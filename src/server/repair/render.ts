import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium, type Page } from 'playwright';
import type { AdLanguage } from '../../shared/schemas.js';

/** sRGB color triple, 0-255 per channel. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse a #rrggbb string (throws on anything else). */
export function rgbFromHex(hex: string): Rgb {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m?.[1]) throw new Error(`not a #rrggbb color: ${JSON.stringify(hex)}`);
  return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) };
}

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
  fonts: { ready: Promise<unknown>; check(spec: string): boolean; load(font: string, text?: string): Promise<unknown[]> };
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

export function escapeHtml(s: string): string {
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

/**
 * Chromium for text rendering. Sandboxed shells (no Mach bootstrap on macOS)
 * cannot launch the default multi-process browser; RENDER_SINGLE_PROCESS=1
 * falls back to one process. Dev machines with Google Chrome but no
 * downloaded Playwright browsers fall back to the system Chrome channel.
 */
async function launchRenderBrowser() {
  const args = process.env.RENDER_SINGLE_PROCESS === '1' ? ['--single-process', '--no-sandbox', '--disable-gpu'] : undefined;
  try {
    return await chromium.launch(args ? { args } : undefined);
  } catch (e) {
    if (e instanceof Error && /Executable doesn't exist/.test(e.message)) {
      return chromium.launch({ channel: 'chrome', args });
    }
    throw e;
  }
}

// One shared browser for the whole worker pool (pages are short-lived).
let sharedBrowser: Awaited<ReturnType<typeof launchRenderBrowser>> | null = null;
let sharedBrowserPromise: Promise<Awaited<ReturnType<typeof launchRenderBrowser>>> | null = null;

async function getSharedBrowser(): Promise<NonNullable<typeof sharedBrowser>> {
  if (sharedBrowser) return sharedBrowser;
  sharedBrowserPromise ??= launchRenderBrowser().then((b) => {
    sharedBrowser = b;
    return b;
  });
  return sharedBrowserPromise;
}

/** Close the shared browser (tests / process shutdown). */
export async function closeSharedBrowser(): Promise<void> {
  const b = sharedBrowser;
  sharedBrowser = null;
  sharedBrowserPromise = null;
  if (b) await b.close().catch(() => undefined);
}

async function withPage<T>(width: number, height: number, fn: (page: Page) => Promise<T>): Promise<T> {
  // Single-process Chromium cannot reliably serve sequential pages on one
  // browser (the process dies after the first page closes): give every
  // render its own browser there. Multi-process browsers share one.
  if (process.env.RENDER_SINGLE_PROCESS === '1') {
    const browser = await launchRenderBrowser();
    try {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      try {
        return await fn(page);
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
  const browser = await getSharedBrowser();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => undefined);
  }
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

  return withPage(input.width, input.height, async (page) => {
    let mainPx = main0;
    let subPx = sub0;
    await page.setContent(buildPanelHtml({ ...input, fontCss, mainPx, subPx }), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await assertFontsLoaded(page, input.lang);

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
  });
}

async function assertFontsLoaded(page: Page, lang: AdLanguage): Promise<void> {
  const primary = lang === 'he' ? 'Noto Sans Hebrew' : 'Noto Sans';
  // Force both weights to load: fonts.ready can resolve while a used face is
  // still decoding (slow single-process builds), which makes a bare check racy.
  await page.evaluate(async (family: string) => {
    try {
      await Promise.all([
        document.fonts.load(`400 20px "${family}"`),
        document.fonts.load(`700 20px "${family}"`),
      ]);
    } catch {
      // Fall through to the check below, which reports precisely.
    }
  }, primary);
  const fontsOk = await page.evaluate((family: string) => {
    try {
      return document.fonts.check(`400 20px "${family}"`) && document.fonts.check(`700 20px "${family}"`);
    } catch {
      return false;
    }
  }, primary);
  if (!fontsOk) {
    throw new Error(`bundled font "${primary}" did not load (400/700 check failed)`);
  }
}

// --- free-text blocks (MatchPic protected mode) ---

export interface TextLine {
  text: string;
  /** Starting font size; shrinks to fit, never grows. */
  px: number;
  weight: 400 | 700;
  color: Rgb;
}

export interface TextBlockInput {
  width: number;
  height: number;
  lines: TextLine[];
  lang: AdLanguage;
  align: 'start' | 'center' | 'end';
}

export interface TextBlockResult {
  png: Buffer;
  sizes: number[];
  fontStack: string;
}

export const MIN_TEXT_PX = 18;

export function buildTextBlockHtml(input: TextBlockInput & { fontCss: string; sizes: number[] }): string {
  const dir = input.lang === 'he' ? 'rtl' : 'ltr';
  const stack = fontStackFor(input.lang);
  const align = input.align === 'start' ? 'start' : input.align === 'end' ? 'end' : 'center';
  const lines = input.lines
    .map((l, i) => {
      const size = input.sizes[i] ?? l.px;
      return `<p class="tline" style="font-size:${size}px;font-weight:${l.weight};color:${cssColor(l.color)}">${isolateNumerals(escapeHtml(l.text))}</p>`;
    })
    .join('');
  return `<!DOCTYPE html>
<html lang="${input.lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<style>
${input.fontCss}
html,body{margin:0;padding:0;width:${input.width}px;height:${input.height}px;}
.block{width:${input.width}px;height:${input.height}px;display:flex;flex-direction:column;align-items:stretch;justify-content:center;overflow:hidden;box-sizing:border-box;}
.tline{font-family:${stack};line-height:1.2;margin:0;text-align:${align};white-space:pre-wrap;overflow-wrap:break-word;}
</style>
</head>
<body>
<div class="block">${lines}</div>
</body>
</html>`;
}

async function blockOverflows(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector('.block');
    if (!el) return true;
    return el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
  });
}

/**
 * Render verbatim free text on a transparent canvas in Chromium (Playwright):
 * viewport exactly the target size, deviceScaleFactor 1. Text stays in
 * logical string order (never reversed), numerals are bidi-isolated.
 * Shrinks all lines proportionally until nothing overflows; below MIN_TEXT_PX
 * the render is refused with `text_does_not_fit` instead of clipped text.
 */
export async function renderTextBlock(input: TextBlockInput): Promise<TextBlockResult> {
  const fontCss = await loadFontCss();
  const stack = fontStackFor(input.lang);
  return withPage(input.width, input.height, async (page) => {
    let sizes = input.lines.map((l) => l.px);
    await page.setContent(buildTextBlockHtml({ ...input, fontCss, sizes }), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await assertFontsLoaded(page, input.lang);
    for (;;) {
      if (!(await blockOverflows(page))) break;
      const next = sizes.map((s) => s - 2);
      if (next.some((s) => s < MIN_TEXT_PX)) {
        throw new RenderBlocker(
          `free text overflows a ${input.width}x${input.height} box at the minimum size (${MIN_TEXT_PX}px)`,
        );
      }
      sizes = next;
      await page.setContent(buildTextBlockHtml({ ...input, fontCss, sizes }), { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
    }
    const png = await page.screenshot({ type: 'png', omitBackground: true });
    return { png, sizes, fontStack: stack };
  });
}

// --- rebuilt offer panels (MatchPic: panels are rebuilt, not pasted) ---

export interface PanelLine {
  text: string;
  weight: 400 | 700;
  color: Rgb;
}

export interface RebuiltPanelInput {
  width: number;
  height: number;
  radius: number;
  fill: Rgb;
  lines: PanelLine[];
  lang: AdLanguage;
  align: 'start' | 'center' | 'end';
}

export interface RebuiltPanelResult {
  png: Buffer;
  sizes: number[];
  fontStack: string;
}

/**
 * Minimum legible text height per canvas: body text must render at ≥ this
 * size or the panel falls back to pasting (flagged) instead of rebuilding.
 */
export function minLegiblePx(canvasShortSide: number): number {
  return Math.max(18, Math.round(canvasShortSide * 0.022));
}

export function buildRebuiltPanelHtml(input: RebuiltPanelInput & { fontCss: string; sizes: number[] }): string {
  const dir = input.lang === 'he' ? 'rtl' : 'ltr';
  const stack = fontStackFor(input.lang);
  const align = input.align === 'start' ? 'start' : input.align === 'end' ? 'end' : 'center';
  const lines = input.lines
    .map((l, i) => {
      const size = input.sizes[i] ?? 24;
      return `<p class="pline" style="font-size:${size}px;font-weight:${l.weight};color:${cssColor(l.color)}">${isolateNumerals(escapeHtml(l.text))}</p>`;
    })
    .join('');
  return `<!DOCTYPE html>
<html lang="${input.lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<style>
${input.fontCss}
html,body{margin:0;padding:0;width:${input.width}px;height:${input.height}px;}
.panel{width:${input.width}px;height:${input.height}px;background:${cssColor(input.fill)};border-radius:${input.radius}px;display:flex;flex-direction:column;align-items:stretch;justify-content:center;overflow:hidden;box-sizing:border-box;padding:${Math.round(input.height * 0.1)}px ${Math.round(input.width * 0.05)}px;}
.pline{font-family:${stack};line-height:1.25;margin:0;text-align:${align};white-space:pre-wrap;overflow-wrap:break-word;}
</style>
</head>
<body>
<div class="panel">${lines}</div>
</body>
</html>`;
}

/**
 * Render a rebuilt offer panel: solid rounded-rect background sampled from the
 * source plus verbatim text lines (exact strings, never reworded). Starts
 * large and shrinks to fit; refuses below the legible floor instead of
 * rendering unreadable text.
 */
export async function renderRebuiltPanel(input: RebuiltPanelInput): Promise<RebuiltPanelResult> {
  const fontCss = await loadFontCss();
  const stack = fontStackFor(input.lang);
  const floor = minLegiblePx(Math.min(input.width, input.height));
  return withPage(input.width, input.height, async (page) => {
    let sizes = input.lines.map((_, i) => (i === 0 ? Math.round(input.height * 0.42) : Math.round(input.height * 0.24)));
    await page.setContent(buildRebuiltPanelHtml({ ...input, fontCss, sizes }), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await assertFontsLoaded(page, input.lang);
    for (;;) {
      const overflows = await page.evaluate(() => {
        const el = document.querySelector('.panel');
        if (!el) return true;
        return el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
      });
      if (!overflows) break;
      const next = sizes.map((s) => s - 2);
      if (next.some((s) => s < floor)) {
        throw new RenderBlocker(
          `panel text overflows a ${input.width}x${input.height} panel below the legible floor (${floor}px)`,
        );
      }
      sizes = next;
      await page.setContent(buildRebuiltPanelHtml({ ...input, fontCss, sizes }), { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
    }
    const png = await page.screenshot({ type: 'png', omitBackground: false });
    return { png, sizes, fontStack: stack };
  });
}

/** Real rendered text bounds for one line (post-font-load measurement). */
export interface MeasuredText {
  width: number;
  height: number;
  fontPx: number;
}

/**
 * Measure the real rendered size of verbatim text lines at a starting font
 * size (fonts loaded, no guessing). Used to size layout boxes before placing.
 */
export async function measureTextLines(
  lines: Array<{ text: string; px: number; weight: 400 | 700 }>,
  lang: AdLanguage,
): Promise<MeasuredText[]> {
  const fontCss = await loadFontCss();
  const stack = fontStackFor(lang);
  const dir = lang === 'he' ? 'rtl' : 'ltr';
  const rows = lines
    .map((l, i) => `<p id="l${i}" style="font-size:${l.px}px;font-weight:${l.weight};margin:0;white-space:nowrap;">${isolateNumerals(escapeHtml(l.text))}</p>`)
    .join('');
  const html = `<!DOCTYPE html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><style>${fontCss}
html,body{margin:0;padding:0;}.m{font-family:${stack};display:inline-block;}</style></head><body><div class="m">${rows}</div></body></html>`;
  return withPage(2400, 400, async (page) => {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await assertFontsLoaded(page, lang);
    return page.evaluate((n: number) => {
      const out: Array<{ width: number; height: number; fontPx: number }> = [];
      for (let i = 0; i < n; i++) {
        const p = document.querySelector(`#l${i}`);
        if (!p) {
          out.push({ width: 0, height: 0, fontPx: 0 });
          continue;
        }
        out.push({ width: p.scrollWidth, height: p.scrollHeight, fontPx: 0 });
      }
      return out;
    }, lines.length).then((sizes) => sizes.map((s, i) => ({ ...s, fontPx: lines[i]?.px ?? 0 })));
  });
}
