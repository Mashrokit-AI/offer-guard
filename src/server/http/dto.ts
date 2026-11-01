import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { adClaimsSchema, pageClaimsSchema, type AdClaims, type PageClaims } from '../../shared/schemas.js';
import {
  buildComparisons,
  decideVerdict,
  type FieldComparison,
  type VerdictField,
  type VerdictSide,
} from '../../shared/verdict.js';
import { STRINGS, type MessageKey } from '../../shared/i18n.js';
import { loadOfferSpec } from '../repair/spec.js';
import { Store, type ClaimRow, type SnapshotRow } from '../store/db.js';

/**
 * DTO builders for the read API. Reasons and explanations are served as
 * {key, vars} so the client renders them in its own language. Convention:
 * a var named `side` holds 'side_ad'|'side_page' and a var named `field`
 * holds a 'field_*' key — the client resolves those nested keys first.
 */

export interface Msg {
  key: string;
  vars: Record<string, string>;
}

export interface SpecDto {
  version: number;
  percent: number | null;
  scope: string;
  shipping: string;
  dayMonth: string | null;
  /** Full expiry "2026-11-10" when the spec file states one. */
  validFull: string | null;
}

export function specDto(specJson: string): SpecDto {
  const spec = loadOfferSpec(JSON.parse(specJson));
  let validFull: string | null = null;
  try {
    const raw = (JSON.parse(specJson) as { valid_until?: unknown }).valid_until;
    if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw)) validFull = raw.slice(0, 10);
  } catch {
    validFull = null;
  }
  return {
    version: spec.version,
    percent: spec.percent,
    scope: spec.scope,
    shipping: spec.shipping,
    dayMonth: spec.dayMonth,
    validFull,
  };
}

export function splitAdKey(adKey: string): { ad: string; lang: string } {
  const i = adKey.lastIndexOf('/');
  if (i < 0) return { ad: adKey, lang: 'en' };
  return { ad: adKey.slice(0, i), lang: adKey.slice(i + 1) };
}

const NONE_STATED = '(none stated)';

function claimsOf(rows: ClaimRow[], source: string): Map<string, ClaimRow> {
  const m = new Map<string, ClaimRow>();
  for (const r of rows) {
    if (r.source === source && !m.has(r.field)) m.set(r.field, r);
  }
  return m;
}

function parsePercent(normalized: string): number | null {
  if (normalized === NONE_STATED) return null;
  const m = normalized.match(/^(-?\d+(?:\.\d+)?)%$/);
  return m ? Number(m[1]) : null;
}

/** Rebuild AdClaims from claim rows (old runs without stored geometry). */
export function synthAd(rows: ClaimRow[], lang: string): AdClaims {
  const c = claimsOf(rows, 'ad');
  const pct = c.get('percent');
  const scope = c.get('scope');
  const ship = c.get('shipping');
  const valid = c.get('valid_until');
  return adClaimsSchema.parse({
    language: lang === 'he' ? 'he' : 'en',
    offer_texts: [],
    discount: {
      percent: pct ? parsePercent(pct.normalized) : null,
      scope: scope?.normalized ?? 'unspecified',
      verbatim: pct?.verbatim ?? '',
    },
    shipping: { terms: ship?.normalized ?? 'unspecified', verbatim: ship?.verbatim ?? '' },
    valid_until: {
      day_month: valid && valid.normalized !== NONE_STATED ? valid.normalized : null,
      verbatim: valid?.verbatim ?? '',
    },
    panel: null,
    product_bbox: null,
    logo_bbox: null,
    unreadable: [],
  });
}

/** Rebuild PageClaims from claim rows (quotes only exist in stored evidence). */
export function synthPage(rows: ClaimRow[]): PageClaims | null {
  const c = claimsOf(rows, 'page');
  if (c.size === 0) return null;
  const pct = c.get('percent');
  const scope = c.get('scope');
  const ship = c.get('shipping');
  const valid = c.get('valid_until');
  return pageClaimsSchema.parse({
    discount: {
      percent: pct ? parsePercent(pct.normalized) : null,
      scope: scope?.normalized ?? 'unspecified',
      verbatim: pct?.verbatim ?? '',
    },
    shipping: { terms: ship?.normalized ?? 'unspecified', verbatim: ship?.verbatim ?? '' },
    valid_until: {
      day_month: valid && valid.normalized !== NONE_STATED ? valid.normalized : null,
      verbatim: valid?.verbatim ?? '',
    },
    quotes: [],
  });
}

