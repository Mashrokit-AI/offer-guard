import type OpenAI from 'openai';
import { presetSafeRect, type Preset } from '../../shared/presets.js';
import type { LayoutPlan, PlanBox, QAverdict, SourceAnalysis, TemplateSpec } from '../../shared/schemas.js';
import { analyzeSource } from '../models/analyze.js';
import { editImages, type ImageGenConfig } from '../models/muse-image.js';
import { qaOutput } from '../models/qa.js';
import type { CostLedger } from '../models/costs.js';
import type { WonderSizePlan } from '../models/wonder.js';
import { clipMaskToPaddedBox, completeLogoMask, fillMaskHoles, maskFillInBox, segmentTargets } from '../repair/masks.js';
import { buildBoxPromptText, segment } from '../models/sam.js';
import {
  decodeRgba,
  defringeCut,
  drawContactShadow,
  exactSize,
  pasteWithFeather,
  scaleRgbaNearest,
  supportPoint,
  type RgbaImage,
} from '../repair/composite.js';
import { artifactDigest, elementProof, type ArtifactDigest, type ElementProof } from '../repair/proof.js';
import { minLegiblePx, renderRebuiltPanel, renderTextBlock, rgbFromHex, RenderBlocker, type TextLine } from '../repair/render.js';
import { maskBoundingBox, padBox, type PixelBox } from '../../shared/geometry.js';
import { freeHeadlineSubtext, freeOtherTexts, planLayout } from './planner.js';
import { panelComplexity, samplePanelColor, snapPanelRect } from './snap.js';
import { loadCachedLayers, sourceDigest, storeCachedLayers } from './cache.js';
import { enforceManifest, familyForPreset, manifestFromPlan, templateZonesPx, type ResolvedLayoutManifest } from './manifest.js';
import { TraceCollector } from '../workflow/trace.js';

export interface PipelineModels {
  client: OpenAI;
  extractModel: string;
  samModel: string;
  wonderModel: string;
  image: ImageGenConfig;
}

export type FitMode = 'protected' | 'fast';

/** One cut element: tight RGBA pixels (alpha = mask) + source offset. */
export interface ElementCut {
  id: string;
  rgba: RgbaImage;
  srcX: number;
  srcY: number;
  fallbackRect: boolean;
}

export interface PreparedSource {
  id: string;
  /** sha256 of the source bytes: the layer-cache key. */
  digest: string;
  bytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
  analysis: SourceAnalysis;
  products: ElementCut[];
  logo: ElementCut | null;
  panel: ElementCut | null;
  /** Pixel-sampled panel fill (median of the panel bbox grid). */
  panelFill: string | null;
  /** True when the panel carries photo texture/illustration (paste, don't rebuild). */
  panelComplex: boolean;
  /** Full-frame SAM masks by element id (for overlays + proof records). */
  masks: Map<string, Uint8Array>;
  maskLabels: Record<string, string>;
  modelCalls: number;
}

export interface OutputTemplate {
  id: string;
  spec: TemplateSpec;
  imageBytes: Buffer;
  mimeType: string;
}

export interface OutputRequest {
  source: PreparedSource;
  preset: Preset;
  mode: FitMode;
  template: OutputTemplate | null;
  /** Transparent PNG placed exactly, last. Must match the preset size. */
  framePng: Buffer | null;
  brandName: string | null;
}

export interface OutputOutcome {
  png: Buffer;
  plan: LayoutPlan;
  /** Resolved manifest: final boxes after enforcement (overlays/proof/review read this). */
  manifest: ResolvedLayoutManifest;
  /** Per-element proof (protected mode only; fast mode redraws pixels). */
  proofs: Record<string, ElementProof> | null;
  digest: ArtifactDigest;
  qa: QAverdict;
  retries: number;
  modelCalls: number;
  imageCalls: number;
}

function cutFromMask(rgba: RgbaImage, mask: Uint8Array, id: string): ElementCut {
  const box = maskBoundingBox(mask, rgba.width, rgba.height);
  if (!box) throw new Error(`cutFromMask: empty mask for ${id}`);
  const out = Buffer.alloc(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const si = ((box.y + y) * rgba.width + (box.x + x)) * 4;
      const di = (y * box.w + x) * 4;
      out[di] = rgba.data[si] as number;
      out[di + 1] = rgba.data[si + 1] as number;
      out[di + 2] = rgba.data[si + 2] as number;
      out[di + 3] = mask[(box.y + y) * rgba.width + (box.x + x)] ? 255 : 0;
    }
  }
  return { id, rgba: { data: out, width: box.w, height: box.h }, srcX: box.x, srcY: box.y, fallbackRect: false };
}

function cutFromRect(rgba: RgbaImage, rect: PixelBox, id: string): ElementCut {
  const x1 = Math.max(0, Math.round(rect.x));
  const y1 = Math.max(0, Math.round(rect.y));
  const x2 = Math.min(rgba.width, Math.round(rect.x + rect.w));
  const y2 = Math.min(rgba.height, Math.round(rect.y + rect.h));
  const w = Math.max(1, x2 - x1);
  const h = Math.max(1, y2 - y1);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y1 + y) * rgba.width + (x1 + x)) * 4;
      const di = (y * w + x) * 4;
      out[di] = rgba.data[si] as number;
      out[di + 1] = rgba.data[si + 1] as number;
      out[di + 2] = rgba.data[si + 2] as number;
      out[di + 3] = 255;
    }
  }
  return { id, rgba: { data: out, width: w, height: h }, srcX: x1, srcY: y1, fallbackRect: true };
}

export interface PrepareOptions {
  /** Repo root for the digest layer cache (no cache when omitted). */
  repoRoot?: string;
  /** Cost ledger (real usage from API responses). */
  ledger?: CostLedger | null;
}

/**
 * Analyze one source once per job: Spark analysis + SAM masks for every
 * product and the logo (phrase + box-prompt union). An empty SAM mask falls
 * back to the Spark bbox rect — recorded in the trace, never silent.
 * Analysis + masks are cached by source digest: a cache hit skips every
 * model call (trace cached:true).
 */
