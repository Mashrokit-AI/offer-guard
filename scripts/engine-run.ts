#!/usr/bin/env tsx
/**
 * Engine verification runner (session 10): one source through the protected
 * batch engine, outputs + manifests + ledger under artifacts/engine-10/.
 *
 *   npm run engine:run -- --source gali-he --sizes ig-feed-11,fb-link,ig-story-916
 *   npm run engine:run -- --source gali-he --sizes all
 *   npm run engine:run -- --source vela --sizes ig-feed-11,fb-link,ig-story-916 --no-wonder
 *
 * Flags: --source <gali-he|gali-en|vela|dafna|noa> (required)
 *        --sizes <csv preset ids | all> (default: the 3 iteration sizes)
 *        --out <dir> (default artifacts/engine-10/<source>)
 *        --no-wonder (code planner + deterministic checks only)
 *        --skip-review (compose only; fastest smoke)
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { presetById, PRESETS } from '../src/shared/presets.js';
import { templateSpecSchema } from '../src/shared/schemas.js';
import { findRepoRoot, loadEnvFiles } from '../src/shared/env.js';
import { loadModelConfig } from '../src/shared/config.js';
import { createModelClient } from '../src/server/models/client.js';
import { runBatchSource, type BatchSize } from '../src/server/adfit/batch.js';
import { CostLedger } from '../src/server/models/costs.js';
import { closeSharedBrowser } from '../src/server/repair/render.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
loadEnvFiles(REPO_ROOT);

const SOURCES: Record<string, { brand: string; file: string; name: string }> = {
  'gali-he': { brand: 'gali', file: 'source-he.png', name: 'GALI' },
  'gali-en': { brand: 'gali', file: 'source-en.png', name: 'GALI' },
  vela: { brand: 'vela', file: 'source-en.png', name: 'VELA' },
  dafna: { brand: 'dafna', file: 'source-he.png', name: 'DAFNA' },
  noa: { brand: 'noa', file: 'source.png', name: 'NOA' },
};

const ITERATION_SIZES = ['ig-feed-11', 'fb-link', 'ig-story-916'];

function arg(name: string, def: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  return process.argv[i + 1] ?? def;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const sourceKey = arg('source');
  if (!sourceKey || !SOURCES[sourceKey]) {
    console.error(`usage: engine:run --source <${Object.keys(SOURCES).join('|')}> [--sizes csv|all] [--out dir] [--no-wonder] [--skip-review]`);
    process.exit(2);
  }
  const src = SOURCES[sourceKey] as { brand: string; file: string; name: string };
  const sizesRaw = arg('sizes', ITERATION_SIZES.join(','));
  const sizeIds = sizesRaw === 'all' ? PRESETS.map((p) => p.id) : (sizesRaw as string).split(',').map((s) => s.trim()).filter(Boolean);
  const outDir = arg('out', join(REPO_ROOT, 'artifacts', 'engine-10', sourceKey)) as string;
  const wonderAllowed = !has('no-wonder');
  const skipReview = has('skip-review');

  const brandDir = join(REPO_ROOT, 'fixtures', 'brands', src.brand);
  const brandJson = JSON.parse(await readFile(join(brandDir, 'brand.json'), 'utf8')) as {
    templates: Array<{ id: string; preset: string; image: string; spec: string }>;
  };
  const sourceBytes = await readFile(join(brandDir, src.file));
  const meta = await sharp(sourceBytes).metadata();

  const sizes: BatchSize[] = [];
  for (const presetId of sizeIds) {
    const preset = presetById(presetId);
    if (!preset) {
      console.error(`unknown preset: ${presetId}`);
      process.exit(2);
    }
    // Exact-size template when the brand has one, else no-template path.
    const tpl = brandJson.templates.find((t) => t.preset === presetId) ?? null;
    let template: BatchSize['template'] = null;
    if (tpl) {
      const spec = templateSpecSchema.parse(JSON.parse(await readFile(join(brandDir, tpl.spec), 'utf8')));
      template = { id: tpl.id, spec, imageBytes: await readFile(join(brandDir, tpl.image)), mimeType: 'image/png' };
    }
    let framePng: Buffer | null = null;
    try {
      framePng = await readFile(join(brandDir, `frame-${preset.width}x${preset.height}.png`));
    } catch { /* no frame */ }
    // Legacy frame naming: frame-9x16.png for 1080x1920.
    if (!framePng && preset.width === 1080 && preset.height === 1920) {
      try {
        framePng = await readFile(join(brandDir, 'frame-9x16.png'));
      } catch { /* no frame */ }
    }
    sizes.push({ preset: preset as BatchSize['preset'], template, framePng, sourceIndex: 0 });
  }

  const cfg = loadModelConfig(process.env);
  const client = createModelClient(cfg);
  const models = {
    client,
    extractModel: cfg.MODEL_EXTRACT,
    samModel: cfg.MODEL_SAM,
    wonderModel: cfg.MODEL_WONDER,
    image: { baseUrl: cfg.MODEL_API_BASE, apiKey: cfg.MODEL_API_KEY, model: cfg.MODEL_IMAGE },
  };
  const ledger = new CostLedger(25);
  await mkdir(outDir, { recursive: true });

  console.log(`engine: ${sourceKey} x [${sizeIds.join(', ')}] wonder=${wonderAllowed} skipReview=${skipReview}`);
  const t0 = Date.now();
  const batch = await runBatchSource({
    models,
    input: { id: sourceKey, bytes: sourceBytes, mimeType: 'image/png', width: meta.width ?? 1080, height: meta.height ?? 1080 },
    sizes,
    brandName: src.name,
    jobTag: `engine-10-${sourceKey}`,
    repoRoot: REPO_ROOT,
    ledger,
    wonderAllowed,
    concurrency: 4,
    skipReview,
    onPreview: (o) => {
      console.log(`  preview ${o.preset.id} at ${((Date.now() - t0) / 1000).toFixed(1)}s (${o.planner}/${o.family})`);
    },
  });

  // Save everything (never the demo dir).
  const report: Array<Record<string, unknown>> = [];
  for (const o of batch.outcomes) {
    if (o.png && o.plan && o.manifest) {
      await writeFile(join(outDir, `${o.preset.id}.png`), o.png);
      if (o.plate) await writeFile(join(outDir, `${o.preset.id}.plate.png`), o.plate);
      await writeFile(join(outDir, `${o.preset.id}.manifest.json`), JSON.stringify(o.manifest, null, 2));
      await writeFile(join(outDir, `${o.preset.id}.trace.json`), JSON.stringify(o.trace.all(), null, 2));
      if (o.repaired) await writeFile(join(outDir, `before-${o.preset.id}.png`), o.repaired.beforePng);
    }
    const proofs = o.proofs ?? {};
    const minCov = Object.keys(proofs).length > 0 ? Math.min(...Object.values(proofs).map((p) => p.coverage)) : null;
    report.push({
      preset: o.preset.id,
      planner: o.planner,
      family: o.family,
      status: o.error ? 'failed' : undefined,
      checks: { protected: o.checks.protected_pixels.status, text: o.checks.text.status, layout: o.checks.layout_review.status },
      proofCoverage: minCov !== null ? Math.round(minCov * 100) : null,
      repaired: o.repaired ? o.repaired.patches : null,
      seconds: Math.round((o.latencyMs / 1000) * 10) / 10,
      error: o.error,
      findings: o.findings.map((f) => `${f.severity}:${f.code}:${f.element ?? ''}:${f.detail}`.slice(0, 160)),
    });
  }
  await writeFile(join(outDir, 'ledger.json'), JSON.stringify(ledger.toJSON(), null, 2));
  await writeFile(join(outDir, 'report.json'), JSON.stringify({
    source: sourceKey,
    sizes: sizeIds,
    wonderAllowed,
    skipReview,
    firstPreviewMs: batch.firstPreviewMs,
    totalMs: batch.totalMs,
    wonderUsed: batch.wonderUsed,
    totals: ledger.totals(),
    outputs: report,
  }, null, 2));

  console.log(`first preview: ${batch.firstPreviewMs !== null ? `${(batch.firstPreviewMs / 1000).toFixed(1)}s` : 'none'}`);
  console.log(`total: ${(batch.totalMs / 1000).toFixed(1)}s  wonder used: ${batch.wonderUsed}`);
  console.log(`ledger: $${ledger.totalUsd().toFixed(4)} ${JSON.stringify(ledger.totals())}`);
  for (const r of report) console.log(`  ${r['preset']}: ${JSON.stringify(r)}`);
  await closeSharedBrowser().catch(() => undefined);
}

await main();
