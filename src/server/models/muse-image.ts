import { timed, withModelRetry } from './client.js';

/**
 * Muse Image via the Model API (plain fetch — not the OpenAI SDK shape).
 *
 * Verified behavior (do not re-research without cause):
 * - POST {base}/images/edits, JSON body {model, prompt, size:"WxH",
 *   images:[{image_url:"data:image/png;base64,..."}], output_format:"png",
 *   reasoning_strength:"low"|"high"}. Up to 10 input images.
 * - `size` sets the ASPECT RATIO only (1080x1920 came back 1152x2048) —
 *   callers must resize/crop to the exact size in code and verify.
 * - `mask`, `enable_web_search`, `enable_image_search` → 400 on edits.
 * - ~16–18 s per image, $0.01.
 */

export interface ImageGenConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ImageEditInput {
  prompt: string;
  /** "WxH" — aspect ratio hint; the real size is fixed in code afterwards. */
  size: string;
  images: Array<{ bytes: Buffer; mimeType: string }>;
  reasoningStrength: 'low' | 'high';
}

export interface ImageResult {
  png: Buffer;
  latencyMs: number;
  /** Wire size the model actually returned (before our exact-size fix). */
  returnedBytes: number;
}

export class ImageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'ImageError';
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

function dataUrl(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

/**
 * Pull image bytes out of the response. The wire shape has varied between
 * model releases, so accept every shape seen so far instead of guessing one:
 * data[0].b64_json, data[0].url (fetched), images[0] (b64 or data URL),
 * output[0], or a top-level b64_json / image_base64 string.
 */
export async function extractImageBytes(payload: unknown, fetchUrl: (url: string) => Promise<Buffer>): Promise<Buffer> {
  const asB64 = (v: unknown): Buffer | null => {
    if (typeof v !== 'string' || v.length < 100) return null;
    const b64 = v.startsWith('data:image/') ? (v.split(',', 2)[1] ?? '') : v;
    if (!b64 || b64.length < 100 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) return null;
    try {
      const buf = Buffer.from(b64.replace(/\s/g, ''), 'base64');
      return buf.length > 100 ? buf : null;
    } catch {
      return null;
    }
  };
  if (typeof payload === 'string') {
    const direct = asB64(payload);
    if (direct) return direct;
  }
  if (!payload || typeof payload !== 'object') throw new Error('empty image response');
  const p = payload as Record<string, unknown>;
  for (const key of ['b64_json', 'image_base64', 'image']) {
    const direct = asB64(p[key]);
    if (direct) return direct;
  }
  for (const key of ['data', 'images', 'output']) {
    const arr = p[key];
    if (Array.isArray(arr) && arr.length > 0) {
      const first = arr[0] as unknown;
      const direct = asB64(typeof first === 'string' ? first : (first as Record<string, unknown> | null)?.['b64_json'] ?? (first as Record<string, unknown> | null)?.['image_base64']);
      if (direct) return direct;
      const url = (first as Record<string, unknown> | null)?.['url'];
      if (typeof url === 'string' && /^https?:\/\//.test(url)) {
        return fetchUrl(url);
      }
      if (first && typeof first === 'object') {
        for (const v of Object.values(first as Record<string, unknown>)) {
          const nested = asB64(v);
          if (nested) return nested;
        }
      }
    }
  }
  throw new Error(`unrecognized image response shape (keys: ${Object.keys(p).join(',')})`);
}

async function postImages(
  cfg: ImageGenConfig,
  path: 'images/edits' | 'images/generations',
  body: Record<string, unknown>,
): Promise<ImageResult> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/${path}`;
  const { result, latencyMs } = await timed(() =>
    withModelRetry(async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`POST ${path} → HTTP ${res.status}: ${text.slice(0, 500)}`);
        // Retry transient failures the same way as chat calls.
        if (res.status === 429 || res.status >= 500) throw new TypeError(`fetch failed: ${err.message}`);
        throw err;
      }
      return (await res.json()) as unknown;
    }),
  );
  const png = await extractImageBytes(result, async (u) => {
    const res = await fetch(u);
    if (!res.ok) throw new ImageError(`image url fetch → HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }).catch((err: unknown) => {
    throw new ImageError(`Could not read the image from the ${path} response: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  });
  return { png, latencyMs, returnedBytes: png.length };
}

/** Edit / recompose: one prompt + up to 10 reference images. */
export async function editImages(cfg: ImageGenConfig, input: ImageEditInput): Promise<ImageResult> {
  if (input.images.length === 0 || input.images.length > 10) {
    throw new ImageError(`edits needs 1–10 input images, got ${input.images.length}`);
  }
  return postImages(cfg, 'images/edits', {
    model: cfg.model,
    prompt: input.prompt,
    size: input.size,
    images: input.images.map((i) => ({ image_url: dataUrl(i.bytes, i.mimeType) })),
    output_format: 'png',
    reasoning_strength: input.reasoningStrength,
  });
}

/** Text-to-image (used once to create the synthetic NOA fixture). */
export async function generateImage(cfg: ImageGenConfig, prompt: string, size: string): Promise<ImageResult> {
  return postImages(cfg, 'images/generations', {
    model: cfg.model,
    prompt,
    size,
    output_format: 'png',
  });
}
