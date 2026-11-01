import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/server/store/db.js';

function open(): { store: Store; dbPath: string } {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'adfit-db-')), 't.db');
  return { store: Store.open(dbPath), dbPath };
}

describe('store', () => {
  it('creates brands and resolves exact-size then default templates', () => {
    const { store } = open();
    try {
      store.insertBrand({ id: 'b1', name: 'B', colors: ['#ffffff'], fonts: [], logoPath: null, isDemo: false, expiresAt: null });
      store.insertTemplate({ id: 't-def', brandId: 'b1', preset: null, imagePath: 'data/x.png', framePath: null, expiresAt: null });
      store.setTemplateReady('t-def', '{"direction":"rtl"}');
      store.insertTemplate({ id: 't-11', brandId: 'b1', preset: 'ig-feed-11', imagePath: 'data/y.png', framePath: null, expiresAt: null });
      store.setTemplateReady('t-11', '{"direction":"rtl"}');
      expect(store.templateForSize('b1', 'ig-feed-11')?.id).toBe('t-11');
      expect(store.templateForSize('b1', 'ig-story-916')?.id).toBe('t-def');
      expect(store.templateForSize('b1', 'nope-preset')?.id).toBe('t-def');
      // Pending templates never resolve.
      store.insertTemplate({ id: 't-pend', brandId: 'b1', preset: 'fb-feed', imagePath: 'data/z.png', framePath: null, expiresAt: null });
      expect(store.templateForSize('b1', 'fb-feed')?.id).toBe('t-def');
    } finally {
      store.close();
    }
  });

  it('tracks jobs, outputs and per-kind usage', () => {
    const { store } = open();
    try {
      store.insertSource({ id: 's1', imagePath: 'data/s.png', width: 100, height: 100, expiresAt: null });
      store.insertJob({ id: 'j1', brandId: null, mode: 'protected', sizes: ['ig-feed-11'], sources: ['s1'] });
      const oid = store.insertOutput({
        jobId: 'j1', sourceId: 's1', preset: 'ig-feed-11', mode: 'protected', status: 'pass',
        imagePath: 'data/o.png', planJson: '{}', proofJson: null, qaJson: '{"pass":true}',
        retries: 0, modelCalls: 3, imageCalls: 1, latencyMs: 5, traceJson: '[]', error: null,
      });
      expect(store.getOutput(oid)?.status).toBe('pass');
      expect(store.outputsForJob('j1')).toHaveLength(1);
      store.finishJob('j1', 'done', null, 3, 1);
      expect(store.getJob('j1')?.status).toBe('done');
      store.recordUsage('model', 3);
      store.recordUsage('image', 1);
      store.recordUsage('model', 0); // no-op, never a row
      const midnight = new Date();
      midnight.setUTCHours(0, 0, 0, 0);
      expect(store.countUsageSince(midnight.toISOString(), 'model')).toBe(3);
      expect(store.countUsageSince(midnight.toISOString(), 'image')).toBe(1);
    } finally {
      store.close();
    }
  });

  it('deletes expired visitor rows but keeps demo brands', () => {
    const { store } = open();
    try {
      const past = new Date(Date.now() - 1000).toISOString();
      const future = new Date(Date.now() + 3600_000).toISOString();
      store.insertBrand({ id: 'demo', name: 'D', colors: [], fonts: [], logoPath: 'fixtures/x.png', isDemo: true, expiresAt: null });
      store.insertBrand({ id: 'old', name: 'O', colors: [], fonts: [], logoPath: 'data/old/logo.png', isDemo: false, expiresAt: past });
      store.insertBrand({ id: 'new', name: 'N', colors: [], fonts: [], logoPath: null, isDemo: false, expiresAt: future });
      store.insertTemplate({ id: 't-old', brandId: 'old', preset: null, imagePath: 'data/old/t.png', framePath: null, expiresAt: past });
      store.insertSource({ id: 's-old', imagePath: 'data/old/s.png', width: 1, height: 1, expiresAt: past });
      const paths = store.deleteExpired(new Date().toISOString());
      expect(paths.sort()).toEqual(['data/old/logo.png', 'data/old/s.png', 'data/old/t.png'].sort());
      expect(store.getBrand('old')).toBeNull();
      expect(store.getTemplate('t-old')).toBeNull();
      expect(store.getSource('s-old')).toBeNull();
      expect(store.getBrand('demo')).not.toBeNull();
      expect(store.getBrand('new')).not.toBeNull();
    } finally {
      store.close();
    }
  });
});
