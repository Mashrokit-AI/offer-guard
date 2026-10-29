import { describe, expect, it } from 'vitest';
import { PAUSED_STATUS, assertOnlyPaused } from '../src/shared/guards.js';

describe('assertOnlyPaused', () => {
  it('accepts exactly PAUSED', () => {
    expect(() => assertOnlyPaused({ status: 'PAUSED' }, 'test')).not.toThrow();
    expect(PAUSED_STATUS).toBe('PAUSED');
  });

  it('refuses ACTIVE', () => {
    expect(() => assertOnlyPaused({ status: 'ACTIVE' }, 'ad creation')).toThrow(/must be "PAUSED"/);
  });

  it('refuses ARCHIVED and DELETED', () => {
    expect(() => assertOnlyPaused({ status: 'ARCHIVED' }, 'ad creation')).toThrow(/must be "PAUSED"/);
    expect(() => assertOnlyPaused({ status: 'DELETED' }, 'ad creation')).toThrow(/must be "PAUSED"/);
  });

  it('refuses a missing or lowercase status', () => {
    expect(() => assertOnlyPaused({}, 'ad creation')).toThrow(/must be "PAUSED"/);
    expect(() => assertOnlyPaused({ status: 'paused' }, 'ad creation')).toThrow(/must be "PAUSED"/);
  });
});
