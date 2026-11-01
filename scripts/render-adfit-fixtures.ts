#!/usr/bin/env tsx
/**
 * AdFit fixture generator: renders the synthetic GALI + NOA brand assets with
 * headless Chromium (Playwright) — GALI templates for 1:1, 4:5, 9:16, 1.91:1,
 * a GALI logo PNG, one 9:16 frame overlay, NOA templates for 1:1 and 9:16 and
 * a NOA logo PNG.
 *
 *   npm run render:adfit-fixtures
 *
 * Deterministic: same template + same Chromium = same PNG bytes. The script
 * reports which PNGs changed so a regeneration is reviewable.
 * All brands are fictional and synthetic; see fixtures/brands/README.md.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { findRepoRoot } from '../src/shared/env.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const GALI = join(REPO_ROOT, 'fixtures', 'brands', 'gali');
const NOA = join(REPO_ROOT, 'fixtures', 'brands', 'noa');

const GALI_LOGO_SVG = `<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#0f4c5c"/><path d="M10 38 C20 26, 28 46, 38 34 S 54 30, 56 34" stroke="#7fd3c4" stroke-width="6" fill="none" stroke-linecap="round"/></svg>`;
const GALI_BOTTLE_SVG = `<svg class="product" viewBox="0 0 300 560">
    <defs>
      <linearGradient id="body" x1="0" x2="1">
        <stop offset="0" stop-color="#0d3b47"/><stop offset=".35" stop-color="#1e7486"/>
        <stop offset=".55" stop-color="#3fa3b4"/><stop offset="1" stop-color="#0d3b47"/>
      </linearGradient>
      <linearGradient id="cap" x1="0" x2="1">
        <stop offset="0" stop-color="#2b2b2b"/><stop offset=".5" stop-color="#5a5a5a"/><stop offset="1" stop-color="#2b2b2b"/>
      </linearGradient>
    </defs>
    <rect x="95" y="0" width="110" height="70" rx="18" fill="url(#cap)"/>
    <rect x="110" y="62" width="80" height="26" fill="#3a3a3a"/>
    <path d="M90 88 h120 q40 30 40 90 v330 q0 50 -50 50 h-100 q-50 0 -50 -50 v-330 q0 -60 40 -90 z" fill="url(#body)"/>
    <rect x="70" y="250" width="160" height="120" rx="12" fill="rgba(255,255,255,.14)"/>
    <text x="150" y="322" text-anchor="middle" font-family="Arial" font-weight="800" font-size="40" fill="#e8fbf7" letter-spacing="4">GALI</text>
    <path d="M78 140 q-6 160 0 330" stroke="rgba(255,255,255,.35)" stroke-width="10" fill="none" stroke-linecap="round"/>
  </svg>`;
const GALI_BG = 'background: linear-gradient(160deg, #e9f5f3 0%, #cfe9e4 55%, #b7ddd5 100%);';
const GALI_FONT = 'font-family: Arial, "Arial Hebrew", sans-serif;';

const NUM = (s: string): string => `<span class="num">${s}</span>`;

function galiDoc(w: number, h: number, css: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; }
  body { ${GALI_FONT} ${GALI_BG} position: relative; }
  .logo { position: absolute; display: flex; align-items: center; gap: 14px; direction: ltr; }
  .num { unicode-bidi: isolate; direction: ltr; display: inline-block; }
${css}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

const GALI_11 = galiDoc(1080, 1080, `
  .logo { top: 56px; right: 64px; }
  .logo svg { width: 64px; height: 64px; }
  .logo span { font: 800 54px/1 Arial, sans-serif; letter-spacing: 6px; color: #0f4c5c; }
  .tagline { position: absolute; top: 140px; right: 66px; font-size: 34px; color: #1f5f6b; }
  .product { position: absolute; left: 50%; top: 210px; transform: translateX(-50%); width: 300px; height: 560px; }
  .shadow { position: absolute; left: 50%; top: 760px; transform: translateX(-50%); width: 360px; height: 46px;
            background: radial-gradient(ellipse at center, rgba(15,76,92,.35) 0%, rgba(15,76,92,0) 70%); }
  .panel { position: absolute; left: 90px; right: 90px; bottom: 70px; height: 170px; border-radius: 28px;
           background: #ff5a3c; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .panel .main { font-size: 66px; font-weight: 800; line-height: 1.05; }
  .panel .sub { font-size: 32px; margin-top: 10px; opacity: .95; }`, `
  <div class="logo">${GALI_LOGO_SVG}<span>GALI</span></div>
  <div class="tagline">בקבוק תרמי · 750 מ״ל</div>
  <div class="shadow"></div>
  ${GALI_BOTTLE_SVG}
  <div class="panel"><div class="main">${NUM('20%')} הנחה על דגמים נבחרים</div><div class="sub">בתוקף עד ${NUM('10.11')} · משלוח בתשלום</div></div>`);

const GALI_45 = galiDoc(1080, 1350, `
  .logo { top: 60px; right: 68px; }
  .logo svg { width: 68px; height: 68px; }
  .logo span { font: 800 56px/1 Arial, sans-serif; letter-spacing: 6px; color: #0f4c5c; }
  .tagline { position: absolute; top: 148px; right: 70px; font-size: 36px; color: #1f5f6b; }
  .product { position: absolute; left: 50%; top: 300px; transform: translateX(-50%); width: 330px; height: 616px; }
  .shadow { position: absolute; left: 50%; top: 906px; transform: translateX(-50%); width: 390px; height: 50px;
            background: radial-gradient(ellipse at center, rgba(15,76,92,.35) 0%, rgba(15,76,92,0) 70%); }
  .panel { position: absolute; left: 90px; right: 90px; bottom: 90px; height: 190px; border-radius: 30px;
           background: #ff5a3c; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .panel .main { font-size: 68px; font-weight: 800; line-height: 1.05; }
  .panel .sub { font-size: 34px; margin-top: 10px; opacity: .95; }`, `
  <div class="logo">${GALI_LOGO_SVG}<span>GALI</span></div>
  <div class="tagline">בקבוק תרמי · 750 מ״ל</div>
  <div class="shadow"></div>
  ${GALI_BOTTLE_SVG}
  <div class="panel"><div class="main">${NUM('20%')} הנחה על דגמים נבחרים</div><div class="sub">בתוקף עד ${NUM('10.11')} · משלוח בתשלום</div></div>`);

const GALI_916 = galiDoc(1080, 1920, `
  .tagline { position: absolute; top: 120px; width: 100%; text-align: center; font-size: 44px; color: #1f5f6b; }
  .headline { position: absolute; top: 200px; width: 100%; text-align: center; font-size: 84px; font-weight: 800; color: #0f4c5c; }
  .product { position: absolute; left: 50%; top: 480px; transform: translateX(-50%); width: 360px; height: 672px; }
  .shadow { position: absolute; left: 50%; top: 1140px; transform: translateX(-50%); width: 420px; height: 54px;
            background: radial-gradient(ellipse at center, rgba(15,76,92,.35) 0%, rgba(15,76,92,0) 70%); }
  .panel { position: absolute; left: 110px; right: 110px; top: 1240px; height: 200px; border-radius: 32px;
           background: #ff5a3c; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .panel .main { font-size: 72px; font-weight: 800; line-height: 1.05; }
  .panel .sub { font-size: 36px; margin-top: 10px; opacity: .95; }
  .band { position: absolute; left: 0; right: 0; bottom: 0; height: 400px; background: #0f4c5c;
          display: flex; align-items: center; justify-content: center; gap: 22px; direction: ltr; }
  .band svg { width: 110px; height: 110px; }
  .band span { font: 800 96px/1 Arial, sans-serif; letter-spacing: 10px; color: #e8fbf7; }`, `
  <div class="tagline">בקבוק תרמי · 750 מ״ל</div>
  <div class="headline">${NUM('20%')} הנחה</div>
  <div class="shadow"></div>
  ${GALI_BOTTLE_SVG}
  <div class="panel"><div class="main">על דגמים נבחרים</div><div class="sub">בתוקף עד ${NUM('10.11')} · משלוח בתשלום</div></div>
  <div class="band"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="none" stroke="#e8fbf7" stroke-width="4"/><path d="M10 38 C20 26, 28 46, 38 34 S 54 30, 56 34" stroke="#7fd3c4" stroke-width="6" fill="none" stroke-linecap="round"/></svg><span>GALI</span></div>`);

const GALI_191 = galiDoc(1200, 628, `
  .product { position: absolute; left: 90px; top: 60px; width: 210px; height: 392px; }
  .shadow { position: absolute; left: 60px; top: 448px; width: 270px; height: 34px;
            background: radial-gradient(ellipse at center, rgba(15,76,92,.35) 0%, rgba(15,76,92,0) 70%); }
  .side { position: absolute; left: 380px; right: 70px; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: center; }
  .logo { position: static; margin-bottom: 8px; }
  .logo svg { width: 46px; height: 46px; }
  .logo span { font: 800 40px/1 Arial, sans-serif; letter-spacing: 5px; color: #0f4c5c; }
  .tagline { font-size: 26px; color: #1f5f6b; }
  .panel { margin-top: 18px; border-radius: 22px; background: #ff5a3c; color: #fff; display: flex; align-items: center; gap: 26px; padding: 20px 34px; width: fit-content; }
  .panel .main { font-size: 46px; font-weight: 800; }
  .panel .sub { font-size: 26px; opacity: .95; }`, `
  <div class="shadow"></div>
  ${GALI_BOTTLE_SVG}
  <div class="side">
    <div class="logo">${GALI_LOGO_SVG}<span>GALI</span></div>
    <div class="tagline">בקבוק תרמי · 750 מ״ל</div>
    <div class="panel"><div class="main">${NUM('20%')} הנחה</div><div class="sub">על דגמים נבחרים · עד ${NUM('10.11')}</div></div>
  </div>`);

const GALI_LOGO = `<!doctype html>
<html><head><meta charset="utf-8">
<style>html, body { margin: 0; width: 520px; height: 180px; overflow: hidden; background: transparent; }
.lockup { width: 520px; height: 180px; display: flex; align-items: center; justify-content: center; gap: 18px; direction: ltr; }
.lockup svg { width: 120px; height: 120px; }
.lockup span { font: 800 96px/1 Arial, sans-serif; letter-spacing: 10px; color: #0f4c5c; }</style>
</head><body><div class="lockup">${GALI_LOGO_SVG}<span>GALI</span></div></body></html>`;

const GALI_FRAME_916 = `<!doctype html>
<html><head><meta charset="utf-8">
<style>html, body { margin: 0; width: 1080px; height: 1920px; overflow: hidden; background: transparent; }
.frame { position: absolute; left: 26px; top: 26px; width: 1028px; height: 1868px; box-sizing: border-box;
         border: 8px solid #0f4c5c; border-radius: 44px; }
.inner { position: absolute; left: 48px; top: 48px; width: 984px; height: 1824px; box-sizing: border-box;
         border: 3px solid rgba(127,211,196,.9); border-radius: 30px; }</style>
</head><body><div class="frame"></div><div class="inner"></div></body></html>`;

// --- NOA (fictional coffee brand, warm palette) ---

const NOA_LOGO_SVG = `<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#4a2f22"/><path d="M20 24 h18 v12 a8 8 0 0 1 -8 8 h-2 a8 8 0 0 1 -8 -8 z" fill="#f5efe4"/><path d="M38 26 h3 a5 5 0 0 1 0 10 h-3" fill="none" stroke="#f5efe4" stroke-width="3"/><path d="M25 18 q2 -3 0 -6 M31 18 q2 -3 0 -6" stroke="#d97b3f" stroke-width="2.5" fill="none" stroke-linecap="round"/></svg>`;
const NOA_CUP_SVG = `<svg class="product" viewBox="0 0 300 300">
  <ellipse cx="150" cy="258" rx="110" ry="18" fill="#3a241a"/>
  <path d="M60 90 h150 v90 a60 60 0 0 1 -60 60 h-30 a60 60 0 0 1 -60 -60 z" fill="#4a2f22"/>
  <path d="M210 105 h16 a28 28 0 0 1 0 56 h-14" fill="none" stroke="#4a2f22" stroke-width="16"/>
  <ellipse cx="135" cy="90" rx="75" ry="16" fill="#2c1a12"/>
  <ellipse cx="135" cy="90" rx="62" ry="11" fill="#8a5a33"/>
  <path d="M100 40 q6 -12 0 -24 M135 40 q6 -12 0 -24 M170 40 q6 -12 0 -24" stroke="#b08a5e" stroke-width="7" fill="none" stroke-linecap="round"/>
  <text x="135" y="180" text-anchor="middle" font-family="Arial" font-weight="800" font-size="42" fill="#f5efe4" letter-spacing="6">NOA</text>
</svg>`;

function noaDoc(w: number, h: number, css: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; }
  body { ${GALI_FONT} background: linear-gradient(165deg, #f7f1e5 0%, #efe2cd 60%, #e4d2b4 100%); position: relative; }
  .logo { position: absolute; display: flex; align-items: center; gap: 12px; direction: ltr; }
  .num { unicode-bidi: isolate; direction: ltr; display: inline-block; }
${css}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

const NOA_11 = noaDoc(1080, 1080, `
  .logo { top: 56px; right: 64px; }
  .logo svg { width: 64px; height: 64px; }
  .logo span { font: 800 54px/1 Arial, sans-serif; letter-spacing: 8px; color: #4a2f22; }
  .tagline { position: absolute; top: 140px; right: 66px; font-size: 34px; color: #7a5a3a; }
  .product { position: absolute; left: 50%; top: 260px; transform: translateX(-50%); width: 420px; height: 420px; }
  .panel { position: absolute; left: 90px; right: 90px; bottom: 70px; height: 190px; border-radius: 28px;
           background: #4a2f22; color: #f5efe4; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .panel .main { font-size: 62px; font-weight: 800; line-height: 1.05; }
  .panel .sub { font-size: 32px; margin-top: 10px; color: #e8b04b; }`, `
  <div class="logo">${NOA_LOGO_SVG}<span>NOA</span></div>
  <div class="tagline">קפה טרי · קלוי בבית</div>
  ${NOA_CUP_SVG}
  <div class="panel"><div class="main">פולי קפה במבצע החודש</div><div class="sub">${NUM('15%')} הנחה · עד ${NUM('20.11')}</div></div>`);

const NOA_916 = noaDoc(1080, 1920, `
  .band { position: absolute; left: 0; right: 0; top: 0; height: 330px; background: #4a2f22;
          display: flex; align-items: center; justify-content: center; gap: 20px; direction: ltr; }
  .band svg { width: 96px; height: 96px; }
  .band span { font: 800 84px/1 Arial, sans-serif; letter-spacing: 9px; color: #f5efe4; }
  .headline { position: absolute; top: 430px; width: 100%; text-align: center; font-size: 76px; font-weight: 800; color: #4a2f22; }
  .tagline { position: absolute; top: 560px; width: 100%; text-align: center; font-size: 42px; color: #7a5a3a; }
  .product { position: absolute; left: 50%; top: 700px; transform: translateX(-50%); width: 460px; height: 460px; }
  .panel { position: absolute; left: 110px; right: 110px; bottom: 110px; height: 220px; border-radius: 32px;
           background: #d97b3f; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .panel .main { font-size: 66px; font-weight: 800; line-height: 1.05; }
  .panel .sub { font-size: 36px; margin-top: 10px; opacity: .95; }`, `
  <div class="band">${NOA_LOGO_SVG}<span>NOA</span></div>
  <div class="headline">קפה טרי כל בוקר</div>
  <div class="tagline">קלוי בבית · 250 גרם</div>
  ${NOA_CUP_SVG}
  <div class="panel"><div class="main">${NUM('15%')} הנחה החודש</div><div class="sub">בתוקף עד ${NUM('20.11')}</div></div>`);

const NOA_LOGO = `<!doctype html>
<html><head><meta charset="utf-8">
<style>html, body { margin: 0; width: 520px; height: 180px; overflow: hidden; background: transparent; }
.lockup { width: 520px; height: 180px; display: flex; align-items: center; justify-content: center; gap: 18px; direction: ltr; }
.lockup svg { width: 120px; height: 120px; }
.lockup span { font: 800 96px/1 Arial, sans-serif; letter-spacing: 12px; color: #4a2f22; }</style>
</head><body><div class="lockup">${NOA_LOGO_SVG}<span>NOA</span></div></body></html>`;

interface RenderJob {
  html: string;
  w: number;
  h: number;
  out: string;
  transparent: boolean;
}

const JOBS: RenderJob[] = [
  { html: GALI_11, w: 1080, h: 1080, out: join(GALI, 'tpl-1x1.png'), transparent: false },
  { html: GALI_45, w: 1080, h: 1350, out: join(GALI, 'tpl-4x5.png'), transparent: false },
  { html: GALI_916, w: 1080, h: 1920, out: join(GALI, 'tpl-9x16.png'), transparent: false },
  { html: GALI_191, w: 1200, h: 628, out: join(GALI, 'tpl-1.91x1.png'), transparent: false },
  { html: GALI_LOGO, w: 520, h: 180, out: join(GALI, 'logo.png'), transparent: true },
  { html: GALI_FRAME_916, w: 1080, h: 1920, out: join(GALI, 'frame-9x16.png'), transparent: true },
  { html: NOA_11, w: 1080, h: 1080, out: join(NOA, 'tpl-1x1.png'), transparent: false },
  { html: NOA_916, w: 1080, h: 1920, out: join(NOA, 'tpl-9x16.png'), transparent: false },
  { html: NOA_LOGO, w: 520, h: 180, out: join(NOA, 'logo.png'), transparent: true },
];

function sha12(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  try {
    for (const job of JOBS) {
      const page = await browser.newPage({ viewport: { width: job.w, height: job.h }, deviceScaleFactor: 1 });
      try {
        await page.setContent(job.html, { waitUntil: 'load' });
        const png = await page.screenshot({ type: 'png', omitBackground: job.transparent });
        let prev = '(new)';
        try {
          prev = sha12(await readFile(job.out));
        } catch {
          prev = '(new)';
        }
        await writeFile(job.out, png);
        const next = sha12(png);
        console.log(`${job.out.split('/').slice(-3).join('/')}: ${prev === next ? 'unchanged' : `WROTE (was ${prev}, now ${next})`}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}

await main();
