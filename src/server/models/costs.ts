/**
 * Model API cost ledger. List prices (USD):
 * - Wonder (muse-wonder-1.0): $4 / 1M input tokens, $20 / 1M output tokens
 * - Spark (muse-spark-*): $1.25 / 1M in, $4.25 / 1M out
 * - SAM (sam-*): $2.50 per 1000 images (one segment call = one image)
 * - Muse Image: $0.01 per image
 *
 * Real usage comes from API responses (usage.input_tokens/output_tokens);
 * image/SAM costs are per call. The ledger is the single place that turns
 * usage into dollars — the session $25 stop rule and the daily public caps
 * (ADFIT_WONDER_DAILY_USD / ADFIT_DAILY_USD) both read from it.
 */

export const PRICE = {
  wonderInPerM: 4,
  wonderOutPerM: 20,
  sparkInPerM: 1.25,
  sparkOutPerM: 4.25,
  samPerImage: 2.5 / 1000,
  imagePerImage: 0.01,
} as const;

export type LedgerModel = 'wonder' | 'spark' | 'sam' | 'image';

export interface LedgerEntry {
  at: string;
  model: LedgerModel;
  /** Model id as called, e.g. "muse-wonder-1.0". */
  modelId: string;
  label: string;
  inputTokens: number | null;
  outputTokens: number | null;
  images: number | null;
  costUsd: number;
}

export function modelKind(modelId: string): LedgerModel {
  const m = modelId.toLowerCase();
  if (m.includes('wonder')) return 'wonder';
  if (m.includes('sam')) return 'sam';
  if (m.includes('image')) return 'image';
  return 'spark';
}

function tokensCost(kind: LedgerModel, inputTokens: number | null, outputTokens: number | null): number {
  const i = inputTokens ?? 0;
  const o = outputTokens ?? 0;
  if (kind === 'wonder') return (i * PRICE.wonderInPerM + o * PRICE.wonderOutPerM) / 1_000_000;
  if (kind === 'spark') return (i * PRICE.sparkInPerM + o * PRICE.sparkOutPerM) / 1_000_000;
  return 0;
}

export function costFor(
  modelId: string,
  usage: { inputTokens?: number | null; outputTokens?: number | null; images?: number | null },
): number {
  const kind = modelKind(modelId);
  if (kind === 'sam') return (usage.images ?? 1) * PRICE.samPerImage;
  if (kind === 'image') return (usage.images ?? 1) * PRICE.imagePerImage;
  return tokensCost(kind, usage.inputTokens ?? null, usage.outputTokens ?? null);
}

export interface LedgerTotals {
  totalUsd: number;
  wonderUsd: number;
  sparkUsd: number;
  samUsd: number;
  imageUsd: number;
  entries: number;
}

/** In-memory session ledger with a hard Wonder stop rule. */
export class CostLedger {
  private readonly entries: LedgerEntry[] = [];
  /** Session cap for Wonder calls (USD). Default 25. */
  sessionCapUsd: number;

  constructor(sessionCapUsd = 25) {
    this.sessionCapUsd = sessionCapUsd;
  }

  record(
    modelId: string,
    usage: { inputTokens?: number | null; outputTokens?: number | null; images?: number | null },
    label: string,
  ): LedgerEntry {
    const entry: LedgerEntry = {
      at: new Date().toISOString(),
      model: modelKind(modelId),
      modelId,
      label,
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      images: usage.images ?? null,
      costUsd: costFor(modelId, usage),
    };
    this.entries.push(entry);
    return entry;
  }

  all(): LedgerEntry[] {
    return [...this.entries];
  }

  totals(): LedgerTotals {
    const t: LedgerTotals = { totalUsd: 0, wonderUsd: 0, sparkUsd: 0, samUsd: 0, imageUsd: 0, entries: this.entries.length };
    for (const e of this.entries) {
      t.totalUsd += e.costUsd;
      if (e.model === 'wonder') t.wonderUsd += e.costUsd;
      else if (e.model === 'spark') t.sparkUsd += e.costUsd;
      else if (e.model === 'sam') t.samUsd += e.costUsd;
      else t.imageUsd += e.costUsd;
    }
    return t;
  }

  totalUsd(): number {
    return this.totals().totalUsd;
  }

  /** True once the session ledger passes the cap: stop calling Wonder. */
  wonderStopped(): boolean {
    return this.totalUsd() > this.sessionCapUsd;
  }

  toJSON(): { sessionCapUsd: number; totals: LedgerTotals; entries: LedgerEntry[] } {
    return { sessionCapUsd: this.sessionCapUsd, totals: this.totals(), entries: this.all() };
  }
}

/** Daily-cap check against ledger totals (fake-ledger friendly for tests). */
export function overDailyCaps(
  totals: Pick<LedgerTotals, 'totalUsd' | 'wonderUsd'>,
  caps: { wonderDailyUsd: number; dailyUsd: number },
): { wonderOver: boolean; allOver: boolean } {
  return {
    wonderOver: totals.wonderUsd >= caps.wonderDailyUsd,
    allOver: totals.totalUsd >= caps.dailyUsd,
  };
}