export interface SourceInput {
  id: string;
  bytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

export interface AnalysisStage {
  digest: string;
  analysis: SourceAnalysis;
  coordSystem: string;
  attempts: number;
  cached: boolean;
}

/** Stage 1: Spark analysis, once per source (layer cache aware). */
export async function runAnalysisStage(
  models: PipelineModels,
  input: SourceInput,
  trace: TraceCollector,
  opts: PrepareOptions = {},
): Promise<AnalysisStage> {
  const digest = sourceDigest(input.bytes);
  const cached = opts.repoRoot ? await loadCachedLayers(opts.repoRoot, digest, input.width, input.height) : null;
  if (cached) {
    trace.emit({
      step: 'adfit_analyze',
      tool_or_model: `model:${models.extractModel}`,
      input_summary: `source ${input.width}x${input.height} digest ${digest.slice(0, 12)}`,
      output_summary: `lang=${cached.analysis.language} products=${cached.analysis.products.length} (layer cache hit)`,
      duration_ms: 0,
      evidence_ids: ['src:analysis'],
      next_state: 'adfit_masks',
      cached: true,
    });
    return { digest, analysis: cached.analysis, coordSystem: 'cached', attempts: 0, cached: true };
  }
  const analyzed = await analyzeSource(models.client, {
    imageBytes: input.bytes,
    mimeType: input.mimeType,
    width: input.width,
    height: input.height,
    model: models.extractModel,
  });
  if (opts.ledger) {
    for (const a of analyzed.attempts) {
      opts.ledger.record(models.extractModel, { inputTokens: a.usage?.inputTokens ?? null, outputTokens: a.usage?.outputTokens ?? null }, 'analyze');
    }
  }
  const analysis = analyzed.analysis;
  trace.emit({
    step: 'adfit_analyze',
    tool_or_model: `model:${models.extractModel}`,
    input_summary: `source ${input.width}x${input.height}`,
    output_summary: `lang=${analysis.language} products=${analysis.products.length} logo=${analysis.logo_bbox ? 'yes' : 'no'} headline=${analysis.headline ? JSON.stringify(analysis.headline.text.slice(0, 40)) : 'none'} panel=${analysis.panel ? (analysis.panel.opaque ? 'opaque' : 'transparent') : 'none'} bg=${analysis.background.type} coords=${analyzed.coordSystem}`,
    duration_ms: analyzed.totalLatencyMs,
    evidence_ids: ['src:analysis'],
    next_state: 'adfit_masks',
    cached: false,
  });
  return { digest, analysis, coordSystem: analyzed.coordSystem, attempts: analyzed.attempts.length, cached: false };
}

export interface MasksStage {
  masks: Map<string, Uint8Array>;
  maskLabels: Record<string, string>;
  calls: number;
}

/** Stage 2: SAM masks for every product + the logo (runs parallel to Wonder planning). */
export async function runMasksStage(
  models: PipelineModels,
  input: SourceInput,
  analysis: SourceAnalysis,
  trace: TraceCollector,
  opts: PrepareOptions & { digest?: string } = {},
): Promise<MasksStage> {
  // Layer cache hit: masks already on disk next to the cached analysis.
  if (opts.repoRoot && opts.digest) {
    const cached = await loadCachedLayers(opts.repoRoot, opts.digest, input.width, input.height);
    if (cached) {
      trace.emit({
        step: 'adfit_masks',
        tool_or_model: `model:${models.samModel}`,
        input_summary: `digest ${opts.digest.slice(0, 12)}`,
        output_summary: `ok: ${[...cached.masks.keys()].join(',')} (layer cache hit)`,
        duration_ms: 0,
        evidence_ids: [...cached.masks.keys()].map((id) => `src:${id}`),
        next_state: 'adfit_plan',
        cached: true,
      });
      return { masks: cached.masks, maskLabels: cached.maskLabels, calls: 0 };
    }
  }
  const rgba0 = await decodeRgba(input.bytes);
  // Pad Spark's logo box: it can end mid-letter, and both the SAM box prompt
  // and the contrast grow below treat it as a hard bound (seen live as a
  // "GAL" logo with a damaged "I"). Products keep their union with the
  // unbounded phrase mask, so only the logo needs this.
  const logoBox0 = analysis.logo_bbox ? padBox({ ...analysis.logo_bbox }, 15, input.width, input.height) : null;
  const targets = [
    ...analysis.products.map((p, i) => ({ id: `product-${i}`, phrase: p.sam_phrase, box: { ...p.bbox } })),
    ...(logoBox0 ? [{ id: 'logo', phrase: 'logo', box: { ...logoBox0 } }] : []),
  ];
  const masks = new Map<string, Uint8Array>();
  const maskLabels: Record<string, string> = {};
  let calls = 0;
  if (targets.length > 0) {
    const seg = await segmentTargets(models.client, {
      imageBytes: input.bytes,
      mimeType: input.mimeType,
      width: input.width,
      height: input.height,
      model: models.samModel,
      targets,
    });
    calls = seg.calls;
    if (opts.ledger) opts.ledger.record(models.samModel, { images: seg.calls }, 'sam-masks');
    for (const [id, mask] of seg.masks) {
      masks.set(id, mask);
      maskLabels[id] = seg.labels[id] ?? '';
    }
    // Complete the logo lockup by contrast (SAM sometimes keeps only the mark
    // + half the wordmark, and Spark's box can end mid-word). Counted in the
    // trace, never silent.
    let logoGrownBy = 0;
    const logoMask = masks.get('logo');
    if (logoMask && analysis.logo_bbox) {
      const grown = completeLogoMask(rgba0, logoMask, { ...analysis.logo_bbox });
      for (let i = 0; i < grown.length; i++) {
        if (grown[i] && !logoMask[i]) logoGrownBy++;
      }
      masks.set('logo', grown);
      if (logoGrownBy > 0) maskLabels['logo'] += ` +contrast-grow(${logoGrownBy}px)`;
    }
    // Cross-coverage guard: the phrase mask is unbounded, so "bottle" can also
    // match the jar (seen live: one cut containing both products). Clip every
    // product mask to its own Spark box + margin; the phrase still completes
    // parts, but the box bounds the extent. The logo keeps its union + grow
    // (wordmark completion needs it).
    const clipNotes: string[] = [];
    analysis.products.forEach((p, i) => {
      const id = `product-${i}`;
      const mask = masks.get(id);
      if (!mask) return;
      const margin = Math.max(24, Math.round(Math.max(p.bbox.w, p.bbox.h) * 0.08));
      const { kept, dropped } = clipMaskToPaddedBox(mask, input.width, input.height, { ...p.bbox }, margin);
      if (dropped > 0.05 * (kept + dropped)) {
        clipNotes.push(`${id} clipped to its box (removed ${Math.round((dropped / Math.max(1, kept + dropped)) * 100)}% cross-coverage)`);
        maskLabels[id] += ` +box-clip(-${dropped}px)`;
      }
    });
    // Hole-fill + sparse-mask retry (products only — logos keep counters).
    // A sparse mask pastes with plate showing through as mottling (seen live
    // on the VELA jar). Below the fill floor, one box-only retry usually
    // returns the solid silhouette the phrase match missed.
    const FILL_FLOOR = 0.7;
    const holeNotes: string[] = [];
    for (let i = 0; i < analysis.products.length; i++) {
      const id = `product-${i}`;
      const p = analysis.products[i] as SourceAnalysis['products'][number];
      const mask = masks.get(id);
      if (!mask) continue;
      const filled = fillMaskHoles(mask, input.width, input.height);
      if (filled > 100) holeNotes.push(`${id} holes filled (+${filled}px)`);
      let fill = maskFillInBox(mask, input.width, input.height);
      if (fill < FILL_FLOOR && p.bbox.w > 0 && p.bbox.h > 0) {
        try {
          const retry = await segment(models.client, {
            imageBytes: input.bytes,
            mimeType: input.mimeType,
            width: input.width,
            height: input.height,
            model: models.samModel,
            inputText: buildBoxPromptText(p.bbox, input.width, input.height),
          });
          calls++;
          if (opts.ledger) opts.ledger.record(models.samModel, { images: 1 }, 'sam-mask-retry');
          const retryMask = retry.mask;
          fillMaskHoles(retryMask, input.width, input.height);
          const retryFill = maskFillInBox(retryMask, input.width, input.height);
          if (retryFill > fill && maskBoundingBox(retryMask, input.width, input.height)) {
            masks.set(id, retryMask);
            maskLabels[id] = `box-only retry (fill ${fill.toFixed(2)} → ${retryFill.toFixed(2)})`;
            holeNotes.push(`${id} sparse mask retried box-only (fill ${fill.toFixed(2)} → ${retryFill.toFixed(2)})`);
            fill = retryFill;
          } else {
            holeNotes.push(`${id} mask sparse (fill ${fill.toFixed(2)}) even after retry — kept best`);
          }
        } catch {
          holeNotes.push(`${id} mask sparse (fill ${fill.toFixed(2)}), retry failed — kept original`);
        }
      }
    }
    // Coverage validation: every analyzed product instance must be found, and
    // no product mask may substantially cover another product's box.
    const foundProducts = analysis.products.filter((_, i) => {
      const m = masks.get(`product-${i}`);
      return m && maskBoundingBox(m, input.width, input.height);
    }).length;
    const crossNotes: string[] = [];
    analysis.products.forEach((p, i) => {
      const mask = masks.get(`product-${i}`);
      if (!mask) return;
      analysis.products.forEach((q, j) => {
        if (i === j) return;
        let hit = 0;
        const total = Math.max(1, q.bbox.w * q.bbox.h);
        for (let y = q.bbox.y; y < q.bbox.y + q.bbox.h; y++) {
          for (let x = q.bbox.x; x < q.bbox.x + q.bbox.w; x++) {
            if (x < 0 || y < 0 || x >= input.width || y >= input.height) continue;
            if (mask[y * input.width + x]) hit++;
          }
        }
        if (hit > 0.25 * total) crossNotes.push(`product-${i} still covers ${Math.round((hit / total) * 100)}% of product-${j}'s box`);
      });
    });
    const coverage = `coverage: products ${foundProducts}/${analysis.products.length}${clipNotes.length > 0 ? `; ${clipNotes.join('; ')}` : ''}${holeNotes.length > 0 ? `; ${holeNotes.join('; ')}` : ''}${crossNotes.length > 0 ? `; CROSS: ${crossNotes.join('; ')}` : ''}`;
    trace.emit({
      step: 'adfit_masks',
      tool_or_model: `model:${models.samModel}`,
      input_summary: targets.map((t) => `${t.id}[${t.phrase}]`).join(' '),
      output_summary: seg.blockers.length > 0
        ? `blockers: ${seg.blockers.join(',')} (bbox fallback) ${coverage}`
        : `ok: ${[...masks.keys()].join(',')} ${coverage}`,
      duration_ms: seg.latencyMs,
      evidence_ids: targets.map((t) => `src:${t.id}`),
      next_state: 'adfit_plan',
      cached: false,
    });
  }
  return { masks, maskLabels, calls };
}

/** Stage 3: cut products/logo/panel from masks + sample the panel (no models). */
export async function assemblePreparedSource(
  input: SourceInput,
  digest: string,
  analysis: SourceAnalysis,
  masks: Map<string, Uint8Array>,
  maskLabels: Record<string, string>,
  modelCalls: number,
): Promise<PreparedSource> {
  const rgba = await decodeRgba(input.bytes);
  const logoBox = analysis.logo_bbox ? padBox({ ...analysis.logo_bbox }, 15, input.width, input.height) : null;
  const cutOrRect = (id: string, sparkBox: PixelBox | null): ElementCut | null => {
    const mask = masks.get(id);
    if (mask && maskBoundingBox(mask, rgba.width, rgba.height)) return cutFromMask(rgba, mask, id);
    if (sparkBox) return cutFromRect(rgba, sparkBox, id);
    return null;
  };
  const products: ElementCut[] = [];
  analysis.products.forEach((p, i) => {
    const cut = cutOrRect(`product-${i}`, { ...p.bbox });
    if (cut) products.push(cut);
  });
  const logo = logoBox ? cutOrRect('logo', { ...logoBox }) : null;
  // The opaque panel travels as pixels; snap Spark's box out to the panel's
  // visual edges first so padding (and descenders) are never clipped.
  const panel = analysis.panel?.opaque
    ? cutFromRect(rgba, snapPanelRect(rgba, { ...analysis.panel.bbox }), 'panel')
    : null;
  // Pixel-sampled fill + complexity for the rebuild-or-paste decision.
  let panelFill: string | null = null;
  let panelComplex = false;
  if (analysis.panel && panel) {
    const box = { x: panel.srcX, y: panel.srcY, w: panel.rgba.width, h: panel.rgba.height };
    panelFill = samplePanelColor(rgba, box);
    panelComplex = panelComplexity(rgba, box).complex;
  }
  return {
    id: input.id,
    digest,
    bytes: input.bytes,
    mimeType: input.mimeType,
    width: input.width,
    height: input.height,
    analysis,
    products,
    logo,
    panel,
    panelFill,
    panelComplex,
    masks,
    maskLabels,
    modelCalls,
  };
}

/**
 * Analyze one source once per job: Spark analysis + SAM masks for every
 * product and the logo (phrase + box-prompt union). An empty SAM mask falls
 * back to the Spark bbox rect — recorded in the trace, never silent.
 * Analysis + masks are cached by source digest: a cache hit skips every
 * model call (trace cached:true).
 */
export async function prepareSource(
  models: PipelineModels,
  input: { id: string; bytes: Buffer; mimeType: string; width: number; height: number },
  trace: TraceCollector,
  opts: PrepareOptions = {},
): Promise<PreparedSource> {
  const analyzed = await runAnalysisStage(models, input, trace, opts);
  const seg = await runMasksStage(models, input, analyzed.analysis, trace, { ...opts, digest: analyzed.digest });
  if (opts.repoRoot && !analyzed.cached) {
    await storeCachedLayers(opts.repoRoot, {
      digest: analyzed.digest, width: input.width, height: input.height,
      analysis: analyzed.analysis, masks: seg.masks, maskLabels: seg.maskLabels,
    });
  }
  return assemblePreparedSource(input, analyzed.digest, analyzed.analysis, seg.masks, seg.maskLabels, analyzed.attempts + seg.calls);
}

// Text renders share one Chromium (concurrent pages); no serialization needed.

function verbatimList(a: SourceAnalysis): string[] {
  const out: string[] = [];
  if (a.headline) out.push(a.headline.text);
  if (a.subtext) out.push(a.subtext.text);
  if (a.panel) out.push(...a.panel.texts);
  for (const t of a.other_texts) out.push(t.text);
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))];
}

