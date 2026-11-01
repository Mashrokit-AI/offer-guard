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
  dailyImages: z.coerce.number().int().min(0).default(200),
  jobTimeoutMs: z.coerce.number().int().min(10_000).default(900_000),
  ratePerHour: z.coerce.number().int().min(1).default(3),
  queueMax: z.coerce.number().int().min(0).default(3),
  uploadMaxBytes: z.coerce.number().int().min(1024).default(10 * 1024 * 1024),
  uploadMaxPixels: z.coerce.number().int().min(10_000).default(24_000_000),
  sizeConcurrency: z.coerce.number().int().min(1).max(8).default(4),
  wonderDailyUsd: z.coerce.number().min(0).default(3),
  dailyUsd: z.coerce.number().min(0).default(8),
});

export type HttpConfig = z.infer<typeof httpConfigSchema>;

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  return httpConfigSchema.parse({
    port: env.ADFIT_PORT,
    basePath: env.ADFIT_BASE_PATH,
    live: env.ADFIT_LIVE,
    trustProxy: env.ADFIT_TRUST_PROXY,
    dailyModelCalls: env.ADFIT_DAILY_MODEL_CALLS,
    dailyImages: env.ADFIT_DAILY_IMAGES,
    jobTimeoutMs: env.ADFIT_JOB_TIMEOUT_MS,
    ratePerHour: env.ADFIT_RATE_PER_HOUR,
    queueMax: env.ADFIT_QUEUE_MAX,
    uploadMaxBytes: env.ADFIT_UPLOAD_MAX_BYTES,
    uploadMaxPixels: env.ADFIT_UPLOAD_MAX_PIXELS,
    sizeConcurrency: env.ADFIT_SIZE_CONCURRENCY,
    wonderDailyUsd: env.ADFIT_WONDER_DAILY_USD,
    dailyUsd: env.ADFIT_DAILY_USD,
  });
}
