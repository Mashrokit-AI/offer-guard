import { describe, expect, it } from 'vitest';
import {
  CaptureError,
  assignChunkIds,
  assertDnsAllowed,
  assertUrlAllowed,
  isRiskyIp,
  parseAllowedHosts,
} from '../src/server/browser/capture.js';

describe('allowed-hosts config', () => {
  it('defaults to loopback only when unset', () => {
    expect(parseAllowedHosts({})).toEqual(['127.0.0.1']);
    expect(parseAllowedHosts({ OFFER_GUARD_ALLOWED_HOSTS: '  ' })).toEqual(['127.0.0.1']);
  });

  it('parses a comma-separated list, trimmed + lowercased', () => {
    expect(parseAllowedHosts({ OFFER_GUARD_ALLOWED_HOSTS: ' Example.COM ,127.0.0.1,' })).toEqual([
      'example.com',
      '127.0.0.1',
    ]);
  });
});

describe('URL guard', () => {
  const allow = ['127.0.0.1', 'example.com'];

  it('accepts http(s) URLs on the allowlist', () => {
    expect(assertUrlAllowed('http://127.0.0.1:8080/gali-offer-he.html', allow).hostname).toBe('127.0.0.1');
    expect(assertUrlAllowed('https://example.com/x', allow).hostname).toBe('example.com');
  });

  it('matches hosts case-insensitively', () => {
    expect(assertUrlAllowed('https://EXAMPLE.com/x', allow).hostname).toBe('example.com');
  });

  it('rejects non-http(s) schemes', () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)', 'data:text/plain,hi']) {
      expect(() => assertUrlAllowed(u, allow)).toThrowError(CaptureError);
    }
  });

  it('rejects hosts off the allowlist (exact match, no subdomains)', () => {
    for (const u of ['https://evil.com/', 'https://sub.example.com/', 'https://example.com.evil.com/']) {
      expect(() => assertUrlAllowed(u, allow)).toThrowError(/allowlist/);
    }
  });

  it('rejects malformed URLs', () => {
    expect(() => assertUrlAllowed('not a url', allow)).toThrowError(CaptureError);
  });
});

describe('risky-IP classifier', () => {
  it.each([
    '127.0.0.1',
    '127.0.0.2',
    '10.0.0.5',
    '172.16.4.9',
    '172.31.255.1',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.1.2.3',
  ])('blocks %s', (ip) => {
    expect(isRiskyIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '192.167.1.1', '2001:4860:4860::8888'])(
    'allows public %s',
    (ip) => {
      expect(isRiskyIp(ip)).toBe(false);
    },
  );

  it('fails closed on garbage', () => {
    expect(isRiskyIp('999.1.1.1')).toBe(true);
    expect(isRiskyIp('not-an-ip')).toBe(true);
  });
});

describe('DNS guard', () => {
  it('allows an exact-allowlisted loopback host (IP literals need no DNS)', async () => {
    await assertDnsAllowed('127.0.0.1', ['127.0.0.1']);
  });

  it('blocks a risky IP that is not exactly allowlisted', async () => {
    await expect(assertDnsAllowed('127.0.0.1', ['example.com'])).rejects.toThrowError(CaptureError);
    await expect(assertDnsAllowed('10.1.2.3', ['10.1.2.3', 'example.com'])).resolves.toBeUndefined();
  });

  it('allows a public IP on the allowlist', async () => {
    await assertDnsAllowed('8.8.8.8', ['8.8.8.8']);
  });

  it('fails closed on unresolvable hosts', async () => {
    await expect(assertDnsAllowed('nonexistent.invalid', ['nonexistent.invalid'])).rejects.toThrowError(CaptureError);
  });
});

describe('chunk ids', () => {
  it('dedupes identical text+bounds and numbers c1..cn', () => {
    const chunks = assignChunkIds([
      { text: 'a', x: 0, y: 0, w: 1, h: 1 },
      { text: 'a', x: 0, y: 0, w: 1, h: 1 },
      { text: 'b', x: 0, y: 5, w: 1, h: 1 },
    ]);
    expect(chunks.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(chunks[1]?.text).toBe('b');
  });
});
