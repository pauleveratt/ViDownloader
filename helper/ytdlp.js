// yt-dlp wrapper: metadata lookup and regular (non-live) downloads.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const u = require('./util');
const history = require('./history');
const { finish } = require('./jobs');

const { config } = u;

// ---------------------------------------------------------------- process

function commonArgs({ cookieFile, headers } = {}) {
  const args = [
    '--no-colors', '--newline', '--no-playlist', '--no-mtime',
    '--ffmpeg-location', path.dirname(config.ffmpegPath),
    '--js-runtimes', `node:${config.nodePath}`,
  ];
  if (cookieFile) args.push('--cookies', cookieFile);
  for (const [k, v] of Object.entries(headers || {})) {
    if (v) args.push('--add-headers', `${k}:${v}`);
  }
  return args;
}

// Spawns yt-dlp; calls onLine for every stdout/stderr line. Resolves { code, stdout, stderr }.
function run(args, { onLine, job, keepStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    // Force UTF-8 output; otherwise titles with e.g. curly quotes come back as mangled file paths.
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    const proc = spawn(config.ytdlpPath, ['--encoding', 'utf-8', ...args], { windowsHide: true, env });
    if (job) job._procs.add(proc);
    let stdout = '', stderr = '';
    if (keepStdout) proc.stdout.on('data', d => { stdout += d; });
    else readline.createInterface({ input: proc.stdout }).on('line', l => onLine && onLine(l, 'out'));
    readline.createInterface({ input: proc.stderr }).on('line', l => {
      stderr = (stderr + l + '\n').slice(-8000);
      if (onLine) onLine(l, 'err');
    });
    proc.on('error', reject);
    proc.on('close', code => {
      if (job) job._procs.delete(proc);
      resolve({ code, stdout, stderr });
    });
  });
}

// Session cookies that mean "logged in" on the sites we care about.
const AUTH_COOKIES = /^(sessionid|auth-token|SAPISID|__Secure-3PAPISID|sid_tt|sessionid_ss|LOGIN_INFO)$/;

// Names only (never values) - enough to tell "no login sent" from "login rejected".
function cookieSummary(cookies) {
  const list = Array.isArray(cookies) ? cookies : [];
  const auth = list.filter(c => AUTH_COOKIES.test(c.name)).map(c => c.name);
  return { count: list.length, auth };
}

function errorFrom(stderr, cookies) {
  const lines = String(stderr).split(/\r?\n/).filter(l => /^ERROR:/.test(l));
  let msg = lines.length ? lines[lines.length - 1].replace(/^ERROR:\s*/, '') : u.lastLines(stderr, 2);
  const site = (/^\[(\w+)/.exec(msg) || [, ''])[1].replace(/^\w/, c => c.toUpperCase());
  if (/Unsupported URL/i.test(msg)) {
    msg = 'This site/page is not supported by yt-dlp. Try "Detected media" or "Record this tab".';
  } else if (/log ?in|cookies|private|rate-limit|not available/i.test(msg)) {
    const ck = cookieSummary(cookies);
    const fallback = ' If it keeps failing, use "Record this tab" below.';
    if (!ck.count) msg = `${site || 'This site'} needs your login for this. Tick "Use my Chrome login" and try again.`;
    else if (!ck.auth.length) msg = `Your Chrome cookies were sent, but you don't seem to be logged in to ${site || 'this site'} in Chrome. Log in there, then try again.`;
    else msg = `${site || 'The site'} refused your login (it may be rate-limiting, or the session expired). Reload the page while logged in, wait a minute and retry.${fallback}`;
  }
  return new Error(msg || 'yt-dlp failed');
}

// ---------------------------------------------------------------- info

const infoCache = new Map(); // key -> { at, info }
const INFO_TTL = 3 * 60 * 1000;

function cacheKey(url, cookies) {
  return url + '|' + (Array.isArray(cookies) && cookies.length ? 'c' : '');
}

async function getInfo(url, { cookies, headers, fresh = false } = {}) {
  const key = cacheKey(url, cookies);
  const hit = infoCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < INFO_TTL) return hit.info;

  const cookieFile = u.writeCookieFile(cookies);
  const ck = cookieSummary(cookies);
  try {
    const res = await run([...commonArgs({ cookieFile, headers }), '-J', '--flat-playlist', url], { keepStdout: true });
    if (res.code !== 0 || !res.stdout.trim()) {
      u.log(`info failed for ${url} (cookies sent: ${ck.count}, login cookies: ${ck.auth.join(',') || 'none'}):`, u.lastLines(res.stderr, 1));
      throw errorFrom(res.stderr, cookies);
    }
    const info = JSON.parse(res.stdout);
    infoCache.set(key, { at: Date.now(), info });
    return info;
  } finally {
    u.removeFile(cookieFile);
  }
}

