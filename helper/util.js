// Shared helpers: config, logging, paths, process control, ffmpeg/ffprobe wrappers.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'helper.log');

// ---------------------------------------------------------------- config

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '')); } catch { /* first run */ }
  const defaults = {
    port: 47321,
    outputDir: path.join(os.homedir(), 'Videos', 'ViDownloader'),
    ytdlpPath: path.join(ROOT, 'bin', 'yt-dlp.exe'),
    ffmpegPath: 'ffmpeg',
    nodePath: process.execPath,
    lastYtdlpUpdate: 0,
  };
  cfg = { ...defaults, ...cfg };
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  }
  return cfg;
}

const config = loadConfig();

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function ffprobePath() {
  const p = path.join(path.dirname(config.ffmpegPath), 'ffprobe.exe');
  return fs.existsSync(p) ? p : 'ffprobe';
}

// Per-job scratch space lives inside the output folder so moves stay on one drive.
function tempDir(name) {
  const dir = path.join(config.outputDir, '.vid-temp', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Note: Node 24's fs.rmSync/fs.rm silently skip files with some non-ASCII names on Windows
// (e.g. a curly apostrophe), so deletions go through unlink/rmdir instead.
function deleteFile(file) {
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') log('could not delete', file, e.code); }
}

function removeDir(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) removeDir(p);
    else deleteFile(p);
  }
  try { fs.rmdirSync(dir); } catch { /* best effort */ }
}

// ---------------------------------------------------------------- logging

fs.mkdirSync(LOG_DIR, { recursive: true });
try { if (fs.statSync(LOG_FILE).size > 5e6) fs.renameSync(LOG_FILE, LOG_FILE + '.old'); } catch { /* none yet */ }

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  console.log(line);
  fs.appendFile(LOG_FILE, line + '\n', () => {});
}

// ---------------------------------------------------------------- names & times

function sanitize(name, max = 100) {
  let s = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max).trim();
  return s.replace(/[. ]+$/, '') || 'video';
}

// "83", "1:23", "01:02:03", "1:23.5" -> seconds. Empty -> null. Invalid -> throws.
function parseTime(str) {
  if (str === undefined || str === null || String(str).trim() === '') return null;
  const s = String(str).trim();
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) throw new Error(`Invalid time "${s}" (use e.g. 1:23 or 1:02:03)`);
  return s.split(':').reduce((acc, part) => acc * 60 + parseFloat(part), 0);
}

// 83.5 -> "1m23s", 3723 -> "1h02m03s" (used in file names)
function stampTime(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}h${p(m)}m${p(s)}s` : `${m}m${p(s)}s`;
}

function dateStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

function platformFromUrl(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return 'Other'; }
  if (/(^|\.)instagram\.com$/.test(host)) return 'Instagram';
  if (/(^|\.)tiktok\.com$/.test(host)) return 'TikTok';
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host)) return 'YouTube';
  if (/(^|\.)twitch\.tv$/.test(host)) return 'Twitch';
  return 'Other';
}

// Page titles carry site boilerplate; keep the useful part for file names.
function cleanPageTitle(title) {
  return String(title || '')
    .replace(/^\(\d+\)\s*/, '')                       // "(3) Instagram" notification counts
    .replace(/\s+on Instagram:\s*/i, ' - ')
    .replace(/\s*[•|·-]\s*(Instagram|TikTok|YouTube|Twitch)(\b.*)?$/i, '')
    .replace(/["“”]/g, '')
    .trim();
}

// Avoid overwriting: "name.mp4" -> "name (2).mp4"
function uniquePath(file) {
  if (!fs.existsSync(file)) return file;
  const { dir, name, ext } = path.parse(file);
  for (let i = 2; ; i++) {
    const p = path.join(dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
}

// ---------------------------------------------------------------- cookies

// Chrome cookie objects (from chrome.cookies.getAll) -> Netscape cookies.txt for yt-dlp.
function writeCookieFile(cookies) {
  if (!Array.isArray(cookies) || !cookies.length) return null;
  const clean = v => String(v ?? '').replace(/[\t\r\n]/g, '');
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    if (!c || !c.name || !c.domain) continue;
    const bare = c.domain.replace(/^\./, '');
    const domain = c.hostOnly ? bare : '.' + bare;
    lines.push([
      (c.httpOnly ? '#HttpOnly_' : '') + domain,
      c.hostOnly ? 'FALSE' : 'TRUE',
      clean(c.path || '/'),
      c.secure ? 'TRUE' : 'FALSE',
      Math.floor(c.expirationDate || 0),
      clean(c.name),
      clean(c.value),
    ].join('\t'));
  }
  const file = path.join(os.tmpdir(), `vid-cookies-${crypto.randomBytes(6).toString('hex')}.txt`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function cookieHeader(cookies) {
  if (!Array.isArray(cookies)) return '';
  return cookies.filter(c => c && c.name).map(c => `${c.name}=${c.value}`).join('; ');
}

function removeFile(file) {
  if (file) deleteFile(file);
}

// Runs at helper start (no jobs yet): removes what a crash or shutdown mid-job left behind -
// cookie files (they hold login sessions), job temp folders, and half-converted MP4s.
function cleanupLeftovers() {
  const found = { cookies: 0, jobFolders: 0, converting: 0 };
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (/^vid-cookies-[0-9a-f]+\.txt$/.test(f)) { deleteFile(path.join(os.tmpdir(), f)); found.cookies++; }
  }
  const tempRoot = path.join(config.outputDir, '.vid-temp');
  try { found.jobFolders = fs.readdirSync(tempRoot).length; } catch { /* none */ }
  removeDir(tempRoot);
  const sweep = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) sweep(p);
      else if (/\.converting\.mp4$/.test(e.name)) { deleteFile(p); found.converting++; }
    }
  };
  sweep(config.outputDir);
  if (found.cookies || found.jobFolders || found.converting) {
    log(`Cleaned up leftovers from interrupted jobs: ${found.cookies} cookie file(s), ${found.jobFolders} job temp folder(s), ${found.converting} half-converted file(s)`);
  }
}

// ---------------------------------------------------------------- processes

function killTree(pid) {
  if (!pid) return;
  spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
}

// Runs ffmpeg; onTime(seconds) is called as it reports progress. Resolves on exit code 0.
function runFfmpeg(args, { onTime, job } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ffmpegPath, ['-hide_banner', '-y', ...args], { windowsHide: true });
    if (job) job._procs.add(proc);
    let tail = '';
    proc.stderr.on('data', d => {
      const s = d.toString();
      tail = (tail + s).slice(-4000);
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
      if (m && onTime) onTime(+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]));
    });
    proc.on('error', reject);
    proc.on('close', code => {
      if (job) job._procs.delete(proc);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed: ${lastLines(tail, 3)}`));
    });
  });
}

