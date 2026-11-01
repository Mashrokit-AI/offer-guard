#!/usr/bin/env tsx
/**
 * MatchPic live batch (one command, minimal approvals). Steps (comma-separated
 * --steps, default: all):
 *
 *   specs      parse missing fixture template specs (Spark) into fixtures/
 *   noa        generate the synthetic NOA photographic source (Muse Image)
 *   smoke      ONE fast output (GALI-he 1:1) to validate the wire shapes ($0.01)
 *   gali-fast  all 8 sizes for GALI-he in Fast mode
 *   gali-prot  all 8 sizes for GALI-he in Protected mode (+ demo export)
 *   noa-prot   all 8 sizes for NOA in Protected mode
 *
 * Outputs → artifacts/adfit-live/<run>/*.png + report.json (gitignored).
 * The gali-prot run is also exported to fixtures/brands/gali/demo/ as the
 * saved demo job served at GET /api/demo.
 *
 * Cost: $0.01 per Muse Image; Spark/SAM calls are counted, not priced.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { findRepoRoot, loadEnvFiles } from '../src/shared/env.js';
import { loadModelConfig } from '../src/shared/config.js';
import { PRESETS } from '../src/shared/presets.js';
import { templateSpecSchema, type TemplateSpec } from '../src/shared/schemas.js';
import { createModelClient } from '../src/server/models/client.js';
import { generateImage } from '../src/server/models/muse-image.js';
import { readTemplate } from '../src/server/models/template-read.js';
import { prepareSource, runOutput, runPool, type FitMode, type OutputTemplate } from '../src/server/adfit/pipeline.js';
import { TraceCollector } from '../src/server/workflow/trace.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
loadEnvFiles(REPO_ROOT);

const argv = process.argv.slice(2);
const stepsArg = argv.indexOf('--steps');
const STEPS = new Set(
  (stepsArg >= 0 ? (argv[stepsArg + 1] ?? '') : 'specs,noa,smoke,gali-fast,gali-prot,noa-prot')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const GALI = join(REPO_ROOT, 'fixtures', 'brands', 'gali');
const NOA = join(REPO_ROOT, 'fixtures', 'brands', 'noa');
const OUT = join(REPO_ROOT, 'artifacts', 'adfit-live');

const modelCfg = loadModelConfig(process.env);
const client = createModelClient(modelCfg);
const models = {
  client,
  extractModel: modelCfg.MODEL_EXTRACT,
  samModel: modelCfg.MODEL_SAM,
  image: { baseUrl: modelCfg.MODEL_API_BASE, apiKey: modelCfg.MODEL_API_KEY, model: modelCfg.MODEL_IMAGE },
};

interface SpecJob {
  dir: string;
  image: string;
  spec: string;
}

const SPEC_JOBS: SpecJob[] = [
  { dir: GALI, image: 'tpl-1x1.png', spec: 'spec-1x1.json' },
  { dir: GALI, image: 'tpl-4x5.png', spec: 'spec-4x5.json' },
  { dir: GALI, image: 'tpl-9x16.png', spec: 'spec-9x16.json' },
  { dir: GALI, image: 'tpl-1.91x1.png', spec: 'spec-1.91x1.json' },
  { dir: NOA, image: 'tpl-1x1.png', spec: 'spec-1x1.json' },
  { dir: NOA, image: 'tpl-9x16.png', spec: 'spec-9x16.json' },
];

async function stepSpecs(): Promise<void> {
  for (const job of SPEC_JOBS) {
    const specPath = join(job.dir, job.spec);
    if (existsSync(specPath)) {
      console.log(`specs: ${job.spec} exists, skipping`);
      continue;
    }
    const bytes = await readFile(join(job.dir, job.image));
    const meta = await sharp(bytes).metadata();
    const res = await readTemplate(client, {
      imageBytes: bytes,
      mimeType: 'image/png',
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      model: modelCfg.MODEL_EXTRACT,
    });
    await writeFile(specPath, `${JSON.stringify(res.spec, null, 2)}\n`);
    console.log(`specs: wrote ${job.spec} (${res.attempts.length} calls, ${res.totalLatencyMs} ms)`);
  }
}

async function stepNoa(): Promise<void> {
  const dest = join(NOA, 'source.png');
  if (existsSync(dest)) {
    console.log('noa: source.png exists, skipping (delete it to regenerate)');
    return;
  }
  const prompt = [
    'Warm advertising photograph for a fictional coffee brand: a brown paper coffee bag labeled "NOA" on a rustic wooden table,',
    'soft morning window light, blurred café background, rich browns and cream tones.',
    'Printed headline at the top in large Hebrew letters: "טרי מהקליה".',
    'Smaller Hebrew sub-line under it: "250 גרם · 89 ש״ח".',
    'Exact Hebrew spelling matters. No other text.',
  ].join(' ');
  const gen = await generateImage(models.image, prompt, '1080x1350');
  await writeFile(dest, gen.png);
  console.log(`noa: wrote source.png (${gen.png.length} bytes, ${gen.latencyMs} ms) — INSPECT the Hebrew before use`);
}

interface SizeReport {
  preset: string;
  mode: FitMode;
  ms: number;
  qa: string;
  retries: number;
  proof: string;
  modelCalls: number;
  imageCalls: number;
}

async function loadTemplate(dir: string, image: string, specFile: string, id: string): Promise<OutputTemplate | null> {
  const specPath = join(dir, specFile);
  if (!existsSync(specPath)) return null;
  const spec = templateSpecSchema.parse(JSON.parse(await readFile(specPath, 'utf8'))) as TemplateSpec;
  return { id, spec, imageBytes: await readFile(join(dir, image)), mimeType: 'image/png' };
}

async function runAllSizes(
  runName: string,
  sourcePath: string,
  brandName: string,
  mode: FitMode,
  templates: Map<string, OutputTemplate>,
  frameFor: Map<string, Buffer>,
): Promise<SizeReport[]> {
  const dir = join(OUT, runName);
  await mkdir(dir, { recursive: true });
  const bytes = await readFile(sourcePath);
  const meta = await sharp(bytes).metadata();
  const prepTrace = new TraceCollector();
  console.log(`${runName}: analyzing ${sourcePath.split('/').slice(-3).join('/')} ...`);
  const source = await prepareSource(
    models,
    { id: runName, bytes, mimeType: 'image/png', width: meta.width ?? 0, height: meta.height ?? 0 },
    prepTrace,
  );
  console.log(
    `${runName}: lang=${source.analysis.language} products=${source.analysis.products.map((p) => p.label).join(',')} logo=${source.logo ? 'yes' : 'no'} panel=${source.analysis.panel ? 'yes' : 'no'} (${source.modelCalls} model calls)`,
  );
  const reports = await runPool(PRESETS, 2, async (preset): Promise<SizeReport> => {
    const trace = new TraceCollector();
    for (const e of prepTrace.all()) {
      const { seq: _s, ...rest } = e;
      trace.emit(rest);
    }
    const start = Date.now();
    try {
      const outcome = await runOutput(
        models,
        { source, preset, mode, template: templates.get(preset.id) ?? null, framePng: frameFor.get(preset.id) ?? null, brandName },
        `${runName}/${preset.id}`,
        trace,
      );
      const ms = Date.now() - start;
      await writeFile(join(dir, `${preset.id}.png`), outcome.png);
      await writeFile(
        join(dir, `${preset.id}.json`),
        JSON.stringify({ plan: outcome.plan, proofs: outcome.proofs, digest: outcome.digest, qa: outcome.qa, retries: outcome.retries, trace: trace.all() }, null, 2),
      );
      const proof = outcome.proofs
        ? Object.entries(outcome.proofs).map(([id, pr]) => `${id}:${pr.core_differ}/${pr.core_total}`).join(' ')
        : 'n/a (fast)';
      const line = `${runName} ${preset.id}: ${ms} ms QA=${outcome.qa.pass ? 'PASS' : 'FAIL→needs-review'} retries=${outcome.retries} proof=[${proof}] calls=${outcome.modelCalls}m+${outcome.imageCalls}i`;
      console.log(line);
      return { preset: preset.id, mode, ms, qa: outcome.qa.pass ? 'PASS' : 'FAIL', retries: outcome.retries, proof, modelCalls: outcome.modelCalls + source.modelCalls, imageCalls: outcome.imageCalls };
    } catch (e) {
      const ms = Date.now() - start;
      const message = e instanceof Error ? e.message : String(e);
      console.log(`${runName} ${preset.id}: ERROR after ${ms} ms: ${message.slice(0, 200)}`);
      await writeFile(join(dir, `${preset.id}.error.json`), JSON.stringify({ error: message, trace: trace.all() }, null, 2));
      return { preset: preset.id, mode, ms, qa: 'ERROR', retries: 0, proof: message.slice(0, 120), modelCalls: source.modelCalls, imageCalls: 0 };
    }
  });
  return reports;
}

async function galiTemplates(): Promise<{ templates: Map<string, OutputTemplate>; frames: Map<string, Buffer> }> {
  const t11 = await loadTemplate(GALI, 'tpl-1x1.png', 'spec-1x1.json', 'tpl-gali-ig-11');
  const t45 = await loadTemplate(GALI, 'tpl-4x5.png', 'spec-4x5.json', 'tpl-gali-ig-45');
  const t916 = await loadTemplate(GALI, 'tpl-9x16.png', 'spec-9x16.json', 'tpl-gali-story');
  const t191 = await loadTemplate(GALI, 'tpl-1.91x1.png', 'spec-1.91x1.json', 'tpl-gali-fb-link');
  const templates = new Map<string, OutputTemplate>();
  if (t11) {
    templates.set('ig-feed-11', t11);
    templates.set('fb-feed', t11);
  }
  if (t45) templates.set('ig-feed-45', t45);
  if (t916) {
    templates.set('ig-story-916', t916);
    templates.set('tiktok-916', t916);
  }
  if (t191) {
    templates.set('fb-link', t191);
    templates.set('li-post', t191);
    templates.set('yt-thumb', t191);
  }
  const frames = new Map<string, Buffer>();
  const framePath = join(GALI, 'frame-9x16.png');
  if (existsSync(framePath)) {
    const frame = await readFile(framePath);
    frames.set('ig-story-916', frame);
    frames.set('tiktok-916', frame);
  }
  return { templates, frames };
}

async function noaTemplates(): Promise<{ templates: Map<string, OutputTemplate>; frames: Map<string, Buffer> }> {
  const t11 = await loadTemplate(NOA, 'tpl-1x1.png', 'spec-1x1.json', 'tpl-noa-ig-11');
  const t916 = await loadTemplate(NOA, 'tpl-9x16.png', 'spec-9x16.json', 'tpl-noa-story');
  const templates = new Map<string, OutputTemplate>();
  if (t11) templates.set('ig-feed-11', t11);
  if (t916) templates.set('ig-story-916', t916);
  return { templates, frames: new Map() };
}

async function exportDemo(reports: SizeReport[]): Promise<void> {
  const dir = join(GALI, 'demo');
  await mkdir(dir, { recursive: true });
  const runDir = join(OUT, 'gali-he-protected');
  const outputs = [];
  let modelCalls = 0;
  let imageCalls = 0;
  for (const r of reports) {
    if (r.qa === 'ERROR') {
      console.log(`demo: skipping failed ${r.preset} (${r.proof})`);
      continue;
    }
    const sidecar = JSON.parse(await readFile(join(runDir, `${r.preset}.json`), 'utf8')) as {
      plan: unknown; proofs: unknown; qa: { pass: boolean }; retries: number; trace: unknown[];
    };
    const png = await readFile(join(runDir, `${r.preset}.png`));
    await writeFile(join(dir, `${r.preset}.png`), png);
    modelCalls += r.modelCalls;
    imageCalls += r.imageCalls;
    outputs.push({
      source: 'demo-src-he',
      sourceLabel: 'source-he.png',
      preset: r.preset,
      mode: 'protected',
      status: sidecar.qa.pass ? 'pass' : 'needs_review',
      image: `${r.preset}.png`,
      plan: sidecar.plan,
      proof: sidecar.proofs,
      qa: sidecar.qa,
      retries: sidecar.retries,
      modelCalls: r.modelCalls,
      imageCalls: r.imageCalls,
      latencyMs: r.ms,
      trace: sidecar.trace,
      error: null,
    });
  }
  await writeFile(
    join(dir, 'demo.json'),
    JSON.stringify({ brand: 'gali', mode: 'protected', finishedAt: new Date().toISOString(), modelCalls, imageCalls, outputs }, null, 2),
  );
  console.log(`demo: exported ${outputs.length} outputs to fixtures/brands/gali/demo/`);
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const allReports: SizeReport[] = [];
  if (STEPS.has('specs')) await stepSpecs();
  if (STEPS.has('noa')) await stepNoa();
  if (STEPS.has('smoke')) {
    const { templates, frames } = await galiTemplates();
    const t11 = templates.get('ig-feed-11');
    if (!t11) throw new Error('smoke needs spec-1x1.json — run the specs step first');
    const dir = join(OUT, 'smoke');
    await mkdir(dir, { recursive: true });
    const bytes = await readFile(join(GALI, 'source-he.png'));
    const meta = await sharp(bytes).metadata();
    const prepTrace = new TraceCollector();
    const source = await prepareSource(
      models,
      { id: 'smoke', bytes, mimeType: 'image/png', width: meta.width ?? 0, height: meta.height ?? 0 },
      prepTrace,
    );
    const preset = PRESETS.find((p) => p.id === 'ig-feed-11')!;
    for (const mode of ['fast', 'protected'] as const) {
      const trace = new TraceCollector();
      for (const e of prepTrace.all()) {
        const { seq: _s, ...rest } = e;
        trace.emit(rest);
      }
      const outcome = await runOutput(
        models,
        { source, preset, mode, template: t11, framePng: frames.get(preset.id) ?? null, brandName: 'GALI' },
        `smoke/${mode}/ig-feed-11`,
        trace,
      );
      await writeFile(join(dir, `${mode}-ig-feed-11.png`), outcome.png);
      await writeFile(
        join(dir, `${mode}-ig-feed-11.json`),
        JSON.stringify({ plan: outcome.plan, proofs: outcome.proofs, qa: outcome.qa, retries: outcome.retries, trace: trace.all() }, null, 2),
      );
      console.log(`smoke/${mode}: QA=${outcome.qa.pass ? 'PASS' : 'FAIL'} retries=${outcome.retries} calls=${outcome.modelCalls}m+${outcome.imageCalls}i`);
      allReports.push({ preset: `ig-feed-11 (smoke/${mode})`, mode, ms: 0, qa: outcome.qa.pass ? 'PASS' : 'FAIL', retries: outcome.retries, proof: outcome.proofs ? 'see sidecar' : 'n/a (fast)', modelCalls: outcome.modelCalls, imageCalls: outcome.imageCalls });
    }
  }
  if (STEPS.has('gali-fast')) {
    const { templates, frames } = await galiTemplates();
    allReports.push(...(await runAllSizes('gali-he-fast', join(GALI, 'source-he.png'), 'GALI', 'fast', templates, frames)));
  }
  let galiProt: SizeReport[] = [];
  if (STEPS.has('gali-prot')) {
    const { templates, frames } = await galiTemplates();
    galiProt = await runAllSizes('gali-he-protected', join(GALI, 'source-he.png'), 'GALI', 'protected', templates, frames);
    allReports.push(...galiProt);
    await exportDemo(galiProt);
  }
  if (STEPS.has('noa-prot')) {
    const { templates, frames } = await noaTemplates();
    allReports.push(...(await runAllSizes('noa-protected', join(NOA, 'source.png'), 'NOA', 'protected', templates, frames)));
  }
  const images = allReports.reduce((s, r) => s + r.imageCalls, 0);
  const modelCalls = allReports.reduce((s, r) => s + r.modelCalls, 0);
  console.log(`\nTOTAL: ${allReports.length} outputs · ${images} images ($${(images * 0.01).toFixed(2)}) · ${modelCalls} Spark/SAM calls`);
  await writeFile(join(OUT, 'report.json'), JSON.stringify({ at: new Date().toISOString(), reports: allReports, imageCostUsd: images * 0.01 }, null, 2));
}

await main();