export function buildFastPrompt(req: OutputRequest, plan: LayoutPlan, qaNotes: string[]): string {
  const a = req.source.analysis;
  const s = plan.safe;
  const lines = [
    `Recompose this ad creative for ${plan.width}x${plan.height} (${req.preset.label}).`,
    `Keep the brand style${req.brandName ? ` of ${req.brandName}` : ''}, the product, the logo, and every printed text EXACTLY (letter by letter, same script and language: ${a.language}).`,
    ...verbatimList(a).map((t) => `Must appear verbatim: ${JSON.stringify(t)}`),
    `Safe-area pixel lines: left x=${s.x}, right x=${s.x + s.w}, top y=${s.y}, bottom y=${s.y + s.h}. Keep every text, the logo and the product fully inside this rectangle — nothing important may touch or cross these lines, even if a reference image shows content near an edge. Do not crop the logo or product; do not invent any new text.`,
  ];
  if (req.template) lines.push('Follow the layout of the second reference image (the brand template for this size): same zone arrangement, same panel position, same background style.');
  else lines.push(`Layout: ${plan.notes.join('; ')}.`);
  for (const n of qaNotes) lines.push(`Fix from QA review: ${n}`);
  return lines.join('\n');
}

export interface PlatePromptExtra {
  /** Resolved manifest: element regions the plate must keep clean/low-detail. */
  manifest?: ResolvedLayoutManifest | null;
  /** False when the logo relocated off the template band (no footer band then). */
  logoOnBand?: boolean;
  /** Wonder's one-line background brief for this size. */
  backgroundBrief?: string | null;
  /** True on regen-after-defect: Wonder overrules the template style; force one continuous field. */
  forceContinuous?: boolean;
}

