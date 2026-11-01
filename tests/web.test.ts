import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_JOB_ID } from '../src/server/adfit/seed.js';
import { createApp } from '../src/server/http/app.js';
import type { HttpConfig } from '../src/server/http/config.js';
import { Store } from '../src/server/store/db.js';

let tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
  tmpDirs = [];
});

function repoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adfit-app-'));
  tmpDirs.push(dir);
  return dir;
}

async function png(w = 32, h = 32): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
}

/** Buffer → BlobPart (undici accepts Buffers at runtime; TS wants the cast). */
function part(b: Buffer): BlobPart {
  return b as unknown as BlobPart;
}

function writeRel(root: string, rel: string, data: Buffer): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, data);
}

/** A client that fails fast (400 is never retried) — jobs finish as failed cells. */
function failingClient(): OpenAI {
  const err = new OpenAI.APIError(400, { error: { message: 'nope' } } as never, 'nope', new Headers());
  return { chat: { completions: { create: async () => { throw err; } } } } as unknown as OpenAI;
}

function mockClient(text: string): OpenAI {
  return {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: text } }], usage: {} }) } },
  } as unknown as OpenAI;
}

function testApp(root: string, opts: { http?: Partial<HttpConfig>; client?: OpenAI } = {}) {
  const dbPath = join(root, 'data', 't.db');
  const webRoot = join(root, 'web');
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<html>hi</html>');
  const app = createApp({
    repoRoot: root,
    dbPath,
    webRoot,
    http: opts.http,
    makeClient: () => opts.client ?? failingClient(),
    makeImageConfig: () => ({ baseUrl: 'https://example.invalid', apiKey: 'x', model: 'muse-image-1.0' }),
  });
  return { app, dbPath };
}

const SPEC = JSON.stringify({
  logo: null, headline_zone: null, subtext_zone: null, panel_zone: null,
  product_zone: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, frames: [],
  background_style: 'flat', text_align: 'center', direction: 'ltr',
});

function seedBrand(dbPath: string, demo = false): void {
  const store = Store.open(dbPath);
  try {
    store.insertBrand({ id: demo ? 'demo-b' : 'b1', name: demo ? 'Demo' : 'B', colors: ['#ffffff'], fonts: [], logoPath: null, isDemo: demo, expiresAt: null });
    store.insertTemplate({ id: demo ? 'demo-t' : 't1', brandId: demo ? 'demo-b' : 'b1', preset: 'ig-feed-11', imagePath: 'data/t.png', framePath: null, expiresAt: null });
    store.setTemplateReady(demo ? 'demo-t' : 't1', SPEC);
  } finally {
    store.close();
  }
}

async function seedJob(root: string, dbPath: string, jobId = 'j1', sourceId = 's1'): Promise<number> {
  const img = await png();
  writeRel(root, `data/outputs/${jobId}/0-ig-feed-11.png`, img);
  writeRel(root, `data/uploads/${sourceId}/source.png`, img);
  const store = Store.open(dbPath);
  try {
    store.insertSource({ id: sourceId, imagePath: `data/uploads/${sourceId}/source.png`, width: 32, height: 32, expiresAt: null });
    store.setSourceAnalysis(sourceId, '{"language":"en"}', JSON.stringify({ 'product-0': `data/masks/${sourceId}/product-0.png` }), null);
    writeRel(root, `data/masks/${sourceId}/product-0.png`, img);
    store.insertJob({ id: jobId, brandId: null, mode: 'protected', sizes: ['ig-feed-11'], sources: [sourceId] });
    const oid = store.insertOutput({
      jobId, sourceId, preset: 'ig-feed-11', mode: 'protected', status: 'pass',
      imagePath: `data/outputs/${jobId}/0-ig-feed-11.png`, planJson: '{"preset":"ig-feed-11","width":1080,"height":1080}',
      proofJson: '{"product-0":{"scale":1,"core_differ":0,"core_total":9,"feather_total":0,"pass":true}}',
      qaJson: '{"pass":true,"reasons":[],"texts_read":[],"logo_ok":true,"product_ok":true,"safe_area_ok":true,"invented_text":[]}',
      retries: 0, modelCalls: 3, imageCalls: 1, latencyMs: 5, traceJson: '[]', error: null,
    });
    store.finishJob(jobId, 'done', null, 3, 1);
    return oid;
  } finally {
    store.close();
  }
}