const FIELD_KEY: Record<VerdictField, MessageKey> = {
  percent: 'field_percent',
  scope: 'field_scope',
  shipping: 'field_shipping',
  valid_until: 'field_valid_until',
};

const SIDE_KEY: Record<VerdictSide, MessageKey> = {
  ad: 'side_ad',
  page: 'side_page',
};

function toKeyVars(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...vars };
  if (out.side === 'ad' || out.side === 'page') out.side = SIDE_KEY[out.side];
  const f = out.field as VerdictField;
  if (f && FIELD_KEY[f]) out.field = FIELD_KEY[f];
  return out;
}

export interface Analysis {
  ad: AdClaims | null;
  page: PageClaims | null;
  comparisons: FieldComparison[];
  findings: Array<{ kind: string; side: string | null; field: string | null; key: string; vars: Record<string, string> }>;
  question: Msg | null;
  blockers: string[];
  hasGeometry: boolean;
}

/** Recompute comparisons/findings/question from stored evidence (pure code). */
export function analyzeSnapshot(
  store: Store,
  snapshot: SnapshotRow,
  specJson: string,
): Analysis {
  const empty: Analysis = {
    ad: null, page: null, comparisons: [], findings: [], question: null, blockers: [], hasGeometry: false,
  };
  if (snapshot.verdict === 'ERROR') return empty;
  const rows = store.getClaims(snapshot.id);
  const evidence = store.getEvidence(snapshot.id);
  const { lang } = splitAdKey(snapshot.ad_key);
  let ad: AdClaims | null = null;
  let page: PageClaims | null = null;
  let hasGeometry = false;
  try {
    if (evidence?.adJson) {
      ad = adClaimsSchema.parse(JSON.parse(evidence.adJson));
      hasGeometry = true;
    } else {
      ad = synthAd(rows, lang);
    }
    if (evidence?.pageJson) {
      page = pageClaimsSchema.parse(JSON.parse(evidence.pageJson));
    } else {
      page = synthPage(rows);
    }
  } catch {
    return { ...empty, hasGeometry };
  }
  if (!ad) return { ...empty, hasGeometry };
  const findingRows = store.getFindings(snapshot.id);
  const blockers = findingRows.filter((f) => f.kind === 'repair_blocker' && f.observed_value).map((f) => f.observed_value as string);
  const captureFailed = snapshot.verdict === 'CAPTURE_FAILED' || page === null;
  const spec = loadOfferSpec(JSON.parse(specJson));
  const out = decideVerdict({ spec, ad, page, captureFailed, repairBlockers: blockers, lang: 'en' });
  const findings = out.findings.map((f) => ({
    kind: f.kind,
    side: f.side,
    field: f.field,
    key: (f.messageKey ?? 'finding_contradiction') as string,
    vars: toKeyVars(f.vars),
  }));
  let question: Msg | null = null;
  if (out.question) {
    const unk = out.comparisons.find((c) => c.ad === 'unknown' || c.page === 'unknown');
    if (unk) {
      const side: VerdictSide = unk.ad === 'unknown' ? 'ad' : 'page';
      question = { key: 'ambiguous_question', vars: { side: SIDE_KEY[side], field: FIELD_KEY[unk.field] } };
    }
  }
  return { ad, page, comparisons: out.comparisons, findings, question, blockers, hasGeometry };
}

const EXPLAIN_KEY: Record<string, MessageKey> = {
  CLEAN: 'explain_clean',
  AD_WRONG_REPAIRABLE: 'explain_repaired',
  AD_WRONG_UNSAFE: 'explain_unsafe',
  PAGE_WRONG: 'explain_page_wrong',
  AMBIGUOUS: 'explain_ambiguous',
  CAPTURE_FAILED: 'explain_capture_failed',
  ERROR: 'explain_error',
};

/** Map a stored repair-blocker id to a message key (fallback: generic line). */
export function blockerMsg(blocker: string): Msg {
  const candidate = `blocker_${blocker}`;
  if (candidate in STRINGS.en) return { key: candidate, vars: {} };
  return { key: 'finding_repair_blocker', vars: { blocker } };
}

