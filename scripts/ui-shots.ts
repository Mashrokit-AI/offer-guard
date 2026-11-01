#!/usr/bin/env tsx
/**
 * UI screenshot matrix + failure gate. Serves the real app (real DB) on
 * 127.0.0.1 and drives it with Playwright:
 *
 *   node scripts/ui-shots.ts [--live] [--port 3023]
 *
 * Shots: home, repaired / refused / page-wrong / ambiguous ad, trace open,
 * check-your-own-ad — each in EN+HE at 1440x900 and 390x844 → artifacts/ui/.
 * Exits nonzero on ANY console error, page error, failed request, HTTP >= 400
 * or non-localhost request. --live additionally clicks "Run fresh analysis"
 * and submits "Check your own ad" through the UI (live model calls).
 * --live-only skips the matrix and runs just the two live flows.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { chromium, type Browser, type Page } from 'playwright';
import { findRepoRoot, loadEnvFiles } from '../src/shared/env.js';
import { createApp } from '../src/server/http/app.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
loadEnvFiles(REPO_ROOT);

const argv = process.argv.slice(2);
const LIVE = argv.includes('--live') || argv.includes('--live-only');
const MATRIX = !argv.includes('--live-only');
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
  const app = createApp({ repoRoot: REPO_ROOT });
  const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' });
  await new Promise((r) => setTimeout(r, 500));
  const base = `http://127.0.0.1:${PORT}`;
  console.log(`ui-shots: serving ${base}`);

  // Resolve snapshot ids per ad+lang from the live campaign endpoint.
  const campaign = (await (await fetch(`${base}/api/campaign`)).json()) as {
    ads: Array<{ id: number; ad: string; lang: string }>;
  };
  const idFor = (ad: string, lang: string): number => {
    const hit = campaign.ads.find((a) => a.ad === ad && a.lang === lang);
    if (!hit) throw new Error(`no snapshot for ${ad}/${lang}`);
    return hit.id;
  };

  const browser: Browser = await chromium.launch();
  try {
    if (MATRIX) {
    for (const lang of LANGS) {
      for (const vp of VIEWPORTS) {
        const shots: Array<{ name: string; hash: string; setup?: (p: Page) => Promise<void> }> = [
          { name: 'home', hash: '#/' },
          { name: 'ad-repaired', hash: `#/ad/${idFor('ad-02', lang)}` },
          { name: 'ad-refused', hash: `#/ad/${idFor('ad-03', lang)}` },
          { name: 'ad-pagewrong', hash: `#/ad/${idFor('ad-04', lang)}` },
          { name: 'ad-ambiguous', hash: `#/ad/${idFor('ad-05', lang)}` },
          {
            name: 'trace',
            hash: `#/ad/${idFor('ad-02', lang)}`,
            setup: async (p) => {
              await p.click('#trace summary');
              await p.waitForTimeout(400);
              await p.locator('#trace').scrollIntoViewIfNeeded();
            },
          },
          {
            name: 'repair-open',
            hash: `#/ad/${idFor('ad-02', lang)}`,
            setup: async (p) => {
              const masks = p.locator('#tgl-masks');
              if ((await masks.count()) > 0) await masks.check();
              const diff = p.locator('#tgl-diff');
              if ((await diff.count()) > 0) await diff.check();
              await p.waitForTimeout(800);
              await p.locator('.overlay-stage').first().scrollIntoViewIfNeeded();
            },
          },
          { name: 'check', hash: '#/check' },
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
    }

    if (LIVE) {
      // --- live "Run fresh analysis" through the UI ---
      {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        watch(page, 'live-fresh');
        await page.goto(`${base}/?lang=en#/`, { waitUntil: 'domcontentloaded' });
        await settle(page);
        const before = (await (await fetch(`${base}/api/campaign`)).json()) as { run: { id: number } };
        await page.click('.toolbar .btn');
        // The grid refreshes when the fresh run lands; poll for the new run id.
        const deadline = Date.now() + 600_000;
        let latest = before.run.id;
        for (;;) {
          await page.waitForTimeout(5000);
          const cur = (await (await fetch(`${base}/api/campaign`)).json()) as {
            run: { id: number; mode: string };
            ads: Array<{ verdict: string }>;
          };
          latest = cur.run.id;
          if (latest !== before.run.id) {
            console.log(`live: fresh sweep landed as run #${latest} (${cur.run.mode}, verdicts: ${cur.ads.map((a) => a.verdict).join(',')})`);
            break;
          }
          const bannerText = await page.evaluate(() => document.querySelector('.job-banner')?.textContent ?? '').catch(() => '');
          if (/fail|busy|paused|Too many/i.test(bannerText)) {
            throw new Error(`fresh sweep failed in the UI: ${bannerText}`);
          }
          if (Date.now() > deadline) throw new Error('fresh sweep timed out waiting for a new run');
        }
        await settle(page);
        await page.screenshot({ path: join(SHOTS_DIR, 'home-fresh-en-1440.png') });
        console.log('live: fresh sweep finished through the UI');
        await page.close();
      }
      // --- live "Check your own ad" through the UI ---
      {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        watch(page, 'live-check');
        await page.goto(`${base}/?lang=en#/check`, { waitUntil: 'domcontentloaded' });
        await settle(page);
        await page.setInputFiles('input[type="file"]', join(REPO_ROOT, 'fixtures', 'ads', 'ad-02-wrong-en.png'));
        await page.click('form .btn');
        await page.waitForFunction(() => window.location.hash.startsWith('#/ad/'), undefined, { timeout: 600_000 });
        await settle(page);
        console.log(`live: own-ad check landed on ${await page.evaluate(() => window.location.hash)}`);
        await page.screenshot({ path: join(SHOTS_DIR, 'check-result-en-1440.png') });
        await page.close();
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
