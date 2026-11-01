#!/usr/bin/env tsx
/**
 * Bundle the no-framework UI (src/web/app.ts → dist/web/app.js) and copy the
 * shell, stylesheet, favicon and bundled fonts. No CDN, no external request.
 *
 *   npm run build:web        one-shot build
 *   npm run web:dev          rebuild on change + run the server
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { findRepoRoot } from '../src/shared/env.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const OUT = join(REPO_ROOT, 'dist', 'web');

const FONTS: Array<[string, string[]]> = [
  ['noto-sans', ['noto-sans-latin-400-normal.woff2', 'noto-sans-latin-500-normal.woff2', 'noto-sans-latin-700-normal.woff2']],
  ['noto-sans-hebrew', ['noto-sans-hebrew-hebrew-400-normal.woff2', 'noto-sans-hebrew-hebrew-500-normal.woff2', 'noto-sans-hebrew-hebrew-700-normal.woff2']],
];

async function copyStatic(): Promise<void> {
  await mkdir(join(OUT, 'fonts'), { recursive: true });
  await copyFile(join(REPO_ROOT, 'src', 'web', 'index.html'), join(OUT, 'index.html'));
  await copyFile(join(REPO_ROOT, 'src', 'web', 'styles.css'), join(OUT, 'styles.css'));
  await copyFile(join(REPO_ROOT, 'src', 'web', 'favicon.svg'), join(OUT, 'favicon.svg'));
  for (const [pkg, files] of FONTS) {
    for (const f of files) {
      await copyFile(join(REPO_ROOT, 'node_modules', '@fontsource', pkg, 'files', f), join(OUT, 'fonts', f));
    }
  }
}

async function buildOnce(): Promise<void> {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await esbuild.build({
    entryPoints: [join(REPO_ROOT, 'src', 'web', 'app.ts')],
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: join(OUT, 'app.js'),
    logLevel: 'warning',
  });
  await copyStatic();
  console.log('web: built dist/web/app.js (+ shell, css, fonts)');
}

async function watch(): Promise<void> {
  await buildOnce();
  const ctx = await esbuild.context({
    entryPoints: [join(REPO_ROOT, 'src', 'web', 'app.ts')],
    bundle: true,
    minify: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: join(OUT, 'app.js'),
    logLevel: 'warning',
  });
  await ctx.watch();
  console.log('web: watching src/web/ …');
  let server: ChildProcess | null = null;
  const startServer = (): void => {
    server = spawn('npx', ['tsx', join('src', 'server', 'http', 'server.ts')], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  };
  startServer();
  const stop = (): void => {
    void ctx.dispose();
    server?.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function main(): Promise<void> {
  if (process.argv.includes('--watch')) await watch();
  else {
    await buildOnce();
    process.exit(0);
  }
}

void main();
