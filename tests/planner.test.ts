import { describe, expect, it } from 'vitest';
import { presetById } from '../src/shared/presets.js';
import type { PlanBox, SourceAnalysis, TemplateSpec } from '../src/shared/schemas.js';
import { freeOtherTexts, luminance, mirrorNorm, planLayout, travelsWithPixels } from '../src/server/adfit/planner.js';

function analysis(over: Partial<SourceAnalysis> = {}): SourceAnalysis {
  return {
    language: 'he',
    direction: 'rtl',
    products: [{ label: 'bottle', sam_phrase: 'bottle', bbox: { x: 390, y: 210, w: 300, h: 560 } }],
    logo_bbox: { x: 850, y: 56, w: 170, h: 84 },
    headline: { text: '20% הנחה', bbox: { x: 90, y: 840, w: 900, h: 100 }, bold: true, color: '#ffffff' },
    subtext: null,
    panel: { bbox: { x: 90, y: 820, w: 900, h: 170 }, opaque: true, bg_color: '#ff5a3c', text_color: '#ffffff', texts: ['20% הנחה'] },
    other_texts: [],
    background: { type: 'gradient', description: 'teal gradient', colors: ['#e9f5f3'] },
    unreadable: [],
    ...over,
  };
}

function template(over: Partial<TemplateSpec> = {}): TemplateSpec {
  return {
    logo: { box: { x: 0.78, y: 0.03, w: 0.17, h: 0.08 }, corner: 'top-right' },
    headline_zone: { x: 0.07, y: 0.74, w: 0.86, h: 0.1 },
    subtext_zone: null,
    panel_zone: { box: { x: 0.08, y: 0.76, w: 0.84, h: 0.16 }, color: '#ff5a3c', shape: 'rounded_rect' },
    product_zone: { x: 0.3, y: 0.15, w: 0.4, h: 0.55 },
    frames: [],
    background_style: 'teal gradient',
    text_align: 'center',
    direction: 'rtl',
    ...over,
  };
}

const CUTS = [{ w: 300, h: 560 }];
const LOGO_CUT = { w: 170, h: 84 };

function inside(b: PlanBox | null, safe: PlanBox): boolean {
  if (!b) return true;
  return b.x >= safe.x && b.y >= safe.y && b.x + b.w <= safe.x + safe.w + 1 && b.y + b.h <= safe.y + safe.h + 1;
}

