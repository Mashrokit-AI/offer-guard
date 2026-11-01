import { BRAND_NAME, BRAND_SLUG } from '../shared/brand.js';
import { STRINGS, t, type Lang, type MessageKey } from '../shared/i18n.js';

export type { Lang };
export { BRAND_NAME, BRAND_SLUG, STRINGS, t };

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

export function getLang(): Lang {
  try {
    const q = new URLSearchParams(window.location.search).get('lang');
    if (q === 'he' || q === 'en') {
      window.localStorage.setItem('adfit-lang', q);
      return q;
    }
    return window.localStorage.getItem('adfit-lang') === 'he' ? 'he' : 'en';
  } catch {
    return 'en';
  }
}

export function setLang(lang: Lang): void {
  try {
    window.localStorage.setItem('adfit-lang', lang);
  } catch {
    // Private mode: the toggle still works for this page load.
  }
}

export function applyLang(lang: Lang): void {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
  document.title = `${BRAND_NAME} — ${t(lang, 'app_tagline')}`;
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

export function errText(lang: Lang, e: unknown): string {
  const key = e instanceof ApiError ? e.key : 'err_unknown';
  return key in STRINGS.en ? t(lang, key as MessageKey) : key;
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

/** QA badge: green check or amber warning. */
export function qaBadge(lang: Lang, pass: boolean | null): HTMLElement {
  if (pass === true) return h('span', { class: 'badge v-clean' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '✓'), t(lang, 'qa_pass'));
  if (pass === false) return h('span', { class: 'badge v-page' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '⚠'), t(lang, 'qa_fail'));
  return h('span', { class: 'badge v-err' }, '…');
}

export function modeBadge(lang: Lang, mode: string): HTMLElement {
  return h('span', { class: 'chip' }, t(lang, mode === 'fast' ? 'mode_badge_fast' : 'mode_badge_protected'));
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
      `top:${((bbox.y / frameW) * 100).toFixed(2)}%`,
      `width:${((bbox.w / frameW) * 100).toFixed(2)}%`,
      `height:${((bbox.h / frameH) * 100).toFixed(2)}%`,
    ].join(';'),
  });
  if (tag) d.append(h('span', { class: 'tag' }, tag));
  return d;
}

/** Brand mark: two overlapping placement frames. */
export function brandSvg(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '30');
  svg.setAttribute('height', '30');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  const back = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  back.setAttribute('x', '9');
  back.setAttribute('y', '3');
  back.setAttribute('width', '20');
  back.setAttribute('height', '20');
  back.setAttribute('rx', '2');
  back.setAttribute('fill', 'none');
  back.setAttribute('stroke', '#7fb8a4');
  back.setAttribute('stroke-width', '2.4');
  const front = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  front.setAttribute('x', '3');
  front.setAttribute('y', '9');
  front.setAttribute('width', '20');
  front.setAttribute('height', '20');
  front.setAttribute('rx', '2');
  front.setAttribute('fill', '#0c6b4f');
  const check = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  check.setAttribute('d', 'M8.5 19.5l4 4L18 17');
  check.setAttribute('stroke', '#fff');
  check.setAttribute('stroke-width', '2.6');
  check.setAttribute('fill', 'none');
  check.setAttribute('stroke-linecap', 'round');
  check.setAttribute('stroke-linejoin', 'round');
  svg.append(back, front, check);
  return svg;
}
