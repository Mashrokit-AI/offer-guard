#!/usr/bin/env tsx
/**
 * One-shot generator for the complex-fixture photographic backgrounds
 * (VELA + DAFNA). Runs once; the PNGs are committed like NOA's source.
 * Cost: 2 x Muse Image = $0.02 (logged to the session ledger file).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findRepoRoot, loadEnvFiles } from '../src/shared/env.js';
import { loadModelConfig } from '../src/shared/config.js';
import { generateImage } from '../src/server/models/muse-image.js';
import { CostLedger } from '../src/server/models/costs.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
loadEnvFiles(REPO_ROOT);

const BACKGROUNDS: Array<{ dir: string; file: string; prompt: string }> = [
  {
    dir: join(REPO_ROOT, 'fixtures', 'brands', 'vela'),
    file: 'bg-photo.png',
    prompt:
      'Soft morning spa background photograph: sunlit stone countertop with blurred eucalyptus sprigs and a linen cloth at the edges, ' +
      'bright airy bokeh, large empty copy space in the center, absolutely NO products, NO bottles, NO people, NO text, NO logos, NO shadows of objects',
  },
  {
    dir: join(REPO_ROOT, 'fixtures', 'brands', 'dafna'),
    file: 'bg-photo.png',
    prompt:
      'Warm Mediterranean terrace background photograph at golden hour: blurred olive branches and old stone wall, soft glowing bokeh, ' +
      'large empty copy space in the center, absolutely NO products, NO jars, NO people, NO text, NO logos, NO shadows of objects',
  },
];

async function main(): Promise<void> {
  const cfg = loadModelConfig(process.env);
  const ledger = new CostLedger(25);
  for (const bg of BACKGROUNDS) {
    await mkdir(bg.dir, { recursive: true });
    console.log(`generating ${bg.file} ...`);
    const res = await generateImage(
      { baseUrl: cfg.MODEL_API_BASE, apiKey: cfg.MODEL_API_KEY, model: cfg.MODEL_IMAGE },
      bg.prompt,
      '1080x1080',
    );
    ledger.record(cfg.MODEL_IMAGE, { images: 1 }, `fixture-bg ${bg.file}`);
    await writeFile(join(bg.dir, bg.file), res.png);
    console.log(`wrote ${join(bg.dir, bg.file)} (${res.png.length} bytes)`);
  }
  console.log(JSON.stringify({ totals: ledger.totals() }));
}

await main();
