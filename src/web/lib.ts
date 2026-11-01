import { STRINGS, t, type Lang, type MessageKey } from '../shared/i18n.js';

export type { Lang };
export { STRINGS, t };

/** Tiny DOM helper. String children become text nodes — never HTML. */
export function h(
  tag: string,
  attrs: Record<string, string | number | boolean | null | undefined> = {},
  ...children: Array<Node | string | null | undefined | false>
): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'for') el.setAttribute('for', String(v));
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return el;
}

export interface Msg {
  key: string;
  vars: Record<string, string>;
}

/**
 * Render a server {key, vars} message. Vars named `side`/`field` hold nested
 * message keys and are resolved first.
 */
export function msg(lang: Lang, m: Msg): string {
  const vars: Record<string, string | number> = { ...m.vars };
  if (vars.side === 'side_ad' || vars.side === 'side_page') vars.side = t(lang, vars.side as MessageKey);
  const f = vars.field;
  if (typeof f === 'string' && f.startsWith('field_') && f in STRINGS.en) {
    vars.field = t(lang, f as MessageKey);
  }
  if (m.key in STRINGS.en) {
    const s = t(lang, m.key as MessageKey, vars);
    return s.length > 0 ? s[0]?.toUpperCase() + s.slice(1) : s;
  }
  return m.key;
}

export function getLang(): Lang {
  try {
    const q = new URLSearchParams(window.location.search).get('lang');
    if (q === 'he' || q === 'en') {
      window.localStorage.setItem('og-lang', q);
      return q;
    }
    return window.localStorage.getItem('og-lang') === 'he' ? 'he' : 'en';
  } catch {
    return 'en';
  }
}

export function setLang(lang: Lang): void {
  try {
    window.localStorage.setItem('og-lang', lang);
  } catch {
    // Private mode: the toggle still works for this page load.
  }
}

export function applyLang(lang: Lang): void {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
  document.title = `Offer Guard — ${t(lang, 'app_tagline')}`;
}

export class ApiError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(key);
    this.key = key;
  }
}

/** Relative-URL fetch (works under any base path). Throws ApiError on {error}. */
export async function api(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(path, init);
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    throw new ApiError(res.ok ? 'err_unknown' : 'err_not_found');
  }
  const body = (await res.json()) as { error?: string } & Record<string, unknown>;
  if (!res.ok || typeof body.error === 'string') {
    throw new ApiError(typeof body.error === 'string' ? body.error : 'err_unknown');
  }
  return body;
}

export function fmtTime(lang: Lang, iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString(lang === 'he' ? 'he-IL' : 'en-US', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** Verdict → badge class + icon + label key. */
export function verdictBadge(lang: Lang, verdict: string): HTMLElement {
  let cls = 'v-err';
  let ico = '✕';
  let label = verdict;
  switch (verdict) {
    case 'CLEAN':
      cls = 'v-clean';
      ico = '✓';
      label = t(lang, 'counter_clean');
      break;
    case 'AD_WRONG_REPAIRABLE':
      cls = 'v-fixed';
      ico = '✎';
      label = t(lang, 'counter_fixed');
      break;
    case 'AD_WRONG_UNSAFE':
      cls = 'v-refused';
      ico = '!';
      label = t(lang, 'counter_refused');
      break;
    case 'PAGE_WRONG':
      cls = 'v-page';
      ico = '⚑';
      label = t(lang, 'counter_page_wrong');
      break;
    case 'AMBIGUOUS':
      cls = 'v-amb';
      ico = '?';
      label = t(lang, 'counter_ambiguous');
      break;
    case 'CAPTURE_FAILED':
      label = t(lang, 'verdict_capture_failed');
      break;
    case 'UNSUPPORTED_FORMAT':
      label = t(lang, 'verdict_unsupported_format');
      break;
  }
  return h('span', { class: `badge ${cls}` }, h('span', { class: 'ico', 'aria-hidden': 'true' }, ico), label);
}

export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Absolutely-positioned % box overlay (appended to a positioned frame). */
export function bboxDiv(bbox: Bbox, frameW: number, frameH: number, cls: string, tag?: string): HTMLElement {
  const d = h('div', {
    class: `box ${cls}`,
    style: [
      `left:${((bbox.x / frameW) * 100).toFixed(2)}%`,
      `top:${((bbox.y / frameH) * 100).toFixed(2)}%`,
      `width:${((bbox.w / frameW) * 100).toFixed(2)}%`,
      `height:${((bbox.h / frameH) * 100).toFixed(2)}%`,
    ].join(';'),
  });
  if (tag) d.append(h('span', { class: 'tag' }, tag));
  return d;
}

/** Draw a zoomed crop of one bbox onto a canvas (fixed height, honest zoom). */
export function cropCanvas(img: HTMLImageElement, bbox: Bbox, heightPx = 110): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const w = Math.max(1, Math.round(bbox.w));
  const hgt = Math.max(1, Math.round(bbox.h));
  const scale = heightPx / hgt;
  canvas.height = heightPx;
  canvas.width = Math.min(640, Math.max(1, Math.round(w * scale)));
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, bbox.x, bbox.y, w, hgt, 0, 0, canvas.width, heightPx);
  }
  return canvas;
}

export function shieldSvg(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '30');
  svg.setAttribute('height', '30');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p1.setAttribute('d', 'M16 2l11 4v8c0 7-4.6 12.4-11 16C9.6 26.4 5 21 5 14V6z');
  p1.setAttribute('fill', '#0c6b4f');
  const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p2.setAttribute('d', 'M11 15.5l3.4 3.4L21.5 12');
  p2.setAttribute('stroke', '#fff');
  p2.setAttribute('stroke-width', '2.6');
  p2.setAttribute('fill', 'none');
  p2.setAttribute('stroke-linecap', 'round');
  p2.setAttribute('stroke-linejoin', 'round');
  svg.append(p1, p2);
  return svg;
}
