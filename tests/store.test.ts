import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/server/store/db.js';
import { sweepCacheKey, type CacheKeyInput } from '../src/server/store/cache.js';

const BASE_KEY: CacheKeyInput = {
  imageBytes: Buffer.from('fake-png-bytes'),
  copy: 'some copy',
  landingUrl: 'http://127.0.0.1:1/gali-offer-he.html',
  specVersion: 1,
  models: 'muse-spark-1.3+sam-3.1',
  promptVersions: 'extract-ad-v1+extract-page-v1+panel-v1',
};

describe('sweep cache key', () => {
  it('is a stable sha256 hex', () => {
    const a = sweepCacheKey(BASE_KEY);
    const b = sweepCacheKey({ ...BASE_KEY, imageBytes: Buffer.from('fake-png-bytes') });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any input changes', () => {
    const base = sweepCacheKey(BASE_KEY);
    const variants: CacheKeyInput[] = [
      { ...BASE_KEY, imageBytes: Buffer.from('other-bytes') },
      { ...BASE_KEY, copy: 'other copy' },
      { ...BASE_KEY, landingUrl: 'http://127.0.0.1:1/other.html' },
      { ...BASE_KEY, specVersion: 2 },
      { ...BASE_KEY, models: 'other-model' },
      { ...BASE_KEY, promptVersions: 'extract-ad-v2+extract-page-v1+panel-v1' },
    ];
    for (const v of variants) expect(sweepCacheKey(v)).not.toBe(base);
  });
});

describe('store', () => {
  let store: Store | null = null;
  afterEach(() => {
    store?.close();
    store = null;
  });

  function openTmp(): { store: Store; dbPath: string } {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'og-store-')), 'test.db');
    store = Store.open(dbPath);
    return { store, dbPath };
  }

  it('round-trips a run: snapshot, capture, claims, findings, repair, trace', () => {
    const { store: s } = openTmp();
    s.upsertSpec(1, '{"version":1}');
    const runId = s.createRun({ manifestPath: 'fixtures/campaign.json', fresh: true, pagesBase: 'http://x/', specVersion: 1 });
    const snapId = s.insertSnapshot({
      run_id: runId,
      ad_key: 'ad-01/he',
      image_sha256: 'abc',
      image_bytes: 10,
      copy: 'copy',
      landing_url: 'http://x/p.html',
      cache_key: 'key-1',
      capture_time: '2026-10-29T00:00:00.000Z',
      original_capture_time: null,
      verdict: 'CLEAN',
      expected: 'CLEAN',
      pass: 1,
      cached: 0,
      latency_ms: 5,
      model_calls: 2,
    });
    s.insertCapture({ snapshotId: snapId, requestedUrl: 'http://x/p.html', finalUrl: 'http://x/p.html', captureTime: '2026-10-29T00:00:00.000Z', screenshotPaths: ['a.png'], chunksJson: '[]' });
    s.insertClaim({ snapshotId: snapId, source: 'ad', field: 'percent', normalized: '20%', verbatim: '20%', evidenceId: 'ad:discount' });
    s.insertFinding({ snapshotId: snapId, kind: 'contradiction', side: 'ad', field: 'percent', specValue: '20%', observedValue: '30%', evidenceIds: ['ad:discount'], detail: 'd' });
    s.insertRepairArtifact({ snapshotId: snapId, beforeSha256: 'a', afterSha256: 'b', digest: 'd', proofJson: '{}', revalidationJson: '{}', artifactDir: 'artifacts/x' });
    s.insertTrace({ snapshotId: snapId, seq: 1, step: 'snapshot', toolOrModel: 'code', inputSummary: 'i', outputSummary: 'o', durationMs: 1, evidenceIds: [], nextState: 'extract_ad', cached: false });
    s.finishRun(runId);

    const hit = s.findByCacheKey('key-1');
    expect(hit?.snapshot.verdict).toBe('CLEAN');
    expect(hit?.capture?.final_url).toBe('http://x/p.html');
    expect(hit?.claims).toHaveLength(1);
    expect(hit?.findings).toHaveLength(1);
    expect(s.findByCacheKey('nope')).toBeNull();
  });
});
