// Dev harness: serves the extension's pages as a normal website with a fake `chrome` API
// (dev/shim.js) so the UI can be worked on in any browser. Calls to the helper are proxied
// through /api with the real token, so downloads and recordings are real.
//   node dev/harness-server.js   ->  http://localhost:47400/popup.html?url=<video url>
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'helper', 'config.json'), 'utf8').replace(/^﻿/, ''));
const PORT = Number(process.env.PORT) || 47400;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith('/api/')) {
    if (url.searchParams.has('t')) url.searchParams.set('t', cfg.token); // editor media stream
    const proxy = http.request({
      host: '127.0.0.1', port: cfg.port, method: req.method,
      path: url.pathname.slice(4) + url.search,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json', 'x-vid-token': cfg.token, 'x-vid-seq': req.headers['x-vid-seq'] || '',
        ...(req.headers.range ? { range: req.headers.range } : {}),
      },
    }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    proxy.on('error', () => { res.writeHead(502); res.end('{"error":"helper offline"}'); });
    return req.pipe(proxy);
  }

  const base = url.pathname.startsWith('/dev/') ? ROOT : EXT;
  const file = path.normalize(path.join(base, url.pathname === '/' ? 'popup.html' : url.pathname));
  if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  let body = fs.readFileSync(file);
  if (file.endsWith('.html')) {
    body = body.toString().replace('<head>', '<head>\n<script src="/dev/shim.js"></script>');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}).listen(PORT, () => console.log(`harness on http://localhost:${PORT}/popup.html`));
