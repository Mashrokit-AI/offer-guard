import { describe, expect, it } from 'vitest';
import { maskSecret, redactText, redactUrl } from '../src/shared/masking.js';

describe('maskSecret', () => {
  it('keeps only a short prefix and suffix of a long token', () => {
    const token = 'EAAJKL1234567890abcdef';
    const masked = maskSecret(token);
    expect(masked).toBe('EAAJ...cdef');
    expect(masked).not.toContain('1234567890');
    expect(token).toContain('1234567890'); // sanity: the middle existed in the input
  });

  it('fully masks short, empty, or missing values', () => {
    expect(maskSecret('short')).toBe('***');
    expect(maskSecret('12345678')).toBe('***');
    expect(maskSecret('')).toBe('***');
    expect(maskSecret(undefined)).toBe('***');
    expect(maskSecret(null)).toBe('***');
  });
});

describe('redactUrl', () => {
  it('strips the access_token query value but keeps the rest of the URL', () => {
    const url = 'https://graph.facebook.com/v25.0/me?fields=id&access_token=SECRET123&limit=5';
    const redacted = redactUrl(url);
    expect(redacted).not.toContain('SECRET123');
    expect(redacted).toContain('access_token=***');
    expect(redacted).toContain('fields=id');
  });

  it('leaves URLs without a token untouched', () => {
    const url = 'https://graph.facebook.com/v25.0/me?fields=id';
    expect(redactUrl(url)).toBe(url);
  });
});

describe('redactText', () => {
  it('replaces known secrets with their masks', () => {
    const token = 'EAAJKL1234567890abcdef';
    const text = `POST /ads with token=${token} done`;
    const redacted = redactText(text, [token]);
    expect(redacted).not.toContain(token);
    expect(redacted).toContain(maskSecret(token));
  });
});
