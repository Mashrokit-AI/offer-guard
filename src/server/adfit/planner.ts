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

/** Relative luminance of a #rrggbb color (0 = black, 1 = white). */
export function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const f = (c: number): number => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function overlaps(a: PlanBox, b: PlanBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * On tall canvases (9:16) a small template product zone pastes a thumbnail
 * floating in empty space (seen on NOA). Grow the cell toward half the safe
 * height across the full safe width, centered on the zone, without covering
 * the other template zones. Returns the original cell when it is already big
 * enough or there is no room to grow.
 */
export function tallProductCell(zoneBox: PlanBox, neighbors: PlanBox[], safe: PlanBox, margin: number): PlanBox {
  if (zoneBox.h >= Math.round(safe.h * 0.45)) return zoneBox;
  const targetH = Math.round(safe.h * 0.5);
  let top = safe.y + margin;
  let bottom = safe.y + safe.h - margin;
  const cy = zoneBox.y + zoneBox.h / 2;
  for (const nb of neighbors) {
    if (nb.y + nb.h / 2 < cy) top = Math.max(top, nb.y + nb.h + margin);
    else bottom = Math.min(bottom, nb.y - margin);
  }
  const h = Math.min(targetH, bottom - top);
  if (h <= zoneBox.h) return zoneBox;
  const center = Math.min(Math.max(cy, top + h / 2), bottom - h / 2);
  return box(safe.x + margin, Math.round(center - h / 2), safe.w - margin * 2, h);
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
 * Nudge free other-text boxes out of other elements. Relative mapping does
 * not know about template zones or the relocated default logo, so a tagline
 * can land on top of the logo (seen live on the 9:16 story). Each box tries
 * moves above/below/left/right of whatever it overlaps until it is clear,
 * always staying fully inside the safe area; already-placed siblings count
 * as blockers too. The text is never dropped — worst case it keeps its
 * mapped box.
 */
export function decollideOthers(others: PlanBox[], reserved: PlanBox[], safe: PlanBox, margin: number): { boxes: PlanBox[]; moved: number } {
  const placed: PlanBox[] = [];
  let moved = 0;
  for (const orig of others) {
    const b = { ...orig };
    const blockers = [...reserved, ...placed];
    for (let iter = 0; iter < 8; iter++) {
      const hit = blockers.find((r) => overlaps(b, r));
      if (!hit) break;
      const candidates = [
        box(b.x, hit.y - b.h - margin, b.w, b.h),
        box(b.x, hit.y + hit.h + margin, b.w, b.h),
        box(hit.x - b.w - margin, b.y, b.w, b.h),
        box(hit.x + hit.w + margin, b.y, b.w, b.h),
      ];
      const good = candidates.find(
        (c) =>
          c.x >= safe.x && c.y >= safe.y && c.x + c.w <= safe.x + safe.w && c.y + c.h <= safe.y + safe.h &&
          !blockers.some((r) => overlaps(c, r)),
      );
      if (!good) break;
      b.x = good.x;
      b.y = good.y;
      moved++;
    }
    placed.push(b);
  }
  return { boxes: placed, moved };
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
  const tall = H / W >= 1.5;

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
    const zone = (n: NormBox | null, label: string): PlanBox | null => {
      if (!n) return null;
      const raw = denormalize(mirrored ? mirrorNorm(n) : n, W, H);
      const clamped = clampInto(raw, safe);
      // clampInto moves a fully-outside box into the safe area instead of
      // clipping it — reject zones that barely overlap their true position
      // (e.g. below the 9:16 bottom UI zone) so defaults take over.
      const ix = Math.max(0, Math.min(raw.x + raw.w, clamped.x + clamped.w) - Math.max(raw.x, clamped.x));
      const iy = Math.max(0, Math.min(raw.y + raw.h, clamped.y + clamped.h) - Math.max(raw.y, clamped.y));
      if ((ix * iy) / Math.max(1, raw.w * raw.h) < 0.5) {
        notes.push(`${label}: template zone outside the safe area, using default`);
        return null;
      }
      return clamped;
    };
    // Neighbor boxes for the tall product expansion (placement-time boxes).
    const neighborBoxes: PlanBox[] = [];
    {
      const push = (n: NormBox | null): void => {
        if (n) neighborBoxes.push(clampInto(denormalize(mirrored ? mirrorNorm(n) : n, W, H), safe));
      };
      if (spec.logo) push(spec.logo.box);
      push(spec.headline_zone);
      push(spec.subtext_zone);
      if (spec.panel_zone) push(spec.panel_zone.box);
    }

    if (spec.logo && input.logoCut) {
      // A dark source logo vanishes on a dark template band (the template
      // itself uses a light lockup there, which we don't have). Relocate
      // to the default corner instead of pasting invisibly.
      const zonePx = denormalize(mirrored ? mirrorNorm(spec.logo.box) : spec.logo.box, W, H);
      const onDarkBand = spec.frames.some((f) => {
        const fb = denormalize(mirrored ? mirrorNorm(f.box) : f.box, W, H);
        return overlaps(zonePx, fb) && luminance(f.color) < 0.4;
      });
      if (onDarkBand) {
        notes.push('logo: moved to default corner (dark band behind template zone)');
      } else {
        const z = zone(spec.logo.box, 'logo');
        if (z) {
          const fit = fitCentered(input.logoCut.w, input.logoCut.h, z, 2);
          logo = clampInto(fit.box, safe);
          logoScale = fit.scale;
          notes.push('logo: template zone');
        }
      }
    }
    if (spec.product_zone && input.productCuts.length > 0) {
      let z = zone(spec.product_zone, 'products');
      let expanded = false;
      if (z && tall) {
        const bigger = tallProductCell(z, neighborBoxes, safe, margin);
        if (bigger !== z) {
          z = bigger;
          expanded = true;
        }
      }
      if (z) {
        // Split the zone horizontally when there are several products.
        const slot = Math.floor(z.w / input.productCuts.length);
        input.productCuts.forEach((cut, i) => {
          const cell = box(z.x + i * slot, z.y, i === input.productCuts.length - 1 ? z.w - i * slot : slot, z.h);
          const fit = fitCentered(cut.w, cut.h, cell, 1.5);
          products.push(clampInto(fit.box, safe));
          productScales.push(fit.scale);
        });
        notes.push(expanded ? 'products: template zone expanded for 9:16 fill' : 'products: template zone');
      }
    }
    if (spec.panel_zone && source.panel) {
      panel = zone(spec.panel_zone.box, 'panel');
      if (panel) notes.push('panel: template zone');
    }
    if (headlineFree && spec.headline_zone) {
      headline = zone(spec.headline_zone, 'headline');
      if (headline) notes.push('headline: template zone');
    }
    if (subtextFree && spec.subtext_zone) {
      subtext = zone(spec.subtext_zone, 'subtext');
      if (subtext) notes.push('subtext: template zone');
    }
    // Fall through to defaults for anything the template did not place.
  }

  // --- defaults ---
  if (source.logo_bbox && input.logoCut && !logo) {
    const scale = Math.min((W * 0.28) / input.logoCut.w, (H * 0.1) / input.logoCut.h, 2);
    const w = Math.max(1, Math.round(input.logoCut.w * scale));
    const h = Math.max(1, Math.round(input.logoCut.h * scale));
    // Tall canvases get a double inset so the logo never hugs the safe edge.
    const lm = tall ? margin * 2 : margin;
    const x = source.direction === 'rtl' ? safe.x + safe.w - w - lm : safe.x + lm;
    logo = clampInto(box(x, safe.y + lm, w, h), safe);
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
  // Wide canvases (aspect > 1.3) with products: side-by-side — product on one
  // side, text column on the other. Stacking on a wide canvas shrinks the
  // product to a thumbnail and blows the text up to billboard size.
  const wide = W / H > 1.3 && input.productCuts.length > 0 && products.length === 0;
  const rtl = source.direction === 'rtl';
  // Text column geometry for the wide branch (computed once, used twice).
  const prodW = Math.round(safe.w * 0.42);
  const colW = safe.w - prodW - margin * 2;
  const colX = rtl ? safe.x + safe.w - colW : safe.x;
  const prodX = rtl ? safe.x : safe.x + safe.w - prodW;
  if (wide) {
    // Text column stays above the bottom panel when there is one.
    const colBottom = panel ? panel.y - margin : safe.y + safe.h;
    const logoOnTextSide = logo !== null && (rtl ? logo.x + logo.w > colX : logo.x < colX + colW);
    let cursor = logoOnTextSide && logo ? logo.y + logo.h + margin : safe.y + margin;
    if (headlineFree && !headline && source.headline) {
      const aspect = source.headline.bbox.h / Math.max(1, source.headline.bbox.w);
      const hh = Math.min(Math.max(30, Math.round(colW * aspect)), Math.round(H * 0.16), Math.max(30, colBottom - cursor));
      headline = clampInto(box(colX, cursor, colW, hh), safe);
      cursor = headline.y + headline.h + margin;
      notes.push('headline: default side column');
    }
    if (subtextFree && !subtext && source.subtext) {
      const aspect = source.subtext.bbox.h / Math.max(1, source.subtext.bbox.w);
      const sh = Math.min(Math.max(24, Math.round(colW * aspect)), Math.round(H * 0.1), Math.max(24, colBottom - cursor));
      subtext = clampInto(box(colX, cursor, colW, sh), safe);
      notes.push('subtext: default side column');
    }
  }
  if (!wide && headlineFree && !headline && source.headline) {
    const hw = Math.round(safe.w * 0.86);
    const aspect = source.headline.bbox.h / Math.max(1, source.headline.bbox.w);
    const hh = Math.max(30, Math.min(Math.round(hw * aspect), Math.round(H * 0.13)));
    const anchorTop = panel ? panel.y : safe.y + safe.h - margin;
    headline = clampInto(box(safe.x + (safe.w - hw) / 2, anchorTop - hh - margin * 2, hw, hh), safe);
    notes.push('headline: default above panel');
  }
  if (!wide && subtextFree && !subtext && source.subtext) {
    const sw = Math.round(safe.w * 0.8);
    const aspect = source.subtext.bbox.h / Math.max(1, source.subtext.bbox.w);
    const sh = Math.max(24, Math.min(Math.round(sw * aspect), Math.round(H * 0.09)));
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
    const minW = 80;
    const minH = 36;
    if (mapped.w >= minW && mapped.h >= minH) return mapped;
    const cx = mapped.x + mapped.w / 2;
    const cy = mapped.y + mapped.h / 2;
    return clampInto(box(cx - Math.max(mapped.w, minW) / 2, cy - Math.max(mapped.h, minH) / 2, Math.max(mapped.w, minW), Math.max(mapped.h, minH)), safe);
  });
  if (otherTexts.length > 0) notes.push(`${otherTexts.length} other text(s): relative position`);

  if (wide) {
    const top = safe.y + margin;
    const bottom = panel ? panel.y - margin : safe.y + safe.h - margin;
    // Product zone: full height on its side, products stacked vertically.
    const budget = box(prodX, top, prodW, Math.max(40, bottom - top));
    const slot = Math.floor(budget.h / input.productCuts.length);
    input.productCuts.forEach((cut, i) => {
      const cell = box(budget.x, budget.y + i * slot, budget.w, i === input.productCuts.length - 1 ? budget.h - i * slot : slot);
      const fit = fitCentered(cut.w, cut.h, cell, 1.5);
      products.push(clampInto(fit.box, safe));
      productScales.push(fit.scale);
    });
    notes.push('products: default side-by-side (wide)');
  }
  if (!wide && input.productCuts.length > 0 && products.length === 0) {
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

  // De-collide after every other box is known (products come last above).
  const reserved: PlanBox[] = [
    ...(logo ? [logo] : []),
    ...products,
    ...(headline ? [headline] : []),
    ...(subtext ? [subtext] : []),
    ...(panel ? [panel] : []),
  ];
  const { boxes: placedOthers, moved: othersMoved } = decollideOthers(otherTexts, reserved, safe, margin);
  if (othersMoved > 0) notes.push(`${othersMoved} other text(s) moved out of overlapping elements`);

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
    other_texts: placedOthers,
    product_scales: productScales,
    logo_scale: logoScale,
    notes,
  });
}
