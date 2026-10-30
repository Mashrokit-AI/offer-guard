import { createHash } from 'node:crypto';

export interface CacheKeyInput {
  imageBytes: Buffer;
  copy: string;
  landingUrl: string;
  specVersion: number;
  /** Model ids that feed the result (extract + SAM), joined by the caller. */
  models: string;
  /** Prompt/template versions (extract-ad + extract-page + panel), joined by the caller. */
  promptVersions: string;
}

/**
 * Sweep cache key: sha256 over the exact inputs. Length-prefixed parts so
 * no two different input tuples share a key. Any prompt/template/model/spec
 * change invalidates the cache.
 */
export function sweepCacheKey(input: CacheKeyInput): string {
  const h = createHash('sha256');
  const part = (b: Buffer): void => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    h.update(len);
    h.update(b);
  };
  part(input.imageBytes);
  part(Buffer.from(input.copy, 'utf8'));
  part(Buffer.from(input.landingUrl, 'utf8'));
  part(Buffer.from(String(input.specVersion), 'utf8'));
  part(Buffer.from(input.models, 'utf8'));
  part(Buffer.from(input.promptVersions, 'utf8'));
  return h.digest('hex');
}
