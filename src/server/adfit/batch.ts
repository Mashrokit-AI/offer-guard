import sharp from 'sharp';
import type { Preset } from '../../shared/presets.js';
import type { LayoutPlan, PlanBox, SourceAnalysis } from '../../shared/schemas.js';
import { TraceCollector, type TraceEventInput } from '../workflow/trace.js';
import { checkManifestGeometry, type GeometryFinding } from './checks.js';
import { enforceManifest, type CompositionFamily, type ResolvedLayoutManifest } from './manifest.js';
import { freeOtherTexts } from './planner.js';
import {
  assemblePreparedSource,
  compositeProtected,
  generatePlate,
  planForSize,
  provePlaced,
  runAnalysisStage,
  runMasksStage,
  runPool,
  type OutputTemplate,
  type PipelineModels,
  type PreparedSource,
  type SourceInput,
} from './pipeline.js';
import { storeCachedLayers } from './cache.js';
import { artifactDigest, type ElementProof } from '../repair/proof.js';
import { measureTextLines, type MeasuredText } from '../repair/render.js';
import type { CostLedger } from '../models/costs.js';
import {
  checkPlatesWithSpark,
  checkTextWithSpark,
  planWithWonder,
  reviewWithWonder,
  type WonderPatch,
  type WonderSizePlan,
} from '../models/wonder.js';
import { outputChecksSchema, pendingChecks, rowStatusFromChecks, type OutputChecks } from './statuses.js';

/**
 * Protected batch engine: one source, N sizes.
 * Analyze once → SAM + Wonder plan in parallel → plates as plans land →
 * compose + stream (review pending) → plate/text checks → ONE Wonder review
 * → at most one repair pass from cached layers → final statuses.
 */

export interface BatchSize {
  preset: Preset;
  template: OutputTemplate | null;
  framePng: Buffer | null;
  sourceIndex: number;
}

export interface SizeOutcome {
  preset: Preset;
  sourceIndex: number;
  png: Buffer | null;
  /** Exact-sized background plate (kept for inspection + plate regen). */
  plate: Buffer | null;
  /** Wonder background brief for this size (reused by plate regens). */
  brief: string | null;
  logoOnBand?: boolean;
  plan: LayoutPlan | null;
  manifest: ResolvedLayoutManifest | null;
  planner: 'wonder' | 'code';
  family: CompositionFamily | null;
  proofs: Record<string, ElementProof> | null;
  digest: string | null;
  checks: OutputChecks;
  findings: GeometryFinding[];
  repaired: { beforePng: Buffer; patches: string[] } | null;
  textSizes: Record<string, number[]>;
  panelFlagged: boolean;
  trace: TraceCollector;
  modelCalls: number;
  imageCalls: number;
  latencyMs: number;
  error: string | null;
}

export interface BatchOptions {
  models: PipelineModels;
  source: PreparedSource;
  sizes: BatchSize[];
  brandName: string | null;
  jobTag: string;
  ledger?: CostLedger | null;
  /** False when the daily Wonder cap is exceeded (code planner, no review). */
  wonderAllowed?: boolean;
  concurrency?: number;
  prepareTrace?: TraceCollector;
  /** Streamed per size at compose time, before the batch review lands. */
  onPreview?: (outcome: SizeOutcome) => void | Promise<void>;
  /** Injectable text measurer (tests stub Chromium out). */
  textMeasurer?: (lines: Array<{ text: string; px: number; weight: 400 | 700 }>, lang: 'he' | 'en') => Promise<MeasuredText[]>;
  /** Skip review stages (tests / fast iteration). */
  skipReview?: boolean;
  /** Precomputed Wonder plans (runBatchSource plans parallel to SAM). */
  preplanned?: Preplanned | null;
}

export interface BatchResult {
  outcomes: SizeOutcome[];
  /** Shared batch rows (wonder plan/review...), appended into every size trace. */
  sharedRows: TraceEventInput[];
  firstPreviewMs: number | null;
  totalMs: number;
  wonderUsed: boolean;
  /** Shared model attempts (wonder plan/review + plate/text checks). */
  modelCalls: number;
}

/** Labeled review copy: long side exactly 768px + a preset badge. */
export async function labelReviewImage(png: Buffer, presetId: string): Promise<Buffer> {
  const small = await sharp(png).resize(768, 768, { fit: 'inside', withoutEnlargement: false }).png().toBuffer();
  const meta = await sharp(small).metadata();
  const W = meta.width ?? 768;
  const label = presetId.replace(/[^a-z0-9-]/gi, '').slice(0, 24);
  const badge = Buffer.from(
    `<svg width="320" height="46"><rect x="0" y="0" width="320" height="46" rx="8" fill="rgba(0,0,0,0.62)"/><text x="16" y="31" font-family="sans-serif" font-size="24" font-weight="bold" fill="#fff">${label}</text></svg>`,
  );
  return sharp(small).composite([{ input: badge, left: Math.max(0, Math.min(W - 328, 8)), top: 8 }]).png().toBuffer();
}

/**
 * Zoomed crops of every re-rendered text region (panel + free text boxes from
 * the manifest), padded and upscaled 2x so the Spark text check reads glyphs
 * instead of guessing at full-canvas scale. Never throws: a failed crop is
 * skipped and the full image remains the evidence.
 */
export async function cropTextRegions(
  png: Buffer,
  manifest: ResolvedLayoutManifest,
  outputIndex: number,
): Promise<Array<{ label: string; imageBytes: Buffer; mimeType: string }>> {
  const els = manifest.elements.filter(
    (e) => e.kind === 'panel' || e.kind === 'headline' || e.kind === 'subtext' || e.kind === 'other_text',
  ).slice(0, 6);
  const out: Array<{ label: string; imageBytes: Buffer; mimeType: string }> = [];
  for (const e of els) {
    try {
      const pad = 10;
      const left = Math.max(0, Math.round(e.box.x - pad));
      const top = Math.max(0, Math.round(e.box.y - pad));
      const width = Math.min(manifest.width - left, Math.round(e.box.w + pad * 2));
      const height = Math.min(manifest.height - top, Math.round(e.box.h + pad * 2));
      if (width < 8 || height < 8) continue;
      const crop = await sharp(png)
        .extract({ left, top, width, height })
        .resize(width * 2, height * 2, { fit: 'fill', kernel: 'lanczos3' })
        .png()
        .toBuffer();
      out.push({ label: `OUTPUT${outputIndex}:${e.id}`, imageBytes: crop, mimeType: 'image/png' });
    } catch {
      // skip failed crops; the full image still goes to the check
    }
  }
  return out;
}

