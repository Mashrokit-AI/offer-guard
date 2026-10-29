import { describe, expect, it } from 'vitest';
import { snapPanel, PanelSnapError } from '../src/server/repair/panel.js';
import { protectionBlockers } from '../src/server/repair/masks.js';
import { buildPanelCopy } from '../src/server/repair/templates.js';
import { buildPanelHtml, isolateNumerals } from '../src/server/repair/render.js';
import { pixelProof } from '../src/server/repair/proof.js';
import {
  compareClaims,
  findOutsidePanelContradiction,
  isClean,
  loadOfferSpec,
  toDayMonth,
} from '../src/server/repair/spec.js';
import { revalidate } from '../src/server/repair/revalidate.js';
import { STRINGS, parseLang, t, type MessageKey } from '../src/shared/i18n.js';
import type { AdClaims } from '../src/shared/schemas.js';

/** Paint helpers for tiny synthetic RGBA images (no fixtures, no network). */
function makeRgba(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const o = (y * w + x) * 4;
      buf[o] = r;
      buf[o + 1] = g;
      buf[o + 2] = b;
      buf[o + 3] = 255;
    }
  }
  return buf;
}

const FILL: [number, number, number] = [255, 90, 60];
const WHITE: [number, number, number] = [255, 255, 255];
const bg = (x: number, y: number): [number, number, number] => [190 + ((x + y) % 30), 220 + ((x * 2 + y) % 18), 215 + ((x + y * 3) % 20)];

function inRoundedRect(
  x: number, y: number,
  rect: { x: number; y: number; w: number; h: number }, r: number,
): boolean {
  const { x: x1, y: y1, w, h } = rect;
  const x2 = x1 + w;
  const y2 = y1 + h;
  if (x < x1 || x >= x2 || y < y1 || y >= y2) return false;
  if (r <= 0) return true;
  const corners: Array<[number, number]> = [
    [x1 + r, y1 + r],
    [x2 - r - 1, y1 + r],
    [x1 + r, y2 - r - 1],
    [x2 - r - 1, y2 - r - 1],
  ];
  for (const [cx, cy] of corners) {
    const dx = x - cx;
    const dy = y - cy;
    const inCornerZone =
      (x < x1 + r && y < y1 + r) || (x >= x2 - r && y < y1 + r) ||
      (x < x1 + r && y >= y2 - r) || (x >= x2 - r && y >= y2 - r);
    if (inCornerZone && dx * dx + dy * dy > r * r) return false;
  }
  return true;
}

function claims(over: Partial<AdClaims>): AdClaims {
  return {
    language: 'he',
    offer_texts: [],
    discount: { percent: 20, scope: 'selected_models', verbatim: '20% הנחה על דגמים נבחרים' },
    shipping: { terms: 'paid', verbatim: 'משלוח בתשלום' },
    valid_until: { day_month: '10.11', verbatim: 'עד 10.11' },
    panel: { bbox: { x: 20, y: 60, w: 160, h: 40 }, opaque: true },
    product_bbox: null,
    logo_bbox: null,
    unreadable: [],
    ...over,
  };
}

const SPEC = loadOfferSpec({
  version: 1,
  discount: { percent: 20, scope: 'selected_models' },
  shipping: 'paid',
  valid_until: '2026-11-10',
});

