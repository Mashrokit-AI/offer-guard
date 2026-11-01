import { describe, expect, it } from 'vitest';
import { JobManager, RateLimiter, sseResponse } from '../src/server/http/jobs.js';

const row = (n: number) => ({ outputId: n, sourceId: 's', sourceIndex: 0, preset: 'ig-feed-11', status: 'pass' as const, retries: 0, models: ['muse-spark-1.3'], traceMs: 1200 });

describe('RateLimiter', () => {
  it('allows 3 per hour per IP, then refuses', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(3, () => now);
    expect(limiter.check('1.2.3.4')).toBe(true);
    expect(limiter.check('1.2.3.4')).toBe(true);
    expect(limiter.check('1.2.3.4')).toBe(true);
    expect(limiter.check('1.2.3.4')).toBe(false);
    expect(limiter.check('5.6.7.8')).toBe(true);
    now += 3600_000;
    expect(limiter.check('1.2.3.4')).toBe(true);
  });
});

describe('JobManager', () => {
  it('runs one job at a time, queues 3, then says busy', async () => {
    const mgr = new JobManager({ queueMax: 3, jobTimeoutMs: 60_000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = () => gate.then(() => ({}));
    const j1 = mgr.submit('generate', 1, async () => slow());
    const j2 = mgr.submit('generate', 1, async () => ({}));
    const j3 = mgr.submit('generate', 1, async () => ({}));
    const j4 = mgr.submit('generate', 1, async () => ({}));
    const j5 = mgr.submit('generate', 1, async () => ({}));
    expect([j1?.status, j2?.status, j3?.status, j4?.status]).toEqual(['running', 'queued', 'queued', 'queued']);
    expect(j5).toBeNull();
    expect(mgr.isBusy()).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(mgr.get(j1!.id)?.status).toBe('done');
  });

  it('streams progress rows and replays the log over SSE', async () => {
    const mgr = new JobManager({ queueMax: 3, jobTimeoutMs: 60_000 });
    const job = mgr.submit('generate', 2, async (onRow) => {
      onRow(row(1));
      onRow(row(2));
      return { jobId: 'store-1' };
    });
    for (let i = 0; i < 50 && mgr.get(job!.id)?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const done = mgr.get(job!.id)!;
    expect(done.status).toBe('done');
    expect(done.done).toBe(2);
    const res = sseResponse(done);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('"type":"progress"');
    expect(text).toContain('"type":"done"');
    expect(text).toContain('"jobId":"store-1"');
  });

  it('fails jobs past the hard timeout', async () => {
    const mgr = new JobManager({ queueMax: 3, jobTimeoutMs: 50 });
    const job = mgr.submit('generate', 1, () => new Promise(() => undefined));
    for (let i = 0; i < 50 && mgr.get(job!.id)?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(mgr.get(job!.id)?.status).toBe('failed');
  });
});