function platformOf(info) {
  const k = String(info.extractor_key || info.ie_key || '');
  if (/^Youtube/i.test(k)) return 'YouTube';
  if (/^Instagram/i.test(k)) return 'Instagram';
  if (/^TikTok/i.test(k)) return 'TikTok';
  if (/^Twitch/i.test(k)) return 'Twitch';
  if (!k || /^Generic$/i.test(k)) return 'Other';
  return k.replace(/[^\w-]/g, '');
}

function isPlaylist(info) {
  return info._type === 'playlist' || info._type === 'multi_video';
}

// Playlists of fully-extracted entries (e.g. an Instagram carousel) are fine to download;
// channel/playlist pages that yield bare URL references are not.
function playlistProblem(info) {
  if (!isPlaylist(info)) return null;
  const entries = info.entries || [];
  if (!entries.length) return 'No videos found on this page.';
  if (entries.some(e => e._type === 'url' || e._type === 'url_transparent') || entries.length > 30) {
    return 'This is a playlist/channel page. Open a single video and try again.';
  }
  return null;
}

function summarize(info) {
  const first = isPlaylist(info) ? (info.entries || [])[0] || {} : info;
  const heights = (first.formats || []).map(f => f.height).filter(Boolean);
  const twitch = platformOf(info) === 'Twitch';
  const uploader = twitch
    ? info.channel || info.uploader || first.channel || ''
    : info.uploader || info.channel || first.uploader || first.channel || info.uploader_id || '';
  return {
    // fulltitle = title without the date yt-dlp appends to live streams
    title: info.fulltitle || info.title || first.title || '',
    uploader,
    duration: first.duration || info.duration || null,
    isLive: info.is_live === true || info.live_status === 'is_live',
    liveStatus: info.live_status || null,
    platform: platformOf(info),
    thumbnail: info.thumbnail || first.thumbnail || null,
    webpageUrl: info.webpage_url || info.original_url || null,
    count: isPlaylist(info) ? (info.entries || []).length : 1,
    problem: playlistProblem(info),
    maxHeight: heights.length ? Math.max(...heights) : null,
    extractor: info.extractor_key || '',
  };
}

// ---------------------------------------------------------------- download

const SORTS = {
  1080: 'res:1080,vcodec:h264,acodec:aac',
  720: 'res:720,vcodec:h264,acodec:aac',
  best: 'res,vcodec:h264,acodec:aac',
};

const PROGRESS = 'download:VIDPROG|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.downloaded_bytes)s';

