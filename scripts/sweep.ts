#!/usr/bin/env tsx
/**
 * Campaign sweep: run every manifest entry through snapshot → extract ad →
 * capture page → extract page → compare → verdict → (repair) and store
 * everything in data/offer-guard.db.
 *
 *   npm run sweep -- --manifest fixtures/campaign.json [--fresh] [--lang he|en]
 *
 * Model API calls are live (a few cents); the Graph API is never touched.
 * Expected verdicts come from tests/fixtures/expected-verdicts.json
 * (local-only, never sent to a model) for the PASS/FAIL column.
 */
import { join } from 'node:path';
import { findRepoRoot, loadEnvFiles } from '../src/shared/env.js';
import { describeModelConfigForLog, loadModelConfig } from '../src/shared/config.js';
import { parseLang, t, type Lang } from '../src/shared/i18n.js';
import { VERDICT_MESSAGE_KEY, verdictText } from '../src/shared/verdict.js';
import { parseAllowedHosts } from '../src/server/browser/capture.js';
import { createModelClient } from '../src/server/models/client.js';
import { runSweep, type SweepRow } from '../src/server/workflow/sweep.js';

const REPO_ROOT = findRepoRoot(import.meta.url);

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : undefined;
}

function usage(): never {
  console.log(`Usage: sweep --manifest <path> [--fresh] [--lang he|en]

  --manifest <path>  campaign manifest (default: fixtures/campaign.json)
  --fresh            bypass the result cache and re-check every ad
  --lang he|en       output language (default: en)`);
  process.exit(1);
}

function shortVerdict(lang: Lang, v: string): string {
  // ERROR rows carry free text, not a Verdict — never look them up as keys.
  if (!(v in VERDICT_MESSAGE_KEY)) return v;
  return verdictText(lang, v as Parameters<typeof verdictText>[1]);
}

async function main(): Promise<void> {
  loadEnvFiles(REPO_ROOT);
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) usage();
  const lang = parseLang(argv);
  const manifestOpt = argValue(argv, '--manifest');
  const manifestPath = join(REPO_ROOT, manifestOpt ?? 'fixtures/campaign.json');
  const fresh = argv.includes('--fresh');
  const unknown = argv.find((a) => a.startsWith('--') && !['--manifest', '--fresh', '--lang'].includes(a));
  if (unknown) {
    console.log(`Unknown flag: ${unknown}`);
    usage();
  }

  const config = loadModelConfig(process.env);
  const client = createModelClient(config);
  const allowedHosts = parseAllowedHosts(process.env);
  const pagesBase = process.env.OFFER_GUARD_PAGES_BASE?.trim() || null;
  const dbPath = join(REPO_ROOT, 'data', 'offer-guard.db');

  console.log(`=== ${t(lang, 'sweep_title')} ===`);
  console.log(`extract=${config.MODEL_EXTRACT} sam=${config.MODEL_SAM} base=${config.MODEL_API_BASE}`);
  console.log(`key=${describeModelConfigForLog(config)['MODEL_API_KEY']}`);
  console.log(t(lang, 'sweep_using_pages', { base: pagesBase ?? '(local static server)' }));
  console.log(t(lang, 'sweep_using_db', { path: 'data/offer-guard.db' }));
  console.log(`allowed hosts: ${allowedHosts.join(', ')}${fresh ? ' [--fresh]' : ''}\n`);

  const printRow = (r: SweepRow): void => {
    console.log(
      `- ${r.ad}/${r.lang}: expected=${shortVerdict(lang, r.expected)} got=${shortVerdict(lang, r.got)} ` +
        `${t(lang, r.pass ? 'word_pass' : 'word_fail')} ` +
        `${t(lang, r.cached ? 'word_cached' : 'word_fresh')} ${t(lang, 'line_latency', { ms: r.latencyMs })} ` +
        `${t(lang, 'line_model_calls', { count: r.modelCalls })}`,
    );
  };

  const report = await runSweep({
    repoRoot: REPO_ROOT,
    manifestPath,
    expectedPath: join(REPO_ROOT, 'tests', 'fixtures', 'expected-verdicts.json'),
    fresh,
    lang,
    client,
    extractModel: config.MODEL_EXTRACT,
    samModel: config.MODEL_SAM,
    allowedHosts,
    pagesBase,
    dbPath,
    onRow: printRow,
  });
  console.log(`run: ${report.runId} · ` + t(lang, 'sweep_using_pages', { base: report.pagesBase }));

  console.log('');
  const w = (s: string, n: number): string => s.padEnd(n).slice(0, n);
  console.log(
    `${w(t(lang, 'hdr_ad'), 8)} ${w(t(lang, 'hdr_language'), 6)} ${w(t(lang, 'hdr_expected'), 22)} ` +
      `${w(t(lang, 'hdr_got'), 22)} ${w(t(lang, 'hdr_result'), 8)} ${w(t(lang, 'hdr_cached'), 10)} ` +
      `${w(t(lang, 'hdr_latency'), 12)} ${t(lang, 'hdr_calls')}`,
  );
  for (const r of report.rows) {
    console.log(
      `${w(r.ad, 8)} ${w(r.lang, 6)} ${w(shortVerdict(lang, r.expected), 22)} ` +
        `${w(shortVerdict(lang, r.got), 22)} ${w(t(lang, r.pass ? 'word_pass' : 'word_fail'), 8)} ` +
        `${w(t(lang, r.cached ? 'word_cached' : 'word_fresh'), 10)} ${w(`${r.latencyMs} ms`, 12)} ${r.modelCalls}`,
    );
  }
  console.log(
    `${t(lang, 'line_latency', { ms: report.totalLatencyMs })}; ` +
      `${t(lang, 'line_api_calls', { count: report.totalCalls })}; ` +
      `${t(lang, 'line_usage', { in: report.usage.in, out: report.usage.out, total: report.usage.total })}`,
  );
  console.log(report.allPass ? t(lang, 'sweep_all_pass') : t(lang, 'sweep_failures'));
  process.exit(report.allPass ? 0 : 1);
}

await main();
