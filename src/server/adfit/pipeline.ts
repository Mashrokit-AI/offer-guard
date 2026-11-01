import type OpenAI from 'openai';
import type { Preset } from '../../shared/presets.js';
import type { LayoutPlan, QAverdict, SourceAnalysis, TemplateSpec } from '../../shared/schemas.js';
import { analyzeSource } from '../models/analyze.js';
import { editImages, type ImageGenConfig } from '../models/muse-image.js';
import { qaOutput } from '../models/qa.js';
import { growLogoMask, segmentTargets } from '../repair/masks.js';
import {
  decodeRgba,
  exactSize,
  pasteWithFeather,
  scaleRgbaNearest,
  type RgbaImage,
} from '../repair/composite.js';
import { artifactDigest, elementProof, type ArtifactDigest, type ElementProof } from '../repair/proof.js';
import { renderTextBlock, rgbFromHex, type TextLine } from '../repair/render.js';
import { maskBoundingBox, type PixelBox } from '../../shared/geometry.js';
import { freeOtherTexts, planLayout } from './planner.js';
import { snapPanelRect } from './snap.js';
import { TraceCollector } from '../workflow/trace.js';

export interface PipelineModels {
  client: OpenAI;
  extractModel: string;
  samModel: string;
  image: ImageGenConfig;
}

export type AdFitMode = 'protected' | 'fast';

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
  bytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
  analysis: SourceAnalysis;
  products: ElementCut[];
  logo: ElementCut | null;
  panel: ElementCut | null;
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
  mode: AdFitMode;
  template: OutputTemplate | null;
  /** Transparent PNG placed exactly, last. Must match the preset size. */
  framePng: Buffer | null;
  brandName: string | null;
}

export interface OutputOutcome {
  png: Buffer;
  plan: LayoutPlan;
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

/**
 * Analyze one source once per job: Spark analysis + SAM masks for every
 * product and the logo (phrase + box-prompt union). An empty SAM mask falls
 * back to the Spark bbox rect — recorded in the trace, never silent.
 */
export async function prepareSource(
  models: PipelineModels,
  input: { id: string; bytes: Buffer; mimeType: string; width: number; height: number },
  trace: TraceCollector,
): Promise<PreparedSource> {
  let modelCalls = 0;
  const analyzed = await analyzeSource(models.client, {
    imageBytes: input.bytes,
    mimeType: input.mimeType,
    width: input.width,
    height: input.height,
    model: models.extractModel,
  });
  modelCalls += analyzed.attempts.length;
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

  const rgba = await decodeRgba(input.bytes);
  const targets = [
    ...analysis.products.map((p, i) => ({ id: `product-${i}`, phrase: p.sam_phrase, box: { ...p.bbox } })),
    ...(analysis.logo_bbox ? [{ id: 'logo', phrase: 'logo', box: { ...analysis.logo_bbox } }] : []),
  ];
  const maskLabels: Record<string, string> = {};
  const masks = new Map<string, Uint8Array>();
  if (targets.length > 0) {
    const seg = await segmentTargets(models.client, {
      imageBytes: input.bytes,
      mimeType: input.mimeType,
      width: input.width,
      height: input.height,
      model: models.samModel,
      targets,
    });
    modelCalls += seg.calls;
    for (const [id, mask] of seg.masks) {
      masks.set(id, mask);
      maskLabels[id] = seg.labels[id] ?? '';
    }
    // Complete the logo lockup by contrast (SAM sometimes keeps only the mark
    // + half the wordmark). Counted in the trace, never silent.
    let logoGrownBy = 0;
    const logoMask = masks.get('logo');
    if (logoMask && analysis.logo_bbox) {
      const grown = growLogoMask(rgba, logoMask, { ...analysis.logo_bbox });
      for (let i = 0; i < grown.length; i++) {
        if (grown[i] && !logoMask[i]) logoGrownBy++;
      }
      masks.set('logo', grown);
      if (logoGrownBy > 0) maskLabels['logo'] += ` +contrast-grow(${logoGrownBy}px)`;
    }
    trace.emit({
      step: 'adfit_masks',
      tool_or_model: `model:${models.samModel}`,
      input_summary: targets.map((t) => `${t.id}[${t.phrase}]`).join(' '),
      output_summary: seg.blockers.length > 0 ? `blockers: ${seg.blockers.join(',')} (bbox fallback)` : `ok: ${[...masks.keys()].join(',')}`,
      duration_ms: seg.latencyMs,
      evidence_ids: targets.map((t) => `src:${t.id}`),
      next_state: 'adfit_plan',
      cached: false,
    });
  }

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
  const logo = analysis.logo_bbox ? cutOrRect('logo', { ...analysis.logo_bbox }) : null;
  // The opaque panel travels as pixels; snap Spark's box out to the panel's
  // visual edges first so padding (and descenders) are never clipped.
  const panel = analysis.panel?.opaque
    ? cutFromRect(rgba, snapPanelRect(rgba, { ...analysis.panel.bbox }), 'panel')
    : null;

  return {
    id: input.id,
    bytes: input.bytes,
    mimeType: input.mimeType,
    width: input.width,
    height: input.height,
    analysis,
    products,
    logo,
    panel,
    masks,
    maskLabels,
    modelCalls,
  };
}

// Chromium renders are serialized (one browser at a time).
let browserChain: Promise<unknown> = Promise.resolve();

function withBrowser<T>(fn: () => Promise<T>): Promise<T> {
  const run = browserChain.then(fn, fn);
  browserChain = run.catch(() => undefined);
  return run;
}

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
  const lines = [
    `Recompose this ad creative for ${plan.width}x${plan.height} (${req.preset.label}).`,
    `Keep the brand style${req.brandName ? ` of ${req.brandName}` : ''}, the product, the logo, and every printed text EXACTLY (letter by letter, same script and language: ${a.language}).`,
    ...verbatimList(a).map((t) => `Must appear verbatim: ${JSON.stringify(t)}`),
    'Keep all important content inside the safe area (away from the outer edges); do not crop the logo or product; do not invent any new text.',
  ];
  if (req.template) lines.push('Follow the layout of the second reference image (the brand template for this size): same zone arrangement, same panel position, same background style.');
  else lines.push(`Layout: ${plan.notes.join('; ')}.`);
  for (const n of qaNotes) lines.push(`Fix from QA review: ${n}`);
  return lines.join('\n');
}

