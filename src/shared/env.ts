import dotenv from 'dotenv';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Secrets (Meta access token, Model API key) live OUTSIDE the repo so that neither git nor a coding
 * agent working in this folder can read them. Default: ~/.config/offer-guard/secrets.env (chmod 600).
 */
export function secretsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OFFER_GUARD_SECRETS_FILE || join(homedir(), '.config', 'offer-guard', 'secrets.env');
}

/** Load the out-of-repo secrets file first, then the repo .env (which holds only non-secret IDs). */
export function loadEnvFiles(repoRoot: string): void {
  dotenv.config({ path: secretsFilePath(), quiet: true });
  dotenv.config({ path: join(repoRoot, '.env'), quiet: true });
}
