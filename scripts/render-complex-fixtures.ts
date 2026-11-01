#!/usr/bin/env tsx
/**
 * Complex-fixture generator: VELA (EN) + DAFNA (HE), each with a photographic
 * Muse Image background (committed), 2 SVG products, headline, price panel
 * (price + CTA + terms), subline and logo. Renders with headless Chromium:
 * source (1:1) + templates for 1:1, 1.91:1, 9:16 + logo lockup, plus
 * brand.json and layout specs authored from the same geometry constants the
 * HTML is built with (single source of truth — no Spark re-read needed).
 *
 *   npx tsx scripts/render-complex-fixtures.ts
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { findRepoRoot } from '../src/shared/env.js';

const REPO_ROOT = findRepoRoot(import.meta.url);

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SizeLayout {
  W: number;
  H: number;
  logo: Box;
  headline: Box;
  subtext: Box;
  panel: Box;
  productZone: Box;
  bottle: Box;
  jar: Box;
}

interface BrandDef {
  id: string;
  dir: string;
  name: string;
  lang: 'he' | 'en';
  dirAttr: 'rtl' | 'ltr';
  colors: string[];
  ink: string;
  subInk: string;
  panelFill: string;
  panelInk: string;
  logoMark: string;
  wordmark: string;
  headline: string;
  subline: string;
  price: string;
  cta: string;
  terms: string;
  bottleLabel: string;
  jarLabel: string;
  bottleBody: string[];
  jarBody: string;
  bgStyle: string;
  sizes: Record<'1x1' | '191' | '916', SizeLayout>;
}

const VELA: BrandDef = {
  id: 'vela',
  dir: join(REPO_ROOT, 'fixtures', 'brands', 'vela'),
  name: 'VELA',
  lang: 'en',
  dirAttr: 'ltr',
  colors: ['#0e4d5c', '#e86a4a', '#f3ece1', '#2a7d8c'],
  ink: '#0e4d5c',
  subInk: '#2a7d8c',
  panelFill: '#f7f3ea',
  panelInk: '#0e4d5c',
  logoMark: `<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#0e4d5c"/><path d="M12 36 C22 26, 30 44, 40 32 S 50 30, 54 33" stroke="#8fd8cb" stroke-width="6" fill="none" stroke-linecap="round"/></svg>`,
  wordmark: 'VELA',
  headline: 'Morning glow, bottled',
  subline: 'Vitamin C serum · 30 ml',
  price: '$39',
  cta: 'Shop now',
  terms: 'Free shipping over $50 · 30-day returns',
  bottleLabel: 'VELA',
  jarLabel: 'VELA',
  bottleBody: ['#0d3b47', '#2a7d8c', '#5cb3c2'],
  jarBody: '#f3ece1',
  bgStyle: 'sof, sunlit spa countertop with eucalyptus, bright and airy',
  sizes: {
    '1x1': {
      W: 1080, H: 1080,
      logo: { x: 56, y: 48, w: 230, h: 60 },
      headline: { x: 56, y: 130, w: 960, h: 80 },
      subtext: { x: 56, y: 224, w: 540, h: 44 },
      panel: { x: 90, y: 820, w: 900, h: 190 },
      productZone: { x: 200, y: 300, w: 660, h: 440 },
      bottle: { x: 230, y: 300, w: 220, h: 440 },
      jar: { x: 560, y: 480, w: 300, h: 260 },
    },
    '191': {
      W: 1200, H: 628,
      logo: { x: 70, y: 50, w: 230, h: 56 },
      headline: { x: 70, y: 130, w: 480, h: 130 },
      subtext: { x: 70, y: 272, w: 420, h: 38 },
      panel: { x: 70, y: 398, w: 520, h: 170 },
      productZone: { x: 780, y: 70, w: 360, h: 490 },
      bottle: { x: 810, y: 70, w: 180, h: 360 },
      jar: { x: 870, y: 330, w: 250, h: 215 },
    },
    '916': {
      W: 1080, H: 1920,
      logo: { x: 56, y: 60, w: 230, h: 60 },
      headline: { x: 65, y: 150, w: 950, h: 115 },
      subtext: { x: 65, y: 280, w: 650, h: 48 },
      panel: { x: 90, y: 1290, w: 900, h: 220 },
      productZone: { x: 210, y: 400, w: 710, h: 560 },
      bottle: { x: 230, y: 400, w: 280, h: 560 },
      jar: { x: 560, y: 640, w: 360, h: 315 },
    },
  },
};

const DAFNA: BrandDef = {
  id: 'dafna',
  dir: join(REPO_ROOT, 'fixtures', 'brands', 'dafna'),
  name: 'דפנה',
  lang: 'he',
  dirAttr: 'rtl',
  colors: ['#5c1e3a', '#c9963c', '#f6efe3', '#8a4a5e'],
  ink: '#4a1529',
  subInk: '#8a4a5e',
  panelFill: '#4a1529',
  panelInk: '#f6efe3',
  logoMark: `<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#4a1529"/><path d="M32 14 C40 24, 40 38, 32 50 C24 38, 24 24, 32 14 z" fill="#c9963c"/><circle cx="32" cy="32" r="4" fill="#f6efe3"/></svg>`,
  wordmark: 'דפנה',
  headline: 'זוהר בוקר בבקבוק',
  subline: 'סרום ויטמין C · 30 מ״ל',
  price: '₪149',
  cta: 'לקנייה',
  terms: 'משלוח חינם מעל ₪200 · החזרות עד 30 יום',
  bottleLabel: 'דפנה',
  jarLabel: 'דפנה',
  bottleBody: ['#3a0f20', '#7a2c4d', '#c9968a'],
  jarBody: '#f6efe3',
  bgStyle: 'warm Mediterranean stone terrace with olive branches at golden hour',
  sizes: {
    '1x1': {
      W: 1080, H: 1080,
      logo: { x: 794, y: 48, w: 230, h: 60 },
      headline: { x: 324, y: 130, w: 700, h: 80 },
      subtext: { x: 484, y: 224, w: 540, h: 44 },
      panel: { x: 90, y: 820, w: 900, h: 190 },
      productZone: { x: 200, y: 300, w: 660, h: 440 },
      bottle: { x: 230, y: 300, w: 220, h: 440 },
      jar: { x: 560, y: 480, w: 300, h: 260 },
    },
    '191': {
      W: 1200, H: 628,
      logo: { x: 900, y: 50, w: 230, h: 56 },
      headline: { x: 650, y: 130, w: 480, h: 70 },
      subtext: { x: 710, y: 214, w: 420, h: 38 },
      panel: { x: 610, y: 398, w: 520, h: 170 },
      productZone: { x: 60, y: 70, w: 360, h: 490 },
      bottle: { x: 90, y: 70, w: 180, h: 360 },
      jar: { x: 150, y: 330, w: 250, h: 215 },
    },
    '916': {
      W: 1080, H: 1920,
      logo: { x: 794, y: 60, w: 230, h: 60 },
      headline: { x: 65, y: 150, w: 950, h: 115 },
      subtext: { x: 365, y: 280, w: 650, h: 48 },
      panel: { x: 90, y: 1290, w: 900, h: 220 },
      productZone: { x: 210, y: 400, w: 710, h: 560 },
      bottle: { x: 230, y: 400, w: 280, h: 560 },
      jar: { x: 560, y: 640, w: 360, h: 315 },
    },
  },
};

function bottleSvg(b: BrandDef, w: number, h: number): string {
  const [dark, mid, light] = b.bottleBody;
  return `<svg viewBox="0 0 220 440" width="${w}" height="${h}">
    <defs><linearGradient id="bb-${b.id}" x1="0" x2="1">
      <stop offset="0" stop-color="${dark}"/><stop offset=".4" stop-color="${mid}"/>
      <stop offset=".6" stop-color="${light}"/><stop offset="1" stop-color="${dark}"/>
    </linearGradient></defs>
    <rect x="80" y="0" width="60" height="54" rx="10" fill="#2b2b2b"/>
    <rect x="88" y="50" width="44" height="18" fill="#4a4a4a"/>
    <path d="M60 68 h100 q34 26 34 76 v250 q0 44 -44 44 h-80 q-44 0 -44 -44 v-250 q0 -50 34 -76 z" fill="url(#bb-${b.id})"/>
    <rect x="52" y="220" width="116" height="90" rx="8" fill="rgba(255,255,255,.16)"/>
    <text x="110" y="276" text-anchor="middle" font-family="Arial" font-weight="800" font-size="30" fill="#f4fbf9" letter-spacing="3">${b.bottleLabel}</text>
    <path d="M52 120 q-5 120 0 260" stroke="rgba(255,255,255,.35)" stroke-width="8" fill="none" stroke-linecap="round"/>
  </svg>`;
}

function jarSvg(b: BrandDef, w: number, h: number): string {
  return `<svg viewBox="0 0 300 260" width="${w}" height="${h}">
    <rect x="30" y="0" width="240" height="70" rx="22" fill="${b.ink}"/>
    <rect x="30" y="58" width="240" height="14" fill="rgba(255,255,255,.15)"/>
    <path d="M45 72 h210 q22 8 22 40 v100 q0 44 -44 44 h-166 q-44 0 -44 -44 v-100 q0 -32 22 -40 z" fill="${b.jarBody}" stroke="${b.ink}" stroke-width="6"/>
    <text x="150" y="180" text-anchor="middle" font-family="Arial" font-weight="800" font-size="40" fill="${b.ink}" letter-spacing="4">${b.jarLabel}</text>
  </svg>`;
}

function doc(b: BrandDef, key: '1x1' | '191' | '916', bgDataUrl: string): string {
  const L = b.sizes[key];
  const edge = b.dirAttr === 'rtl' ? 'right' : 'left';
  const headlineSize = key === '916' ? 84 : key === '191' ? 56 : 68;
  const subSize = key === '916' ? 40 : key === '191' ? 30 : 36;
  const priceSize = key === '916' ? 88 : key === '191' ? 64 : 72;
  const ctaSize = key === '916' ? 46 : key === '191' ? 34 : 38;
  const termsSize = key === '916' ? 30 : key === '191' ? 24 : 28;
  return `<!doctype html>
<html lang="${b.lang}" dir="${b.dirAttr}">
<head><meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${L.W}px; height: ${L.H}px; overflow: hidden; }
  body { font-family: Arial, "Arial Hebrew", sans-serif; position: relative;
         background: url("${bgDataUrl}") center / cover no-repeat; }
  .shade { position: absolute; inset: 0; background: rgba(255,255,255,.28); }
  .logo { position: absolute; left: ${L.logo.x}px; top: ${L.logo.y}px; width: ${L.logo.w}px; height: ${L.logo.h}px;
          display: flex; align-items: center; gap: 12px; direction: ltr; }
  .logo svg { width: ${L.logo.h}px; height: ${L.logo.h}px; flex: none; }
  .logo span { font: 800 ${Math.round(L.logo.h * 0.8)}px/1 Arial, sans-serif; letter-spacing: 5px; color: ${b.ink}; }
  .headline { position: absolute; left: ${L.headline.x}px; top: ${L.headline.y}px; width: ${L.headline.w}px;
              font-size: ${headlineSize}px; font-weight: 800; line-height: 1.15; color: ${b.ink}; text-align: ${edge}; }
  .subline { position: absolute; left: ${L.subtext.x}px; top: ${L.subtext.y}px; width: ${L.subtext.w}px;
             font-size: ${subSize}px; color: ${b.subInk}; text-align: ${edge}; }
  .bottle { position: absolute; left: ${L.bottle.x}px; top: ${L.bottle.y}px; }
  .jar { position: absolute; left: ${L.jar.x}px; top: ${L.jar.y}px; }
  .pshadow { position: absolute; background: radial-gradient(ellipse at center, rgba(20,20,20,.30) 0%, rgba(20,20,20,0) 70%); }
  .panel { position: absolute; left: ${L.panel.x}px; top: ${L.panel.y}px; width: ${L.panel.w}px; height: ${L.panel.h}px;
           border-radius: 26px; background: ${b.panelFill}; color: ${b.panelInk};
           display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .panel .price { font-size: ${priceSize}px; font-weight: 800; line-height: 1.05; }
  .panel .cta { font-size: ${ctaSize}px; font-weight: 700; margin-top: 6px; text-decoration: underline; }
  .panel .terms { font-size: ${termsSize}px; margin-top: 8px; opacity: .9; }
</style>
</head><body>
<div class="shade"></div>
<div class="logo">${b.logoMark}<span>${b.wordmark}</span></div>
<div class="headline">${b.headline}</div>
<div class="subline">${b.subline}</div>
<div class="pshadow" style="left:${L.bottle.x - 30}px;top:${L.bottle.y + L.bottle.h - 14}px;width:${L.bottle.w + 60}px;height:36px"></div>
<div class="pshadow" style="left:${L.jar.x - 30}px;top:${L.jar.y + L.jar.h - 14}px;width:${L.jar.w + 60}px;height:30px"></div>
<div class="bottle">${bottleSvg(b, L.bottle.w, L.bottle.h)}</div>
<div class="jar">${jarSvg(b, L.jar.w, L.jar.h)}</div>
<div class="panel"><div class="price">${b.price}</div><div class="cta">${b.cta}</div><div class="terms">${b.terms}</div></div>
</body></html>`;
}

function logoDoc(b: BrandDef): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>html, body { margin: 0; width: 520px; height: 180px; overflow: hidden; background: transparent; }
.lockup { width: 520px; height: 180px; display: flex; align-items: center; justify-content: center; gap: 18px; direction: ltr; }
.lockup svg { width: 120px; height: 120px; }
.lockup span { font: 800 96px/1 Arial, sans-serif; letter-spacing: 8px; color: ${b.ink}; }</style>
</head><body><div class="lockup">${b.logoMark}<span>${b.wordmark}</span></div></body></html>`;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const norm = (b: Box, W: number, H: number) => ({ x: r3(b.x / W), y: r3(b.y / H), w: r3(b.w / W), h: r3(b.h / H) });

function specFor(b: BrandDef, key: '1x1' | '191' | '916'): Record<string, unknown> {
  const L = b.sizes[key];
  const logoCorner = b.dirAttr === 'rtl'
    ? (L.logo.x > L.W / 2 ? 'top-right' : 'top-left')
    : (L.logo.x < L.W / 2 ? 'top-left' : 'top-right');
  return {
    logo: { box: norm(L.logo, L.W, L.H), corner: logoCorner },
    headline_zone: norm(L.headline, L.W, L.H),
    subtext_zone: norm(L.subtext, L.W, L.H),
    panel_zone: { box: norm(L.panel, L.W, L.H), color: b.panelFill, shape: 'rounded_rect' },
    product_zone: norm(L.productZone, L.W, L.H),
    frames: [],
    background_style: `photographic lifestyle background, ${b.bgStyle}, with soft white shade for text legibility`,
    text_align: 'center',
    direction: b.dirAttr,
  };
}

const SIZE_FILES = {
  '1x1': { png: 'tpl-1x1.png', spec: 'spec-1x1.json', preset: 'ig-feed-11', id: (b: string) => `tpl-${b}-ig-11` },
  '191': { png: 'tpl-1.91x1.png', spec: 'spec-1.91x1.json', preset: 'fb-link', id: (b: string) => `tpl-${b}-fb-link` },
  '916': { png: 'tpl-9x16.png', spec: 'spec-9x16.json', preset: 'ig-story-916', id: (b: string) => `tpl-${b}-story` },
} as const;

function sha12(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

async function launchOne(): Promise<Awaited<ReturnType<typeof chromium.launch>>> {
  // Same fallback ladder as the engine (see launchRenderBrowser): default,
  // then single-process for sandboxed shells, then system Chrome.
  const single = process.env.RENDER_SINGLE_PROCESS === '1';
  const launchArgs = single ? { args: ['--single-process', '--no-sandbox', '--disable-gpu'] } : {};
  return chromium.launch(launchArgs).catch((e: unknown) => {
    if (e instanceof Error && /Executable doesn't exist/.test(e.message)) return chromium.launch({ channel: 'chrome', ...launchArgs });
    throw e;
  });
}

async function main(): Promise<void> {
  for (const b of [VELA, DAFNA]) {
    // One browser per brand, one page per browser: single-process Chromium
    // cannot reliably serve sequential pages.
    const browser = await launchOne();
    try {
      await mkdir(b.dir, { recursive: true });
      const bg = await readFile(join(b.dir, 'bg-photo.png'));
      const bgDataUrl = `data:image/png;base64,${bg.toString('base64')}`;
      const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 1 });
      try {
        for (const key of ['1x1', '191', '916'] as const) {
          const L = b.sizes[key];
          await page.setViewportSize({ width: L.W, height: L.H });
          await page.setContent(doc(b, key, bgDataUrl), { waitUntil: 'load' });
          const png = await page.screenshot({ type: 'png', omitBackground: false });
          const out = join(b.dir, SIZE_FILES[key].png);
          let prev = '(new)';
          try {
            prev = sha12(await readFile(out));
          } catch { /* new */ }
          await writeFile(out, png);
          console.log(`${b.id}/${SIZE_FILES[key].png}: ${prev === sha12(png) ? 'unchanged' : `WROTE (was ${prev})`}`);
          await writeFile(join(b.dir, SIZE_FILES[key].spec), `${JSON.stringify(specFor(b, key), null, 2)}\n`);
        }
      } finally {
        await page.close();
      }
      // Source = the 1:1 creative.
      const source = await readFile(join(b.dir, 'tpl-1x1.png'));
      await writeFile(join(b.dir, b.lang === 'he' ? 'source-he.png' : 'source-en.png'), source);
      // Logo lockup: fresh browser (the size browser is spent).
      const browser2 = await launchOne();
      try {
        const lp = await browser2.newPage({ viewport: { width: 520, height: 180 }, deviceScaleFactor: 1 });
        try {
          await lp.setContent(logoDoc(b), { waitUntil: 'load' });
          await writeFile(join(b.dir, 'logo.png'), await lp.screenshot({ type: 'png', omitBackground: true }));
        } finally {
          await lp.close().catch(() => undefined);
        }
      } finally {
        await browser2.close().catch(() => undefined);
      }
      await writeFile(join(b.dir, 'brand.json'), `${JSON.stringify({
        id: b.id,
        name: b.name,
        colors: b.colors,
        fonts: [],
        logo: 'logo.png',
        templates: (['1x1', '191', '916'] as const).map((k) => ({ id: SIZE_FILES[k].id(b.id), preset: SIZE_FILES[k].preset, image: SIZE_FILES[k].png, spec: SIZE_FILES[k].spec })),
      }, null, 2)}\n`);
      console.log(`${b.id}/brand.json + specs written`);
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
}

await main();
