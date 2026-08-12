// Minimal static server for local testing.
//
// Not part of the app. The app is plain static files and needs no server in
// production. This exists so `npm run serve` works with nothing installed, and
// so the browser test has an http origin (ES modules and WASM will not load
// from file:// in Chrome).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(process.cwd());
const PORT = Number(process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.traineddata': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = join(ROOT, normalize(url === '/' ? '/index.html' : url));

    // Contain the server to ROOT. normalize() has already collapsed any
    // traversal, so a prefix check is enough.
    if (file !== ROOT && !file.startsWith(ROOT + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => {
  console.log(`serving ${ROOT} on http://localhost:${PORT}`);
});
