#!/usr/bin/env tsx
/**
 * Day-1 kill test: Meta write path.
 *
 * Proves we can create a PAUSED replacement ad on our own account and read it back.
 *
 *   npm run probe:meta              # dry run (default): reads + local image only, POSTs are printed not sent
 *   npm run probe:meta -- --execute # actually sends steps 4-6 to Meta
 *
 * Safety: dry run by default; never sends any status other than PAUSED; never
 * edits/pauses existing ads; never touches budgets; never creates campaigns or ad sets.
 * Every step is logged to the console and appended to .local/probe-journal.jsonl.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFiles } from '../src/shared/env.js';
import { describeConfigForLog, loadConfig, type OfferGuardConfig } from '../src/shared/config.js';
import { generateProbeTestImage } from '../src/server/repair/test-image.js';
import { assertOnlyPaused } from '../src/shared/guards.js';
import {
  GraphApiError,
  GraphTimeoutError,
  formatGraphError,
  graphGet,
  graphPost,
  graphPostMultipart,
} from '../src/server/meta/graph.js';
import { isOptOutRejection, parseProbeArgs, ProbeArgsError } from '../src/server/meta/probe.js';
import { appendJournal, nowIso, type JournalEntry } from '../src/server/workflow/journal.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const JOURNAL_PATH = join(REPO_ROOT, '.local', 'probe-journal.jsonl');
const TEST_IMAGE_PATH = join(REPO_ROOT, '.local', 'probe-test-image.png');

const PROBE_MESSAGE = 'Offer Guard probe – test only';
const PROBE_LINK_NAME = 'Offer Guard probe';

// Graph v25 documented opt-out for automatic creative enhancements.
// If Meta rejects this field (detected by numeric subcode, never message text)
// we log the error and retry once without it.
const ENHANCEMENT_OPT_OUT = {
  degrees_of_freedom_spec: {
    creative_features_spec: {
      standard_enhancements: { enroll_status: 'OPT_OUT' },
    },
  },
};

type Mode = 'dry-run' | 'execute';

interface MeResponse {
  id: string;
  name: string;
}
interface AdAccountResponse {
  id: string;
  name: string;
  account_status: number;
  currency: string;
}
interface AdSetResponse {
  id: string;
  name: string;
  status: string;
  effective_status?: string;
  campaign?: { id: string; name: string; status: string; objective: string };
}
interface AdImagesResponse {
  images: Record<string, { hash: string; url?: string }>;
}
interface AdCreativeResponse {
  id: string;
}
interface AdResponse {
  id: string;
}
interface AdReadback {
  id: string;
  name: string;
  status?: string;
  configured_status?: string;
  effective_status?: string;
  adset_id?: string;
  creative?: {
    id: string;
    image_hash?: string;
    object_story_spec?: { link_data?: { link?: string; message?: string } };
  };
}
interface NamedNode {
  id: string;
  name?: string;
  creative?: { id: string };
}

function usage(exitCode: number): never {
  console.log(`Usage: probe-meta-write [--execute] [--image-hash <hash>]

  (no flag)   Dry run: performs the safe reads (steps 1-2) and local test-image
              generation (step 3), prints the POSTs it would send (steps 4-6),
              and skips the readback (step 7).
  --execute   Actually sends steps 4-6 to Meta and performs the readback (step 7).
  --image-hash <hash>
              Reuse an already-uploaded image (32 hex chars): skips step 3
              (local image generation) and step 4 (adimages upload).

Journal: .local/probe-journal.jsonl (gitignored; request summaries never contain the token).`);
  process.exit(exitCode);
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

function fail(consoleLines: string[]): never {
  for (const line of consoleLines) console.log(line);
  process.exit(1);
}

/** True for transport-level fetch failures (DNS, connection reset, TLS, ...). */
function isTransportError(err: unknown): err is TypeError {
  return err instanceof TypeError && err.message.startsWith('fetch failed');
}

function transportDetail(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? `: ${err.cause.message}` : '';
    return `${err.message}${cause}`;
  }
  return String(err);
}