async function waitLive(app: ReturnType<typeof createApp>, key: string): Promise<{ status: string }> {
  for (let i = 0; i < 100; i++) {
    const s = (await (await app.request(`/api/live/${key}`)).json()) as { job: { status: string } };
    if (s.job.status === 'done' || s.job.status === 'failed') return s.job;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('live job did not finish');
}

describe('read API', () => {
  it('serves presets, brands with templates, runs, outputs and demo', async () => {
    const root = repoRoot();
    const { app, dbPath } = testApp(root);
    seedBrand(dbPath);
    const oid = await seedJob(root, dbPath);
    await seedJob(root, dbPath, DEMO_JOB_ID, 's-demo');

    const presets = (await (await app.request('/api/presets')).json()) as { presets: unknown[] };
    expect(presets.presets).toHaveLength(8);

    const brands = (await (await app.request('/api/brands')).json()) as { brands: Array<{ id: string; templates: unknown[] }> };
    expect(brands.brands.map((b) => b.id)).toEqual(['b1']);
    expect(brands.brands[0]?.templates).toHaveLength(1);
    expect((await app.request('/api/brands/nope')).status).toBe(404);

    const run = (await (await app.request('/api/runs/j1')).json()) as { id: string; outputs: Array<{ proofDiff: number; qaPass: boolean }> };
    expect(run.id).toBe('j1');
    expect(run.outputs[0]?.proofDiff).toBe(0);
    expect(run.outputs[0]?.qaPass).toBe(true);

    const out = (await (await app.request(`/api/outputs/${oid}`)).json()) as { masks: string[]; plan: unknown; qa: unknown };
    expect(out.masks).toEqual(['product-0']);
    expect(out.plan).not.toBeNull();
    expect(out.qa).not.toBeNull();
    expect((await app.request('/api/outputs/9999')).status).toBe(404);
    expect((await app.request('/api/outputs/abc')).status).toBe(404);

    const demo = (await (await app.request('/api/demo')).json()) as { id: string };
    expect(demo.id).toBe(DEMO_JOB_ID);
  });

  it('404s unknown records with an i18n key and no stack', async () => {
    const root = repoRoot();
    const { app } = testApp(root);
    for (const p of ['/api/runs/nope', '/api/nope', '/media/output/9999', '/media/bogus/1']) {
      const res = await app.request(p);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'err_not_found' });
    }
  });
});

describe('base path', () => {
  it('serves everything under ADFIT_BASE_PATH', async () => {
    const root = repoRoot();
    const { app } = testApp(root, { http: { basePath: '/adfit/' } });
    expect((await app.request('/adfit/api/presets')).status).toBe(200);
    expect((await app.request('/adfit/')).status).toBe(200);
    expect((await app.request('/api/presets')).status).toBe(404);
  });
});

