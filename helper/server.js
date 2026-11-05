// ViDownloader local helper: a small HTTP API on 127.0.0.1 used by the Chrome extension.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const u = require('./util');
const yt = require('./ytdlp');
const live = require('./live');
const tabrec = require('./tabrec');
const images = require('./images');
const editor = require('./editor');
const history = require('./history');
const jobsMod = require('./jobs');

const { config, log } = u;
const VERSION = '1.0.0';
let ytdlpVersion = '';

// ---------------------------------------------------------------- http plumbing

function send(res, status, body) {
  const data = JSON.stringify(body ?? {});
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function json(req) {
  const buf = await readBody(req, 5e6);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }); }
}

function httpError(status, msg) {
  return Object.assign(new Error(msg), { status });
}

// Start a background job and report failures on the job itself.
function runJob(job, fn) {
  fn().catch(e => {
    if (job.stopRequested || /^Stopped/.test(e.message)) {
      jobsMod.finish(job, 'stopped');
      job.stage = 'Stopped';
    } else {
      log(`job ${job.id} failed:`, e.message);
      jobsMod.finish(job, 'error', e);
      job.stage = 'Failed';
    }
  });
}

// Instant results (frame grabs) still show up in the popup's Activity list.
function doneJob(type, url, { file, platform, title }) {
  const job = jobsMod.createJob(type, { url, title: title || path.basename(file), platform, files: [file], stage: 'Done' });
  jobsMod.finish(job, 'done');
  return { id: job.id, file };
}

function reveal(file) {
  // explorer.exe needs the /select argument unquoted-but-joined, hence verbatim args.
  spawn('explorer.exe', [`/select,"${file}"`], { windowsVerbatimArguments: true, detached: true }).unref();
}

function knownFile(file) {
  if (!file) return false;
  if (history.knownFiles().has(file)) return true;
  return jobsMod.list().some(j => j.files.includes(file));
}

// ---------------------------------------------------------------- routes

const routes = {
  'GET /ping': async () => ({ ok: true, version: VERSION, ytdlp: ytdlpVersion, outputDir: config.outputDir, busy: jobsMod.isBusy() }),

  'GET /config': async () => ({ outputDir: config.outputDir, ytdlp: ytdlpVersion, lastYtdlpUpdate: config.lastYtdlpUpdate }),

  'POST /config': async req => {
    const body = await json(req);
    if (body.outputDir) {
      const dir = path.resolve(String(body.outputDir));
      fs.mkdirSync(dir, { recursive: true });
      config.outputDir = dir;
      u.saveConfig();
    }
    return { outputDir: config.outputDir };
  },

  'POST /info': async req => {
    const body = await json(req);
    if (!body.url) throw httpError(400, 'url required');
    const info = await yt.getInfo(body.url, body);
    return yt.summarize(info);
  },

  'POST /download': async req => {
    const body = await json(req);
    if (!body.url) throw httpError(400, 'url required');
    u.parseTime(body.start); u.parseTime(body.end); // validate up front
    const trim = body.start || body.end ? `${body.start || '0:00'}–${body.end || 'end'}` : '';
    const job = jobsMod.createJob('download', { url: body.pageUrl || body.url, title: body.pageTitle || '', mode: body.mode || 'video', trim });
    job._onStop = () => { for (const p of job._procs) u.killTree(p.pid); };
    runJob(job, () => yt.download(job, body));
    return { id: job.id };
  },

  'POST /record': async req => {
    const body = await json(req);
    if (!body.url) throw httpError(400, 'url required');
    const job = jobsMod.createJob('live', { url: body.pageUrl || body.url, title: body.pageTitle || '' });
    job._onStop = () => { job.stopRequested = true; };
    runJob(job, () => live.record(job, body));
    return { id: job.id };
  },

  'POST /images': async req => {
    const body = await json(req);
    const job = jobsMod.createJob('images', { url: body.pageUrl || '' });
    runJob(job, () => images.saveImages(job, body));
    return { id: job.id };
  },

  // Synchronous so the extension can fall back to capturing the frame itself if this fails.
  'POST /frame': async req => {
    const body = await json(req);
    if (!body.url) throw httpError(400, 'url required');
    const r = await images.grabFrame(body).catch(e => { throw httpError(422, e.message); });
    return doneJob('frame', body.pageUrl || body.url, r);
  },

  'POST /image-upload': async (req, url) => {
    const buf = await readBody(req, 80e6);
    const q = Object.fromEntries(url.searchParams);
    const r = images.saveUpload(buf, q);
    return doneJob('frame', q.pageUrl || '', { ...r, title: u.cleanPageTitle(q.pageTitle) });
  },

  'GET /probe': async (req, url) => {
    const file = url.searchParams.get('file');
    if (!knownFile(file)) throw httpError(403, 'Unknown file');
    if (!fs.existsSync(file)) throw httpError(404, 'File was moved or deleted');
    const p = await u.probe(file);
    const source = history.read().find(r => r.file === file) || {};
    return { ...p, file, name: path.basename(file), title: source.title || '', platform: source.platform || '', uploader: source.uploader || '' };
  },

  'POST /edit': async req => {
    const body = await json(req);
    if (!knownFile(body.file)) throw httpError(403, 'Unknown file');
    if (!fs.existsSync(body.file)) throw httpError(404, 'File was moved or deleted');
    const job = jobsMod.createJob('edit', { url: '' });
    runJob(job, () => editor.exportEdit(job, body));
    return { id: job.id };
  },

  'POST /tabrec/start': async req => {
    const body = await json(req);
    const job = jobsMod.createJob('tabrec', {});
    tabrec.start(job, body);
    return { id: job.id };
  },

  'GET /jobs': async () => jobsMod.list(),

  // Latest modification time of the extension's files; the extension reloads itself when it changes.
  'GET /dev/ext-version': async () => {
    const dir = path.join(u.ROOT, 'extension');
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).reduce((m, e) => {
      const p = path.join(d, e.name);
      return Math.max(m, e.isDirectory() ? walk(p) : fs.statSync(p).mtimeMs);
    }, 0);
    return { version: Math.floor(walk(dir)) };
  },

  'GET /history': async () => history.read(),

  // Empties the history list only; downloaded files stay where they are.
  'POST /history/clear': async () => {
    history.clear();
    return { ok: true };
  },

  'POST /history/delete': async req => {
    const { id } = await json(req);
    history.remove(id);
    return { ok: true };
  },

  'POST /jobs/clear': async () => {
    for (const j of jobsMod.list()) if (j.finishedAt) jobsMod.jobs.delete(j.id);
    return { ok: true };
  },

  'POST /reveal': async req => {
    const { file } = await json(req);
    if (!knownFile(file)) throw httpError(403, 'Unknown file');
    if (!fs.existsSync(file)) throw httpError(404, 'File was moved or deleted');
    reveal(file);
    return { ok: true };
  },

  'POST /open-folder': async () => {
    fs.mkdirSync(config.outputDir, { recursive: true });
    spawn('explorer.exe', [config.outputDir], { detached: true }).unref();
    return { ok: true };
  },

  'POST /update': async () => {
    if (jobsMod.isBusy()) throw httpError(409, 'Wait for running downloads to finish first.');
    const out = await yt.selfUpdate();
    ytdlpVersion = await yt.version();
    return { output: out, ytdlp: ytdlpVersion };
  },
};

