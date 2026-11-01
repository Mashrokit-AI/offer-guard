import type { Msg, Bbox } from './lib.js';

export interface SpecDto {
  version: number;
  percent: number | null;
  scope: string;
  shipping: string;
  dayMonth: string | null;
  validFull: string | null;
}

export interface CampaignAd {
  id: number;
  adKey: string;
  ad: string;
  lang: string;
  thumb: string;
  verdict: string;
  reason: Msg;
  cached: boolean;
  captureTime: string;
}

export interface Campaign {
  spec: SpecDto;
  run: {
    id: number;
    mode: 'fresh' | 'cached';
    startedAt: string;
    finishedAt: string | null;
    countsByVerdict: Record<string, number>;
    countsByLang: Record<string, number>;
  };
  ads: CampaignAd[];
}

export interface Comparison {
  field: string;
  ad: string;
  page: string;
  spec: string;
  adObserved: string;
  pageObserved: string;
}

export interface Finding {
  kind: string;
  side: string | null;
  field: string | null;
  key: string;
  vars: Record<string, string>;
}

export interface TraceEvent {
  seq: number;
  step: string;
  tool: string;
  input: string;
  output: string;
  durationMs: number;
  evidence: string[];
  next: string;
  cached: boolean;
}

export interface AdDetail {
  snapshot: {
    id: number;
    adKey: string;
    ad: string;
    lang: string;
    verdict: string;
    cached: boolean;
    captureTime: string;
    copy: string;
    landingUrl: string;
  };
  spec: SpecDto;
  adClaims: {
    hasGeometry: boolean;
    language: string;
    discount: { percent: number | null; scope: string; verbatim: string };
    shipping: { terms: string; verbatim: string };
    validUntil: { dayMonth: string | null; verbatim: string };
    offerTexts: Array<{ text: string; bbox: Bbox; inPanel: boolean }>;
    panel: { bbox: Bbox; opaque: boolean } | null;
    productBbox: Bbox | null;
    logoBbox: Bbox | null;
  } | null;
  pageClaims: {
    discount: { percent: number | null; scope: string; verbatim: string };
    shipping: { terms: string; verbatim: string };
    validUntil: { dayMonth: string | null; verbatim: string };
    quotes: Array<{ text: string; chunkIds: string[] }>;
    chunks: Array<{ id: string; text: string; bounds: Bbox }>;
    shots: number;
    pageFile: string | null;
  } | null;
  comparisons: Comparison[];
  findings: Finding[];
  explain: Msg;
  question: Msg | null;
  repair: {
    digest: string;
    specVersion: number;
    proof: { changed_outside_rect: number; changed_inside_protected: number; max_channel_diff_outside: number; pass: boolean };
    revalidation: {
      pass: boolean;
      checks: Array<{ check: string; pass: boolean; detail: string }>;
      claims?: { percent: number | null; scope: string; shipping: string; valid: string | null };
    };
    rect: Bbox | null;
    hasMasks: boolean;
    hasDiff: boolean;
  } | null;
  refusal: { blockers: Msg[]; hasMasks: boolean } | null;
  trace: TraceEvent[];
}

export interface JobSummary {
  id: string;
  kind: 'fresh' | 'check';
  status: 'queued' | 'running' | 'done' | 'failed';
  total: number;
  done: number;
  rows: Array<{ ad: string; lang: string; got: string; cached: boolean }>;
  snapshotId?: number;
  cached?: boolean;
  error?: string;
}
