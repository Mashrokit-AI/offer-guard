import { z } from 'zod';
import { minLegiblePx } from '../repair/render.js';
import { presetSafeRect, type Preset } from '../../shared/presets.js';
import { planBoxSchema, type LayoutPlan, type NormBox, type PlanBox, type TemplateSpec } from '../../shared/schemas.js';

/**
 * Resolved layout manifest: the single object every downstream reader uses.
 * Written once per output AFTER constraint enforcement — the compositor,
 * overlays, proof and review all read these final boxes, never the raw
 * planner output or the template zones directly.
 */

export type CompositionFamily = 'landscape_split' | 'portrait_stack' | 'square_balanced';
export type PlannerUsed = 'wonder' | 'code';

export const manifestElementSchema = z.object({
  id: z.string(),
  kind: z.enum(['product', 'logo', 'panel', 'headline', 'subtext', 'other_text', 'frame', 'shadow']),
  box: planBoxSchema,
  /** Layout group: products / logo / text / offer. Text shares one alignment edge. */
  group: z.string().nullable(),
  /** Paint order, low first. */
  z: z.number().int(),
  /** Alignment edge within the group (right for RTL, left for LTR). */
  align: z.enum(['left', 'right', 'center']).nullable(),
  /** Uniform scale applied to source pixels (null for re-rendered text). */
  scale: z.number().nullable(),
  source: z.enum(['template', 'wonder', 'default', 'corrected']),
});

export type ManifestElement = z.infer<typeof manifestElementSchema>;

export const manifestSchema = z.object({
  preset: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  family: z.enum(['landscape_split', 'portrait_stack', 'square_balanced']),
  planner: z.enum(['wonder', 'code']),
  safe: planBoxSchema,
  elements: z.array(manifestElementSchema),
  /** Template target zones in output pixels (what the brand asked for) — distinct from actual placement. */
  templateZones: z.record(planBoxSchema).nullable(),
  /** Every deterministic correction applied during enforcement. */
  corrections: z.array(z.string()),
  rationale: z.string().nullable(),
});

export type ResolvedLayoutManifest = z.infer<typeof manifestSchema>;

/** Composition family from canvas aspect ratio. */
export function familyForPreset(preset: Preset): CompositionFamily {
  if (preset.width / preset.height > 1.3) return 'landscape_split';
  if (preset.height / preset.width >= 1.5) return 'portrait_stack';
  return 'square_balanced';
}

function el(
  id: string,
  kind: ManifestElement['kind'],
  box: PlanBox,
  group: string | null,
  z: number,
  align: ManifestElement['align'],
  scale: number | null,
  source: ManifestElement['source'],
): ManifestElement {
  return { id, kind, box, group, z, align, scale, source };
}

/** Denormalize template zones to output pixels (for the "template target" overlay). */
export function templateZonesPx(spec: TemplateSpec, W: number, H: number, mirrored: boolean): Record<string, PlanBox> {
  const px = (n: NormBox): PlanBox => {
    const m = mirrored ? { x: 1 - n.x - n.w, y: n.y, w: n.w, h: n.h } : n;
    return { x: Math.round(m.x * W), y: Math.round(m.y * H), w: Math.max(1, Math.round(m.w * W)), h: Math.max(1, Math.round(m.h * H)) };
  };
  const out: Record<string, PlanBox> = {};
  if (spec.logo) out['logo'] = px(spec.logo.box);
  if (spec.product_zone) out['product_zone'] = px(spec.product_zone);
  if (spec.headline_zone) out['headline_zone'] = px(spec.headline_zone);
  if (spec.subtext_zone) out['subtext_zone'] = px(spec.subtext_zone);
  if (spec.panel_zone) out['panel_zone'] = px(spec.panel_zone.box);
  spec.frames.forEach((f, i) => {
    out[`frame_${i}`] = px(f.box);
  });
  return out;
}