async function stopOnTransportError(
  mode: Mode,
  step: string,
  requestSummary: string,
  err: unknown,
): Promise<never> {
  const detail = transportDetail(err);
  await logStep(
    mode,
    step,
    {
      request: { method: methodOf(requestSummary), summary: requestSummary },
      error: { message: `Transport failure: ${detail}` },
    },
    [`Transport failure on ${requestSummary}: ${detail}`, 'STOPPING (no further requests will be sent).'],
  );
  process.exit(1);
}

function methodOf(requestSummary: string): string {
  return requestSummary.split(' ')[0] ?? 'GET';
}

async function stopOnGraphError(mode: Mode, step: string, err: GraphApiError): Promise<never> {
  const text = formatGraphError(err);
  await logStep(
    mode,
    step,
    {
      request: { method: methodOf(err.requestSummary), summary: err.requestSummary },
      error: {
        message: err.body.message,
        code: err.body.code,
        error_subcode: err.body.error_subcode,
        error_user_msg: err.body.error_user_msg,
        fbtrace_id: err.body.fbtrace_id,
        httpStatus: err.httpStatus,
      },
    },
    [text, 'STOPPING (no further requests will be sent).'],
  );
  process.exit(1);
}

async function generateTestImage(): Promise<{ path: string; bytes: number }> {
  const image = await generateProbeTestImage(TEST_IMAGE_PATH);
  return { path: image.path, bytes: image.bytes };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let parsed: { mode: Mode; imageHash: string | undefined; help: boolean };
  try {
    parsed = parseProbeArgs(args);
  } catch (err) {
    if (err instanceof ProbeArgsError) {
      console.log(err.message);
      usage(1);
    }
    throw err;
  }
  if (parsed.help) usage(0);
  const mode: Mode = parsed.mode;
  const reuseImageHash = parsed.imageHash;

  loadEnvFiles(REPO_ROOT);
  let config: OfferGuardConfig;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    fail(['Config validation failed:', err instanceof Error ? err.message : String(err)]);
  }

  const runTag = new Date().toISOString().replace(/[:.]/g, '-');
  const adName = `Offer Guard probe ${runTag}`;
  const creativeName = `Offer Guard probe creative ${runTag}`;

  console.log(`=== Offer Guard Meta write-path probe (${mode}) ===`);
  console.log(`run: ${runTag}`);
  console.log(`journal: .local/probe-journal.jsonl`);
  const described = describeConfigForLog(config);
  for (const [k, v] of Object.entries(described)) console.log(`  ${k}=${v}`);
  console.log('');

  if (reuseImageHash) {
    console.log(`reusing --image-hash ${reuseImageHash}: steps 3-4 will be skipped.`);
  }
  if (mode === 'dry-run') {
    console.log('DRY RUN: steps 4-6 will be printed, not sent. Pass --execute to send them.\n');
  }

  // ---- Step 1: token + account sanity check (safe reads, run in both modes) ----
  console.log('--- Step 1: GET /me and GET /act_{id} ---');
  try {
    const me = await graphGet<MeResponse>(config, '/me', { fields: 'id,name' });
    await logStep(
      mode,
      'step-1-me',
      { request: { method: 'GET', summary: me.requestSummary }, responseSummary: `id=${me.data.id} name=${me.data.name}` },
      [`GET /me -> id=${me.data.id} name=${me.data.name}`],
    );
  } catch (err) {
    if (err instanceof GraphApiError) await stopOnGraphError(mode, 'step-1-me', err);
    if (isTransportError(err)) await stopOnTransportError(mode, 'step-1-me', 'GET /me?fields=id,name', err);
    throw err;
  }
  try {
    const account = await graphGet<AdAccountResponse>(config, `/act_${config.META_AD_ACCOUNT_ID}`, {
      fields: 'name,account_status,currency',
    });
    await logStep(
      mode,
      'step-1-account',
      {
        request: { method: 'GET', summary: account.requestSummary },
        responseSummary: `name=${account.data.name} status=${account.data.account_status} currency=${account.data.currency}`,
      },
      [
        `GET /act_${config.META_AD_ACCOUNT_ID} -> name=${account.data.name} account_status=${account.data.account_status} currency=${account.data.currency}`,
      ],
    );
  } catch (err) {
    if (err instanceof GraphApiError) await stopOnGraphError(mode, 'step-1-account', err);
    if (isTransportError(err)) {
      await stopOnTransportError(
        mode,
        'step-1-account',
        `GET /act_${config.META_AD_ACCOUNT_ID}?fields=name,account_status,currency`,
        err,
      );
    }
    throw err;
  }

  // ---- Step 2: ad set must exist and must NOT be ACTIVE (safe read, both modes) ----
  console.log('--- Step 2: GET /{adset_id} (must exist, must NOT be ACTIVE) ---');
  try {
    const adset = await graphGet<AdSetResponse>(config, `/${config.META_ADSET_ID}`, {
      fields: 'id,name,status,effective_status,campaign{id,name,status,objective}',
    });
    const a = adset.data;
    await logStep(
      mode,
      'step-2-adset',
      {
        request: { method: 'GET', summary: adset.requestSummary },
        responseIds: { adset_id: a.id },
        responseSummary: `name=${a.name} status=${a.status} effective_status=${a.effective_status ?? '(none)'} campaign=${a.campaign?.id ?? '(none)'}`,
      },
      [
        `GET /${config.META_ADSET_ID} -> name=${a.name} status=${a.status} effective_status=${a.effective_status ?? '(none)'}`,
        `  campaign: ${a.campaign ? `${a.campaign.id} "${a.campaign.name}" status=${a.campaign.status} objective=${a.campaign.objective}` : '(none)'}`,
      ],
    );
    if (a.status === 'ACTIVE') {
      await logStep(
        mode,
        'step-2-abort',
        {
          request: { method: 'GET', summary: adset.requestSummary },
          error: { message: `Refusing to probe into an ACTIVE ad set (status=ACTIVE).` },
        },
        ['ABORT: ad set status is ACTIVE. The probe only runs against a non-ACTIVE ad set. Stopping.'],
      );
      process.exit(1);
    }
    console.log('OK: ad set exists and is not ACTIVE.');
  } catch (err) {
    if (err instanceof GraphApiError) await stopOnGraphError(mode, 'step-2-adset', err);
    if (isTransportError(err)) {
      await stopOnTransportError(
        mode,
        'step-2-adset',
        `GET /${config.META_ADSET_ID}?fields=id,name,status,effective_status,campaign{id,name,status,objective}`,
        err,
      );
    }
    throw err;
  }

  // ---- Step 3: generate the 1080x1080 test PNG locally (both modes; skipped with --image-hash) ----
  console.log('--- Step 3: generate 1080x1080 test PNG locally ---');
  const image = reuseImageHash ? undefined : await generateTestImage();
  if (image) {
    await logStep(
      mode,
      'step-3-image',
      {
        request: { method: 'LOCAL', summary: 'sharp: 1080x1080 navy PNG + centered 840x420 offer panel, no text' },
        responseSummary: `path=.local/probe-test-image.png bytes=${image.bytes}`,
      },
      [`Generated .local/probe-test-image.png (1080x1080, ${image.bytes} bytes).`],
    );
  } else {
    await logStep(
      mode,
      'step-3-image',
      {
        request: { method: 'LOCAL', summary: 'skipped (--image-hash given)' },
        note: 'skipped: reusing provided image hash, no local image generated',
      },
      [`Skipped: reusing --image-hash ${reuseImageHash} (no local image generated).`],
    );
  }

  // ---- Step 4: POST /act_{id}/adimages (skipped with --image-hash) ----
  console.log('--- Step 4: POST /act_{id}/adimages ---');
  let imageHash: string | undefined = reuseImageHash;
  const uploadFileName = 'probe-test-image.png';
  if (reuseImageHash) {
    await logStep(
      mode,
      'step-4-adimages',
      {
        request: {
          method: 'POST',
          summary: `skipped: reusing provided image hash for /act_${config.META_AD_ACCOUNT_ID}/adimages`,
        },
        responseIds: { image_hash: reuseImageHash },
        responseSummary: `image_hash=${reuseImageHash}`,
        note: 'skipped: reusing --image-hash, no upload sent',
      },
      [`Skipped upload: reusing image_hash=${reuseImageHash} (persisted to journal)`],
    );
  } else if (mode === 'dry-run') {
    if (!image) fail(['Internal error: no test image was generated and no --image-hash was given.']);
    const summary = `POST https://graph.facebook.com/${config.META_GRAPH_VERSION}/act_${config.META_AD_ACCOUNT_ID}/adimages multipart(file ${uploadFileName}, ${image.bytes} bytes)`;
    await logStep(
      mode,
      'step-4-adimages',
      { request: { method: 'POST', summary }, note: 'dry-run: not sent' },
      [`DRY RUN would send: ${summary}`, '  -> expected response: { images: { "<file>": { hash } } } (hash kept for step 5)'],
    );
  } else {
    const bytes = await readFile(TEST_IMAGE_PATH);
    const form = new FormData();
    form.append(uploadFileName, new Blob([new Uint8Array(bytes)], { type: 'image/png' }), uploadFileName);
    try {
      const res = await graphPostMultipart<AdImagesResponse>(
        config,
        `/act_${config.META_AD_ACCOUNT_ID}/adimages`,
        form,
        `file ${uploadFileName} (${bytes.length} bytes)`,
      );
      const firstKey = Object.keys(res.data.images ?? {})[0];
      const hash = firstKey ? res.data.images[firstKey]?.hash : undefined;
      if (!hash) {
        await logStep(
          mode,
          'step-4-adimages',
          {
            request: { method: 'POST', summary: res.requestSummary },
            error: { message: `No image hash in adimages response (keys: ${Object.keys(res.data.images ?? {}).join(',') || '(none)'})` },
          },
          ['STOPPING: adimages response contained no image hash.'],
        );
        process.exit(1);
      }
      imageHash = hash;
      await logStep(
        mode,
        'step-4-adimages',
        {
          request: { method: 'POST', summary: res.requestSummary },
          responseIds: { image_hash: hash },
          responseSummary: `images key=${firstKey}`,
        },
        [`POST adimages -> image_hash=${hash} (persisted to journal)`],
      );
    } catch (err) {
      if (err instanceof GraphApiError) await stopOnGraphError(mode, 'step-4-adimages', err);
      // adimages has no name lookup, but the hash is content-addressed: same bytes
      // always yield the same hash, so exactly one retry cannot create a duplicate.
      // A transport failure (no response) is as ambiguous as a timeout: same treatment.
      const noResponse =
        err instanceof GraphTimeoutError
          ? { reason: `TIMEOUT on ${err.requestSummary}`, retryTag: 'after timeout' }
          : isTransportError(err)
            ? {
                reason: `TRANSPORT FAILURE (${transportDetail(err)}) on POST /act_${config.META_AD_ACCOUNT_ID}/adimages`,
                retryTag: 'after transport failure',
              }
            : null;
      if (noResponse) {
        const lines = [
          noResponse.reason,
          'Reconcile: adimages offers no lookup by name. The image hash is content-addressed,',
          'so retrying the identical bytes once is safe (it returns the same hash). Retrying once...',
        ];
        try {
          const retry = await graphPostMultipart<AdImagesResponse>(
            config,
            `/act_${config.META_AD_ACCOUNT_ID}/adimages`,
            form,
            `file ${uploadFileName} (${bytes.length} bytes) [retry 1/1 ${noResponse.retryTag}]`,
          );
          const rk = Object.keys(retry.data.images ?? {})[0];
          const rhash = rk ? retry.data.images[rk]?.hash : undefined;
          if (!rhash) {
            await logStep(
              mode,
              'step-4-adimages',
              {
                request: { method: 'POST', summary: retry.requestSummary },
                error: { message: 'Retry after timeout returned no image hash.' },
              },
              [...lines, 'STOPPING: retry returned no image hash.'],
            );
            process.exit(1);
          }
          imageHash = rhash;
          await logStep(
            mode,
            'step-4-adimages',
            {
              request: { method: 'POST', summary: retry.requestSummary },
              responseIds: { image_hash: rhash },
              note: 'recovered via one safe retry after POST timeout (content-addressed hash)',
            },
            [...lines, `Retry -> image_hash=${rhash} (persisted to journal)`],
          );
        } catch (retryErr) {
          if (retryErr instanceof GraphApiError) await stopOnGraphError(mode, 'step-4-adimages', retryErr);
          if (isTransportError(retryErr)) {
            await stopOnTransportError(
              mode,
              'step-4-adimages',
              `POST /act_${config.META_AD_ACCOUNT_ID}/adimages (multipart retry ${noResponse.retryTag})`,
              retryErr,
            );
          }
          throw retryErr;
        }
      } else {
        throw err;
      }
    }
  }

  // ---- Step 5: POST /act_{id}/adcreatives ----
  console.log('--- Step 5: POST /act_{id}/adcreatives ---');
  const creativePayload: Record<string, unknown> = {
    name: creativeName,
    object_story_spec: {
      page_id: config.META_PAGE_ID,
      link_data: {
        image_hash: imageHash ?? '<hash from step 4>',
        link: config.META_TEST_LINK_URL,
        message: PROBE_MESSAGE,
        name: PROBE_LINK_NAME,
        call_to_action: { type: 'LEARN_MORE' },
      },
    },
    ...ENHANCEMENT_OPT_OUT,
  };
  let creativeId: string | undefined;
  if (mode === 'dry-run') {
    const summary = `POST https://graph.facebook.com/${config.META_GRAPH_VERSION}/act_${config.META_AD_ACCOUNT_ID}/adcreatives ${JSON.stringify(creativePayload)}`;
    await logStep(
      mode,
      'step-5-adcreatives',
      { request: { method: 'POST', summary }, note: 'dry-run: not sent' },
      [
        'DRY RUN would send:',
        `  POST /act_${config.META_AD_ACCOUNT_ID}/adcreatives`,
        `  ${JSON.stringify(creativePayload, null, 2).split('\n').join('\n  ')}`,
        '  (includes degrees_of_freedom_spec opt-out; on subcode-3858504 rejection: log, retry once without it)',
      ],
    );
  } else {
    assertOnlyPaused({ status: 'PAUSED' }, 'probe sanity check');
    try {
      const res = await graphPost<AdCreativeResponse>(
        config,
        `/act_${config.META_AD_ACCOUNT_ID}/adcreatives`,
        creativePayload,
      );
      creativeId = res.data.id;
      await logStep(
        mode,
        'step-5-adcreatives',
        {
          request: { method: 'POST', summary: res.requestSummary },
          responseIds: { creative_id: creativeId },
          responseSummary: `name=${creativeName} payload_variant=with-degrees_of_freedom_spec-opt-out`,
          note: 'payload_variant=with-degrees_of_freedom_spec-opt-out (Meta accepted the opt-out)',
        },
        [`POST adcreatives -> creative_id=${creativeId} (persisted to journal)`],
      );
    } catch (err) {
      const requestContainedOptOut = 'degrees_of_freedom_spec' in creativePayload;
      if (err instanceof GraphApiError && isOptOutRejection(err.body, requestContainedOptOut)) {
        const text = formatGraphError(err);
        console.log(text);
        console.log('Meta rejected the enhancements opt-out field. Retrying ONCE without it...');
        const { degrees_of_freedom_spec: _dropped, ...payloadWithoutOptOut } = creativePayload;
        await logStep(
          mode,
          'step-5-adcreatives-optout-rejected',
          {
            request: { method: 'POST', summary: err.requestSummary },
            error: {
              message: err.body.message,
              code: err.body.code,
              error_subcode: err.body.error_subcode,
              error_user_msg: err.body.error_user_msg,
              fbtrace_id: err.body.fbtrace_id,
              httpStatus: err.httpStatus,
            },
            note: 'enhancements opt-out field rejected; retrying once without it',
          },
          [],
        );
        try {
          const retry = await graphPost<AdCreativeResponse>(
            config,
            `/act_${config.META_AD_ACCOUNT_ID}/adcreatives`,
            payloadWithoutOptOut,
          );
          creativeId = retry.data.id;
          await logStep(
            mode,
            'step-5-adcreatives',
            {
              request: { method: 'POST', summary: retry.requestSummary },
              responseIds: { creative_id: creativeId },
              responseSummary: `name=${creativeName} payload_variant=without-opt-out`,
              note: 'REPORT: payload_variant=without-opt-out — Meta rejected degrees_of_freedom_spec; creative was created WITHOUT the opt-out',
            },
            [
              `Retry without opt-out -> creative_id=${creativeId} (persisted to journal)`,
              'REPORT: the automatic-enhancements opt-out was REJECTED by Meta; this creative does not carry it.',
            ],
          );
        } catch (retryErr) {
          if (retryErr instanceof GraphApiError) await stopOnGraphError(mode, 'step-5-adcreatives', retryErr);
          if (retryErr instanceof GraphTimeoutError || isTransportError(retryErr)) {
            await stopOnTransportError(
              mode,
              'step-5-adcreatives',
              `POST /act_${config.META_AD_ACCOUNT_ID}/adcreatives (retry without opt-out)`,
              retryErr,
            );
          }
          throw retryErr;
        }
      } else if (err instanceof GraphApiError) {
        await stopOnGraphError(mode, 'step-5-adcreatives', err);
      } else if (err instanceof GraphTimeoutError || isTransportError(err)) {
        await reconcileAfterNoResponse(mode, 'step-5-adcreatives', noResponseReason(config, err, 'adcreatives'), {
          kind: 'creative',
          name: creativeName,
          lookup: () => findCreativeByName(config, creativeName),
          adopt: (id) => {
            creativeId = id;
          },
        });
      } else {
        throw err;
      }
    }
  }

  // ---- Step 6: POST /act_{id}/ads (PAUSED only) ----
  console.log('--- Step 6: POST /act_{id}/ads (status=PAUSED) ---');
  const adPayload: Record<string, unknown> = {
    name: adName,
    adset_id: config.META_ADSET_ID,
    creative: { creative_id: creativeId ?? '<creative_id from step 5>' },
    status: 'PAUSED',
  };
  let adId: string | undefined;
  if (mode === 'dry-run') {
    const summary = `POST https://graph.facebook.com/${config.META_GRAPH_VERSION}/act_${config.META_AD_ACCOUNT_ID}/ads ${JSON.stringify(adPayload)}`;
    await logStep(
      mode,
      'step-6-ads',
      { request: { method: 'POST', summary }, note: 'dry-run: not sent' },
      [
        'DRY RUN would send:',
        `  POST /act_${config.META_AD_ACCOUNT_ID}/ads`,
        `  ${JSON.stringify(adPayload, null, 2).split('\n').join('\n  ')}`,
        '  (guard: status must be PAUSED — anything else refuses to send)',
      ],
    );
  } else {
    assertOnlyPaused(adPayload, 'probe ad creation');
    try {
      const res = await graphPost<AdResponse>(config, `/act_${config.META_AD_ACCOUNT_ID}/ads`, adPayload);
      adId = res.data.id;
      await logStep(
        mode,
        'step-6-ads',
        {
          request: { method: 'POST', summary: res.requestSummary },
          responseIds: { ad_id: adId },
          responseSummary: `name=${adName} status=PAUSED`,
        },
        [`POST ads -> ad_id=${adId} (persisted to journal)`],
      );
    } catch (err) {
      if (err instanceof GraphApiError) await stopOnGraphError(mode, 'step-6-ads', err);
      if (err instanceof GraphTimeoutError || isTransportError(err)) {
        await reconcileAfterNoResponse(mode, 'step-6-ads', noResponseReason(config, err, 'ads'), {
          kind: 'ad',
          name: adName,
          lookup: () => findAdByNameInAdSet(config, adName),
          adopt: (id) => {
            adId = id;
          },
        });
      } else {
        throw err;
      }
    }
  }

  // ---- Step 7: readback + assertions ----
  console.log('--- Step 7: readback GET /{new_ad_id} + assertions ---');
  if (mode === 'dry-run') {
    const summary = `GET https://graph.facebook.com/${config.META_GRAPH_VERSION}/{new_ad_id}?fields=id,name,status,configured_status,effective_status,adset_id,creative{id,image_hash,object_story_spec}`;
    await logStep(
      mode,
      'step-7-readback',
      { request: { method: 'GET', summary }, note: 'dry-run: skipped (no ad created); assertions listed below' },
      [
        'DRY RUN: readback skipped (no ad was created). With --execute it would send:',
        `  ${summary}`,
        '  and assert: status/configured_status is PAUSED; adset_id matches; image_hash matches step 4;',
        '  link and message match the step-5 payload. PASS/FAIL printed per assertion.',
      ],
    );
    console.log('\nDry run complete. No writes were sent. Review the requests above, then run with --execute.');
    return;
  }

  if (!adId || !imageHash || !creativeId) {
    fail(['STOPPING: missing IDs from earlier steps; cannot perform readback.']);
  }
  try {
    const rb = await graphGet<AdReadback>(config, `/${adId}`, {
      fields: 'id,name,status,configured_status,effective_status,adset_id,creative{id,image_hash,object_story_spec}',
    });
    const ad = rb.data;
    const statusValues = [ad.status, ad.configured_status].filter((v): v is string => !!v);
    const statusOk = statusValues.length > 0 && statusValues.every((v) => v === 'PAUSED');
    const adsetOk = ad.adset_id === config.META_ADSET_ID;
    const hashOk = ad.creative?.image_hash === imageHash;
    const linkOk = normalizeLink(ad.creative?.object_story_spec?.link_data?.link) === normalizeLink(config.META_TEST_LINK_URL);
    const messageOk = ad.creative?.object_story_spec?.link_data?.message === PROBE_MESSAGE;
    const creativeIdOk = ad.creative?.id === creativeId;

    const checks: Array<[string, boolean, string]> = [
      ['status/configured_status is PAUSED', statusOk, `status=${ad.status ?? '?'} configured_status=${ad.configured_status ?? '?'} effective_status=${ad.effective_status ?? '?'}`],
      ['adset_id matches', adsetOk, `got=${ad.adset_id ?? '?'} want=${config.META_ADSET_ID}`],
      ['image_hash matches step 4', hashOk, `got=${ad.creative?.image_hash ?? '?'} want=${imageHash}`],
      ['link matches', linkOk, `got=${ad.creative?.object_story_spec?.link_data?.link ?? '?'} want=${config.META_TEST_LINK_URL}`],
      ['message matches', messageOk, `got=${JSON.stringify(ad.creative?.object_story_spec?.link_data?.message)} want=${JSON.stringify(PROBE_MESSAGE)}`],
      ['creative_id matches step 5', creativeIdOk, `got=${ad.creative?.id ?? '?'} want=${creativeId}`],
    ];
    const allOk = checks.every(([, ok]) => ok);
    const lines = [
      `GET /${adId} -> name=${JSON.stringify(ad.name)}`,
      ...checks.map(([label, ok, detail]) => `  [${ok ? 'PASS' : 'FAIL'}] ${label} (${detail})`),
      allOk ? 'READBACK: ALL ASSERTIONS PASSED.' : 'READBACK: SOME ASSERTIONS FAILED — see above.',
    ];
    await logStep(
      mode,
      'step-7-readback',
      {
        request: { method: 'GET', summary: rb.requestSummary },
        responseIds: { ad_id: ad.id },
        responseSummary: checks.map(([label, ok]) => `${ok ? 'PASS' : 'FAIL'}:${label}`).join(' | '),
        note: allOk ? 'all readback assertions passed' : 'READBACK FAILURES — see responseSummary',
      },
      lines,
    );
    if (!allOk) process.exit(1);
    console.log('\nProbe complete: PAUSED replacement ad created and verified. Original ads untouched.');
    console.log('To remove the probe objects, run: npm run cleanup:probe -- --execute');
  } catch (err) {
    if (err instanceof GraphApiError) await stopOnGraphError(mode, 'step-7-readback', err);
    if (isTransportError(err)) {
      await stopOnTransportError(mode, 'step-7-readback', `GET /${adId}?fields=id,name,status,...`, err);
    }
    throw err;
  }
}

