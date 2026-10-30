import { describe, expect, it } from 'vitest';
import {
  gateCreative,
  importCampaignAds,
  listCampaignAds,
  resolveImageUrl,
  type CreativeNode,
  type GraphReader,
} from '../src/server/meta/campaign.js';

/** Fake account/campaign/creative ids — obviously fake, never real Meta ids. */
const ACCOUNT = '100000000000001';
const CAMPAIGN = '200000000000002';

function linkCreative(over: Record<string, unknown> = {}): CreativeNode {
  return {
    id: '300000000000003',
    name: 'seed creative',
    object_story_spec: {
      page_id: '400000000000004',
      link_data: {
        image_hash: 'abc123abc123abc123abc123abc123ab',
        link: 'https://example.com/gali-offer-en.html',
        message: 'The new GALI bottle is here.',
        name: 'GALI sale',
        call_to_action: { type: 'LEARN_MORE' },
        ...(over as object),
      },
    },
  } as CreativeNode;
}

describe('campaign adapter (mocked Graph responses only)', () => {
  it('paginates GET /{campaign_id}/ads via after cursors', async () => {
    const seen: Array<Record<string, string | undefined> | undefined> = [];
    const reader: GraphReader = async <T>(path: string, params?: Record<string, string | undefined>) => {
      seen.push(params);
      if (path !== `/${CAMPAIGN}/ads`) throw new Error(`unexpected path ${path}`);
      const after = params?.after;
      const page =
        after === undefined
          ? { data: [{ id: 'a1' }], paging: { cursors: { after: 'cur1' } } }
          : { data: [{ id: 'a2' }], paging: {} };
      return { data: page as T };
    };
    const ads = await listCampaignAds(reader, CAMPAIGN);
    expect(ads.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(seen[1]?.after).toBe('cur1');
  });

  it('gates creatives: single-image link ads pass, everything else is UNSUPPORTED_FORMAT', () => {
    expect(gateCreative(linkCreative())).toEqual({ ok: true });
    expect(gateCreative(linkCreative({ child_attachments: [{ link: 'x' }] })).ok).toBe(false);
    expect(gateCreative({ id: 'c', object_story_spec: { video_data: {} } }).ok).toBe(false);
    expect(gateCreative({ ...linkCreative(), asset_feed_spec: {} }).ok).toBe(false);
    expect(gateCreative(linkCreative({ image_hash: undefined })).ok).toBe(false);
    expect(gateCreative({ id: 'c' }).ok).toBe(false);
  });

  it('resolves the image URL by hash from adimages', async () => {
    const reader: GraphReader = async <T>(path: string) => {
      expect(path).toBe(`/act_${ACCOUNT}/adimages`);
      return { data: { images: { h1: { hash: 'h1', url: 'https://cdn.example.com/img.png' } } } as T };
    };
    await expect(resolveImageUrl(reader, ACCOUNT, 'h1')).resolves.toBe('https://cdn.example.com/img.png');
  });

  it('imports supported ads into the snapshot shape and flags the rest', async () => {
    const creative = linkCreative();
    const reader: GraphReader = async <T>(path: string) => {
      if (path === `/${CAMPAIGN}/ads`) {
        return {
          data: {
            data: [
              { id: 'ad-ok', name: 'ok', configured_status: 'PAUSED', adset_id: '500', creative: { id: 'c-ok' } },
              { id: 'ad-bad', name: 'bad', creative: { id: 'c-bad' } },
            ],
          } as T,
        };
      }
      if (path === '/c-ok') return { data: creative as T };
      if (path === '/c-bad') return { data: { id: 'c-bad' } as T };
      if (path === `/act_${ACCOUNT}/adimages`) {
        return { data: { images: { [creative.object_story_spec?.link_data?.image_hash as string]: { hash: 'h', url: 'https://cdn.example.com/img.png' } } } as T };
      }
      throw new Error(`unexpected path ${path}`);
    };
    const downloader = async (url: string): Promise<Buffer> => {
      expect(url).toBe('https://cdn.example.com/img.png');
      return Buffer.from('fake-image-bytes');
    };
    const entries = await importCampaignAds(reader, downloader, { campaignId: CAMPAIGN, adAccountId: ACCOUNT });
    expect(entries).toHaveLength(2);
    const ok = entries[0];
    expect(ok?.supported).toBe(true);
    if (ok?.supported) {
      expect(ok.snapshot.adId).toBe('ad-ok');
      expect(ok.snapshot.status).toBe('PAUSED');
      expect(ok.snapshot.imageBytes).toEqual(Buffer.from('fake-image-bytes'));
      expect(ok.snapshot.imageSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(ok.snapshot.copy).toContain('GALI');
      expect(ok.snapshot.landingUrl).toBe('https://example.com/gali-offer-en.html');
    }
    expect(entries[1]).toMatchObject({ supported: false, adId: 'ad-bad', verdict: 'UNSUPPORTED_FORMAT' });
  });
});
