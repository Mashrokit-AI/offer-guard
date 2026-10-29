import { z } from 'zod';
import { maskSecret } from './masking.js';

const numericId = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .regex(/^\d+$/, `${label} must be digits only (without the act_ prefix)`);

export const configSchema = z.object({
  META_ACCESS_TOKEN: z.string().trim().min(1, 'META_ACCESS_TOKEN is required'),
  META_GRAPH_VERSION: z
    .string()
    .trim()
    .regex(/^v\d+\.\d+$/, 'META_GRAPH_VERSION must look like v25.0')
    .default('v25.0'),
  META_AD_ACCOUNT_ID: numericId('META_AD_ACCOUNT_ID'),
  META_PAGE_ID: numericId('META_PAGE_ID'),
  META_ADSET_ID: numericId('META_ADSET_ID'),
  META_TEST_LINK_URL: z.string().trim().url('META_TEST_LINK_URL must be a valid URL'),
  MODEL_API_KEY: z.string().trim().optional().default(''),
  MODEL_API_BASE: z.string().trim().url('MODEL_API_BASE must be a valid URL').default('https://api.meta.ai/v1'),
});

export type OfferGuardConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OfferGuardConfig {
  return configSchema.parse({
    META_ACCESS_TOKEN: env.META_ACCESS_TOKEN,
    META_GRAPH_VERSION: env.META_GRAPH_VERSION,
    META_AD_ACCOUNT_ID: env.META_AD_ACCOUNT_ID,
    META_PAGE_ID: env.META_PAGE_ID,
    META_ADSET_ID: env.META_ADSET_ID,
    META_TEST_LINK_URL: env.META_TEST_LINK_URL,
    MODEL_API_KEY: env.MODEL_API_KEY,
    MODEL_API_BASE: env.MODEL_API_BASE,
  });
}

/** Config safe for logs: the token is always masked, never printed raw. */
export function describeConfigForLog(config: OfferGuardConfig): Record<string, string> {
  return {
    META_ACCESS_TOKEN: maskSecret(config.META_ACCESS_TOKEN),
    META_GRAPH_VERSION: config.META_GRAPH_VERSION,
    META_AD_ACCOUNT_ID: config.META_AD_ACCOUNT_ID,
    META_PAGE_ID: config.META_PAGE_ID,
    META_ADSET_ID: config.META_ADSET_ID,
    META_TEST_LINK_URL: config.META_TEST_LINK_URL,
    MODEL_API_BASE: config.MODEL_API_BASE,
    MODEL_API_KEY: config.MODEL_API_KEY ? maskSecret(config.MODEL_API_KEY) : '(empty)',
  };
}
