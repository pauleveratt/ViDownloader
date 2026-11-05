// "Record this tab": the extension streams MediaRecorder WebM chunks here; on stop we
// convert to constant-frame-rate H.264/AAC MP4 for editors.
const fs = require('fs');
const path = require('path');
const u = require('./util');
const history = require('./history');
const { finish } = require('./jobs');

const { config } = u;
const IDLE_TIMEOUT = 60 * 1000; // no chunks for this long -> assume the tab/extension went away

function start(job, { pageTitle, pageUrl }) {
  const dir = u.tempDir(job.id);
  const file = path.join(dir, 'tab.webm');
  const stream = fs.createWriteStream(file);
  const state = { dir, file, stream, seq: 0, startedAt: Date.now(), lastChunk: Date.now(), pageUrl, ended: false };
  Object.defineProperty(job, '_tab', { value: state });
  let host = 'Tab';
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { /* keep default */ }
  Object.assign(job, {
    title: pageTitle || host,
    platform: u.platformFromUrl(pageUrl),
    url: pageUrl || '',
    stage: 'Recording tab',
    canStop: true,
    progress: null,
  });
  state.ticker = setInterval(() => {
    job.elapsed = (Date.now() - state.startedAt) / 1000;
    if (Date.now() - state.lastChunk > IDLE_TIMEOUT) stop(job, 'timeout');
  }, 1000);
  // The extension does the actual stopping; Stop from the job list asks it via the stop flag.
  job._onStop = () => { job.stopRequested = true; };
}

function chunk(job, buf, seq) {
  const s = job._tab;
  if (!s || s.ended) throw new Error('Recording is not active');
  if (seq !== undefined && Number(seq) !== s.seq) throw new Error(`Chunk out of order (got ${seq}, expected ${s.seq})`);
  s.seq++;
  s.lastChunk = Date.now();
  s.stream.write(buf);
  job.bytes += buf.length;
}

async function stop(job, reason) {
  const s = job._tab;
  if (!s || s.ended) return;
  s.ended = true;
  clearInterval(s.ticker);
  job.canStop = false;
  await new Promise(r => s.stream.end(r));
  const recorded = (Date.now() - s.startedAt) / 1000;

  if (job.bytes < 10 * 1024) {
    u.removeDir(s.dir);
    finish(job, 'error', reason === 'timeout' ? 'The tab stopped sending video.' : 'Nothing was recorded.');
    return;
  }

  job.status = 'processing';
  job.stage = 'Converting to MP4';
  job.progress = 0;
  const outDir = path.join(config.outputDir, job.platform);
  fs.mkdirSync(outDir, { recursive: true });
  const out = u.uniquePath(path.join(outDir, `${u.sanitize(job.title, 90)} [tab ${u.dateStamp(new Date(s.startedAt))}].mp4`));
  try {
    await u.runFfmpeg(['-fflags', '+genpts', '-i', s.file,
      '-map', '0:v:0?', '-map', '0:a:0?',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-fps_mode', 'cfr', '-r', '30',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', out], {
      job,
      onTime: t => { job.progress = Math.min(99, (t / recorded) * 100); },
    });
  } catch (e) {
    // Don't lose the recording: keep the raw WebM next to where the MP4 would have gone
    // (the temp folder is wiped on the next helper start).
    u.deleteFile(out);
    const raw = u.uniquePath(out.replace(/\.mp4$/, ' (raw).webm'));
    try { fs.renameSync(s.file, raw); } catch (err) { u.log('could not keep raw tab recording:', err.message); }
    u.removeDir(s.dir);
    finish(job, 'error', `Converting to MP4 failed; the raw recording was saved as ${path.basename(raw)}`);
    u.log('tab recording convert failed:', e.message, '- raw kept at', raw);
    return;
  }
  u.removeDir(s.dir);
  const probe = await u.probe(out).catch(() => ({}));
  history.append({
    kind: 'tab',
    platform: job.platform,
    title: job.title,
    uploader: '',
    sourceUrl: s.pageUrl,
    mode: 'video',
    duration: probe.duration || recorded,
    file: out,
  });
  job.files = [out];
  job.stage = reason === 'timeout' ? 'Done (tab stopped sending)' : 'Done';
  finish(job, 'done');
}

module.exports = { start, chunk, stop };
