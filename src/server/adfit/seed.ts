import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../store/db.js';

interface FixtureTemplate {
  id: string;
  preset: string | null;
  image: string;
  spec: string | null;
  frame?: string;
}

interface FixtureBrand {
  id: string;
  name: string;
  colors: string[];
  fonts: string[];
  logo: string | null;
  templates: FixtureTemplate[];
}

interface DemoOutput {
  source: string;
  sourceLabel: string;
  preset: string;
  mode: string;
  status: string;
  image: string;
  plan: unknown;
  proof: unknown;
  qa: unknown;
  retries: number;
  modelCalls: number;
  imageCalls: number;
  latencyMs: number;
  trace: unknown[];
  error: string | null;
}

interface DemoJob {
  brand: string;
  mode: string;
  finishedAt: string;
  modelCalls: number;
  imageCalls: number;
  outputs: DemoOutput[];
}

/** Store id of the saved GALI demo job served at GET /api/demo. */
export const DEMO_JOB_ID = 'demo-gali-he';

/**
 * Seed fixture (demo) brands and the saved demo job into the store.
 * Idempotent: existing rows are left untouched. Demo rows never expire.
 */
export function ensureSeeded(repoRoot: string, dbPath: string): void {
  const store = Store.open(dbPath);
  try {
    const brandsDir = join(repoRoot, 'fixtures', 'brands');
    if (!existsSync(brandsDir)) return;
    for (const dir of ['gali', 'noa']) {
      const manifestPath = join(brandsDir, dir, 'brand.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as FixtureBrand;
      if (!store.getBrand(manifest.id)) {
        store.insertBrand({
          id: manifest.id,
          name: manifest.name,
          colors: manifest.colors,
          fonts: manifest.fonts ?? [],
          logoPath: manifest.logo ? `fixtures/brands/${dir}/${manifest.logo}` : null,
          isDemo: true,
          expiresAt: null,
        });
      }
      for (const t of manifest.templates) {
        if (store.getTemplate(t.id)) continue;
        let specJson: string | null = null;
        if (t.spec) {
          const specPath = join(brandsDir, dir, t.spec);
          if (existsSync(specPath)) specJson = readFileSync(specPath, 'utf8');
        }
        store.insertTemplate({
          id: t.id,
          brandId: manifest.id,
          preset: t.preset,
          imagePath: `fixtures/brands/${dir}/${t.image}`,
          framePath: t.frame ? `fixtures/brands/${dir}/${t.frame}` : null,
          expiresAt: null,
        });
        if (specJson) store.setTemplateReady(t.id, specJson);
        else store.setTemplateFailed(t.id, 'fixture spec missing');
      }
    }

    // Saved demo job (finished GALI run, committed under fixtures).
    const demoPath = join(brandsDir, 'gali', 'demo', 'demo.json');
    if (existsSync(demoPath)) {
      const demo = JSON.parse(readFileSync(demoPath, 'utf8')) as DemoJob;
      if (!store.getJob(DEMO_JOB_ID)) {
        const sourceIds = [...new Set(demo.outputs.map((o) => o.source))];
        for (const sid of sourceIds) {
          if (!store.getSource(sid)) {
            const first = demo.outputs.find((o) => o.source === sid);
            const meta = { width: 0, height: 0 };
            void meta;
            store.insertSource({ id: sid, imagePath: `fixtures/brands/gali/${first?.sourceLabel ?? 'source-he.png'}`, width: 1080, height: 1080, expiresAt: null });
          }
        }
        store.insertJob({ id: DEMO_JOB_ID, brandId: demo.brand, mode: demo.mode, sizes: demo.outputs.map((o) => o.preset), sources: sourceIds });
        for (const o of demo.outputs) {
          store.insertOutput({
            jobId: DEMO_JOB_ID,
            sourceId: o.source,
            preset: o.preset,
            mode: o.mode,
            status: o.status,
            imagePath: `fixtures/brands/gali/demo/${o.image}`,
            planJson: JSON.stringify(o.plan),
            proofJson: o.proof ? JSON.stringify(o.proof) : null,
            qaJson: o.qa ? JSON.stringify(o.qa) : null,
            retries: o.retries,
            modelCalls: o.modelCalls,
            imageCalls: o.imageCalls,
            latencyMs: o.latencyMs,
            traceJson: JSON.stringify(o.trace),
            error: o.error,
          });
        }
        store.finishJob(DEMO_JOB_ID, 'done', null, demo.modelCalls, demo.imageCalls);
      }
    }
  } finally {
    store.close();
  }
}
