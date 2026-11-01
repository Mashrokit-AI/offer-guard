import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS brand (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  colors_json TEXT NOT NULL,
  fonts_json TEXT NOT NULL,
  logo_path TEXT,
  is_demo INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE TABLE IF NOT EXISTS template (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brand(id),
  preset TEXT,
  image_path TEXT NOT NULL,
  spec_json TEXT,
  status TEXT NOT NULL,
  error TEXT,
  frame_path TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_template_brand ON template(brand_id);
CREATE TABLE IF NOT EXISTS source (
  id TEXT PRIMARY KEY,
  image_path TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  analysis_json TEXT,
  masks_json TEXT,
  brand_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE TABLE IF NOT EXISTS job (
  id TEXT PRIMARY KEY,
  brand_id TEXT,
  mode TEXT NOT NULL,
  sizes_json TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  model_calls INTEGER NOT NULL,
  image_calls INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS output (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES job(id),
  source_id TEXT NOT NULL,
  preset TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  image_path TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  proof_json TEXT,
  qa_json TEXT,
  retries INTEGER NOT NULL,
  model_calls INTEGER NOT NULL,
  image_calls INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  trace_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  checks_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_output_job ON output(job_id);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  model TEXT NOT NULL,
  model_id TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  images INTEGER
);
CREATE INDEX IF NOT EXISTS idx_spend_created ON spend(created_at);
`;

export interface BrandRow {
  id: string;
  name: string;
  colors_json: string;
  fonts_json: string;
  logo_path: string | null;
  is_demo: number;
  created_at: string;
  expires_at: string | null;
}

export interface TemplateRow {
  id: string;
  brand_id: string;
  preset: string | null;
  image_path: string;
  spec_json: string | null;
  status: string;
  error: string | null;
  frame_path: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface SourceRow {
  id: string;
  image_path: string;
  width: number;
  height: number;
  analysis_json: string | null;
  masks_json: string | null;
  brand_id: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface JobRow {
  id: string;
  brand_id: string | null;
  mode: string;
  sizes_json: string;
  sources_json: string;
  status: string;
  error: string | null;
  model_calls: number;
  image_calls: number;
  created_at: string;
  finished_at: string | null;
}

export interface OutputRow {
  id: number;
  job_id: string;
  source_id: string;
  preset: string;
  mode: string;
  status: string;
  image_path: string;
  plan_json: string;
  proof_json: string | null;
  qa_json: string | null;
  retries: number;
  model_calls: number;
  image_calls: number;
  latency_ms: number;
  trace_json: string;
  error: string | null;
  created_at: string;
  checks_json: string | null;
}

const now = (): string => new Date().toISOString();

export class Store {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static open(dbPath: string): Store {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(SCHEMA);
    // Light migration for pre-existing databases (CREATE TABLE IF NOT EXISTS
    // never adds columns to an old table).
    try {
      db.exec('ALTER TABLE output ADD COLUMN checks_json TEXT');
    } catch {
      // Column already exists.
    }
    return new Store(db);
  }

  close(): void {
    this.db.close();
  }

  // --- brands ---

  insertBrand(b: { id: string; name: string; colors: string[]; fonts: string[]; logoPath: string | null; isDemo: boolean; expiresAt: string | null }): void {
    this.db
      .prepare('INSERT INTO brand (id, name, colors_json, fonts_json, logo_path, is_demo, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(b.id, b.name, JSON.stringify(b.colors), JSON.stringify(b.fonts), b.logoPath, b.isDemo ? 1 : 0, now(), b.expiresAt);
  }

  getBrand(id: string): BrandRow | null {
    return (this.db.prepare('SELECT * FROM brand WHERE id=?').get(id) as BrandRow | undefined) ?? null;
  }

  allBrands(): BrandRow[] {
    return this.db.prepare('SELECT * FROM brand ORDER BY is_demo DESC, name').all() as BrandRow[];
  }

  deleteBrand(id: string): void {
    this.db.prepare('DELETE FROM template WHERE brand_id=?').run(id);
    this.db.prepare('DELETE FROM brand WHERE id=?').run(id);
  }

  setBrandLogo(id: string, logoPath: string): void {
    this.db.prepare('UPDATE brand SET logo_path=? WHERE id=?').run(logoPath, id);
  }

  // --- templates ---

  insertTemplate(t: { id: string; brandId: string; preset: string | null; imagePath: string; framePath: string | null; expiresAt: string | null }): void {
    this.db
      .prepare('INSERT INTO template (id, brand_id, preset, image_path, spec_json, status, error, frame_path, created_at, expires_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)')
      .run(t.id, t.brandId, t.preset, t.imagePath, 'pending', t.framePath, now(), t.expiresAt);
  }

  getTemplate(id: string): TemplateRow | null {
    return (this.db.prepare('SELECT * FROM template WHERE id=?').get(id) as TemplateRow | undefined) ?? null;
  }

  templatesForBrand(brandId: string): TemplateRow[] {
    return this.db.prepare('SELECT * FROM template WHERE brand_id=? ORDER BY created_at').all(brandId) as TemplateRow[];
  }

  setTemplateReady(id: string, specJson: string): void {
    this.db.prepare('UPDATE template SET spec_json=?, status=?, error=NULL WHERE id=?').run(specJson, 'ready', id);
  }

  setTemplateFailed(id: string, error: string): void {
    this.db.prepare('UPDATE template SET status=?, error=? WHERE id=?').run('failed', error, id);
  }

  updateTemplateSpec(id: string, specJson: string): void {
    this.db.prepare('UPDATE template SET spec_json=? WHERE id=?').run(specJson, id);
  }

  setTemplatePreset(id: string, preset: string | null): void {
    this.db.prepare('UPDATE template SET preset=? WHERE id=?').run(preset, id);
  }

  setTemplateFrame(id: string, framePath: string): void {
    this.db.prepare('UPDATE template SET frame_path=? WHERE id=?').run(framePath, id);
  }

  deleteTemplate(id: string): void {
    this.db.prepare('DELETE FROM template WHERE id=?').run(id);
  }

  /** Template for an exact size, else the brand default (preset NULL). */
  templateForSize(brandId: string, preset: string): TemplateRow | null {
    const exact = this.db
      .prepare("SELECT * FROM template WHERE brand_id=? AND preset=? AND status='ready' AND spec_json IS NOT NULL ORDER BY created_at DESC LIMIT 1")
      .get(brandId, preset) as TemplateRow | undefined;
    if (exact) return exact;
    return (
      (this.db
        .prepare("SELECT * FROM template WHERE brand_id=? AND preset IS NULL AND status='ready' AND spec_json IS NOT NULL ORDER BY created_at DESC LIMIT 1")
        .get(brandId) as TemplateRow | undefined) ?? null
    );
  }

  // --- sources ---

  insertSource(s: { id: string; imagePath: string; width: number; height: number; expiresAt: string | null }): void {
    this.db
      .prepare('INSERT INTO source (id, image_path, width, height, analysis_json, masks_json, brand_id, created_at, expires_at) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)')
      .run(s.id, s.imagePath, s.width, s.height, now(), s.expiresAt);
  }

  getSource(id: string): SourceRow | null {
    return (this.db.prepare('SELECT * FROM source WHERE id=?').get(id) as SourceRow | undefined) ?? null;
  }

  setSourceAnalysis(id: string, analysisJson: string, masksJson: string, brandId: string | null): void {
    this.db.prepare('UPDATE source SET analysis_json=?, masks_json=?, brand_id=? WHERE id=?').run(analysisJson, masksJson, brandId, id);
  }

  // --- jobs ---

  insertJob(j: { id: string; brandId: string | null; mode: string; sizes: string[]; sources: string[] }): void {
    this.db
      .prepare('INSERT INTO job (id, brand_id, mode, sizes_json, sources_json, status, error, model_calls, image_calls, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 0, ?, NULL)')
      .run(j.id, j.brandId, j.mode, JSON.stringify(j.sizes), JSON.stringify(j.sources), 'running', now());
  }

  getJob(id: string): JobRow | null {
    return (this.db.prepare('SELECT * FROM job WHERE id=?').get(id) as JobRow | undefined) ?? null;
  }

  finishJob(id: string, status: string, error: string | null, modelCalls: number, imageCalls: number): void {
    this.db.prepare('UPDATE job SET status=?, error=?, model_calls=?, image_calls=?, finished_at=? WHERE id=?').run(status, error, modelCalls, imageCalls, now(), id);
  }

  latestFinishedJob(limit = 5): JobRow[] {
    return this.db.prepare("SELECT * FROM job WHERE status IN ('done','failed') ORDER BY created_at DESC LIMIT ?").all(limit) as JobRow[];
  }

  // --- outputs ---

  insertOutput(o: {
    jobId: string; sourceId: string; preset: string; mode: string; status: string; imagePath: string;
    planJson: string; proofJson: string | null; qaJson: string | null; retries: number;
    modelCalls: number; imageCalls: number; latencyMs: number; traceJson: string; error: string | null;
    checksJson?: string | null;
  }): number {
    const r = this.db
      .prepare('INSERT INTO output (job_id, source_id, preset, mode, status, image_path, plan_json, proof_json, qa_json, retries, model_calls, image_calls, latency_ms, trace_json, error, created_at, checks_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(o.jobId, o.sourceId, o.preset, o.mode, o.status, o.imagePath, o.planJson, o.proofJson, o.qaJson, o.retries, o.modelCalls, o.imageCalls, o.latencyMs, o.traceJson, o.error, now(), o.checksJson ?? null);
    return Number(r.lastInsertRowid);
  }

  /** Update one output after the repair pass / batch review lands. */
  updateOutput(id: number, o: {
    status?: string; imagePath?: string; planJson?: string; proofJson?: string | null;
    qaJson?: string | null; retries?: number; modelCalls?: number; imageCalls?: number;
    latencyMs?: number; traceJson?: string; error?: string | null; checksJson?: string | null;
  }): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const cols: Record<string, string> = {
      status: 'status', imagePath: 'image_path', planJson: 'plan_json', proofJson: 'proof_json',
      qaJson: 'qa_json', retries: 'retries', modelCalls: 'model_calls', imageCalls: 'image_calls',
      latencyMs: 'latency_ms', traceJson: 'trace_json', error: 'error', checksJson: 'checks_json',
    };
    for (const [key, col] of Object.entries(cols)) {
      const v = (o as Record<string, unknown>)[key];
      if (v !== undefined) {
        sets.push(`${col}=?`);
        vals.push(v);
      }
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE output SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
  }

  getOutput(id: number): OutputRow | null {
    return (this.db.prepare('SELECT * FROM output WHERE id=?').get(id) as OutputRow | undefined) ?? null;
  }

  outputsForJob(jobId: string): OutputRow[] {
    return this.db.prepare('SELECT * FROM output WHERE job_id=? ORDER BY id').all(jobId) as OutputRow[];
  }

  // --- usage / daily caps ---

  recordUsage(kind: 'model' | 'image', count: number): void {
    if (count <= 0) return;
    this.db.prepare('INSERT INTO usage (created_at, kind, count) VALUES (?, ?, ?)').run(now(), kind, count);
  }

  countUsageSince(sinceIso: string, kind: 'model' | 'image'): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(count), 0) AS total FROM usage WHERE created_at >= ? AND kind=?').get(sinceIso, kind) as { total: number };
    return row.total;
  }

  // --- spend ledger (USD, from real API usage) ---

  recordSpend(s: {
    model: string; modelId: string; costUsd: number;
    inputTokens?: number | null; outputTokens?: number | null; images?: number | null;
  }): void {
    this.db.prepare(
      'INSERT INTO spend (created_at, model, model_id, cost_usd, input_tokens, output_tokens, images) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(now(), s.model, s.modelId, s.costUsd, s.inputTokens ?? null, s.outputTokens ?? null, s.images ?? null);
  }

  spendSince(sinceIso: string): { totalUsd: number; wonderUsd: number } {
    const rows = this.db.prepare(
      'SELECT model, COALESCE(SUM(cost_usd), 0) AS total FROM spend WHERE created_at >= ? GROUP BY model',
    ).all(sinceIso) as Array<{ model: string; total: number }>;
    let totalUsd = 0;
    let wonderUsd = 0;
    for (const r of rows) {
      totalUsd += r.total;
      if (r.model === 'wonder') wonderUsd += r.total;
    }
    return { totalUsd, wonderUsd };
  }

  // --- expiry (visitor data; demo brands/sources are permanent) ---

  /** Delete expired visitor brands/templates/sources; returns repo-rel paths to unlink. */
  deleteExpired(beforeIso: string): string[] {
    const paths: string[] = [];
    for (const t of this.db.prepare('SELECT image_path, frame_path FROM template WHERE expires_at IS NOT NULL AND expires_at < ?').all(beforeIso) as Array<{ image_path: string; frame_path: string | null }>) {
      paths.push(t.image_path);
      if (t.frame_path) paths.push(t.frame_path);
    }
    this.db.prepare('DELETE FROM template WHERE expires_at IS NOT NULL AND expires_at < ?').run(beforeIso);
    for (const b of this.db.prepare('SELECT logo_path FROM brand WHERE expires_at IS NOT NULL AND expires_at < ? AND is_demo=0').all(beforeIso) as Array<{ logo_path: string | null }>) {
      if (b.logo_path) paths.push(b.logo_path);
    }
    this.db.prepare('DELETE FROM brand WHERE expires_at IS NOT NULL AND expires_at < ? AND is_demo=0').run(beforeIso);
    for (const s of this.db.prepare('SELECT image_path FROM source WHERE expires_at IS NOT NULL AND expires_at < ?').all(beforeIso) as Array<{ image_path: string }>) {
      paths.push(s.image_path);
    }
    this.db.prepare('DELETE FROM source WHERE expires_at IS NOT NULL AND expires_at < ?').run(beforeIso);
    return paths;
  }
}