// Routes with an id: /jobs/:id/stop, /jobs/:id/dismiss, /tabrec/:id/chunk, /tabrec/:id/stop
async function idRoute(method, parts, req) {
  const [area, id, action] = parts;
  const job = jobsMod.jobs.get(id);
  if (!job) throw httpError(404, 'No such job');

  if (method === 'POST' && area === 'jobs' && action === 'stop') {
    job.stopRequested = true;
    if (job._onStop) job._onStop();
    return { ok: true };
  }
  if (method === 'POST' && area === 'jobs' && action === 'dismiss') {
    if (!job.finishedAt) throw httpError(409, 'Job is still running');
    jobsMod.jobs.delete(id);
    return { ok: true };
  }
  if (method === 'POST' && area === 'tabrec' && action === 'chunk') {
    const buf = await readBody(req, 100e6);
    tabrec.chunk(job, buf, req.headers['x-vid-seq']);
    return { ok: true, stopRequested: !!job.stopRequested };
  }
  if (method === 'POST' && area === 'tabrec' && action === 'stop') {
    tabrec.stop(job, 'user').catch(e => jobsMod.finish(job, 'error', e));
    return { ok: true };
  }
  throw httpError(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  // Only the extension may talk to us; web pages would send an http(s) Origin.
  if (origin && !origin.startsWith('chrome-extension://')) return send(res, 403, { error: 'Forbidden origin' });
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-ViD-Token, X-ViD-Seq');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://127.0.0.1');
  // <video src> can't send headers, so the editor's media stream carries the token in the URL.
  // Only this read-only route accepts it there, and only for files the helper saved.
  if (req.method === 'GET' && url.pathname === '/media') {
    const file = url.searchParams.get('file');
    if (url.searchParams.get('t') !== config.token) return send(res, 401, { error: 'Bad or missing token' });
    if (!knownFile(file) || !fs.existsSync(file)) return send(res, 404, { error: 'Unknown file' });
    return editor.stream(req, res, file);
  }
  if (req.headers['x-vid-token'] !== config.token) return send(res, 401, { error: 'Bad or missing token' });

  try {
    const route = routes[`${req.method} ${url.pathname}`];
    let result;
    if (route) result = await route(req, url);
    else {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length !== 3) throw httpError(404, 'Not found');
      result = await idRoute(req.method, parts, req);
    }
    send(res, 200, result);
  } catch (e) {
    if (!e.status) log(`${req.method} ${url.pathname} error:`, e.message);
    send(res, e.status || 500, { error: e.message });
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    log(`Port ${config.port} is in use - another helper is probably running. Exiting.`);
    process.exit(0);
  }
  throw e;
});

// ---------------------------------------------------------------- startup

async function maybeUpdateYtdlp() {
  const WEEK = 7 * 24 * 3600 * 1000;
  if (Date.now() - (config.lastYtdlpUpdate || 0) < WEEK || jobsMod.isBusy()) return;
  try {
    log('Weekly yt-dlp update:', u.lastLines(await yt.selfUpdate(), 1));
    ytdlpVersion = await yt.version();
  } catch (e) { log('yt-dlp update failed:', e.message); }
}

server.listen(config.port, '127.0.0.1', async () => {
  log(`ViDownloader helper ${VERSION} listening on 127.0.0.1:${config.port}; output -> ${config.outputDir}`);
  try { ytdlpVersion = await yt.version(); } catch (e) { log('yt-dlp not found at', config.ytdlpPath); }
  u.cleanupLeftovers(); // anything a previous crash/shutdown left behind
  setTimeout(maybeUpdateYtdlp, 60 * 1000);
  setInterval(maybeUpdateYtdlp, 6 * 3600 * 1000);
});

process.on('uncaughtException', e => log('uncaught:', e.stack || e.message));
process.on('unhandledRejection', e => log('unhandled rejection:', (e && e.stack) || e));
