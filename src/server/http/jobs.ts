import { randomBytes } from 'node:crypto';
import type { SweepRow } from '../workflow/sweep.js';

/**
 * One heavy job at a time (fresh sweep or own-ad check), bounded queue,
 * per-IP hourly rate limit, SSE fan-out with replay. All in-memory: the
 * server is a single process and jobs are short-lived demo runs.
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface JobProgressEvent {
  type: 'progress';
  done: number;
  total: number;
  row: SweepRow;
}

export interface JobTerminalEvent {
  type: 'done' | 'failed';
  done: number;
  total: number;
  snapshotId?: number;
  cached?: boolean;
  error?: string;
}

export type JobEvent = JobProgressEvent | JobTerminalEvent;

export interface JobResult {
  snapshotId?: number;
  cached?: boolean;
}

export interface Job {
  id: string;
  kind: 'fresh' | 'check';
  status: JobStatus;
  total: number;
  done: number;
  rows: SweepRow[];
  snapshotId?: number;
  cached?: boolean;
  errorKey?: string;
  log: JobEvent[];
  listeners: Set<(e: JobEvent) => void>;
  createdAt: number;
}

export interface JobSummary {
  id: string;
  kind: 'fresh' | 'check';
  status: JobStatus;
  total: number;
  done: number;
  rows: SweepRow[];
  snapshotId?: number;
  cached?: boolean;
  error?: string;
}

export function summarize(job: Job): JobSummary {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    total: job.total,
    done: job.done,
    rows: [...job.rows],
    snapshotId: job.snapshotId,
    cached: job.cached,
    error: job.errorKey,
  };
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly perHour: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when the call is allowed (and recorded); false when over the limit. */
  check(ip: string): boolean {
    const t = this.now();
    const list = (this.hits.get(ip) ?? []).filter((x) => t - x < 3600_000);
    if (list.length >= this.perHour) {
      this.hits.set(ip, list);
      return false;
    }
    list.push(t);
    this.hits.set(ip, list);
    return true;
  }
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private running: Job | null = null;
  private readonly waiting: Job[] = [];

  constructor(
    private readonly opts: { queueMax: number; jobTimeoutMs: number; now?: () => number },
  ) {}

  get(id: string): Job | null {
    return this.jobs.get(id) ?? null;
  }

  queuedCount(): number {
    return this.waiting.length;
  }

  isBusy(): boolean {
    return this.running !== null;
  }

  /**
   * Submit a heavy task. The task runs `onRow` per finished ad and resolves
   * with the resulting snapshot id (single-check jobs). Returns null when
   * the server is busy (running + queue full).
   */
  submit(
    kind: 'fresh' | 'check',
    total: number,
    task: (onRow: (row: SweepRow) => void) => Promise<JobResult>,
  ): Job | null {
    if (this.running && this.waiting.length >= this.opts.queueMax) return null;
    const now = this.opts.now ?? Date.now;
    const job: Job = {
      id: randomBytes(9).toString('hex'),
      kind,
      status: this.running ? 'queued' : 'running',
      total,
      done: 0,
      rows: [],
      log: [],
      listeners: new Set(),
      createdAt: now(),
    };
    this.jobs.set(job.id, job);
    if (this.jobs.size > 50) {
      const oldest = [...this.jobs.values()].find((j) => j.status === 'done' || j.status === 'failed');
      if (oldest && oldest.id !== job.id) this.jobs.delete(oldest.id);
    }
    if (this.running) {
      this.waiting.push(job);
    } else {
      void this.execute(job, task);
    }
    return job;
  }

  onRow(job: Job, row: SweepRow): void {
    job.done += 1;
    job.rows.push(row);
    this.emit(job, { type: 'progress', done: job.done, total: job.total, row });
  }

  private emit(job: Job, event: JobEvent): void {
    job.log.push(event);
    for (const fn of job.listeners) {
      try {
        fn(event);
      } catch {
        // A broken listener must not break the job.
      }
    }
  }

  private finish(job: Job, event: JobTerminalEvent): void {
    if (event.type === 'done') {
      job.status = 'done';
      job.snapshotId = event.snapshotId;
      job.cached = event.cached;
    } else {
      job.status = 'failed';
      job.errorKey = event.error ?? 'err_job_failed';
    }
    this.emit(job, event);
    this.running = null;
    const next = this.waiting.shift();
    if (next) {
      next.status = 'running';
      void this.execute(next, (next as unknown as { task: (onRow: (r: SweepRow) => void) => Promise<JobResult> }).task);
    }
  }

  private async execute(
    job: Job,
    task: (onRow: (row: SweepRow) => void) => Promise<JobResult>,
  ): Promise<void> {
    // Stash the task so finish() can start queued jobs generically.
    (job as unknown as { task: typeof task }).task = task;
    if (this.running && this.running.id !== job.id) {
      this.waiting.push(job);
      return;
    }
    this.running = job;
    job.status = 'running';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.finish(job, { type: 'failed', done: job.done, total: job.total, error: 'err_job_timeout' });
    }, this.opts.jobTimeoutMs);
    // Don't hold the process open for a hung job.
    timer.unref?.();
    try {
      const result = await task((row) => this.onRow(job, row));
      if (timedOut) return;
      clearTimeout(timer);
      this.finish(job, { type: 'done', done: job.done, total: job.total, snapshotId: result.snapshotId, cached: result.cached });
    } catch {
      if (timedOut) return;
      clearTimeout(timer);
      this.finish(job, { type: 'failed', done: job.done, total: job.total, error: 'err_job_failed' });
    }
  }
}

/** SSE response: replays the job log, then streams until a terminal event. */
export function sseResponse(job: Job): Response {
  const encode = (e: JobEvent): string => `data: ${JSON.stringify(e)}\n\n`;
  const enc = new TextEncoder();
  let listener: ((e: JobEvent) => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of job.log) controller.enqueue(enc.encode(encode(e)));
      const terminal = job.log.find((e) => e.type === 'done' || e.type === 'failed');
      if (terminal) {
        controller.close();
        return;
      }
      listener = (e: JobEvent): void => {
        controller.enqueue(enc.encode(encode(e)));
        if (e.type === 'done' || e.type === 'failed') {
          if (listener) job.listeners.delete(listener);
          controller.close();
        }
      };
      job.listeners.add(listener);
    },
    cancel() {
      if (listener) job.listeners.delete(listener);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