export function buildPlatePrompt(req: OutputRequest, plan: LayoutPlan, qaNotes: string[]): string {
  const a = req.source.analysis;
  const lines = [
    `Clean advertising background plate, ${plan.width}x${plan.height} aspect. Absolutely NO product, NO logo, NO text, NO letters, NO numbers — an empty background only.`,
    `Style to match: ${a.background.description} (type: ${a.background.type}; colors: ${a.background.colors.join(', ') || 'match the reference'}).`,
  ];
  if (req.template) lines.push(`Brand layout style for this size: ${req.template.spec.background_style}.`);
  lines.push('Even, seamless, no vignette traps; leave clean space where the product and text will be placed by code.');
  for (const n of qaNotes) lines.push(`Fix from QA review: ${n}`);
  return lines.join('\n');
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

/** Protected-mode composite: plate + original pixels + re-rendered text + frame. */
export async function compositeProtected(
  req: OutputRequest,
  plan: LayoutPlan,
  platePng: Buffer,
  trace: TraceCollector,
): Promise<{ png: Buffer; placed: PlacedElement[]; textSizes: Record<string, number[]>; notes: string[] }> {
  const notes: string[] = [];
  const placed: PlacedElement[] = [];
  const textSizes: Record<string, number[]> = {};
  const start = Date.now();
  const canvas = await decodeRgba(await exactSize(platePng, plan.width, plan.height));
  const a = req.source.analysis;

  // Products + logo: uniform scale, feathered paste.
  req.source.products.forEach((cut, i) => {
    const dst = plan.products[i];
    const scale = plan.product_scales[i];
    if (!dst || scale === undefined) return;
    const scaled = scaleRgbaNearest(cut.rgba, scale);
    // Center the scaled cut in its plan box (exact for fitCentered plans).
    const left = Math.round(dst.x + (dst.w - scaled.width) / 2);
    const top = Math.round(dst.y + (dst.h - scaled.height) / 2);
    pasteWithFeather(canvas, scaled, left, top, 2);
    placed.push({ id: cut.id, cut, left, top, scale, featherPx: 2 });
  });
  if (req.source.logo && plan.logo && plan.logo_scale !== null) {
    const scaled = scaleRgbaNearest(req.source.logo.rgba, plan.logo_scale);
    const left = Math.round(plan.logo.x + (plan.logo.w - scaled.width) / 2);
    const top = Math.round(plan.logo.y + (plan.logo.h - scaled.height) / 2);
    pasteWithFeather(canvas, scaled, left, top, 2);
    placed.push({ id: 'logo', cut: req.source.logo, left, top, scale: plan.logo_scale, featherPx: 2 });
  }
  // Opaque panel: copied as a pixel block, no feather (hard design edge).
  if (req.source.panel && plan.panel) {
    const scale = Math.min(plan.panel.w / req.source.panel.rgba.width, plan.panel.h / req.source.panel.rgba.height);
    const scaled = scaleRgbaNearest(req.source.panel.rgba, scale);
    const left = Math.round(plan.panel.x + (plan.panel.w - scaled.width) / 2);
    const top = Math.round(plan.panel.y + (plan.panel.h - scaled.height) / 2);
    pasteWithFeather(canvas, scaled, left, top, 0);
    placed.push({ id: 'panel', cut: req.source.panel, left, top, scale, featherPx: 0 });
  }

  // Free text on the background: re-rendered verbatim in Chromium.
  const align = req.template?.spec.text_align ?? 'center';
  const renderOne = async (text: { text: string; bold: boolean; color: string } | null, dst: LayoutPlan['headline'], key: string): Promise<void> => {
    if (!text || !dst) return;
    const line: TextLine = { text: text.text, px: Math.max(24, Math.round(dst.h * 0.62)), weight: text.bold ? 700 : 400, color: rgbFromHex(text.color) };
    const rendered = await withBrowser(() => renderTextBlock({ width: dst.w, height: dst.h, lines: [line], lang: a.language, align }));
    textSizes[key] = rendered.sizes;
    const layer = await decodeRgba(rendered.png);
    // Stamp the rendered layer with its own alpha (text pixels only).
    for (let y = 0; y < Math.min(layer.height, canvas.height - dst.y); y++) {
      for (let x = 0; x < Math.min(layer.width, canvas.width - dst.x); x++) {
        const si = (y * layer.width + x) * 4;
        const alpha = (layer.data[si + 3] as number) / 255;
        if (alpha <= 0) continue;
        const di = ((dst.y + y) * canvas.width + (dst.x + x)) * 4;
        for (let c = 0; c < 3; c++) {
          canvas.data[di + c] = Math.round((layer.data[si + c] as number) * alpha + (canvas.data[di + c] as number) * (1 - alpha));
        }
      }
    }
  };
  const headlineFree = a.headline && (!a.panel || plan.headline);
  const subtextFree = a.subtext && (!a.panel || plan.subtext);
  if (plan.headline && headlineFree && a.headline) await renderOne(a.headline, plan.headline, 'headline');
  if (plan.subtext && subtextFree && a.subtext) await renderOne(a.subtext, plan.subtext, 'subtext');
  const freeOthers = freeOtherTexts(a);
  for (let i = 0; i < freeOthers.length; i++) {
    const dst = plan.other_texts[i];
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
    input_summary: `plate + ${placed.map((p) => `${p.id}@${p.scale.toFixed(3)}x`).join(' ') || 'no pasted elements'}${Object.keys(textSizes).length > 0 ? ` + text(${Object.keys(textSizes).join(',')})` : ''}`,
    output_summary: `${plan.width}x${plan.height} ${notes.join('; ') || 'ok'}`,
    duration_ms: Date.now() - start,
    evidence_ids: placed.map((p) => `out:${p.id}`),
    next_state: 'adfit_proof',
    cached: false,
  });
  return { png, placed, textSizes, notes };
}

