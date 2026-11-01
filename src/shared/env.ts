import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Secrets (the Model API key) live OUTSIDE the repo so that neither git nor a
 * coding agent working in this folder can read them. Default:
 * ~/.config/offer-guard/secrets.env (chmod 600) — the historical path, kept so
 * existing setups keep working after the MatchPic pivot.
 */
export function secretsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.ADFIT_SECRETS_FILE ||
    env.OFFER_GUARD_SECRETS_FILE ||
    join(homedir(), '.config', 'offer-guard', 'secrets.env')
  );
}

/** Load the out-of-repo secrets file first, then the repo .env (non-secrets only). */
export function loadEnvFiles(repoRoot: string): void {
  dotenv.config({ path: secretsFilePath(), quiet: true });
  dotenv.config({ path: join(repoRoot, '.env'), quiet: true });
}

/**
 * Find the repo root (the dir holding package.json) by walking up from a
 * module URL. Works both for tsx runs (scripts/foo.ts) and tsc-compiled runs
 * (dist/scripts/foo.js), where `../..` arithmetic would differ.
 */
export function findRepoRoot(fromUrl: string | URL): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('findRepoRoot: no package.json found walking up');
    dir = parent;
  }
}