// opts: { url, mode: video|mp3|wav, quality, start, end, cookies, headers, pageUrl, pageTitle, sniffed }
async function download(job, opts) {
  const start = u.parseTime(opts.start);
  const end = u.parseTime(opts.end);
  if (start !== null && end !== null && end <= start) throw new Error('Trim end must be after start.');
  const trimmed = start !== null || end !== null;

  // Media the browser already located (e.g. an Instagram story's separate video + audio
  // files): nothing for yt-dlp to extract, ffmpeg fetches and merges them directly.
  if (opts.direct) return ffmpegFallback(job, opts, { start, end, res: { stderr: '' } });

  job.stage = 'Getting video info';
  let info;
  try {
    info = await getInfo(opts.url, opts);
  } catch (e) {
    if (!opts.sniffed) throw e;
    // yt-dlp couldn't read a detected media URL at all; let ffmpeg try it directly.
    Object.assign(job, { title: opts.pageTitle || 'video', platform: 'Other' });
    return ffmpegFallback(job, opts, { start, end, res: { stderr: 'ERROR: ' + e.message } });
  }
  const sum = summarize(info);
  if (sum.problem) throw new Error(sum.problem);
  if (sum.isLive) throw new Error('This is a live stream. Use "Record live" instead.');
  if (sum.liveStatus === 'is_upcoming') throw new Error('This stream has not started yet.');

  const platform = opts.sniffed ? 'Other' : sum.platform;
  Object.assign(job, { title: (opts.sniffed && opts.pageTitle) || sum.title, uploader: sum.uploader, platform });

  const dir = u.tempDir(job.id);
  const infoFile = path.join(dir, 'info.json');
  fs.writeFileSync(infoFile, JSON.stringify(info));
  const cookieFile = u.writeCookieFile(opts.cookies);

  const trimTag = trimmed ? ` (${u.stampTime(start || 0)}-${end !== null ? u.stampTime(end) : 'end'})` : '';
  const esc = s => s.replace(/%/g, '%%');
  // Sites serving plain HTTPS files (YouTube, TikTok, IG) throttle ffmpeg's single-stream
  // seeking badly, so for those we download the whole thing natively and cut locally.
  // Segmented streams (Twitch VODs, HLS) download just the needed section.
  const first = isPlaylist(info) ? (info.entries || [])[0] || {} : info;
  const localCut = trimmed && (first.formats || []).some(f => f.protocol === 'https' && f.vcodec && f.vcodec !== 'none');
  let name;
  if (opts.sniffed || platform === 'Other') {
    name = esc(u.sanitize(opts.pageTitle || sum.title || 'video', 90)) + ' [' + u.dateStamp() + ']';
  } else if (platform === 'Twitch') {
    // For clips, "uploader" is whoever clipped it; credit the broadcaster's channel.
    name = '%(channel,uploader,uploader_id|Unknown).40B - %(title).90B [%(id)s]';
  } else {
    name = '%(uploader,channel,creator,uploader_id|Unknown).40B - %(title).90B [%(id)s]';
  }
  const template = `${platform}/${name}${localCut ? '' : esc(trimTag)}.%(ext)s`;

  const args = [...commonArgs({ cookieFile, headers: opts.headers }),
    '--load-info-json', infoFile,
    '-P', localCut ? path.join(dir, 'full') : config.outputDir, '-P', `temp:${dir}`, '-o', template,
    '--windows-filenames',
    '--print', 'after_move:VIDFILE|%(filepath)s',
    '--progress', '--progress-template', PROGRESS, '--progress-delta', '0.5',
  ];
  if (opts.mode === 'mp3' || opts.mode === 'wav') {
    args.push('-f', 'ba/b', '-x', '--audio-format', opts.mode, '--audio-quality', '0');
  } else {
    args.push('-f', 'bv*+ba/b', '-S', SORTS[opts.quality] || SORTS[1080], '--merge-output-format', 'mp4');
  }
  if (trimmed && !localCut) {
    args.push('--download-sections', `*${start || 0}-${end !== null ? end : 'inf'}`, '--force-keyframes-at-cuts');
  }

  const sectionLen = trimmed ? (end !== null ? end : (sum.duration || 0)) - (start || 0) : 0;
  let files = [];
  let part = 0, lastPct = 0;
  job.stage = 'Downloading';
  job.canStop = true;
  job._onStop = () => { for (const p of job._procs) u.killTree(p.pid); };

  const res = await run(args, {
    job,
    onLine: (line, stream) => {
      if (line.startsWith('VIDFILE|')) { files.push(line.slice(8).trim()); return; }
      if (line.startsWith('VIDPROG|')) {
        const [, pct, speed, eta, bytes] = line.split('|');
        const p = parseFloat(pct);
        if (!isNaN(p)) {
          if (p + 5 < lastPct) part++;       // video finished, audio started
          lastPct = p;
          job.progress = p;
          job.stage = part ? 'Downloading audio' : 'Downloading';
        }
        job.speed = (speed || '').trim().replace(/^Unknown.*$/, '');
        job.eta = (eta || '').trim().replace(/^Unknown.*$/, '');
        job.bytes = parseInt(bytes, 10) || job.bytes;
        return;
      }
      // Section downloads go through ffmpeg, which reports time= instead of a percentage.
      const m = stream === 'err' && /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
      if (m && sectionLen > 0) {
        const t = +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
        job.progress = Math.min(99, (t / sectionLen) * 100);
        job.stage = 'Downloading section';
      }
      if (/^\[(Merger|ExtractAudio|FixupM3u8|VideoConvertor)\]/.test(line)) job.stage = 'Processing';
    },
  }).catch(e => { u.removeFile(cookieFile); u.removeDir(dir); throw e; });
  u.removeFile(cookieFile);
  job.canStop = false;

  if (job.stopRequested) { u.removeDir(dir); throw new Error('Stopped'); }
  if (res.code !== 0 || !files.length) {
    u.removeDir(dir);
    if (opts.sniffed && opts.allowFallback !== false) return ffmpegFallback(job, opts, { start, end, res });
    throw errorFrom(res.stderr, opts.cookies);
  }
  try {
    if (localCut) {
      const cut = [];
      for (const f of files) cut.push(await cutLocal(job, f, path.join(config.outputDir, platform), trimTag, start, end, sum.duration));
      files = cut;
    }
  } finally {
    u.removeDir(dir);
  }
  return finalize(job, opts, files, { start, end, sum, editorReady: localCut });
}

