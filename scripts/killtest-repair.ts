#!/usr/bin/env tsx
/**
 * Repair-proof kill test (ARCHITECTURE.md section 12, spec in sections 8+5).
 *
 * Runs all 6 fixtures (Hebrew + English) through the full repair pipeline:
 * Spark extraction → verdict → panel snap → SAM protection masks → repair
 * gates → Chromium render → Sharp composite → pixel proof → fresh Spark
 * revalidation. Model API only (read-only); never touches the Graph API.
 *
 *   npm run killtest:repair [-- --lang he]
 *
 * Expected: ad-01 clean → CLEAN (no repair); ad-02 wrong → repaired with
 * zero-diff proof + passing revalidation; ad-03 overlap → REFUSED with
 * panel_not_opaque + panel_overlaps_protected.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadEnvFiles } from '../src/shared/env.js';
import { describeModelConfigForLog, loadModelConfig } from '../src/shared/config.js';
import { countMaskInRect } from '../src/shared/geometry.js';
import { parseLang, t, type Lang } from '../src/shared/i18n.js';
import {
  createModelClient,
  type ModelUsage,
} from '../src/server/models/client.js';
import { extractAdClaims, ExtractError } from '../src/server/models/extract-ad.js';
import type { AdClaims } from '../src/shared/schemas.js';
import { snapPanel, PanelSnapError, type PanelSnap } from '../src/server/repair/panel.js';
import { buildProtectedMask, type ProtectionResult } from '../src/server/repair/masks.js';
import {
  compareClaims,
  findOutsidePanelContradiction,
  isClean,
  loadOfferSpec,
} from '../src/server/repair/spec.js';
import { buildPanelCopy } from '../src/server/repair/templates.js';
import { renderPanel, RenderBlocker } from '../src/server/repair/render.js';
import { compositePanel, decodeRgba } from '../src/server/repair/composite.js';
import { artifactDigest, pixelProof, type PixelProof } from '../src/server/repair/proof.js';
import { revalidate, type Revalidation } from '../src/server/repair/revalidate.js';
import { loadGroundTruth } from './ground-truth.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');

type Verdict = 'clean' | 'repaired' | 'refused';

interface AdCase {
  id: string;
  expect: Verdict;
  expectBlockers?: string[];
}

const ADS: AdCase[] = [
  { id: 'ad-01-clean', expect: 'clean' },
  { id: 'ad-02-wrong', expect: 'repaired' },
  {
    id: 'ad-03-overlap',
    expect: 'refused',
    expectBlockers: ['panel_not_opaque', 'panel_overlaps_protected'],
  },
  { id: 'ad-01-clean-en', expect: 'clean' },
  { id: 'ad-02-wrong-en', expect: 'repaired' },
  {
    id: 'ad-03-overlap-en',
    expect: 'refused',
    expectBlockers: ['panel_not_opaque', 'panel_overlaps_protected'],
  },
];

const VERDICT_KEY = { clean: 'verdict_clean', repaired: 'verdict_repaired', refused: 'verdict_refused' } as const;
const BLOCKER_KEY: Record<string, 'blocker_panel_not_opaque' | 'blocker_panel_overlaps_protected' | 'blocker_wrong_text_outside_panel' | 'blocker_text_does_not_fit' | 'blocker_protected_mask_empty' | 'blocker_protected_mask_tiny' | 'blocker_panel_not_found'> = {
  panel_not_opaque: 'blocker_panel_not_opaque',
  panel_overlaps_protected: 'blocker_panel_overlaps_protected',
  wrong_text_outside_panel: 'blocker_wrong_text_outside_panel',
  text_does_not_fit: 'blocker_text_does_not_fit',
  protected_mask_empty: 'blocker_protected_mask_empty',
  protected_mask_tiny: 'blocker_protected_mask_tiny',
  panel_not_found: 'blocker_panel_not_found',
};

function blockerText(lang: Lang, blocker: string): string {
  const key = BLOCKER_KEY[blocker];
  return key ? t(lang, key) : blocker;
}

interface Row {
  ad: string;
  expected: Verdict;
  got: Verdict;
  pass: boolean;
  detail: string;
}

/** Changed pixels red, everything else dimmed. */
async function writeDiffPng(
  before: { data: Buffer; width: number; height: number },
  after: { data: Buffer; width: number; height: number },
  outPath: string,
): Promise<void> {
  const { width, height } = before;
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const changed =
      before.data[o] !== after.data[o] ||
      before.data[o + 1] !== after.data[o + 1] ||
      before.data[o + 2] !== after.data[o + 2];
    if (changed) {
      out[o] = 255;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = 255;
    } else {
      out[o] = Math.round((before.data[o] as number) * 0.35);
      out[o + 1] = Math.round((before.data[o + 1] as number) * 0.35);
      out[o + 2] = Math.round((before.data[o + 2] as number) * 0.35);
      out[o + 3] = 255;
    }
  }
  await sharp(out, { raw: { width, height, channels: 4 } }).png().toFile(outPath);
}