describe('snapPanel on synthetic images', () => {
  const W = 200;
  const H = 120;
  const RECT = { x: 20, y: 60, w: 160, h: 40 };

  it('snaps a uniform panel on a gradient to the exact rect', () => {
    const img = makeRgba(W, H, (x, y) => {
      if (!inRoundedRect(x, y, RECT, 8)) return bg(x, y);
      // white "text" bar in the middle, clear of the border band
      if (y >= 74 && y < 86 && x >= 50 && x < 150) return WHITE;
      return FILL;
    });
    const rough = { x: RECT.x + 8, y: RECT.y - 6, w: RECT.w - 20, h: RECT.h - 12 };
    const s = snapPanel(img, W, H, rough);
    expect(s.rect).toEqual(RECT);
    expect(s.fill).toEqual({ r: 255, g: 90, b: 60 });
    expect(s.textColor).toEqual({ r: 255, g: 255, b: 255 });
    expect(s.radius).toBeGreaterThanOrEqual(6);
    expect(s.radius).toBeLessThanOrEqual(10);
    expect(s.opaque).toBe(true);
    expect(s.matchFraction).toBe(1);
  });

  it('still snaps when the rough box undershoots by more than the 40px search margin', () => {
    const W2 = 400;
    const H2 = 300;
    const RECT2 = { x: 40, y: 200, w: 320, h: 80 };
    const img = makeRgba(W2, H2, (x, y) => (inRoundedRect(x, y, RECT2, 0) ? FILL : bg(x, y)));
    // rough bottom (230) misses the true bottom (280) by 50px: the search
    // window must widen past its initial 40px margin to snap exactly.
    const rough = { x: 50, y: 205, w: 300, h: 25 };
    const s = snapPanel(img, W2, H2, rough);
    expect(s.rect).toEqual(RECT2);
    expect(s.opaque).toBe(true);
  });

  it('rejects a semi-transparent panel over the product as not opaque', () => {
    const PRODUCT: [number, number, number] = [60, 130, 145];
    const ALPHA = 0.92;
    const blend = (c: [number, number, number]): [number, number, number] => [
      Math.round(ALPHA * FILL[0] + (1 - ALPHA) * c[0]),
      Math.round(ALPHA * FILL[1] + (1 - ALPHA) * c[1]),
      Math.round(ALPHA * FILL[2] + (1 - ALPHA) * c[2]),
    ];
    const overBg = blend([200, 229, 223]);
    const img = makeRgba(W, H, (x, y) => {
      const behind: [number, number, number] = x >= 80 && x < 120 ? PRODUCT : bg(x, y);
      if (!inRoundedRect(x, y, RECT, 8)) return behind;
      if (y >= 74 && y < 86 && x >= 50 && x < 150) return WHITE;
      return blend(behind);
    });
    void overBg;
    const rough = { x: 24, y: 62, w: 150, h: 34 };
    const s = snapPanel(img, W, H, rough);
    expect(s.rect).toEqual(RECT);
    expect(s.opaque).toBe(false);
    expect(s.matchFraction).toBeLessThan(0.97);
  });

  it('throws panel_not_found on an empty rough box', () => {
    const img = makeRgba(W, H, bg);
    expect(() => snapPanel(img, W, H, { x: 5, y: 5, w: 0, h: 10 })).toThrowError(PanelSnapError);
  });
});

describe('protectionBlockers', () => {
  const W = 100;
  const H = 100;
  const solid = (x1: number, y1: number, x2: number, y2: number): Uint8Array => {
    const m = new Uint8Array(W * H);
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) m[y * W + x] = 1;
    return m;
  };

  it('accepts two solid far-apart targets (sparse union is not "tiny")', () => {
    // ad-03 regression: bottle + wordmark-wide logo have a sparse union bbox
    // but both targets are solid — no blocker.
    expect(protectionBlockers(solid(40, 20, 60, 80), solid(70, 5, 95, 12), W, H)).toEqual([]);
  });

  it('flags an empty target', () => {
    expect(protectionBlockers(new Uint8Array(W * H), solid(70, 5, 95, 12), W, H)).toEqual([
      'protected_mask_empty',
    ]);
  });

  it('flags a scattered low-fill target as tiny', () => {
    const sparse = new Uint8Array(W * H);
    sparse[0] = 1;
    sparse[W * H - 1] = 1; // two pixels, full-frame bbox → fill ~0
    expect(protectionBlockers(sparse, solid(70, 5, 95, 12), W, H)).toEqual(['protected_mask_tiny']);
  });
});

describe('template text', () => {
  it('renders the exact Hebrew strings from the spec', () => {
    expect(buildPanelCopy(SPEC, 'he')).toEqual({
      main: '20% הנחה על דגמים נבחרים',
      sub: 'בתוקף עד 10.11 · משלוח בתשלום',
    });
  });

  it('renders the exact English strings from the spec', () => {
    expect(buildPanelCopy(SPEC, 'en')).toEqual({
      main: '20% off selected models',
      sub: 'Valid until 10.11 · paid shipping',
    });
  });

  it('renders the all/free variants exactly', () => {
    const spec = loadOfferSpec({
      version: 1,
      discount: { percent: 30, scope: 'all' },
      shipping: 'free',
      valid_until: '2026-11-10',
    });
    expect(buildPanelCopy(spec, 'he')).toEqual({
      main: '30% הנחה על הכל',
      sub: 'בתוקף עד 10.11 · משלוח חינם',
    });
    expect(buildPanelCopy(spec, 'en')).toEqual({
      main: '30% off everything',
      sub: 'Valid until 10.11 · free shipping',
    });
  });

  it('refuses to render an unspecified promise', () => {
    const spec = loadOfferSpec({
      version: 1,
      discount: { percent: 20, scope: 'unspecified' },
      shipping: 'paid',
      valid_until: '2026-11-10',
    });
    expect(() => buildPanelCopy(spec, 'en')).toThrow(/unspecified/);
  });
});