export function buildPlatePrompt(req: OutputRequest, plan: LayoutPlan, qaNotes: string[], extra: PlatePromptExtra = {}): string {
  const a = req.source.analysis;
  const lines = [
    `Clean advertising background plate, ${plan.width}x${plan.height} aspect. Use the reference image ONLY for background style, colors and texture: REMOVE the product, the logo, and EVERY text, letter, number and wordmark — inpaint clean seamless background where they were. The output must be an empty background only: NO product, NO logo, NO text, NO letters, NO numbers, NO fake UI, NO inset border or frame edges, NO product shadows (shadows are drawn in code later).`,
    `Style to match: ${a.background.description} (type: ${a.background.type}; colors: ${a.background.colors.join(', ') || 'match the reference'}). One continuous field: if the reference background is split (flat-color region plus photo), blend it into a single seamless background with NO straight seams, horizon splits, bands, or blocks.`,
  ];
  if (extra.backgroundBrief) lines.push(`Art direction: ${extra.backgroundBrief}`);
  if (extra.forceContinuous) {
    // Regen after a background defect (seen live: a template-mandated header
    // band surviving regen, and a re-seamed landscape): the defect overrules
    // the brand style — paint one continuous background, period.
    lines.push('CONTINUOUS BACKGROUND ONLY: NO bands, headers, footers, blocks, panels, or straight seams/splits of any kind — even if the brand style or the reference suggests them. The background continues edge to edge as one field.');
  } else if (req.template) {
    const style = req.template.spec.background_style;
    // A footer band with no logo on it renders as an empty dark block (seen on
    // the GALI story): when the logo relocated, ask for continuous background.
    const mentionsBand = /footer|band|bottom|header/i.test(style);
    if (mentionsBand && extra.logoOnBand === false) {
      lines.push('One continuous seamless background across the whole canvas: NO footer band, NO dark block, NO split regions — the background continues edge to edge.');
    } else {
      lines.push(`Brand layout style for this size: ${style}.`);
    }
  }
  const guide = layoutGuideForPlate(extra.manifest ?? null);
  if (guide) lines.push(`Layout guide — keep these regions clean and low-detail (percent of canvas): ${guide}.`);
  lines.push('One seamless background across the whole canvas: no vignette traps; leave clean space where the product and text will be placed by code.');
  for (const n of qaNotes) lines.push(`Fix from QA review: ${n}`);
  return lines.join('\n');
}