/** Product green + logo blue over the source, snapped rect outlined red. */
async function writeMasksPng(
  source: Buffer,
  width: number,
  height: number,
  protection: ProtectionResult,
  rect: { x: number; y: number; w: number; h: number },
  outPath: string,
): Promise<void> {
  const overlay = Buffer.alloc(width * height * 4, 0);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (protection.product[i]) {
      overlay[o] = 0;
      overlay[o + 1] = 220;
      overlay[o + 2] = 0;
      overlay[o + 3] = 110;
    }
    if (protection.logo[i]) {
      overlay[o] = 0;
      overlay[o + 1] = 120;
      overlay[o + 2] = 255;
      overlay[o + 3] = 140;
    }
  }
  const t2 = 4;
  const x1 = Math.max(0, Math.round(rect.x));
  const y1 = Math.max(0, Math.round(rect.y));
  const x2 = Math.min(width, Math.round(rect.x + rect.w));
  const y2 = Math.min(height, Math.round(rect.y + rect.h));
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const onBorder = y < y1 + t2 || y >= y2 - t2 || x < x1 + t2 || x >= x2 - t2;
      if (!onBorder) continue;
      const o = (y * width + x) * 4;
      overlay[o] = 255;
      overlay[o + 1] = 0;
      overlay[o + 2] = 0;
      overlay[o + 3] = 255;
    }
  }
  await sharp(source).composite([{ input: overlay, raw: { width, height, channels: 4 } }]).png().toFile(outPath);
}

function sumUsage(usages: Array<ModelUsage | undefined>): { in: number; out: number; total: number } {
  let input = 0;
  let output = 0;
  let total = 0;
  for (const u of usages) {
    if (!u) continue;
    input += u.inputTokens ?? 0;
    output += u.outputTokens ?? 0;
    total += u.totalTokens ?? 0;
  }
  return { in: input, out: output, total };
}

