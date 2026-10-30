#!/usr/bin/env tsx
/**
 * Seed the real test campaign: one PAUSED ad per campaign.json entry in the
 * test ad set, each with its real landing URL.
 *
 *   npm run seed:campaign              # dry run: print exact payloads, send nothing
 *   npm run seed:campaign -- --execute # a HUMAN runs this later (agent must not)
 *
 * Reuses the probe's upload → creative → ad flow and guards (assertOnlyPaused,
 * enhancements opt-out with one retry without it, reconcile-before-retry on
 * POST timeouts). Never edits existing ads; the only status ever sent is PAUSED.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { findRepoRoot, loadEnvFiles } from '../src/shared/env.js';
import { loadConfig, type OfferGuardConfig } from '../src/shared/config.js';
import { assertOnlyPaused } from '../src/shared/guards.js';
import { parseLang, t } from '../src/shared/i18n.js';
import {
  GraphApiError,
  GraphTimeoutError,
  formatGraphError,
  graphGet,
  graphPost,
  graphPostMultipart,
} from '../src/server/meta/graph.js';
import { isOptOutRejection } from '../src/server/meta/probe.js';
import { appendJournal, nowIso, type JournalEntry } from '../src/server/workflow/journal.js';
import { adKey, loadManifest, resolveLandingUrl, type ManifestEntry } from '../src/server/workflow/sweep.js';
import { sha256Hex } from '../src/server/models/client.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const JOURNAL_PATH = join(REPO_ROOT, '.local', 'seed-journal.jsonl');

// Same documented opt-out the probe uses; on subcode-3858504 rejection the
// creative is retried once without it (logged as payload_variant).
const ENHANCEMENT_OPT_OUT = {
  degrees_of_freedom_spec: {
    creative_features_spec: {
      standard_enhancements: { enroll_status: 'OPT_OUT' },
    },
  },
};

type Mode = 'dry-run' | 'execute';

const dryEnvSchema = z.object({
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v25.0'),
  META_AD_ACCOUNT_ID: z.string().regex(/^\d+$/, 'META_AD_ACCOUNT_ID must be digits only'),
  META_PAGE_ID: z.string().regex(/^\d+$/, 'META_PAGE_ID must be digits only'),
  META_ADSET_ID: z.string().regex(/^\d+$/, 'META_ADSET_ID must be digits only'),
  OFFER_GUARD_PAGES_BASE: z.string().url('OFFER_GUARD_PAGES_BASE must be a public https URL Meta can reach'),
});

interface AdImagesResponse {
  images: Record<string, { hash: string; url?: string }>;
}
interface NamedNode {
  id: string;
  name?: string;
  creative?: { id: string };
}

function usage(): never {
  console.log(`Usage: seed-campaign [--execute] [--manifest <path>] [--lang he|en]

  (no flag)      Dry run: print the exact upload/creative/ad payloads, send nothing.
  --execute      Actually create the PAUSED ads (a human runs this, never an agent).
  --manifest     Campaign manifest (default: fixtures/campaign.json).`);
  process.exit(1);
}

async function logStep(
  mode: Mode,
  step: string,
  entry: Omit<JournalEntry, 'ts' | 'step' | 'mode'>,
  consoleLines: string[],
): Promise<void> {
  for (const line of consoleLines) console.log(line);
  await appendJournal(JOURNAL_PATH, { ts: nowIso(), step, mode, ...entry });
}

function fail(lines: string[]): never {
  for (const line of lines) console.log(line);
  process.exit(1);
}

function isLocalBase(base: string): boolean {
  try {
    const h = new URL(base).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('10.') || h.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  } catch {
    return true;
  }
}

function buildCreativePayload(pageId: string, creativeName: string, entry: ManifestEntry, landingUrl: string, imageHash: string): Record<string, unknown> {
  return {
    name: creativeName,
    object_story_spec: {
      page_id: pageId,
      link_data: {
        image_hash: imageHash,
        link: landingUrl,
        message: entry.copy,
        name: `GALI seed ${adKey(entry)}`,
        call_to_action: { type: 'LEARN_MORE' },
      },
    },
    ...ENHANCEMENT_OPT_OUT,
  };
}

function buildAdPayload(adName: string, adsetId: string, creativeId: string): Record<string, unknown> {
  return { name: adName, adset_id: adsetId, creative: { creative_id: creativeId }, status: 'PAUSED' };
}

async function stopOnGraphError(mode: Mode, step: string, err: GraphApiError): Promise<never> {
  await logStep(
    mode,
    step,
    {
      request: { method: err.requestSummary.split(' ')[0] ?? 'POST', summary: err.requestSummary },
      error: {
        message: err.body.message,
        code: err.body.code,
        error_subcode: err.body.error_subcode,
        error_user_msg: err.body.error_user_msg,
        fbtrace_id: err.body.fbtrace_id,
        httpStatus: err.httpStatus,
      },
    },
    [formatGraphError(err), 'STOPPING (no further requests will be sent).'],
  );
  process.exit(1);
}

/** Never retry a no-response POST blindly: look the object up by name first. */
async function reconcileOrStop(
  mode: Mode,
  step: string,
  reason: string,
  target: { kind: 'ad' | 'creative'; name: string; lookup: () => Promise<NamedNode[]>; adopt: (id: string) => void },
): Promise<void> {
  console.log(reason);
  console.log(`Reconcile: looking for ${target.kind} named ${JSON.stringify(target.name)} before any retry...`);
  let found: NamedNode[];
  try {
    found = await target.lookup();
  } catch (lookupErr) {
    const detail = lookupErr instanceof GraphApiError ? formatGraphError(lookupErr) : String(lookupErr);
    await logStep(
      mode,
      `${step}-reconcile`,
      {
        request: { method: 'GET', summary: `reconcile lookup for ${target.kind} ${JSON.stringify(target.name)}` },
        error: { message: `POST got no response and the reconcile lookup also failed: ${detail}` },
      },
      ['STOPPING: object state is unknown; will not retry blindly.'],
    );
    process.exit(1);
  }
  if (found.length === 1 && found[0]) {
    target.adopt(found[0].id);
    console.log(`Found exactly one ${target.kind}: id=${found[0].id}. Adopting it (no blind retry).`);
    return;
  }
  await logStep(
    mode,
    `${step}-reconcile`,
    {
      request: { method: 'GET', summary: `reconcile lookup for ${target.kind} ${JSON.stringify(target.name)}` },
      error: { message: `POST got no response; reconcile found ${found.length} matching ${target.kind}(s).` },
    },
    ['STOPPING: will not retry blindly. Inspect the journal and Ads Manager.'],
  );
  process.exit(1);
}