describe('bidi markup', () => {
  const base = {
    width: 900,
    height: 170,
    radius: 28,
    fill: { r: 255, g: 90, b: 60 },
    textColor: { r: 255, g: 255, b: 255 },
    fontCss: '',
    mainPx: 68,
    subPx: 34,
  };

  it('isolates numerals and dates, keeps logical order', () => {
    expect(isolateNumerals('20% הנחה על דגמים נבחרים')).toBe(
      '<span dir="ltr" style="unicode-bidi:isolate">20%</span> הנחה על דגמים נבחרים',
    );
    expect(isolateNumerals('בתוקף עד 10.11 · משלוח בתשלום')).toBe(
      'בתוקף עד <span dir="ltr" style="unicode-bidi:isolate">10.11</span> · משלוח בתשלום',
    );
  });

  it('emits rtl Hebrew and ltr English documents', () => {
    const he = buildPanelHtml({ ...base, lang: 'he', main: '20% הנחה על דגמים נבחרים', sub: 'בתוקף עד 10.11 · משלוח בתשלום' });
    expect(he).toContain('<html lang="he" dir="rtl">');
    expect(he).toContain('unicode-bidi:isolate">20%</span> הנחה');
    const en = buildPanelHtml({ ...base, lang: 'en', main: '20% off selected models', sub: 'Valid until 10.11 · paid shipping' });
    expect(en).toContain('<html lang="en" dir="ltr">');
    expect(en).toContain('unicode-bidi:isolate">20%</span> off');
  });
});

describe('pixelProof', () => {
  const W = 4;
  const H = 4;
  const RECT = { x: 1, y: 1, w: 2, h: 2 };
  const flat = (v: number): Buffer => {
    const b = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      b[i * 4] = v;
      b[i * 4 + 1] = v;
      b[i * 4 + 2] = v;
      b[i * 4 + 3] = 255;
    }
    return b;
  };
  const none = new Uint8Array(W * H);

  it('passes on identical images', () => {
    const p = pixelProof(
      { data: flat(10), width: W, height: H },
      { data: flat(10), width: W, height: H },
      RECT,
      none,
    );
    expect(p.pass).toBe(true);
    expect(p.changed_outside_rect).toBe(0);
    expect(p.changed_inside_protected).toBe(0);
    expect(p.max_channel_diff_outside).toBe(0);
  });

  it('fails on one changed pixel outside the rect', () => {
    const after = flat(10);
    after[0] = 60; // pixel (0,0), outside the rect
    const p = pixelProof({ data: flat(10), width: W, height: H }, { data: after, width: W, height: H }, RECT, none);
    expect(p.pass).toBe(false);
    expect(p.changed_outside_rect).toBe(1);
    expect(p.max_channel_diff_outside).toBe(50);
  });

  it('fails on a change inside the protected mask', () => {
    const prot = new Uint8Array(W * H);
    prot[1 * W + 1] = 1; // protected pixel at (1,1), inside the rect
    const after = flat(10);
    const o = (1 * W + 1) * 4;
    after[o] = 11;
    const p = pixelProof({ data: flat(10), width: W, height: H }, { data: after, width: W, height: H }, RECT, prot);
    expect(p.pass).toBe(false);
    expect(p.changed_inside_protected).toBe(1);
    expect(p.changed_outside_rect).toBe(0);
  });

  it('passes when only unprotected rect pixels change (the repair itself)', () => {
    const after = flat(10);
    const o = (1 * W + 1) * 4;
    after[o] = 200;
    after[o + 1] = 150;
    const p = pixelProof({ data: flat(10), width: W, height: H }, { data: after, width: W, height: H }, RECT, none);
    expect(p.pass).toBe(true);
  });
});

