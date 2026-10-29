import { describe, expect, it } from 'vitest';
import {
  OPT_OUT_REJECTION_SUBCODE,
  isOptOutRejection,
  parseProbeArgs,
} from '../src/server/meta/probe.js';

// Obviously fake image hash for tests (32 hex chars, not a real upload).
const FAKE_HASH = 'abcdef0123456789abcdef0123456789';

describe('isOptOutRejection', () => {
  it('matches the opt-out subcode regardless of message language', () => {
    expect(OPT_OUT_REJECTION_SUBCODE).toBe(3858504);
    // Localized (Hebrew) user message carries no English field names; only the subcode matters.
    expect(isOptOutRejection({ code: 100, error_subcode: 3858504 }, true)).toBe(true);
    expect(isOptOutRejection({ code: 100, error_subcode: 3858504 }, false)).toBe(true);
  });

  it('falls back to code 100 when the request contained degrees_of_freedom_spec', () => {
    expect(isOptOutRejection({ code: 100 }, true)).toBe(true);
  });

  it('rejects other code-100 errors when the request had no degrees_of_freedom_spec', () => {
    expect(isOptOutRejection({ code: 100 }, false)).toBe(false);
    expect(isOptOutRejection({ code: 100, error_subcode: 1234567 }, false)).toBe(false);
  });

  it('rejects unrelated error codes', () => {
    expect(isOptOutRejection({ code: 200, error_subcode: 3858504 }, true)).toBe(true);
    expect(isOptOutRejection({ code: 1 }, true)).toBe(false);
    expect(isOptOutRejection({ code: 0 }, false)).toBe(false);
  });
});

describe('parseProbeArgs', () => {
  it('defaults to dry-run with no image hash', () => {
    expect(parseProbeArgs([])).toEqual({ mode: 'dry-run', imageHash: undefined, help: false });
  });

  it('parses --execute', () => {
    expect(parseProbeArgs(['--execute'])).toEqual({ mode: 'execute', imageHash: undefined, help: false });
  });

  it('parses --image-hash with a valid 32-hex-char hash', () => {
    expect(parseProbeArgs(['--image-hash', FAKE_HASH])).toEqual({
      mode: 'dry-run',
      imageHash: FAKE_HASH,
      help: false,
    });
    expect(parseProbeArgs(['--execute', `--image-hash=${FAKE_HASH}`])).toEqual({
      mode: 'execute',
      imageHash: FAKE_HASH,
      help: false,
    });
  });

  it('accepts uppercase hex in the hash', () => {
    const upper = FAKE_HASH.toUpperCase();
    expect(parseProbeArgs(['--image-hash', upper]).imageHash).toBe(upper);
  });

  it('rejects an invalid image hash', () => {
    expect(() => parseProbeArgs(['--image-hash', 'xyz'])).toThrow(/32 hex/);
    expect(() => parseProbeArgs(['--image-hash', 'abcdef0123456789abcdef012345678'])).toThrow(/32 hex/);
    expect(() => parseProbeArgs(['--image-hash', `${FAKE_HASH}9`])).toThrow(/32 hex/);
    expect(() => parseProbeArgs(['--image-hash', 'zz'.padEnd(32, '0')])).toThrow(/32 hex/);
  });

  it('rejects a missing hash value', () => {
    expect(() => parseProbeArgs(['--image-hash'])).toThrow(/requires a value/);
    expect(() => parseProbeArgs(['--image-hash='])).toThrow(/requires a value/);
  });

  it('rejects unknown flags', () => {
    expect(() => parseProbeArgs(['--bogus'])).toThrow(/Unknown flag/);
    expect(() => parseProbeArgs(['--execute', 'extra'])).toThrow(/Unknown flag/);
  });

  it('reports --help and -h', () => {
    expect(parseProbeArgs(['--help']).help).toBe(true);
    expect(parseProbeArgs(['-h']).help).toBe(true);
  });
});