/** Element regions as canvas percents, so the plate keeps them clean. */
export function layoutGuideForPlate(manifest: ResolvedLayoutManifest | null): string | null {
  if (!manifest) return null;
  const parts: string[] = [];
  for (const e of manifest.elements) {
    if (e.kind !== 'product' && e.group !== 'text' && e.kind !== 'panel') continue;
    const x = Math.round((e.box.x / manifest.width) * 100);
    const y = Math.round((e.box.y / manifest.height) * 100);
    const w = Math.round((e.box.w / manifest.width) * 100);
    const h = Math.round((e.box.h / manifest.height) * 100);
    parts.push(`${e.id} x${x} y${y} w${w} h${h}`);
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

async function sharpenPng(png: Buffer): Promise<Buffer> {
  return png;
}

async function rgbaToPng(rgba: RgbaImage): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp(rgba.data, { raw: { width: rgba.width, height: rgba.height, channels: 4 } }).png().toBuffer();
}

interface PlacedElement {
  id: string;
  cut: ElementCut;
  left: number;
  top: number;
  scale: number;
  featherPx: number;
}

/**
 * Stamp a transparent brand frame PNG over the whole canvas, last. The frame
 * must match the output size exactly; anything else is skipped with an
 * honest note (a stretched frame would misplace brand bands). Returns the
 * trace note.
 */
export async function applyFrameOverlay(canvas: RgbaImage, framePng: Buffer, width: number, height: number): Promise<string> {
  const sharp = (await import('sharp')).default;
  const meta = await sharp(framePng).metadata();
  if (meta.width !== width || meta.height !== height) {
    return `frame overlay skipped (is ${meta.width}x${meta.height}, need ${width}x${height})`;
  }
  const frame = await decodeRgba(framePng);
  for (let i = 0; i < frame.data.length; i += 4) {
    const alpha = (frame.data[i + 3] as number) / 255;
    if (alpha <= 0) continue;
    for (let c = 0; c < 3; c++) {
      canvas.data[i + c] = Math.round((frame.data[i + c] as number) * alpha + (canvas.data[i + c] as number) * (1 - alpha));
    }
  }
  return 'frame overlay applied';
}

export interface CompositeResult {
  png: Buffer;
  placed: PlacedElement[];
  textSizes: Record<string, number[]>;
  notes: string[];
  panelRebuilt: boolean;
  panelFlagged: boolean;
}

/** Stamp a same-size-or-smaller RGBA layer onto the canvas with its own alpha. */
function stampLayer(canvas: RgbaImage, layer: RgbaImage, dx: number, dy: number): void {
  for (let y = 0; y < Math.min(layer.height, canvas.height - dy); y++) {
    for (let x = 0; x < Math.min(layer.width, canvas.width - dx); x++) {
      const si = (y * layer.width + x) * 4;
      const alpha = (layer.data[si + 3] as number) / 255;
      if (alpha <= 0) continue;
      const di = ((dy + y) * canvas.width + (dx + x)) * 4;
      for (let c = 0; c < 3; c++) {
        canvas.data[di + c] = Math.round((layer.data[si + c] as number) * alpha + (canvas.data[di + c] as number) * (1 - alpha));
      }
    }
  }
}

/**
 * Protected-mode composite: plate + protected pixels (products, logo) +
 * rebuilt/pasted panel + re-rendered text + frame. Boxes come from the
 * resolved manifest when provided (the one object overlays/proof/review read).
 */
export async function compositeProtected(
  req: OutputRequest,
  plan: LayoutPlan,
  platePng: Buffer,
  trace: TraceCollector,
  manifest: ResolvedLayoutManifest | null = null,
): Promise<CompositeResult> {
  const notes: string[] = [];
  const placed: PlacedElement[] = [];
  const textSizes: Record<string, number[]> = {};
  const start = Date.now();
  const canvas = await decodeRgba(await exactSize(platePng, plan.width, plan.height));
  const a = req.source.analysis;
  const mBox = (id: string): PlanBox | null => manifest?.elements.find((e) => e.id === id)?.box ?? null;

  // Products: defringed, contact shadow under the support point, feathered paste.
  req.source.products.forEach((cut, i) => {
    const dst = mBox(cut.id) ?? plan.products[i];
    const mScale = manifest?.elements.find((e) => e.id === cut.id)?.scale ?? null;
    const scale = mScale ?? plan.product_scales[i];
    if (!dst || scale === undefined || scale === null) return;
    const scaled = defringeCut(scaleRgbaNearest(cut.rgba, scale), 2);
    // Center the scaled cut in its box (exact for fitCentered plans).
    const left = Math.round(dst.x + (dst.w - scaled.width) / 2);
    const top = Math.round(dst.y + (dst.h - scaled.height) / 2);
    const sp = supportPoint(scaled, left, top);
    // Floating products (no opaque pixel near the cut bottom third) get no
    // shadow; the plate was asked for no product shadows either.
    const floating = sp === null || sp.y < top + scaled.height * 0.9;
    if (sp && drawContactShadow(canvas, sp, { floating })) notes.push(`${cut.id}: contact shadow at support y=${sp.y}`);
    pasteWithFeather(canvas, scaled, left, top, 2);
    placed.push({ id: cut.id, cut, left, top, scale, featherPx: 2 });
  });
  if (req.source.logo && (mBox('logo') ?? plan.logo) && (manifest?.elements.find((e) => e.id === 'logo')?.scale ?? plan.logo_scale) !== null) {
    const dst = (mBox('logo') ?? plan.logo) as PlanBox;
    const scale = (manifest?.elements.find((e) => e.id === 'logo')?.scale ?? plan.logo_scale) as number;
    const scaled = defringeCut(scaleRgbaNearest(req.source.logo.rgba, scale), 2);
    const left = Math.round(dst.x + (dst.w - scaled.width) / 2);
    const top = Math.round(dst.y + (dst.h - scaled.height) / 2);
    pasteWithFeather(canvas, scaled, left, top, 2);
    placed.push({ id: 'logo', cut: req.source.logo, left, top, scale, featherPx: 2 });
  }

  // Panel: rebuilt in code when simple, else pasted with a legibility floor.
  let panelRebuilt = false;
  let panelFlagged = false;
  const panelDst = mBox('panel') ?? plan.panel;
  if (req.source.panel && panelDst && a.panel) {
    const shape = req.template?.spec.panel_zone?.shape ?? 'rounded_rect';
    const simple = a.panel.opaque && !req.source.panelComplex && a.panel.texts.length > 0;
    if (simple) {
      try {
        const sampled = req.source.panelFill ?? a.panel.bg_color;
        const fill = rgbFromHex(sampled);
        const textColor = rgbFromHex(a.panel.text_color);
        const radius = shape === 'pill' ? Math.floor(panelDst.h / 2) : shape === 'rect' ? 0 : Math.round(Math.min(panelDst.w, panelDst.h) * 0.08);
        const align = req.template?.spec.text_align ?? 'center';
        const rendered = await renderRebuiltPanel({
          width: panelDst.w,
          height: panelDst.h,
          radius,
          fill,
          lines: a.panel.texts.map((t, i) => ({ text: t, weight: i === 0 ? 700 : 400, color: textColor })),
          lang: a.language,
          align,
        });
        textSizes['panel'] = rendered.sizes;
        stampLayer(canvas, await decodeRgba(rendered.png), panelDst.x, panelDst.y);
        panelRebuilt = true;
        notes.push(`panel rebuilt in code (${shape}, fill ${sampled}${req.source.panelFill ? ' sampled' : ' spec'})`);
      } catch (err) {
        if (!(err instanceof RenderBlocker)) throw err;
        notes.push(`panel rebuild refused (${err.message.slice(0, 120)}) — paste fallback`);
        panelFlagged = await pastePanelFallback(req, panelDst, canvas, placed, notes);
      }
    } else {
      panelFlagged = await pastePanelFallback(req, panelDst, canvas, placed, notes);
    }
  }

  // Free text on the background: re-rendered verbatim in Chromium.
  const align = req.template?.spec.text_align ?? 'center';
  const nestedInPanel = (dst: PlanBox): boolean =>
    !!panelDst && dst.x >= panelDst.x && dst.y >= panelDst.y && dst.x + dst.w <= panelDst.x + panelDst.w && dst.y + dst.h <= panelDst.y + panelDst.h;
  const renderOne = async (text: { text: string; bold: boolean; color: string } | null, dst: LayoutPlan['headline'], key: string): Promise<void> => {
    if (!text || !dst) return;
    if (nestedInPanel(dst)) {
      // Last defense (enforcement should have pushed this out): never stamp
      // free text over the panel's own text — skip it loudly instead.
      notes.push(`${key} SKIPPED: box nested in the panel (would collide with panel text)`);
      return;
    }
    const line: TextLine = { text: text.text, px: Math.max(24, Math.round(dst.h * 0.62)), weight: text.bold ? 700 : 400, color: rgbFromHex(text.color) };
    const rendered = await renderTextBlock({ width: dst.w, height: dst.h, lines: [line], lang: a.language, align });
    textSizes[key] = rendered.sizes;
    stampLayer(canvas, await decodeRgba(rendered.png), dst.x, dst.y);
  };
  const free = freeHeadlineSubtext(a, plan);
  const headlineDst = mBox('headline') ?? plan.headline;
  const subtextDst = mBox('subtext') ?? plan.subtext;
  if (headlineDst && free.headline && a.headline) await renderOne(a.headline, headlineDst, 'headline');
  if (subtextDst && free.subtext && a.subtext) await renderOne(a.subtext, subtextDst, 'subtext');
  const freeOthers = freeOtherTexts(a);
  for (let i = 0; i < freeOthers.length; i++) {
    const dst = mBox(`other-${i}`) ?? plan.other_texts[i];
    const text = freeOthers[i];
    if (dst && text) await renderOne(text, dst, `other-${i}`);
  }

  // Frame overlay, last. Must match the preset exactly or it is skipped.
  if (req.framePng) {
    notes.push(await applyFrameOverlay(canvas, req.framePng, plan.width, plan.height));
  }

  const png = await sharpenPng(await rgbaToPng(canvas));
  trace.emit({
    step: 'adfit_composite',
    tool_or_model: 'code:composite+chromium',
    input_summary: `plate + ${placed.map((p) => `${p.id}@${p.scale.toFixed(3)}x`).join(' ') || 'no pasted elements'}${Object.keys(textSizes).length > 0 ? ` + text(${Object.keys(textSizes).join(',')})` : ''}${panelRebuilt ? ' panel:rebuilt' : ''}`,
    output_summary: `${plan.width}x${plan.height} ${notes.join('; ') || 'ok'}`,
    duration_ms: Date.now() - start,
    evidence_ids: placed.map((p) => `out:${p.id}`),
    next_state: 'adfit_proof',
    cached: false,
  });
  return { png, placed, textSizes, notes, panelRebuilt, panelFlagged };
}

/**
 * Paste fallback for panels too complex to rebuild: never below the scale
 * where the text stays legible, otherwise the paste is SKIPPED and flagged
 * (returns true) instead of rendering unreadable text.
 */
async function pastePanelFallback(
  req: OutputRequest,
  panelDst: PlanBox,
  canvas: RgbaImage,
  placed: PlacedElement[],
  notes: string[],
): Promise<boolean> {
  const cut = req.source.panel;
  if (!cut) return false;
  const scale = Math.min(panelDst.w / cut.rgba.width, panelDst.h / cut.rgba.height);
  // Biggest source line ≈ 35% of the panel height; pasted text must clear the floor.
  const floor = minLegiblePx(Math.min(panelDst.w, panelDst.h));
  const estTextH = cut.rgba.height * 0.35 * scale;
  if (estTextH < floor) {
    notes.push(`panel paste SKIPPED at ${scale.toFixed(2)}x (text ~${Math.round(estTextH)}px < ${floor}px floor) — needs review`);
    return true;
  }
  const scaled = scaleRgbaNearest(cut.rgba, scale);
  const left = Math.round(panelDst.x + (panelDst.w - scaled.width) / 2);
  const top = Math.round(panelDst.y + (panelDst.h - scaled.height) / 2);
  pasteWithFeather(canvas, scaled, left, top, 0);
  placed.push({ id: 'panel', cut, left, top, scale, featherPx: 0 });
  notes.push(`panel pasted (complex) at ${scale.toFixed(2)}x`);
  return false;
}

export interface PlannedSize {
  plan: LayoutPlan;
  manifest: ResolvedLayoutManifest;
  planner: 'wonder' | 'code';
  /** False when the logo relocated off a template band (plate: no footer). */
  logoOnBand?: boolean;
}

function denorm(n: { x: number; y: number; w: number; h: number }, W: number, H: number): PlanBox {
  const x = Math.min(Math.max(0, n.x), 1);
  const y = Math.min(Math.max(0, n.y), 1);
  const w = Math.min(Math.max(0, n.w), 1 - x);
  const h = Math.min(Math.max(0, n.h), 1 - y);
  return { x: Math.round(x * W), y: Math.round(y * H), w: Math.max(1, Math.round(w * W)), h: Math.max(1, Math.round(h * H)) };
}

function intersectArea(a: PlanBox, b: PlanBox): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return w * h;
}

