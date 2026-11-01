#!/usr/bin/env tsx
/**
 * MatchPic UI screenshot matrix + failure gate. Seeds the store, serves the real
 * app on 127.0.0.1 and drives it with Playwright:
 *
 *   npm run ui-shots [-- --live] [--port 3023]
 *
 * Shots: home (empty form + saved demo), output detail (overlays on), brands
 * (parsed template overlay) — each in EN+HE at 1440x900 and 390x844 →
 * artifacts/ui/. Exits nonzero on ANY console error, page error, failed
 * request, HTTP >= 400 or non-localhost request. --live additionally runs one
 * single-size demo-source job through the API (live model calls) and fails
 * when the job fails.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { chromium, type Browser, type Page } from 'playwright';
import { findRepoRoot, loadEnvFiles } from '../src/shared/env.js';
import { ensureSeeded } from '../src/server/adfit/seed.js';
import { createApp } from '../src/server/http/app.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
loadEnvFiles(REPO_ROOT);

const argv = process.argv.slice(2);
const LIVE = argv.includes('--live');
const portArg = argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 3023;

const SHOTS_DIR = join(REPO_ROOT, 'artifacts', 'ui');
const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
] as const;
const LANGS = ['en', 'he'] as const;

interface Problem {
  shot: string;
  kind: string;
  detail: string;
}

const problems: Problem[] = [];

function watch(page: Page, shot: string): void {
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push({ shot, kind: 'console', detail: m.text().slice(0, 300) });
  });
  page.on('pageerror', (e) => problems.push({ shot, kind: 'pageerror', detail: String(e).slice(0, 300) }));
  page.on('requestfailed', (r) => problems.push({ shot, kind: 'requestfailed', detail: `${r.url()} ${r.failure()?.errorText ?? ''}`.slice(0, 300) }));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push({ shot, kind: `http-${r.status()}`, detail: r.url().slice(0, 300) });
  });
  page.on('request', (r) => {
    try {
      const host = new URL(r.url()).hostname;
      if (host !== '127.0.0.1' && host !== 'localhost') {
        problems.push({ shot, kind: 'external-request', detail: r.url().slice(0, 300) });
      }
    } catch {
      // Non-URL requests (data:) are fine.
    }
  });
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(600);
}

async function main(): Promise<void> {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const dbPath = join(REPO_ROOT, 'data', 'adfit.db');
  ensureSeeded(REPO_ROOT, dbPath);
  const app = createApp({ repoRoot: REPO_ROOT, dbPath });
  const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' });
  await new Promise((r) => setTimeout(r, 500));
  const base = `http://127.0.0.1:${PORT}`;
  console.log(`ui-shots: serving ${base}`);

  const demo = (await (await fetch(`${base}/api/demo`)).json()) as {
    outputs: Array<{ id: number; preset: string; mode: string }>;
  };
  const firstOutput = demo.outputs[0];
  if (!firstOutput) throw new Error('demo job has no outputs — run the live batch first');
  console.log(`ui-shots: demo output #${firstOutput.id} (${firstOutput.preset}, ${firstOutput.mode})`);

  const browser: Browser = await chromium.launch();
  try {
    for (const lang of LANGS) {
      for (const vp of VIEWPORTS) {
        const shots: Array<{ name: string; hash: string; setup?: (p: Page) => Promise<void> }> = [
          { name: 'home', hash: '#/' },
          {
            name: 'detail',
            hash: `#/output/${firstOutput.id}`,
            setup: async (p) => {
              for (const id of ['#tgl-masks', '#tgl-zones', '#tgl-safe']) {
                const box = p.locator(id);
                if ((await box.count()) > 0) await box.check();
              }
              await p.waitForTimeout(800);
              await p.locator('.evidence2').first().scrollIntoViewIfNeeded();
            },
          },
          {
            name: 'trace',
            hash: `#/output/${firstOutput.id}`,
            setup: async (p) => {
              await p.click('#trace summary');
              await p.waitForTimeout(400);
              await p.locator('#trace').scrollIntoViewIfNeeded();
            },
          },
          { name: 'brands', hash: '#/brands' },
          { name: 'about', hash: '#/about' },
        ];
        for (const s of shots) {
          const shotName = `${s.name}-${lang}-${vp.name}`;
          const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
          watch(page, shotName);
          await page.goto(`${base}/?lang=${lang}${s.hash}`, { waitUntil: 'domcontentloaded' });
          await settle(page);
          if (s.setup) await s.setup(page);
          await page.screenshot({ path: join(SHOTS_DIR, `${shotName}.png`) });
          console.log(`shot: ${shotName}.png`);
          await page.close();
        }
      }
    }

    if (LIVE) {
      // One single-size live job through the API (protected, demo source).
      const fd = new FormData();
      fd.append('demoSource', 'gali-he');
      fd.append('sizes', 'ig-feed-11');
      fd.append('mode', 'protected');
      fd.append('brandId', 'gali');
      const sub = await fetch(`${base}/api/jobs`, { method: 'POST', body: fd });
      if (sub.status !== 202) throw new Error(`live job submit → HTTP ${sub.status}: ${(await sub.text()).slice(0, 200)}`);
      const { key, jobId } = (await sub.json()) as { key: string; jobId: string };
      console.log(`live: job ${jobId} submitted, following SSE...`);
      const deadline = Date.now() + 600_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 5000));
        const poll = (await (await fetch(`${base}/api/live/${key}`)).json()) as { job: { status: string; rows: Array<{ status: string }> } };
        if (poll.job.status === 'done') {
          console.log(`live: job done, rows: ${poll.job.rows.map((r) => r.status).join(',')}`);
          if (poll.job.rows.some((r) => r.status === 'failed')) throw new Error('live job produced a failed output');
          break;
        }
        if (poll.job.status === 'failed') throw new Error('live job failed');
        if (Date.now() > deadline) throw new Error('live job timed out');
      }
    }
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }

  if (problems.length > 0) {
    console.log(`\nui-shots: ${problems.length} problem(s):`);
    for (const p of problems) console.log(`- [${p.shot}] ${p.kind}: ${p.detail}`);
    process.exit(1);
  }
  console.log('\nui-shots: clean — no console errors, failed or external requests.');
}

void main();
