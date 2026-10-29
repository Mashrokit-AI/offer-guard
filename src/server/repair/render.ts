import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium, type Page } from 'playwright';
import type { AdLanguage } from '../../shared/schemas.js';
import type { Rgb } from './panel.js';

/**
 * Minimal browser-document shape for page.evaluate callbacks only (this
 * module is otherwise DOM-free server code). At runtime these closures run
 * inside Chromium, where the real document exists.
 */
declare const document: {
  querySelector(sel: string): {
    scrollWidth: number;
    clientWidth: number;
    scrollHeight: number;
    clientHeight: number;
  } | null;
  fonts: { ready: Promise<unknown>; check(spec: string): boolean };
};

export interface RenderInput {
  width: number;
  height: number;
  radius: number;
  fill: Rgb;
  textColor: Rgb;
  main: string;
  sub: string;
  lang: AdLanguage;
}

export interface RenderResult {
  png: Buffer;
  mainPx: number;
  subPx: number;
  fontStack: string;
}

export class RenderBlocker extends Error {
  readonly blocker = 'text_does_not_fit' as const;
  constructor(message: string) {
    super(message);
    this.name = 'RenderBlocker';
  }
}

export const MIN_MAIN_PX = 28;
export const MIN_SUB_PX = 18;

const require = createRequire(import.meta.url);

function fontPackageDir(pkg: string): string {
  return dirname(require.resolve(`${pkg}/package.json`));
}

async function fontFaceCss(
  family: string,
  weight: number,
  file: string,
): Promise<string> {
  const bytes = await readFile(file);
  const b64 = bytes.toString('base64');
  return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${b64}) format("woff2");}`;
}

/**
 * Load the bundled Noto fonts from local files (never the network at render
 * time): Hebrew subset for Hebrew glyphs + Latin subset for digits, %, dates.
 * License: OFL — see the LICENSE file in each fontsource package.
 */
export async function loadFontCss(): Promise<string> {
  const hebrewDir = fontPackageDir('@fontsource/noto-sans-hebrew');
  const sansDir = fontPackageDir('@fontsource/noto-sans');
  const faces = await Promise.all([
    fontFaceCss('Noto Sans Hebrew', 400, join(hebrewDir, 'files', 'noto-sans-hebrew-hebrew-400-normal.woff2')),
    fontFaceCss('Noto Sans Hebrew', 700, join(hebrewDir, 'files', 'noto-sans-hebrew-hebrew-700-normal.woff2')),
    fontFaceCss('Noto Sans', 400, join(sansDir, 'files', 'noto-sans-latin-400-normal.woff2')),
    fontFaceCss('Noto Sans', 700, join(sansDir, 'files', 'noto-sans-latin-700-normal.woff2')),
  ]);
  return faces.join('\n');
}

export function fontStackFor(lang: AdLanguage): string {
  return lang === 'he'
    ? '"Noto Sans Hebrew","Noto Sans",sans-serif'
    : '"Noto Sans","Noto Sans Hebrew",sans-serif';
}

export function cssColor(c: Rgb): string {
  return `rgb(${c.r},${c.g},${c.b})`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Wrap numbers-with-% and DD.MM dates in bidi-isolated LTR spans. */
export function isolateNumerals(escapedText: string): string {
  return escapedText.replace(
    /(\d[\d.]*%|\d{1,2}\.\d{1,2})/g,
    '<span dir="ltr" style="unicode-bidi:isolate">$1</span>',
  );
}

export interface PanelHtmlInput extends RenderInput {
  fontCss: string;
  mainPx: number;
  subPx: number;
}

/**
 * Full panel document. `lang`+`dir` follow the ad language, text stays in
 * logical string order (never reversed), numerals are bidi-isolated.
 */
export function buildPanelHtml(input: PanelHtmlInput): string {
  const dir = input.lang === 'he' ? 'rtl' : 'ltr';
  const stack = fontStackFor(input.lang);
  const main = isolateNumerals(escapeHtml(input.main));
  const sub = isolateNumerals(escapeHtml(input.sub));
  return `<!DOCTYPE html>
<html lang="${input.lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<style>
${input.fontCss}
html,body{margin:0;padding:0;width:${input.width}px;height:${input.height}px;}
.panel{width:${input.width}px;height:${input.height}px;background:${cssColor(input.fill)};border-radius:${input.radius}px;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;box-sizing:border-box;padding:0 40px;}
.main{font-family:${stack};font-weight:700;font-size:${input.mainPx}px;line-height:1.15;color:${cssColor(input.textColor)};white-space:nowrap;margin:0;text-align:center;}
.sub{font-family:${stack};font-weight:400;font-size:${input.subPx}px;line-height:1.3;color:${cssColor(input.textColor)};white-space:nowrap;margin:0;text-align:center;}
</style>
</head>
<body>
<div class="panel"><p class="main">${main}</p><p class="sub">${sub}</p></div>
</body>
</html>`;
}

async function panelOverflows(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector('.panel');
    if (!el) return true;
    return el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
  });
}

/**
 * Render the corrected panel in Chromium (Playwright): viewport exactly the
 * panel rect size, deviceScaleFactor 1, transparent background. Starts at a
 * size proportional to the panel height and shrinks until nothing overflows;
 * below the minimum (main 28 px, sub 18 px) the repair is refused with
 * `text_does_not_fit` instead of rendering clipped text.
 */
export async function renderPanel(input: RenderInput): Promise<RenderResult> {
  const fontCss = await loadFontCss();
  const stack = fontStackFor(input.lang);
  const main0 = Math.round(input.height * 0.4);
  const sub0 = Math.round(input.height * 0.2);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: input.width, height: input.height },
      deviceScaleFactor: 1,
    });
    let mainPx = main0;
    let subPx = sub0;
    await page.setContent(buildPanelHtml({ ...input, fontCss, mainPx, subPx }), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const primary = input.lang === 'he' ? 'Noto Sans Hebrew' : 'Noto Sans';
    const fontsOk = await page.evaluate((family: string) => {
      try {
        return (
          document.fonts.check(`400 20px "${family}"`) && document.fonts.check(`700 20px "${family}"`)
        );
      } catch {
        return false;
      }
    }, primary);
    if (!fontsOk) {
      throw new Error(`bundled font "${primary}" did not load (400/700 check failed)`);
    }

    for (;;) {
      if (!(await panelOverflows(page))) break;
      const nextMain = mainPx - 2;
      const nextSub = Math.round((nextMain * sub0) / main0);
      if (nextMain < MIN_MAIN_PX || nextSub < MIN_SUB_PX) {
        throw new RenderBlocker(
          `corrected text overflows a ${input.width}x${input.height} panel at the minimum size (main ${MIN_MAIN_PX}px, sub ${MIN_SUB_PX}px)`,
        );
      }
      mainPx = nextMain;
      subPx = nextSub;
      await page.setContent(buildPanelHtml({ ...input, fontCss, mainPx, subPx }), { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
    }

    const png = await page.screenshot({ type: 'png', omitBackground: true });
    return { png, mainPx, subPx, fontStack: stack };
  } finally {
    await browser.close();
  }
}
