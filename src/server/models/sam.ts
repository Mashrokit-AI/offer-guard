import OpenAI from 'openai';
import {
  buildObjectPrompt,
  decodeMaskToRaster,
  parseImageStream,
  recordsOfKind,
  type ResponsesEvent,
  type SegmentationDiagnostic,
} from '@meta-sam/parser';
import {
  boundsToBox,
  placeRasterInFrame,
  unionMasks,
  type MaskBounds,
  type PixelBox,
} from '../../shared/geometry.js';
import { normalizeUsage, timed, withModelRetry, type ModelUsage } from './client.js';

export interface SegmentInput {
  imageBytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
  model: string;
  /** Noun phrase ("bottle") or object-prompt text from buildBoxPromptText. Never combined. */
  inputText: string;
}

export interface SegmentDiagnostic {
  severity: string;
  code: string;
  message: string;
  line: number;
}

export interface SegmentResult {
  /** Full-frame binary mask: union of every mask record, in actual image pixels. */
  mask: Uint8Array;
  boxes: PixelBox[];
  diagnostics: SegmentDiagnostic[];
  rawOutput: string;
  outcomeStatus: string;
  outcomeReason: string | null;
  /** Frame size the API reported on the wire (should equal the image size). */
  reportedFrame: { w: number; h: number }[];
  latencyMs: number;
  usage: ModelUsage | undefined;
}

export class SegmentError extends Error {
  constructor(
    message: string,
    readonly rawOutput: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'SegmentError';
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/**
 * Build object-prompt input_text for one box (half-open PixelBox), clamped into
 * the frame. Throws when the clamped box is empty.
 */
export function buildBoxPromptText(box: PixelBox, frameW: number, frameH: number, objectId = 1): string {
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y) || box.w <= 0 || box.h <= 0) {
    throw new Error(`Cannot build a box prompt from an empty box ${JSON.stringify(box)}`);
  }
  const left = Math.min(Math.max(0, Math.round(box.x)), frameW - 1);
  const top = Math.min(Math.max(0, Math.round(box.y)), frameH - 1);
  const right = Math.min(Math.max(left + 1, Math.round(box.x + box.w)), frameW);
  const bottom = Math.min(Math.max(top + 1, Math.round(box.y + box.h)), frameH);
  return buildObjectPrompt({
    size: { width: frameW, height: frameH },
    objects: [{ id: objectId, prompts: [{ box: { left, top, right, bottom } }] }],
  });
}

/** Frame sizes the API reported on the wire (from `;w=..;h=..` in box tokens). */
export function reportedFrameSizes(rawOutput: string): { w: number; h: number }[] {
  const seen = new Map<string, { w: number; h: number }>();
  for (const m of rawOutput.matchAll(/;w=(\d+);h=(\d+)/g)) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    seen.set(`${w}x${h}`, { w, h });
  }
  return [...seen.values()];
}

async function* tapStream<T>(source: AsyncIterable<T>, onEvent: (event: T) => void): AsyncIterable<T> {
  for await (const event of source) {
    onEvent(event);
    yield event;
  }
}

function usageFromEvent(event: unknown): ModelUsage | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const e = event as Record<string, unknown>;
  if (e['type'] !== 'response.completed' && e['type'] !== 'response.incomplete') return undefined;
  const response = e['response'];
  if (!response || typeof response !== 'object') return undefined;
  return normalizeUsage((response as Record<string, unknown>)['usage']);
}

/**
 * Place one decoded raster given in reported-frame space into an actual-frame
 * mask. Falls back to nearest-coordinate mapping when the API reported a
 * frame size different from the real image size.
 */
function placeRaster(
  raster: Uint8Array,
  rasterW: number,
  rasterH: number,
  bounds: MaskBounds,
  reportedW: number,
  reportedH: number,
  frameW: number,
  frameH: number,
): Uint8Array {
  if (reportedW === frameW && reportedH === frameH) {
    return placeRasterInFrame(raster, rasterW, rasterH, bounds, frameW, frameH);
  }
  const frame = new Uint8Array(frameW * frameH);
  for (let ry = 0; ry < rasterH; ry++) {
    for (let rx = 0; rx < rasterW; rx++) {
      if (!raster[ry * rasterW + rx]) continue;
      const fx = Math.round(((bounds.left + rx) * frameW) / reportedW);
      const fy = Math.round(((bounds.top + ry) * frameH) / reportedH);
      if (fx < 0 || fx >= frameW || fy < 0 || fy >= frameH) continue;
      frame[fy * frameW + fx] = 1;
    }
  }
  return frame;
}

/**
 * Segment one image with one prompt (noun phrase OR box-prompt text).
 * Streams the Responses API and parses with @meta-sam/parser. Zero matches
 * is a valid empty result, not an error.
 */
export async function segment(client: OpenAI, input: SegmentInput): Promise<SegmentResult> {
  const dataUrl = `data:${input.mimeType};base64,${input.imageBytes.toString('base64')}`;
  const requestBody = {
    model: input.model,
    stream: true as const,
    input: [
      {
        role: 'user' as const,
        content: [
          { type: 'input_text' as const, text: input.inputText },
          { type: 'input_image' as const, image_url: dataUrl, detail: 'high' as const },
        ],
      },
    ],
  };

  let usage: ModelUsage | undefined;
  const run = async () => {
    const stream = await client.responses.create(requestBody);
    const tapped = tapStream(stream as unknown as AsyncIterable<ResponsesEvent>, (event) => {
      usage = usageFromEvent(event) ?? usage;
    });
    return parseImageStream(tapped).finalResult;
  };

  let result: Awaited<ReturnType<typeof run>>;
  let latencyMs: number;
  try {
    ({ result, latencyMs } = await timed(() => withModelRetry(run)));
  } catch (err) {
    const detail = err instanceof Error ? `${err.message}${err.cause instanceof Error ? ` (cause: ${err.cause.message})` : ''}` : String(err);
    throw new SegmentError(`SAM request failed: ${detail}`, '', { cause: err });
  }

  const rawOutput = result.rawOutput;
  const reported = reportedFrameSizes(rawOutput);
  const reportedW = reported[0]?.w ?? input.width;
  const reportedH = reported[0]?.h ?? input.height;

  let mask: Uint8Array = new Uint8Array(input.width * input.height);
  const masks = recordsOfKind(result.records, 'mask');
  try {
    for (const record of masks) {
      const raster = decodeMaskToRaster(record.mask);
      const placed = placeRaster(
        raster,
        record.mask.width,
        record.mask.height,
        record.bounds,
        reportedW,
        reportedH,
        input.width,
        input.height,
      );
      mask = unionMasks(mask, placed);
    }
  } catch (err) {
    throw new SegmentError(`SAM mask decode failed: ${err instanceof Error ? err.message : String(err)}`, rawOutput, { cause: err });
  }

  const boxes = recordsOfKind(result.records, 'box').map((r) =>
    boundsToBox({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }),
  );
  const diagnostics: SegmentDiagnostic[] = result.diagnostics.map((d: SegmentationDiagnostic) => ({
    severity: d.severity,
    code: d.code,
    message: d.message,
    line: d.line,
  }));

  return {
    mask,
    boxes,
    diagnostics,
    rawOutput,
    outcomeStatus: result.outcome.status,
    outcomeReason:
      result.outcome.status === 'incomplete'
        ? `${result.outcome.reason}${result.outcome.detail ? `: ${result.outcome.detail}` : ''}`
        : null,
    reportedFrame: reported,
    latencyMs,
    usage,
  };
}
