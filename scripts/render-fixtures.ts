#!/usr/bin/env tsx
/**
 * Scripted fixture generator: builds fixtures/src/ad-*.html from the
 * fixtures/src/ad.html template and renders fixtures/ads/*.png with headless
 * Chromium (Playwright) at 1080x1080.
 *
 *   npm run render:fixtures                  # regenerate all 12
 *   npm run render:fixtures -- --only ad-04  # regenerate a subset (id prefix match)
 *
 * Deterministic: same template + same Chromium = same PNG bytes. The script
 * reports which PNGs changed so a regeneration is reviewable.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { findRepoRoot } from '../src/shared/env.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const SRC_DIR = join(REPO_ROOT, 'fixtures', 'src');
const ADS_DIR = join(REPO_ROOT, 'fixtures', 'ads');

interface FixtureSpec {
  /** Base id, e.g. "ad-04-page-wrong" (HTML name gets "-en" for English). */
  id: string;
  lang: 'he' | 'en';
  variant: '' | 'overlap';
  main: string;
  sub: string;
  /** Main-line font size override (default 66 he / 62 en) when the text is long. */
  mainPx?: number;
}

const NUM = (s: string): string => `<span class="num">${s}</span>`;

const HE_TAGLINE = 'בקבוק תרמי · 750 מ״ל';
const EN_TAGLINE = 'Thermal bottle · 750 ml';

export const FIXTURES: FixtureSpec[] = [
  { id: 'ad-01-clean', lang: 'he', variant: '', main: `${NUM('20%')} הנחה על דגמים נבחרים`, sub: `בתוקף עד ${NUM('10.11')} · משלוח בתשלום` },
  { id: 'ad-02-wrong', lang: 'he', variant: '', main: `${NUM('30%')} הנחה על הכל`, sub: `+ משלוח חינם · בתוקף עד ${NUM('10.11')}` },
  { id: 'ad-03-overlap', lang: 'he', variant: 'overlap', main: `${NUM('30%')} הנחה על הכל`, sub: `+ משלוח חינם · עד ${NUM('10.11')}` },
  { id: 'ad-04-page-wrong', lang: 'he', variant: '', main: `${NUM('20%')} הנחה על דגמים נבחרים`, sub: `בתוקף עד ${NUM('10.11')} · משלוח בתשלום` },
  { id: 'ad-05-ambiguous', lang: 'he', variant: '', main: 'הנחה על מוצרים נבחרים', sub: '' },
  { id: 'ad-06-clean-phrasing', lang: 'he', variant: '', main: `חיסכון של ${NUM('20%')} על דגמים נבחרים`, sub: `עד ${NUM('10.11')} · משלוח לא כלול`, mainPx: 52 },
  { id: 'ad-01-clean', lang: 'en', variant: '', main: `${NUM('20%')} off selected models`, sub: `Valid until ${NUM('10.11')} · paid shipping` },
  { id: 'ad-02-wrong', lang: 'en', variant: '', main: `${NUM('30%')} off everything`, sub: `+ free shipping · valid until ${NUM('10.11')}` },
  { id: 'ad-03-overlap', lang: 'en', variant: 'overlap', main: `${NUM('30%')} off everything`, sub: `+ free shipping · until ${NUM('10.11')}` },
  { id: 'ad-04-page-wrong', lang: 'en', variant: '', main: `${NUM('20%')} off selected models`, sub: `Valid until ${NUM('10.11')} · paid shipping` },
  { id: 'ad-05-ambiguous', lang: 'en', variant: '', main: 'Sale on selected items', sub: '' },
  { id: 'ad-06-clean-phrasing', lang: 'en', variant: '', main: `Save ${NUM('20%')} on selected models`, sub: `Until ${NUM('10.11')} · shipping not included` },
];

export function htmlName(spec: FixtureSpec): string {
  return spec.lang === 'he' ? `${spec.id}.html` : `${spec.id}-en.html`;
}

export function pngName(spec: FixtureSpec): string {
  return spec.lang === 'he' ? `${spec.id}.png` : `${spec.id}-en.png`;
}

/** Fill the ad.html template: lang/dir, tagline, main font size, panel text. */
export function buildFixtureHtml(template: string, spec: FixtureSpec): string {
  let html = template;
  if (spec.lang === 'en') {
    html = html.replace('<html lang="he" dir="rtl">', '<html lang="en" dir="ltr">');
    html = html.replace(HE_TAGLINE, EN_TAGLINE);
    html = html.replace('.panel .main { font-size: 66px;', '.panel .main { font-size: 62px;');
  }
  html = html.replace('__VARIANT__', spec.variant);
  html = html.replace('__MAIN__', spec.main);
  html = html.replace('__SUB__', spec.sub);
  if (spec.mainPx !== undefined) {
    const from = spec.lang === 'he' ? '.panel .main { font-size: 66px;' : '.panel .main { font-size: 62px;';
    html = html.replace(from, `.panel .main { font-size: ${spec.mainPx}px;`);
  }
  return html;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function main(): Promise<void> {
  const onlyIdx = process.argv.indexOf('--only');
  const only = onlyIdx >= 0 ? (process.argv[onlyIdx + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : [];
  const specs = only.length === 0 ? FIXTURES : FIXTURES.filter((s) => only.some((p) => `${s.id}${s.lang === 'en' ? '-en' : ''}`.startsWith(p)));

  if (specs.length === 0) {
    console.log(`No fixtures match --only ${only.join(',')}.`);
    process.exit(1);
  }

  const template = await readFile(join(SRC_DIR, 'ad.html'), 'utf8');
  for (const marker of ['__VARIANT__', '__MAIN__', '__SUB__']) {
    if (!template.includes(marker)) throw new Error(`template ad.html lost its ${marker} placeholder`);
  }

  const browser = await chromium.launch();
  try {
    for (const spec of specs) {
      const html = buildFixtureHtml(template, spec);
      const htmlPath = join(SRC_DIR, htmlName(spec));
      await writeFile(htmlPath, html, 'utf8');

      const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 1 });
      try {
        await page.setContent(html, { waitUntil: 'load' });
        const png = await page.screenshot({ type: 'png' });
        const pngPath = join(ADS_DIR, pngName(spec));
        let prev = '';
        try {
          prev = sha256Hex(await readFile(pngPath));
        } catch {
          prev = '(new)';
        }
        await writeFile(pngPath, png);
        const next = sha256Hex(png);
        console.log(`${pngName(spec)}: ${prev === next ? 'unchanged' : `WROTE (was ${prev.slice(0, 12)}, now ${next.slice(0, 12)})`}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}

await main();
