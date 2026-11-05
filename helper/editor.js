// Trim editor support: streaming saved files to the editor page, and exporting segments
// (frame-accurate re-encode, then either joined into one file or saved separately).
const fs = require('fs');
const path = require('path');
const u = require('./util');
const history = require('./history');
const { finish } = require('./jobs');

const TYPES = { '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };
const AUDIO_EXT = /^\.(mp3|wav|m4a)$/i;

// Serves a file with HTTP Range support so the player can seek.
function stream(req, res, file) {
  const size = fs.statSync(file).size;
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (!m) {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(file).pipe(res);
  }
  let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
  let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : size - 1;
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
  res.writeHead(206, {
    'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${start}-${end}/${size}`,
  });
  fs.createReadStream(file, { start, end }).pipe(res);
}

function encodeArgs(ext) {
  if (/^\.mp3$/i.test(ext)) return ['-vn', '-c:a', 'libmp3lame', '-q:a', '0'];
  if (/^\.wav$/i.test(ext)) return ['-vn', '-c:a', 'pcm_s16le'];
  if (/^\.m4a$/i.test(ext)) return ['-vn', '-c:a', 'aac', '-b:a', '192k'];
  return ['-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart'];
}

const span = s => `${u.stampTime(s.start)}-${u.stampTime(s.end)}`;

// opts: { file, segments: [{ start, end }], join }
async function exportEdit(job, opts) {
  const file = opts.file;
  const segs = (opts.segments || [])
    .map(s => ({ start: Math.max(0, Number(s.start)), end: Number(s.end) }))
    .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end - s.start >= 0.05);
  if (!segs.length) throw new Error('Add at least one segment.');

  const { dir, name, ext } = path.parse(file);
  const outExt = AUDIO_EXT.test(ext) ? ext.toLowerCase() : '.mp4';
  const total = segs.reduce((n, s) => n + (s.end - s.start), 0);
  const source = history.read().find(r => r.file === file) || {};
  Object.assign(job, {
    title: source.title || name, platform: source.platform || '', uploader: source.uploader || '',
    stage: 'Cutting', progress: 0, canStop: true,
  });
  job._onStop = () => { job.stopRequested = true; for (const p of job._procs) u.killTree(p.pid); };

  const work = u.tempDir(job.id);
  const parts = [];
  let done = 0;
  try {
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      job.stage = segs.length > 1 ? `Cutting part ${i + 1} of ${segs.length}` : 'Cutting';
      const out = opts.join
        ? path.join(work, `part${i}${outExt}`)
        : u.uniquePath(path.join(dir, `${name} (${span(s)})${outExt}`));
      await u.runFfmpeg(['-ss', s.start.toFixed(3), '-i', file, '-t', (s.end - s.start).toFixed(3), ...encodeArgs(outExt), out], {
        job,
        onTime: t => { job.progress = Math.min(99, ((done + t) / total) * 100); },
      }).catch(e => { u.deleteFile(out); throw e; }); // half-written part
      done += s.end - s.start;
      parts.push(out);
    }
    let outputs = parts;
    if (opts.join && parts.length > 1) {
      job.stage = 'Joining';
      const list = path.join(work, 'list.txt');
      fs.writeFileSync(list, parts.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
      const out = u.uniquePath(path.join(dir, `${name} (edit, ${parts.length} parts)${outExt}`));
      await u.runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', ...(outExt === '.mp4' ? ['-movflags', '+faststart'] : []), out], { job })
        .catch(e => { u.deleteFile(out); throw e; });
      outputs = [out];
    } else if (opts.join) {
      const out = u.uniquePath(path.join(dir, `${name} (${span(segs[0])})${outExt}`));
      fs.renameSync(parts[0], out);
      outputs = [out];
    }
    for (const f of outputs) {
      history.append({
        kind: 'edit', platform: job.platform, title: job.title, uploader: job.uploader,
        sourceUrl: source.sourceUrl || '', mode: source.mode || 'video', duration: opts.join ? total : null,
        parts: opts.join ? segs.length : 1, file: f, editedFrom: file,
      });
    }
    job.files = outputs;
    finish(job, 'done');
    job.stage = 'Done';
  } catch (e) {
    if (!opts.join) for (const p of parts) u.deleteFile(p);
    throw job.stopRequested ? new Error('Stopped') : e;
  } finally {
    job.canStop = false;
    u.removeDir(work);
  }
}

module.exports = { stream, exportEdit };
