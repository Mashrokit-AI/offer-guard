import { Hono, type Context } from 'hono';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type OpenAI from 'openai';
import { z } from 'zod';
import { loadModelConfig } from '../../shared/config.js';
import { createModelClient } from '../models/client.js';
import { loadOfferSpec, toDayMonth } from '../repair/spec.js';
import { Store } from '../store/db.js';
import {
  loadManifest,
  manifestSchema,
  runSweep,
  type SweepOptions,
  type SweepReport,
} from '../workflow/sweep.js';
import { loadHttpConfig, type HttpConfig } from './config.js';
import { buildCampaign, buildDetail, buildRunTrace } from './dto.js';
import { JobManager, RateLimiter, sseResponse, summarize } from './jobs.js';
import { MEDIA_KINDS, resolveMedia, type MediaKind } from './media.js';
import { UploadError, validateAndStoreUpload } from './uploads.js';

/**
 * Public read-only web app + bounded live jobs. This module never touches
 * the Graph API: no write-path imports, no publish path. (A test enforces
 * the module graph; keep this comment free of the forbidden substrings.)
 */

export interface AppDeps {
  repoRoot: string;
  dbPath?: string;
  /** Campaign manifest, repo-relative. Default: fixtures/campaign.json. */
  manifestRel?: string;
  /** Expected verdicts, repo-relative; null disables. Default: tests/fixtures/expected-verdicts.json. */
  expectedRel?: string | null;
  webRoot?: string;
  http?: Partial<HttpConfig>;
  runSweepFn?: (opts: SweepOptions) => Promise<SweepReport>;
  makeClient?: () => OpenAI;
  extractModel?: string;
  samModel?: string;
  allowedHosts?: string[];
  pagesBase?: string | null;
}

export const CHECK_PAGES = [
  'gali-offer-he.html',
  'gali-offer-en.html',
  'gali-offer-wrong-he.html',
  'gali-offer-wrong-en.html',
] as const;

const CSP =
  // No inline scripts or event handlers anywhere; dynamic evidence geometry
  // (bbox overlays, slider, progress) is positioned with computed inline
  // styles, so style-src allows 'unsafe-inline' while script stays strict.
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

const CHECK_FIELDS = ['image', 'copy', 'percent', 'scope', 'shipping', 'valid', 'page'] as const;

/** Strict: unknown fields are rejected, never ignored. */
const freshBodySchema = z.object({}).strict();

const checkFieldsSchema = z
  .object({
    copy: z.string().max(2000).optional().default(''),
    percent: z
      .string()
      .regex(/^\d{1,2}$/)
      .refine((n) => Number(n) <= 90),
    scope: z.enum(['all', 'selected_models']),
    shipping: z.enum(['free', 'paid']),
    valid: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    page: z.enum(CHECK_PAGES),
  })
  .strict();

interface CheckInput {
  copy: string;
  percent: number;
  scope: 'all' | 'selected_models';
  shipping: 'free' | 'paid';
  valid: string;
  page: (typeof CHECK_PAGES)[number];
}