describe('media', () => {
  it('serves outputs, thumbs, sources and masks by id', async () => {
    const root = repoRoot();
    const { app, dbPath } = testApp(root);
    const oid = await seedJob(root, dbPath);
    const img = await app.request(`/media/output/${oid}`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect((await app.request(`/media/thumb/${oid}`)).status).toBe(200);
    expect((await app.request('/media/source/s1')).status).toBe(200);
    expect((await app.request('/media/mask/s1/product-0')).status).toBe(200);
    expect((await app.request('/media/mask/s1/nope')).status).toBe(404);
    expect((await app.request('/media/mask/s1/..')).status).toBe(404);
  });

  it('blocks path traversal and escaping symlinks', async () => {
    const root = repoRoot();
    const { app, dbPath } = testApp(root);
    await seedJob(root, dbPath);
    const outside = join(tmpdir(), `adfit-outside-${Date.now()}.png`);
    writeFileSync(outside, 'NOT AN IMAGE');
    const artDir = join(root, 'artifacts', 't');
    mkdirSync(artDir, { recursive: true });
    try {
      symlinkSync(outside, join(artDir, 'evil.png'));
    } catch {
      // Filesystem without symlink support: skip the symlink leg.
    }
    const store = Store.open(dbPath);
    try {
      store.insertSource({ id: 'evil', imagePath: '../../etc/passwd', width: 1, height: 1, expiresAt: null });
      store.insertSource({ id: 'evil2', imagePath: 'artifacts/t/evil.png', width: 1, height: 1, expiresAt: null });
    } finally {
      store.close();
    }
    expect((await app.request('/media/source/evil')).status).toBe(404);
    expect((await app.request('/media/source/evil2')).status).toBe(404);
    expect((await app.request('/media/output/..%2f..')).status).toBe(404);
  });
});

describe('brands', () => {
  it('creates, renames nothing, and deletes visitor brands (never demo)', async () => {
    const root = repoRoot();
    const { app, dbPath } = testApp(root);
    seedBrand(dbPath, true);
    const created = await app.request('/api/brands', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Acme', colors: ['#112233'] }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect((await app.request(`/api/brands/${id}`)).status).toBe(200);
    // Strict: unknown fields and bad colors are rejected.
    expect((await app.request('/api/brands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X', nope: 1 }) })).status).toBe(400);
    expect((await app.request('/api/brands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X', colors: ['red'] }) })).status).toBe(400);
    expect((await app.request(`/api/brands/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await app.request(`/api/brands/${id}`)).status).toBe(404);
    expect((await app.request('/api/brands/demo-b', { method: 'DELETE' })).status).toBe(400);
  });

  it('uploads logos and templates, parses in background, patches and deletes', async () => {
    const root = repoRoot();
    const { app, dbPath } = testApp(root);
    seedBrand(dbPath);
    const file = new File([part(await png(64, 64))], 'logo.png', { type: 'image/png' });
    const fd = new FormData();
    fd.append('logo', file);
    const logo = await app.request('/api/brands/b1/logo', { method: 'POST', body: fd });
    expect(logo.status).toBe(200);
    expect((await app.request('/media/logo/b1')).status).toBe(200);

    const bad = new FormData();
    bad.append('logo', new File([part(Buffer.from('nope'))], 'x.txt', { type: 'text/plain' }));
    expect((await app.request('/api/brands/b1/logo', { method: 'POST', body: bad })).status).toBe(400);

    const tf = new FormData();
    tf.append('image', new File([part(await png(64, 64))], 't.png', { type: 'image/png' }));
    tf.append('preset', 'ig-feed-11');
    const tpl = await app.request('/api/brands/b1/templates', { method: 'POST', body: tf });
    expect(tpl.status).toBe(202);
    const { id: tplId } = (await tpl.json()) as { id: string };
    // Background parse fails fast with the failing client (pending→failed).
    for (let i = 0; i < 50; i++) {
      const store = Store.open(dbPath);
      const row = store.getTemplate(tplId);
      store.close();
      if (row?.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 30));
    }

    const badPreset = new FormData();
    badPreset.append('image', new File([part(await png())], 't.png', { type: 'image/png' }));
    badPreset.append('preset', 'nope');
    expect((await app.request('/api/brands/b1/templates', { method: 'POST', body: badPreset })).status).toBe(400);

    // PATCH preset + nudged spec.
    const spec = { ...JSON.parse(SPEC), product_zone: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 } };
    expect((await app.request(`/api/templates/t1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preset: 'fb-feed' }) })).status).toBe(200);
    expect((await app.request(`/api/templates/t1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec }) })).status).toBe(200);
    expect((await app.request(`/api/templates/t1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preset: 'nope' }) })).status).toBe(400);
    expect((await app.request(`/api/templates/t1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: { ...spec, product_zone: { x: 0, y: 0, w: 5, h: 5 } } }) })).status).toBe(400);

    expect((await app.request(`/api/templates/t1`, { method: 'DELETE' })).status).toBe(200);
    seedBrand(dbPath, true);
    expect((await app.request('/api/templates/demo-t', { method: 'DELETE' })).status).toBe(400);
  });
});

describe('match', () => {
  it('proposes a brand from logo+colors', async () => {
    const root = repoRoot();
    const { app, dbPath } = testApp(root, { client: mockClient('{"brand_index":0,"reason":"teal logo"}') });
    seedBrand(dbPath);
    const fd = new FormData();
    fd.append('image', new File([part(await png())], 's.png', { type: 'image/png' }));
    const res = await app.request('/api/match', { method: 'POST', body: fd });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ brandId: 'b1' });
  });
});

describe('live-job guards', () => {
  function jobForm(sizes = 'ig-feed-11', files = 1): FormData {
    const fd = new FormData();
    fd.append('sizes', sizes);
    fd.append('mode', 'protected');
    return fd;
  }

  async function withFiles(fd: FormData, n: number): Promise<FormData> {
    for (let i = 0; i < n; i++) fd.append(`source${i}`, new File([part(await png())], `s${i}.png`, { type: 'image/png' }));
    return fd;
  }

  it('kill switch refuses submits but keeps reads working', async () => {
    const root = repoRoot();
    const { app } = testApp(root, { http: { live: false } });
    const post = await app.request('/api/jobs', { method: 'POST', body: await withFiles(jobForm(), 1) });
    expect(post.status).toBe(503);
    expect(await post.json()).toEqual({ error: 'err_live_off' });
    expect((await app.request('/api/presets')).status).toBe(200);
  });

  it('validates sizes, mode, brand and file counts', async () => {
    const root = repoRoot();
    const { app } = testApp(root);
    expect((await app.request('/api/jobs', { method: 'POST', body: await withFiles(jobForm('nope'), 1) })).status).toBe(400);
    const badMode = await withFiles(jobForm(), 1);
    badMode.set('mode', 'turbo');
    expect((await app.request('/api/jobs', { method: 'POST', body: badMode })).status).toBe(400);
    const badBrand = await withFiles(jobForm(), 1);
    badBrand.set('brandId', 'ghost');
    expect((await app.request('/api/jobs', { method: 'POST', body: badBrand })).status).toBe(400);
    expect((await app.request('/api/jobs', { method: 'POST', body: jobForm() })).status).toBe(400);
    expect((await app.request('/api/jobs', { method: 'POST', body: await withFiles(jobForm(), 4) })).status).toBe(400);
  });

  it('rate-limits per IP (3/hour) and honors trust-proxy', async () => {
    const root = repoRoot();
    const { app } = testApp(root, { http: { trustProxy: true, ratePerHour: 3 } });
    const post = async (ip: string) =>
      app.request('/api/jobs', { method: 'POST', body: await withFiles(jobForm(), 1), headers: { 'x-forwarded-for': ip } });
    expect((await post('9.9.9.9')).status).toBe(202);
    expect((await post('9.9.9.9')).status).toBe(202);
    expect((await post('9.9.9.9')).status).toBe(202);
    const fourth = await post('9.9.9.9');
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toEqual({ error: 'err_rate' });
    expect((await post('8.8.8.8')).status).toBe(202);
  });

  it('says busy when running with a full queue', async () => {
    const root = repoRoot();
    const hung = { chat: { completions: { create: () => new Promise(() => undefined) } } } as unknown as OpenAI;
    const { app } = testApp(root, { http: { queueMax: 0, jobTimeoutMs: 200 }, client: hung });
    const post = async () => app.request('/api/jobs', { method: 'POST', body: await withFiles(jobForm(), 1) });
    expect((await post()).status).toBe(202);
    const busy = await post();
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual({ error: 'err_busy' });
  });

  it('enforces the daily model-call and image caps', async () => {
    const root = repoRoot();
    const { app, dbPath } = testApp(root, { http: { dailyModelCalls: 5, dailyImages: 200 } });
    const store = Store.open(dbPath);
    try {
      store.recordUsage('model', 5);
    } finally {
      store.close();
    }
    const post = await app.request('/api/jobs', { method: 'POST', body: await withFiles(jobForm(), 1) });
    expect(post.status).toBe(503);

    const root2 = repoRoot();
    const capped = testApp(root2, { http: { dailyModelCalls: 300, dailyImages: 1 } });
    const store2 = Store.open(capped.dbPath);
    try {
      store2.recordUsage('image', 1);
    } finally {
      store2.close();
    }
    const post2 = await capped.app.request('/api/jobs', { method: 'POST', body: await withFiles(jobForm(), 1) });
    expect(post2.status).toBe(503);
  });

  it('runs jobs to completion and streams SSE with poll snapshots', async () => {
    const root = repoRoot();
    const { app } = testApp(root);
    const post = await app.request('/api/jobs', { method: 'POST', body: await withFiles(jobForm('ig-feed-11,fb-feed'), 1) });
    expect(post.status).toBe(202);
    const { key, jobId } = (await post.json()) as { key: string; jobId: string };
    const job = await waitLive(app, key);
    expect(job.status).toBe('done'); // failed cells still finish the job
    const run = (await (await app.request(`/api/runs/${jobId}`)).json()) as { outputs: Array<{ status: string }> };
    expect(run.outputs).toHaveLength(2);
    expect(run.outputs[0]?.status).toBe('failed'); // failing client: honest failure
    const sse = await app.request(`/api/live/${key}/events`);
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    const text = await sse.text();
    expect(text).toContain('"type":"progress"');
    expect(text).toContain('"type":"done"');
    expect((await app.request('/api/live/nope')).status).toBe(404);
  });

  it('accepts a fixture demoSource for Run-it-live', async () => {
    const root = repoRoot();
    const { app } = testApp(root);
    writeRel(root, 'fixtures/brands/gali/source-he.png', await png(64, 64));
    const fd = new FormData();
    fd.append('demoSource', 'gali-he');
    fd.append('sizes', 'ig-feed-11');
    const post = await app.request('/api/jobs', { method: 'POST', body: fd });
    expect(post.status).toBe(202);
  });

  it('regenerates a single output and zips finished runs', async () => {
    const root = repoRoot();
    const { app, dbPath } = testApp(root);
    const oid = await seedJob(root, dbPath);
    const regen = await app.request(`/api/outputs/${oid}/regenerate`, { method: 'POST' });
    expect(regen.status).toBe(202);
    const { key } = (await regen.json()) as { key: string };
    await waitLive(app, key);
    expect((await app.request('/api/outputs/9999/regenerate', { method: 'POST' })).status).toBe(404);

    const zip = await app.request('/api/runs/j1/zip');
    expect(zip.status).toBe(200);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    const bytes = Buffer.from(await zip.arrayBuffer());
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect((await app.request('/api/runs/nope/zip')).status).toBe(404);
  });
});