// Frame-accurate cut of a downloaded file; re-encodes the clip to H.264/AAC (or keeps audio format).
async function cutLocal(job, file, outDir, trimTag, start, end, duration) {
  const { name, ext } = path.parse(file);
  const audioOnly = /^\.(mp3|wav|m4a|opus)$/i.test(ext);
  fs.mkdirSync(outDir, { recursive: true });
  const out = u.uniquePath(path.join(outDir, `${name}${trimTag}${audioOnly ? ext : '.mp4'}`));
  const len = (end !== null ? end : duration || 0) - (start || 0);
  const args = [];
  if (start) args.push('-ss', String(start));
  args.push('-i', file);
  if (end !== null) args.push('-t', String(end - (start || 0)));
  if (/^\.mp3$/i.test(ext)) args.push('-c:a', 'libmp3lame', '-q:a', '0');
  else if (/^\.wav$/i.test(ext)) args.push('-c:a', 'pcm_s16le');
  else if (audioOnly) args.push('-c:a', 'aac', '-b:a', '192k');
  else {
    args.push('-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
  }
  args.push(out);
  job.status = 'processing';
  job.stage = 'Cutting clip';
  job.progress = 0;
  try {
    await runFfmpegJob(args, job, len > 0 ? len : null);
  } catch (e) {
    u.deleteFile(out); // half-written clip
    throw e;
  }
  return out;
}

// Direct ffmpeg grab: detected-media URLs yt-dlp can't handle, and browser-located media
// (opts.direct) - optionally a separate audio file (opts.audioUrl) merged with the video.
async function ffmpegFallback(job, opts, { start, end, res }) {
  if (!opts.direct) u.log('yt-dlp failed on sniffed media, trying ffmpeg:', u.lastLines(res.stderr, 2));
  const platform = opts.platform || 'Other';
  Object.assign(job, { title: opts.pageTitle || 'video', platform, uploader: opts.uploader || '' });
  job.stage = 'Downloading';
  const headers = [];
  const h = opts.headers || {};
  if (h.Referer) headers.push(`Referer: ${h.Referer}`);
  if (h['User-Agent']) headers.push(`User-Agent: ${h['User-Agent']}`);
  const ck = u.cookieHeader(opts.cookies);
  if (ck) headers.push(`Cookie: ${ck}`);
  const audio = opts.mode === 'mp3' || opts.mode === 'wav';
  const trimTag = start !== null || end !== null ? ` (${u.stampTime(start || 0)}-${end !== null ? u.stampTime(end) : 'end'})` : '';
  const who = opts.uploader ? `${u.sanitize(opts.uploader, 40)} - ` : '';
  const out = u.uniquePath(path.join(config.outputDir, platform,
    `${who}${u.sanitize(opts.pageTitle || 'video', 90)} [${u.dateStamp()}]${trimTag}.${audio ? opts.mode : 'mp4'}`));
  fs.mkdirSync(path.dirname(out), { recursive: true });

  // Audio-only output from a separate audio file needs just that input.
  const inputs = audio && opts.audioUrl ? [opts.audioUrl] : [opts.url, ...(opts.audioUrl ? [opts.audioUrl] : [])];
  const args = [];
  for (const src of inputs) {
    if (headers.length) args.push('-headers', headers.join('\r\n') + '\r\n');
    if (start !== null) args.push('-ss', String(start));
    args.push('-i', src);
  }
  if (end !== null) args.push('-t', String(end - (start || 0)));
  if (audio) args.push('-vn', ...(opts.mode === 'mp3' ? ['-c:a', 'libmp3lame', '-q:a', '0'] : ['-c:a', 'pcm_s16le']));
  else {
    args.push('-map', '0:v:0', '-map', inputs.length > 1 ? '1:a:0' : '0:a:0?');
    args.push('-c', 'copy', '-movflags', '+faststart');
  }
  args.push(out);

  job.canStop = true;
  job._onStop = () => { for (const p of job._procs) u.killTree(p.pid); };
  const dur = end !== null ? end - (start || 0) : opts.duration || null;
  try {
    await runFfmpegJob(args, job, dur);
  } catch (e) {
    u.deleteFile(out);
    if (job.stopRequested) throw new Error('Stopped');
    throw opts.direct ? new Error(`Download failed: ${e.message}`) : errorFrom(res.stderr, opts.cookies);
  }
  return finalize(job, opts, [out], { start, end, sum: { title: opts.pageTitle, uploader: opts.uploader || '', duration: dur } });
}

function runFfmpegJob(args, job, duration) {
  return u.runFfmpeg(args, {
    job,
    onTime: t => {
      job.elapsed = t;
      if (duration) job.progress = Math.min(99, (t / duration) * 100);
    },
  });
}

async function finalize(job, opts, files, { start, end, sum, editorReady }) {
  job.canStop = false;
  job.status = 'processing';
  const out = [];
  for (let f of files) {
    if (opts.mode !== 'mp3' && opts.mode !== 'wav' && !editorReady) f = await u.ensureEditorFriendly(f, job);
    out.push(f);
    history.append({
      kind: opts.sniffed ? 'sniffed' : 'download',
      platform: job.platform,
      title: job.title,
      uploader: job.uploader,
      sourceUrl: opts.pageUrl || opts.url,
      mediaUrl: opts.sniffed ? opts.url : undefined,
      mode: opts.mode || 'video',
      trim: start !== null || end !== null ? { start, end } : null,
      duration: sum.duration || null,
      file: f,
    });
  }
  job.files = out;
  finish(job, 'done');
  job.stage = 'Done';
}

// ---------------------------------------------------------------- maintenance

async function version() {
  const r = await run(['--version'], { keepStdout: true });
  return r.stdout.trim();
}

async function selfUpdate() {
  const r = await run(['-U'], { keepStdout: true });
  config.lastYtdlpUpdate = Date.now();
  u.saveConfig();
  return (r.stdout + r.stderr).trim();
}

module.exports = { run, commonArgs, getInfo, summarize, download, errorFrom, version, selfUpdate, platformOf, runFfmpegJob };
