import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRepoRoot } from '../src/shared/env.js';
import { STRINGS } from '../src/shared/i18n.js';
import { adClaimsSchema, pageClaimsSchema } from '../src/shared/schemas.js';
import { Store } from '../src/server/store/db.js';
import type { SweepOptions, SweepReport, SweepRow } from '../src/server/workflow/sweep.js';
import { createApp } from '../src/server/http/app.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const SPEC_JSON = readFileSync(join(REPO_ROOT, 'fixtures', 'ads', 'offer-spec.json'), 'utf8');

function adJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify(
    adClaimsSchema.parse({
      language: 'en',
      offer_texts: [{ text: '30% OFF EVERYTHING', bbox: { x: 100, y: 100, w: 400, h: 120 }, in_panel: true }],
      discount: { percent: 30, scope: 'all', verbatim: '30% OFF EVERYTHING' },
      shipping: { terms: 'free', verbatim: 'FREE SHIPPING' },
      valid_until: { day_month: '10.11', verbatim: 'UNTIL 10.11' },
      panel: { bbox: { x: 90, y: 90, w: 420, h: 300 }, opaque: true },
      product_bbox: { x: 500, y: 300, w: 300, h: 500 },
      logo_bbox: { x: 60, y: 900, w: 200, h: 100 },
      unreadable: [],
      ...over,
    }),
  );
}

function pageJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify(
    pageClaimsSchema.parse({
      discount: { percent: 20, scope: 'selected_models', verbatim: '20% off selected models' },
      shipping: { terms: 'paid', verbatim: 'shipping paid at checkout' },
      valid_until: { day_month: '10.11', verbatim: 'valid until 10.11' },
      quotes: [{ text: '20% off selected models', chunk_ids: ['c1'] }],
      ...over,
    }),
  );
}

interface Seed {
  dbPath: string;
  runId: number;
  cleanId: number;
  repairId: number;
  ambId: number;
}