export interface ManifestFromPlanInput {
  plan: LayoutPlan;
  preset: Preset;
  planner: PlannerUsed;
  family?: CompositionFamily;
  direction: 'rtl' | 'ltr';
  templateZones?: Record<string, PlanBox> | null;
  rationale?: string | null;
  /** Which elements came from template zones (vs defaults). */
  fromTemplateNotes?: string[];
  /** Headline/subtext render free (false when they travel with panel pixels). */
  freeText?: { headline: boolean; subtext: boolean };
}

/** Build the manifest element list from a layout plan (pre-enforcement). */
export function manifestFromPlan(input: ManifestFromPlanInput): ResolvedLayoutManifest {
  const { plan, preset } = input;
  const textAlign = input.direction === 'rtl' ? 'right' : 'left';
  const elements: ManifestElement[] = [];
  const notes = input.fromTemplateNotes ?? plan.notes;
  const noted = (label: string): ManifestElement['source'] =>
    notes.some((n) => n.startsWith(label) && n.includes('template')) ? 'template' : 'default';

  plan.products.forEach((b, i) => {
    elements.push(el(`product-${i}`, 'product', { ...b }, 'products', 20 + i, null, plan.product_scales[i] ?? null, noted('products')));
  });
  if (plan.panel) elements.push(el('panel', 'panel', { ...plan.panel }, 'offer', 10, textAlign, null, noted('panel')));
  const freeText = input.freeText ?? { headline: true, subtext: true };
  if (plan.headline && freeText.headline) elements.push(el('headline', 'headline', { ...plan.headline }, 'text', 30, textAlign, null, noted('headline')));
  if (plan.subtext && freeText.subtext) elements.push(el('subtext', 'subtext', { ...plan.subtext }, 'text', 31, textAlign, null, noted('subtext')));
  plan.other_texts.forEach((b, i) => {
    elements.push(el(`other-${i}`, 'other_text', { ...b }, 'text', 32 + i, textAlign, null, 'default'));
  });
  if (plan.logo) elements.push(el('logo', 'logo', { ...plan.logo }, 'logo', 40, null, plan.logo_scale, noted('logo')));

  return manifestSchema.parse({
    preset: preset.id,
    width: plan.width,
    height: plan.height,
    family: input.family ?? familyForPreset(preset),
    planner: input.planner,
    safe: presetSafeRect(preset),
    elements,
    templateZones: input.templateZones ?? null,
    corrections: [],
    rationale: input.rationale ?? null,
  });
}

function overlaps(a: PlanBox, b: PlanBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function intersectArea(a: PlanBox, b: PlanBox): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return w * h;
}

/** True when inner sits (mostly) inside outer — intended nesting, not a collision. */
function nestedIn(inner: PlanBox, outer: PlanBox): boolean {
  return intersectArea(inner, outer) / Math.max(1, inner.w * inner.h) > 0.6;
}

export interface EnforceInput {
  manifest: ResolvedLayoutManifest;
  direction: 'rtl' | 'ltr';
}

/**
 * Deterministic hard-constraint enforcement. Mutates element boxes in place
 * and records every correction:
 * - margins ≥ 6% of the short side, key content inside safe areas;
 * - no unintended overlap (nesting inside the panel is intended);
 * - product ≥ ~45% of safe height on 9:16, ~70-80% of height on landscape;
 * - text group shares one alignment edge with consistent gaps;
 * - no empty horizontal band > ~25% of the canvas height.
 */