async function main(): Promise<void> {
  loadEnvFiles(REPO_ROOT);
  const lang = parseLang(process.argv.slice(2));
  const config = loadModelConfig(process.env);
  const gt = await loadGroundTruth(REPO_ROOT);
  const spec = loadOfferSpec(JSON.parse(await readFile(join(REPO_ROOT, 'fixtures', 'ads', 'offer-spec.json'), 'utf8')));
  const client = createModelClient(config);

  console.log(`=== ${t(lang, 'killtest_repair_title')} ===`);
  console.log(`extract=${config.MODEL_EXTRACT} sam=${config.MODEL_SAM} base=${config.MODEL_API_BASE}`);
  console.log(`key=${describeModelConfigForLog(config)['MODEL_API_KEY']}`);
  console.log('Model API only (read-only). Ground truth is local-only, never sent.\n');

  const rows: Row[] = [];
  let allPass = true;
  let totalCalls = 0;
  let totalLatency = 0;
  const allUsages: Array<ModelUsage | undefined> = [];

  for (const adCase of ADS) {
    const g = gt.ads[adCase.id];
    if (!g) {
      rows.push({ ad: adCase.id, expected: adCase.expect, got: 'refused', pass: false, detail: 'NO GROUND TRUTH' });
      allPass = false;
      continue;
    }
    const started = Date.now();
    let calls = 0;
    const usages: Array<ModelUsage | undefined> = [];
    const dir = join(REPO_ROOT, 'artifacts', 'repair', adCase.id);
    await mkdir(dir, { recursive: true });

    console.log(`--- ${adCase.id} ---`);
    try {
      const sourceBytes = await readFile(join(REPO_ROOT, g.file));
      const before = await decodeRgba(sourceBytes);
      await writeFile(join(dir, 'before.png'), sourceBytes);

      const extracted = await extractAdClaims(client, {
        imageBytes: sourceBytes,
        mimeType: 'image/png',
        width: before.width,
        height: before.height,
        model: config.MODEL_EXTRACT,
      });
      calls += extracted.attempts.length;
      for (const a of extracted.attempts) usages.push(a.usage);
      const claims: AdClaims = extracted.claims;

      const comparisons = compareClaims(spec, claims);
      if (isClean(comparisons)) {
        // CLEAN: no repair job at all.
        const pass = adCase.expect === 'clean';
        const latencyMs = Date.now() - started;
        await writeFile(
          join(dir, 'result.json'),
          JSON.stringify({ test: 'killtest-repair', ad: adCase.id, verdict: 'clean', comparisons, latencyMs, modelCalls: calls }, null, 2) + '\n',
        );
        console.log(`  ${t(lang, 'verdict_clean')} — ${t(lang, 'line_latency', { ms: latencyMs })}; ${t(lang, 'line_model_calls', { count: calls })}`);
        rows.push({ ad: adCase.id, expected: adCase.expect, got: 'clean', pass, detail: t(lang, 'verdict_clean') });
        allPass = allPass && pass;
        totalCalls += calls;
        totalLatency += latencyMs;
        for (const u of usages) allUsages.push(u);
        continue;
      }

      // Wrong ad: snap the panel, then run every gate (all blockers reported).
      const blockers: string[] = [];
      let snap: PanelSnap | null = null;
      if (!claims.panel) {
        blockers.push('panel_not_found');
      } else {
        try {
          snap = snapPanel(before.data, before.width, before.height, { ...claims.panel.bbox });
          console.log(`  snap: rect=${JSON.stringify(snap.rect)} r=${snap.radius} opaque=${snap.opaque}`);
          if (!snap.opaque) blockers.push('panel_not_opaque');
        } catch (err) {
          if (err instanceof PanelSnapError) blockers.push(err.blocker);
          else throw err;
        }
      }

      const outside = findOutsidePanelContradiction(spec, claims);
      if (outside) blockers.push('wrong_text_outside_panel');

      const protection = await buildProtectedMask(client, {
        imageBytes: sourceBytes,
        mimeType: 'image/png',
        width: before.width,
        height: before.height,
        model: config.MODEL_SAM,
        sparkProductBox: claims.product_bbox ? { ...claims.product_bbox } : null,
        sparkLogoBox: claims.logo_bbox ? { ...claims.logo_bbox } : null,
        fallbackProductBox: { ...g.product_bbox },
        fallbackLogoBox: { ...g.logo_bbox },
      });
      calls += protection.calls;
      console.log(`  masks: product[${protection.labels.product}] logo[${protection.labels.logo.join(' + ')}]`);
      blockers.push(...protection.blockers);

      let overlapPx = -1;
      if (snap) {
        overlapPx = countMaskInRect(protection.protected, before.width, before.height, snap.rect);
        console.log(`  protected∩panel: ${overlapPx}px`);
        if (overlapPx > 0) blockers.push('panel_overlaps_protected');
        await writeMasksPng(sourceBytes, before.width, before.height, protection, snap.rect, join(dir, 'masks.png'));
      }

      if (blockers.length > 0) {
        const latencyMs = Date.now() - started;
        const pass =
          adCase.expect === 'refused' &&
          (adCase.expectBlockers ?? []).every((b) => blockers.includes(b));
        await writeFile(
          join(dir, 'result.json'),
          JSON.stringify(
            {
              test: 'killtest-repair',
              ad: adCase.id,
              verdict: 'refused',
              blockers,
              blockerReasons: blockers.map((b) => blockerText(lang, b)),
              snap,
              overlapPx,
              labels: protection.labels,
              latencyMs,
              modelCalls: calls,
            },
            null,
            2,
          ) + '\n',
        );
        for (const b of blockers) console.log(`  blocker: ${b} — ${blockerText(lang, b)}`);
        console.log(`  ${t(lang, 'verdict_refused')} — ${t(lang, 'line_latency', { ms: latencyMs })}; ${t(lang, 'line_model_calls', { count: calls })}`);
        rows.push({ ad: adCase.id, expected: adCase.expect, got: 'refused', pass, detail: blockers.join(', ') });
        allPass = allPass && pass;
        totalCalls += calls;
        totalLatency += latencyMs;
        for (const u of usages) allUsages.push(u);
        continue;
      }

      // No blockers: render, composite, prove, revalidate.
      const snapRect = (snap as PanelSnap).rect;
      const copy = buildPanelCopy(spec, claims.language);
      let panelPng: Buffer;
      try {
        const rendered = await renderPanel({
          width: Math.round(snapRect.w),
          height: Math.round(snapRect.h),
          radius: (snap as PanelSnap).radius,
          fill: (snap as PanelSnap).fill,
          textColor: (snap as PanelSnap).textColor,
          main: copy.main,
          sub: copy.sub,
          lang: claims.language,
        });
        panelPng = rendered.png;
        console.log(`  render: main=${rendered.mainPx}px sub=${rendered.subPx}px`);
      } catch (err) {
        if (err instanceof RenderBlocker) {
          const latencyMs = Date.now() - started;
          const pass = adCase.expect === 'refused' && (adCase.expectBlockers ?? []).includes(err.blocker);
          await writeFile(join(dir, 'result.json'), JSON.stringify({ test: 'killtest-repair', ad: adCase.id, verdict: 'refused', blockers: [err.blocker], latencyMs, modelCalls: calls }, null, 2) + '\n');
          console.log(`  blocker: ${err.blocker} — ${blockerText(lang, err.blocker)}`);
          rows.push({ ad: adCase.id, expected: adCase.expect, got: 'refused', pass, detail: err.blocker });
          allPass = allPass && pass;
          totalCalls += calls;
          totalLatency += latencyMs;
          for (const u of usages) allUsages.push(u);
          continue;
        }
        throw err;
      }
      await writeFile(join(dir, 'panel.png'), panelPng);

      const afterBytes = await compositePanel(sourceBytes, panelPng, snapRect);
      await writeFile(join(dir, 'after.png'), afterBytes);
      const after = await decodeRgba(afterBytes);
      const proof: PixelProof = pixelProof(before, after, snapRect, protection.protected);
      const roundTrip: PixelProof = pixelProof(before, await decodeRgba(afterBytes), snapRect, protection.protected);
      const digest = artifactDigest(afterBytes, spec.version);
      await writeDiffPng(before, after, join(dir, 'diff.png'));
      await writeFile(
        join(dir, 'proof.json'),
        JSON.stringify({ ad: adCase.id, rect: snapRect, proof, roundTrip, digest, specVersion: spec.version }, null, 2) + '\n',
      );
      console.log(`  ${t(lang, 'proof_changed_outside', { count: proof.changed_outside_rect })}; ${t(lang, 'proof_changed_protected', { count: proof.changed_inside_protected })}; ${t(lang, 'proof_max_diff', { diff: proof.max_channel_diff_outside })}`);
      console.log(`  ${t(lang, roundTrip.pass ? 'proof_roundtrip_ok' : 'proof_roundtrip_fail')}`);

      const rextracted = await extractAdClaims(client, {
        imageBytes: afterBytes,
        mimeType: 'image/png',
        width: after.width,
        height: after.height,
        model: config.MODEL_EXTRACT,
      });
      calls += rextracted.attempts.length;
      for (const a of rextracted.attempts) usages.push(a.usage);
      const reval: Revalidation = revalidate(claims, rextracted.claims, spec);
      await writeFile(join(dir, 'revalidation.json'), JSON.stringify({ ad: adCase.id, pass: reval.pass, checks: reval.checks }, null, 2) + '\n');
      for (const c of reval.checks) {
        if (!c.pass) console.log(`  reval [${t(lang, 'word_fail')}] ${c.check}: ${c.detail}`);
      }
      console.log(`  ${t(lang, reval.pass ? 'reval_pass' : 'reval_fail')}`);

      const repaired = proof.pass && roundTrip.pass && reval.pass;
      const verdict: Verdict = repaired ? 'repaired' : 'refused';
      const latencyMs = Date.now() - started;
      const detail = repaired
        ? `${t(lang, 'proof_pass')}, ${t(lang, 'reval_pass')}`
        : [proof.pass ? null : t(lang, 'proof_fail'), roundTrip.pass ? null : t(lang, 'proof_roundtrip_fail'), reval.pass ? null : t(lang, 'reval_fail')].filter(Boolean).join('; ');
      await writeFile(
        join(dir, 'result.json'),
        JSON.stringify({ test: 'killtest-repair', ad: adCase.id, verdict, proof, roundTrip, digest, revalidation: reval, latencyMs, modelCalls: calls }, null, 2) + '\n',
      );
      console.log(`  ${t(lang, VERDICT_KEY[verdict])} — ${t(lang, 'line_latency', { ms: latencyMs })}; ${t(lang, 'line_model_calls', { count: calls })}; ${t(lang, 'line_artifacts', { dir: `artifacts/repair/${adCase.id}/` })}`);
      const pass = verdict === adCase.expect;
      rows.push({ ad: adCase.id, expected: adCase.expect, got: verdict, pass, detail });
      allPass = allPass && pass;
      totalCalls += calls;
      totalLatency += latencyMs;
      for (const u of usages) allUsages.push(u);
    } catch (err) {
      allPass = false;
      const attempts = err instanceof ExtractError ? err.attempts : [];
      calls += attempts.length;
      totalCalls += calls;
      const detail = err instanceof Error ? err.message : String(err);
      console.log(`  [${t(lang, 'word_fail')}] error: ${detail}`);
      rows.push({ ad: adCase.id, expected: adCase.expect, got: 'refused', pass: false, detail });
    }
  }

  console.log('');
  const w = (s: string, n: number) => s.padEnd(n).slice(0, n);
  console.log(`${w(t(lang, 'hdr_ad'), 18)} ${w(t(lang, 'hdr_expected'), 10)} ${w(t(lang, 'hdr_got'), 10)} ${w(t(lang, 'hdr_result'), 8)} ${t(lang, 'hdr_detail')}`);
  for (const r of rows) {
    console.log(
      `${w(r.ad, 18)} ${w(t(lang, VERDICT_KEY[r.expected]), 10)} ${w(t(lang, VERDICT_KEY[r.got]), 10)} ${w(t(lang, r.pass ? 'word_pass' : 'word_fail'), 8)} ${r.detail}`,
    );
  }
  const total = sumUsage(allUsages);
  console.log(`${t(lang, 'line_latency', { ms: totalLatency })}; ${t(lang, 'line_api_calls', { count: totalCalls })}; ${t(lang, 'line_usage', { in: total.in, out: total.out, total: total.total })}`);
  console.log(allPass ? t(lang, 'repair_all_pass') : t(lang, 'repair_failures'));
  process.exit(allPass ? 0 : 1);
}

await main();
