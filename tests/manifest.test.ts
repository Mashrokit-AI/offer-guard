import { describe, expect, it } from 'vitest';
import { presetById } from '../src/shared/presets.js';
import type { LayoutPlan } from '../src/shared/schemas.js';
import { enforceManifest, familyForPreset, manifestFromPlan, paintOrder, templateZonesPx } from '../src/server/adfit/manifest.js';

function plan(over: Partial<LayoutPlan> = {}): LayoutPlan {
  const safe = { x: 43, y: 43, w: 994, h: 994 };
  return {
    preset: 'ig-feed-11',
    width: 1080,
    height: 1080,
    from_template: true,
    template_id: 't1',
    safe,
    logo: { x: 850, y: 60, w: 170, h: 60 },
    products: [{ x: 390, y: 200, w: 300, h: 560 }],
    headline: { x: 140, y: 845, w: 800, h: 60 },
    subtext: null,
    panel: { x: 90, y: 840, w: 900, h: 170 },
    other_texts: [],
    product_scales: [1],
    logo_scale: 1,
    notes: ['logo: template zone', 'products: template zone', 'panel: template zone', 'headline: template zone'],
    ...over,
  };
}

describe('layout manifest', () => {
  it('assigns composition families by aspect', () => {
    expect(familyForPreset(presetById('fb-link')!)).toBe('landscape_split');
    expect(familyForPreset(presetById('ig-story-916')!)).toBe('portrait_stack');
    expect(familyForPreset(presetById('ig-feed-11')!)).toBe('square_balanced');
    expect(familyForPreset(presetById('ig-feed-45')!)).toBe('square_balanced');
  });

  it('builds one element per placed box with z-order, group, align and scale', () => {
    const m = manifestFromPlan({ plan: plan(), preset: presetById('ig-feed-11')!, planner: 'code', direction: 'rtl' });
    expect(m.family).toBe('square_balanced');
    expect(m.planner).toBe('code');
    const ids = m.elements.map((e) => e.id).sort();
    expect(ids).toEqual(['headline', 'logo', 'panel', 'product-0']);
    const byId = Object.fromEntries(m.elements.map((e) => [e.id, e]));
    expect(byId['product-0']?.group).toBe('products');
    expect(byId['product-0']?.scale).toBe(1);
    expect(byId['headline']?.group).toBe('text');
    expect(byId['headline']?.align).toBe('right');
    expect(byId['panel']?.group).toBe('offer');
    // Paint order: panel < product < headline < logo.
    const zs = paintOrder(m).map((e) => e.id);
    expect(zs).toEqual(['panel', 'product-0', 'headline', 'logo']);
    // Template-zone sources are detected from plan notes.
    expect(byId['product-0']?.source).toBe('template');
  });

  it('uses the left edge for LTR text', () => {
    const m = manifestFromPlan({ plan: plan(), preset: presetById('ig-feed-11')!, planner: 'code', direction: 'ltr' });
    expect(m.elements.find((e) => e.id === 'headline')?.align).toBe('left');
  });

  it('clamps out-of-safe boxes and records corrections', () => {
    const m = manifestFromPlan({
      plan: plan({ logo: { x: 1000, y: 10, w: 200, h: 60 } }),
      preset: presetById('ig-feed-11')!,
      planner: 'code',
      direction: 'rtl',
    });
    const out = enforceManifest({ manifest: m, direction: 'rtl' });
    const logo = out.elements.find((e) => e.id === 'logo')!;
    expect(logo.box.x + logo.box.w).toBeLessThanOrEqual(out.safe.x + out.safe.w);
    expect(logo.source).toBe('corrected');
    expect(out.corrections.join(' ')).toMatch(/logo.*safe area/);
  });

  it('grows a small 9:16 product toward the 45% floor', () => {
    const p = plan({
      preset: 'ig-story-916',
      width: 1080,
      height: 1920,
      safe: { x: 54, y: 269, w: 972, h: 1267 },
      logo: null,
      products: [{ x: 400, y: 700, w: 280, h: 400 }],
      headline: null,
      panel: { x: 110, y: 1240, w: 860, h: 200 },
      product_scales: [1],
      logo_scale: null,
    });
    const m = manifestFromPlan({ plan: p, preset: presetById('ig-story-916')!, planner: 'code', direction: 'rtl' });
    const out = enforceManifest({ manifest: m, direction: 'rtl' });
    const prod = out.elements.find((e) => e.id === 'product-0')!;
    expect(prod.box.h).toBeGreaterThan(400);
    expect(out.corrections.join(' ')).toMatch(/45% safe-height/);
  });

  it('moves text/logo clear of overlaps, including panel-nested text', () => {
    const m = manifestFromPlan({
      plan: plan({ products: [{ x: 800, y: 40, w: 300, h: 300 }] }),
      preset: presetById('ig-feed-11')!,
      planner: 'code',
      direction: 'rtl',
    });
    const out = enforceManifest({ manifest: m, direction: 'rtl' });
    // The logo yields to the product (products never move for text/logo).
    expect(out.corrections.join(' ')).toMatch(/logo: pushed clear of product-0/);
    const logo = out.elements.find((e) => e.id === 'logo')!;
    const prod = out.elements.find((e) => e.id === 'product-0')!;
    expect(logo.box.y).toBeGreaterThanOrEqual(prod.box.y + prod.box.h);
    // A free-text box inside the panel box always collides: pushed out.
    expect(out.corrections.join(' ')).toMatch(/headline: pushed clear of panel/);
    const h = out.elements.find((e) => e.id === 'headline')!;
    const p = out.elements.find((e) => e.id === 'panel')!;
    expect(h.box.y + h.box.h).toBeLessThanOrEqual(p.box.y);
  });

  it('pushes overlapping free text apart in reading order', () => {
    const m = manifestFromPlan({
      plan: plan({ panel: null, headline: { x: 140, y: 200, w: 800, h: 60 }, subtext: { x: 140, y: 220, w: 600, h: 40 }, products: [], product_scales: [], notes: [] }),
      preset: presetById('ig-feed-11')!,
      planner: 'wonder',
      direction: 'ltr',
    });
    const out = enforceManifest({ manifest: m, direction: 'ltr' });
    const h = out.elements.find((e) => e.id === 'headline')!;
    const s = out.elements.find((e) => e.id === 'subtext')!;
    expect(s.box.y).toBeGreaterThanOrEqual(h.box.y + h.box.h);
    expect(out.corrections.join(' ')).toMatch(/subtext: pushed clear of headline/);
  });

  it('clamps overlap pushes to the margin bound, not just the safe area', () => {
    // fb-link: safe bottom is 603 but the 6% margin bound is 590. A push that
    // would strand the subtext at 563..603 (safe-legal, margin-busting) must
    // fall back above the headline instead.
    const m = manifestFromPlan({
      plan: plan({ preset: 'fb-link', width: 1200, height: 628, safe: { x: 48, y: 25, w: 1104, h: 578 }, panel: null, logo: null, products: [], product_scales: [], logo_scale: null, headline: { x: 500, y: 500, w: 600, h: 60 }, subtext: { x: 500, y: 520, w: 600, h: 40 }, notes: [] }),
      preset: presetById('fb-link')!,
      planner: 'wonder',
      direction: 'ltr',
    });
    const out = enforceManifest({ manifest: m, direction: 'ltr' });
    const h = out.elements.find((e) => e.id === 'headline')!;
    const s = out.elements.find((e) => e.id === 'subtext')!;
    expect(s.box.y + s.box.h).toBeLessThanOrEqual(590);
    expect(h.box.y + h.box.h).toBeLessThanOrEqual(590);
    expect(s.box.y + s.box.h <= h.box.y || h.box.y + h.box.h <= s.box.y).toBe(true);
  });

  it('grows a tiny logo to the minimum instead of shrinking it away', () => {
    const m = manifestFromPlan({
      plan: plan({ panel: null, logo: { x: 156, y: 302, w: 23, h: 8 }, headline: { x: 65, y: 269, w: 931, h: 115 }, products: [], product_scales: [], notes: [] }),
      preset: presetById('ig-feed-11')!,
      planner: 'wonder',
      direction: 'ltr',
    });
    const out = enforceManifest({ manifest: m, direction: 'ltr' });
    const logo = out.elements.find((e) => e.id === 'logo')!;
    const h = out.elements.find((e) => e.id === 'headline')!;
    expect(logo.box.h).toBeGreaterThanOrEqual(38);
    expect(logo.box.y).toBeGreaterThanOrEqual(h.box.y + h.box.h);
    expect(out.corrections.join(' ')).toMatch(/logo: grew to the logo minimum/);
    expect(out.corrections.join(' ')).toMatch(/logo: pushed clear of headline/);
  });

  it('flags empty bands over 25% of the canvas', () => {
    const m = manifestFromPlan({
      plan: plan({ products: [{ x: 400, y: 80, w: 280, h: 200 }], headline: null, panel: null, logo: null, product_scales: [1], logo_scale: null }),
      preset: presetById('ig-feed-11')!,
      planner: 'code',
      direction: 'rtl',
    });
    const out = enforceManifest({ manifest: m, direction: 'rtl' });
    expect(out.corrections.join(' ')).toMatch(/empty band/);
  });

  it('omits panel-carried text from the manifest (no ghost layer)', () => {
    const m = manifestFromPlan({
      plan: plan(),
      preset: presetById('ig-feed-11')!,
      planner: 'wonder',
      direction: 'rtl',
      freeText: { headline: false, subtext: true },
    });
    expect(m.elements.map((e) => e.id).sort()).toEqual(['logo', 'panel', 'product-0']);
  });

  it('grows undersized text boxes to the legible minimum', () => {
    const m = manifestFromPlan({
      plan: plan({ preset: 'fb-link', width: 1200, height: 628, safe: { x: 48, y: 25, w: 1104, h: 578 }, panel: null, headline: { x: 400, y: 300, w: 222, h: 24 }, subtext: null, notes: [] }),
      preset: presetById('fb-link')!,
      planner: 'wonder',
      direction: 'rtl',
    });
    const out = enforceManifest({ manifest: m, direction: 'rtl' });
    const h = out.elements.find((e) => e.id === 'headline')!;
    expect(h.box.h).toBeGreaterThanOrEqual(Math.ceil(18 * 1.7));
    expect(h.box.w).toBeGreaterThanOrEqual(18 * 4);
    expect(out.corrections.join(' ')).toMatch(/headline.*text minimum/);
  });

  it('denormalizes template zones for the target overlay', () => {
    const zones = templateZonesPx(
      {
        logo: { box: { x: 0.78, y: 0.03, w: 0.17, h: 0.08 }, corner: 'top-right' },
        headline_zone: null,
        subtext_zone: null,
        panel_zone: null,
        product_zone: { x: 0.3, y: 0.15, w: 0.4, h: 0.55 },
        frames: [],
        background_style: 'x',
        text_align: 'center',
        direction: 'rtl',
      },
      1080,
      1080,
      false,
    );
    expect(zones['logo']).toEqual({ x: Math.round(0.78 * 1080), y: Math.round(0.03 * 1080), w: Math.round(0.17 * 1080), h: Math.round(0.08 * 1080) });
    expect(zones['product_zone']?.h).toBe(Math.round(0.55 * 1080));
  });
});