/** One full output: plan → generate → QA, with one automatic retry on FAIL. */
export async function runOutput(
  models: PipelineModels,
  req: OutputRequest,
  outputTag: string,
  trace: TraceCollector,
): Promise<OutputOutcome> {
  const jobStart = Date.now();
  let modelCalls = 0;
  let imageCalls = 0;
  const planStart = Date.now();
  const plan = planLayout({
    preset: req.preset,
    source: req.source.analysis,
    sourceWidth: req.source.width,
    sourceHeight: req.source.height,
    productCuts: req.source.products.map((p) => ({ w: p.rgba.width, h: p.rgba.height })),
    logoCut: req.source.logo ? { w: req.source.logo.rgba.width, h: req.source.logo.rgba.height } : null,
    template: req.template ? { id: req.template.id, spec: req.template.spec } : null,
  });
  trace.emit({
    step: 'adfit_plan',
    tool_or_model: 'code:planLayout',
    input_summary: `${req.preset.id} ${req.mode}${req.template ? ` template=${req.template.id}` : ' no-template'}`,
    output_summary: plan.notes.join('; '),
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
        prompt: buildPlatePrompt(req, plan, qaNotes),
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
      const comp = await compositeProtected(req, plan, gen.png, trace);
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
      const summary = Object.entries(proofs).map(([id, pr]) => `${id}:${pr.core_differ}/${pr.core_total}`).join(' ');
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
      return { png, plan, proofs, digest, qa: qa.verdict, retries, modelCalls, imageCalls };
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
