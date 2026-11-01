import type OpenAI from 'openai';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { AdClaims } from '../../shared/schemas.js';
import { countMaskInRect } from '../../shared/geometry.js';
import type { ModelUsage } from '../models/client.js';
import { extractAdClaims, ExtractError } from '../models/extract-ad.js';
import { snapPanel, PanelSnapError, type PanelSnap } from '../repair/panel.js';
import { buildProtectedMask } from '../repair/masks.js';
import { findOutsidePanelContradiction, type OfferSpec } from '../repair/spec.js';
import { buildPanelCopy } from '../repair/templates.js';
import { renderPanel, RenderBlocker } from '../repair/render.js';
import { compositePanel, decodeRgba } from '../repair/composite.js';
import { artifactDigest, pixelProof, type ArtifactDigest, type PixelProof } from '../repair/proof.js';
import { revalidate, type Revalidation } from '../repair/revalidate.js';
import { TraceCollector } from './trace.js';

export interface RepairPipelineInput {
  client: OpenAI;
  extractModel: string;
  samModel: string;
  sourceBytes: Buffer;
  claims: AdClaims;
  spec: OfferSpec;
  trace: TraceCollector;
  /** Per-ad artifact dir (before/after/panel/proof/revalidation/result JSON). */
  artifactDir: string;
  /** Chromium mutex shared with page capture (concurrency 1 for Chromium). */
  withBrowser: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface RepairPipelineOutput {
  status: 'repaired' | 'refused';
  blockers: string[];
  afterBytes: Buffer | null;
  digest: ArtifactDigest | null;
  proof: PixelProof | null;
  revalidation: Revalidation | null;
  modelCalls: number;
  usages: Array<ModelUsage | undefined>;
}

/**
 * Production repair run for one AD_WRONG_REPAIRABLE check: panel snap →
 * protection masks → gates → Chromium render → Sharp composite → pixel
 * proof → fresh Spark revalidation. Every stage emits into the shared trace.
 * No ground-truth fallbacks: a mask Spark cannot support stays empty and
 * the repair is refused.
 */
export async function runRepairPipeline(input: RepairPipelineInput): Promise<RepairPipelineOutput> {
  const { client, claims, spec, trace, artifactDir } = input;
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, 'before.png'), input.sourceBytes);
  let modelCalls = 0;
  const usages: Array<ModelUsage | undefined> = [];
  const blockers: string[] = [];

  const before = await decodeRgba(input.sourceBytes);

  // --- snap + cheap gates ---
  const snapStart = Date.now();
  let snap: PanelSnap | null = null;
  if (!claims.panel) {
    blockers.push('panel_not_found');
  } else {
    try {
      snap = snapPanel(before.data, before.width, before.height, { ...claims.panel.bbox });
      if (!snap.opaque) blockers.push('panel_not_opaque');
    } catch (err) {
      if (err instanceof PanelSnapError) blockers.push(err.blocker);
      else throw err;
    }
  }
  if (findOutsidePanelContradiction(spec, claims)) blockers.push('wrong_text_outside_panel');
  trace.emit({
    step: 'repair_snap',
    tool_or_model: 'code:snapPanel',
    input_summary: claims.panel ? `panel bbox ${JSON.stringify(claims.panel.bbox)}` : 'no panel claimed',
    output_summary: snap ? `rect=${JSON.stringify(snap.rect)} gates=[${blockers.join(',') || 'none'}]` : `no rect gates=[${blockers.join(',')}]`,
    duration_ms: Date.now() - snapStart,
    evidence_ids: ['ad:panel'],
    next_state: 'repair_masks',
    cached: false,
  });

  // --- protection masks (SAM) ---
  const masksStart = Date.now();
  const protection = await buildProtectedMask(client, {
    imageBytes: input.sourceBytes,
    mimeType: 'image/png',
    width: before.width,
    height: before.height,
    model: input.samModel,
    sparkProductBox: claims.product_bbox ? { ...claims.product_bbox } : null,
    sparkLogoBox: claims.logo_bbox ? { ...claims.logo_bbox } : null,
  });
  modelCalls += protection.calls;
  blockers.push(...protection.blockers);
  // Persist the SAM masks (even on refusal) so the UI can show the overlay
  // without re-running SAM. Grayscale PNGs: 255 = masked pixel.
  await writeFile(join(artifactDir, 'masks.json'), JSON.stringify({ width: before.width, height: before.height, labels: protection.labels }, null, 2) + '\n');
  for (const [name, mask] of [['mask-product.png', protection.product], ['mask-logo.png', protection.logo], ['mask-protected.png', protection.protected]] as const) {
    const px = Buffer.alloc(before.width * before.height);
    for (let i = 0; i < px.length; i++) px[i] = mask[i] ? 255 : 0;
    await sharp(px, { raw: { width: before.width, height: before.height, channels: 1 } })
      .png()
      .toFile(join(artifactDir, name));
  }
  let overlapPx = -1;
  if (snap) {
    overlapPx = countMaskInRect(protection.protected, before.width, before.height, snap.rect);
    if (overlapPx > 0) blockers.push('panel_overlaps_protected');
  }
  trace.emit({
    step: 'repair_masks',
    tool_or_model: `model:${input.samModel}`,
    input_summary: `product[${protection.labels.product}] logo[${protection.labels.logo.join('+')}] calls=${protection.calls}`,
    output_summary: `overlapPx=${overlapPx} gates=[${blockers.join(',') || 'none'}]`,
    duration_ms: Date.now() - masksStart,
    evidence_ids: ['ad:product', 'ad:logo'],
    next_state: blockers.length > 0 ? 'repair_refused' : 'repair_render',
    cached: false,
  });

  if (blockers.length > 0 || !snap) {
    await writeFile(join(artifactDir, 'result.json'), JSON.stringify({ status: 'refused', blockers }, null, 2) + '\n');
    return { status: 'refused', blockers, afterBytes: null, digest: null, proof: null, revalidation: null, modelCalls, usages };
  }
  const rect = snap.rect;

  // --- render the corrected panel (Chromium, under the shared lock) ---
  const renderStart = Date.now();
  const copy = buildPanelCopy(spec, claims.language);
  let panelPng: Buffer;
  try {
    const rendered = await input.withBrowser(() =>
      renderPanel({
        width: Math.round(rect.w),
        height: Math.round(rect.h),
        radius: snap.radius,
        fill: snap.fill,
        textColor: snap.textColor,
        main: copy.main,
        sub: copy.sub,
        lang: claims.language,
      }),
    );
    panelPng = rendered.png;
    trace.emit({
      step: 'repair_render',
      tool_or_model: 'chromium:renderPanel',
      input_summary: `rect=${JSON.stringify(rect)} main=${JSON.stringify(copy.main)}`,
      output_summary: `main=${rendered.mainPx}px sub=${rendered.subPx}px`,
      duration_ms: Date.now() - renderStart,
      evidence_ids: ['ad:panel'],
      next_state: 'repair_proof',
      cached: false,
    });
  } catch (err) {
    if (err instanceof RenderBlocker) {
      blockers.push(err.blocker);
      trace.emit({
        step: 'repair_render',
        tool_or_model: 'chromium:renderPanel',
        input_summary: `rect=${JSON.stringify(rect)}`,
        output_summary: `refused: ${err.blocker}`,
        duration_ms: Date.now() - renderStart,
        evidence_ids: ['ad:panel'],
        next_state: 'repair_refused',
        cached: false,
      });
      await writeFile(join(artifactDir, 'result.json'), JSON.stringify({ status: 'refused', blockers }, null, 2) + '\n');
      return { status: 'refused', blockers, afterBytes: null, digest: null, proof: null, revalidation: null, modelCalls, usages };
    }
    throw err;
  }
  await writeFile(join(artifactDir, 'panel.png'), panelPng);

  // --- composite + pixel proof ---
  const proofStart = Date.now();
  const afterBytes = await compositePanel(input.sourceBytes, panelPng, rect);
  await writeFile(join(artifactDir, 'after.png'), afterBytes);
  const after = await decodeRgba(afterBytes);
  const proof = pixelProof(before, after, rect, protection.protected);
  const roundTrip = pixelProof(before, await decodeRgba(afterBytes), rect, protection.protected);
  const digest = artifactDigest(afterBytes, spec.version);
  await writeFile(join(artifactDir, 'proof.json'), JSON.stringify({ rect, proof, roundTrip, digest, specVersion: spec.version }, null, 2) + '\n');
  trace.emit({
    step: 'repair_proof',
    tool_or_model: 'code:pixelProof',
    input_summary: `rect=${JSON.stringify(rect)}`,
    output_summary: `outside=${proof.changed_outside_rect} protected=${proof.changed_inside_protected} maxdiff=${proof.max_channel_diff_outside} roundtrip=${roundTrip.pass ? 'ok' : 'FAIL'} pass=${proof.pass}`,
    duration_ms: Date.now() - proofStart,
    evidence_ids: ['ad:panel', 'ad:product', 'ad:logo'],
    next_state: proof.pass && roundTrip.pass ? 'repair_revalidate' : 'repair_refused',
    cached: false,
  });
  if (!proof.pass || !roundTrip.pass) {
    blockers.push('pixel_proof_failed');
    await writeFile(join(artifactDir, 'result.json'), JSON.stringify({ status: 'refused', blockers, proof, roundTrip }, null, 2) + '\n');
    return { status: 'refused', blockers, afterBytes: null, digest, proof, revalidation: null, modelCalls, usages };
  }

  // --- fresh revalidation ---
  const revalStart = Date.now();
  let revalidation: Revalidation;
  try {
    const rextracted = await extractAdClaims(client, {
      imageBytes: afterBytes,
      mimeType: 'image/png',
      width: after.width,
      height: after.height,
      model: input.extractModel,
    });
    modelCalls += rextracted.attempts.length;
    for (const a of rextracted.attempts) usages.push(a.usage);
    revalidation = revalidate(claims, rextracted.claims, spec);
    revalidation.claims = {
      percent: rextracted.claims.discount.percent,
      scope: rextracted.claims.discount.scope,
      shipping: rextracted.claims.shipping.terms,
      valid: rextracted.claims.valid_until.day_month,
    };
  } catch (err) {
    if (err instanceof ExtractError) {
      modelCalls += err.attempts.length;
      blockers.push('revalidation_failed');
      trace.emit({
        step: 'repair_revalidate',
        tool_or_model: `model:${input.extractModel}`,
        input_summary: 'fresh extraction of after.png',
        output_summary: `extraction error: ${err.message}`,
        duration_ms: Date.now() - revalStart,
        evidence_ids: ['ad:discount'],
        next_state: 'repair_refused',
        cached: false,
      });
      await writeFile(join(artifactDir, 'result.json'), JSON.stringify({ status: 'refused', blockers }, null, 2) + '\n');
      return { status: 'refused', blockers, afterBytes: null, digest, proof, revalidation: null, modelCalls, usages };
    }
    throw err;
  }
  await writeFile(join(artifactDir, 'revalidation.json'), JSON.stringify({ pass: revalidation.pass, checks: revalidation.checks }, null, 2) + '\n');
  trace.emit({
    step: 'repair_revalidate',
    tool_or_model: `model:${input.extractModel}`,
    input_summary: 'fresh extraction of after.png',
    output_summary: revalidation.pass ? 'PASS' : `FAIL: ${revalidation.checks.filter((c) => !c.pass).map((c) => c.check).join(',')}`,
    duration_ms: Date.now() - revalStart,
    evidence_ids: ['ad:discount', 'ad:shipping', 'ad:valid_until'],
    next_state: revalidation.pass ? 'done' : 'repair_refused',
    cached: false,
  });

  if (!revalidation.pass) {
    blockers.push('revalidation_failed');
    await writeFile(join(artifactDir, 'result.json'), JSON.stringify({ status: 'refused', blockers, revalidation }, null, 2) + '\n');
    return { status: 'refused', blockers, afterBytes: null, digest, proof, revalidation, modelCalls, usages };
  }
  await writeFile(join(artifactDir, 'result.json'), JSON.stringify({ status: 'repaired', digest, proof, revalidation }, null, 2) + '\n');
  return { status: 'repaired', blockers: [], afterBytes, digest, proof, revalidation, modelCalls, usages };
}