export function enforceManifest(input: EnforceInput): ResolvedLayoutManifest {
  const m = input.manifest;
  const W = m.width;
  const H = m.height;
  const corrections = [...m.corrections];
  const margin = Math.round(Math.min(W, H) * 0.06);
  const safe = m.safe;
  const tall = H / W >= 1.5;
  const wide = W / H > 1.3;

  const clampInto = (b: PlanBox, outer: PlanBox): PlanBox => {
    const w = Math.min(b.w, outer.w);
    const h = Math.min(b.h, outer.h);
    return {
      x: Math.min(Math.max(b.x, outer.x), outer.x + outer.w - w),
      y: Math.min(Math.max(b.y, outer.y), outer.y + outer.h - h),
      w,
      h,
    };
  };

  // 1. Margins + safe area for every key element.
  const marginRect: PlanBox = { x: margin, y: margin, w: W - margin * 2, h: H - margin * 2 };
  const bound: PlanBox = {
    x: Math.max(safe.x, marginRect.x),
    y: Math.max(safe.y, marginRect.y),
    w: Math.min(safe.x + safe.w, marginRect.x + marginRect.w) - Math.max(safe.x, marginRect.x),
    h: Math.min(safe.y + safe.h, marginRect.y + marginRect.h) - Math.max(safe.y, marginRect.y),
  };
  // Every later step clamps to this same bound: safe area AND the 6% margin
  // (a push/clamp to safe alone can strand a box past the margin edge).
  const BB = bound.w > 0 && bound.h > 0 ? bound : safe;
  for (const e of m.elements) {
    if (e.kind === 'frame' || e.kind === 'shadow') continue;
    const before = { ...e.box };
    e.box = clampInto(e.box, BB);
    if (e.box.x !== before.x || e.box.y !== before.y || e.box.w !== before.w || e.box.h !== before.h) {
      corrections.push(`${e.id}: clamped into safe area + 6% margin`);
      e.source = 'corrected';
    }
  }

  // 2. Product size floors: ≥45% of safe height on 9:16, ≥70% of canvas height on landscape.
  for (const e of m.elements) {
    if (e.kind !== 'product') continue;
    const targetH = tall ? Math.round(safe.h * 0.45) : wide ? Math.round(H * 0.7) : 0;
    if (targetH > 0 && e.box.h < targetH) {
      // Grow toward the target, keeping center, without covering the panel/logo/text.
      const others = m.elements.filter((o) => o !== e && o.kind !== 'shadow' && o.kind !== 'frame');
      const startH = e.box.h;
      let h = e.box.h;
      let w = e.box.w;
      const cx = e.box.x + e.box.w / 2;
      const cy = e.box.y + e.box.h / 2;
      for (let step = 0; step < 24 && h < targetH; step++) {
        const nh = Math.min(targetH, h + Math.round(targetH / 12));
        const nw = Math.round((w * nh) / Math.max(1, h));
        const cand: PlanBox = { x: Math.round(cx - nw / 2), y: Math.round(cy - nh / 2), w: nw, h: nh };
        const clamped = clampInto(cand, BB);
        if (others.some((o) => overlaps(clamped, o.box) && !nestedIn(clamped, o.box) && !nestedIn(o.box, clamped))) break;
        w = clamped.w;
        h = clamped.h;
        e.box = clamped;
      }
      if (e.box.h !== startH) {
        corrections.push(`${e.id}: grew toward ${tall ? '45% safe-height' : '70% canvas-height'} floor (${e.box.w}x${e.box.h})`);
        e.source = 'corrected';
      } else {
        corrections.push(`${e.id}: below size floor but blocked from growing — needs review`);
      }
    }
  }

  // 3. Text group: one shared alignment edge (right for RTL, left for LTR).
  const wantAlign = input.direction === 'rtl' ? 'right' : 'left';
  for (const e of m.elements) {
    if (e.group !== 'text' && e.kind !== 'panel') continue;
    if (e.align !== wantAlign) {
      e.align = wantAlign;
      corrections.push(`${e.id}: alignment edge → ${wantAlign} (${input.direction})`);
    }
  }
  // Text minimums: every free-text box must fit one line at the legible
  // floor (else Chromium throws RenderBlocker and the whole size fails —
  // seen live with a 222x24 Wonder box). Grown from center, clamped safe.
  const floor = minLegiblePx(Math.min(W, H));
  const minTextH = Math.ceil(floor * 1.7);
  const minTextW = floor * 4;
  for (const e of m.elements) {
    if (e.group !== 'text') continue;
    if (e.box.w >= minTextW && e.box.h >= minTextH) continue;
    const nw = Math.max(e.box.w, minTextW);
    const nh = Math.max(e.box.h, minTextH);
    const cx = e.box.x + e.box.w / 2;
    const cy = e.box.y + e.box.h / 2;
    e.box = clampInto({ x: Math.round(cx - nw / 2), y: Math.round(cy - nh / 2), w: nw, h: nh }, BB);
    e.source = 'corrected';
    corrections.push(`${e.id}: grew to the text minimum (${e.box.w}x${e.box.h})`);
  }
  // Consistent gaps: text boxes stacked vertically share the same edge x.
  const texts = m.elements.filter((e) => e.group === 'text').sort((a, b) => a.box.y - b.box.y);
  if (texts.length >= 2) {
    const edgeX = wantAlign === 'right' ? Math.max(...texts.map((t) => t.box.x + t.box.w)) : Math.min(...texts.map((t) => t.box.x));
    for (const t of texts) {
      const nx = wantAlign === 'right' ? edgeX - t.box.w : edgeX;
      const clamped = clampInto({ ...t.box, x: nx }, BB);
      if (clamped.x !== t.box.x) {
        t.box = clamped;
        t.source = 'corrected';
      }
    }
    corrections.push(`text group: ${texts.length} boxes share the ${wantAlign} edge`);
  }

  // 4. Logo legibility floor: a lockup below this is unreadable (seen live:
  // a 23x8 logo shrunk to nothing). Grown from center, aspect kept.
  const minLogoH = Math.max(28, Math.round(Math.min(W, H) * 0.035));
  const minProductH = Math.max(48, Math.round(H * 0.08));
  for (const e of m.elements) {
    if (e.kind !== 'logo' || e.box.h >= minLogoH) continue;
    const aspect = e.box.w / Math.max(1, e.box.h);
    const nh = minLogoH;
    const nw = Math.max(8, Math.round(nh * aspect));
    const cx = e.box.x + e.box.w / 2;
    const cy = e.box.y + e.box.h / 2;
    const prevW = e.box.w;
    e.box = clampInto({ x: Math.round(cx - nw / 2), y: Math.round(cy - nh / 2), w: nw, h: nh }, BB);
    if (e.scale !== null) e.scale = (e.scale * e.box.w) / Math.max(1, prevW);
    e.source = 'corrected';
    corrections.push(`${e.id}: grew to the logo minimum (${e.box.w}x${e.box.h})`);
  }

  // 5. Overlaps involving text or the logo: move the text/logo box clear in
  // reading order (text never shrinks; products and panels never move here).
  // No panel-nesting exemption: a free-text box inside the panel box always
  // collides with the panel's own text. Bounded + recorded; whatever persists
  // fails honestly downstream.
  const movable = (e: ManifestElement): boolean => e.group === 'text' || e.kind === 'logo';
  for (let iter = 0; iter < 8; iter++) {
    const movers = m.elements.filter(movable).sort((a, b) => a.box.y - b.box.y);
    let pushed = false;
    for (const e of movers) {
      const hit = m.elements.find((o) => o !== e && o.kind !== 'shadow' && o.kind !== 'frame' && overlaps(e.box, o.box));
      if (!hit) continue;
      // Reading order: the lower top-edge moves (ties: the smaller box moves).
      // Text/logo always yields to a product or panel — those never move here.
      let lower: ManifestElement;
      let upper: ManifestElement;
      if (hit.group === 'text' || hit.kind === 'logo') {
        lower = e.box.y !== hit.box.y ? (e.box.y > hit.box.y ? e : hit) : e.box.h <= hit.box.h ? e : hit;
        upper = lower === e ? hit : e;
      } else {
        lower = e;
        upper = hit;
      }
      const ny = upper.box.y + upper.box.h + 8;
      const cand = clampInto({ ...lower.box, y: ny }, BB);
      if (cand.y === lower.box.y || overlaps(cand, upper.box)) {
        // No room below: try above the upper box.
        const above = clampInto({ ...lower.box, y: upper.box.y - lower.box.h - 8 }, BB);
        if (above.y === lower.box.y || overlaps(above, upper.box)) continue;
        lower.box = above;
      } else {
        lower.box = cand;
      }
      lower.source = 'corrected';
      corrections.push(`${lower.id}: pushed clear of ${upper.id}`);
      pushed = true;
      break;
    }
    if (!pushed) break;
    if (iter === 7) corrections.push('text overlaps persist after pushing — needs review');
  }

  // 6. Remaining overlaps: shrink the product/logo until clear, never below
  // the legibility floors (text never shrinks).
  for (const e of m.elements) {
    if (e.kind !== 'product' && e.kind !== 'logo') continue;
    const startW = e.box.w;
    const floorH = e.kind === 'logo' ? minLogoH : minProductH;
    for (let iter = 0; iter < 12; iter++) {
      const hit = m.elements.find((o) => o !== e && o.kind !== 'shadow' && o.kind !== 'frame' && overlaps(e.box, o.box));
      if (!hit) break;
      const nw = Math.round(e.box.w * 0.92);
      const nh = Math.round(e.box.h * 0.92);
      if (nh < floorH || nw < 8) {
        corrections.push(`${e.id}: still overlaps ${hit.id} after shrinking — needs review`);
        break;
      }
      const cx = e.box.x + e.box.w / 2;
      const cy = e.box.y + e.box.h / 2;
      const prevW = e.box.w;
      e.box = clampInto({ x: Math.round(cx - nw / 2), y: Math.round(cy - nh / 2), w: nw, h: nh }, BB);
      if (e.scale !== null) e.scale = (e.scale * e.box.w) / Math.max(1, prevW);
      e.source = 'corrected';
      if (iter === 11) corrections.push(`${e.id}: still overlaps ${hit.id} after shrinking — needs review`);
    }
    if (e.box.w !== startW && !corrections.some((c) => c.startsWith(`${e.id}: still overlaps`))) {
      corrections.push(`${e.id}: shrunk to clear overlap`);
    }
  }

  // 5. Empty-band check: no horizontal band >25% of H without any element.
  const rows = 40;
  const rowH = H / rows;
  const covered = new Array(rows).fill(false);
  m.elements.forEach((e) => {
    if (e.kind === 'frame' || e.kind === 'shadow') return;
    const r1 = Math.max(0, Math.floor(e.box.y / rowH));
    const r2 = Math.min(rows - 1, Math.floor((e.box.y + e.box.h) / rowH));
    for (let r = r1; r <= r2; r++) covered[r] = true;
  });
  let gapStart = -1;
  for (let r = 0; r <= rows; r++) {
    const isGap = r < rows && !covered[r];
    if (isGap && gapStart < 0) gapStart = r;
    if (!isGap && gapStart >= 0) {
      const gapH = (r - gapStart) * rowH;
      if (gapH > H * 0.25) corrections.push(`empty band ${(gapStart * rowH / H * 100).toFixed(0)}-${(r * rowH / H * 100).toFixed(0)}% of canvas height — needs review`);
      gapStart = -1;
    }
  }

  m.corrections = corrections;
  return m;
}

/** Look up one element by id (compositor/proof/review helper). */
export function manifestElement(m: ResolvedLayoutManifest, id: string): ManifestElement | null {
  return m.elements.find((e) => e.id === id) ?? null;
}

/** Elements in paint order (z ascending). */
export function paintOrder(m: ResolvedLayoutManifest): ManifestElement[] {
  return [...m.elements].sort((a, b) => a.z - b.z);
}
