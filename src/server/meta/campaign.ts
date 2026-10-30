import { createHash } from 'node:crypto';
import type { OfferGuardConfig } from '../../shared/config.js';
import { graphGet } from './graph.js';

/**
 * Read-only campaign import (ARCHITECTURE.md section 9, steps 1-4):
 * list ads → read creatives → resolve the original image by hash → download
 * the source bytes, mapped into the same snapshot shape the sweep consumes.
 *
 * All Graph access goes through the injected `reader` so unit tests use
 * mocked responses only — no test may touch the real Graph API.
 */

export type GraphReader = <T>(path: string, params?: Record<string, string | undefined>) => Promise<{ data: T }>;

/** Production reader: thin wrapper over graphGet with the loaded config. */
export function graphConfigReader(config: OfferGuardConfig): GraphReader {
  return async <T>(path: string, params?: Record<string, string | undefined>) => graphGet<T>(config, path, params ?? {});
}

export interface CampaignAdNode {
  id: string;
  name?: string;
  status?: string;
  configured_status?: string;
  adset_id?: string;
  creative?: { id: string };
}

export interface CreativeNode {
  id: string;
  name?: string;
  object_story_spec?: {
    page_id?: string;
    link_data?: {
      image_hash?: string;
      link?: string;
      message?: string;
      name?: string;
      call_to_action?: { type?: string };
      child_attachments?: unknown[];
    };
    video_data?: unknown;
  };
  asset_feed_spec?: unknown;
}

export interface AdImagesNode {
  images: Record<string, { hash: string; url?: string; url_128?: string }>;
}

interface Paged<T> {
  data?: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/** GET /{campaign_id}/ads with `after`-cursor pagination. */
export async function listCampaignAds(reader: GraphReader, campaignId: string): Promise<CampaignAdNode[]> {
  const out: CampaignAdNode[] = [];
  let after: string | undefined;
  for (;;) {
    const res = await reader<Paged<CampaignAdNode>>(`/${campaignId}/ads`, {
      fields: 'id,name,status,configured_status,adset_id,creative{id}',
      limit: '100',
      after,
    });
    out.push(...(res.data.data ?? []));
    const next = res.data.paging?.cursors?.after;
    if (!next || next === after) break;
    after = next;
  }
  return out;
}

export async function getCreative(reader: GraphReader, creativeId: string): Promise<CreativeNode> {
  const res = await reader<CreativeNode>(`/${creativeId}`, {
    fields: 'id,name,object_story_spec,asset_feed_spec',
  });
  return res.data;
}

export type CreativeGate = { ok: true } | { ok: false; reason: string };

/**
 * Input gate: accept only the verified single-image link-ad format.
 * Carousel (child_attachments), video, dynamic/multi-asset (asset_feed_spec)
 * and hashless creatives → UNSUPPORTED_FORMAT with a reason.
 */
export function gateCreative(creative: CreativeNode): CreativeGate {
  const spec = creative.object_story_spec;
  if (!spec?.link_data) return { ok: false, reason: 'no object_story_spec.link_data (not a link ad)' };
  const link = spec.link_data;
  if (link.child_attachments && link.child_attachments.length > 0) {
    return { ok: false, reason: 'carousel / multi-attachment creative' };
  }
  if (spec.video_data) return { ok: false, reason: 'video creative' };
  if (creative.asset_feed_spec) return { ok: false, reason: 'dynamic / multi-asset creative' };
  if (!link.image_hash) return { ok: false, reason: 'link ad without an image_hash' };
  return { ok: true };
}

/** Resolve the original image URL by hash: GET /act_{id}/adimages. */
export async function resolveImageUrl(reader: GraphReader, adAccountId: string, imageHash: string): Promise<string> {
  const res = await reader<AdImagesNode>(`/act_${adAccountId}/adimages`, {
    hashes: JSON.stringify([imageHash]),
    fields: 'hash,url',
  });
  const images = res.data.images ?? {};
  const first = images[imageHash] ?? Object.values(images)[0];
  if (!first?.url) throw new Error(`adimages returned no URL for hash ${imageHash}`);
  return first.url;
}

export type BytesDownloader = (url: string) => Promise<Buffer>;

export const fetchBytesDownloader: BytesDownloader = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image download failed: HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
};

export interface CampaignAdSnapshot {
  /** Same snapshot shape the sweep consumes, plus the Meta ids. */
  adId: string;
  adsetId: string | null;
  creativeId: string;
  name: string;
  status: string | null;
  imageBytes: Buffer;
  imageSha256: string;
  imageHash: string;
  copy: string;
  landingUrl: string;
}

export type CampaignImportEntry =
  | { supported: true; snapshot: CampaignAdSnapshot }
  | { supported: false; adId: string; verdict: 'UNSUPPORTED_FORMAT'; reason: string };

/**
 * Import every ad of a campaign into sweep-ready snapshots. Read-only:
 * GETs (+ one image download) per ad, never a POST.
 */
export async function importCampaignAds(
  reader: GraphReader,
  downloader: BytesDownloader,
  input: { campaignId: string; adAccountId: string },
): Promise<CampaignImportEntry[]> {
  const ads = await listCampaignAds(reader, input.campaignId);
  const out: CampaignImportEntry[] = [];
  for (const ad of ads) {
    if (!ad.creative?.id) {
      out.push({ supported: false, adId: ad.id, verdict: 'UNSUPPORTED_FORMAT', reason: 'ad has no creative id' });
      continue;
    }
    const creative = await getCreative(reader, ad.creative.id);
    const gate = gateCreative(creative);
    if (!gate.ok) {
      out.push({ supported: false, adId: ad.id, verdict: 'UNSUPPORTED_FORMAT', reason: gate.reason });
      continue;
    }
    const link = creative.object_story_spec?.link_data;
    const imageHash = link?.image_hash as string;
    const url = await resolveImageUrl(reader, input.adAccountId, imageHash);
    const imageBytes = await downloader(url);
    out.push({
      supported: true,
      snapshot: {
        adId: ad.id,
        adsetId: ad.adset_id ?? null,
        creativeId: creative.id,
        name: ad.name ?? creative.name ?? ad.id,
        status: ad.configured_status ?? ad.status ?? null,
        imageBytes,
        imageSha256: createHash('sha256').update(imageBytes).digest('hex'),
        imageHash,
        copy: link?.message ?? '',
        landingUrl: link?.link ?? '',
      },
    });
  }
  return out;
}
