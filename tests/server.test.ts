import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startPagesServer } from '../src/server/pages/server.js';

async function get(url: string, method = 'GET'): Promise<{ status: number; body: string; contentType: string | null }> {
  const res = await fetch(url, { method });
  const body = method === 'HEAD' ? '' : await res.text();
  return { status: res.status, body, contentType: res.headers.get('content-type') };
}

describe('pages static server', () => {
  it('serves files, 404s the rest, allows only GET/HEAD', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'og-pages-'));
    writeFileSync(join(dir, 'gali-offer-he.html'), '<html>שלום</html>');
    const server = await startPagesServer(dir);
    try {
      expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const ok = await get(`${server.baseUrl}/gali-offer-he.html`);
      expect(ok.status).toBe(200);
      expect(ok.body).toContain('שלום');
      expect(ok.contentType).toContain('text/html');
      expect((await get(`${server.baseUrl}/missing.html`)).status).toBe(404);
      expect((await get(`${server.baseUrl}/../secret`)).status).toBe(404);
      expect((await get(`${server.baseUrl}/gali-offer-he.html`, 'POST')).status).toBe(405);
      expect((await get(`${server.baseUrl}/gali-offer-he.html`, 'HEAD')).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