/** Downscale a model input image to 768px long side (faster + cheaper calls). Falls back to the original bytes. */
export async function smallForModel(png: Buffer): Promise<Buffer> {
  try {
    return await sharp(png).resize(768, 768, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  } catch {
    return png;
  }
}

/**
 * Fail-closed plate verdict: any requested preset missing from the response
 * counts as dirty (a silent model must not pass a plate). Returns the dirty
 * preset ids plus per-size reasons for the trace.
 */
export function dirtyPlates(
  presets: string[],
  sizes: Array<{ preset: string; clean: boolean; reason: string }> | null | undefined,
): { dirty: Set<string>; reasons: string[] } {
  const byPreset = new Map((sizes ?? []).map((s) => [s.preset, s]));
  const dirty = new Set<string>();
  const reasons: string[] = [];
  for (const p of presets) {
    const v = byPreset.get(p);
    if (!v) {
      dirty.add(p);
      reasons.push(`${p}: no verdict (fail-closed)`);
    } else if (!v.clean) {
      dirty.add(p);
      reasons.push(`${p}: ${v.reason.slice(0, 160)}`);
    }
  }
  return { dirty, reasons };
}

export interface PatchApplication {
  applied: string[];
  needsPlate: boolean;
  flagged: string[];
  /** Flagged items that leave a defect unaddressed (unknown target, reverted patch). Always fail layout review. */
  unfixed: string[];
  recompose: boolean;
}

/**
 * Consolidate one size's patches before applying. Group selectors are expanded
 * to element ids against the manifest (an {element:headline} patch and a
 * {group:text} patch hit the same box — seen live as doubled -162px moves),
 * then per element: identical deltas dedupe (same defect said twice), while
 * genuinely different deltas SUM for moves and MULTIPLY for scales (each lands
 * within its own ±15% clamp otherwise, compounding past it). Other actions
 * dedupe identical. First-occurrence order is preserved; element patches keep
 * group: null so apply-time resolution matches consolidation-time resolution.
 */
export function consolidatePatches(patches: WonderPatch[], elements: Array<{ id: string; group: string | null }>): WonderPatch[] {
  const out: WonderPatch[] = [];
  const accIdx = new Map<string, number>();
  const seenDelta = new Set<string>();
  const seenOther = new Set<string>();
  const resolveIds = (p: WonderPatch): string[] => {
    const ids = new Set<string>();
    if (p.element) ids.add(p.element);
    if (p.group) {
      for (const e of elements) {
        if (e.group === p.group) ids.add(e.id);
      }
    }
    return [...ids];
  };
  for (const p of patches) {
    if (p.action !== 'move' && p.action !== 'scale') {
      const key = [p.element ?? '', p.group ?? '', p.action, p.reason].join('|');
      if (seenOther.has(key)) continue;
      seenOther.add(key);
      out.push({ ...p });
      continue;
    }
    const ids = resolveIds(p);
    if (ids.length === 0) {
      // Unknown target: keep for the honest "not in manifest" flag downstream.
      out.push({ ...p });
      continue;
    }
    for (const id of ids) {
      const delta = p.action === 'move' ? `m|${p.dx ?? 0}|${p.dy ?? 0}` : `s|${p.by ?? 1}`;
      const dupKey = `${id}|${delta}`;
      if (seenDelta.has(dupKey)) continue;
      seenDelta.add(dupKey);
      const key = `${id}|${p.action}`;
      const at = accIdx.get(key);
      if (at === undefined) {
        accIdx.set(key, out.length);
        out.push({ ...p, element: id, group: null });
      } else {
        const acc = out[at] as WonderPatch;
        if (p.action === 'move') {
          acc.dx = (acc.dx ?? 0) + (p.dx ?? 0);
          acc.dy = (acc.dy ?? 0) + (p.dy ?? 0);
        } else {
          acc.by = (acc.by ?? 1) * (p.by ?? 1);
        }
        acc.reason = `${acc.reason} + ${p.reason}`.slice(0, 240);
      }
    }
  }
  return out;
}

/**
 * Apply Wonder element-level patches to a manifest clone (pure except the
 * clone). move/scale/rerender_text recompose from cached layers; only
 * regenerate_plate needs a new image call; flag marks needs-review.
 *
 * Sequential validate-and-apply: each move/scale patch is enforced on top of
 * the validated state, then its targets are separation-checked; a patch that
 * would leave a touch is rolled back before the next patch runs. (Batching
 * then reverting restored stale box combinations past enforcement — seen
 * live as a subtext stranded across the bottle.) No final re-enforce is
 * needed: every surviving patch was enforced incrementally.
 */
export function applyPatchesToManifest(
  manifest: ResolvedLayoutManifest,
  patches: WonderPatch[],
  direction: 'rtl' | 'ltr',
): { manifest: ResolvedLayoutManifest; result: PatchApplication } {
  const clone: ResolvedLayoutManifest = JSON.parse(JSON.stringify(manifest)) as ResolvedLayoutManifest;
  const result: PatchApplication = { applied: [], needsPlate: false, flagged: [], unfixed: [], recompose: false };
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
  const targetsOf = (p: WonderPatch) =>
    clone.elements.filter((e) => (p.element && e.id === p.element) || (p.group && e.group === p.group));
  // Do-no-harm: a 1px gap reads as a collision (seen live: logo moved to 1px
  // above the panel). Same-group text stacks keep a 4px floor instead — tight
  // line gaps are the design there.
  const minGap = Math.max(8, Math.round(Math.min(clone.width, clone.height) * 0.015));
  const gapBetween = (a: PlanBox, b: PlanBox): number => {
    const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
    const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
    return Math.hypot(dx, dy);
  };
  const nestedIn = (inner: PlanBox, outer: PlanBox): boolean =>
    inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
  const touchesSomething = (el: (typeof clone.elements)[number]): string | null => {
    const hit = clone.elements.find(
      (o) => o.id !== el.id && (o.kind === 'product' || o.kind === 'logo' || o.kind === 'panel' || o.group === 'text')
        && !nestedIn(el.box, o.box) && !nestedIn(o.box, el.box)
        && gapBetween(el.box, o.box) < (el.group === 'text' && o.group === 'text' ? 4 : minGap),
    );
    return hit ? hit.id : null;
  };

  for (const p of patches) {
    if (p.action === 'flag') {
      result.flagged.push(`${p.element ?? p.group ?? p.size}: ${p.reason}`);
      continue;
    }
    if (p.action === 'regenerate_plate') {
      result.needsPlate = true;
      result.recompose = true;
      result.applied.push(`plate: regenerate (${p.reason.slice(0, 120)})`);
      continue;
    }
    if (p.action === 'rerender_text') {
      result.recompose = true;
      result.applied.push(`${p.element ?? p.group ?? 'text'}: re-render (${p.reason.slice(0, 120)})`);
      continue;
    }
    const targets = targetsOf(p);
    if (targets.length === 0) {
      const msg = `${p.element ?? p.group ?? p.size}: patch target not in manifest`;
      result.flagged.push(msg);
      result.unfixed.push(msg);
      continue;
    }
    // Snapshot every box: enforcement can move non-targets, and a rollback
    // must restore the validated pre-patch state, not a stale mix.
    const snapshot = new Map(clone.elements.map((e) => [e.id, { box: { ...e.box }, scale: e.scale, source: e.source }]));
    const correctionsLen = clone.corrections.length;
    const appliedHere: string[] = [];
    for (const t of targets) {
      if (p.action === 'move') {
        const dx = Math.round((p.dx ?? 0) * clone.width);
        const dy = Math.round((p.dy ?? 0) * clone.height);
        // Clamp patch travel to ±15% so a wild model delta can't throw an
        // element across the canvas (still recorded honestly).
        const cx = Math.max(-0.15 * clone.width, Math.min(0.15 * clone.width, dx));
        const cy = Math.max(-0.15 * clone.height, Math.min(0.15 * clone.height, dy));
        t.box = clampInto({ ...t.box, x: t.box.x + Math.round(cx), y: t.box.y + Math.round(cy) }, clone.safe);
        t.source = 'corrected';
        appliedHere.push(`${t.id}: move (${Math.round(cx)},${Math.round(cy)})`);
      } else if (p.action === 'scale') {
        const by = Math.min(2, Math.max(0.5, p.by ?? 1));
        if (by === 1) continue;
        const nw = Math.max(8, Math.round(t.box.w * by));
        const nh = Math.max(8, Math.round(t.box.h * by));
        const cx = t.box.x + t.box.w / 2;
        const cy = t.box.y + t.box.h / 2;
        const prevW = t.box.w;
        t.box = clampInto({ x: Math.round(cx - nw / 2), y: Math.round(cy - nh / 2), w: nw, h: nh }, clone.safe);
        if (t.scale !== null) t.scale = (t.scale * t.box.w) / Math.max(1, prevW);
        t.source = 'corrected';
        appliedHere.push(`${t.id}: scale x${by}`);
      }
    }
    if (appliedHere.length === 0) continue;
    enforceManifest({ manifest: clone, direction });
    const violators = targets
      .map((t) => ({ id: t.id, hit: touchesSomething(t) }))
      .filter((v) => v.hit !== null);
    if (violators.length > 0) {
      for (const e of clone.elements) {
        const s = snapshot.get(e.id);
        if (s) {
          e.box = { ...s.box };
          e.scale = s.scale;
          e.source = s.source;
        }
      }
      clone.corrections.length = correctionsLen;
      const msgs = [...new Set(violators.map((v) => `${v.id} (would touch ${v.hit}): patch reverted, needs human review`))].filter(
        (m) => !result.unfixed.includes(m),
      );
      result.flagged.push(...msgs);
      result.unfixed.push(...msgs);
      const line = `repair reverted for ${violators.map((v) => `${v.id} (would touch ${v.hit})`).join(', ')} (separation < ${minGap}px)`;
      if (!clone.corrections.includes(line)) clone.corrections.push(line);
      continue;
    }
    result.recompose = true;
    result.applied.push(...appliedHere);
  }
  return { manifest: clone, result };
}

export interface ChecksInput {
  proofs: Record<string, ElementProof> | null;
  panelFlagged: boolean;
  textSizes: Record<string, number[]>;
  /** Per-preset Spark text verdict (null when unchecked/unavailable). */
  textVerdict: { all_exact: boolean; wrong: string[] } | null;
  findings: GeometryFinding[];
  wonderFlags: string[];
  appliedPatches: string[];
  reviewRan: boolean;
  repaired: boolean;
}

/** Final three statuses from proofs + text verdict + deterministic + review state. */
export function computeChecks(input: ChecksInput): OutputChecks {
  // Protected pixels.
  let protectedPixels: OutputChecks['protected_pixels'];
  if (!input.proofs || Object.keys(input.proofs).length === 0) {
    protectedPixels = { status: 'pending', detail: 'no protected elements pasted' };
  } else {
    const bad = Object.entries(input.proofs).filter(([, pr]) => !pr.pass);
    if (bad.length > 0) {
      protectedPixels = { status: 'needs_review', detail: `core differs: ${bad.map(([id]) => id).join(', ')}` };
    } else {
      const minCov = Math.min(...Object.values(input.proofs).map((pr) => pr.coverage));
      protectedPixels = { status: 'passed', detail: `Protected core matches the resized source (${Math.round(minCov * 100)}% compared)` };
    }
  }
  // Text.
  let text: OutputChecks['text'];
  if (input.panelFlagged) {
    text = { status: 'needs_review', detail: 'panel text below the legible floor (paste skipped)' };
  } else if (Object.keys(input.textSizes).length === 0) {
    text = { status: 'passed', detail: 'source pixels only, nothing re-rendered' };
  } else if (!input.textVerdict) {
    text = { status: 'needs_review', detail: 're-rendered text could not be verified' };
  } else if (input.textVerdict.wrong.length > 0) {
    text = { status: 'needs_review', detail: `text mismatch: ${input.textVerdict.wrong.slice(0, 3).join(' | ').slice(0, 200)}` };
  } else {
    text = input.repaired
      ? { status: 'fixed', detail: 're-rendered text verified exact after repair' }
      : { status: 'passed', detail: 're-rendered text verified exact' };
  }
  // Layout review.
  let layout: OutputChecks['layout_review'];
  const fails = input.findings.filter((f) => f.severity === 'fail');
  if (fails.length > 0) {
    layout = { status: 'needs_review', detail: `deterministic: ${fails.map((f) => f.code).join(', ')}` };
  } else if (input.wonderFlags.length > 0) {
    layout = { status: 'needs_review', detail: input.wonderFlags.slice(0, 2).join(' | ').slice(0, 240) };
  } else if (input.appliedPatches.length > 0) {
    layout = { status: 'fixed', detail: `repaired: ${input.appliedPatches.slice(0, 3).join('; ').slice(0, 240)}` };
  } else if (!input.reviewRan) {
    layout = { status: 'passed', detail: 'deterministic checks passed (review skipped)' };
  } else {
    layout = { status: 'passed', detail: 'deterministic + Wonder review passed' };
  }
  return outputChecksSchema.parse({ protected_pixels: protectedPixels, text, layout_review: layout, repaired: null });
}

async function defaultMeasurer(
  lines: Array<{ text: string; px: number; weight: 400 | 700 }>,
  lang: 'he' | 'en',
): Promise<MeasuredText[]> {
  return measureTextLines(lines, lang);
}

/** Verbatim text inventory for the batched Spark text check (same order as the compositor). */
export function expectedTextsFor(textSizes: Record<string, number[]>, source: PreparedSource): string[] {
  const a = source.analysis;
  const out: string[] = [];
  if (textSizes['headline'] && a.headline) out.push(a.headline.text);
  if (textSizes['subtext'] && a.subtext) out.push(a.subtext.text);
  if (textSizes['panel'] && a.panel) out.push(...a.panel.texts);
  freeOtherTexts(a).forEach((t, i) => {
    if (textSizes[`other-${i}`]) out.push(t.text);
  });
  return [...new Set(out)];
}

export interface Preplanned {
  plans: Map<string, WonderSizePlan>;
  briefs: Map<string, string>;
  row: TraceEventInput;
  used: boolean;
  attempts: number;
}

export function skippedPreplanned(model: string, sizeCount: number, reason: string): Preplanned {
  return {
    plans: new Map(),
    briefs: new Map(),
    attempts: 0,
    row: {
      step: 'adfit_wonder_plan',
      tool_or_model: `model:${model}`,
      input_summary: `1 source x ${sizeCount} sizes`,
      output_summary: reason,
      duration_ms: 0,
      evidence_ids: ['out:plan'],
      next_state: 'adfit_generate',
      cached: false,
    },
    used: false,
  };
}

/**
 * Wonder plan branch: measure text, then one Wonder call for all sizes.
 * Element sizes come from Spark bboxes so this branch starts the moment
 * analysis lands — in parallel with SAM (see runBatchSource).
 */
export async function planBatchWithWonder(
  models: PipelineModels,
  input: { bytes: Buffer; mimeType: string; width: number; height: number },
  analysis: SourceAnalysis,
  sizes: BatchSize[],
  opts: { ledger?: CostLedger | null; textMeasurer?: BatchOptions['textMeasurer'] } = {},
): Promise<Preplanned> {
  const measureLines: Array<{ key: string; text: string; px: number; weight: 400 | 700 }> = [];
  if (analysis.headline) measureLines.push({ key: 'headline', text: analysis.headline.text, px: 60, weight: analysis.headline.bold ? 700 : 400 });
  if (analysis.subtext) measureLines.push({ key: 'subtext', text: analysis.subtext.text, px: 36, weight: analysis.subtext.bold ? 700 : 400 });
  if (analysis.panel) analysis.panel.texts.slice(0, 3).forEach((t, i) => measureLines.push({ key: `panel-${i}`, text: t, px: i === 0 ? 48 : 28, weight: i === 0 ? 700 : 400 }));
  let measuredText: Record<string, MeasuredText> = {};
  try {
    const measurer = opts.textMeasurer ?? defaultMeasurer;
    const sizesOut = measureLines.length > 0 ? await measurer(measureLines.map(({ text, px, weight }) => ({ text, px, weight })), analysis.language) : [];
    measureLines.forEach((l, i) => {
      if (sizesOut[i]) measuredText[l.key] = sizesOut[i] as MeasuredText;
    });
  } catch {
    measuredText = {}; // measurement failure never blocks planning
  }
  const elementBoxes = [
    ...analysis.products.map((p, i) => ({ id: `product-${i}`, w: p.bbox.w, h: p.bbox.h })),
    ...(analysis.logo_bbox ? [{ id: 'logo', w: analysis.logo_bbox.w, h: analysis.logo_bbox.h }] : []),
  ];
  // Downscaled plan inputs: layout needs composition, not glyphs (the 136s
  // Wonder plan call is the batch's dominant cost in time and tokens).
  const smallSource = await smallForModel(input.bytes);
  const planSizes = [];
  for (const s of sizes) {
    planSizes.push({
      preset: s.preset,
      template: s.template ? { spec: s.template.spec, imageBytes: await smallForModel(s.template.imageBytes), mimeType: s.template.mimeType } : null,
    });
  }
  const res = await planWithWonder(models.client, {
    model: models.wonderModel,
    sourceBytes: smallSource,
    sourceMime: input.mimeType,
    sourceWidth: input.width,
    sourceHeight: input.height,
    analysis,
    elementBoxes,
    measuredText,
    sizes: planSizes,
    ledger: opts.ledger ?? null,
  });
  const plans = new Map<string, WonderSizePlan>();
  const briefs = new Map<string, string>();
  if (res.ok && res.parsed) {
    for (const s of res.parsed.sizes) {
      plans.set(s.preset, s);
      briefs.set(s.preset, s.background_brief);
    }
  }
  return {
    plans,
    briefs,
    row: {
      step: 'adfit_wonder_plan',
      tool_or_model: `model:${models.wonderModel}`,
      input_summary: `1 source x ${sizes.length} sizes`,
      output_summary: res.ok ? `families: ${(res.parsed?.sizes ?? []).map((s) => `${s.preset}=${s.family}`).join(' ')}` : res.reason,
      duration_ms: res.totalLatencyMs,
      evidence_ids: ['out:plan'],
      next_state: 'adfit_generate',
      cached: false,
    },
    used: res.ok && !!res.parsed,
    attempts: res.attempts.length,
  };
}

export async function runProtectedBatch(opts: BatchOptions): Promise<BatchResult> {
  const t0 = Date.now();
  const ledger = opts.ledger ?? null;
  const concurrency = opts.concurrency ?? 4;
  const wonderAllowed = opts.wonderAllowed !== false && !(ledger?.wonderStopped() ?? false);
  const sharedRows: TraceEventInput[] = [];
  const prepRows = opts.prepareTrace?.all() ?? [];
  const newTrace = (): TraceCollector => {
    const t = new TraceCollector();
    for (const e of prepRows) {
      const { seq: _s, ...rest } = e;
      t.emit({ ...rest, cached: true });
    }
    return t;
  };

  // --- Wonder plan (one call per source, all sizes) ---
  let pre: Preplanned;
  if (opts.preplanned) {
    pre = opts.preplanned;
  } else if (wonderAllowed && !opts.skipReview) {
    pre = await planBatchWithWonder(
      opts.models,
      { bytes: opts.source.bytes, mimeType: opts.source.mimeType, width: opts.source.width, height: opts.source.height },
      opts.source.analysis,
      opts.sizes,
      { ledger, textMeasurer: opts.textMeasurer },
    );
  } else {
    pre = skippedPreplanned(opts.models.wonderModel, opts.sizes.length, opts.skipReview ? 'skipped (skipReview)' : 'skipped (daily wonder cap) — code planner');
  }
  sharedRows.push(pre.row);
  const wonderPlans = pre.plans;
  const wonderBriefs = pre.briefs;
  const wonderUsed = pre.used;
  let batchModelCalls = pre.attempts;

  // --- plan every size (wonder conversion or code fallback) ---
  interface Planned {
    size: BatchSize;
    plan: LayoutPlan;
    manifest: ResolvedLayoutManifest;
    planner: 'wonder' | 'code';
    logoOnBand?: boolean;
    brief: string | null;
  }
  const planned: Planned[] = opts.sizes.map((size) => {
    const req = { source: opts.source, preset: size.preset, mode: 'protected' as const, template: size.template, framePng: size.framePng, brandName: opts.brandName };
    const p = planForSize(req, wonderPlans.get(size.preset.id) ?? null);
    return { size, plan: p.plan, manifest: p.manifest, planner: p.planner, logoOnBand: p.logoOnBand, brief: wonderBriefs.get(size.preset.id) ?? null };
  });

  // --- plates + composites in a worker pool; stream previews immediately ---
  const plates = new Map<string, Buffer>();
  let firstPreviewMs: number | null = null;
  const outcomes: SizeOutcome[] = new Array(opts.sizes.length);
  await runPool(planned, concurrency, async (p, index) => {
    const trace = newTrace();
    const cellStart = Date.now();
    let modelCalls = 0;
    let imageCalls = 0;
    try {
      trace.emit({
        step: 'adfit_plan',
        tool_or_model: p.planner === 'wonder' ? `model:${opts.models.wonderModel}` : 'code:planLayout',
        input_summary: `${p.size.preset.id} protected${p.size.template ? ` template=${p.size.template.id}` : ' no-template'} family=${p.manifest.family}`,
        output_summary: `${p.plan.notes.join('; ')}${p.manifest.corrections.length > 0 ? ` | corrections: ${p.manifest.corrections.join('; ').slice(0, 300)}` : ''}`,
        duration_ms: 0,
        evidence_ids: ['out:plan'],
        next_state: 'adfit_generate',
        cached: false,
      });
      const req = { source: opts.source, preset: p.size.preset, mode: 'protected' as const, template: p.size.template, framePng: p.size.framePng, brandName: opts.brandName };
      const plate = await generatePlate(opts.models, req, p.plan, p.manifest, { backgroundBrief: p.brief, logoOnBand: p.logoOnBand, ledger }, trace);
      imageCalls++;
      plates.set(p.size.preset.id, plate);
      const comp = await compositeProtected(req, p.plan, plate, trace, p.manifest);
      const proofs = comp.placed.length > 0 ? await provePlaced(comp.png, comp.placed, trace) : {};
      const findings = checkManifestGeometry(p.manifest, opts.source.analysis, comp.textSizes);
      const outcome: SizeOutcome = {
        preset: p.size.preset,
        sourceIndex: p.size.sourceIndex,
        png: comp.png,
        plate,
        brief: p.brief,
        logoOnBand: p.logoOnBand,
        plan: p.plan,
        manifest: p.manifest,
        planner: p.planner,
        family: p.manifest.family,
        proofs,
        digest: artifactDigest(comp.png, `${opts.jobTag}/${p.size.preset.id}`).digest,
        checks: pendingChecks('review pending'),
        findings,
        repaired: null,
        textSizes: comp.textSizes,
        panelFlagged: comp.panelFlagged,
        trace,
        modelCalls,
        imageCalls,
        latencyMs: Date.now() - cellStart,
        error: null,
      };
      outcomes[index] = outcome;
      if (firstPreviewMs === null) firstPreviewMs = Date.now() - t0;
      await opts.onPreview?.(outcome);
    } catch (err) {
      const message = `${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
      outcomes[index] = {
        preset: p.size.preset,
        sourceIndex: p.size.sourceIndex,
        png: null,
        plate: plates.get(p.size.preset.id) ?? null,
        brief: p.brief,
        logoOnBand: p.logoOnBand,
        plan: p.plan,
        manifest: p.manifest,
        planner: p.planner,
        family: p.manifest.family,
        proofs: null,
        digest: null,
        checks: pendingChecks(message),
        findings: [],
        repaired: null,
        textSizes: {},
        panelFlagged: false,
        trace,
        modelCalls,
        imageCalls,
        latencyMs: Date.now() - cellStart,
        error: message,
      };
    }
  });
  const good = outcomes.filter((o) => o.png && !o.error);

  // --- plate check: regenerate dirty plates once, recompose from layers ---
  if (!opts.skipReview && good.length > 0) {
    const platesForCheck = good.map((o) => ({ preset: o.preset.id, imageBytes: plates.get(o.preset.id) as Buffer, mimeType: 'image/png' }));
    const res = await checkPlatesWithSpark(opts.models.client, { model: opts.models.extractModel, plates: platesForCheck, ledger });
    batchModelCalls += res.attempts.length;
    // Fail-closed only on a successful call: a failed check keeps the original
    // plates (honest, flagged in the trace) instead of blindly regenerating.
    const { dirty, reasons } = res.ok
      ? dirtyPlates(platesForCheck.map((p) => p.preset), res.parsed?.sizes)
      : { dirty: new Set<string>(), reasons: [] as string[] };
    sharedRows.push({
      step: 'adfit_plate_check',
      tool_or_model: `model:${opts.models.extractModel}`,
      input_summary: `${platesForCheck.length} plates`,
      output_summary: res.ok ? (dirty.size > 0 ? `dirty (regenerate once): ${reasons.join(' | ').slice(0, 400)}` : 'all clean') : res.reason,
      duration_ms: res.totalLatencyMs,
      evidence_ids: ['out:plate'],
      next_state: 'adfit_review',
      cached: false,
    });
    for (const o of good) {
      if (!dirty.has(o.preset.id) || !o.plan || !o.manifest) continue;
      try {
        const req = { source: opts.source, preset: o.preset, mode: 'protected' as const, template: opts.sizes.find((s) => s.preset.id === o.preset.id)?.template ?? null, framePng: opts.sizes.find((s) => s.preset.id === o.preset.id)?.framePng ?? null, brandName: opts.brandName };
        const plate = await generatePlate(opts.models, req, o.plan, o.manifest, { qaNotes: ['previous plate contained foreground content: regenerate a strictly empty background'], backgroundBrief: o.brief, logoOnBand: o.logoOnBand, forceContinuous: true, ledger }, o.trace);
        o.imageCalls++;
        plates.set(o.preset.id, plate);
        o.plate = plate;
        const comp = await compositeProtected(req, o.plan, plate, o.trace, o.manifest);
        o.png = comp.png;
        o.textSizes = comp.textSizes;
        o.panelFlagged = comp.panelFlagged;
        o.proofs = comp.placed.length > 0 ? await provePlaced(comp.png, comp.placed, o.trace) : {};
        o.findings = checkManifestGeometry(o.manifest, opts.source.analysis, comp.textSizes);
      } catch {
        // A failed regen keeps the original composite (honest, flagged below).
      }
    }
  }

  // --- targeted Spark text check (batched, only where text was re-rendered) ---
  const textVerdicts = new Map<string, { all_exact: boolean; wrong: string[] }>();
  if (!opts.skipReview && good.some((o) => o.png && Object.keys(o.textSizes).length > 0)) {
    const checkable = good.filter((o) => o.png && Object.keys(o.textSizes).length > 0);
    const forCheck = [];
    for (let i = 0; i < checkable.length; i++) {
      const o = checkable[i] as (typeof checkable)[number];
      forCheck.push({
        preset: o.preset.id,
        imageBytes: o.png as Buffer,
        mimeType: 'image/png',
        expected: expectedTextsFor(o.textSizes, opts.source),
        crops: o.manifest ? await cropTextRegions(o.png as Buffer, o.manifest, i + 1) : [],
      });
    }
    const res = await checkTextWithSpark(opts.models.client, { model: opts.models.extractModel, outputs: forCheck, ledger });
    batchModelCalls += res.attempts.length;
    for (const s of res.parsed?.sizes ?? []) textVerdicts.set(s.preset, { all_exact: s.all_exact, wrong: s.wrong });
    sharedRows.push({
      step: 'adfit_text_check',
      tool_or_model: `model:${opts.models.extractModel}`,
      input_summary: `${forCheck.length} outputs with re-rendered text`,
      output_summary: res.ok ? (res.parsed?.sizes.every((s) => s.all_exact) ? 'all exact' : `wrong: ${res.parsed?.sizes.filter((s) => !s.all_exact).map((s) => s.preset).join(',')}`) : res.reason,
      duration_ms: res.totalLatencyMs,
      evidence_ids: ['out:text'],
      next_state: 'adfit_review',
      cached: false,
    });
  }

  // --- Wonder review (one call) + at most one repair pass ---
  const patchesBySize = new Map<string, WonderPatch[]>();
  let reviewRan = false;
  if (wonderAllowed && !opts.skipReview && good.length > 0) {
    const reviewOutputs = [];
    for (const o of good) {
      if (!o.png || !o.manifest) continue;
      reviewOutputs.push({
        preset: o.preset.id,
        imageBytes: await labelReviewImage(o.png, o.preset.id),
        mimeType: 'image/png',
        manifestJson: JSON.stringify({ preset: o.manifest.preset, family: o.manifest.family, planner: o.manifest.planner, elements: o.manifest.elements, corrections: o.manifest.corrections }),
        checks: o.findings,
      });
    }
    const res = await reviewWithWonder(opts.models.client, {
      model: opts.models.wonderModel,
      sourceBytes: await smallForModel(opts.source.bytes),
      sourceMime: opts.source.mimeType,
      analysis: opts.source.analysis,
      outputs: reviewOutputs,
      ledger,
    });
    batchModelCalls += res.attempts.length;
    reviewRan = res.ok;
    if (res.ok && res.parsed) {
      for (const d of res.parsed.defects) {
        const list = patchesBySize.get(d.size) ?? [];
        list.push(d);
        patchesBySize.set(d.size, list);
      }
    }
    sharedRows.push({
      step: 'adfit_review',
      tool_or_model: `model:${opts.models.wonderModel}`,
      input_summary: `source + ${reviewOutputs.length} outputs + deterministic findings`,
      output_summary: res.ok ? (`${res.parsed?.defects.length ?? 0} defects` + ((res.parsed?.defects.length ?? 0) > 0 ? `: ${(res.parsed?.defects ?? []).map((d) => `${d.size}/${d.element ?? d.group ?? d.action}`).join(', ').slice(0, 300)}` : '')) : res.reason,
      duration_ms: res.totalLatencyMs,
      evidence_ids: ['out:review'],
      next_state: 'adfit_repair',
      cached: false,
    });

    // Repair pass: recompose from cached layers (new plate only for background defects).
    let repairedCount = 0;
    const regenChecks: Array<{ preset: string; plate: Buffer }> = [];
    for (const o of good) {
      const patches = consolidatePatches(patchesBySize.get(o.preset.id) ?? [], (o.manifest?.elements ?? []).map((e) => ({ id: e.id, group: e.group })));
      if (patches.length === 0 || !o.png || !o.manifest || !o.plan) continue;
      const { manifest: patched, result } = applyPatchesToManifest(o.manifest, patches, opts.source.analysis.direction);
      o.trace.emit({
        step: 'adfit_repair',
        tool_or_model: result.needsPlate ? `model:${opts.models.image.model}` : 'code:recompose',
        input_summary: patches.map((p) => `${p.action}:${p.element ?? p.group ?? ''}`).join(', '),
        output_summary: result.applied.length > 0 ? `applied: ${result.applied.join('; ').slice(0, 300)}` : `flagged: ${result.flagged.join('; ').slice(0, 300)}`,
        duration_ms: 0,
        evidence_ids: ['out:repair'],
        next_state: 'done',
        cached: false,
      });
      if (!result.recompose) {
        o.findings = [...o.findings, ...result.flagged.map((f) => ({ code: 'wonder_flag', severity: 'fail' as const, element: null, detail: f }))];
        continue;
      }
      try {
        const size = opts.sizes.find((s) => s.preset.id === o.preset.id);
        const req = { source: opts.source, preset: o.preset, mode: 'protected' as const, template: size?.template ?? null, framePng: size?.framePng ?? null, brandName: opts.brandName };
        let plate = plates.get(o.preset.id) as Buffer;
        if (result.needsPlate) {
          // The defect reasons ride along (a band the template style mandated
          // survives a generic regen — seen live on the NOA story), and the
          // defect overrules the template style (forceContinuous).
          const defectReasons = patches.filter((p) => p.action === 'regenerate_plate').map((p) => p.reason.slice(0, 200));
          plate = await generatePlate(opts.models, req, o.plan, patched, {
            qaNotes: ['previous background was defective, paint it clean this time', ...defectReasons],
            backgroundBrief: o.brief,
            logoOnBand: o.logoOnBand,
            forceContinuous: true,
            ledger,
          }, o.trace);
          o.imageCalls++;
          plates.set(o.preset.id, plate);
          regenChecks.push({ preset: o.preset.id, plate });
        }
        const beforePng = o.png;
        const comp = await compositeProtected(req, o.plan, plate, o.trace, patched);
        o.manifest = patched;
        o.png = comp.png;
        if (result.needsPlate) o.plate = plate;
        o.textSizes = comp.textSizes;
        o.panelFlagged = comp.panelFlagged;
        o.proofs = comp.placed.length > 0 ? await provePlaced(comp.png, comp.placed, o.trace) : {};
        o.findings = [
          ...checkManifestGeometry(patched, opts.source.analysis, comp.textSizes),
          ...result.unfixed.map((f) => ({ code: 'wonder_flag', severity: 'fail' as const, element: null, detail: f })),
        ];
        o.repaired = { beforePng, patches: result.applied };
        repairedCount++;
        // The text verdict is NOT flipped after repair: only a pixel re-read
        // could clear it, and the repair pass gets no second model round.
      } catch {
        o.findings = [...o.findings, { code: 'repair_failed', severity: 'fail' as const, element: null, detail: 'repair recompose failed, keeping original' }];
      }
    }
    // Re-check regened plates: the repair pass must not trust a regen blind
    // (seen live: a re-seamed landscape accepted as fixed). One batched Spark
    // call; a still-dirty plate fails honestly — no second regen.
    if (regenChecks.length > 0) {
      const res = await checkPlatesWithSpark(opts.models.client, {
        model: opts.models.extractModel,
        plates: regenChecks.map((r) => ({ preset: r.preset, imageBytes: r.plate, mimeType: 'image/png' })),
        ledger,
      });
      batchModelCalls += res.attempts.length;
      const { dirty, reasons } = res.ok
        ? dirtyPlates(regenChecks.map((r) => r.preset), res.parsed?.sizes)
        : { dirty: new Set<string>(), reasons: [] as string[] };
      for (const o of good) {
        if (dirty.has(o.preset.id)) {
          o.findings = [...o.findings, { code: 'plate_dirty', severity: 'fail' as const, element: null, detail: `regened plate still dirty: ${reasons.find((r) => r.startsWith(o.preset.id)) ?? 'see trace'}` }];
        }
      }
      sharedRows.push({
        step: 'adfit_plate_recheck',
        tool_or_model: `model:${opts.models.extractModel}`,
        input_summary: `${regenChecks.length} regened plates`,
        output_summary: res.ok ? (dirty.size > 0 ? `still dirty: ${reasons.join(' | ').slice(0, 300)}` : 'all clean after regen') : res.reason,
        duration_ms: res.totalLatencyMs,
        evidence_ids: ['out:plate'],
        next_state: 'done',
        cached: false,
      });
    }
    if (repairedCount > 0) {
      sharedRows.push({
        step: 'adfit_repair',
        tool_or_model: 'code:recompose',
        input_summary: `${patchesBySize.size} sizes with defects`,
        output_summary: `${repairedCount} recomposed from cached layers (before kept)`,
        duration_ms: 0,
        evidence_ids: ['out:repair'],
        next_state: 'done',
        cached: false,
      });
    }
  }

  // --- finalize checks + append shared rows into every size trace ---
  for (const o of outcomes) {
    if (o.error || !o.png || !o.manifest) continue;
    const wonderFlags = (patchesBySize.get(o.preset.id) ?? []).filter((p) => p.action === 'flag').map((p) => p.reason);
    const applied = o.repaired?.patches ?? [];
    o.checks = computeChecks({
      proofs: o.proofs,
      panelFlagged: o.panelFlagged,
      textSizes: o.textSizes,
      textVerdict: Object.keys(o.textSizes).length > 0 ? (textVerdicts.get(o.preset.id) ?? null) : { all_exact: true, wrong: [] },
      findings: o.findings,
      wonderFlags,
      appliedPatches: applied,
      reviewRan,
      repaired: o.repaired !== null,
    });
    if (o.repaired) o.checks.repaired = { before: '', patches: o.repaired.patches };
  }
  outcomes.forEach((o, i) => {
    for (const row of sharedRows) {
      // The batch call ran once per source; every size trace after the first
      // references the shared result (cached) instead of repeating the call.
      o.trace.emit({ ...row, cached: i === 0 ? row.cached : true });
    }
  });

  return { outcomes, sharedRows, firstPreviewMs, totalMs: Date.now() - t0, wonderUsed, modelCalls: batchModelCalls };
}

export interface BatchSourceOptions {
  models: PipelineModels;
  input: SourceInput;
  sizes: BatchSize[];
  brandName: string | null;
  jobTag: string;
  repoRoot?: string;
  ledger?: CostLedger | null;
  wonderAllowed?: boolean;
  concurrency?: number;
  prepareTrace?: TraceCollector;
  onPreview?: BatchOptions['onPreview'];
  textMeasurer?: BatchOptions['textMeasurer'];
  skipReview?: boolean;
}

/**
 * Full batch source run: analyze once, then SAM and the (measure → Wonder
 * plan) branch run IN PARALLEL; plates start as soon as plans exist. Returns
 * the prepared source alongside the batch result.
 */
export async function runBatchSource(
  opts: BatchSourceOptions,
): Promise<BatchResult & { source: PreparedSource; prepareTrace: TraceCollector }> {
  const t0 = Date.now();
  const trace = opts.prepareTrace ?? new TraceCollector();
  const analyzed = await runAnalysisStage(opts.models, opts.input, trace, { repoRoot: opts.repoRoot, ledger: opts.ledger });
  const wonderAllowed = opts.wonderAllowed !== false && !(opts.ledger?.wonderStopped() ?? false);
  const [seg, pre] = await Promise.all([
    runMasksStage(opts.models, opts.input, analyzed.analysis, trace, { repoRoot: opts.repoRoot, ledger: opts.ledger, digest: analyzed.digest }),
    wonderAllowed && !opts.skipReview
      ? planBatchWithWonder(opts.models, opts.input, analyzed.analysis, opts.sizes, { ledger: opts.ledger, textMeasurer: opts.textMeasurer })
      : Promise.resolve(skippedPreplanned(opts.models.wonderModel, opts.sizes.length, opts.skipReview ? 'skipped (skipReview)' : 'skipped (daily wonder cap) — code planner')),
  ]);
  if (opts.repoRoot && !analyzed.cached) {
    await storeCachedLayers(opts.repoRoot, {
      digest: analyzed.digest, width: opts.input.width, height: opts.input.height,
      analysis: analyzed.analysis, masks: seg.masks, maskLabels: seg.maskLabels,
    });
  }
  const source = await assemblePreparedSource(
    opts.input, analyzed.digest, analyzed.analysis, seg.masks, seg.maskLabels, analyzed.attempts + seg.calls,
  );
  // First-preview and total are measured from the source job start (span
  // prepare + plan), not from the compose pool start.
  let firstPreviewMs: number | null = null;
  const batch = await runProtectedBatch({
    models: opts.models,
    source,
    sizes: opts.sizes,
    brandName: opts.brandName,
    jobTag: opts.jobTag,
    ledger: opts.ledger,
    wonderAllowed: opts.wonderAllowed,
    concurrency: opts.concurrency,
    prepareTrace: trace,
    onPreview: async (o) => {
      if (firstPreviewMs === null) firstPreviewMs = Date.now() - t0;
      await opts.onPreview?.(o);
    },
    textMeasurer: opts.textMeasurer,
    skipReview: opts.skipReview,
    preplanned: pre,
  });
  return { ...batch, firstPreviewMs, totalMs: Date.now() - t0, modelCalls: batch.modelCalls + analyzed.attempts + seg.calls, source, prepareTrace: trace };
}

export { rowStatusFromChecks };
export type { OutputChecks };