async function main(): Promise<void> {
  loadEnvFiles(REPO_ROOT);
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) usage();
  const lang = parseLang(argv);
  const mode: Mode = argv.includes('--execute') ? 'execute' : 'dry-run';
  const mi = argv.indexOf('--manifest');
  const manifestPath = join(REPO_ROOT, mi >= 0 && argv[mi + 1] && !argv[mi + 1]?.startsWith('--') ? (argv[mi + 1] as string) : 'fixtures/campaign.json');
  const unknown = argv.find((a) => a.startsWith('--') && !['--execute', '--manifest', '--lang'].includes(a));
  if (unknown) {
    console.log(`Unknown flag: ${unknown}`);
    usage();
  }

  const manifest = await loadManifest(manifestPath);
  console.log(`=== ${t(lang, 'seed_title')} ===`);
  console.log(`manifest: ${manifest.entries.length} entries (${manifest.name})`);
  if (mode === 'dry-run') console.log(`${t(lang, 'seed_dry_note')}\n`);

  if (mode === 'dry-run') {
    let env: z.infer<typeof dryEnvSchema>;
    try {
      env = dryEnvSchema.parse(process.env);
    } catch (err) {
      fail(['Config for dry run:', err instanceof Error ? err.message : String(err)]);
    }
    if (isLocalBase(env.OFFER_GUARD_PAGES_BASE)) {
      console.log('WARNING: OFFER_GUARD_PAGES_BASE is local — Meta could not reach these landing URLs.');
      console.log('Set it to the public pages host before --execute. Payloads below still show the exact shape.\n');
    }
    for (const entry of manifest.entries) {
      const bytes = await readFile(resolve(REPO_ROOT, entry.image));
      const landingUrl = resolveLandingUrl(entry.landing_url, env.OFFER_GUARD_PAGES_BASE);
      const creative = buildCreativePayload(env.META_PAGE_ID, `Offer Guard seed creative ${adKey(entry)} <runTag>`, entry, landingUrl, '<hash from upload>');
      const ad = buildAdPayload(`Offer Guard seed ${adKey(entry)} <runTag>`, env.META_ADSET_ID, '<creative_id>');
      console.log(`--- ${adKey(entry)} ---`);
      console.log(`  upload: POST /act_${env.META_AD_ACCOUNT_ID}/adimages multipart(${entry.image}, ${bytes.length} bytes, sha256=${sha256Hex(bytes).slice(0, 16)}…)`);
      console.log(`  creative: POST /act_${env.META_AD_ACCOUNT_ID}/adcreatives`);
      console.log(`    ${JSON.stringify(creative)}`);
      console.log(`  ad: POST /act_${env.META_AD_ACCOUNT_ID}/ads`);
      console.log(`    ${JSON.stringify(ad)}`);
      console.log(`  readback: GET /{new_ad_id} asserts PAUSED + adset + image_hash + link`);
    }
    console.log(`\n${t(lang, 'seed_done')}`);
    return;
  }

  // --- execute (a human runs this) ---
  let config: OfferGuardConfig;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    fail(['Config validation failed:', err instanceof Error ? err.message : String(err)]);
  }
  const pagesBase = process.env.OFFER_GUARD_PAGES_BASE?.trim() ?? '';
  if (!pagesBase || isLocalBase(pagesBase)) {
    fail(['Refusing --execute: OFFER_GUARD_PAGES_BASE must be a public URL Meta can reach.']);
  }
  const runTag = new Date().toISOString().replace(/[:.]/g, '-');

  // Guard: the ad set must exist and must NOT be ACTIVE.
  try {
    const adset = await graphGet<{ id: string; name: string; status: string }>(config, `/${config.META_ADSET_ID}`, {
      fields: 'id,name,status',
    });
    console.log(`ad set: ${adset.data.name} status=${adset.data.status}`);
    if (adset.data.status === 'ACTIVE') fail(['ABORT: ad set status is ACTIVE. The seed only runs against a non-ACTIVE ad set.']);
  } catch (err) {
    if (err instanceof GraphApiError) await stopOnGraphError(mode, 'adset-guard', err);
    throw err;
  }

  let created = 0;
  for (const entry of manifest.entries) {
    const key = adKey(entry);
    const step = `seed-${key.replace('/', '-')}`;
    const landingUrl = resolveLandingUrl(entry.landing_url, pagesBase);
    const bytes = await readFile(resolve(REPO_ROOT, entry.image));
    const fileName = `${entry.id}-${entry.lang}.png`;
    console.log(`--- ${key} ---`);

    // 1. upload (content-addressed: one retry after a no-response POST is safe).
    let imageHash: string;
    const doUpload = async (tag: string): Promise<string> => {
      const form = new FormData();
      form.append(fileName, new Blob([new Uint8Array(bytes)], { type: 'image/png' }), fileName);
      const res = await graphPostMultipart<AdImagesResponse>(config, `/act_${config.META_AD_ACCOUNT_ID}/adimages`, form, `file ${fileName} (${bytes.length} bytes)${tag}`);
      const k = Object.keys(res.data.images ?? {})[0];
      const hash = k ? res.data.images[k]?.hash : undefined;
      if (!hash) throw new Error('adimages response contained no image hash');
      return hash;
    };
    try {
      imageHash = await doUpload('');
    } catch (err) {
      if (err instanceof GraphApiError) await stopOnGraphError(mode, `${step}-upload`, err);
      if (err instanceof GraphTimeoutError || err instanceof TypeError) {
        console.log('Upload got no response; the hash is content-addressed, retrying once...');
        try {
          imageHash = await doUpload(' [retry 1/1]');
        } catch (retryErr) {
          if (retryErr instanceof GraphApiError) await stopOnGraphError(mode, `${step}-upload`, retryErr);
          throw retryErr;
        }
      } else {
        throw err;
      }
    }
    await logStep(
      mode,
      `${step}-upload`,
      {
        request: { method: 'POST', summary: `POST /act_${config.META_AD_ACCOUNT_ID}/adimages multipart(${fileName}, ${bytes.length} bytes)` },
        responseIds: { image_hash: imageHash as string },
      },
      [`upload -> image_hash=${imageHash}`],
    );

    // 2. creative (opt-out, one retry without it on rejection; reconcile on no-response).
    const creativeName = `Offer Guard seed creative ${key} ${runTag}`;
    const creativePayload = buildCreativePayload(config.META_PAGE_ID, creativeName, entry, landingUrl, imageHash as string);
    let creativeId: string | undefined;
    const postCreative = (payload: Record<string, unknown>): Promise<string> =>
      graphPost<{ id: string }>(config, `/act_${config.META_AD_ACCOUNT_ID}/adcreatives`, payload).then((r) => r.data.id);
    try {
      creativeId = await postCreative(creativePayload);
      await logStep(mode, `${step}-creative`, { request: { method: 'POST', summary: `POST /act_${config.META_AD_ACCOUNT_ID}/adcreatives` }, responseIds: { creative_id: creativeId }, note: 'with-degrees_of_freedom_spec-opt-out' }, [`creative -> ${creativeId}`]);
    } catch (err) {
      if (err instanceof GraphApiError && isOptOutRejection(err.body, true)) {
        console.log('Opt-out rejected; retrying once without it...');
        const { degrees_of_freedom_spec: _d, ...without } = creativePayload;
        try {
          creativeId = await postCreative(without);
          await logStep(mode, `${step}-creative`, { request: { method: 'POST', summary: `POST /act_${config.META_AD_ACCOUNT_ID}/adcreatives` }, responseIds: { creative_id: creativeId }, note: 'REPORT: without-opt-out' }, [`creative -> ${creativeId} (WITHOUT the opt-out)`]);
        } catch (retryErr) {
          if (retryErr instanceof GraphApiError) await stopOnGraphError(mode, `${step}-creative`, retryErr);
          throw retryErr;
        }
      } else if (err instanceof GraphApiError) {
        await stopOnGraphError(mode, `${step}-creative`, err);
      } else if (err instanceof GraphTimeoutError || err instanceof TypeError) {
        await reconcileOrStop(mode, `${step}-creative`, 'Creative POST got no response.', {
          kind: 'creative',
          name: creativeName,
          lookup: () =>
            graphGet<{ data?: NamedNode[] }>(config, `/act_${config.META_AD_ACCOUNT_ID}/adcreatives`, { fields: 'id,name', limit: '100' }).then((r) =>
              (r.data.data ?? []).filter((n) => n.name === creativeName),
            ),
          adopt: (id) => {
            creativeId = id;
          },
        });
      } else {
        throw err;
      }
    }

    // 3. ad (PAUSED only).
    const adName = `Offer Guard seed ${key} ${runTag}`;
    const adPayload = buildAdPayload(adName, config.META_ADSET_ID, creativeId as string);
    assertOnlyPaused(adPayload, `seed ad creation for ${key}`);
    let adId: string | undefined;
    try {
      const newAdId: string = await graphPost<{ id: string }>(config, `/act_${config.META_AD_ACCOUNT_ID}/ads`, adPayload).then((r) => r.data.id);
      adId = newAdId;
      await logStep(mode, `${step}-ad`, { request: { method: 'POST', summary: `POST /act_${config.META_AD_ACCOUNT_ID}/ads status=PAUSED` }, responseIds: { ad_id: newAdId } }, [`ad -> ${newAdId} (PAUSED)`]);
    } catch (err) {
      if (err instanceof GraphApiError) await stopOnGraphError(mode, `${step}-ad`, err);
      if (err instanceof GraphTimeoutError || err instanceof TypeError) {
        await reconcileOrStop(mode, `${step}-ad`, 'Ad POST got no response.', {
          kind: 'ad',
          name: adName,
          lookup: () =>
            graphGet<{ data?: NamedNode[] }>(config, `/${config.META_ADSET_ID}/ads`, { fields: 'id,name', limit: '100' }).then((r) =>
              (r.data.data ?? []).filter((n) => n.name === adName),
            ),
          adopt: (id) => {
            adId = id;
          },
        });
      } else {
        throw err;
      }
    }

    // 4. readback.
    const rb = await graphGet<{
      id: string;
      status?: string;
      configured_status?: string;
      adset_id?: string;
      creative?: { id: string; image_hash?: string; object_story_spec?: { link_data?: { link?: string } } };
    }>(config, `/${adId}`, { fields: 'id,status,configured_status,adset_id,creative{id,image_hash,object_story_spec}' });
    const a = rb.data;
    const checks: Array<[string, boolean]> = [
      ['status PAUSED', [a.status, a.configured_status].filter(Boolean).every((v) => v === 'PAUSED')],
      ['adset matches', a.adset_id === config.META_ADSET_ID],
      ['image hash matches', a.creative?.image_hash === imageHash],
      ['link matches', (a.creative?.object_story_spec?.link_data?.link ?? '').replace(/\/+$/, '') === landingUrl.replace(/\/+$/, '')],
      ['creative matches', a.creative?.id === creativeId],
    ];
    for (const [label, ok] of checks) console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`);
    await logStep(
      mode,
      `${step}-readback`,
      {
        request: { method: 'GET', summary: rb.requestSummary },
        responseIds: { ad_id: a.id },
        responseSummary: checks.map(([l, ok]) => `${ok ? 'PASS' : 'FAIL'}:${l}`).join(' | '),
      },
      [],
    );
    if (!checks.every(([, ok]) => ok)) fail([`STOPPING: readback failed for ${key}.`]);
    created++;
  }

  console.log(t(lang, 'seed_execute_done', { ads: created }));
}

await main();
