import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { chromium, type Browser } from 'playwright';
import type { AdLanguage } from '../../shared/schemas.js';

/**
 * Minimal browser-document shapes for page.evaluate callbacks only (this
 * module is otherwise DOM-free server code). At runtime these closures run
 * inside Chromium, where the real document exists.
 */
interface PageElement {
  tagName: string;
  children: { length: number };
  textContent: string | null;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
}
declare const document: {
  title: string;
  body: { innerText: string; querySelectorAll(sel: string): PageElement[] } | null;
  documentElement: { querySelectorAll(sel: string): PageElement[] };
  fonts: { ready: Promise<unknown> };
};
declare const window: {
  scrollTo(x: number, y: number): void;
  scrollX: number;
  scrollY: number;
};
declare function getComputedStyle(el: PageElement): { visibility: string; display: string };

export const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2 } as const;
export const TIMEZONE = 'Asia/Jerusalem';
export const DEFAULT_CAPTURE_TIMEOUT_MS = 15_000;
export const MAX_SECTIONS = 3;
export const MAX_CHUNKS = 500;

/** Default allowlist when OFFER_GUARD_ALLOWED_HOSTS is unset: loopback only. */
export const DEFAULT_ALLOWED_HOSTS = ['127.0.0.1'];

/** Parse OFFER_GUARD_ALLOWED_HOSTS (comma-separated) or fall back to loopback only. */
export function parseAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.OFFER_GUARD_ALLOWED_HOSTS ?? '').trim();
  if (!raw) return [...DEFAULT_ALLOWED_HOSTS];
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
}

export class CaptureError extends Error {
  /** True for guard blocks (bad URL / DNS / redirect), false for load/timeout/challenge failures. */
  readonly blocked: boolean;
  readonly reason: string;
  constructor(reason: string, blocked: boolean, options?: { cause?: unknown }) {
    super(reason);
    this.name = 'CaptureError';
    this.reason = reason;
    this.blocked = blocked;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

export function isHostAllowlisted(hostname: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((h) => normalizeHost(h) === normalizeHost(hostname));
}

/** Sync URL check: http(s) only + host exactly on the allowlist. Returns the parsed URL. */
export function assertUrlAllowed(urlString: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new CaptureError(`not a valid URL: ${JSON.stringify(urlString)}`, true);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CaptureError(`only http(s) URLs are allowed, got ${url.protocol}`, true);
  }
  if (!isHostAllowlisted(url.hostname, allowedHosts)) {
    throw new CaptureError(`host not on the allowlist: ${url.hostname}`, true);
  }
  return url;
}

function ipv4Bytes(addr: string): [number, number, number, number] | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums as [number, number, number, number];
}

function inCidr4(b: [number, number, number, number], base: [number, number, number, number], prefix: number): boolean {
  const toInt = (x: [number, number, number, number]): number =>
    ((x[0] * 256 + x[1]) * 256 + x[2]) * 256 + x[3];
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((toInt(b) & mask) >>> 0) === ((toInt(base) & mask) >>> 0);
}

function isRiskyIPv4(addr: string): boolean {
  const b = ipv4Bytes(addr);
  if (!b) return true; // unparseable: fail closed
  // Everything that is not public unicast: "this" net, privates, CGNAT,
  // loopback, link-local (incl. the cloud metadata IP), multicast+, broadcast.
  const risky: Array<[[number, number, number, number], number]> = [
    [[0, 0, 0, 0], 8],
    [[10, 0, 0, 0], 8],
    [[100, 64, 0, 0], 10],
    [[127, 0, 0, 0], 8],
    [[169, 254, 0, 0], 16],
    [[172, 16, 0, 0], 12],
    [[192, 168, 0, 0], 16],
    [[224, 0, 0, 0], 4],
    [[255, 255, 255, 255], 32],
  ];
  return risky.some(([base, prefix]) => inCidr4(b, base, prefix));
}