function seedDb(dbPath: string): Seed {
  const store = Store.open(dbPath);
  try {
    store.upsertSpec(1, SPEC_JSON);
    const runId = store.createRun({ manifestPath: 'fixtures/campaign.json', fresh: false, pagesBase: 'http://127.0.0.1:8901', specVersion: 1 });
    const snap = (adKey: string, verdict: string, cached: number, modelCalls: number): number =>
      store.insertSnapshot({
        run_id: runId, ad_key: adKey, image_sha256: 'abc', image_bytes: 10, copy: 'copy', landing_url: 'http://127.0.0.1:8901/gali-offer-en.html',
        cache_key: `k-${adKey}`, capture_time: '2026-10-29T21:37:34.540Z', original_capture_time: null,
        verdict, expected: verdict, pass: 1, cached, latency_ms: 5, model_calls: modelCalls,
      });
    const cleanId = snap('ad-01/en', 'CLEAN', 0, 2);
    store.insertSource(cleanId, 'fixtures/ads/ad-01-clean-en.png');
    // ad claims agree with spec; page agrees too.
    for (const [source, field, normalized, verbatim] of [
      ['ad', 'percent', '20%', '20% OFF'], ['ad', 'scope', 'selected_models', 'SELECTED'], ['ad', 'shipping', 'paid', 'PAID SHIP'], ['ad', 'valid_until', '10.11', 'UNTIL 10.11'],
      ['page', 'percent', '20%', '20% off'], ['page', 'scope', 'selected_models', 'selected'], ['page', 'shipping', 'paid', 'paid'], ['page', 'valid_until', '10.11', 'until 10.11'],
    ] as const) {
      store.insertClaim({ snapshotId: cleanId, source, field, normalized, verbatim, evidenceId: `${source}:${field}` });
    }
    store.insertCapture({
      snapshotId: cleanId, requestedUrl: 'http://127.0.0.1:8901/gali-offer-en.html', finalUrl: 'http://127.0.0.1:8901/gali-offer-en.html',
      captureTime: '2026-10-29T21:37:34.540Z', screenshotPaths: ['fixtures/ads/ad-01-clean-en.png'],
      chunksJson: JSON.stringify([{ id: 'c1', text: '20% off selected models', bounds: { x: 10, y: 20, w: 300, h: 40 } }]),
    });
    store.insertTrace({ snapshotId: cleanId, seq: 1, step: 'extract_ad', toolOrModel: 'model:muse-spark-1.3', inputSummary: 'img', outputSummary: 'ok', durationMs: 3, evidenceIds: [], nextState: 'done', cached: false });

    const repairId = snap('ad-02/en', 'AD_WRONG_REPAIRABLE', 0, 6);
    store.insertSource(repairId, 'fixtures/ads/ad-02-wrong-en.png');
    store.insertEvidence(repairId, adJson(), pageJson());
    for (const [source, field, normalized, verbatim] of [
      ['ad', 'percent', '30%', '30% OFF'], ['ad', 'scope', 'all', 'EVERYTHING'], ['ad', 'shipping', 'free', 'FREE'], ['ad', 'valid_until', '10.11', 'UNTIL 10.11'],
      ['page', 'percent', '20%', '20% off'], ['page', 'scope', 'selected_models', 'selected'], ['page', 'shipping', 'paid', 'paid'], ['page', 'valid_until', '10.11', 'until 10.11'],
    ] as const) {
      store.insertClaim({ snapshotId: repairId, source, field, normalized, verbatim, evidenceId: `${source}:${field}` });
    }
    store.insertCapture({
      snapshotId: repairId, requestedUrl: 'http://127.0.0.1:8901/gali-offer-en.html', finalUrl: 'http://127.0.0.1:8901/gali-offer-en.html',
      captureTime: '2026-10-29T21:37:34.540Z', screenshotPaths: ['fixtures/ads/ad-01-clean-en.png'],
      chunksJson: JSON.stringify([{ id: 'c1', text: '20% off selected models', bounds: { x: 10, y: 20, w: 300, h: 40 } }]),
    });
    store.insertTrace({ snapshotId: repairId, seq: 1, step: 'extract_ad', toolOrModel: 'model:muse-spark-1.3', inputSummary: 'img', outputSummary: 'ok', durationMs: 3, evidenceIds: [], nextState: 'repair', cached: false });
    store.insertTrace({ snapshotId: repairId, seq: 2, step: 'repair_masks', toolOrModel: 'model:sam-3.1', inputSummary: 'masks', outputSummary: 'ok', durationMs: 4, evidenceIds: [], nextState: 'done', cached: false });

    const ambId = snap('ad-05/he', 'AMBIGUOUS', 1, 0);
    store.insertSource(ambId, 'fixtures/ads/ad-05-ambiguous.png');
    for (const [source, field, normalized, verbatim] of [
      ['ad', 'percent', '20%', '20%'], ['ad', 'scope', 'unspecified', ''], ['ad', 'shipping', 'paid', 'paid'], ['ad', 'valid_until', '10.11', '10.11'],
      ['page', 'percent', '20%', '20%'], ['page', 'scope', 'selected_models', 'selected'], ['page', 'shipping', 'paid', 'paid'], ['page', 'valid_until', '10.11', '10.11'],
    ] as const) {
      store.insertClaim({ snapshotId: ambId, source, field, normalized, verbatim, evidenceId: `${source}:${field}` });
    }
    store.finishRun(runId);
    return { dbPath, runId, cleanId, repairId, ambId };
  } finally {
    store.close();
  }
}

async function pngBuffer(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
}

function stubSweep(impl: (opts: SweepOptions) => Promise<SweepReport>): (opts: SweepOptions) => Promise<SweepReport> {
  return impl;
}

function fakeReport(runId: number): SweepReport {
  return { runId, rows: [], allPass: true, totalCalls: 0, totalLatencyMs: 0, usage: { in: 0, out: 0, total: 0 }, pagesBase: 'http://127.0.0.1:8901' };
}

let tmpDirs: string[] = [];
let uploadDirsBefore: Set<string> = new Set();

function webRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'og-webroot-'));
  tmpDirs.push(dir);
  writeFileSync(join(dir, 'index.html'), '<html>hi</html>');
  return dir;
}

function listUploads(): Set<string> {
  try {
    return new Set(readdirSync(join(REPO_ROOT, 'data', 'uploads')));
  } catch {
    return new Set();
  }
}