function parseCheckBody(body: Record<string, unknown>): CheckInput | null {
  for (const k of Object.keys(body)) {
    if (!(CHECK_FIELDS as readonly string[]).includes(k)) return null;
  }
  const imageFile = body.image as { arrayBuffer?: () => Promise<ArrayBuffer> } | undefined;
  if (!imageFile || typeof imageFile.arrayBuffer !== 'function') return null;
  const { image: _ignored, ...rest } = body;
  const parsed = checkFieldsSchema.safeParse(rest);
  if (!parsed.success) return null;
  const dt = new Date(`${parsed.data.valid}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== parsed.data.valid) return null;
  return {
    copy: parsed.data.copy,
    percent: Number(parsed.data.percent),
    scope: parsed.data.scope,
    shipping: parsed.data.shipping,
    valid: parsed.data.valid,
    page: parsed.data.page,
  };
}

export function createApp(deps: AppDeps): Hono {
  const repoRoot = deps.repoRoot;
  const cfg: HttpConfig = { ...loadHttpConfig(process.env), ...deps.http };
  const dbPath = deps.dbPath ?? join(repoRoot, 'data', 'offer-guard.db');
  const manifestRel = deps.manifestRel ?? 'fixtures/campaign.json';
  const manifestPath = join(repoRoot, manifestRel);
  const expectedRel = deps.expectedRel === undefined ? 'tests/fixtures/expected-verdicts.json' : deps.expectedRel;
  const expectedPath = expectedRel === null ? null : join(repoRoot, expectedRel);
  const webRoot = deps.webRoot ?? join(repoRoot, 'dist', 'web');
  const runSweepFn = deps.runSweepFn ?? runSweep;
  const makeClient = deps.makeClient ?? (() => createModelClient(loadModelConfig(process.env)));
  const extractModel = deps.extractModel ?? 'muse-spark-1.3';
  const samModel = deps.samModel ?? 'sam-3.1';
  const allowedHosts = deps.allowedHosts ?? ['127.0.0.1'];
  const pagesBase = deps.pagesBase === undefined ? process.env.OFFER_GUARD_PAGES_BASE?.trim() || null : deps.pagesBase;

  const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const manifestImages = new Map(manifest.entries.map((e) => [`${e.id}/${e.lang}`, e.image]));

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

  const dailyCapped = (): boolean =>
    withStore((s) => s.countModelCallsSince(utcMidnightIso())) >= cfg.dailyModelCalls;

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
  inner.get('/api/campaign', (c) => {
    const dto = withStore((s) => buildCampaign(s, manifestRel));
    if (!dto) return err(c, 404, 'err_not_found');
    return c.json(dto);
  });
  inner.get('/api/ads/:id', (c) => {
    if (!/^\d+$/.test(c.req.param('id'))) return err(c, 404, 'err_not_found');
    const dto = withStore((s) => buildDetail(repoRoot, s, Number(c.req.param('id'))));
    if (!dto) return err(c, 404, 'err_not_found');
    return c.json(dto);
  });
  inner.get('/api/runs/:id/trace', (c) => {
    if (!/^\d+$/.test(c.req.param('id'))) return err(c, 404, 'err_not_found');
    const dto = withStore((s) => buildRunTrace(s, Number(c.req.param('id'))));
    if (!dto) return err(c, 404, 'err_not_found');
    return c.json(dto);
  });

  // --- media by record id ---
  inner.get('/media/:kind/:id', async (c) => {
    const kind = c.req.param('kind') as MediaKind;
    if (!MEDIA_KINDS.includes(kind)) return err(c, 404, 'err_not_found');
    const m = await resolveMedia(
      { repoRoot, dbPath, sourceFallback: (k) => manifestImages.get(k) ?? null },
      kind,
      c.req.param('id'),
      c.req.query('shot'),
    );
    if (!m) return err(c, 404, 'err_not_found');
    return sendFile(c, m.file, m.contentType, 'public, max-age=3600');
  });

  // --- demo landing pages (read-only) ---
  inner.get('/pages/:file', (c) => {
    const f = c.req.param('file');
    if (!/^[A-Za-z0-9_-]+\.html$/.test(f)) return err(c, 404, 'err_not_found');
    return sendFile(c, join(repoRoot, 'fixtures', 'pages', f), 'text/html; charset=utf-8', 'public, max-age=3600');
  });

  // --- live jobs ---
  inner.post('/api/runs/fresh', async (c) => {
    if (!cfg.live) return err(c, 503, 'err_live_off');
    const len = c.req.header('content-length');
    if (len && Number(len) > 1024) return err(c, 413, 'err_too_large');
    const raw = await c.req.text();
    if (raw.length > 1024) return err(c, 413, 'err_too_large');
    try {
      const v: unknown = raw.trim() === '' ? {} : JSON.parse(raw);
      if (!freshBodySchema.safeParse(v).success) return err(c, 400, 'err_bad_request');
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    if (!limiter.check(clientIp(c, cfg.trustProxy))) return err(c, 429, 'err_rate');
    if (dailyCapped()) return err(c, 503, 'err_live_off');
    const job = jobs.submit('fresh', manifest.entries.length, async (onRow) => {
      const client = makeClient();
      await runSweepFn({
        repoRoot,
        manifestPath,
        expectedPath,
        fresh: true,
        lang: 'en',
        client,
        extractModel,
        samModel,
        allowedHosts,
        pagesBase,
        dbPath,
        onRow,
      });
      return {};
    });
    if (!job) return err(c, 429, 'err_busy');
    return c.json({ jobId: job.id, status: job.status }, 202);
  });

  inner.get('/api/jobs/:id', (c) => {
    const job = jobs.get(c.req.param('id'));
    if (!job) return err(c, 404, 'err_not_found');
    return c.json({ job: summarize(job) });
  });

  inner.get('/api/jobs/:id/events', (c) => {
    const job = jobs.get(c.req.param('id'));
    if (!job) return err(c, 404, 'err_not_found');
    return sseResponse(job);
  });

  inner.post('/api/checks', async (c) => {
    if (!cfg.live) return err(c, 503, 'err_live_off');
    const len = c.req.header('content-length');
    if (len && Number(len) > cfg.uploadMaxBytes + 65536) return err(c, 413, 'err_too_large');
    let parsed: Record<string, unknown>;
    try {
      parsed = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    const input = parseCheckBody(parsed);
    if (!input) return err(c, 400, 'err_bad_request');
    const file = parsed.image as { arrayBuffer: () => Promise<ArrayBuffer>; size?: number };
    if (typeof file.size === 'number' && file.size > cfg.uploadMaxBytes) return err(c, 413, 'err_too_large');
    if (!limiter.check(clientIp(c, cfg.trustProxy))) return err(c, 429, 'err_rate');
    if (dailyCapped()) return err(c, 503, 'err_live_off');
    const bytes = Buffer.from(await file.arrayBuffer());
    let stored;
    try {
      stored = await validateAndStoreUpload(repoRoot, bytes, cfg.uploadMaxBytes, cfg.uploadMaxPixels);
    } catch (e) {
      if (e instanceof UploadError) return err(c, e.key === 'err_too_large' ? 413 : 400, e.key);
      throw e;
    }
    // Reuse an identical stored spec version when the fields match (cache
    // key covers spec version, so identical resubmissions hit the cache).
    const dayMonth = toDayMonth(input.valid);
    const version = withStore((s) => {
      let max = 0;
      for (const row of s.allSpecs()) {
        max = Math.max(max, row.version);
        try {
          const o = loadOfferSpec(JSON.parse(row.spec_json));
          if (o.percent === input.percent && o.scope === input.scope && o.shipping === input.shipping && o.dayMonth === dayMonth) {
            return o.version;
          }
        } catch {
          // A corrupt stored spec never blocks a new check.
        }
      }
      return max + 1;
    });
    const dir = join(repoRoot, 'data', 'uploads', stored.id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'spec.json'),
      JSON.stringify(
        {
          version,
          brand: 'Check-your-own-ad (user supplied)',
          discount: { percent: input.percent, scope: input.scope },
          shipping: input.shipping,
          valid_until: input.valid,
          timezone: 'Asia/Jerusalem',
          required_disclosures: [],
        },
        null,
        2,
      ),
    );
    const pageLang = input.page.includes('-he.') ? 'he' : 'en';
    const checkManifestPath = join(dir, 'manifest.json');
    await writeFile(
      checkManifestPath,
      JSON.stringify(
        {
          name: `own-ad check ${stored.id}`,
          spec: `data/uploads/${stored.id}/spec.json`,
          entries: [
            { id: stored.id, lang: pageLang, image: stored.relPath, copy: input.copy, landing_url: `{PAGES_BASE}/${input.page}` },
          ],
        },
        null,
        2,
      ),
    );
    const job = jobs.submit('check', 1, async (onRow) => {
      const client = makeClient();
      const report = await runSweepFn({
        repoRoot,
        manifestPath: checkManifestPath,
        expectedPath: null,
        fresh: false,
        lang: 'en',
        client,
        extractModel,
        samModel,
        allowedHosts,
        pagesBase,
        dbPath,
        onRow,
      });
      const snap = withStore((s) => s.getSnapshots(report.runId)[0]);
      if (!snap) throw new Error('check produced no snapshot');
      return { snapshotId: snap.id, cached: snap.cached === 1 };
    });
    if (!job) return err(c, 429, 'err_busy');
    return c.json({ jobId: job.id, status: job.status }, 202);
  });

  if (cfg.basePath === '/') return inner;
  const mount = cfg.basePath.replace(/\/+$/, '');
  const outer = new Hono();
  outer.use('*', async (c, next) => {
    securityHeaders(c);
    await next();
  });
  // route() maps inner '/' to the bare mount only; serve the slashed root too.
  outer.get(`${mount}/`, (c) => sendFile(c, join(webRoot, 'index.html'), 'text/html; charset=utf-8', 'no-cache'));
  outer.notFound((c) => err(c, 404, 'err_not_found'));
  outer.onError((e, c) => {
    console.error(`web error: ${e instanceof Error ? e.message : String(e)}`);
    return err(c, 500, 'err_unknown');
  });
  outer.route(mount, inner);
  return outer;
}

/** Re-exported so the jobs route and tests share one manifest loader. */
export { loadManifest };
