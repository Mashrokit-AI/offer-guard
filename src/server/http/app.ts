import { Hono, type Context } from 'hono';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type OpenAI from 'openai';
import sharp from 'sharp';
import { z } from 'zod';
import { BRAND_SLUG } from '../../shared/brand.js';
import { loadModelConfig } from '../../shared/config.js';
import { PRESETS, presetById } from '../../shared/presets.js';
import { templateSpecSchema } from '../../shared/schemas.js';
import { DEMO_JOB_ID } from '../adfit/seed.js';
import { prepareSource, runOutput, runPool, type FitMode, type OutputTemplate, type PreparedSource } from '../adfit/pipeline.js';
import { matchBrand } from '../models/brand-match.js';
import { createModelClient } from '../models/client.js';
import { readTemplate, specBoxesNormalized } from '../models/template-read.js';
import type { ImageGenConfig } from '../models/muse-image.js';
import { segmentTargets } from '../repair/masks.js';
import { Store } from '../store/db.js';
import { TraceCollector } from '../workflow/trace.js';
import { loadHttpConfig, type HttpConfig } from './config.js';
import { buildBrand, buildBrands, buildJob, buildOutput } from './dto.js';
import { JobManager, RateLimiter, sseResponse, summarize, type JobRow } from './jobs.js';
import { MEDIA_KINDS, readContainedFile, resolveMask, resolveMedia, type MediaKind } from './media.js';
import { UploadError, validateAndStoreUpload, validateImageBytes } from './uploads.js';
import { buildZip, sha256Hex } from './zip.js';

/**
 * Public read-only web app + bounded live jobs. MatchPic never publishes
 * anything: there is no write path to any external ad platform in this
 * module or its imports.
 */

export interface AppDeps {
  repoRoot: string;
  dbPath?: string;
  webRoot?: string;
  http?: Partial<HttpConfig>;
  makeClient?: () => OpenAI;
  makeImageConfig?: () => ImageGenConfig;
  extractModel?: string;
  samModel?: string;
}

const CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

function securityHeaders(c: Context): void {
  c.header('content-security-policy', CSP);
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'no-referrer');
  c.header('x-frame-options', 'DENY');
}

function err(c: Context, status: 400 | 404 | 413 | 429 | 503 | 500, key: string) {
  return c.json({ error: key }, status);
}

function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) return xff.split(',')[0]?.trim().slice(0, 100) || 'unknown';
  }
  const incoming = (c.env as Record<string, unknown> | undefined)?.incoming as
    | { socket?: { remoteAddress?: string } }
    | undefined;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}

function utcMidnightIso(now: Date = new Date()): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

async function sendFile(c: Context, abs: string, contentType: string, cache: string) {
  try {
    const bytes = await readFile(abs);
    c.header('content-type', contentType);
    c.header('content-length', String(bytes.length));
    c.header('cache-control', cache);
    return c.body(bytes);
  } catch {
    return err(c, 404, 'err_not_found');
  }
}

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const brandBodySchema = z.object({ name: z.string().trim().min(1).max(60), colors: z.array(hexColor).max(8).default([]), fonts: z.array(z.string().trim().min(1).max(60)).max(8).default([]) }).strict();

const templatePatchSchema = z.object({ preset: z.string().max(40).nullable().optional(), spec: z.unknown().optional() }).strict();

const DEMO_SOURCES: Record<string, string> = {
  'gali-he': 'fixtures/brands/gali/source-he.png',
  'gali-en': 'fixtures/brands/gali/source-en.png',
  noa: 'fixtures/brands/noa/source.png',
};

const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
const dayFromNow = (): string => new Date(Date.now() + 24 * 3600 * 1000).toISOString();

interface UploadedFile {
  arrayBuffer: () => Promise<ArrayBuffer>;
  size?: number;
}

function isFile(v: unknown): v is UploadedFile {
  return !!v && typeof (v as UploadedFile).arrayBuffer === 'function';
}

function collectFiles(body: Record<string, unknown>): UploadedFile[] {
  const out: UploadedFile[] = [];
  for (const v of Object.values(body)) {
    if (isFile(v)) out.push(v);
    else if (Array.isArray(v)) for (const e of v) if (isFile(e)) out.push(e);
  }
  return out;
}

