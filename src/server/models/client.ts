import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import OpenAI from 'openai';
import type { ModelConfig } from '../../shared/config.js';
import { redactText } from '../../shared/masking.js';

/** One OpenAI-compatible client for the Model API (Spark, SAM, ...). */
export function createModelClient(config: ModelConfig): OpenAI {
  return new OpenAI({ apiKey: config.MODEL_API_KEY, baseURL: config.MODEL_API_BASE });
}

export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** Cost as reported by the API, when present (field names vary). */
  cost: number | null;
  raw: unknown;
}

/** Normalize chat- and responses-style usage payloads into one shape. */
export function normalizeUsage(raw: unknown): ModelUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const input = num(u['input_tokens']) ?? num(u['prompt_tokens']);
  const output = num(u['output_tokens']) ?? num(u['completion_tokens']);
  if (input === null && output === null && num(u['total_tokens']) === null) return undefined;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: num(u['total_tokens']) ?? (input !== null && output !== null ? input + output : null),
    cost: num(u['cost']) ?? num(u['cost_usd']) ?? num(u['total_cost']) ?? null,
    raw,
  };
}

/** True for errors worth retrying: 429, 5xx, and transport-level failures. Never 4xx validation errors. */
export function isTransientModelError(err: unknown): boolean {
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    if (status === 429) return true;
    if (typeof status === 'number' && status >= 500) return true;
    return false;
  }
  // Transport failures surface as TypeError('fetch failed ...') from undici.
  if (err instanceof TypeError) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run fn, retrying transient Model API errors twice with backoff (1s, 2s).
 * 4xx validation errors are rethrown immediately — retrying them is pointless.
 */
export async function withModelRetry<T>(fn: () => Promise<T>): Promise<T> {
  const backoffs = [1000, 2000];
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= backoffs.length || !isTransientModelError(err)) throw err;
      await sleep(backoffs[attempt] as number);
      attempt++;
    }
  }
}

/** Measure wall-clock latency of one model call. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; latencyMs: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, latencyMs: Date.now() - start };
}

export function sha256Hex(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface ImageDescriptor {
  sha256: string;
  bytes: number;
  width: number;
  height: number;
}

export function describeImage(bytes: Buffer | Uint8Array, width: number, height: number): ImageDescriptor {
  return { sha256: sha256Hex(bytes), bytes: bytes.length, width, height };
}

/**
 * JSON replacer that swaps embedded image/data blobs for short descriptors,
 * so a raw request that still holds a base64 data URL never lands on disk.
 */
function artifactReplacer(_key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.startsWith('data:image/')) {
    return `[omitted data-url len=${value.length}]`;
  }
  if (value.length > 50000 && /^[A-Za-z0-9+/=\s]+$/.test(value)) {
    return `[omitted base64 len=${value.length}]`;
  }
  return value;
}

/**
 * Write one raw request/response record to artifacts/killtests/<name>.json.
 * Secrets are redacted and image blobs replaced; artifacts/ is gitignored.
 */
export async function writeKilltestArtifact(
  repoRoot: string,
  name: string,
  payload: unknown,
  secrets: Array<string | undefined | null>,
): Promise<string> {
  const dir = join(repoRoot, 'artifacts', 'killtests');
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  const json = redactText(JSON.stringify(payload, artifactReplacer, 2), secrets);
  await writeFile(path, json + '\n', 'utf8');
  return path;
}
