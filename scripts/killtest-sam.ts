#!/usr/bin/env tsx
/**
 * Day-1 kill test: protection masks (SAM 3.1).
 *
 * Runs ad-02 and ad-03: separate SAM requests for the product and the logo,
 * then checks the repair geometry against tests/fixtures/ground-truth.json.
 * Model API only (read-only); never touches the Graph API.
 *
 *   npm run killtest:sam
 *
 * Raw requests/responses land in artifacts/killtests/sam-<ad>.json, overlay
 * PNGs in artifacts/killtests/sam-<ad>.png (gitignored; key masked, image
 * bytes replaced by {sha256, bytes}).
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import OpenAI from 'openai';
import { loadEnvFiles } from '../src/shared/env.js';
import { describeModelConfigForLog, loadModelConfig } from '../src/shared/config.js';
import {
  createModelClient,
  describeImage,
  writeKilltestArtifact,
  type ModelUsage,
} from '../src/server/models/client.js';
import { buildBoxPromptText, segment, SegmentError, type SegmentResult } from '../src/server/models/sam.js';
import {
  boxIoU,
  countMaskInRect,
  dilateMask,
  maskArea,
  maskBoundingBox,
  unionMasks,
  type PixelBox,
} from '../src/shared/geometry.js';
import type { AdClaims } from '../src/shared/schemas.js';
import { loadGroundTruth, type AdGroundTruth } from './ground-truth.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const ADS = ['ad-02-wrong', 'ad-03-overlap'] as const;
const PRODUCT_PHRASES = ['bottle', 'water bottle'];
const LOGO_PHRASES = ['logo', 'brand logo'];
const DILATE_PX = 4;
const PRODUCT_IOU_THRESHOLD = 0.8;
const LOGO_REGION_TOLERANCE_PX = 20;
const TINY_MASK_FILL = 0.2;

interface MaskAttemptRecord {
  kind: 'phrase' | 'box';
  inputText: string;
  boxSource: 'spark artifact' | 'fixture geometry' | null;
  latencyMs: number;
  usage: ModelUsage | undefined;
  maskArea: number;
  boxes: PixelBox[];
  diagnostics: SegmentResult['diagnostics'];
  outcomeStatus: string;
  outcomeReason: string | null;
  reportedFrame: { w: number; h: number }[];
  rawOutput: string;
}

interface TargetResult {
  mask: Uint8Array;
  promptUsed: string;
  attempts: MaskAttemptRecord[];
  totalLatencyMs: number;
}

interface SparkArtifact {
  claims?: AdClaims | undefined;
}

async function readSparkBox(ad: string, field: 'product_bbox' | 'logo_bbox'): Promise<PixelBox | null> {
  try {
    const raw = await readFile(join(REPO_ROOT, 'artifacts', 'killtests', `spark-${ad}.json`), 'utf8');
    const box = (JSON.parse(raw) as SparkArtifact).claims?.[field];
    if (!box || box.w <= 0 || box.h <= 0) return null;
    return { x: box.x, y: box.y, w: box.w, h: box.h };
  } catch {
    return null;
  }
}

async function segmentTarget(
  client: OpenAI,
  target: 'product' | 'logo',
  phrases: string[],
  sparkBox: PixelBox | null,
  gtBox: PixelBox,
  imageBytes: Buffer,
  width: number,
  height: number,
  model: string,
): Promise<TargetResult> {
  const attempts: MaskAttemptRecord[] = [];
  const runAttempt = async (kind: 'phrase' | 'box', inputText: string, boxSource: MaskAttemptRecord['boxSource']) => {
    const seg = await segment(client, { imageBytes, mimeType: 'image/png', width, height, model, inputText });
    attempts.push({
      kind,
      inputText,
      boxSource,
      latencyMs: seg.latencyMs,
      usage: seg.usage,
      maskArea: maskArea(seg.mask),
      boxes: seg.boxes,
      diagnostics: seg.diagnostics,
      outcomeStatus: seg.outcomeStatus,
      outcomeReason: seg.outcomeReason,
      reportedFrame: seg.reportedFrame,
      rawOutput: seg.rawOutput,
    });
    return seg;
  };

  for (const phrase of phrases) {
    const seg = await runAttempt('phrase', phrase, null);
    if (maskArea(seg.mask) > 0) {
      return { mask: seg.mask, promptUsed: `phrase "${phrase}"`, attempts, totalLatencyMs: sumLatency(attempts) };
    }
  }

  const boxSource: MaskAttemptRecord['boxSource'] = sparkBox ? 'spark artifact' : 'fixture geometry';
  const box = sparkBox ?? gtBox;
  const inputText = buildBoxPromptText(box, width, height);
  const seg = await runAttempt('box', inputText, boxSource);
  const label = sparkBox ? `box from spark artifact ${JSON.stringify(box)}` : `box from fixture geometry ${JSON.stringify(box)}`;
  return { mask: seg.mask, promptUsed: label, attempts, totalLatencyMs: sumLatency(attempts) };
}

function sumLatency(attempts: MaskAttemptRecord[]): number {
  return attempts.reduce((s, a) => s + a.latencyMs, 0);
}

function attemptRecord(a: MaskAttemptRecord, bytes: Buffer, width: number, height: number, model: string) {
  const { inputText, kind, boxSource, ...rest } = a;
  return {
    request: {
      endpoint: 'responses.create',
      model,
      stream: true,
      inputText,
      kind,
      boxSource,
      imageDetail: 'high',
      image: describeImage(bytes, width, height),
    },
    ...rest,
  };
}

function sumUsage(targets: TargetResult[]): { in: number; out: number; total: number; cost: number | null } {
  let input = 0;
  let output = 0;
  let total = 0;
  let cost: number | null = null;
  for (const t of targets) {
    for (const a of t.attempts) {
      const u = a.usage;
      if (!u) continue;
      input += u.inputTokens ?? 0;
      output += u.outputTokens ?? 0;
      total += u.totalTokens ?? 0;
      if (u.cost !== null) cost = (cost ?? 0) + u.cost;
    }
  }
  return { in: input, out: output, total, cost };
}

function boxToString(b: PixelBox | null): string {
  return b ? `{x:${b.x},y:${b.y},w:${b.w},h:${b.h}}` : '(none)';
}

/** Tint product green + logo blue over the image, outline the panel rect red. */
async function writeOverlay(
  imageBytes: Buffer,
  width: number,
  height: number,
  product: Uint8Array,
  logo: Uint8Array,
  panel: PixelBox,
  outPath: string,
): Promise<void> {
  const overlay = Buffer.alloc(width * height * 4, 0);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (product[i]) {
      overlay[o] = 0;
      overlay[o + 1] = 220;
      overlay[o + 2] = 0;
      overlay[o + 3] = 110;
    }
    if (logo[i]) {
      overlay[o] = 0;
      overlay[o + 1] = 120;
      overlay[o + 2] = 255;
      overlay[o + 3] = 140;
    }
  }
  const t = 4;
  const x1 = Math.max(0, Math.round(panel.x));
  const y1 = Math.max(0, Math.round(panel.y));
  const x2 = Math.min(width, Math.round(panel.x + panel.w));
  const y2 = Math.min(height, Math.round(panel.y + panel.h));
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const onBorder = y < y1 + t || y >= y2 - t || x < x1 + t || x >= x2 - t;
      if (!onBorder) continue;
      const o = (y * width + x) * 4;
      overlay[o] = 255;
      overlay[o + 1] = 0;
      overlay[o + 2] = 0;
      overlay[o + 3] = 255;
    }
  }
  await sharp(imageBytes)
    .composite([{ input: overlay, raw: { width, height, channels: 4 } }])
    .png()
    .toFile(outPath);
}

