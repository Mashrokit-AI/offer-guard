import type { OfferGuardConfig } from '../../shared/config.js';
import { redactText } from '../../shared/masking.js';

export const GRAPH_HOST = 'https://graph.facebook.com';

export interface GraphErrorBody {
  message: string;
  type: string;
  code: number;
  error_subcode?: number;
  error_user_msg?: string;
  fbtrace_id?: string;
}

export class GraphApiError extends Error {
  constructor(
    public readonly body: GraphErrorBody,
    public readonly httpStatus: number,
    public readonly requestSummary: string,
  ) {
    super(body.error_user_msg || body.message);
    this.name = 'GraphApiError';
  }
}

export class GraphTimeoutError extends Error {
  constructor(public readonly requestSummary: string, public readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms: ${requestSummary}`);
    this.name = 'GraphTimeoutError';
  }
}

/** One-line-per-fact rendering of a Graph error for console + journal. */
export function formatGraphError(err: GraphApiError): string {
  const b = err.body;
  return [
    `Graph error (HTTP ${err.httpStatus}) on ${err.requestSummary}:`,
    `  error.code        = ${b.code}`,
    `  error_subcode     = ${b.error_subcode ?? '(none)'}`,
    `  error_user_msg    = ${b.error_user_msg ?? '(none)'}`,
    `  message           = ${b.message}`,
    `  fbtrace_id        = ${b.fbtrace_id ?? '(none)'}`,
  ].join('\n');
}

export interface GraphCallOptions {
  timeoutMs?: number;
}

function buildUrl(
  config: OfferGuardConfig,
  path: string,
  params: Record<string, string | undefined>,
): { url: string; summary: string } {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) search.set(k, v);
  }
  const summary = `https://graph.facebook.com/${config.META_GRAPH_VERSION}${path}?${search.toString()}`;
  search.set('access_token', config.META_ACCESS_TOKEN);
  return { url: `${GRAPH_HOST}/${config.META_GRAPH_VERSION}${path}?${search.toString()}`, summary };
}

function summarizeJsonBody(body: Record<string, unknown>, secrets: Array<string | null | undefined>): string {
  return redactText(JSON.stringify(body), secrets);
}

async function parseJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? (JSON.parse(text) as unknown) : {};
  } catch {
    return { _raw: text.slice(0, 500) };
  }
}

async function doFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  requestSummary: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new GraphTimeoutError(requestSummary, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface GraphResult<T> {
  data: T;
  requestSummary: string;
}

function throwIfGraphError(json: unknown, httpStatus: number, requestSummary: string): void {
  if (typeof json === 'object' && json !== null && 'error' in json) {
    const e = (json as { error: GraphErrorBody }).error;
    throw new GraphApiError(
      {
        message: String(e.message ?? 'Unknown Graph error'),
        type: String(e.type ?? ''),
        code: Number(e.code ?? 0),
        error_subcode: e.error_subcode,
        error_user_msg: e.error_user_msg,
        fbtrace_id: e.fbtrace_id,
      },
      httpStatus,
      requestSummary,
    );
  }
}

export async function graphGet<T>(
  config: OfferGuardConfig,
  path: string,
  params: Record<string, string | undefined> = {},
  options: GraphCallOptions = {},
): Promise<GraphResult<T>> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const { url, summary } = buildUrl(config, path, params);
  const requestSummary = `GET ${summary}`;
  const res = await doFetch(url, { method: 'GET' }, timeoutMs, requestSummary);
  const json = await parseJsonSafe(res);
  throwIfGraphError(json, res.status, requestSummary);
  if (!res.ok) {
    throw new GraphApiError(
      { message: `HTTP ${res.status} with no Graph error body`, type: '', code: 0 },
      res.status,
      requestSummary,
    );
  }
  return { data: json as T, requestSummary };
}

export async function graphPost<T>(
  config: OfferGuardConfig,
  path: string,
  body: Record<string, unknown>,
  options: GraphCallOptions = {},
): Promise<GraphResult<T>> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const { url, summary } = buildUrl(config, path, {});
  const bodySummary = summarizeJsonBody(body, [config.META_ACCESS_TOKEN]);
  const requestSummary = `POST ${summary} ${bodySummary}`;
  const res = await doFetch(
    url,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    timeoutMs,
    requestSummary,
  );
  const json = await parseJsonSafe(res);
  throwIfGraphError(json, res.status, requestSummary);
  if (!res.ok) {
    throw new GraphApiError(
      { message: `HTTP ${res.status} with no Graph error body`, type: '', code: 0 },
      res.status,
      requestSummary,
    );
  }
  return { data: json as T, requestSummary };
}

export async function graphPostMultipart<T>(
  config: OfferGuardConfig,
  path: string,
  form: FormData,
  formSummary: string,
  options: GraphCallOptions = {},
): Promise<GraphResult<T>> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const { url, summary } = buildUrl(config, path, {});
  const requestSummary = `POST ${summary} multipart(${formSummary})`;
  const res = await doFetch(url, { method: 'POST', body: form }, timeoutMs, requestSummary);
  const json = await parseJsonSafe(res);
  throwIfGraphError(json, res.status, requestSummary);
  if (!res.ok) {
    throw new GraphApiError(
      { message: `HTTP ${res.status} with no Graph error body`, type: '', code: 0 },
      res.status,
      requestSummary,
    );
  }
  return { data: json as T, requestSummary };
}

export async function graphDelete<T>(
  config: OfferGuardConfig,
  path: string,
  options: GraphCallOptions = {},
): Promise<GraphResult<T>> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const { url, summary } = buildUrl(config, path, {});
  const requestSummary = `DELETE ${summary}`;
  const res = await doFetch(url, { method: 'DELETE' }, timeoutMs, requestSummary);
  const json = await parseJsonSafe(res);
  throwIfGraphError(json, res.status, requestSummary);
  if (!res.ok) {
    throw new GraphApiError(
      { message: `HTTP ${res.status} with no Graph error body`, type: '', code: 0 },
      res.status,
      requestSummary,
    );
  }
  return { data: json as T, requestSummary };
}
