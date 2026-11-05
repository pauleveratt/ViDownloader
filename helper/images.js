// Still images: saving a page's images, grabbing a full-resolution video frame, and storing
// frames the extension captured itself. Everything lands in <output>\<Platform>\Images.
const fs = require('fs');
const path = require('path');
const u = require('./util');
const yt = require('./ytdlp');
const history = require('./history');
const { finish } = require('./jobs');

const { config } = u;

const EXT_BY_TYPE = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/avif': '.avif', 'image/heic': '.heic', 'image/heif': '.heic',
};
// Formats every editor opens; anything else is converted to PNG.
const EDITOR_OK = new Set(['.jpg', '.png', '.gif']);

function imagesDir(platform) {
  const dir = path.join(config.outputDir, platform, 'Images');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function baseName(pageTitle, pageUrl) {
  let host = 'page';
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { /* keep default */ }
  return u.sanitize(u.cleanPageTitle(pageTitle) || host, 80);
}

async function toPng(file) {
  const out = u.uniquePath(file.replace(/\.[^.\\/]+$/, '.png'));
  try {
    await u.runFfmpeg(['-i', file, '-frames:v', '1', '-update', '1', out]);
    u.deleteFile(file);
    return out;
  } catch {
    u.deleteFile(out);
    return file; // e.g. animated WebP ffmpeg can't decode: keep the original
  }
}

// opts: { items: [{ url }], pageUrl, pageTitle, cookies, headers }
async function saveImages(job, opts) {
  const items = (opts.items || []).filter(i => /^https?:/.test(i.url)).slice(0, 200);
  if (!items.length) throw new Error('No images selected.');
  const platform = u.platformFromUrl(opts.pageUrl);
  Object.assign(job, { platform, title: u.cleanPageTitle(opts.pageTitle) || 'Images', stage: 'Saving images', progress: 0, canStop: true });
  job._onStop = () => { job.stopRequested = true; };

  const headers = { 'User-Agent': (opts.headers || {})['User-Agent'] || 'Mozilla/5.0' };
  if (opts.pageUrl) headers.Referer = opts.pageUrl;
  const ck = u.cookieHeader(opts.cookies);
  if (ck) headers.Cookie = ck;

  const dir = imagesDir(platform);
  const base = `${baseName(opts.pageTitle, opts.pageUrl)} [${u.dateStamp()}]`;
  const files = [];
  let failed = 0;
  for (let i = 0; i < items.length && !job.stopRequested; i++) {
    try {
      const res = await fetch(items[i].url, { headers, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (type && !type.startsWith('image/')) throw new Error(`not an image (${type})`);
      const urlExt = path.extname(new URL(items[i].url).pathname).toLowerCase();
      const ext = EXT_BY_TYPE[type] || (/^\.(jpe?g|png|gif|webp|avif)$/.test(urlExt) ? urlExt.replace('jpeg', 'jpg') : '.jpg');
      const buf = Buffer.from(await res.arrayBuffer());
      const num = items.length > 1 ? ` ${String(i + 1).padStart(2, '0')}` : '';
      let file = u.uniquePath(path.join(dir, `${base}${num}${ext}`));
      fs.writeFileSync(file, buf);
      if (!EDITOR_OK.has(ext)) file = await toPng(file);
      files.push(file);
      job.bytes += buf.length;
    } catch (e) {
      failed++;
      u.log('image save failed:', items[i].url.slice(0, 120), e.message);
    }
    job.progress = ((i + 1) / items.length) * 100;
  }
  job.canStop = false;
  if (!files.length) throw new Error(job.stopRequested ? 'Stopped' : 'The site refused the image downloads. Try ticking "Use my Chrome login".');

  history.append({
    kind: 'image', platform, title: job.title, uploader: '', sourceUrl: opts.pageUrl,
    mode: 'image', count: files.length, file: files[0],
  });
  job.files = files;
  finish(job, 'done');
  job.stage = failed ? `Saved ${files.length}, ${failed} failed` : 'Done';
}

// Full-resolution frame straight from the source stream (no player UI, no screen scaling).
// opts: { url, time, cookies, headers, pageUrl, pageTitle }
async function grabFrame(opts) {
  const time = Math.max(0, Number(opts.time) || 0);
  const info = await yt.getInfo(opts.url, opts);
  const sum = yt.summarize(info);
  if (sum.isLive) throw new Error('Live stream');
  const entry = info._type === 'playlist' ? (info.entries || []).find(e => (e.formats || []).some(isVideo)) || {} : info;
  const fmt = (entry.formats || []).filter(isVideo).sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  if (!fmt) throw new Error('No video stream found');

  const headers = Object.entries(fmt.http_headers || entry.http_headers || {}).map(([k, v]) => `${k}: ${v}`);
  const platform = sum.platform;
  const name = `${u.sanitize(sum.uploader || platform, 40)} - ${u.sanitize(sum.title, 80)} [${entry.id || info.id}] frame ${frameStamp(time)}.png`;
  const out = u.uniquePath(path.join(imagesDir(platform), name));
  const args = [];
  if (headers.length) args.push('-headers', headers.join('\r\n') + '\r\n');
  args.push('-ss', time.toFixed(3), '-i', fmt.url, '-frames:v', '1', '-update', '1', out);
  await u.runFfmpeg(args).catch(e => { u.deleteFile(out); throw e; });
  if (!fs.existsSync(out)) throw new Error('Could not read that frame');
  history.append({
    kind: 'frame', platform, title: sum.title, uploader: sum.uploader, sourceUrl: opts.pageUrl || opts.url,
    mode: 'image', time, file: out, resolution: fmt.height ? `${fmt.width || '?'}x${fmt.height}` : null,
  });
  return { file: out, platform, title: sum.title, height: fmt.height || null };
}

function isVideo(f) {
  return f.vcodec && f.vcodec !== 'none' && f.url && !/mhtml|storyboard/i.test(`${f.protocol} ${f.format_note || ''}`);
}

// A PNG the extension captured itself (canvas or tab screenshot).
function saveUpload(buf, { pageUrl, pageTitle, time }) {
  if (buf.length < 100 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
  const platform = u.platformFromUrl(pageUrl);
  const t = Number(time);
  const suffix = Number.isFinite(t) && t > 0 ? ` frame ${frameStamp(t)}` : ` [${u.dateStamp()}]`;
  const out = u.uniquePath(path.join(imagesDir(platform), `${baseName(pageTitle, pageUrl)}${suffix}.png`));
  fs.writeFileSync(out, buf);
  history.append({
    kind: 'frame', platform, title: u.cleanPageTitle(pageTitle), uploader: '', sourceUrl: pageUrl,
    mode: 'image', time: Number.isFinite(t) ? t : null, file: out,
  });
  return { file: out, platform };
}

// 83.42 -> "1m23.4s"
function frameStamp(t) {
  return `${u.stampTime(t).replace(/s$/, '')}.${Math.floor((t % 1) * 10)}s`;
}

module.exports = { saveImages, grabFrame, saveUpload };