describe('layout planner', () => {
  it('maps template zones to boxes in the target size', () => {
    const preset = presetById('ig-feed-45')!;
    const plan = planLayout({
      preset, source: analysis(), sourceWidth: 1080, sourceHeight: 1080,
      productCuts: CUTS, logoCut: LOGO_CUT, template: { id: 'tpl-1', spec: template() },
    });
    expect(plan.from_template).toBe(true);
    expect(plan.template_id).toBe('tpl-1');
    expect(plan.width).toBe(1080);
    expect(plan.height).toBe(1350);
    // Panel zone 0.08..0.92 x 0.76..0.92 of 1080x1350.
    expect(plan.panel?.x).toBe(Math.round(0.08 * 1080));
    expect(plan.panel?.w).toBe(Math.round(0.84 * 1080));
    expect(plan.product_scales).toHaveLength(1);
    expect(plan.product_scales[0]).toBeGreaterThan(0);
  });

  it('mirrors template zones when the source direction differs', () => {
    const preset = presetById('ig-feed-11')!;
    const rtlPlan = planLayout({
      preset, source: analysis(), sourceWidth: 1080, sourceHeight: 1080,
      productCuts: CUTS, logoCut: LOGO_CUT, template: { id: 't', spec: template() },
    });
    const ltrPlan = planLayout({
      preset, source: analysis({ language: 'en', direction: 'ltr' }), sourceWidth: 1080, sourceHeight: 1080,
      productCuts: CUTS, logoCut: LOGO_CUT, template: { id: 't', spec: template() },
    });
    // Logo zone x 0.78 (right) mirrors to the left for ltr sources.
    expect(rtlPlan.logo!.x).toBeGreaterThan(preset.width / 2);
    expect(ltrPlan.logo!.x).toBeLessThan(preset.width / 2);
    expect(ltrPlan.notes.join(' ')).toMatch(/mirrored/);
    expect(mirrorNorm({ x: 0.78, y: 0.03, w: 0.17, h: 0.08 }).x).toBeCloseTo(0.05, 6);
  });

  it('keeps every planned box inside the safe area', () => {
    for (const id of ['ig-feed-11', 'ig-story-916', 'fb-link', 'yt-thumb']) {
      const preset = presetById(id)!;
      for (const withTemplate of [true, false]) {
        const plan = planLayout({
          preset, source: analysis(), sourceWidth: 1080, sourceHeight: 1080,
          productCuts: CUTS, logoCut: LOGO_CUT, template: withTemplate ? { id: 't', spec: template() } : null,
        });
        expect(inside(plan.logo, plan.safe), `${id} logo`).toBe(true);
        for (const p of plan.products) expect(inside(p, plan.safe), `${id} product`).toBe(true);
        expect(inside(plan.panel, plan.safe), `${id} panel`).toBe(true);
        expect(inside(plan.headline, plan.safe), `${id} headline`).toBe(true);
      }
    }
  });

  it('falls back to default rules: corner logo, centered product, bottom panel', () => {
    const preset = presetById('ig-feed-11')!;
    const plan = planLayout({
      preset, source: analysis(), sourceWidth: 1080, sourceHeight: 1080,
      productCuts: CUTS, logoCut: LOGO_CUT, template: null,
    });
    expect(plan.from_template).toBe(false);
    // rtl → top-right corner.
    expect(plan.logo!.x + plan.logo!.w).toBeGreaterThan(preset.width * 0.7);
    expect(plan.logo!.y).toBeLessThan(preset.height * 0.2);
    // Product centered horizontally within the safe area.
    const cx = plan.products[0]!.x + plan.products[0]!.w / 2;
    expect(Math.abs(cx - preset.width / 2)).toBeLessThan(preset.width * 0.1);
    // Panel at the bottom.
    expect(plan.panel!.y + plan.panel!.h).toBeGreaterThan(preset.height * 0.85);
    // ltr → top-left corner.
    const ltr = planLayout({
      preset, source: analysis({ language: 'en', direction: 'ltr' }), sourceWidth: 1080, sourceHeight: 1080,
      productCuts: CUTS, logoCut: LOGO_CUT, template: null,
    });
    expect(ltr.logo!.x).toBeLessThan(preset.width * 0.3);
  });

  it('splits the product zone across several products without stretching', () => {
    const preset = presetById('ig-feed-11')!;
    const two = [
      { label: 'a', sam_phrase: 'cup', bbox: { x: 100, y: 100, w: 200, h: 200 } },
      { label: 'b', sam_phrase: 'bag', bbox: { x: 400, y: 100, w: 200, h: 200 } },
    ];
    const plan = planLayout({
      preset, source: analysis({ products: two }), sourceWidth: 1080, sourceHeight: 1080,
      productCuts: [{ w: 200, h: 200 }, { w: 200, h: 200 }], logoCut: LOGO_CUT,
      template: { id: 't', spec: template() },
    });
    expect(plan.products).toHaveLength(2);
    expect(plan.product_scales).toHaveLength(2);
    // Uniform scale: aspect preserved.
    for (let i = 0; i < 2; i++) {
      expect(plan.products[i]!.w).toBe(plan.products[i]!.h);
    }
    expect(plan.products[0]!.x).toBeLessThan(plan.products[1]!.x);
  });

  it('maps other texts by relative position, clamped to the safe area', () => {
    const preset = presetById('ig-feed-11')!;
    const plan = planLayout({
      preset,
      source: analysis({
        other_texts: [{ text: 'tagline', bbox: { x: 90, y: 700, w: 140, h: 34 }, bold: false, color: '#1f5f6b' }],
      }),
      sourceWidth: 1080,
      sourceHeight: 1080,
      productCuts: CUTS,
      logoCut: LOGO_CUT,
      template: null,
    });
    expect(plan.other_texts).toHaveLength(1);
    // 140x34 grows to the 80x36 minimum, centered; clear of other elements.
    expect(plan.other_texts[0]).toMatchObject({ x: 90, y: 699, w: 140, h: 36 });
    expect(inside(plan.other_texts[0]!, plan.safe)).toBe(true);
  });

  it('grows sliver other-text boxes to a minimum readable size', () => {
    const preset = presetById('ig-story-916')!;
    const plan = planLayout({
      preset,
      source: analysis({
        other_texts: [{ text: 'tagline', bbox: { x: 740, y: 145, w: 250, h: 10 }, bold: false, color: '#1f5f6b' }],
      }),
      sourceWidth: 1080,
      sourceHeight: 1080,
      productCuts: CUTS,
      logoCut: LOGO_CUT,
      template: null,
    });
    // Relative height would be ~18px; the plan guarantees 36px.
    expect(plan.other_texts[0]!.h).toBeGreaterThanOrEqual(36);
    expect(plan.other_texts[0]!.w).toBeGreaterThanOrEqual(80);
    expect(inside(plan.other_texts[0]!, plan.safe)).toBe(true);
  });

  it('drops texts printed on the product/logo (they travel with pixels)', () => {
    const preset = presetById('ig-feed-11')!;
    const src = analysis({
      products: [{ label: 'bottle', sam_phrase: 'bottle', bbox: { x: 100, y: 100, w: 400, h: 600 } }],
      other_texts: [
        { text: 'GALI', bbox: { x: 200, y: 300, w: 120, h: 40 }, bold: true, color: '#ffffff' },
        { text: 'tagline', bbox: { x: 850, y: 140, w: 140, h: 34 }, bold: false, color: '#1f5f6b' },
      ],
    });
    expect(freeOtherTexts(src).map((t) => t.text)).toEqual(['tagline']);
    expect(travelsWithPixels(src, { x: 200, y: 300, w: 120, h: 40 })).toBe(true);
    expect(travelsWithPixels(src, { x: 850, y: 140, w: 140, h: 34 })).toBe(false);
    const plan = planLayout({
      preset, source: src, sourceWidth: 1080, sourceHeight: 1080,
      productCuts: CUTS, logoCut: LOGO_CUT, template: null,
    });
    expect(plan.other_texts).toHaveLength(1);
    expect(plan.notes.join(' ')).toMatch(/travel with pasted pixels/);
  });

  it('lays wide canvases side-by-side: product left, text column right (rtl)', () => {
    const preset = presetById('fb-link')!;
    const src = analysis({
      panel: null,
      headline: { text: 'Hi', bbox: { x: 100, y: 100, w: 300, h: 60 }, bold: true, color: '#000000' },
      subtext: { text: 'Sub', bbox: { x: 100, y: 200, w: 200, h: 40 }, bold: false, color: '#000000' },
    });
    const plan = planLayout({
      preset, source: src, sourceWidth: 1080, sourceHeight: 1080,
      productCuts: CUTS, logoCut: LOGO_CUT, template: null,
    });
    expect(plan.notes.join(' ')).toMatch(/side-by-side/);
    // Product on the left half, headline in the right column.
    expect(plan.products[0]!.x + plan.products[0]!.w).toBeLessThan(preset.width / 2 + 80);
    expect(plan.headline!.x).toBeGreaterThan(preset.width / 2 - 80);
    expect(plan.subtext!.y).toBeGreaterThan(plan.headline!.y);
    for (const b of [plan.products[0]!, plan.headline!, plan.subtext!]) {
      expect(inside(b, plan.safe)).toBe(true);
    }
  });

  it('relocates the logo out of a dark template band', () => {
    const preset = presetById('ig-story-916')!;
    const spec = template({
      logo: { box: { x: 0.3, y: 0.85, w: 0.4, h: 0.08 }, corner: 'bottom-left' },
      frames: [{ box: { x: 0, y: 0.79, w: 1, h: 0.21 }, color: '#0f4c5c', edge: 'bottom', kind: 'band' }],
    });
    const plan = planLayout({
      preset, source: analysis(), sourceWidth: 1080, sourceHeight: 1080,
      productCuts: CUTS, logoCut: LOGO_CUT, template: { id: 't', spec },
    });
    // Dark band (#0f4c5c, luminance ~0.07): default corner, not the band.
    expect(plan.notes.join(' ')).toMatch(/dark band/);
    expect(plan.logo!.y).toBeLessThan(preset.height * 0.3);
    expect(luminance('#0f4c5c')).toBeLessThan(0.4);
    expect(luminance('#e8fbf7')).toBeGreaterThan(0.4);
  });

  it('moves other texts out of the logo/product/panel (relative mapping can collide)', () => {
  const preset = presetById('ig-story-916')!;
  const src = analysis({
    other_texts: [{ text: 'tagline', bbox: { x: 740, y: 151, w: 250, h: 30 }, bold: false, color: '#1f5f6b' }],
  });
  expect(freeOtherTexts(src)).toHaveLength(1);
  const plan = planLayout({
    preset, source: src, sourceWidth: 1080, sourceHeight: 1080,
    productCuts: CUTS, logoCut: LOGO_CUT, template: null,
  });
  expect(plan.other_texts).toHaveLength(1);
  const t = plan.other_texts[0]!;
  const hit = (b: PlanBox | null): boolean =>
    !!b && t.x < b.x + b.w && b.x < t.x + t.w && t.y < b.y + b.h && b.y < t.y + t.h;
  expect(hit(plan.logo)).toBe(false);
  for (const p of plan.products) expect(hit(p)).toBe(false);
  expect(hit(plan.panel)).toBe(false);
  expect(inside(t, plan.safe)).toBe(true);
  expect(plan.notes.join(' ')).toMatch(/moved out of/);
  });

  it('renders free headlines outside the panel, skips ones inside it', () => {
    const preset = presetById('ig-feed-11')!;
    const insidePanel = planLayout({
      preset, source: analysis(), sourceWidth: 1080, sourceHeight: 1080,
      productCuts: CUTS, logoCut: LOGO_CUT, template: null,
    });
    expect(insidePanel.headline).toBeNull(); // headline sits inside the panel
    const free = planLayout({
      preset,
      source: analysis({ headline: { text: 'Hi', bbox: { x: 100, y: 100, w: 300, h: 60 }, bold: true, color: '#000000' } }),
      sourceWidth: 1080, sourceHeight: 1080, productCuts: CUTS, logoCut: LOGO_CUT, template: null,
    });
    expect(free.headline).not.toBeNull();
  });
});
