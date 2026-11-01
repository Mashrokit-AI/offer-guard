import { z } from 'zod';
import { maskSecret } from './masking.js';

/** Model-API-only config. Must NOT require any Meta token. */
export const modelConfigSchema = z.object({
  MODEL_API_KEY: z.string().trim().min(1, 'MODEL_API_KEY is required'),
  MODEL_API_BASE: z.string().trim().url('MODEL_API_BASE must be a valid URL').default('https://api.meta.ai/v1'),
  MODEL_EXTRACT: z.string().trim().min(1, 'MODEL_EXTRACT must not be empty').default('muse-spark-1.3'),
  MODEL_SAM: z.string().trim().min(1, 'MODEL_SAM must not be empty').default('sam-3.1'),
  MODEL_IMAGE: z.string().trim().min(1, 'MODEL_IMAGE must not be empty').default('muse-image-1.0'),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;

export function loadModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  return modelConfigSchema.parse({
    MODEL_API_KEY: env.MODEL_API_KEY,
    MODEL_API_BASE: env.MODEL_API_BASE,
    MODEL_EXTRACT: env.MODEL_EXTRACT,
    MODEL_SAM: env.MODEL_SAM,
    MODEL_IMAGE: env.MODEL_IMAGE,
  });
}

/** Model config safe for logs: the key is always masked, never printed raw. */
export function describeModelConfigForLog(config: ModelConfig): Record<string, string> {
  return {
    MODEL_API_KEY: maskSecret(config.MODEL_API_KEY),
    MODEL_API_BASE: config.MODEL_API_BASE,
    MODEL_EXTRACT: config.MODEL_EXTRACT,
    MODEL_SAM: config.MODEL_SAM,
    MODEL_IMAGE: config.MODEL_IMAGE,
  };
}
