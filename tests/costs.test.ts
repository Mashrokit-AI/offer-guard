import { describe, expect, it } from 'vitest';
import { CostLedger, costFor, modelKind, overDailyCaps } from '../src/server/models/costs.js';

describe('cost ledger', () => {
  it('classifies model ids into kinds', () => {
    expect(modelKind('muse-wonder-1.0')).toBe('wonder');
    expect(modelKind('muse-spark-1.3')).toBe('spark');
    expect(modelKind('sam-3.1')).toBe('sam');
    expect(modelKind('muse-image-1.0')).toBe('image');
  });

  it('prices tokens at list price', () => {
    // Wonder: 1000 in + 1000 out = 0.004 + 0.02.
    expect(costFor('muse-wonder-1.0', { inputTokens: 1000, outputTokens: 1000 })).toBeCloseTo(0.024, 9);
    // Spark: 1M in + 1M out = 1.25 + 4.25.
    expect(costFor('muse-spark-1.3', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(5.5, 9);
    // SAM: 2 images = 2 * 0.0025.
    expect(costFor('sam-3.1', { images: 2 })).toBeCloseTo(0.005, 9);
    // Image: 3 images = $0.03.
    expect(costFor('muse-image-1.0', { images: 3 })).toBeCloseTo(0.03, 9);
  });

  it('totals a session and stops Wonder past $25', () => {
    const ledger = new CostLedger(25);
    expect(ledger.wonderStopped()).toBe(false);
    ledger.record('muse-spark-1.3', { inputTokens: 100_000, outputTokens: 10_000 }, 'analyze');
    ledger.record('muse-image-1.0', { images: 3 }, 'plates');
    const t = ledger.totals();
    expect(t.entries).toBe(2);
    expect(t.sparkUsd).toBeGreaterThan(0);
    expect(t.imageUsd).toBeCloseTo(0.03, 9);
    expect(ledger.wonderStopped()).toBe(false);
    // A huge Wonder call pushes the session over the cap ($4 + $40).
    ledger.record('muse-wonder-1.0', { inputTokens: 1_000_000, outputTokens: 2_000_000 }, 'plan');
    expect(ledger.wonderStopped()).toBe(true);
  });

  it('checks daily caps from ledger totals', () => {
    expect(overDailyCaps({ totalUsd: 1, wonderUsd: 1 }, { wonderDailyUsd: 3, dailyUsd: 8 })).toEqual({
      wonderOver: false,
      allOver: false,
    });
    expect(overDailyCaps({ totalUsd: 2, wonderUsd: 3 }, { wonderDailyUsd: 3, dailyUsd: 8 }).wonderOver).toBe(true);
    expect(overDailyCaps({ totalUsd: 8, wonderUsd: 0 }, { wonderDailyUsd: 3, dailyUsd: 8 }).allOver).toBe(true);
  });
});
