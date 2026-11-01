#!/usr/bin/env tsx
/**
 * Offer Guard web app: static UI + read API + bounded live jobs.
 * Binds 127.0.0.1 (nginx fronts it in production).
 *
 *   npm run web        build + start
 *   npm run web:dev    rebuild on change + start
 */
import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { findRepoRoot, loadEnvFiles } from '../../shared/env.js';
import { loadHttpConfig } from './config.js';
import { createApp } from './app.js';
import { cleanupUploads } from './uploads.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const DAY_MS = 24 * 3600 * 1000;

async function main(): Promise<void> {
  loadEnvFiles(REPO_ROOT);
  const cfg = loadHttpConfig(process.env);
  const removed = await cleanupUploads(REPO_ROOT, DAY_MS).catch(() => 0);
  if (removed > 0) console.log(`uploads: removed ${removed} expired dir(s)`);
  const timer = setInterval(() => {
    void cleanupUploads(REPO_ROOT, DAY_MS).catch(() => 0);
  }, 3600_000);
  timer.unref?.();

  const app = createApp({ repoRoot: REPO_ROOT, webRoot: join(REPO_ROOT, 'dist', 'web') });
  serve({ fetch: app.fetch, port: cfg.port, hostname: '127.0.0.1' }, () => {
    console.log(`Offer Guard web: http://127.0.0.1:${cfg.port}${cfg.basePath} live=${cfg.live ? 'on' : 'off'}`);
  });
}

void main();