export function createApp(deps: AppDeps): Hono {
  const repoRoot = deps.repoRoot;
  const cfg: HttpConfig = { ...loadHttpConfig(process.env), ...deps.http };
  const dbPath = deps.dbPath ?? join(repoRoot, 'data', 'adfit.db');
  const webRoot = deps.webRoot ?? join(repoRoot, 'dist', 'web');
  const makeClient = deps.makeClient ?? (() => createModelClient(loadModelConfig(process.env)));
  const makeImageConfig =
    deps.makeImageConfig ??
    (() => {
      const m = loadModelConfig(process.env);
      return { baseUrl: m.MODEL_API_BASE, apiKey: m.MODEL_API_KEY, model: m.MODEL_IMAGE };
    });
  const extractModel = deps.extractModel ?? 'muse-spark-1.3';
  const samModel = deps.samModel ?? 'sam-3.1';

  const jobs = new JobManager({ queueMax: cfg.queueMax, jobTimeoutMs: cfg.jobTimeoutMs });
  const limiter = new RateLimiter(cfg.ratePerHour);

  const withStore = <T>(fn: (s: Store) => T): T => {
    const store = Store.open(dbPath);
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };

  const capped = (kind: 'model' | 'image'): boolean => {
    const limit = kind === 'model' ? cfg.dailyModelCalls : cfg.dailyImages;
    return withStore((s) => s.countUsageSince(utcMidnightIso(), kind)) >= limit;
  };

  /** Best-effort unlink of repo-local data files (never fixtures). */
  const unlinkData = async (rels: Array<string | null>): Promise<void> => {
    for (const rel of rels) {
      if (!rel || (!rel.startsWith('data/') && !rel.startsWith('artifacts/'))) continue;
      await rm(join(repoRoot, rel), { force: true, recursive: true }).catch(() => undefined);
    }
  };

  // Background template parse: Spark layout spec + SAM logo mask (by convention
  // data/.../mask-logo.png next to the template image). Never throws.
  const parseTemplate = (templateId: string): void => {
    void (async () => {
      try {
        const row = withStore((s) => s.getTemplate(templateId));
        if (!row) return;
        const bytes = await readContainedFile(repoRoot, row.image_path);
        if (!bytes) {
          withStore((s) => s.setTemplateFailed(templateId, 'template image missing'));
          return;
        }
        const meta = await sharp(bytes).metadata();
        const client = makeClient();
        const res = await readTemplate(client, {
          imageBytes: bytes,
          mimeType: 'image/png',
          width: meta.width ?? 0,
          height: meta.height ?? 0,
          model: extractModel,
        });
        withStore((s) => {
          s.setTemplateReady(templateId, JSON.stringify(res.spec));
          s.recordUsage('model', res.attempts.length);
        });
        if (res.spec.logo) {
          const seg = await segmentTargets(client, {
            imageBytes: bytes,
            mimeType: 'image/png',
            width: meta.width ?? 0,
            height: meta.height ?? 0,
            model: samModel,
            targets: [{ id: 'logo', phrase: 'logo', box: null }],
          });
          withStore((s) => s.recordUsage('model', seg.calls));
          const mask = seg.masks.get('logo');
          if (mask && row.image_path.startsWith('data/')) {
            const px = Buffer.alloc(mask.length);
            for (let i = 0; i < px.length; i++) px[i] = mask[i] ? 255 : 0;
            const dir = join(repoRoot, dirname(row.image_path));
            await mkdir(dir, { recursive: true });
            await sharp(px, { raw: { width: meta.width ?? 0, height: meta.height ?? 0, channels: 1 } })
              .png()
              .toFile(join(dir, 'mask-logo.png'));
          }
        }
      } catch (e) {
        withStore((s) => s.setTemplateFailed(templateId, `parse failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)));
      }
    })();
  };

  interface CellDef {
    source: PreparedSource;
    sourceIndex: number;
    presetId: string;
  }

  /** Execute one generation job: prepare sources, run cells 2-at-a-time. */
  const executeJob = async (
    storeJobId: string,
    cells: CellDef[],
    mode: FitMode,
    brandId: string | null,
    brandName: string | null,
    prepareTraces: Map<string, TraceCollector>,
    onRow: (row: JobRow) => void,
  ): Promise<{ jobId: string }> => {
    // Resolve template + frame per size once.
    const perSize = new Map<string, { template: OutputTemplate | null; framePng: Buffer | null }>();
    for (const cell of cells) {
      if (perSize.has(cell.presetId)) continue;
      let template: OutputTemplate | null = null;
      let framePng: Buffer | null = null;
      if (brandId) {
        const row = withStore((s) => s.templateForSize(brandId, cell.presetId));
        if (row?.spec_json) {
          try {
            const spec = templateSpecSchema.parse(JSON.parse(row.spec_json));
            const bytes = await readContainedFile(repoRoot, row.image_path);
            if (bytes) template = { id: row.id, spec, imageBytes: bytes, mimeType: 'image/png' };
            if (row.frame_path) framePng = await readContainedFile(repoRoot, row.frame_path);
          } catch {
            // A corrupt template row never fails the job; the plan falls back to defaults.
          }
        }
      }
      perSize.set(cell.presetId, { template, framePng });
    }

    const models = { client: makeClient(), extractModel, samModel, image: makeImageConfig() };
    let jobModels = 0;
    let jobImages = 0;
    const runCell = async (cell: CellDef): Promise<void> => {
      const preset = presetById(cell.presetId);
      if (!preset) return;
      const trace = new TraceCollector();
      for (const e of prepareTraces.get(cell.source.id)?.all() ?? []) {
        const { seq: _s, ...rest } = e;
        trace.emit(rest);
      }
      const outDir = join(repoRoot, 'data', 'outputs', storeJobId);
      const start = Date.now();
      try {
        const { template, framePng } = perSize.get(cell.presetId) ?? { template: null, framePng: null };
        const outcome = await runOutput(models, { source: cell.source, preset, mode, template, framePng, brandName }, `${storeJobId}/${cell.sourceIndex}/${preset.id}`, trace);
        await mkdir(outDir, { recursive: true });
        const fileName = `${cell.sourceIndex}-${preset.id}.png`;
        await writeFile(join(outDir, fileName), outcome.png);
        jobModels += outcome.modelCalls;
        jobImages += outcome.imageCalls;
        const status = outcome.qa.pass ? 'pass' : 'needs_review';
        const outputId = withStore((s) => {
          const id = s.insertOutput({
            jobId: storeJobId, sourceId: cell.source.id, preset: preset.id, mode, status,
            imagePath: `data/outputs/${storeJobId}/${fileName}`,
            planJson: JSON.stringify(outcome.plan),
            proofJson: outcome.proofs ? JSON.stringify(outcome.proofs) : null,
            qaJson: JSON.stringify(outcome.qa),
            retries: outcome.retries,
            modelCalls: outcome.modelCalls, imageCalls: outcome.imageCalls,
            latencyMs: Date.now() - start, traceJson: JSON.stringify(trace.all()), error: null,
          });
          s.recordUsage('model', outcome.modelCalls);
          s.recordUsage('image', outcome.imageCalls);
          return id;
        });
        onRow({ outputId, sourceId: cell.source.id, sourceIndex: cell.sourceIndex, preset: preset.id, status, retries: outcome.retries });
      } catch (e) {
        const message = `${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
        const outputId = withStore((s) =>
          s.insertOutput({
            jobId: storeJobId, sourceId: cell.source.id, preset: preset.id, mode, status: 'failed',
            imagePath: '', planJson: '{}', proofJson: null, qaJson: null, retries: 0,
            modelCalls: 0, imageCalls: 0, latencyMs: Date.now() - start,
            traceJson: JSON.stringify(trace.all()), error: message,
          }),
        );
        onRow({ outputId, sourceId: cell.source.id, sourceIndex: cell.sourceIndex, preset: preset.id, status: 'failed', retries: 0, error: message });
      }
    };
    await runPool(cells, 2, runCell);
    const failed = withStore((s) => s.outputsForJob(storeJobId).filter((o) => o.status === 'failed').length);
    const total = withStore((s) => s.outputsForJob(storeJobId).length);
    withStore((s) => s.finishJob(storeJobId, failed === total && total > 0 ? 'failed' : 'done', null, jobModels, jobImages));
    return { jobId: storeJobId };
  };

  /** Prepare sources (analyze + masks + persist mask PNGs). Throws nothing per-source: failures are returned. */
  const prepareAll = async (
    raws: Array<{ id: string; bytes: Buffer; width: number; height: number }>,
  ): Promise<{ prepared: PreparedSource[]; traces: Map<string, TraceCollector>; failed: Map<string, string> }> => {
    const models = { client: makeClient(), extractModel, samModel, image: makeImageConfig() };
    const prepared: PreparedSource[] = [];
    const traces = new Map<string, TraceCollector>();
    const failed = new Map<string, string>();
    for (const raw of raws) {
      const trace = new TraceCollector();
      traces.set(raw.id, trace);
      try {
        const p = await prepareSource(models, { id: raw.id, bytes: raw.bytes, mimeType: 'image/png', width: raw.width, height: raw.height }, trace);
        // Persist full-frame masks for the overlay UI.
        const maskMap: Record<string, string> = {};
        if (p.masks.size > 0) {
          const dir = join(repoRoot, 'data', 'masks', raw.id);
          await mkdir(dir, { recursive: true });
          for (const [mid, mask] of p.masks) {
            const px = Buffer.alloc(mask.length);
            for (let i = 0; i < px.length; i++) px[i] = mask[i] ? 255 : 0;
            await sharp(px, { raw: { width: p.width, height: p.height, channels: 1 } }).png().toFile(join(dir, `${mid}.png`));
            maskMap[mid] = `data/masks/${raw.id}/${mid}.png`;
          }
        }
        withStore((s) => {
          s.setSourceAnalysis(raw.id, JSON.stringify(p.analysis), JSON.stringify(maskMap), null);
          s.recordUsage('model', p.modelCalls);
        });
        prepared.push(p);
      } catch (e) {
        failed.set(raw.id, `${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
      }
    }
    return { prepared, traces, failed };
  };

  const inner = new Hono();
  inner.use('*', async (c, next) => {
    securityHeaders(c);
    await next();
  });
  inner.notFound((c) => err(c, 404, 'err_not_found'));
  inner.onError((e, c) => {
    console.error(`web error: ${e instanceof Error ? e.message : String(e)}`);
    return err(c, 500, 'err_unknown');
  });

  // --- static shell ---
  inner.get('/', (c) => sendFile(c, join(webRoot, 'index.html'), 'text/html; charset=utf-8', 'no-cache'));
  inner.get('/app.js', (c) => sendFile(c, join(webRoot, 'app.js'), 'text/javascript; charset=utf-8', 'no-cache'));
  inner.get('/styles.css', (c) => sendFile(c, join(webRoot, 'styles.css'), 'text/css; charset=utf-8', 'no-cache'));
  inner.get('/favicon.svg', (c) => sendFile(c, join(webRoot, 'favicon.svg'), 'image/svg+xml', 'public, max-age=3600'));
  inner.get('/fonts/:file', (c) => {
    const f = c.req.param('file');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.woff2$/.test(f)) return err(c, 404, 'err_not_found');
    return sendFile(c, join(webRoot, 'fonts', f), 'font/woff2', 'public, max-age=86400');
  });

  // --- read API ---
  inner.get('/api/presets', (c) => c.json({ presets: PRESETS }));
  inner.get('/api/brands', (c) => c.json(withStore((s) => buildBrands(s))));
  inner.get('/api/brands/:id', (c) => {
    const dto = withStore((s) => buildBrand(s, c.req.param('id')));
    if (!dto) return err(c, 404, 'err_not_found');
    return c.json(dto);
  });
  inner.get('/api/runs/:id', (c) => {
    const dto = withStore((s) => buildJob(s, c.req.param('id')));
    if (!dto) return err(c, 404, 'err_not_found');
    return c.json(dto);
  });
  inner.get('/api/outputs/:id', (c) => {
    if (!/^\d+$/.test(c.req.param('id'))) return err(c, 404, 'err_not_found');
    const dto = withStore((s) => buildOutput(s, Number(c.req.param('id'))));
    if (!dto) return err(c, 404, 'err_not_found');
    return c.json(dto);
  });
  inner.get('/api/demo', (c) => {
    const dto = withStore((s) => buildJob(s, DEMO_JOB_ID));
    if (!dto) return err(c, 404, 'err_not_found');
    return c.json(dto);
  });

  // --- media by record id ---
  inner.get('/media/:kind/:id', async (c) => {
    const kind = c.req.param('kind') as MediaKind;
    if (!MEDIA_KINDS.includes(kind)) return err(c, 404, 'err_not_found');
    const m = await resolveMedia({ repoRoot, dbPath }, kind, c.req.param('id'));
    if (!m) return err(c, 404, 'err_not_found');
    return sendFile(c, m.file, m.contentType, 'public, max-age=3600');
  });
  inner.get('/media/mask/:source/:mask', async (c) => {
    const m = await resolveMask({ repoRoot, dbPath }, c.req.param('source'), c.req.param('mask'));
    if (!m) return err(c, 404, 'err_not_found');
    return sendFile(c, m.file, m.contentType, 'public, max-age=3600');
  });
  inner.get('/media/templatemask/:id', async (c) => {
    const row = withStore((s) => s.getTemplate(c.req.param('id')));
    if (!row) return err(c, 404, 'err_not_found');
    const rel = `${dirname(row.image_path)}/mask-logo.png`;
    const bytes = await readContainedFile(repoRoot, rel);
    if (!bytes) return err(c, 404, 'err_not_found');
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' },
    });
  });

  // --- brands ---
  inner.post('/api/brands', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    const parsed = brandBodySchema.safeParse(body);
    if (!parsed.success) return err(c, 400, 'err_bad_request');
    const id = newId('brand');
    withStore((s) => s.insertBrand({ id, name: parsed.data.name, colors: parsed.data.colors, fonts: parsed.data.fonts, logoPath: null, isDemo: false, expiresAt: dayFromNow() }));
    return c.json({ id }, 201);
  });
  inner.delete('/api/brands/:id', async (c) => {
    const id = c.req.param('id');
    const row = withStore((s) => s.getBrand(id));
    if (!row) return err(c, 404, 'err_not_found');
    if (row.is_demo === 1) return err(c, 400, 'err_bad_request');
    const templates = withStore((s) => s.templatesForBrand(id));
    await unlinkData([row.logo_path, ...templates.flatMap((t) => [t.image_path, t.frame_path])]);
    withStore((s) => s.deleteBrand(id));
    return c.json({ ok: true });
  });
  inner.post('/api/brands/:id/logo', async (c) => {
    const row = withStore((s) => s.getBrand(c.req.param('id')));
    if (!row) return err(c, 404, 'err_not_found');
    if (row.is_demo === 1) return err(c, 400, 'err_bad_request');
    const len = c.req.header('content-length');
    if (len && Number(len) > cfg.uploadMaxBytes + 65536) return err(c, 413, 'err_too_large');
    let parsed: Record<string, unknown>;
    try {
      parsed = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    const files = collectFiles(parsed);
    if (files.length !== 1) return err(c, 400, 'err_bad_request');
    const raw = Buffer.from(await (files[0] as UploadedFile).arrayBuffer());
    try {
      const stored = await validateAndStoreUpload(repoRoot, raw, cfg.uploadMaxBytes, cfg.uploadMaxPixels, 'logos', 'logo.png');
      await unlinkData([row.logo_path]);
      withStore((s) => s.setBrandLogo(row.id, stored.relPath));
      return c.json({ logo: `media/logo/${row.id}` });
    } catch (e) {
      if (e instanceof UploadError) return err(c, e.key === 'err_too_large' ? 413 : 400, e.key);
      throw e;
    }
  });
  inner.post('/api/brands/:id/templates', async (c) => {
    if (!cfg.live) return err(c, 503, 'err_live_off');
    const row = withStore((s) => s.getBrand(c.req.param('id')));
    if (!row) return err(c, 404, 'err_not_found');
    if (row.is_demo === 1) return err(c, 400, 'err_bad_request');
    const len = c.req.header('content-length');
    if (len && Number(len) > (cfg.uploadMaxBytes + 65536) * 2) return err(c, 413, 'err_too_large');
    let parsed: Record<string, unknown>;
    try {
      parsed = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    const presetRaw = typeof parsed.preset === 'string' && parsed.preset !== '' ? parsed.preset : null;
    if (presetRaw !== null && !presetById(presetRaw)) return err(c, 400, 'err_bad_request');
    const imageFile = parsed.image;
    const frameFile = parsed.frame;
    if (!isFile(imageFile) || (frameFile !== undefined && !isFile(frameFile))) return err(c, 400, 'err_bad_request');
    try {
      const stored = await validateAndStoreUpload(repoRoot, Buffer.from(await imageFile.arrayBuffer()), cfg.uploadMaxBytes, cfg.uploadMaxPixels, 'templates', 'template.png');
      let framePath: string | null = null;
      if (isFile(frameFile)) {
        const frame = await validateAndStoreUpload(repoRoot, Buffer.from(await frameFile.arrayBuffer()), cfg.uploadMaxBytes, cfg.uploadMaxPixels, 'templates', 'frame.png');
        framePath = frame.relPath;
      }
      const id = newId('tpl');
      withStore((s) => s.insertTemplate({ id, brandId: row.id, preset: presetRaw, imagePath: stored.relPath, framePath, expiresAt: dayFromNow() }));
      parseTemplate(id);
      return c.json({ id, status: 'pending' }, 202);
    } catch (e) {
      if (e instanceof UploadError) return err(c, e.key === 'err_too_large' ? 413 : 400, e.key);
      throw e;
    }
  });
  inner.patch('/api/templates/:id', async (c) => {
    const row = withStore((s) => s.getTemplate(c.req.param('id')));
    if (!row) return err(c, 404, 'err_not_found');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    const parsed = templatePatchSchema.safeParse(body);
    if (!parsed.success) return err(c, 400, 'err_bad_request');
    if (parsed.data.preset !== undefined) {
      if (parsed.data.preset !== null && !presetById(parsed.data.preset)) return err(c, 400, 'err_bad_request');
      withStore((s) => s.setTemplatePreset(row.id, parsed.data.preset ?? null));
    }
    if (parsed.data.spec !== undefined) {
      const spec = templateSpecSchema.safeParse(parsed.data.spec);
      if (!spec.success || !specBoxesNormalized(spec.data)) return err(c, 400, 'err_bad_request');
      withStore((s) => s.updateTemplateSpec(row.id, JSON.stringify(spec.data)));
    }
    return c.json({ ok: true });
  });
  inner.delete('/api/templates/:id', async (c) => {
    const row = withStore((s) => s.getTemplate(c.req.param('id')));
    if (!row) return err(c, 404, 'err_not_found');
    const brand = withStore((s) => s.getBrand(row.brand_id));
    if (brand?.is_demo === 1) return err(c, 400, 'err_bad_request');
    await unlinkData([row.image_path, row.frame_path]);
    withStore((s) => s.deleteTemplate(row.id));
    return c.json({ ok: true });
  });

  // --- brand auto-match (one light Spark call; gated on live + daily cap) ---
  inner.post('/api/match', async (c) => {
    if (!cfg.live) return err(c, 503, 'err_live_off');
    if (capped('model')) return err(c, 503, 'err_live_off');
    const len = c.req.header('content-length');
    if (len && Number(len) > cfg.uploadMaxBytes + 65536) return err(c, 413, 'err_too_large');
    let parsed: Record<string, unknown>;
    try {
      parsed = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    const files = collectFiles(parsed);
    if (files.length !== 1) return err(c, 400, 'err_bad_request');
    const raw = Buffer.from(await (files[0] as UploadedFile).arrayBuffer());
    let checked: { bytes: Buffer; width: number; height: number };
    try {
      checked = await validateImageBytes(raw, cfg.uploadMaxBytes, cfg.uploadMaxPixels);
    } catch (e) {
      if (e instanceof UploadError) return err(c, e.key === 'err_too_large' ? 413 : 400, e.key);
      throw e;
    }
    const brands = withStore((s) => s.allBrands());
    const candidates = [];
    for (const b of brands) {
      let colors: string[] = [];
      try {
        colors = JSON.parse(b.colors_json) as string[];
      } catch {
        colors = [];
      }
      const logoBytes = b.logo_path ? await readContainedFile(repoRoot, b.logo_path) : null;
      candidates.push({ name: b.name, colors, logoBytes, logoMime: 'image/png' });
    }
    try {
      const match = await matchBrand(makeClient(), { imageBytes: checked.bytes, mimeType: 'image/png', model: extractModel, candidates });
      withStore((s) => s.recordUsage('model', 1));
      const brandId = match.brand_index !== null ? (brands[match.brand_index]?.id ?? null) : null;
      return c.json({ brandId, reason: match.reason });
    } catch {
      return err(c, 500, 'err_unknown');
    }
  });

  // --- live generation jobs ---
  inner.post('/api/jobs', async (c) => {
    if (!cfg.live) return err(c, 503, 'err_live_off');
    const len = c.req.header('content-length');
    if (len && Number(len) > (cfg.uploadMaxBytes + 65536) * 3) return err(c, 413, 'err_too_large');
    let parsed: Record<string, unknown>;
    try {
      parsed = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    const mode = parsed.mode === 'fast' ? 'fast' : parsed.mode === undefined || parsed.mode === 'protected' ? 'protected' : null;
    if (!mode) return err(c, 400, 'err_bad_request');
    const sizes = typeof parsed.sizes === 'string' ? [...new Set(parsed.sizes.split(',').map((s) => s.trim()).filter(Boolean))] : [];
    if (sizes.length === 0 || sizes.length > 8 || !sizes.every((s) => presetById(s))) return err(c, 400, 'err_bad_request');
    const brandId = typeof parsed.brandId === 'string' && parsed.brandId !== '' ? parsed.brandId : null;
    const brand = brandId ? withStore((s) => s.getBrand(brandId)) : null;
    if (brandId && !brand) return err(c, 400, 'err_bad_request');

    // Sources: uploaded files, or one fixture source for "Run it live".
    const raws: Array<{ id: string; bytes: Buffer; width: number; height: number; relPath: string; fixture: boolean }> = [];
    const demoSource = typeof parsed.demoSource === 'string' ? parsed.demoSource : null;
    try {
      if (demoSource) {
        const rel = DEMO_SOURCES[demoSource];
        if (!rel) return err(c, 400, 'err_bad_request');
        const bytes = await readContainedFile(repoRoot, rel);
        if (!bytes) return err(c, 500, 'err_unknown');
        const meta = await sharp(bytes).metadata();
        raws.push({ id: newId('src'), bytes, width: meta.width ?? 0, height: meta.height ?? 0, relPath: rel, fixture: true });
      } else {
        const files = collectFiles(parsed);
        if (files.length === 0 || files.length > 3) return err(c, 400, 'err_too_many');
        for (const f of files) {
          const buf = Buffer.from(await f.arrayBuffer());
          const stored = await validateAndStoreUpload(repoRoot, buf, cfg.uploadMaxBytes, cfg.uploadMaxPixels, 'uploads', 'source.png');
          const bytes = await readFile(join(repoRoot, stored.relPath));
          raws.push({ id: newId('src'), bytes, width: stored.width, height: stored.height, relPath: stored.relPath, fixture: false });
        }
      }
    } catch (e) {
      if (e instanceof UploadError) return err(c, e.key === 'err_too_large' ? 413 : e.key === 'err_too_many_pixels' ? 400 : 400, e.key);
      throw e;
    }

    if (!limiter.check(clientIp(c, cfg.trustProxy))) {
      await unlinkData(raws.filter((r) => !r.fixture).map((r) => r.relPath));
      return err(c, 429, 'err_rate');
    }
    if (capped('model') || capped('image')) {
      await unlinkData(raws.filter((r) => !r.fixture).map((r) => r.relPath));
      return err(c, 503, 'err_live_off');
    }

    for (const r of raws) {
      withStore((s) => s.insertSource({ id: r.id, imagePath: r.relPath, width: r.width, height: r.height, expiresAt: dayFromNow() }));
    }
    const storeJobId = newId('job');
    withStore((s) => s.insertJob({ id: storeJobId, brandId, mode, sizes, sources: raws.map((r) => r.id) }));

    const total = raws.length * sizes.length;
    const job = jobs.submit('generate', total, async (onRow) => {
      const { prepared, traces, failed } = await prepareAll(raws);
      if (failed.size > 0) {
        withStore((s) => s.recordUsage('model', 0));
        for (const [sid, message] of failed) {
          const idx = raws.findIndex((r) => r.id === sid);
          for (const presetId of sizes) {
            const outputId = withStore((s) =>
              s.insertOutput({
                jobId: storeJobId, sourceId: sid, preset: presetId, mode, status: 'failed',
                imagePath: '', planJson: '{}', proofJson: null, qaJson: null, retries: 0,
                modelCalls: 0, imageCalls: 0, latencyMs: 0,
                traceJson: JSON.stringify(traces.get(sid)?.all() ?? []), error: message,
              }),
            );
            onRow({ outputId, sourceId: sid, sourceIndex: idx, preset: presetId, status: 'failed', retries: 0, error: message });
          }
        }
      }
      const cells = prepared.flatMap((p) => sizes.map((presetId) => ({ source: p, sourceIndex: raws.findIndex((r) => r.id === p.id), presetId })));
      if (cells.length === 0) {
        withStore((s) => s.finishJob(storeJobId, 'failed', 'all sources failed to analyze', 0, 0));
        return { jobId: storeJobId };
      }
      return executeJob(storeJobId, cells, mode, brandId, brand?.name ?? null, traces, onRow);
    });
    if (!job) {
      await unlinkData(raws.filter((r) => !r.fixture).map((r) => r.relPath));
      return err(c, 429, 'err_busy');
    }
    return c.json({ key: job.id, status: job.status, jobId: storeJobId }, 202);
  });

  inner.post('/api/outputs/:id/regenerate', async (c) => {
    if (!cfg.live) return err(c, 503, 'err_live_off');
    if (!/^\d+$/.test(c.req.param('id'))) return err(c, 404, 'err_not_found');
    const prev = withStore((s) => s.getOutput(Number(c.req.param('id'))));
    if (!prev) return err(c, 404, 'err_not_found');
    const prevJob = withStore((s) => s.getJob(prev.job_id));
    if (!prevJob) return err(c, 404, 'err_not_found');
    const source = withStore((s) => s.getSource(prev.source_id));
    if (!source) return err(c, 404, 'err_not_found');
    if (!limiter.check(clientIp(c, cfg.trustProxy))) return err(c, 429, 'err_rate');
    if (capped('model') || capped('image')) return err(c, 503, 'err_live_off');

    const bytes = await readContainedFile(repoRoot, source.image_path);
    if (!bytes) return err(c, 404, 'err_not_found');
    const storeJobId = newId('job');
    const mode = (prev.mode === 'fast' ? 'fast' : 'protected') as FitMode;
    withStore((s) => s.insertJob({ id: storeJobId, brandId: prevJob.brand_id, mode, sizes: [prev.preset], sources: [source.id] }));
    const brand = prevJob.brand_id ? withStore((s) => s.getBrand(prevJob.brand_id as string)) : null;
    const job = jobs.submit('regenerate', 1, async (onRow) => {
      const { prepared, traces, failed } = await prepareAll([{ id: source.id, bytes, width: source.width, height: source.height }]);
      if (failed.size > 0 || prepared.length === 0) {
        const message = failed.get(source.id) ?? 'source analysis failed';
        const outputId = withStore((s) =>
          s.insertOutput({
            jobId: storeJobId, sourceId: source.id, preset: prev.preset, mode, status: 'failed',
            imagePath: '', planJson: '{}', proofJson: null, qaJson: null, retries: 0,
            modelCalls: 0, imageCalls: 0, latencyMs: 0, traceJson: '[]', error: message,
          }),
        );
        onRow({ outputId, sourceId: source.id, sourceIndex: 0, preset: prev.preset, status: 'failed', retries: 0, error: message });
        withStore((s) => s.finishJob(storeJobId, 'failed', message, 0, 0));
        return { jobId: storeJobId };
      }
      return executeJob(
        storeJobId,
        [{ source: prepared[0] as PreparedSource, sourceIndex: 0, presetId: prev.preset }],
        mode,
        prevJob.brand_id,
        brand?.name ?? null,
        traces,
        onRow,
      );
    });
    if (!job) return err(c, 429, 'err_busy');
    return c.json({ key: job.id, status: job.status, jobId: storeJobId }, 202);
  });

  inner.get('/api/live/:key', (c) => {
    const job = jobs.get(c.req.param('key'));
    if (!job) return err(c, 404, 'err_not_found');
    return c.json({ job: summarize(job) });
  });

  inner.get('/api/live/:key/events', (c) => {
    const job = jobs.get(c.req.param('key'));
    if (!job) return err(c, 404, 'err_not_found');
    return sseResponse(job);
  });

  // --- download all (ZIP with manifest) ---
  inner.get('/api/runs/:id/zip', async (c) => {
    const job = withStore((s) => s.getJob(c.req.param('id')));
    if (!job) return err(c, 404, 'err_not_found');
    const outputs = withStore((s) => s.outputsForJob(job.id)).filter((o) => o.status !== 'failed' && o.image_path);
    if (outputs.length === 0) return err(c, 404, 'err_not_found');
    const entries = [];
    const manifest = [];
    for (const o of outputs) {
      const bytes = await readContainedFile(repoRoot, o.image_path);
      if (!bytes) continue;
      const name = `${BRAND_SLUG}-${o.preset}-${o.id}.png`;
      entries.push({ name, data: bytes });
      manifest.push({ file: name, preset: o.preset, source: o.source_id, mode: o.mode, status: o.status, qa: o.qa_json ? JSON.parse(o.qa_json) : null, sha256: sha256Hex(bytes) });
    }
    if (entries.length === 0) return err(c, 404, 'err_not_found');
    entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify({ job: job.id, brand: job.brand_id, mode: job.mode, generatedAt: job.finished_at ?? job.created_at, outputs: manifest }, null, 2)) });
    const zip = buildZip(entries);
    return new Response(zip as unknown as BodyInit, {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${BRAND_SLUG}-${job.id}.zip"`,
        'content-length': String(zip.length),
      },
    });
  });

  if (cfg.basePath === '/') return inner;
  const mount = cfg.basePath.replace(/\/+$/, '');
  const outer = new Hono();
  outer.use('*', async (c, next) => {
    securityHeaders(c);
    await next();
  });
  outer.get(`${mount}/`, (c) => sendFile(c, join(webRoot, 'index.html'), 'text/html; charset=utf-8', 'no-cache'));
  outer.notFound((c) => err(c, 404, 'err_not_found'));
  outer.onError((e, c) => {
    console.error(`web error: ${e instanceof Error ? e.message : String(e)}`);
    return err(c, 500, 'err_unknown');
  });
  outer.route(mount, inner);
  return outer;
}