/** One-line card reason for a snapshot. */
export function reasonFor(verdict: string, analysis: Analysis): Msg {
  const contra = (side: VerdictSide) => analysis.findings.find((f) => f.kind === 'contradiction' && f.side === side);
  switch (verdict) {
    case 'CLEAN':
      return { key: 'explain_clean', vars: {} };
    case 'AD_WRONG_REPAIRABLE': {
      const f = contra('ad') ?? analysis.findings.find((f) => f.kind === 'contradiction');
      return f ? { key: f.key, vars: f.vars } : { key: 'explain_repaired', vars: {} };
    }
    case 'AD_WRONG_UNSAFE':
      return analysis.blockers.length > 0 ? blockerMsg(analysis.blockers[0] as string) : { key: 'explain_unsafe', vars: {} };
    case 'PAGE_WRONG': {
      const f = contra('page') ?? analysis.findings.find((f) => f.kind === 'contradiction');
      return f ? { key: f.key, vars: f.vars } : { key: 'explain_page_wrong', vars: {} };
    }
    case 'AMBIGUOUS':
      return analysis.question ?? { key: 'explain_ambiguous', vars: {} };
    case 'CAPTURE_FAILED':
      return { key: 'explain_capture_failed', vars: {} };
    default:
      return { key: 'explain_error', vars: {} };
  }
}

// --- campaign DTO ---

export interface CampaignAdDto {
  id: number;
  adKey: string;
  ad: string;
  lang: string;
  /** Relative thumbnail URL (the frontend uses relative URLs only). */
  thumb: string;
  verdict: string;
  reason: Msg;
  cached: boolean;
  captureTime: string;
}

export interface CampaignDto {
  spec: SpecDto;
  run: {
    id: number;
    mode: 'fresh' | 'cached';
    startedAt: string;
    finishedAt: string | null;
    countsByVerdict: Record<string, number>;
    countsByLang: Record<string, number>;
  };
  ads: CampaignAdDto[];
}

export function buildCampaign(store: Store, manifestRel: string): CampaignDto | null {
  const run = store.latestRunForManifest(manifestRel);
  if (!run) return null;
  const specRow = store.getSpec(run.spec_version) ?? store.latestSpec();
  if (!specRow) return null;
  const snapshots = store.getSnapshots(run.id);
  const countsByVerdict: Record<string, number> = {};
  const countsByLang: Record<string, number> = {};
  const ads: CampaignAdDto[] = snapshots.map((s) => {
    countsByVerdict[s.verdict] = (countsByVerdict[s.verdict] ?? 0) + 1;
    const { ad, lang } = splitAdKey(s.ad_key);
    countsByLang[lang] = (countsByLang[lang] ?? 0) + 1;
    const analysis = analyzeSnapshot(store, s, specRow.spec_json);
    return {
      id: s.id,
      adKey: s.ad_key,
      ad,
      lang,
      thumb: `media/thumb/${s.id}`,
      verdict: s.verdict,
      reason: reasonFor(s.verdict, analysis),
      cached: s.cached === 1,
      captureTime: s.original_capture_time ?? s.capture_time,
    };
  });
  return {
    spec: specDto(specRow.spec_json),
    run: {
      id: run.id,
      mode: run.fresh === 1 ? 'fresh' : 'cached',
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      countsByVerdict,
      countsByLang,
    },
    ads,
  };
}

// --- detail DTO ---

