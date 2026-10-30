import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS offer_spec (
  version INTEGER PRIMARY KEY,
  spec_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaign_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  manifest_path TEXT NOT NULL,
  fresh INTEGER NOT NULL,
  pages_base TEXT NOT NULL,
  spec_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS source_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES campaign_run(id),
  ad_key TEXT NOT NULL,
  image_sha256 TEXT NOT NULL,
  image_bytes INTEGER NOT NULL,
  copy TEXT NOT NULL,
  landing_url TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  capture_time TEXT NOT NULL,
  original_capture_time TEXT,
  verdict TEXT NOT NULL,
  expected TEXT NOT NULL,
  pass INTEGER NOT NULL,
  cached INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  model_calls INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshot_cache ON source_snapshot(cache_key);
CREATE TABLE IF NOT EXISTS page_capture (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES source_snapshot(id),
  requested_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  capture_time TEXT NOT NULL,
  screenshot_paths TEXT NOT NULL,
  chunks_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS claim (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES source_snapshot(id),
  source TEXT NOT NULL,
  field TEXT NOT NULL,
  normalized TEXT NOT NULL,
  verbatim TEXT NOT NULL,
  evidence_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES source_snapshot(id),
  kind TEXT NOT NULL,
  side TEXT,
  field TEXT,
  spec_value TEXT,
  observed_value TEXT,
  evidence_ids_json TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS repair_artifact (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES source_snapshot(id),
  before_sha256 TEXT NOT NULL,
  after_sha256 TEXT NOT NULL,
  digest TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  revalidation_json TEXT NOT NULL,
  artifact_dir TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trace_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES source_snapshot(id),
  seq INTEGER NOT NULL,
  step TEXT NOT NULL,
  tool_or_model TEXT NOT NULL,
  input_summary TEXT NOT NULL,
  output_summary TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  next_state TEXT NOT NULL,
  cached INTEGER NOT NULL
);
`;

export interface SnapshotRow {
  id: number;
  run_id: number;
  ad_key: string;
  image_sha256: string;
  image_bytes: number;
  copy: string;
  landing_url: string;
  cache_key: string;
  capture_time: string;
  original_capture_time: string | null;
  verdict: string;
  expected: string;
  pass: number;
  cached: number;
  latency_ms: number;
  model_calls: number;
}

export interface CachedCheck {
  snapshot: SnapshotRow;
  capture: { requested_url: string; final_url: string; capture_time: string; screenshot_paths: string; chunks_json: string } | null;
  claims: Array<{ source: string; field: string; normalized: string; verbatim: string; evidence_id: string }>;
  findings: Array<{ kind: string; side: string | null; field: string | null; spec_value: string | null; observed_value: string | null; evidence_ids_json: string; detail: string }>;
}

export class Store {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static open(dbPath: string): Store {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(SCHEMA);
    return new Store(db);
  }

  close(): void {
    this.db.close();
  }

  upsertSpec(version: number, specJson: string): void {
    this.db
      .prepare('INSERT INTO offer_spec (version, spec_json, created_at) VALUES (?, ?, ?) ON CONFLICT(version) DO UPDATE SET spec_json=excluded.spec_json')
      .run(version, specJson, new Date().toISOString());
  }

  createRun(input: { manifestPath: string; fresh: boolean; pagesBase: string; specVersion: number }): number {
    const r = this.db
      .prepare('INSERT INTO campaign_run (started_at, manifest_path, fresh, pages_base, spec_version) VALUES (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), input.manifestPath, input.fresh ? 1 : 0, input.pagesBase, input.specVersion);
    return Number(r.lastInsertRowid);
  }

  finishRun(runId: number): void {
    this.db.prepare('UPDATE campaign_run SET finished_at=? WHERE id=?').run(new Date().toISOString(), runId);
  }

  insertSnapshot(s: Omit<SnapshotRow, 'id'>): number {
    const r = this.db
      .prepare(
        `INSERT INTO source_snapshot
         (run_id, ad_key, image_sha256, image_bytes, copy, landing_url, cache_key, capture_time,
          original_capture_time, verdict, expected, pass, cached, latency_ms, model_calls)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.run_id, s.ad_key, s.image_sha256, s.image_bytes, s.copy, s.landing_url, s.cache_key,
        s.capture_time, s.original_capture_time, s.verdict, s.expected, s.pass ? 1 : 0,
        s.cached ? 1 : 0, s.latency_ms, s.model_calls,
      );
    return Number(r.lastInsertRowid);
  }

  findByCacheKey(cacheKey: string): CachedCheck | null {
    const snapshot = this.db.prepare('SELECT * FROM source_snapshot WHERE cache_key=? ORDER BY id DESC LIMIT 1').get(cacheKey) as SnapshotRow | undefined;
    if (!snapshot) return null;
    const capture = this.db.prepare('SELECT requested_url, final_url, capture_time, screenshot_paths, chunks_json FROM page_capture WHERE snapshot_id=?').get(snapshot.id) as CachedCheck['capture'];
    const claims = this.db.prepare('SELECT source, field, normalized, verbatim, evidence_id FROM claim WHERE snapshot_id=? ORDER BY id').all(snapshot.id) as CachedCheck['claims'];
    const findings = this.db.prepare('SELECT kind, side, field, spec_value, observed_value, evidence_ids_json, detail FROM finding WHERE snapshot_id=? ORDER BY id').all(snapshot.id) as CachedCheck['findings'];
    return { snapshot, capture: capture ?? null, claims, findings };
  }

  insertCapture(c: { snapshotId: number; requestedUrl: string; finalUrl: string; captureTime: string; screenshotPaths: string[]; chunksJson: string }): void {
    this.db
      .prepare('INSERT INTO page_capture (snapshot_id, requested_url, final_url, capture_time, screenshot_paths, chunks_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(c.snapshotId, c.requestedUrl, c.finalUrl, c.captureTime, JSON.stringify(c.screenshotPaths), c.chunksJson);
  }

  insertClaim(c: { snapshotId: number; source: string; field: string; normalized: string; verbatim: string; evidenceId: string }): void {
    this.db
      .prepare('INSERT INTO claim (snapshot_id, source, field, normalized, verbatim, evidence_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(c.snapshotId, c.source, c.field, c.normalized, c.verbatim, c.evidenceId);
  }

  insertFinding(f: { snapshotId: number; kind: string; side: string | null; field: string | null; specValue: string | null; observedValue: string | null; evidenceIds: string[]; detail: string }): void {
    this.db
      .prepare('INSERT INTO finding (snapshot_id, kind, side, field, spec_value, observed_value, evidence_ids_json, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.snapshotId, f.kind, f.side, f.field, f.specValue, f.observedValue, JSON.stringify(f.evidenceIds), f.detail);
  }

  insertRepairArtifact(a: { snapshotId: number; beforeSha256: string; afterSha256: string; digest: string; proofJson: string; revalidationJson: string; artifactDir: string }): void {
    this.db
      .prepare('INSERT INTO repair_artifact (snapshot_id, before_sha256, after_sha256, digest, proof_json, revalidation_json, artifact_dir, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.snapshotId, a.beforeSha256, a.afterSha256, a.digest, a.proofJson, a.revalidationJson, a.artifactDir, new Date().toISOString());
  }

  insertTrace(t: { snapshotId: number; seq: number; step: string; toolOrModel: string; inputSummary: string; outputSummary: string; durationMs: number; evidenceIds: string[]; nextState: string; cached: boolean }): void {
    this.db
      .prepare('INSERT INTO trace_event (snapshot_id, seq, step, tool_or_model, input_summary, output_summary, duration_ms, evidence_ids_json, next_state, cached) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t.snapshotId, t.seq, t.step, t.toolOrModel, t.inputSummary, t.outputSummary, t.durationMs, JSON.stringify(t.evidenceIds), t.nextState, t.cached ? 1 : 0);
  }
}
