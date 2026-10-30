import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type OpenAI from 'openai';
import sharp from 'sharp';
import { z } from 'zod';
import { languageSchema, type AdClaims, type PageClaims } from '../../shared/schemas.js';
import { decideVerdict, type Verdict } from '../../shared/verdict.js';
import type { Lang } from '../../shared/i18n.js';
import { sha256Hex, type ModelUsage } from '../models/client.js';
import { EXTRACT_AD_PROMPT_VERSION, extractAdClaims, ExtractError } from '../models/extract-ad.js';
import { EXTRACT_PAGE_PROMPT_VERSION, extractPageClaims, PageExtractError } from '../models/extract-page.js';
import { CaptureError, CaptureService, type PageCaptureResult } from '../browser/capture.js';
import { startPagesServer, type PagesServer } from '../pages/server.js';
import { snapPanel, PanelSnapError } from '../repair/panel.js';
import { findOutsidePanelContradiction, loadOfferSpec } from '../repair/spec.js';
import { PANEL_TEMPLATE_VERSION } from '../repair/templates.js';
import { decodeRgba } from '../repair/composite.js';
import { Store } from '../store/db.js';
import { sweepCacheKey } from '../store/cache.js';
import { TraceCollector } from './trace.js';
import { runRepairPipeline, type RepairPipelineOutput } from './repair-pipeline.js';

// ---------------------------------------------------------------------------
// Manifest + expected verdicts (local-only inputs, never sent to a model)
// ---------------------------------------------------------------------------

export const manifestEntrySchema = z.object({
  id: z.string().min(1),
  lang: languageSchema,
  image: z.string().min(1),
  copy: z.string(),
  landing_url: z.string().min(1),
});

export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

export const manifestSchema = z.object({
  name: z.string(),
  spec: z.string(),
  entries: z.array(manifestEntrySchema).min(1),
});

export type Manifest = z.infer<typeof manifestSchema>;

export async function loadManifest(path: string): Promise<Manifest> {
  return manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

/** Substitute the {PAGES_BASE} template with the live pages base URL. */
export function resolveLandingUrl(template: string, pagesBase: string): string {
  return template.replaceAll('{PAGES_BASE}', pagesBase.replace(/\/+$/, ''));
}

const KNOWN_VERDICTS: Verdict[] = [
  'CLEAN',
  'AD_WRONG_REPAIRABLE',
  'AD_WRONG_UNSAFE',
  'PAGE_WRONG',
  'AMBIGUOUS',
  'CAPTURE_FAILED',
  'UNSUPPORTED_FORMAT',
];

export async function loadExpectedVerdicts(path: string): Promise<Record<string, Verdict>> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const out: Record<string, Verdict> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    if (typeof v !== 'string' || !(KNOWN_VERDICTS as string[]).includes(v)) {
      throw new Error(`expected-verdicts: bad verdict for ${k}: ${JSON.stringify(v)}`);
    }
    out[k] = v as Verdict;
  }
  return out;
}