export interface BboxDto {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChunkDto {
  id: string;
  text: string;
  bounds: BboxDto;
}

export interface TraceDto {
  seq: number;
  step: string;
  tool: string;
  input: string;
  output: string;
  durationMs: number;
  evidence: string[];
  next: string;
  cached: boolean;
}

export interface AdDetailDto {
  snapshot: {
    id: number;
    adKey: string;
    ad: string;
    lang: string;
    verdict: string;
    cached: boolean;
    captureTime: string;
    copy: string;
    landingUrl: string;
  };
  spec: SpecDto;
  adClaims: {
    hasGeometry: boolean;
    language: string;
    discount: { percent: number | null; scope: string; verbatim: string };
    shipping: { terms: string; verbatim: string };
    validUntil: { dayMonth: string | null; verbatim: string };
    offerTexts: Array<{ text: string; bbox: BboxDto; inPanel: boolean }>;
    panel: { bbox: BboxDto; opaque: boolean } | null;
    productBbox: BboxDto | null;
    logoBbox: BboxDto | null;
  } | null;
  pageClaims: {
    discount: { percent: number | null; scope: string; verbatim: string };
    shipping: { terms: string; verbatim: string };
    validUntil: { dayMonth: string | null; verbatim: string };
    quotes: Array<{ text: string; chunkIds: string[] }>;
    chunks: ChunkDto[];
    shots: number;
    pageFile: string | null;
  } | null;
  comparisons: FieldComparison[];
  findings: Analysis['findings'];
  explain: Msg;
  question: Msg | null;
  repair: {
    digest: string;
    specVersion: number;
    proof: { changed_outside_rect: number; changed_inside_protected: number; max_channel_diff_outside: number; pass: boolean };
    revalidation: {
      pass: boolean;
      checks: Array<{ check: string; pass: boolean; detail: string }>;
      claims?: { percent: number | null; scope: string; shipping: string; valid: string | null };
    };
    rect: BboxDto | null;
    hasMasks: boolean;
    hasDiff: boolean;
  } | null;
  refusal: { blockers: Msg[]; hasMasks: boolean } | null;
  trace: TraceDto[];
}

function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function safeKey(adKey: string): string {
  return adKey.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

/** Repair/mask files live under artifacts/sweep/run-<id>/<safeKey>/repair/. */
function repairDirFor(repoRoot: string, runId: number, adKey: string, artifactDir: string | null): string | null {
  if (artifactDir) {
    const d = join(repoRoot, artifactDir);
    if (existsSync(d)) return d;
  }
  const d = join(repoRoot, 'artifacts', 'sweep', `run-${runId}`, safeKey(adKey), 'repair');
  return existsSync(d) ? d : null;
}

/** Map a recorded landing URL back to a fixtures/pages file we serve (else null). */
export function pageFileForUrl(repoRoot: string, landingUrl: string): string | null {
  let base: string;
  try {
    base = basename(new URL(landingUrl).pathname);
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9_-]+\.html$/.test(base)) return null;
  return existsSync(join(repoRoot, 'fixtures', 'pages', base)) ? base : null;
}

export function buildDetail(repoRoot: string, store: Store, snapshotId: number): AdDetailDto | null {
  const snapshot = store.getSnapshot(snapshotId);
  if (!snapshot) return null;
  const run = store.getRun(snapshot.run_id);
  const specRow = (run && store.getSpec(run.spec_version)) ?? store.latestSpec();
  if (!specRow) return null;
  const { ad, lang } = splitAdKey(snapshot.ad_key);
  const analysis = analyzeSnapshot(store, snapshot, specRow.spec_json);
  const capture = store.getCapture(snapshot.id);
  const chunks: ChunkDto[] = [];
  if (capture) {
    const parsed = safeJson<Array<{ id: string; text: string; bounds: BboxDto }>>(capture.chunks_json);
    if (Array.isArray(parsed)) {
      for (const c of parsed) {
        if (c && typeof c.id === 'string' && c.bounds) chunks.push({ id: c.id, text: String(c.text ?? ''), bounds: c.bounds });
      }
    }
  }
  const shotCount = capture ? (safeJson<string[]>(capture.screenshot_paths)?.length ?? 0) : 0;
  const a = analysis.ad;
  const p = analysis.page;
  const repairRow = store.getRepair(snapshot.id);
  let repair: AdDetailDto['repair'] = null;
  if (repairRow) {
    const proof = safeJson<AdDetailDto['repair'] & object>(repairRow.proof_json) as unknown as {
      changed_outside_rect: number; changed_inside_protected: number; max_channel_diff_outside: number; pass: boolean;
    } | null;
    const revalidation = safeJson<{
      pass: boolean;
      checks: Array<{ check: string; pass: boolean; detail: string }>;
      claims?: { percent: number | null; scope: string; shipping: string; valid: string | null };
    }>(repairRow.revalidation_json);
    const dir = repairDirFor(repoRoot, snapshot.run_id, snapshot.ad_key, repairRow.artifact_dir);
    let rect: BboxDto | null = null;
    let hasMasks = false;
    let hasDiff = false;
    if (dir) {
      let proofFile = 'null';
      try {
        proofFile = readFileSync(join(dir, 'proof.json'), 'utf8');
      } catch {
        proofFile = 'null';
      }
      const pj = safeJson<{ rect?: BboxDto }>(proofFile);
      if (pj?.rect) rect = pj.rect;
      hasMasks = existsSync(join(dir, 'mask-product.png')) && existsSync(join(dir, 'mask-logo.png'));
      hasDiff =
        existsSync(join(dir, 'before.png')) &&
        existsSync(join(dir, 'after.png')) &&
        existsSync(join(dir, 'mask-protected.png')) &&
        rect !== null;
    }
    if (proof && revalidation) {
      repair = {
        digest: repairRow.digest,
        specVersion: run?.spec_version ?? specRow.version,
        proof: {
          changed_outside_rect: proof.changed_outside_rect,
          changed_inside_protected: proof.changed_inside_protected,
          max_channel_diff_outside: proof.max_channel_diff_outside,
          pass: proof.pass,
        },
        revalidation,
        rect,
        hasMasks,
        hasDiff,
      };
    }
  }
  let refusal: AdDetailDto['refusal'] = null;
  if (snapshot.verdict === 'AD_WRONG_UNSAFE') {
    const dir = repairDirFor(repoRoot, snapshot.run_id, snapshot.ad_key, repairRow?.artifact_dir ?? null);
    refusal = {
      blockers: analysis.blockers.map(blockerMsg),
      hasMasks: !!dir && existsSync(join(dir, 'mask-protected.png')),
    };
  }
  const trace: TraceDto[] = store.getTrace(snapshot.id).map((t) => ({
    seq: t.seq,
    step: t.step,
    tool: t.tool_or_model,
    input: t.input_summary,
    output: t.output_summary,
    durationMs: t.duration_ms,
    evidence: safeJson<string[]>(t.evidence_ids_json) ?? [],
    next: t.next_state,
    cached: t.cached === 1,
  }));
  return {
    snapshot: {
      id: snapshot.id,
      adKey: snapshot.ad_key,
      ad,
      lang,
      verdict: snapshot.verdict,
      cached: snapshot.cached === 1,
      captureTime: snapshot.original_capture_time ?? snapshot.capture_time,
      copy: snapshot.copy,
      landingUrl: snapshot.landing_url,
    },
    spec: specDto(specRow.spec_json),
    adClaims: a
      ? {
          hasGeometry: analysis.hasGeometry,
          language: a.language,
          discount: { percent: a.discount.percent, scope: a.discount.scope, verbatim: a.discount.verbatim },
          shipping: { terms: a.shipping.terms, verbatim: a.shipping.verbatim },
          validUntil: { dayMonth: a.valid_until.day_month, verbatim: a.valid_until.verbatim },
          offerTexts: a.offer_texts.map((o) => ({ text: o.text, bbox: o.bbox, inPanel: o.in_panel })),
          panel: a.panel,
          productBbox: a.product_bbox,
          logoBbox: a.logo_bbox,
        }
      : null,
    pageClaims: p
      ? {
          discount: { percent: p.discount.percent, scope: p.discount.scope, verbatim: p.discount.verbatim },
          shipping: { terms: p.shipping.terms, verbatim: p.shipping.verbatim },
          validUntil: { dayMonth: p.valid_until.day_month, verbatim: p.valid_until.verbatim },
          quotes: p.quotes.map((q) => ({ text: q.text, chunkIds: q.chunk_ids })),
          chunks,
          shots: shotCount,
          pageFile: pageFileForUrl(repoRoot, snapshot.landing_url),
        }
      : null,
    comparisons: analysis.comparisons,
    findings: analysis.findings,
    explain: { key: EXPLAIN_KEY[snapshot.verdict] ?? 'explain_error', vars: {} },
    question: analysis.question,
    repair,
    refusal,
    trace,
  };
}

export interface RunTraceDto {
  runId: number;
  snapshots: Array<{ snapshotId: number; adKey: string; events: TraceDto[] }>;
}

export function buildRunTrace(store: Store, runId: number): RunTraceDto | null {
  const run = store.getRun(runId);
  if (!run) return null;
  return {
    runId,
    snapshots: store.getSnapshots(runId).map((s) => ({
      snapshotId: s.id,
      adKey: s.ad_key,
      events: store.getTrace(s.id).map((t) => ({
        seq: t.seq,
        step: t.step,
        tool: t.tool_or_model,
        input: t.input_summary,
        output: t.output_summary,
        durationMs: t.duration_ms,
        evidence: safeJson<string[]>(t.evidence_ids_json) ?? [],
        next: t.next_state,
        cached: t.cached === 1,
      })),
    })),
  };
}
