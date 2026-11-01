import { presetSafeRect, type Preset } from '../../shared/presets.js';
import {
  layoutPlanSchema,
  type LayoutPlan,
  type NormBox,
  type PlanBox,
  type SourceAnalysis,
  type TemplateSpec,
} from '../../shared/schemas.js';

export interface PlannerInput {
  preset: Preset;
  source: SourceAnalysis;
  sourceWidth: number;
  sourceHeight: number;
  /** Source cutout sizes (tight mask bbox) per product, in source pixels. */
  productCuts: Array<{ w: number; h: number }>;
  /** Source logo cutout size, in source pixels (null when no logo). */
  logoCut: { w: number; h: number } | null;
  template: { id: string; spec: TemplateSpec } | null;
}

function box(x: number, y: number, w: number, h: number): PlanBox {
  return { x: Math.round(x), y: Math.round(y), w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

function clampInto(b: PlanBox, safe: PlanBox): PlanBox {
  const x = Math.min(Math.max(b.x, safe.x), safe.x + safe.w - 1);
  const y = Math.min(Math.max(b.y, safe.y), safe.y + safe.h - 1);
  return { x, y, w: Math.max(1, Math.min(b.w, safe.x + safe.w - x)), h: Math.max(1, Math.min(b.h, safe.y + safe.h - y)) };
}

/** Fit a source rect (uniform, no stretch) centered inside a target rect. */
function fitCentered(srcW: number, srcH: number, dst: PlanBox, maxScale: number): { box: PlanBox; scale: number } {
  const scale = Math.min(dst.w / srcW, dst.h / srcH, maxScale);
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  return { box: box(dst.x + (dst.w - w) / 2, dst.y + (dst.h - h) / 2, w, h), scale };
}

function denormalize(n: NormBox, W: number, H: number): PlanBox {
  return box(n.x * W, n.y * H, n.w * W, n.h * H);
}

/** Mirror a normalized box horizontally (for direction mismatches). */
export function mirrorNorm(n: NormBox): NormBox {
  return { x: 1 - n.x - n.w, y: n.y, w: n.w, h: n.h };
}

type BoxLike = { x: number; y: number; w: number; h: number };

/** True when a text bbox travels with pasted element pixels (never re-render). */
export function travelsWithPixels(source: SourceAnalysis, bbox: BoxLike): boolean {
  if (source.panel && centerIn(bbox, source.panel.bbox)) return true;
  for (const p of source.products) if (containedIn(bbox, p.bbox)) return true;
  if (source.logo_bbox && containedIn(bbox, source.logo_bbox)) return true;
  return false;
}

/** The other_texts that need their own plan boxes (same order as the plan). */
export function freeOtherTexts(source: SourceAnalysis): SourceAnalysis['other_texts'] {
  return source.other_texts.filter((t) => !travelsWithPixels(source, t.bbox));
}

function centerIn(bbox: { x: number; y: number; w: number; h: number }, outer: { x: number; y: number; w: number; h: number }): boolean {
  const cx = bbox.x + bbox.w / 2;
  const cy = bbox.y + bbox.h / 2;
  return cx >= outer.x && cx <= outer.x + outer.w && cy >= outer.y && cy <= outer.y + outer.h;
}

/** True when the inner box sits fully inside the outer box. */
function containedIn(
  inner: { x: number; y: number; w: number; h: number },
  outer: { x: number; y: number; w: number; h: number },
): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

/**
 * Plan the per-size layout: from the brand template zones when present
 * (mirrored when the template direction differs from the source), else from
 * default rules — logo in the top corner by direction, product centered
 * within the safe area, panel at the bottom. The plan is data, shown in the
 * trace; compositing follows it exactly.
 */
export function planLayout(input: PlannerInput): LayoutPlan {
  const { preset, source } = input;
  const W = preset.width;
  const H = preset.height;
  const safe = presetSafeRect(preset);
  const notes: string[] = [];
  const margin = Math.round(Math.min(W, H) * 0.02);

  // Texts printed ON an element travel with its pasted pixels and must never
  // be re-rendered on top (it garbles). Panel: center-in (generous — the
  // panel copy is exact). Product/logo: strict containment (a real headline
  // over a photo spans wider than the product).
  const headlineFree = !!source.headline && !travelsWithPixels(source, source.headline.bbox);
  const subtextFree = !!source.subtext && !travelsWithPixels(source, source.subtext.bbox);
  const freeOthers = freeOtherTexts(source);
  const droppedOthers = source.other_texts.length - freeOthers.length;
  if (droppedOthers > 0) notes.push(`${droppedOthers} other text(s) travel with pasted pixels`);

  let logo: PlanBox | null = null;
  let logoScale: number | null = null;
  let products: PlanBox[] = [];
  let productScales: number[] = [];
  let headline: PlanBox | null = null;
  let subtext: PlanBox | null = null;
  let panel: PlanBox | null = null;
  let fromTemplate = false;
  let templateId: string | null = null;

  if (input.template) {
    fromTemplate = true;
    templateId = input.template.id;
    const spec = input.template.spec;
    const mirrored = spec.direction !== source.direction;
    if (mirrored) notes.push(`template zones mirrored (${spec.direction}→${source.direction})`);
    const zone = (n: NormBox | null): PlanBox | null => (n ? clampInto(denormalize(mirrored ? mirrorNorm(n) : n, W, H), safe) : null);

    if (spec.logo && input.logoCut) {
      const z = zone(spec.logo.box);
      if (z) {
        const fit = fitCentered(input.logoCut.w, input.logoCut.h, z, 2);
        logo = clampInto(fit.box, safe);
        logoScale = fit.scale;
        notes.push('logo: template zone');
      }
    }
    if (spec.product_zone && input.productCuts.length > 0) {
      const z = zone(spec.product_zone);
      if (z) {
        // Split the zone horizontally when there are several products.
        const slot = Math.floor(z.w / input.productCuts.length);
        input.productCuts.forEach((cut, i) => {
          const cell = box(z.x + i * slot, z.y, i === input.productCuts.length - 1 ? z.w - i * slot : slot, z.h);
          const fit = fitCentered(cut.w, cut.h, cell, 1.5);
          products.push(clampInto(fit.box, safe));
          productScales.push(fit.scale);
        });
        notes.push('products: template zone');
      }
    }
    if (spec.panel_zone && source.panel) {
      panel = zone(spec.panel_zone.box);
      if (panel) notes.push('panel: template zone');
    }
    if (headlineFree && spec.headline_zone) {
      headline = zone(spec.headline_zone);
      if (headline) notes.push('headline: template zone');
    }
    if (subtextFree && spec.subtext_zone) {
      subtext = zone(spec.subtext_zone);
      if (subtext) notes.push('subtext: template zone');
    }
    // Fall through to defaults for anything the template did not place.
  }

  // --- defaults ---
  if (source.logo_bbox && input.logoCut && !logo) {
    const scale = Math.min((W * 0.28) / input.logoCut.w, (H * 0.1) / input.logoCut.h, 2);
    const w = Math.max(1, Math.round(input.logoCut.w * scale));
    const h = Math.max(1, Math.round(input.logoCut.h * scale));
    const x = source.direction === 'rtl' ? safe.x + safe.w - w - margin : safe.x + margin;
    logo = clampInto(box(x, safe.y + margin, w, h), safe);
    logoScale = scale;
    notes.push(`logo: default top corner (${source.direction})`);
  }
  if (source.panel && !panel) {
    const pw = Math.round(safe.w * 0.9);
    const aspect = source.panel.bbox.h / Math.max(1, source.panel.bbox.w);
    let ph = Math.round(pw * aspect);
    let w = pw;
    if (ph > Math.round(H * 0.25)) {
      ph = Math.round(H * 0.25);
      w = Math.round(ph / aspect);
    }
    panel = clampInto(box(safe.x + (safe.w - w) / 2, safe.y + safe.h - ph - margin, w, ph), safe);
    notes.push('panel: default bottom');
  }
  if (headlineFree && !headline && source.headline) {
    const hw = Math.round(safe.w * 0.86);
    const aspect = source.headline.bbox.h / Math.max(1, source.headline.bbox.w);
    const hh = Math.max(24, Math.round(hw * aspect));
    const anchorTop = panel ? panel.y : safe.y + safe.h - margin;
    headline = clampInto(box(safe.x + (safe.w - hw) / 2, anchorTop - hh - margin * 2, hw, hh), safe);
    notes.push('headline: default above panel');
  }
  if (subtextFree && !subtext && source.subtext) {
    const sw = Math.round(safe.w * 0.8);
    const aspect = source.subtext.bbox.h / Math.max(1, source.subtext.bbox.w);
    const sh = Math.max(18, Math.round(sw * aspect));
    const anchorTop = headline ? headline.y : panel ? panel.y : safe.y + safe.h - margin;
    subtext = clampInto(box(safe.x + (safe.w - sw) / 2, anchorTop - sh - margin, sw, sh), safe);
    notes.push('subtext: default above headline');
  }
  // Other texts: keep their relative position (normalized source box mapped
  // onto the target), clamped into the safe area. Exact for same-aspect
  // sizes, approximate otherwise — but the text stays present and verbatim.
  const otherTexts: PlanBox[] = freeOthers.map((t) => {
    const nx = t.bbox.x / Math.max(1, input.sourceWidth);
    const ny = t.bbox.y / Math.max(1, input.sourceHeight);
    const nw = t.bbox.w / Math.max(1, input.sourceWidth);
    const nh = t.bbox.h / Math.max(1, input.sourceHeight);
    const mapped = clampInto(box(nx * W, ny * H, nw * W, nh * H), safe);
    // Minimum readable box: relative mapping can produce slivers (e.g. a
    // 10px-tall tagline on a tall size) that no font fits. Grow around the
    // center, still inside the safe area.
    const minW = 60;
    const minH = 30;
    if (mapped.w >= minW && mapped.h >= minH) return mapped;
    const cx = mapped.x + mapped.w / 2;
    const cy = mapped.y + mapped.h / 2;
    return clampInto(box(cx - Math.max(mapped.w, minW) / 2, cy - Math.max(mapped.h, minH) / 2, Math.max(mapped.w, minW), Math.max(mapped.h, minH)), safe);
  });
  if (otherTexts.length > 0) notes.push(`${otherTexts.length} other text(s): relative position`);

  if (input.productCuts.length > 0 && products.length === 0) {
    const top = logo ? logo.y + logo.h + margin : safe.y + margin;
    const bottoms = [panel?.y, headline?.y, subtext?.y].filter((v): v is number => typeof v === 'number');
    const bottom = (bottoms.length > 0 ? Math.min(...bottoms) : safe.y + safe.h) - margin;
    const budget = box(safe.x + margin, top, safe.w - margin * 2, Math.max(40, bottom - top));
    const slot = Math.floor(budget.w / input.productCuts.length);
    input.productCuts.forEach((cut, i) => {
      const cell = box(budget.x + i * slot, budget.y, i === input.productCuts.length - 1 ? budget.w - i * slot : slot, budget.h);
      const fit = fitCentered(cut.w, cut.h, cell, 1.5);
      products.push(clampInto(fit.box, safe));
      productScales.push(fit.scale);
    });
    notes.push('products: default centered in safe area');
  }

  return layoutPlanSchema.parse({
    preset: preset.id,
    width: W,
    height: H,
    from_template: fromTemplate,
    template_id: templateId,
    safe,
    logo,
    products,
    headline,
    subtext,
    panel,
    other_texts: otherTexts,
    product_scales: productScales,
    logo_scale: logoScale,
    notes,
  });
}
