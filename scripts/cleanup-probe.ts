#!/usr/bin/env tsx
/**
 * Delete ONLY the ads and creatives created by scripts/probe-meta-write.ts,
 * identified by the IDs recorded in .local/probe-journal.jsonl. Nothing else.
 *
 *   npm run cleanup:probe              # dry run (default): prints what it would delete
 *   npm run cleanup:probe -- --execute # actually sends the DELETEs
 *
 * Note: uploaded ad images (adimages) have no delete API; image hashes are
 * content-addressed and harmless, so they are left alone and reported.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadConfig, type OfferGuardConfig } from '../src/shared/config.js';
import { GraphApiError, formatGraphError, graphDelete } from '../src/server/meta/graph.js';
import { appendJournal, nowIso } from '../src/server/workflow/journal.js';
import { readJournal } from '../src/server/workflow/journal.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const JOURNAL_PATH = join(REPO_ROOT, '.local', 'probe-journal.jsonl');

type Mode = 'dry-run' | 'execute';

function usage(exitCode: number): never {
  console.log(`Usage: cleanup-probe [--execute]

  (no flag)   Dry run: lists the probe-created ads/creatives found in the journal.
  --execute   Deletes exactly those ads and creatives (ads first, then creatives).

Deletes ONLY IDs recorded in .local/probe-journal.jsonl. Nothing else.`);
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) usage(0);
  const unknown = args.filter((a) => a !== '--execute');
  if (unknown.length > 0) {
    console.log(`Unknown flags: ${unknown.join(' ')}`);
    usage(1);
  }
  const mode: Mode = args.includes('--execute') ? 'execute' : 'dry-run';

  dotenv.config({ path: join(REPO_ROOT, '.env') });
  let config: OfferGuardConfig;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    console.log('Config validation failed:');
    console.log(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  let entries;
  try {
    entries = await readJournal(JOURNAL_PATH);
  } catch {
    console.log('No journal found at .local/probe-journal.jsonl — nothing to clean up.');
    return;
  }

  const adIds = new Set<string>();
  const creativeIds = new Set<string>();
  const imageHashes = new Set<string>();
  for (const entry of entries) {
    const ids = entry.responseIds ?? {};
    if (ids.ad_id) adIds.add(ids.ad_id);
    if (ids.creative_id) creativeIds.add(ids.creative_id);
    if (ids.image_hash) imageHashes.add(ids.image_hash);
  }

  console.log(`=== Offer Guard probe cleanup (${mode}) ===`);
  console.log(`ads in journal:       ${adIds.size ? [...adIds].join(', ') : '(none)'}`);
  console.log(`creatives in journal: ${creativeIds.size ? [...creativeIds].join(', ') : '(none)'}`);
  console.log(
    `image hashes:         ${imageHashes.size ? [...imageHashes].join(', ') : '(none)'} (no delete API; left alone)`,
  );
  console.log('');

  if (adIds.size === 0 && creativeIds.size === 0) {
    console.log('Nothing to delete.');
    return;
  }

  if (mode === 'dry-run') {
    for (const id of adIds) console.log(`DRY RUN would send: DELETE /${id} (probe ad)`);
    for (const id of creativeIds) console.log(`DRY RUN would send: DELETE /${id} (probe creative)`);
    console.log('\nDry run complete. Nothing was deleted. Pass --execute to delete exactly the IDs above.');
    await appendJournal(JOURNAL_PATH, {
      ts: nowIso(),
      step: 'cleanup-plan',
      mode,
      request: { method: 'DELETE', summary: 'dry-run plan only' },
      responseSummary: `ads=[${[...adIds].join(',')}] creatives=[${[...creativeIds].join(',')}]`,
      note: 'dry-run: nothing deleted',
    });
    return;
  }

  // Ads first, then creatives (a creative in use by an ad cannot be deleted).
  let failures = 0;
  for (const id of adIds) {
    try {
      const res = await graphDelete<{ success?: boolean }>(config, `/${id}`);
      console.log(`DELETE /${id} (probe ad) -> ${JSON.stringify(res.data)}`);
      await appendJournal(JOURNAL_PATH, {
        ts: nowIso(),
        step: 'cleanup-delete-ad',
        mode,
        request: { method: 'DELETE', summary: res.requestSummary },
        responseIds: { ad_id: id },
        responseSummary: JSON.stringify(res.data),
      });
    } catch (err) {
      failures += 1;
      if (err instanceof GraphApiError) {
        console.log(formatGraphError(err));
        await appendJournal(JOURNAL_PATH, {
          ts: nowIso(),
          step: 'cleanup-delete-ad',
          mode,
          request: { method: 'DELETE', summary: err.requestSummary },
          error: {
            message: err.body.message,
            code: err.body.code,
            error_subcode: err.body.error_subcode,
            error_user_msg: err.body.error_user_msg,
            fbtrace_id: err.body.fbtrace_id,
            httpStatus: err.httpStatus,
          },
        });
      } else {
        console.log(`DELETE /${id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  for (const id of creativeIds) {
    try {
      const res = await graphDelete<{ success?: boolean }>(config, `/${id}`);
      console.log(`DELETE /${id} (probe creative) -> ${JSON.stringify(res.data)}`);
      await appendJournal(JOURNAL_PATH, {
        ts: nowIso(),
        step: 'cleanup-delete-creative',
        mode,
        request: { method: 'DELETE', summary: res.requestSummary },
        responseIds: { creative_id: id },
        responseSummary: JSON.stringify(res.data),
      });
    } catch (err) {
      failures += 1;
      if (err instanceof GraphApiError) {
        console.log(formatGraphError(err));
        await appendJournal(JOURNAL_PATH, {
          ts: nowIso(),
          step: 'cleanup-delete-creative',
          mode,
          request: { method: 'DELETE', summary: err.requestSummary },
          error: {
            message: err.body.message,
            code: err.body.code,
            error_subcode: err.body.error_subcode,
            error_user_msg: err.body.error_user_msg,
            fbtrace_id: err.body.fbtrace_id,
            httpStatus: err.httpStatus,
          },
        });
      } else {
        console.log(`DELETE /${id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (failures > 0) {
    console.log(`\nCleanup finished with ${failures} failure(s) — see above.`);
    process.exit(1);
  }
  console.log('\nCleanup complete: all probe ads and creatives deleted.');
}

await main();
