#!/usr/bin/env tsx
/**
 * MatchPic web app: static UI + read API + bounded live jobs.
 * Binds 127.0.0.1 (nginx fronts it in production).
 *
 *   npm run web        build + start
 *   npm run web:dev    rebuild on change + start
 */
import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { BRAND_NAME } from '../../shared/brand.js';
import { findRepoRoot, loadEnvFiles } from '../../shared/env.js';
import { ensureSeeded } from '../adfit/seed.js';
import { Store } from '../store/db.js';
import { loadHttpConfig } from './config.js';
import { createApp } from './app.js';
import { cleanupUploads } from './uploads.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const DAY_MS = 24 * 3600 * 1000;

async function cleanup(repoRoot: string, dbPath: string): Promise<void> {
  for (const sub of ['uploads', 'templates', 'logos', 'outputs', 'masks']) {
    await cleanupUploads(repoRoot, DAY_MS, sub).catch(() => 0);
  }
  // Expired visitor brands/templates/sources; unlink data files only (fixtures stay).
  try {
    const store = Store.open(dbPath);
    try {
      const paths = store.deleteExpired(new Date().toISOString());
      for (const rel of paths) {
        if (!rel.startsWith('data/')) continue;
        await rm(join(repoRoot, rel), { force: true, recursive: true }).catch(() => undefined);
      }
    } finally {
      store.close();
    }
  } catch {
    // Best effort; retried on the next pass.
  }
}

async function main(): Promise<void> {
  loadEnvFiles(REPO_ROOT);
  const cfg = loadHttpConfig(process.env);
  const dbPath = join(REPO_ROOT, 'data', 'adfit.db');
  ensureSeeded(REPO_ROOT, dbPath);
  await cleanup(REPO_ROOT, dbPath);
  const timer = setInterval(() => {
    void cleanup(REPO_ROOT, dbPath);
  }, 3600_000);
  timer.unref?.();

  const app = createApp({ repoRoot: REPO_ROOT, dbPath, webRoot: join(REPO_ROOT, 'dist', 'web') });
  serve({ fetch: app.fetch, port: cfg.port, hostname: '127.0.0.1' }, () => {
    console.log(`${BRAND_NAME} web: http://127.0.0.1:${cfg.port}${cfg.basePath} live=${cfg.live ? 'on' : 'off'}`);
  });
}

void main();