function expandIPv6(addr: string): number[] | null {
  // Split a possible embedded IPv4 tail (e.g. ::ffff:1.2.3.4).
  let tail: number[] = [];
  const v4match = addr.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  let head = addr;
  if (v4match?.[1]) {
    const b = ipv4Bytes(v4match[1]);
    if (!b) return null;
    tail = [(b[0] * 256 + b[1]) as number, (b[2] * 256 + b[3]) as number];
    head = addr.slice(0, addr.length - v4match[1].length);
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const left = parse(halves[0] ?? '');
  const right = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (!left || !right) return null;
  const zeros = 8 - tail.length - left.length - right.length;
  if (halves.length === 1 ? zeros !== 0 : zeros < 0) return null;
  return [...left, ...new Array(halves.length === 1 ? 0 : zeros).fill(0), ...right, ...tail];
}

function isRiskyIPv6(addr: string): boolean {
  const g = expandIPv6(addr.toLowerCase());
  if (!g || g.length !== 8) return true; // unparseable: fail closed
  const first = g[0] as number;
  // ::1/128 loopback, ::/128 unspecified, fe80::/10 link-local,
  // fc00::/7 unique-local, ff00::/8 multicast.
  if (g.every((x) => x === 0)) return true;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xff00) === 0xff00) return true;
  // ::ffff:0:0/96 IPv4-mapped: judge the embedded IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const a = g[6] as number;
    const b = g[7] as number;
    return isRiskyIPv4(`${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`);
  }
  return false;
}

/** True for loopback / private / link-local / metadata / multicast / unparseable IPs. */
export function isRiskyIp(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) return isRiskyIPv4(addr);
  if (family === 6) return isRiskyIPv6(addr);
  return true;
}

/**
 * DNS guard: resolve the host and block risky IPs (private/loopback/
 * link-local/metadata) unless the exact host string is allowlisted.
 * Unknown hosts fail closed.
 */
export async function assertDnsAllowed(hostname: string, allowedHosts: readonly string[]): Promise<void> {
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch (err) {
    throw new CaptureError(`DNS lookup failed for ${hostname}`, true, { cause: err });
  }
  if (addrs.length === 0) throw new CaptureError(`DNS lookup returned no addresses for ${hostname}`, true);
  const exactListed = allowedHosts.some((h) => normalizeHost(h) === normalizeHost(hostname));
  for (const a of addrs) {
    if (isRiskyIp(a.address) && !exactListed) {
      throw new CaptureError(`DNS for ${hostname} resolves to blocked address ${a.address}`, true);
    }
  }
}

export interface TextChunk {
  id: string;
  text: string;
  bounds: { x: number; y: number; w: number; h: number };
}

export interface PageCaptureResult {
  requestedUrl: string;
  finalUrl: string;
  captureTime: string;
  lang: AdLanguage;
  screenshots: Buffer[];
  chunks: TextChunk[];
}

interface RawChunk {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const CHALLENGE_PATTERNS = [/captcha/i, /just a moment/i, /attention required/i, /verify you are (a )?human/i];

export interface CaptureServiceOptions {
  allowedHosts: readonly string[];
  timeoutMs?: number;
}

/**
 * One shared Chromium instance serving captures serially (concurrency 1).
 * The browser never sees Meta credentials; it only GETs allowlisted pages —
 * no downloads, no form submit, no login.
 */
export class CaptureService {
  private browser: Browser | null = null;
  private readonly allowedHosts: readonly string[];
  private readonly timeoutMs: number;

  constructor(options: CaptureServiceOptions) {
    this.allowedHosts = options.allowedHosts;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    if (!this.browser) this.browser = await chromium.launch();
  }