beforeEach(() => {
  uploadDirsBefore = listUploads();
});

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  // Remove uploads created by the test (never touch pre-existing ones).
  const after = listUploads();
  for (const e of after) {
    if (!uploadDirsBefore.has(e)) rmSync(join(REPO_ROOT, 'data', 'uploads', e), { recursive: true, force: true });
  }
});

describe('read API', () => {
  it('serves campaign shape with spec, run and per-ad rows', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    const dbPath = join(db, 't.db');
    seedDb(dbPath);
    const app = createApp({ repoRoot: REPO_ROOT, dbPath, webRoot: webRoot(), makeClient: () => ({}) as never });
    const res = await app.request('/api/campaign');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, never>;
    expect((body.spec as { version: number }).version).toBe(1);
    expect((body.run as { mode: string }).mode).toBe('cached');
    expect((body.run as { countsByVerdict: Record<string, number> }).countsByVerdict).toMatchObject({ CLEAN: 1, AD_WRONG_REPAIRABLE: 1, AMBIGUOUS: 1 });
    const ads = body.ads as Array<Record<string, unknown>>;
    expect(ads).toHaveLength(3);
    for (const a of ads) {
      expect(a).toHaveProperty('id');
      expect(a).toHaveProperty('lang');
      expect(a).toHaveProperty('verdict');
      expect(a).toHaveProperty('reason');
      expect((a.reason as { key: string }).key).toMatch(/^[a-z_0-9]+$/);
      expect(a).toHaveProperty('cached');
      expect(a).toHaveProperty('captureTime');
      expect(a.thumb).toBe(`media/thumb/${String(a.id)}`);
    }
  });

  it('serves ad detail with comparisons, question, repair refs and trace', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    const dbPath = join(db, 't.db');
    const seed = seedDb(dbPath);
    const app = createApp({ repoRoot: REPO_ROOT, dbPath, webRoot: webRoot(), makeClient: () => ({}) as never });
    const res = await app.request(`/api/ads/${seed.repairId}`);
    expect(res.status).toBe(200);
    const d = (await res.json()) as Record<string, never>;
    expect((d.snapshot as { verdict: string }).verdict).toBe('AD_WRONG_REPAIRABLE');
    expect((d.comparisons as unknown[])).toHaveLength(4);
    expect((d.adClaims as { hasGeometry: boolean }).hasGeometry).toBe(true);
    expect(((d.adClaims as { offerTexts: unknown[] }).offerTexts)).toHaveLength(1);
    expect((d.pageClaims as { quotes: unknown[] }).quotes).toHaveLength(1);
    expect((d.trace as unknown[])).toHaveLength(2);
    expect((d.explain as { key: string }).key).toBe('explain_repaired');
    // No repair row seeded → repair is null (honest absence).
    expect(d.repair).toBeNull();
  });

  it('asks one focused question for AMBIGUOUS (key + vars, not English)', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    const dbPath = join(db, 't.db');
    const seed = seedDb(dbPath);
    const app = createApp({ repoRoot: REPO_ROOT, dbPath, webRoot: webRoot(), makeClient: () => ({}) as never });
    const d = (await (await app.request(`/api/ads/${seed.ambId}`)).json()) as Record<string, never>;
    expect(d.question).toMatchObject({ key: 'ambiguous_question', vars: { side: 'side_ad', field: 'field_scope' } });
  });

  it('serves run traces grouped by snapshot', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    const dbPath = join(db, 't.db');
    const seed = seedDb(dbPath);
    const app = createApp({ repoRoot: REPO_ROOT, dbPath, webRoot: webRoot(), makeClient: () => ({}) as never });
    const res = await app.request(`/api/runs/${seed.runId}/trace`);
    expect(res.status).toBe(200);
    const t = (await res.json()) as { snapshots: Array<{ events: unknown[] }> };
    expect(t.snapshots).toHaveLength(3);
  });

  it('404s unknown records with an i18n key and no stack', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    seedDb(join(db, 't.db'));
    const app = createApp({ repoRoot: REPO_ROOT, dbPath: join(db, 't.db'), webRoot: webRoot(), makeClient: () => ({}) as never });
    for (const p of ['/api/ads/9999', '/api/ads/abc', '/api/runs/9999/trace', '/api/nope', '/media/ad/9999']) {
      const res = await app.request(p);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'err_not_found' });
    }
  });
});