function normalizeLink(link: string | undefined): string {
  return (link ?? '').trim().replace(/\/+$/, '');
}

/** Look for an ad by exact name inside our ad set (used only to reconcile a POST timeout). */
async function findAdByNameInAdSet(config: OfferGuardConfig, name: string): Promise<NamedNode[]> {
  const res = await graphGet<{ data?: NamedNode[] }>(config, `/${config.META_ADSET_ID}/ads`, {
    fields: 'id,name,creative{id}',
    limit: '100',
  });
  return (res.data.data ?? []).filter((n) => n.name === name);
}

/** Look for a creative by exact name in our account (used only to reconcile a POST timeout). */
async function findCreativeByName(config: OfferGuardConfig, name: string): Promise<NamedNode[]> {
  const res = await graphGet<{ data?: NamedNode[] }>(config, `/act_${config.META_AD_ACCOUNT_ID}/adcreatives`, {
    fields: 'id,name',
    limit: '100',
  });
  return (res.data.data ?? []).filter((n) => n.name === name);
}

/** One-line reason for a POST that got no usable response (timeout or transport failure). */
function noResponseReason(config: OfferGuardConfig, err: GraphTimeoutError | TypeError, edge: string): string {
  if (err instanceof GraphTimeoutError) return `TIMEOUT on ${err.requestSummary}`;
  return `TRANSPORT FAILURE (${transportDetail(err)}) on POST /act_${config.META_AD_ACCOUNT_ID}/${edge}`;
}

