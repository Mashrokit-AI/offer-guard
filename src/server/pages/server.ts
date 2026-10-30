import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

export interface PagesServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Minimal local static file server for the demo landing pages (and tests).
 * GET/HEAD only, no directory listing, no dotfiles, no path escape.
 */
export async function startPagesServer(rootDir: string, host = '127.0.0.1', port = 0): Promise<PagesServer> {
  const server: Server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain' });
        res.end('method not allowed');
        return;
      }
      const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
      let rel = normalize(decodeURIComponent(rawPath)).replace(/^(\.\.[/\\])+/, '');
      rel = rel.replace(/^[/\\]+/, '');
      if (!rel || rel.includes('..') || rel.split(sep).some((p) => p.startsWith('.'))) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      const file = join(rootDir, rel);
      const st = await stat(file).catch(() => null);
      if (!st || !st.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      const ext = rel.toLowerCase().slice(rel.lastIndexOf('.'));
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(await readFile(file));
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('error');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    baseUrl: `http://${host}:${actualPort}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