describe('base path', () => {
  it('serves everything under OFFER_GUARD_BASE_PATH', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    seedDb(join(db, 't.db'));
    const app = createApp({
      repoRoot: REPO_ROOT, dbPath: join(db, 't.db'), webRoot: webRoot(),
      http: { basePath: '/offer-guard/' }, makeClient: () => ({}) as never,
    });
    expect((await app.request('/offer-guard/api/campaign')).status).toBe(200);
    expect((await app.request('/offer-guard/')).status).toBe(200);
    expect((await app.request('/api/campaign')).status).toBe(404);
  });
});

describe('media', () => {
  it('serves ad images and thumbnails by record id', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    const dbPath = join(db, 't.db');
    const seed = seedDb(dbPath);
    const app = createApp({ repoRoot: REPO_ROOT, dbPath, webRoot: webRoot(), makeClient: () => ({}) as never });
    const ad = await app.request(`/media/ad/${seed.cleanId}`);
    expect(ad.status).toBe(200);
    expect(ad.headers.get('content-type')).toBe('image/png');
    const th = await app.request(`/media/thumb/${seed.cleanId}`);
    expect(th.status).toBe(200);
    expect(th.headers.get('content-type')).toBe('image/png');
    const cap = await app.request(`/media/pagecap/${seed.cleanId}?shot=0`);
    expect(cap.status).toBe(200);
    expect((await app.request(`/media/pagecap/${seed.cleanId}?shot=3`)).status).toBe(404);
  });

  it('blocks path traversal, encoded tricks and escaping symlinks', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    const dbPath = join(db, 't.db');
    const seed = seedDb(dbPath);
    // Capture screenshot inside the gitignored artifacts dir for the symlink test.
    const artDir = join(REPO_ROOT, 'artifacts', 'test-web');
    mkdirSync(artDir, { recursive: true });
    tmpDirs.push(artDir);
    const outside = join(tmpdir(), `og-outside-${Date.now()}.png`);
    writeFileSync(outside, 'NOT AN IMAGE');
    const link = join(artDir, 'evil.png');
    try {
      symlinkSync(outside, link);
    } catch {
      // Filesystem without symlink support: skip the symlink leg.
    }
    const store = Store.open(dbPath);
    try {
      store.insertSource(seed.cleanId, '../../etc/passwd');
      store.insertSource(seed.repairId, 'artifacts/test-web/evil.png');
      store.insertSnapshot({
        run_id: seed.runId, ad_key: 'ad-09/en', image_sha256: 'x', image_bytes: 1, copy: '', landing_url: '',
        cache_key: 'k3', capture_time: new Date().toISOString(), original_capture_time: null,
        verdict: 'CLEAN', expected: 'CLEAN', pass: 1, cached: 0, latency_ms: 1, model_calls: 0,
      });
      const extra = store.getSnapshots(seed.runId).find((s) => s.ad_key === 'ad-09/en');
      if (extra) store.insertSource(extra.id, '/etc/passwd');
    } finally {
      store.close();
    }
    const app = createApp({ repoRoot: REPO_ROOT, dbPath, webRoot: webRoot(), makeClient: () => ({}) as never });
    expect((await app.request(`/media/ad/${seed.cleanId}`)).status).toBe(404);
    expect((await app.request(`/media/ad/${seed.repairId}`)).status).toBe(404);
    expect((await app.request('/media/ad/..%2f..%2fetc%2fpasswd')).status).toBe(404);
    expect((await app.request('/media/ad/%2e%2e')).status).toBe(404);
  });

  it('serves repair files and generates the diff only from stored inputs', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    const dbPath = join(db, 't.db');
    const seed = seedDb(dbPath);
    const rdir = join(REPO_ROOT, 'artifacts', 'test-web', 'repair');
    mkdirSync(rdir, { recursive: true });
    tmpDirs.push(join(REPO_ROOT, 'artifacts', 'test-web'));
    const before = await pngBuffer(32, 32);
    const after = await sharp(before).composite([{ input: await pngBuffer(4, 4), left: 2, top: 2 }]).png().toBuffer();
    writeFileSync(join(rdir, 'before.png'), before);
    await sharp(after).toFile(join(rdir, 'after.png'));
    writeFileSync(join(rdir, 'proof.json'), JSON.stringify({ rect: { x: 0, y: 0, w: 32, h: 32 } }));
    await sharp(Buffer.alloc(32 * 32, 0), { raw: { width: 32, height: 32, channels: 1 } }).png().toFile(join(rdir, 'mask-protected.png'));
    await sharp(Buffer.alloc(32 * 32, 0), { raw: { width: 32, height: 32, channels: 1 } }).png().toFile(join(rdir, 'mask-product.png'));
    await sharp(Buffer.alloc(32 * 32, 0), { raw: { width: 32, height: 32, channels: 1 } }).png().toFile(join(rdir, 'mask-logo.png'));
    const store = Store.open(dbPath);
    try {
      store.insertRepairArtifact({
        snapshotId: seed.repairId, beforeSha256: 'b', afterSha256: 'a', digest: 'd:spec-v1',
        proofJson: JSON.stringify({ changed_outside_rect: 0, changed_inside_protected: 0, max_channel_diff_outside: 0, pass: true }),
        revalidationJson: JSON.stringify({ pass: true, checks: [] }),
        artifactDir: 'artifacts/test-web/repair',
      });
    } finally {
      store.close();
    }
    const app = createApp({ repoRoot: REPO_ROOT, dbPath, webRoot: webRoot(), makeClient: () => ({}) as never });
    expect((await app.request(`/media/before/${seed.repairId}`)).status).toBe(200);
    expect((await app.request(`/media/after/${seed.repairId}`)).status).toBe(200);
    expect((await app.request(`/media/mask-product/${seed.repairId}`)).status).toBe(200);
    const diff = await app.request(`/media/diff/${seed.repairId}`);
    expect(diff.status).toBe(200);
    expect(diff.headers.get('content-type')).toBe('image/png');
    // Missing inputs → honest 404, not a crash.
    expect((await app.request(`/media/diff/${seed.cleanId}`)).status).toBe(404);
  });
});