async function reconcileAfterNoResponse(
  mode: Mode,
  step: string,
  reason: string,
  target: { kind: 'ad' | 'creative'; name: string; lookup: () => Promise<NamedNode[]>; adopt: (id: string) => void },
): Promise<void> {
  // Never retry a no-response POST blindly: first look for the object by name, then report.
  const header = [reason, `Reconcile: looking for ${target.kind} named ${JSON.stringify(target.name)} before any retry...`];
  let found: NamedNode[];
  try {
    found = await target.lookup();
  } catch (lookupErr) {
    const detail = lookupErr instanceof GraphApiError ? formatGraphError(lookupErr) : transportDetail(lookupErr);
    await logStep(
      mode,
      `${step}-reconcile`,
      {
        request: { method: 'GET', summary: `reconcile lookup for ${target.kind} ${JSON.stringify(target.name)}` },
        error: { message: `POST got no response and the reconcile lookup also failed: ${detail}` },
      },
      [...header, `Reconcile lookup failed: ${detail}`, 'STOPPING: object state is unknown; will not retry blindly.'],
    );
    process.exit(1);
  }
  if (found.length === 1 && found[0]) {
    const id = found[0].id;
    target.adopt(id);
    const key = target.kind === 'ad' ? 'ad_id' : 'creative_id';
    await logStep(
      mode,
      `${step}-reconcile`,
      {
        request: { method: 'GET', summary: `reconcile lookup for ${target.kind} ${JSON.stringify(target.name)}` },
        responseIds: { [key]: id },
        note: `POST got no response but the ${target.kind} exists; adopted id=${id}, continuing without retry`,
      },
      [...header, `Found exactly one ${target.kind}: id=${id}. Adopting it and continuing (no blind retry).`],
    );
    return;
  }
  await logStep(
    mode,
    `${step}-reconcile`,
    {
      request: { method: 'GET', summary: `reconcile lookup for ${target.kind} ${JSON.stringify(target.name)}` },
      responseSummary: found.length === 0 ? 'no matches' : `ambiguous: ${found.map((f) => f.id).join(',')}`,
      error: {
        message: `POST got no response; reconcile found ${found.length} matching ${target.kind}(s). Refusing to retry blindly.`,
      },
    },
    [
      ...header,
      found.length === 0
        ? `Found no ${target.kind} with that name. It may still have been created (indexing lag).`
        : `Found ${found.length} matching objects (${found.map((f) => f.id).join(', ')}) — ambiguous.`,
      'STOPPING: will not retry blindly. Inspect the journal, check Ads Manager, then clean up if needed.',
    ],
  );
  process.exit(1);
}

// Note: the probe creates only; deletion lives in scripts/cleanup-probe.ts.
await main();