function probe(file) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(file)) return reject(new Error(`File not found: ${file}`));
    const proc = spawn(ffprobePath(), ['-v', 'error', '-show_entries',
      'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration', '-of', 'json', file], { windowsHide: true });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.on('error', reject);
    proc.on('close', () => {
      try {
        const j = JSON.parse(out);
        const v = (j.streams || []).find(s => s.codec_type === 'video');
        const a = (j.streams || []).find(s => s.codec_type === 'audio');
        resolve({
          vcodec: v ? v.codec_name : null,
          acodec: a ? a.codec_name : null,
          width: v ? v.width : null,
          height: v ? v.height : null,
          fps: v && /^\d+\/\d+$/.test(v.r_frame_rate || '') ? (([n, d]) => (+d ? n / d : null))(v.r_frame_rate.split('/').map(Number)) : null,
          duration: j.format ? parseFloat(j.format.duration) || null : null,
        });
      } catch (e) { reject(new Error('ffprobe could not read ' + file)); }
    });
  });
}

// Make sure a video file is H.264/AAC in an MP4 so editors import it without fuss.
// Copies streams that are already fine; re-encodes only what isn't. Returns the final path.
async function ensureEditorFriendly(file, job, { forceCfr = false } = {}) {
  const info = await probe(file);
  if (!info.vcodec) return file; // audio-only result, leave it
  const vOk = info.vcodec === 'h264' && !forceCfr;
  const aOk = !info.acodec || info.acodec === 'aac';
  const isMp4 = path.extname(file).toLowerCase() === '.mp4';
  if (vOk && aOk && isMp4) return file;

  const { dir, name } = path.parse(file);
  const tmp = path.join(dir, `${name}.converting.mp4`);
  const args = ['-i', file, '-map', '0:v:0', '-map', '0:a:0?'];
  if (vOk) args.push('-c:v', 'copy');
  else {
    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
    if (forceCfr) args.push('-fps_mode', 'cfr', '-r', '30');
  }
  args.push(...(aOk ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']), '-movflags', '+faststart', tmp);

  if (job) {
    job.stage = vOk ? 'Converting audio to AAC' : `Converting ${info.vcodec.toUpperCase()} → H.264`;
    job.progress = 0;
  }
  try {
    await runFfmpeg(args, {
      job,
      onTime: t => { if (job && info.duration) job.progress = Math.min(99, (t / info.duration) * 100); },
    });
  } catch (e) {
    deleteFile(tmp);
    throw e;
  }
  deleteFile(file);
  const final = uniquePath(path.join(dir, `${name}.mp4`));
  fs.renameSync(tmp, final);
  return final;
}

function lastLines(text, n) {
  return String(text || '').trim().split(/\r?\n/).filter(Boolean).slice(-n).join(' | ');
}

module.exports = {
  ROOT, config, saveConfig, log, tempDir, removeDir, sanitize, parseTime, stampTime, dateStamp,
  platformFromUrl, cleanPageTitle,
  uniquePath, writeCookieFile, cookieHeader, removeFile, deleteFile, cleanupLeftovers, killTree, runFfmpeg, probe,
  ensureEditorFriendly, lastLines,
};
