/**
 * Local dev server. Emulates just enough of Vercel's (req, res) contract to
 * exercise the real handlers — so what passes here is what deploys.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const PORT = process.env.PORT || 3000;
const PUBLIC = new URL('../public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };

/** Vercel gives handlers res.status().end(); Node's ServerResponse does not. */
function shim(res) {
  res.status = code => { res.statusCode = code; return res; };
  return res;
}

const server = createServer(async (req, res) => {
  shim(res);
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice(5).replace(/[^a-z0-9_-]/gi, '');
    try {
      const mod = await import(`../api/${name}.js?t=${Date.now()}`);
      await mod.default(req, res);
    } catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND') {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `No such endpoint: /api/${name}` }));
      } else {
        console.error(e);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e.message, stack: e.stack?.split('\n').slice(0, 4) }));
      }
    }
    return;
  }

  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  try {
    const body = await readFile(join(PUBLIC, file));
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
});

server.listen(PORT, () => console.log(`assay dev → http://localhost:${PORT}`));