describe('live-job guards', () => {
  function instantSweep(dbPath: string, runIdHolder: { id: number }): (opts: SweepOptions) => Promise<SweepReport> {
    return stubSweep(async (opts) => {
      const store = Store.open(dbPath);
      try {
        const runId = store.createRun({ manifestPath: 'fixtures/campaign.json', fresh: true, pagesBase: 'x', specVersion: 1 });
        store.finishRun(runId);
        runIdHolder.id = runId;
      } finally {
        store.close();
      }
      opts.onRow?.({ ad: 'ad-01', lang: 'en', expected: '', got: 'CLEAN', pass: true, cached: false, latencyMs: 1, modelCalls: 0 });
      return fakeReport(runIdHolder.id);
    });
  }

  it('kill switch refuses fresh runs but keeps reads working', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    const dbPath = join(db, 't.db');
    seedDb(dbPath);
    const app = createApp({
      repoRoot: REPO_ROOT, dbPath, webRoot: webRoot(), http: { live: false },
      makeClient: () => ({}) as never, runSweepFn: instantSweep(dbPath, { id: 0 }),
    });
    const post = await app.request('/api/runs/fresh', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(post.status).toBe(503);
    expect(await post.json()).toEqual({ error: 'err_live_off' });
    expect((await app.request('/api/campaign')).status).toBe(200);
  });

  it('rate-limits per IP (3/hour) and honors trust-proxy', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    const dbPath = join(db, 't.db');
    seedDb(dbPath);
    const app = createApp({
      repoRoot: REPO_ROOT, dbPath, webRoot: webRoot(), http: { trustProxy: true, ratePerHour: 3 },
      makeClient: () => ({}) as never, runSweepFn: instantSweep(dbPath, { id: 0 }),
    });
    const post = (ip: string) =>
      app.request('/api/runs/fresh', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip } });
    expect((await post('9.9.9.9')).status).toBe(202);
    expect((await post('9.9.9.9')).status).toBe(202);
    expect((await post('9.9.9.9')).status).toBe(202);
    const fourth = await post('9.9.9.9');
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toEqual({ error: 'err_rate' });
    expect((await post('8.8.8.8')).status).toBe(202);
  });

  it('runs one job at a time, queues 3, then says busy', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    const dbPath = join(db, 't.db');
    seedDb(dbPath);
    const gates: Array<() => void> = [];
    const runSweepFn = stubSweep(async () => {
      await new Promise<void>((r) => gates.push(r));
      return fakeReport(1);
    });
    const app = createApp({
      repoRoot: REPO_ROOT, dbPath, webRoot: webRoot(), http: { ratePerHour: 100, queueMax: 3 },
      makeClient: () => ({}) as never, runSweepFn,
    });
    const post = () => app.request('/api/runs/fresh', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await post()).status);
    expect(statuses).toEqual([202, 202, 202, 202, 429]);
    const busy = await post();
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual({ error: 'err_busy' });
    for (const g of gates.splice(0)) g();
  });

  it('enforces the global daily model-call cap', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    const dbPath = join(db, 't.db');
    seedDb(dbPath);
    const app = createApp({
      repoRoot: REPO_ROOT, dbPath, webRoot: webRoot(), http: { dailyModelCalls: 5 },
      makeClient: () => ({}) as never, runSweepFn: instantSweep(dbPath, { id: 0 }),
    });
    // Seed spends 8 calls today (2+6+0) — but the seed runs are old-dated?
    // They use "now" for started_at, so the cap trips.
    const post = await app.request('/api/runs/fresh', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(post.status).toBe(503);
    expect(await post.json()).toEqual({ error: 'err_live_off' });
  });

  it('rejects unknown JSON fields on POST', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    const dbPath = join(db, 't.db');
    seedDb(dbPath);
    const app = createApp({
      repoRoot: REPO_ROOT, dbPath, webRoot: webRoot(), makeClient: () => ({}) as never, runSweepFn: instantSweep(dbPath, { id: 0 }),
    });
    const res = await app.request('/api/runs/fresh', { method: 'POST', body: '{"x":1}', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
  });

  it('streams job progress over SSE and serves poll snapshots', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    const dbPath = join(db, 't.db');
    seedDb(dbPath);
    const runSweepFn = stubSweep(async (opts) => {
      const row: SweepRow = { ad: 'ad-01', lang: 'en', expected: '', got: 'CLEAN', pass: true, cached: false, latencyMs: 1, modelCalls: 0 };
      opts.onRow?.(row);
      opts.onRow?.({ ...row, ad: 'ad-02' });
      return fakeReport(1);
    });
    const app = createApp({
      repoRoot: REPO_ROOT, dbPath, webRoot: webRoot(), makeClient: () => ({}) as never, runSweepFn,
    });
    const post = await app.request('/api/runs/fresh', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(post.status).toBe(202);
    const { jobId } = (await post.json()) as { jobId: string };
    // Wait for the stub to finish.
    for (let i = 0; i < 50; i++) {
      const s = (await (await app.request(`/api/jobs/${jobId}`)).json()) as { job: { status: string } };
      if (s.job.status === 'done') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const poll = (await (await app.request(`/api/jobs/${jobId}`)).json()) as { job: { status: string; done: number } };
    expect(poll.job.status).toBe('done');
    expect(poll.job.done).toBe(2);
    const sse = await app.request(`/api/jobs/${jobId}/events`);
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    const text = await sse.text();
    expect(text).toContain('"type":"progress"');
    expect(text).toContain('"type":"done"');
  });

  it('fails jobs past the hard timeout', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    const dbPath = join(db, 't.db');
    seedDb(dbPath);
    const runSweepFn = stubSweep(async () => new Promise<SweepReport>(() => undefined));
    const app = createApp({
      repoRoot: REPO_ROOT, dbPath, webRoot: webRoot(), http: { jobTimeoutMs: 60 },
      makeClient: () => ({}) as never, runSweepFn,
    });
    const post = await app.request('/api/runs/fresh', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    const { jobId } = (await post.json()) as { jobId: string };
    for (let i = 0; i < 100; i++) {
      const s = (await (await app.request(`/api/jobs/${jobId}`)).json()) as { job: { status: string } };
      if (s.job.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const s = (await (await app.request(`/api/jobs/${jobId}`)).json()) as { job: { status: string; error: string } };
    expect(s.job.status).toBe('failed');
    expect(s.job.error).toBe('err_job_timeout');
  });
});

describe('uploads', () => {
  async function postCheck(
    app: ReturnType<typeof createApp>,
    file: { bytes: Buffer; name: string; type: string },
    extra: Record<string, string> = {},
    unknownField = false,
  ): Promise<Response> {
    const fd = new FormData();
    fd.append('image', new File([file.bytes as unknown as BlobPart], file.name, { type: file.type }));
    fd.append('copy', 'hello');
    fd.append('percent', '20');
    fd.append('scope', 'selected_models');
    fd.append('shipping', 'paid');
    fd.append('valid', '2026-11-10');
    fd.append('page', 'gali-offer-en.html');
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    if (unknownField) fd.append('smuggle', '1');
    return app.request('/api/checks', { method: 'POST', body: fd });
  }

  function checkSweep(dbPath: string): (opts: SweepOptions) => Promise<SweepReport> {
    return stubSweep(async (opts) => {
      const store = Store.open(dbPath);
      try {
        const runId = store.createRun({ manifestPath: 'data/uploads/x/manifest.json', fresh: false, pagesBase: 'x', specVersion: 1 });
        store.insertSnapshot({
          run_id: runId, ad_key: 'own-x/en', image_sha256: 'x', image_bytes: 1, copy: '', landing_url: 'x',
          cache_key: 'kx', capture_time: new Date().toISOString(), original_capture_time: null,
          verdict: 'CLEAN', expected: '', pass: 1, cached: 0, latency_ms: 1, model_calls: 1,
        });
        store.finishRun(runId);
        opts.onRow?.({ ad: 'own-x', lang: 'en', expected: '', got: 'CLEAN', pass: true, cached: false, latencyMs: 1, modelCalls: 1 });
        return fakeReport(runId);
      } finally {
        store.close();
      }
    });
  }

  it('accepts a valid PNG and strips metadata on re-encode', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    const dbPath = join(db, 't.db');
    seedDb(dbPath);
    const app = createApp({
      repoRoot: REPO_ROOT, dbPath, webRoot: webRoot(), makeClient: () => ({}) as never, runSweepFn: checkSweep(dbPath),
    });
    const res = await postCheck(app, { bytes: await pngBuffer(40, 40), name: 'ad.png', type: 'image/png' });
    expect(res.status).toBe(202);
  });

  it('reuses the stored spec version when the fields match (cache stability)', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    const dbPath = join(db, 't.db');
    seedDb(dbPath);
    const app = createApp({
      repoRoot: REPO_ROOT, dbPath, webRoot: webRoot(), makeClient: () => ({}) as never, runSweepFn: checkSweep(dbPath),
    });
    // GALI defaults (20/selected/paid/2026-11-10) match stored spec v1.
    const res = await postCheck(app, { bytes: await pngBuffer(40, 40), name: 'ad.png', type: 'image/png' });
    expect(res.status).toBe(202);
    const fresh = readdirSync(join(REPO_ROOT, 'data', 'uploads')).filter((e) => !uploadDirsBefore.has(e));
    expect(fresh).toHaveLength(1);
    const spec = JSON.parse(readFileSync(join(REPO_ROOT, 'data', 'uploads', fresh[0] as string, 'spec.json'), 'utf8')) as { version: number };
    expect(spec.version).toBe(1);
  });

  it('rejects non-images by content, oversize, too many pixels, bad fields', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    const dbPath = join(db, 't.db');
    seedDb(dbPath);
    const app = createApp({
      repoRoot: REPO_ROOT, dbPath, webRoot: webRoot(), makeClient: () => ({}) as never, runSweepFn: checkSweep(dbPath),
    });
    // GIF bytes with a .png name → rejected by content.
    const gif = Buffer.from('GIF89a' + 'x'.repeat(100));
    expect((await postCheck(app, { bytes: gif, name: 'ad.png', type: 'image/png' })).status).toBe(400);
    // Text file.
    expect((await postCheck(app, { bytes: Buffer.from('hello'), name: 'ad.png', type: 'image/png' })).status).toBe(400);
    // Unknown field.
    expect((await postCheck(app, { bytes: await pngBuffer(10, 10), name: 'a.png', type: 'image/png' }, {}, true)).status).toBe(400);
    // Bad enum + bad date.
    expect((await postCheck(app, { bytes: await pngBuffer(10, 10), name: 'a.png', type: 'image/png' }, { page: 'https://evil.example/x' })).status).toBe(400);
    expect((await postCheck(app, { bytes: await pngBuffer(10, 10), name: 'a.png', type: 'image/png' }, { valid: 'tomorrow' })).status).toBe(400);
  });

  it('rejects oversize and over-pixel uploads per configured limits', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    const dbPath = join(db, 't.db');
    seedDb(dbPath);
    const app = createApp({
      repoRoot: REPO_ROOT, dbPath, webRoot: webRoot(),
      http: { uploadMaxBytes: 1024, uploadMaxPixels: 500 },
      makeClient: () => ({}) as never, runSweepFn: checkSweep(dbPath),
    });
    const big = await pngBuffer(200, 200); // >1KB and >500px
    const res = await postCheck(app, { bytes: big, name: 'a.png', type: 'image/png' });
    expect([400, 413]).toContain(res.status);
    // Trailing-data polyglot: decodes, but the stored file is a clean re-encode.
    const app2 = createApp({
      repoRoot: REPO_ROOT, dbPath, webRoot: webRoot(), makeClient: () => ({}) as never, runSweepFn: checkSweep(dbPath),
    });
    const poly = Buffer.concat([await pngBuffer(20, 20), Buffer.from('<script>alert(1)</script>')]);
    const res2 = await postCheck(app2, { bytes: poly, name: 'a.png', type: 'image/png' });
    expect(res2.status).toBe(202);
    const { readdirSync, readFileSync: readSync } = await import('node:fs');
    const upRoot = join(REPO_ROOT, 'data', 'uploads');
    const newest = readdirSync(upRoot)
      .filter((e) => !uploadDirsBefore.has(e))
      .map((e) => join(upRoot, e, 'ad.png'))
      .filter((p) => {
        try {
          readSync(p);
          return true;
        } catch {
          return false;
        }
      });
    expect(newest.length).toBeGreaterThan(0);
    for (const p of newest) {
      expect(readSync(p).includes(Buffer.from('<script>'))).toBe(false);
    }
  });
});