export function adKey(entry: Pick<ManifestEntry, 'id' | 'lang'>): string {
  return `${entry.id}/${entry.lang}`;
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export interface SweepOptions {
  repoRoot: string;
  manifestPath: string;
  expectedPath: string;
  fresh: boolean;
  lang: Lang;
  client: OpenAI;
  extractModel: string;
  samModel: string;
  allowedHosts: string[];
  /** Null = serve fixtures/pages/ on a local static server. */
  pagesBase: string | null;
  dbPath: string;
  onRow?: (row: SweepRow) => void;
}

export interface SweepRow {
  ad: string;
  lang: string;
  expected: string;
  got: string;
  pass: boolean;
  cached: boolean;
  latencyMs: number;
  modelCalls: number;
}

export interface SweepReport {
  runId: number;
  rows: SweepRow[];
  allPass: boolean;
  totalCalls: number;
  totalLatencyMs: number;
  usage: { in: number; out: number; total: number };
  pagesBase: string;
}

function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail = Promise.resolve();
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = tail;
    let release!: () => void;
    tail = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

interface CheckContext {
  options: SweepOptions;
  store: Store;
  runId: number;
  spec: ReturnType<typeof loadOfferSpec>;
  specJson: string;
  expected: Record<string, Verdict>;
  captureService: CaptureService;
  withBrowser: <T>(fn: () => Promise<T>) => Promise<T>;
  captureCache: Map<string, PageCaptureResult>;
  capturePaths: Map<string, string[]>;
  artifactsDir: string;
  modelsTag: string;
  promptsTag: string;
  usages: Array<ModelUsage | undefined>;
}

function insertClaimRows(store: Store, snapshotId: number, ad: AdClaims, page: PageClaims | null): void {
  const rows: Array<{ source: string; field: string; normalized: string; verbatim: string; evidenceId: string }> = [
    { source: 'ad', field: 'percent', normalized: ad.discount.percent === null ? '(none stated)' : `${ad.discount.percent}%`, verbatim: ad.discount.verbatim, evidenceId: 'ad:discount' },
    { source: 'ad', field: 'scope', normalized: ad.discount.scope, verbatim: ad.discount.verbatim, evidenceId: 'ad:discount' },
    { source: 'ad', field: 'shipping', normalized: ad.shipping.terms, verbatim: ad.shipping.verbatim, evidenceId: 'ad:shipping' },
    { source: 'ad', field: 'valid_until', normalized: ad.valid_until.day_month ?? '(none stated)', verbatim: ad.valid_until.verbatim, evidenceId: 'ad:valid_until' },
  ];
  if (page) {
    rows.push(
      { source: 'page', field: 'percent', normalized: page.discount.percent === null ? '(none stated)' : `${page.discount.percent}%`, verbatim: page.discount.verbatim, evidenceId: 'page:discount' },
      { source: 'page', field: 'scope', normalized: page.discount.scope, verbatim: page.discount.verbatim, evidenceId: 'page:discount' },
      { source: 'page', field: 'shipping', normalized: page.shipping.terms, verbatim: page.shipping.verbatim, evidenceId: 'page:shipping' },
      { source: 'page', field: 'valid_until', normalized: page.valid_until.day_month ?? '(none stated)', verbatim: page.valid_until.verbatim, evidenceId: 'page:valid_until' },
    );
  }
  for (const r of rows) store.insertClaim({ snapshotId, ...r });
}

function insertTraceRows(store: Store, snapshotId: number, trace: TraceCollector): void {
  for (const e of trace.all()) {
    store.insertTrace({
      snapshotId,
      seq: e.seq,
      step: e.step,
      toolOrModel: e.tool_or_model,
      inputSummary: e.input_summary,
      outputSummary: e.output_summary,
      durationMs: e.duration_ms,
      evidenceIds: e.evidence_ids,
      nextState: e.next_state,
      cached: e.cached,
    });
  }
}

async function checkAd(ctx: CheckContext, entry: ManifestEntry, pagesBase: string): Promise<SweepRow> {
  const { options, store } = ctx;
  const key = adKey(entry);
  const expected = ctx.expected[key];
  if (!expected) throw new Error(`no expected verdict for ${key} in ${options.expectedPath}`);
  const started = Date.now();
  let modelCalls = 0;

  const imageBytes = await readFile(resolve(options.repoRoot, entry.image));
  const landingUrl = resolveLandingUrl(entry.landing_url, pagesBase);
  const cacheKey = sweepCacheKey({
    imageBytes,
    copy: entry.copy,
    landingUrl,
    specVersion: ctx.spec.version,
    models: ctx.modelsTag,
    promptVersions: ctx.promptsTag,
  });

  // --- cache hit: reuse, record cached:true with the original capture time ---
  if (!options.fresh) {
    const hit = store.findByCacheKey(cacheKey);
    if (hit) {
      const trace = new TraceCollector();
      trace.emit({
        step: 'cache_lookup',
        tool_or_model: 'code:store',
        input_summary: `key=${cacheKey.slice(0, 12)}…`,
        output_summary: `HIT verdict=${hit.snapshot.verdict} captured_at=${hit.snapshot.capture_time}`,
        duration_ms: Date.now() - started,
        evidence_ids: [],
        next_state: 'done',
        cached: true,
      });
      const snapshotId = store.insertSnapshot({
        run_id: ctx.runId,
        ad_key: key,
        image_sha256: sha256Hex(imageBytes),
        image_bytes: imageBytes.length,
        copy: entry.copy,
        landing_url: landingUrl,
        cache_key: cacheKey,
        capture_time: new Date().toISOString(),
        original_capture_time: hit.snapshot.capture_time,
        verdict: hit.snapshot.verdict,
        expected,
        pass: hit.snapshot.verdict === expected ? 1 : 0,
        cached: 1,
        latency_ms: Date.now() - started,
        model_calls: 0,
      });
      if (hit.capture) {
        store.insertCapture({
          snapshotId,
          requestedUrl: hit.capture.requested_url,
          finalUrl: hit.capture.final_url,
          captureTime: hit.capture.capture_time,
          screenshotPaths: JSON.parse(hit.capture.screenshot_paths) as string[],
          chunksJson: hit.capture.chunks_json,
        });
      }
      for (const c of hit.claims) {
        store.insertClaim({
          snapshotId,
          source: c.source,
          field: c.field,
          normalized: c.normalized,
          verbatim: c.verbatim,
          evidenceId: c.evidence_id,
        });
      }
      for (const f of hit.findings) {
        store.insertFinding({
          snapshotId,
          kind: f.kind,
          side: f.side,
          field: f.field,
          specValue: f.spec_value,
          observedValue: f.observed_value,
          evidenceIds: JSON.parse(f.evidence_ids_json) as string[],
          detail: f.detail,
        });
      }
      insertTraceRows(store, snapshotId, trace);
      const row: SweepRow = {
        ad: entry.id, lang: entry.lang, expected, got: hit.snapshot.verdict,
        pass: hit.snapshot.verdict === expected, cached: true,
        latencyMs: Date.now() - started, modelCalls: 0,
      };
      options.onRow?.(row);
      return row;
    }
  }

  const trace = new TraceCollector();
  trace.emit({
    step: 'snapshot',
    tool_or_model: 'code:sweep',
    input_summary: `${entry.image} + ${landingUrl}`,
    output_summary: `sha=${sha256Hex(imageBytes).slice(0, 12)}… bytes=${imageBytes.length} cache=${options.fresh ? 'bypassed(--fresh)' : 'miss'}`,
    duration_ms: Date.now() - started,
    evidence_ids: [],
    next_state: 'extract_ad',
    cached: false,
  });

  try {
    // --- extract ad ---
    const meta = await sharp(imageBytes).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    const adStart = Date.now();
    const extracted = await extractAdClaims(options.client, {
      imageBytes, mimeType: 'image/png', width, height, model: options.extractModel,
    });
    modelCalls += extracted.attempts.length;
    for (const a of extracted.attempts) ctx.usages.push(a.usage);
    const ad = extracted.claims;
    trace.emit({
      step: 'extract_ad',
      tool_or_model: `model:${options.extractModel}`,
      input_summary: `image ${width}x${height} sha=${sha256Hex(imageBytes).slice(0, 12)}…`,
      output_summary: `${ad.discount.percent ?? '?'}%/${ad.discount.scope}/${ad.shipping.terms}/${ad.valid_until.day_month ?? '?'} mode=${extracted.outputMode} coords=${extracted.coordSystem}`,
      duration_ms: Date.now() - adStart,
      evidence_ids: ['ad:discount', 'ad:shipping', 'ad:valid_until'],
      next_state: 'capture_page',
      cached: false,
    });

    // --- capture page (one capture per identical URL per sweep) ---
    const capStart = Date.now();
    let capture: PageCaptureResult;
    let captureReused = false;
    try {
      capture = await ctx.withBrowser(async () => {
        const cached = ctx.captureCache.get(landingUrl);
        if (cached) {
          captureReused = true;
          return cached;
        }
        const fresh = await ctx.captureService.capture(landingUrl, entry.lang);
        ctx.captureCache.set(landingUrl, fresh);
        return fresh;
      });
    } catch (err) {
      if (!(err instanceof CaptureError)) throw err;
      const out = decideVerdict({ spec: ctx.spec, ad, page: null, captureFailed: true, repairBlockers: [], lang: options.lang });
      trace.emit({
        step: 'capture_page',
        tool_or_model: 'chromium:capture',
        input_summary: landingUrl,
        output_summary: `CAPTURE_FAILED: ${err.reason}`,
        duration_ms: Date.now() - capStart,
        evidence_ids: [],
        next_state: 'done',
        cached: false,
      });
      const snapshotId = store.insertSnapshot({
        run_id: ctx.runId, ad_key: key, image_sha256: sha256Hex(imageBytes), image_bytes: imageBytes.length,
        copy: entry.copy, landing_url: landingUrl, cache_key: cacheKey, capture_time: new Date().toISOString(),
        original_capture_time: null, verdict: out.verdict, expected,
        pass: out.verdict === expected ? 1 : 0, cached: 0,
        latency_ms: Date.now() - started, model_calls: modelCalls,
      });
      insertClaimRows(store, snapshotId, ad, null);
      insertTraceRows(store, snapshotId, trace);
      const row: SweepRow = {
        ad: entry.id, lang: entry.lang, expected, got: out.verdict,
        pass: out.verdict === expected, cached: false,
        latencyMs: Date.now() - started, modelCalls,
      };
      options.onRow?.(row);
      return row;
    }
    trace.emit({
      step: 'capture_page',
      tool_or_model: 'chromium:capture',
      input_summary: landingUrl,
      output_summary: `${capture.finalUrl} shots=${capture.screenshots.length} chunks=${capture.chunks.length}${captureReused ? ' (reused)' : ''}`,
      duration_ms: Date.now() - capStart,
      evidence_ids: [],
      next_state: 'extract_page',
      cached: false,
    });

    // --- extract page ---
    const pgStart = Date.now();
    const pextracted = await extractPageClaims(options.client, {
      screenshots: capture.screenshots, mimeType: 'image/png', chunks: capture.chunks, model: options.extractModel,
    });
    modelCalls += pextracted.attempts.length;
    for (const a of pextracted.attempts) ctx.usages.push(a.usage);
    const page = pextracted.claims;
    for (const d of pextracted.droppedQuotes) {
      // eslint-disable-next-line no-console
      console.log(`  [${key}] dropped quote (${d.reason}): ${JSON.stringify(d.text.slice(0, 80))}`);
    }
    trace.emit({
      step: 'extract_page',
      tool_or_model: `model:${options.extractModel}`,
      input_summary: `${capture.screenshots.length} shots + ${capture.chunks.length} chunks`,
      output_summary: `${page.discount.percent ?? '?'}%/${page.discount.scope}/${page.shipping.terms}/${page.valid_until.day_month ?? '?'} quotes=${page.quotes.length} dropped=${pextracted.droppedQuotes.length}`,
      duration_ms: Date.now() - pgStart,
      evidence_ids: page.quotes.flatMap((q) => q.chunk_ids.map((c) => `page:chunk:${c}`)),
      next_state: 'compare_verdict',
      cached: false,
    });

    // --- compare + verdict (cheap repair gates feed the verdict) ---
    const cmpStart = Date.now();
    const before = await decodeRgba(imageBytes);
    const cheapBlockers: string[] = [];
    if (!ad.panel) {
      cheapBlockers.push('panel_not_found');
    } else {
      try {
        const s = snapPanel(before.data, before.width, before.height, { ...ad.panel.bbox });
        if (!s.opaque) cheapBlockers.push('panel_not_opaque');
      } catch (err) {
        if (err instanceof PanelSnapError) cheapBlockers.push(err.blocker);
        else throw err;
      }
    }
    if (findOutsidePanelContradiction(ctx.spec, ad)) cheapBlockers.push('wrong_text_outside_panel');
    const out = decideVerdict({ spec: ctx.spec, ad, page, captureFailed: false, repairBlockers: cheapBlockers, lang: options.lang });
    trace.emit({
      step: 'compare_verdict',
      tool_or_model: 'code:verdict',
      input_summary: `ad=[${out.comparisons.map((c) => `${c.field}:${c.ad}`).join(',')}] page=[${out.comparisons.map((c) => `${c.field}:${c.page}`).join(',')}]`,
      output_summary: `${out.verdict} findings=${out.findings.length}${out.question ? ` q=${JSON.stringify(out.question)}` : ''}`,
      duration_ms: Date.now() - cmpStart,
      evidence_ids: out.findings.flatMap((f) => f.evidenceIds).slice(0, 20),
      next_state: out.verdict === 'AD_WRONG_REPAIRABLE' ? 'repair' : 'done',
      cached: false,
    });

    // --- repair (only for AD_WRONG_REPAIRABLE; refusal downgrades to UNSAFE) ---
    let finalVerdict: Verdict = out.verdict;
    let repairDir: string | null = null;
    let repairOutput: RepairPipelineOutput | null = null;
    if (out.verdict === 'AD_WRONG_REPAIRABLE') {
      repairDir = join(ctx.artifactsDir, safeKey(key), 'repair');
      const repaired = (repairOutput = await runRepairPipeline({
        client: options.client,
        extractModel: options.extractModel,
        samModel: options.samModel,
        sourceBytes: imageBytes,
        claims: ad,
        spec: ctx.spec,
        trace,
        artifactDir: repairDir,
        withBrowser: ctx.withBrowser,
      }));
      modelCalls += repaired.modelCalls;
      for (const u of repaired.usages) ctx.usages.push(u);
      if (repaired.status === 'refused') {
        finalVerdict = 'AD_WRONG_UNSAFE';
        trace.emit({
          step: 'finalize',
          tool_or_model: 'code:sweep',
          input_summary: `repair refused: ${repaired.blockers.join(',')}`,
          output_summary: 'verdict downgraded AD_WRONG_REPAIRABLE → AD_WRONG_UNSAFE',
          duration_ms: 0,
          evidence_ids: [],
          next_state: 'done',
          cached: false,
        });
      }
    }

    // --- persist ---
    let shotPaths = ctx.capturePaths.get(landingUrl);
    if (!shotPaths) {
      const capDir = join(ctx.artifactsDir, 'captures', safeKey(landingUrl.replace(/^https?:\/\//, '')));
      await mkdir(capDir, { recursive: true });
      shotPaths = [];
      for (let i = 0; i < capture.screenshots.length; i++) {
        const p = join(capDir, `cap-${i}.png`);
        await writeFile(p, capture.screenshots[i] as Buffer);
        shotPaths.push(relative(options.repoRoot, p));
      }
      ctx.capturePaths.set(landingUrl, shotPaths);
    }
    const snapshotId = store.insertSnapshot({
      run_id: ctx.runId, ad_key: key, image_sha256: sha256Hex(imageBytes), image_bytes: imageBytes.length,
      copy: entry.copy, landing_url: landingUrl, cache_key: cacheKey, capture_time: capture.captureTime,
      original_capture_time: null, verdict: finalVerdict, expected,
      pass: finalVerdict === expected ? 1 : 0, cached: 0,
      latency_ms: Date.now() - started, model_calls: modelCalls,
    });
    store.insertCapture({
      snapshotId,
      requestedUrl: capture.requestedUrl,
      finalUrl: capture.finalUrl,
      captureTime: capture.captureTime,
      screenshotPaths: shotPaths,
      chunksJson: JSON.stringify(capture.chunks),
    });
    insertClaimRows(store, snapshotId, ad, page);
    for (const f of out.findings) {
      store.insertFinding({
        snapshotId,
        kind: f.kind,
        side: f.side,
        field: f.field,
        specValue: f.specValue,
        observedValue: f.observedValue,
        evidenceIds: f.evidenceIds,
        detail: f.detail,
      });
    }
    const ro = repairOutput;
    if (ro && ro.status === 'repaired' && ro.afterBytes && ro.digest && ro.proof && ro.revalidation && repairDir) {
      store.insertRepairArtifact({
        snapshotId,
        beforeSha256: sha256Hex(imageBytes),
        afterSha256: sha256Hex(ro.afterBytes),
        digest: ro.digest.digest,
        proofJson: JSON.stringify(ro.proof),
        revalidationJson: JSON.stringify(ro.revalidation),
        artifactDir: relative(options.repoRoot, repairDir),
      });
    }
    insertTraceRows(store, snapshotId, trace);

    const row: SweepRow = {
      ad: entry.id, lang: entry.lang, expected, got: finalVerdict,
      pass: finalVerdict === expected, cached: false,
      latencyMs: Date.now() - started, modelCalls,
    };
    options.onRow?.(row);
    return row;
  } catch (err) {
    // Unexpected failure (model error, bug): record ERROR, keep sweeping.
    const detail = err instanceof Error ? err.message : String(err);
    if (err instanceof ExtractError || err instanceof PageExtractError) modelCalls += err.attempts.length;
    trace.emit({
      step: 'error',
      tool_or_model: 'code:sweep',
      input_summary: key,
      output_summary: `ERROR: ${detail.slice(0, 300)}`,
      duration_ms: Date.now() - started,
      evidence_ids: [],
      next_state: 'done',
      cached: false,
    });
    const snapshotId = store.insertSnapshot({
      run_id: ctx.runId, ad_key: key, image_sha256: sha256Hex(imageBytes), image_bytes: imageBytes.length,
      copy: entry.copy, landing_url: landingUrl, cache_key: cacheKey, capture_time: new Date().toISOString(),
      original_capture_time: null, verdict: 'ERROR', expected, pass: 0, cached: 0,
      latency_ms: Date.now() - started, model_calls: modelCalls,
    });
    insertTraceRows(store, snapshotId, trace);
    const row: SweepRow = {
      ad: entry.id, lang: entry.lang, expected, got: `ERROR: ${detail.slice(0, 120)}`,
      pass: false, cached: false, latencyMs: Date.now() - started, modelCalls,
    };
    options.onRow?.(row);
    return row;
  }
}

const SWEEP_WORKERS = 2;

/**
 * Fixed loopback port for the sweep's own pages server, so landing URLs —
 * and therefore sweep cache keys — are stable across runs. Falls forward a
 * few ports when busy (cache misses then, but the sweep still works).
 */
export const DEFAULT_PAGES_PORT = 8901;

function isAddrInUse(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EADDRINUSE';
}

async function startLocalPages(repoRoot: string): Promise<PagesServer> {
  const dir = join(repoRoot, 'fixtures', 'pages');
  for (let port = DEFAULT_PAGES_PORT; port < DEFAULT_PAGES_PORT + 10; port++) {
    try {
      return await startPagesServer(dir, '127.0.0.1', port);
    } catch (err) {
      if (!isAddrInUse(err)) throw err;
    }
  }
  return startPagesServer(dir, '127.0.0.1', 0);
}

/** Fixed state machine per ad; 2 workers for model calls, 1 shared Chromium. */
export async function runSweep(options: SweepOptions): Promise<SweepReport> {
  const manifest = await loadManifest(options.manifestPath);
  const specJson = await readFile(resolve(options.repoRoot, manifest.spec), 'utf8');
  const spec = loadOfferSpec(JSON.parse(specJson));
  const expected = await loadExpectedVerdicts(options.expectedPath);
  for (const e of manifest.entries) {
    if (!expected[adKey(e)]) throw new Error(`no expected verdict for ${adKey(e)} in ${options.expectedPath}`);
  }

  const store = Store.open(options.dbPath);
  store.upsertSpec(spec.version, specJson);

  let server: PagesServer | null = null;
  let pagesBase = options.pagesBase;
  if (!pagesBase) {
    server = await startLocalPages(options.repoRoot);
    pagesBase = server.baseUrl;
  }

  const runId = store.createRun({
    manifestPath: relative(options.repoRoot, options.manifestPath),
    fresh: options.fresh,
    pagesBase,
    specVersion: spec.version,
  });
  const artifactsDir = join(options.repoRoot, 'artifacts', 'sweep', `run-${runId}`);
  await mkdir(artifactsDir, { recursive: true });

  const captureService = new CaptureService({ allowedHosts: options.allowedHosts });
  await captureService.start();
  const ctx: CheckContext = {
    options,
    store,
    runId,
    spec,
    specJson,
    expected,
    captureService,
    withBrowser: createMutex(),
    captureCache: new Map(),
    capturePaths: new Map(),
    artifactsDir,
    modelsTag: `${options.extractModel}+${options.samModel}`,
    promptsTag: [EXTRACT_AD_PROMPT_VERSION, EXTRACT_PAGE_PROMPT_VERSION, PANEL_TEMPLATE_VERSION].join('+'),
    usages: [],
  };

  try {
    const queue = [...manifest.entries];
    const workers = Array.from({ length: SWEEP_WORKERS }, async () => {
      const rows: SweepRow[] = [];
      for (;;) {
        const entry = queue.shift();
        if (!entry) return rows;
        rows.push(await checkAd(ctx, entry, pagesBase as string));
      }
    });
    const grouped = await Promise.all(workers);
    const rows = grouped.flat();
    rows.sort((a, b) => a.ad.localeCompare(b.ad) || a.lang.localeCompare(b.lang));
    store.finishRun(runId);

    let input = 0;
    let output = 0;
    let total = 0;
    for (const u of ctx.usages) {
      if (!u) continue;
      input += u.inputTokens ?? 0;
      output += u.outputTokens ?? 0;
      total += u.totalTokens ?? 0;
    }
    return {
      runId,
      rows,
      allPass: rows.every((r) => r.pass),
      totalCalls: rows.reduce((s, r) => s + r.modelCalls, 0),
      totalLatencyMs: rows.reduce((s, r) => s + r.latencyMs, 0),
      usage: { in: input, out: output, total },
      pagesBase,
    };
  } finally {
    await captureService.stop();
    if (server) await server.close();
    store.close();
  }
}