/**
 * Convert one Wonder size plan to a LayoutPlan. Template zones BIND: every
 * Wonder box is intersected with its template zone, and a Wonder box that
 * mostly misses its zone is replaced by the zone. Returns null when the
 * Wonder plan is unusable for this size (caller falls back to the code
 * planner and records it).
 */
export function wonderToLayoutPlan(
  wonder: WonderSizePlan,
  req: OutputRequest,
): { plan: LayoutPlan; note: string } | null {
  const W = req.preset.width;
  const H = req.preset.height;
  const n = req.source.products.length;
  if (wonder.boxes.products.length !== n) {
    return null; // every product instance must be placed, never dropped
  }
  const finite = (b: { x: number; y: number; w: number; h: number }): boolean =>
    [b.x, b.y, b.w, b.h].every((v) => Number.isFinite(v)) && b.w > 0.005 && b.h > 0.005;
  const allBoxes = [...wonder.boxes.products, wonder.boxes.logo, wonder.boxes.panel, wonder.boxes.headline, wonder.boxes.subtext, ...wonder.boxes.others];
  if (allBoxes.some((b) => b !== null && !finite(b))) return null;

  const spec = req.template?.spec ?? null;
  const mirrored = spec ? spec.direction !== req.source.analysis.direction : false;
  const zones = spec ? templateZonesPx(spec, W, H, mirrored) : {};
  // Bind one Wonder box to its template zone (null zone = no binding).
  const bind = (box: PlanBox, zoneKey: string | null): { box: PlanBox; bound: boolean } => {
    if (!zoneKey || !zones[zoneKey]) return { box, bound: false };
    const zone = zones[zoneKey] as PlanBox;
    const frac = intersectArea(box, zone) / Math.max(1, box.w * box.h);
    if (frac >= 0.5) {
      const ix1 = Math.max(box.x, zone.x);
      const iy1 = Math.max(box.y, zone.y);
      const ix2 = Math.min(box.x + box.w, zone.x + zone.w);
      const iy2 = Math.min(box.y + box.h, zone.y + zone.h);
      return { box: { x: ix1, y: iy1, w: Math.max(1, ix2 - ix1), h: Math.max(1, iy2 - iy1) }, bound: true };
    }
    return { box: { ...zone }, bound: true };
  };

  const notes = [`wonder: ${wonder.family}`, `wonder rationale: ${wonder.rationale.slice(0, 160)}`];
  const products: PlanBox[] = [];
  const productScales: number[] = [];
  // Template product zone splits across instances (same rule as the planner).
  const zoneSlots = (zone: PlanBox | null, count: number, i: number): PlanBox | null => {
    if (!zone) return null;
    const slot = Math.floor(zone.w / Math.max(1, count));
    return { x: zone.x + i * slot, y: zone.y, w: i === count - 1 ? zone.w - i * slot : slot, h: zone.h };
  };
  for (let i = 0; i < n; i++) {
    const cut = req.source.products[i] as { rgba: { width: number; height: number } };
    let box = denorm(wonder.boxes.products[i] as { x: number; y: number; w: number; h: number }, W, H);
    const slot = spec?.product_zone ? zoneSlots(zones['product_zone'] as PlanBox, n, i) : null;
    if (slot) {
      const frac = intersectArea(box, slot) / Math.max(1, box.w * box.h);
      box = frac >= 0.5
        ? { x: Math.max(box.x, slot.x), y: Math.max(box.y, slot.y), w: Math.max(1, Math.min(box.x + box.w, slot.x + slot.w) - Math.max(box.x, slot.x)), h: Math.max(1, Math.min(box.y + box.h, slot.y + slot.h) - Math.max(box.y, slot.y)) }
        : { ...slot };
      notes.push(`product-${i}: bound to template zone`);
    }
    const scale = Math.min(box.w / cut.rgba.width, box.h / cut.rgba.height, 1.5);
    // Fit the cut centered in the Wonder box (uniform, no stretch).
    const w = Math.max(1, Math.round(cut.rgba.width * scale));
    const h = Math.max(1, Math.round(cut.rgba.height * scale));
    products.push({ x: Math.round(box.x + (box.w - w) / 2), y: Math.round(box.y + (box.h - h) / 2), w, h });
    productScales.push(scale);
  }
  const fitCut = (nb: { x: number; y: number; w: number; h: number } | null, cut: { width: number; height: number } | null, zoneKey: string | null, cap: number, label: string): { box: PlanBox; scale: number } | null => {
    if (!nb || !cut) return null;
    const { box } = bind(denorm(nb, W, H), zoneKey);
    if (zoneKey && zones[zoneKey]) notes.push(`${label}: bound to template zone`);
    const scale = Math.min(box.w / cut.width, box.h / cut.height, cap);
    const w = Math.max(1, Math.round(cut.width * scale));
    const h = Math.max(1, Math.round(cut.height * scale));
    return { box: { x: Math.round(box.x + (box.w - w) / 2), y: Math.round(box.y + (box.h - h) / 2), w, h }, scale };
  };
  const logoCut = req.source.logo ? { width: req.source.logo.rgba.width, height: req.source.logo.rgba.height } : null;
  const logoFit = req.source.analysis.logo_bbox ? fitCut(wonder.boxes.logo, logoCut, spec?.logo ? 'logo' : null, 2, 'logo') : null;
  const panelFit = wonder.boxes.panel ? bind(denorm(wonder.boxes.panel, W, H), spec?.panel_zone ? 'panel_zone' : null) : null;
  if (panelFit?.bound) notes.push('panel: bound to template zone');
  const headlineFit = wonder.boxes.headline ? bind(denorm(wonder.boxes.headline, W, H), spec?.headline_zone ? 'headline_zone' : null) : null;
  const subtextFit = wonder.boxes.subtext ? bind(denorm(wonder.boxes.subtext, W, H), spec?.subtext_zone ? 'subtext_zone' : null) : null;
  const others = wonder.boxes.others.map((o) => denorm(o, W, H));

  const plan: LayoutPlan = {
    preset: req.preset.id,
    width: W,
    height: H,
    from_template: spec !== null,
    template_id: req.template?.id ?? null,
    safe: presetSafeRect(req.preset),
    logo: logoFit?.box ?? null,
    products,
    headline: req.source.analysis.headline ? (headlineFit?.box ?? null) : null,
    subtext: req.source.analysis.subtext ? (subtextFit?.box ?? null) : null,
    panel: req.source.analysis.panel ? (panelFit?.box ?? null) : null,
    other_texts: others,
    product_scales: productScales,
    logo_scale: logoFit?.scale ?? null,
    notes,
  };
  return { plan, note: notes.join('; ') };
}

