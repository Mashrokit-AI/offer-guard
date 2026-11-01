#!/usr/bin/env tsx
/**
 * Engine-10 verification screenshots (shots only — no UI changes). Imports a
 * finished engine-run dir into a throwaway store as a viewable job, serves
 * the real app on 127.0.0.1 and drives it with Playwright:
 *
 *   npm run ui-shots -- --engine10 [--port 3024]
 *
 * Shots → artifacts/ui/engine10-*.png: fb-link detail with BOTH overlays
 * (template targets + actual placement), 9:16 detail with the safe area, and
 * the trace drawer showing Wonder plan + review rows with a before/after
 * repair. Same failure gate as ui-shots (console/pageerror/http/external).
 *
 * Check details are reconstructed from report.json (statuses, coverage,
 * patches, findings) in computeChecks' exact formats; pixels, manifests,
 * traces and statuses are the recorded ones.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { chromium, type Browser, type Page } from 'playwright';
import { findRepoRoot, loadEnvFiles } from '../src/shared/env.js';
import { ensureSeeded } from '../src/server/adfit/seed.js';
import { createApp } from '../src/server/http/app.js';
import { Store } from '../src/server/store/db.js';
import { sourceDigest } from '../src/server/adfit/cache.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
loadEnvFiles(REPO_ROOT);

const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 3024;
const RUN = 'gali-he-8';
const JOB_ID = 'engine10-gali-he-8';
const SOURCE_ID = 'engine10-gali-he';
const SHOTS_DIR = join(REPO_ROOT, 'artifacts', 'ui');

interface ReportOutput {
  preset: string;
  planner: string;
  family: string | null;
  checks: { protected: string; text: string; layout: string };
  proofCoverage: number | null;
  repaired: string[] | null;
  seconds: number;
  error: string | null;
  findings: string[];
}

function importRun(dbPath: string): void {
  const runDir = join(REPO_ROOT, 'artifacts', 'engine-10', RUN);
  const report = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8')) as { outputs: ReportOutput[] };
  const brand = JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', 'brands', 'gali', 'brand.json'), 'utf8')) as {
    templates: Array<{ id: string; preset: string }>;
  };
  const tplByPreset = new Map(brand.templates.map((t) => [t.preset, t.id]));
  const store = Store.open(dbPath);
  try {
    const srcBytes = readFileSync(join(REPO_ROOT, 'fixtures', 'brands', 'gali', 'source-he.png'));
    const digest = sourceDigest(srcBytes);
    if (!store.getSource(SOURCE_ID)) {
      store.insertSource({ id: SOURCE_ID, imagePath: 'fixtures/brands/gali/source-he.png', width: 1080, height: 1080, expiresAt: null });
      const masks: Record<string, string> = {};
      for (const id of ['product-0', 'logo']) {
        const rel = `data/layers/${digest}/${id}.png`;
        if (existsSync(join(REPO_ROOT, rel))) masks[id] = rel;
      }
      store.setSourceAnalysis(SOURCE_ID, '{}', JSON.stringify(masks), 'gali');
    }
    if (!store.getJob(JOB_ID)) {
      store.insertJob({ id: JOB_ID, brandId: 'gali', mode: 'protected', sizes: report.outputs.map((o) => o.preset), sources: [SOURCE_ID] });
      for (const o of report.outputs) {
        const manifest = JSON.parse(readFileSync(join(runDir, `${o.preset}.manifest.json`), 'utf8')) as {
          safe: unknown; width: number; height: number;
        };
        const trace = JSON.parse(readFileSync(join(runDir, `${o.preset}.trace.json`), 'utf8')) as Array<{ tool_or_model?: unknown }>;
        const fails = o.findings.filter((f) => f.startsWith('fail:'));
        const checks = {
          protected_pixels: {
            status: o.checks.protected,
            detail: o.checks.protected === 'passed' && o.proofCoverage !== null
              ? `Protected core matches the resized source (${o.proofCoverage}% compared)`
              : o.checks.protected,
          },
          text: {
            status: o.checks.text,
            detail: o.checks.text === 'passed'
              ? 're-rendered text verified exact'
              : o.checks.text === 'fixed'
                ? 're-rendered text verified exact after repair'
                : o.checks.text,
          },
          layout_review: {
            status: o.checks.layout,
            detail: o.checks.layout === 'fixed' && o.repaired
              ? `repaired: ${o.repaired.slice(0, 3).join('; ')}`
              : o.checks.layout === 'passed'
                ? 'deterministic + Wonder review passed'
                : fails.slice(0, 2).join(' | '),
          },
          repaired: o.repaired
            ? { before: `artifacts/engine-10/${RUN}/before-${o.preset}.png`, patches: o.repaired }
            : null,
        };
        const modelCalls = trace.filter((r) => typeof r.tool_or_model === 'string' && (r.tool_or_model as string).startsWith('model:muse-')).length;
        const imageCalls = trace.filter((r) => typeof r.tool_or_model === 'string' && (r.tool_or_model as string).startsWith('model:muse-image')).length;
        store.insertOutput({
          jobId: JOB_ID,
          sourceId: SOURCE_ID,
          preset: o.preset,
          mode: 'protected',
          status: o.error ? 'failed' : 'done',
          imagePath: `artifacts/engine-10/${RUN}/${o.preset}.png`,
          planJson: JSON.stringify({
            preset: o.preset, width: manifest.width, height: manifest.height,
            safe: manifest.safe, template_id: tplByPreset.get(o.preset) ?? null, manifest,
          }),
          proofJson: null,
          qaJson: null,
          retries: 0,
          modelCalls,
          imageCalls,
          latencyMs: Math.round(o.seconds * 1000),
          traceJson: JSON.stringify(trace),
          error: o.error,
          checksJson: JSON.stringify(checks),
        });
      }
      store.finishJob(JOB_ID, 'done', null, 0, 0);
    }
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const dbPath = join(SHOTS_DIR, '.shots-engine10.db');
  rmSync(dbPath, { force: true });
  ensureSeeded(REPO_ROOT, dbPath);
  importRun(dbPath);
  const app = createApp({ repoRoot: REPO_ROOT, dbPath });
  const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' });
  await new Promise((r) => setTimeout(r, 500));
  const base = `http://127.0.0.1:${PORT}`;

  const store = Store.open(dbPath);
  let byPreset: Map<string, number>;
  try {
    byPreset = new Map(store.outputsForJob(JOB_ID).map((o) => [o.preset, o.id]));
  } finally {
    store.close();
  }
  const fbLink = byPreset.get('fb-link');
  const story = byPreset.get('ig-story-916');
  if (!fbLink || !story) throw new Error('engine10 job missing fb-link or story outputs');

  const problems: Array<{ shot: string; kind: string; detail: string }> = [];
  const watch = (page: Page, shot: string): void => {
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push({ shot, kind: 'console', detail: m.text().slice(0, 300) });
    });
    page.on('pageerror', (e) => problems.push({ shot, kind: 'pageerror', detail: String(e).slice(0, 300) }));
    page.on('requestfailed', (r) => problems.push({ shot, kind: 'requestfailed', detail: `${r.url()} ${r.failure()?.errorText ?? ''}`.slice(0, 300) }));
    page.on('response', (r) => {
      if (r.status() >= 400) problems.push({ shot, kind: `http-${r.status()}`, detail: r.url().slice(0, 300) });
    });
  };

  const SINGLE = process.env.UI_SHOTS_SINGLE_PROCESS === '1';
  // Sandboxed shells flakily SIGTRAP Chromium helpers; retry the launch.
  // Exactly ONE page total: single-process headless shell dies on the second
  // newPage here, so the proof-of-life page becomes the shots page.
  let browser: Browser | null = null;
  let page: Page | null = null;
  for (let attempt = 1; attempt <= 4 && !browser; attempt++) {
    try {
      const b = await chromium.launch(
        SINGLE ? { args: ['--single-process', '--no-sandbox', '--disable-gpu'] } : undefined,
      );
      const probe = await b.newPage({ viewport: { width: 1440, height: 900 } });
      await probe.goto('about:blank');
      browser = b;
      page = probe;
    } catch (e) {
      console.log(`browser launch attempt ${attempt} failed, retrying...`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!browser || !page) throw new Error('could not launch a surviving browser');
  try {
    const shots: Array<{ name: string; hash: string; setup: (p: Page) => Promise<void> }> = [
      {
        name: 'engine10-detail-fb-link',
        hash: `#/output/${fbLink}`,
        setup: async (p) => {
          await p.locator('#tgl-zones').check();
          await p.locator('#tgl-placed').check();
          await p.waitForTimeout(800);
          await p.locator('.evidence2').first().scrollIntoViewIfNeeded();
        },
      },
      {
        name: 'engine10-detail-story-safe',
        hash: `#/output/${story}`,
        setup: async (p) => {
          await p.locator('#tgl-safe').check();
          await p.waitForTimeout(800);
          await p.locator('.evidence2').first().scrollIntoViewIfNeeded();
        },
      },
      {
        name: 'engine10-trace-fb-link',
        hash: `#/output/${fbLink}`,
        setup: async (p) => {
          if ((await p.locator('#trace[open]').count()) === 0) await p.click('#trace summary');
          await p.waitForTimeout(400);
          await p.locator('#trace').scrollIntoViewIfNeeded();
        },
      },
      {
        name: 'engine10-repair-fb-link',
        hash: `#/output/${fbLink}`,
        setup: async (p) => {
          await p.waitForTimeout(800);
          await p.locator('.evidence2').nth(1).scrollIntoViewIfNeeded();
        },
      },
    ];
    for (const s of shots) {
      watch(page, s.name);
      await page.goto(`${base}/?lang=en${s.hash}`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
      await page.waitForTimeout(600);
      await s.setup(page);
      await page.screenshot({ path: join(SHOTS_DIR, `${s.name}.png`) });
      console.log(`shot: ${s.name}.png`);
    }
    await page.close().catch(() => undefined);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
  if (problems.length > 0) {
    console.log(`\nengine10 shots: ${problems.length} problem(s):`);
    for (const p of problems) console.log(`- [${p.shot}] ${p.kind}: ${p.detail}`);
    process.exit(1);
  }
  console.log('\nengine10 shots: clean.');
}

void main();