describe('spec comparison + repair gates', () => {
  it('parses the fixture spec (valid_until → DD.MM)', () => {
    expect(SPEC).toMatchObject({ version: 1, percent: 20, scope: 'selected_models', shipping: 'paid', dayMonth: '10.11' });
    expect(toDayMonth('10.11')).toBe('10.11');
    expect(toDayMonth('nope')).toBeNull();
  });

  it('matches a clean ad, flags a wrong one field by field', () => {
    expect(isClean(compareClaims(SPEC, claims({})))).toBe(true);
    const wrong = claims({
      discount: { percent: 30, scope: 'all', verbatim: '30% off everything' },
      shipping: { terms: 'free', verbatim: 'free shipping' },
    });
    const cmp = compareClaims(SPEC, wrong);
    expect(isClean(cmp)).toBe(false);
    expect(cmp.filter((c) => !c.match).map((c) => c.field).sort()).toEqual(['percent', 'scope', 'shipping']);
  });

  it('catches contradicting text outside the panel (he + en)', () => {
    const heOutside = claims({
      offer_texts: [{ text: '30% הנחה על הכל', bbox: { x: 1, y: 1, w: 5, h: 5 }, in_panel: false }],
    });
    expect(findOutsidePanelContradiction(SPEC, heOutside)?.reason).toMatch(/30%/);
    const enOutside = claims({
      language: 'en',
      offer_texts: [{ text: '+ free shipping · valid until 10.11', bbox: { x: 1, y: 1, w: 5, h: 5 }, in_panel: false }],
    });
    expect(findOutsidePanelContradiction(SPEC, enOutside)?.reason).toMatch(/free shipping/);
  });

  it('lets agreeing outside-panel text and in-panel text through', () => {
    const ok = claims({
      offer_texts: [
        { text: '20% off selected models', bbox: { x: 1, y: 1, w: 5, h: 5 }, in_panel: false },
        { text: '30% הנחה על הכל', bbox: { x: 1, y: 1, w: 5, h: 5 }, in_panel: true },
      ],
    });
    expect(findOutsidePanelContradiction(SPEC, ok)).toBeNull();
  });
});

describe('revalidate', () => {
  const before = claims({
    discount: { percent: 30, scope: 'all', verbatim: '30% off everything' },
    shipping: { terms: 'free', verbatim: 'free shipping' },
    offer_texts: [
      { text: '30% off everything', bbox: { x: 1, y: 1, w: 5, h: 5 }, in_panel: true },
      { text: '+ free shipping · valid until 10.11', bbox: { x: 1, y: 1, w: 5, h: 5 }, in_panel: true },
    ],
  });

  it('passes a fully corrected repair', () => {
    const after = claims({
      language: 'he',
      offer_texts: [
        { text: '20% הנחה על דגמים נבחרים', bbox: { x: 1, y: 1, w: 5, h: 5 }, in_panel: true },
        { text: 'בתוקף עד 10.11 · משלוח בתשלום', bbox: { x: 1, y: 1, w: 5, h: 5 }, in_panel: true },
      ],
    });
    const r = revalidate(before, after, SPEC);
    expect(r.pass).toBe(true);
  });

  it('fails when an old promise remains or the language flips', () => {
    const leftover = claims({
      offer_texts: [{ text: '20% הנחה על דגמים נבחרים + משלוח חינם', bbox: { x: 1, y: 1, w: 5, h: 5 }, in_panel: true }],
    });
    expect(revalidate(before, leftover, SPEC).pass).toBe(false);
    const flipped = claims({ language: 'en', offer_texts: [] });
    const r = revalidate(claims({ offer_texts: [] }), flipped, SPEC);
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.check === 'language_unchanged')?.pass).toBe(false);
  });
});

describe('i18n dictionary', () => {
  it('has every key in both languages', () => {
    const enKeys = Object.keys(STRINGS.en).sort();
    const heKeys = Object.keys(STRINGS.he).sort();
    expect(heKeys).toEqual(enKeys);
    expect(enKeys.length).toBeGreaterThan(20);
    for (const k of enKeys) {
      expect(STRINGS.en[k as MessageKey].length).toBeGreaterThan(0);
      expect(STRINGS.he[k as MessageKey].length).toBeGreaterThan(0);
    }
  });

  it('interpolates {vars} and parses --lang', () => {
    expect(t('en', 'proof_changed_outside', { count: 3 })).toBe('changed pixels outside panel: 3');
    expect(t('he', 'proof_changed_outside', { count: 3 })).toContain('3');
    expect(parseLang(['--lang', 'he'])).toBe('he');
    expect(parseLang([])).toBe('en');
    expect(parseLang(['--lang', 'fr'])).toBe('en');
  });
});