interface FieldCheck {
  field: string;
  pass: boolean;
  detail: string;
}

function isInside(inner: PixelBox, outer: PixelBox): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

async function main(): Promise<void> {
  loadEnvFiles(REPO_ROOT);
  const config = loadModelConfig(process.env);
  const gt = await loadGroundTruth(REPO_ROOT);
  const client = createModelClient(config);

  console.log('=== Kill test: protection masks (SAM 3.1) ===');
  console.log(`model=${config.MODEL_SAM} base=${config.MODEL_API_BASE}`);
  const described = describeModelConfigForLog(config);
  console.log(`key=${described['MODEL_API_KEY']}`);
  console.log('Model API only (read-only). Ground truth is local-only, never sent.\n');

  let allPass = true;
  let apiCalls = 0;
  const allTargets: TargetResult[] = [];

  for (const ad of ADS) {
    const g: AdGroundTruth | undefined = gt.ads[ad];
    if (!g) {
      console.log(`${ad}: NO GROUND TRUTH — FAIL`);
      allPass = false;
      continue;
    }
    const bytes = await readFile(join(REPO_ROOT, g.file));
    const meta = await sharp(bytes).metadata();
    const width = meta.width ?? gt.frame.width;
    const height = meta.height ?? gt.frame.height;
    console.log(`--- ${ad} (${width}x${height}, ${bytes.length} bytes) ---`);

    try {
      const [sparkProductBox, sparkLogoBox] = await Promise.all([
        readSparkBox(ad, 'product_bbox'),
        readSparkBox(ad, 'logo_bbox'),
      ]);
      const product = await segmentTarget(
        client, 'product', PRODUCT_PHRASES, sparkProductBox, { ...g.product_bbox },
        bytes, width, height, config.MODEL_SAM,
      );
      const logo = await segmentTarget(
        client, 'logo', LOGO_PHRASES, sparkLogoBox, { ...g.logo_bbox },
        bytes, width, height, config.MODEL_SAM,
      );
      apiCalls += product.attempts.length + logo.attempts.length;
      allTargets.push(product, logo);

      const productArea = maskArea(product.mask);
      const logoArea = maskArea(logo.mask);
      const productMaskBox = maskBoundingBox(product.mask, width, height);
      const logoMaskBox = maskBoundingBox(logo.mask, width, height);
      const productFill = productMaskBox ? productArea / (productMaskBox.w * productMaskBox.h) : 0;
      const logoFill = logoMaskBox ? logoArea / (logoMaskBox.w * logoMaskBox.h) : 0;
      const productIoU = productMaskBox ? boxIoU(productMaskBox, { ...g.product_bbox }) : 0;

      const protectedMask = dilateMask(unionMasks(product.mask, logo.mask), width, height, DILATE_PX);
      const protectedArea = maskArea(protectedMask);
      const protectedBox = maskBoundingBox(protectedMask, width, height);
      const protectedFill = protectedBox ? protectedArea / (protectedBox.w * protectedBox.h) : 0;
      const panelRect: PixelBox = { ...g.panel.bbox };
      const intersectPx = countMaskInRect(protectedMask, width, height, panelRect);

      const blockers: string[] = [];
      if (productArea === 0) blockers.push('empty product mask');
      if (logoArea === 0) blockers.push('empty logo mask');
      if (protectedArea > 0 && protectedFill < TINY_MASK_FILL) {
        blockers.push(`tiny protected mask (fill ${protectedFill.toFixed(3)} < ${TINY_MASK_FILL})`);
      }
      if (protectedArea === 0) blockers.push('empty protected mask');

      console.log(`  product: ${product.promptUsed} — area=${productArea} bbox=${boxToString(productMaskBox)} latency=${product.totalLatencyMs}ms`);
      console.log(`  logo:    ${logo.promptUsed} — area=${logoArea} bbox=${boxToString(logoMaskBox)} latency=${logo.totalLatencyMs}ms`);
      console.log(`  protected: area=${protectedArea} fill=${protectedFill.toFixed(3)} ∩panel=${intersectPx}px`);
      if (blockers.length > 0) console.log(`  blockers: ${blockers.join('; ')}`);

      const overlayPath = join(REPO_ROOT, 'artifacts', 'killtests', `sam-${ad}.png`);
      await writeOverlay(bytes, width, height, product.mask, logo.mask, panelRect, overlayPath);

      const checks: FieldCheck[] = [];
      checks.push({
        field: 'product IoU>=0.8',
        pass: productIoU >= PRODUCT_IOU_THRESHOLD,
        detail: `IoU=${productIoU.toFixed(3)} mask=${boxToString(productMaskBox)} gt=${boxToString({ ...g.product_bbox })}`,
      });
      checks.push({
        field: 'product fill 0.5-1.0',
        pass: productFill >= 0.5 && productFill <= 1.0,
        detail: `fill=${productFill.toFixed(3)} (area=${productArea})`,
      });
      const logoRegion: PixelBox = {
        x: g.logo_bbox.x - LOGO_REGION_TOLERANCE_PX,
        y: g.logo_bbox.y - LOGO_REGION_TOLERANCE_PX,
        w: g.logo_bbox.w + 2 * LOGO_REGION_TOLERANCE_PX,
        h: g.logo_bbox.h + 2 * LOGO_REGION_TOLERANCE_PX,
      };
      const logoOk = logoArea > 0 && logoMaskBox !== null && isInside(logoMaskBox, logoRegion);
      checks.push({
        field: 'logo in region±20',
        pass: logoOk,
        detail: `mask=${boxToString(logoMaskBox)} fill=${logoFill.toFixed(3)} region=${boxToString(logoRegion)}`,
      });
      checks.push({
        field: 'no quality blocker',
        pass: blockers.length === 0,
        detail: blockers.length === 0 ? 'none' : blockers.join('; '),
      });
      if (ad === 'ad-02-wrong') {
        checks.push({
          field: 'protected∩panel=0',
          pass: intersectPx === 0,
          detail: intersectPx === 0 ? '0 px — repair allowed' : `${intersectPx} px overlap`,
        });
      } else {
        checks.push({
          field: 'protected∩panel>0',
          pass: intersectPx > 0,
          detail:
            intersectPx > 0
              ? `${intersectPx} px — blocker "panel overlaps protected product" (AD_WRONG_UNSAFE geometry)`
              : '0 px — expected overlap missing',
        });
      }

      const artifact = {
        test: 'killtest-sam',
        ad,
        ts: new Date().toISOString(),
        model: config.MODEL_SAM,
        image: describeImage(bytes, width, height),
        targets: {
          product: {
            promptUsed: product.promptUsed,
            totalLatencyMs: product.totalLatencyMs,
            maskArea: productArea,
            maskBox: productMaskBox,
            fill: productFill,
            iouWithGt: productIoU,
            attempts: product.attempts.map((a) => attemptRecord(a, bytes, width, height, config.MODEL_SAM)),
          },
          logo: {
            promptUsed: logo.promptUsed,
            totalLatencyMs: logo.totalLatencyMs,
            maskArea: logoArea,
            maskBox: logoMaskBox,
            fill: logoFill,
            attempts: logo.attempts.map((a) => attemptRecord(a, bytes, width, height, config.MODEL_SAM)),
          },
        },
        protected: {
          dilatePx: DILATE_PX,
          area: protectedArea,
          bbox: protectedBox,
          fill: protectedFill,
          intersectPanelPx: intersectPx,
          blockers,
        },
        panelGt: panelRect,
        overlay: `artifacts/killtests/sam-${ad}.png`,
      };
      const jsonPath = await writeKilltestArtifact(REPO_ROOT, `sam-${ad}.json`, artifact, [config.MODEL_API_KEY]);

      const adPass = checks.every((c) => c.pass);
      allPass = allPass && adPass;
      for (const c of checks) {
        console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.field}: ${c.detail}`);
      }
      console.log(`  artifacts: ${jsonPath}, ${overlayPath}`);
      console.log(`  => ${ad}: ${adPass ? 'PASS' : 'FAIL'}\n`);
    } catch (err) {
      allPass = false;
      const rawOutput = err instanceof SegmentError ? err.rawOutput : '';
      await writeKilltestArtifact(
        REPO_ROOT,
        `sam-${ad}.json`,
        {
          test: 'killtest-sam',
          ad,
          ts: new Date().toISOString(),
          model: config.MODEL_SAM,
          image: describeImage(bytes, width, height),
          error: err instanceof Error ? err.message : String(err),
          rawOutput,
        },
        [config.MODEL_API_KEY],
      );
      console.log(`  [FAIL] segmentation error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  const total = sumUsage(allTargets);
  console.log(`API calls: ${apiCalls}; tokens: in=${total.in} out=${total.out} total=${total.total}`);
  console.log(`Cost: ${total.cost !== null ? total.cost : '(not reported by API)'}`);
  console.log(allPass ? 'SAM KILL TEST: ALL PASS' : 'SAM KILL TEST: FAILURES PRESENT');
  process.exit(allPass ? 0 : 1);
}

await main();