/**
 * Plan one size: Wonder conversion when a usable Wonder plan exists, else the
 * code planner. Always returns an ENFORCED manifest; the planner used is
 * recorded on the manifest and in the trace.
 */
export function planForSize(req: OutputRequest, wonder: WonderSizePlan | null): PlannedSize {
  const codePlan = planLayout({
    preset: req.preset,
    source: req.source.analysis,
    sourceWidth: req.source.width,
    sourceHeight: req.source.height,
    productCuts: req.source.products.map((p) => ({ w: p.rgba.width, h: p.rgba.height })),
    logoCut: req.source.logo ? { w: req.source.logo.rgba.width, h: req.source.logo.rgba.height } : null,
    template: req.template ? { id: req.template.id, spec: req.template.spec } : null,
  });
  const spec = req.template?.spec ?? null;
  const mirrored = spec ? spec.direction !== req.source.analysis.direction : false;
  const zones = spec ? templateZonesPx(spec, req.preset.width, req.preset.height, mirrored) : null;

  if (wonder) {
    const converted = wonderToLayoutPlan(wonder, req);
    if (converted) {
      const manifest = enforceManifest({
        manifest: manifestFromPlan({
          plan: converted.plan,
          preset: req.preset,
          planner: 'wonder',
          family: wonder.family,
          direction: req.source.analysis.direction,
          templateZones: zones,
          rationale: wonder.rationale,
          freeText: freeHeadlineSubtext(req.source.analysis, converted.plan),
        }),
        direction: req.source.analysis.direction,
      });
      recordDroppedElements(manifest, req, 'wonder');
      return { plan: converted.plan, manifest, planner: 'wonder', logoOnBand: logoOnBandPlaced(manifest, zones, !!spec, converted.plan.notes) };
    }
  }
  const manifest = enforceManifest({
    manifest: manifestFromPlan({
      plan: codePlan,
      preset: req.preset,
      planner: 'code',
      direction: req.source.analysis.direction,
      templateZones: zones,
      freeText: freeHeadlineSubtext(req.source.analysis, codePlan),
    }),
    direction: req.source.analysis.direction,
  });
  recordDroppedElements(manifest, req, 'code');
  return { plan: codePlan, manifest, planner: 'code', logoOnBand: logoOnBandPlaced(manifest, zones, !!spec, codePlan.notes) };
}

/**
 * Honesty record: source elements the planner did not place (the art director
 * may drop minor strings, but never silently). Panel-carried headline/subtext
 * and strings printed on a product travel with those pixels, so only truly
 * missing elements are recorded. A correction, not a finding: it shows in the
 * manifest, the trace and the review input without failing the output.
 */
export function recordDroppedElements(manifest: ResolvedLayoutManifest, req: OutputRequest, planner: string): void {
  const a = req.source.analysis;
  const ids = new Set(manifest.elements.map((e) => e.id));
  const inProducts = (b: { x: number; y: number; w: number; h: number }): boolean =>
    a.products.some((p) => {
      const q = p.bbox;
      const ix = Math.max(0, Math.min(b.x + b.w, q.x + q.w) - Math.max(b.x, q.x));
      const iy = Math.max(0, Math.min(b.y + b.h, q.y + q.h) - Math.max(b.y, q.y));
      return ix * iy > 0.5 * b.w * b.h;
    });
  const dropped: string[] = [];
  a.products.forEach((p, i) => {
    if (!ids.has(`product-${i}`)) dropped.push(`product-${i} (${p.label})`);
  });
  if (a.logo_bbox && !ids.has('logo')) dropped.push('logo');
  if (a.panel && a.panel.texts.length > 0 && !ids.has('panel')) dropped.push('panel');
  const panelBox = a.panel?.bbox ?? null;
  const carriedByPanel = (b: { x: number; y: number; w: number; h: number }): boolean => {
    if (!panelBox) return false;
    const ix = Math.max(0, Math.min(b.x + b.w, panelBox.x + panelBox.w) - Math.max(b.x, panelBox.x));
    const iy = Math.max(0, Math.min(b.y + b.h, panelBox.y + panelBox.h) - Math.max(b.y, panelBox.y));
    return ix * iy > 0.5 * b.w * b.h;
  };
  if (a.headline && !ids.has('headline') && !carriedByPanel(a.headline.bbox) && !inProducts(a.headline.bbox)) {
    dropped.push(`headline ${JSON.stringify(a.headline.text.slice(0, 40))}`);
  }
  if (a.subtext && !ids.has('subtext') && !carriedByPanel(a.subtext.bbox) && !inProducts(a.subtext.bbox)) {
    dropped.push(`subtext ${JSON.stringify(a.subtext.text.slice(0, 40))}`);
  }
  freeOtherTexts(a).forEach((t, i) => {
    if (!ids.has(`other-${i}`) && !inProducts(t.bbox)) dropped.push(`other-${i} ${JSON.stringify(t.text.slice(0, 40))}`);
  });
  if (dropped.length > 0) {
    manifest.corrections.push(`${planner} plan placed no box for: ${dropped.join('; ')}`);
  }
}

/** False when the planner moved the logo off a template band (plate: no footer). */
export function logoOnBandFromNotes(notes: string[], hasTemplate: boolean): boolean | undefined {
  if (!hasTemplate) return undefined;
  return !notes.some((n) => n.includes('dark band'));
}

/**
 * Geometry-first logo-on-band: when the template has frame bands, the logo is
 * on a band only if its enforced box center sits inside a frame box. The notes
 * fallback covers planners that never emit frame geometry (the Wonder path
 * never relocates via notes, so geometry is what suppresses the footer there).
 */
export function logoOnBandPlaced(
  manifest: ResolvedLayoutManifest,
  zones: Record<string, PlanBox> | null,
  hasTemplate: boolean,
  notes: string[],
): boolean | undefined {
  if (!hasTemplate) return undefined;
  const logo = manifest.elements.find((e) => e.id === 'logo');
  const frameBoxes = zones ? Object.entries(zones).filter(([k]) => k.startsWith('frame_')).map(([, b]) => b) : [];
  if (logo && frameBoxes.length > 0) {
    const cx = logo.box.x + logo.box.w / 2;
    const cy = logo.box.y + logo.box.h / 2;
    return frameBoxes.some((f) => cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h);
  }
  return logoOnBandFromNotes(notes, true);
}

/** Generate one background plate (exact-sized) with ledger + trace. Shared by runOutput and the batch engine. */
export async function generatePlate(
  models: PipelineModels,
  req: OutputRequest,
  plan: LayoutPlan,
  manifest: ResolvedLayoutManifest,
  opts: { qaNotes?: string[]; backgroundBrief?: string | null; logoOnBand?: boolean; forceContinuous?: boolean; ledger?: CostLedger | null } = {},
  trace: TraceCollector,
): Promise<Buffer> {
  const genStart = Date.now();
  const gen = await editImages(models.image, {
    prompt: buildPlatePrompt(req, plan, opts.qaNotes ?? [], { manifest, logoOnBand: opts.logoOnBand, backgroundBrief: opts.backgroundBrief ?? null, forceContinuous: opts.forceContinuous }),
    size: `${plan.width}x${plan.height}`,
    images: [{ bytes: req.source.bytes, mimeType: req.source.mimeType }],
    reasoningStrength: 'low',
  });
  opts.ledger?.record(models.image.model, { images: 1 }, `plate-${plan.preset}`);
  trace.emit({
    step: 'adfit_generate',
    tool_or_model: `model:${models.image.model}`,
    input_summary: `protected plate ${plan.width}x${plan.height}${(opts.qaNotes?.length ?? 0) > 0 ? ' (retry)' : ''}`,
    output_summary: `wire bytes=${gen.returnedBytes}`,
    duration_ms: Date.now() - genStart,
    evidence_ids: ['out:plate'],
    next_state: 'adfit_composite',
    cached: false,
  });
  return exactSize(gen.png, plan.width, plan.height);
}