describe('security headers', () => {
  it('sets CSP and hardening headers on pages, API and errors', async () => {
    const db = mkdtempSync(join(tmpdir(), 'og-db-'));
    tmpDirs.push(db);
    seedDb(join(db, 't.db'));
    const app = createApp({ repoRoot: REPO_ROOT, dbPath: join(db, 't.db'), webRoot: webRoot(), makeClient: () => ({}) as never });
    for (const p of ['/', '/api/campaign', '/nope']) {
      const res = await app.request(p);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("img-src 'self' data: blob:");
      expect(csp).not.toContain("script-src 'unsafe-inline'");
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });
});

describe('i18n parity', () => {
  it('every UI string exists in both languages', () => {
    const en = Object.keys(STRINGS.en).sort();
    const he = Object.keys(STRINGS.he).sort();
    expect(he).toEqual(en);
    for (const k of en) {
      expect(STRINGS.he[k as keyof typeof STRINGS.he].length).toBeGreaterThan(0);
    }
  });
});

describe('module graph', () => {
  it('the web server never imports Graph writes or the seeder', async () => {
    const { readdirSync } = await import('node:fs');
    const dir = join(REPO_ROOT, 'src', 'server', 'http');
    const forbidden = ['meta/graph', 'seed-campaign', 'probe-meta', 'cleanup-probe'];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue;
      const src = readFileSync(join(dir, f), 'utf8');
      for (const bad of forbidden) {
        expect(src, `${f} must not reference ${bad}`).not.toContain(bad);
      }
    }
  });
});
