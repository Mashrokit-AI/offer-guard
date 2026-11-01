import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from '../src/shared/env.js';

const REPO_ROOT = findRepoRoot(import.meta.url);

function allSrcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...allSrcFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('module graph', () => {
  it('has no ad-platform write imports anywhere under src/', () => {
    const offenders: string[] = [];
    for (const f of allSrcFiles(join(REPO_ROOT, 'src'))) {
      const text = readFileSync(f, 'utf8');
      if (/from\s+['"]\.\.?\/.*meta\/graph\.js['"]/.test(text)) offenders.push(`${f}: meta/graph import`);
      if (/graph\.facebook\.com/.test(text)) offenders.push(`${f}: graph host`);
      if (/\bact_\d/.test(text)) offenders.push(`${f}: act_ id`);
      if (/\/ads\b.*POST|method:\s*['"]POST['"]/.test(text) && /ads\//.test(text)) offenders.push(`${f}: suspicious ad POST`);
    }
    expect(offenders).toEqual([]);
  });

  it('has no Offer Guard verdict/sweep/campaign leftovers under src/', () => {
    const offenders: string[] = [];
    for (const f of allSrcFiles(join(REPO_ROOT, 'src'))) {
      const text = readFileSync(f, 'utf8');
      for (const re of [/AdClaims/, /PageClaims/, /runSweep/, /extract-page/, /offer-guard\.db/]) {
        if (re.test(text)) offenders.push(`${f}: ${String(re)}`);
      }
      // OFFER_GUARD_* env is gone except the documented secrets-file compat fallback.
      if (!f.endsWith('shared/env.ts') && /OFFER_GUARD_/.test(text)) offenders.push(`${f}: OFFER_GUARD_`);
    }
    expect(offenders).toEqual([]);
  });
});
