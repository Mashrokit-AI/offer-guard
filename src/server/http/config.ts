import { z } from 'zod';

/** Env parsing for the public web server. All optional, all have safe defaults. */
export const httpConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(3023),
  basePath: z
    .string()
    .default('/')
    .transform((s) => {
      const t = `/${s}/`.replace(/\/+/g, '/');
      return t;
    }),
  live: z
    .string()
    .default('on')
    .transform((s) => s.trim().toLowerCase() !== 'off'),
  trustProxy: z
    .string()
    .default('0')
    .transform((s) => s.trim() === '1'),
  dailyModelCalls: z.coerce.number().int().min(0).default(300),
  jobTimeoutMs: z.coerce.number().int().min(10_000).default(600_000),
  ratePerHour: z.coerce.number().int().min(1).default(3),
  queueMax: z.coerce.number().int().min(0).default(3),
  uploadMaxBytes: z.coerce.number().int().min(1024).default(5 * 1024 * 1024),
  uploadMaxPixels: z.coerce.number().int().min(10_000).default(12_000_000),
});

export type HttpConfig = z.infer<typeof httpConfigSchema>;

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  return httpConfigSchema.parse({
    port: env.OFFER_GUARD_PORT,
    basePath: env.OFFER_GUARD_BASE_PATH,
    live: env.OFFER_GUARD_LIVE,
    trustProxy: env.OFFER_GUARD_TRUST_PROXY,
    dailyModelCalls: env.OFFER_GUARD_DAILY_MODEL_CALLS,
    jobTimeoutMs: env.OFFER_GUARD_JOB_TIMEOUT_MS,
    ratePerHour: env.OFFER_GUARD_RATE_PER_HOUR,
    queueMax: env.OFFER_GUARD_QUEUE_MAX,
    uploadMaxBytes: env.OFFER_GUARD_UPLOAD_MAX_BYTES,
    uploadMaxPixels: env.OFFER_GUARD_UPLOAD_MAX_PIXELS,
  });
}