/** Per-element proof with trace. Shared by runOutput and the batch engine. */
export async function provePlaced(
  png: Buffer,
  placed: PlacedElement[],
  trace: TraceCollector,
): Promise<Record<string, ElementProof>> {
  const proofStart = Date.now();
  const proofs: Record<string, ElementProof> = {};
  const outRgba = await decodeRgba(png);
  for (const p of placed) {
    proofs[p.id] = elementProof({ sourceCut: p.cut.rgba, output: outRgba, left: p.left, top: p.top, scale: p.scale, featherPx: p.featherPx });
  }
  const summary = Object.entries(proofs).map(([id, pr]) => `${id}:${pr.core_differ}/${pr.core_total} (${Math.round(pr.coverage * 100)}% compared)`).join(' ');
  trace.emit({
    step: 'adfit_proof',
    tool_or_model: 'code:elementProof',
    input_summary: `${placed.length} pasted elements`,
    output_summary: `${summary} feather outside core only`,
    duration_ms: Date.now() - proofStart,
    evidence_ids: placed.map((p) => `out:${p.id}`),
    next_state: 'adfit_review',
    cached: false,
  });
  return proofs;
}

/** One full output: plan → generate → QA, with one automatic retry on FAIL. */
export async function runOutput(
  models: PipelineModels,
  req: OutputRequest,
  outputTag: string,
  trace: TraceCollector,
  wonder: WonderSizePlan | null = null,
): Promise<OutputOutcome> {
  const jobStart = Date.now();
  let modelCalls = 0;
  let imageCalls = 0;
  const planStart = Date.now();
  const planned = planForSize(req, wonder);
  const plan = planned.plan;
  const manifest = planned.manifest;
  trace.emit({
    step: 'adfit_plan',
    tool_or_model: planned.planner === 'wonder' ? `model:${models.wonderModel}` : 'code:planLayout',
    input_summary: `${req.preset.id} ${req.mode}${req.template ? ` template=${req.template.id}` : ' no-template'} family=${manifest.family}`,
    output_summary: `${plan.notes.join('; ')}${manifest.corrections.length > 0 ? ` | corrections: ${manifest.corrections.join('; ').slice(0, 300)}` : ''}`,
    duration_ms: Date.now() - planStart,
    evidence_ids: ['out:plan'],
    next_state: 'adfit_generate',
    cached: false,
  });

  const qaNotes: string[] = [];
  let retries = 0;
  for (;;) {
    const genStart = Date.now();
    let png: Buffer;
    let placed: PlacedElement[] | null = null;
    if (req.mode === 'fast') {
      const images = [{ bytes: req.source.bytes, mimeType: req.source.mimeType }];
      if (req.template) images.push({ bytes: req.template.imageBytes, mimeType: req.template.mimeType });
      const gen = await editImages(models.image, {
        prompt: buildFastPrompt(req, plan, qaNotes),
        size: `${plan.width}x${plan.height}`,
        images,
        reasoningStrength: 'high',
      });
      imageCalls++;
      trace.emit({
        step: 'adfit_generate',
        tool_or_model: `model:${models.image.model}`,
        input_summary: `fast edit [source${req.template ? '+template' : ''}] ${plan.width}x${plan.height}${qaNotes.length > 0 ? ' (retry)' : ''}`,
        output_summary: `wire bytes=${gen.returnedBytes}`,
        duration_ms: Date.now() - genStart,
        evidence_ids: ['out:image'],
        next_state: 'adfit_exactsize',
        cached: false,
      });
      png = await exactSize(gen.png, plan.width, plan.height);
    } else {
      const gen = await editImages(models.image, {
        prompt: buildPlatePrompt(req, plan, qaNotes, { manifest, logoOnBand: planned.logoOnBand, backgroundBrief: wonder?.background_brief ?? null }),
        size: `${plan.width}x${plan.height}`,
        images: [{ bytes: req.source.bytes, mimeType: req.source.mimeType }],
        reasoningStrength: 'low',
      });
      imageCalls++;
      trace.emit({
        step: 'adfit_generate',
        tool_or_model: `model:${models.image.model}`,
        input_summary: `protected plate ${plan.width}x${plan.height}${qaNotes.length > 0 ? ' (retry)' : ''}`,
        output_summary: `wire bytes=${gen.returnedBytes}`,
        duration_ms: Date.now() - genStart,
        evidence_ids: ['out:plate'],
        next_state: 'adfit_composite',
        cached: false,
      });
      const comp = await compositeProtected(req, plan, gen.png, trace, manifest);
      png = comp.png;
      placed = comp.placed;
    }

    // Proof (protected only): per pasted element, 0 differing core pixels.
    let proofs: Record<string, ElementProof> | null = null;
    if (req.mode === 'protected' && placed) {
      const proofStart = Date.now();
      proofs = {};
      const outRgba = await decodeRgba(png);
      for (const p of placed) {
        proofs[p.id] = elementProof({ sourceCut: p.cut.rgba, output: outRgba, left: p.left, top: p.top, scale: p.scale, featherPx: p.featherPx });
      }
      const summary = Object.entries(proofs).map(([id, pr]) => `${id}:${pr.core_differ}/${pr.core_total} (${Math.round(pr.coverage * 100)}% compared)`).join(' ');
      trace.emit({
        step: 'adfit_proof',
        tool_or_model: 'code:elementProof',
        input_summary: `${placed.length} pasted elements`,
        output_summary: `${summary} feather outside core only`,
        duration_ms: Date.now() - proofStart,
        evidence_ids: placed.map((p) => `out:${p.id}`),
        next_state: 'adfit_qa',
        cached: false,
      });
    }

    const qa = await qaOutput(models.client, {
      imageBytes: png,
      mimeType: 'image/png',
      width: plan.width,
      height: plan.height,
      model: models.extractModel,
      source: req.source.analysis,
      sourceBytes: req.source.bytes,
      sourceMime: req.source.mimeType,
      extraNotes: qaNotes,
      safe: plan.safe,
    });
    modelCalls += qa.attempts.length;
    trace.emit({
      step: 'adfit_qa',
      tool_or_model: `model:${models.extractModel}`,
      input_summary: `fresh read of ${plan.width}x${plan.height} output`,
      output_summary: qa.verdict.pass ? 'PASS' : `FAIL: ${qa.verdict.reasons.join(' | ').slice(0, 300)}`,
      duration_ms: qa.totalLatencyMs,
      evidence_ids: ['out:qa'],
      next_state: qa.verdict.pass ? 'done' : retries === 0 ? 'adfit_retry' : 'needs_review',
      cached: false,
    });

    if (qa.verdict.pass || retries >= 1) {
      const digest = artifactDigest(png, outputTag);
      return { png, plan, manifest, proofs, digest, qa: qa.verdict, retries, modelCalls, imageCalls };
    }
    retries++;
    qaNotes.push(...qa.verdict.reasons.slice(0, 4));
    void jobStart;
  }
}

/** Run items with at most `limit` in flight; results keep input order. */
export async function runPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}