  async stop(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  get started(): boolean {
    return this.browser !== null;
  }

  async capture(urlString: string, lang: AdLanguage): Promise<PageCaptureResult> {
    const url = assertUrlAllowed(urlString, this.allowedHosts);
    await assertDnsAllowed(url.hostname, this.allowedHosts);
    if (!this.browser) throw new Error('CaptureService not started (call start() first)');

    const deadline = Date.now() + this.timeoutMs;
    const remaining = (): number => Math.max(1, deadline - Date.now());
    const context = await this.browser.newContext({
      viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
      deviceScaleFactor: VIEWPORT.deviceScaleFactor,
      locale: lang === 'he' ? 'he-IL' : 'en-US',
      timezoneId: TIMEZONE,
    });
    try {
      // Redirect + subresource guard: only http(s) to allowlisted hosts loads.
      // A redirect off the allowlist aborts the navigation → CAPTURE_FAILED.
      await context.route('**/*', (route) => {
        const reqUrl = route.request().url();
        try {
          const u = new URL(reqUrl);
          if ((u.protocol === 'http:' || u.protocol === 'https:') && isHostAllowlisted(u.hostname, this.allowedHosts)) {
            void route.continue();
          } else {
            void route.abort();
          }
        } catch {
          void route.abort();
        }
      });
      const page = await context.newPage();
      try {
        try {
          await page.goto(urlString, { waitUntil: 'load', timeout: remaining() });
        } catch (err) {
          throw new CaptureError(`navigation failed: ${err instanceof Error ? err.message : String(err)}`, false, { cause: err });
        }
        try {
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          await page.waitForTimeout(Math.min(500, remaining()));
        } catch (err) {
          throw new CaptureError(`page settle timed out: ${err instanceof Error ? err.message : String(err)}`, false, { cause: err });
        }

        const finalUrl = page.url();
        try {
          assertUrlAllowed(finalUrl, this.allowedHosts);
        } catch (err) {
          throw new CaptureError(`redirect left the allowlist (final URL ${finalUrl})`, true, { cause: err });
        }

        // Consent wall / bot challenge heuristics: known challenge markers in
        // the title or first-viewport text mean there is no offer to read.
        const probe = await page.evaluate(() => ({
          title: document.title ?? '',
          sample: (document.body?.innerText ?? '').slice(0, 2000),
        }));
        if (CHALLENGE_PATTERNS.some((p) => p.test(probe.title) || p.test(probe.sample))) {
          throw new CaptureError('page shows a bot challenge or consent wall', false);
        }

        await page.evaluate(() => window.scrollTo(0, 0));
        const raw = (await page.evaluate(collectChunks)) as RawChunk[];
        const chunks = assignChunkIds(raw);

        const screenshots: Buffer[] = [];
        screenshots.push(await page.screenshot({ type: 'png', timeout: remaining() }));
        for (let section = 1; section < MAX_SECTIONS; section++) {
          const y = section * VIEWPORT.height;
          const scrolled = await page.evaluate((target: number) => {
            window.scrollTo(0, target);
            return window.scrollY;
          }, y);
          if (scrolled < y - 1) break; // bottom reached
          await page.waitForTimeout(Math.min(250, remaining()));
          screenshots.push(await page.screenshot({ type: 'png', timeout: remaining() }));
        }

        return {
          requestedUrl: urlString,
          finalUrl,
          captureTime: new Date().toISOString(),
          lang,
          screenshots,
          chunks,
        };
      } finally {
        await page.close();
      }
    } finally {
      await context.close();
    }
  }
}

/**
 * Runs inside the page: collects visible leaf-element text with page-coordinate
 * bounds. Skips script/style/hidden/zero-size content. No raw HTML leaves the page.
 */
function collectChunks(): RawChunk[] {
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'SVG', 'CANVAS', 'HEAD']);
  const out: RawChunk[] = [];
  const root = document.body ?? document.documentElement;
  const els = root.querySelectorAll('*');
  for (const el of els) {
    if (skip.has(el.tagName)) continue;
    if (el.children.length > 0) continue;
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
    if (!text) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    out.push({
      text,
      x: Math.round((r.x + window.scrollX) * 10) / 10,
      y: Math.round((r.y + window.scrollY) * 10) / 10,
      w: Math.round(r.width * 10) / 10,
      h: Math.round(r.height * 10) / 10,
    });
    // Literal cap: this closure is serialized into the page, so module-level
    // constants (e.g. MAX_CHUNKS) are NOT visible here. Keep in sync.
    if (out.length >= 500) break;
  }
  return out;
}

/** Dedupe identical text+bounds pairs, then number chunks c1..cn in order. */
export function assignChunkIds(raw: RawChunk[]): TextChunk[] {
  const seen = new Set<string>();
  const chunks: TextChunk[] = [];
  for (const r of raw) {
    const key = `${r.text}\n${r.x},${r.y},${r.w},${r.h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chunks.push({ id: `c${chunks.length + 1}`, text: r.text, bounds: { x: r.x, y: r.y, w: r.w, h: r.h } });
  }
  return chunks;
}
