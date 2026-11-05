// Live stream recording.
//  - "from now": yt-dlp writes MPEG-TS to stdout -> ffmpeg copies it to a .ts file.
//    MPEG-TS stays playable when cut off, so Stop just kills yt-dlp; ffmpeg sees EOF and closes cleanly.
//  - "from start" (YouTube/Twitch): yt-dlp --live-from-start into a temp folder; on Stop we
//    merge whatever video/audio parts were written.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const u = require('./util');
const yt = require('./ytdlp');
const history = require('./history');
const { finish } = require('./jobs');

const { config } = u;

const LIVE_FORMATS = {
  1080: 'bv*[height<=1080]+ba/b[height<=1080]/b',
  720: 'bv*[height<=720]+ba/b[height<=720]/b',
  best: 'bv*+ba/b',
};

// opts: { url, fromStart, maxMinutes, quality, cookies, headers, pageUrl, pageTitle, sniffed }
async function record(job, opts) {
  job.stage = 'Getting stream info';
  let sum = { title: opts.pageTitle || 'Live stream', uploader: '', platform: 'Other' };
  if (!opts.sniffed) {
    const info = await yt.getInfo(opts.url, { ...opts, fresh: true });
    sum = yt.summarize(info);
    if (!sum.isLive) throw new Error(sum.liveStatus === 'is_upcoming' ? 'This stream has not started yet.' : 'This page is not live right now.');
  }
  Object.assign(job, { title: sum.title, uploader: sum.uploader, platform: opts.sniffed ? 'Other' : sum.platform });

  const base = `${u.sanitize(sum.uploader || job.platform, 40)} - ${u.sanitize(sum.title, 80)} [live ${u.dateStamp()}]`;
  const outDir = path.join(config.outputDir, job.platform);
  fs.mkdirSync(outDir, { recursive: true });
  const dir = u.tempDir(job.id);
  const cookieFile = u.writeCookieFile(opts.cookies);
  const startedAt = Date.now();

  job.stage = 'Recording';
  job.canStop = true;
  job.progress = null;
  const ticker = setInterval(() => {
    job.elapsed = (Date.now() - startedAt) / 1000;
    job.bytes = dirSize(dir);
    if (opts.maxMinutes > 0 && job.elapsed >= opts.maxMinutes * 60 && !job.stopRequested) {
      job.stopRequested = true;
      job.stage = 'Auto-stopping';
      job._onStop();
    }
  }, 1000);

  let files;
  try {
    files = opts.fromStart
      ? await recordFromStart(job, opts, dir, cookieFile)
      : await recordFromNow(job, opts, dir, cookieFile);
  } catch (e) {
    u.removeDir(dir);
    throw e;
  } finally {
    clearInterval(ticker);
    u.removeFile(cookieFile);
    job.canStop = false;
  }

  job.status = 'processing';
  job.stage = 'Saving MP4';
  const recorded = (Date.now() - startedAt) / 1000;
  let out = u.uniquePath(path.join(outDir, base + '.mp4'));
  try {
    if (files.video && files.audio && files.video !== files.audio) {
      // Partial from-start downloads fetch video and audio at different speeds; keep the overlap.
      await u.runFfmpeg(['-i', files.video, '-i', files.audio, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-shortest', '-movflags', '+faststart', out], { job });
    } else {
      await u.runFfmpeg(['-i', files.video || files.audio, '-c', 'copy', '-movflags', '+faststart', out], { job });
    }
    out = await u.ensureEditorFriendly(out, job);
  } catch (e) {
    u.deleteFile(out); // half-written MP4
    throw e;
  } finally {
    u.removeDir(dir);
  }

  const probe = await u.probe(out).catch(() => ({}));
  history.append({
    kind: 'live',
    platform: job.platform,
    title: job.title,
    uploader: job.uploader,
    sourceUrl: opts.pageUrl || opts.url,
    mode: 'video',
    fromStart: !!opts.fromStart,
    duration: probe.duration || recorded,
    file: out,
  });
  job.files = [out];
  job.stage = 'Done';
  finish(job, 'done');
}

// yt-dlp resolves the stream URL(s) (YouTube live is separate video + audio HLS), then
// ffmpeg records them straight into MPEG-TS. Stop sends ffmpeg "q" so it closes the file cleanly.
//
// Live streams break ffmpeg now and then (Twitch ad breaks/discontinuities make timestamps jump,
// network blips, signed URLs expiring after hours). When ffmpeg ends without Stop being pressed,
// we reconnect into a new part and join all parts at the end. Recording only finishes on Stop,
// auto-stop, or the stream really going offline.
async function recordFromNow(job, opts, dir, cookieFile) {
  let streams = await resolveStreams(job, opts, cookieFile);
  const parts = [];
  let quickFails = 0;
  let lastErr = '';

  for (;;) {
    if (job.stopRequested) break;
    const ts = path.join(dir, `rec${parts.length}.ts`);
    const started = Date.now();
    const result = await recordPart(job, streams, ts);
    if (fileSize(ts) >= 50 * 1024) parts.push(ts);
    else u.deleteFile(ts);
    if (job.stopRequested) break;

    // Ended on its own: reconnect.
    lastErr = result.err || lastErr;
    quickFails = (Date.now() - started) / 1000 < 15 ? quickFails + 1 : 0;
    if (quickFails >= 4) { u.log(`live ${job.id}: giving up after repeated quick failures`); break; }
    job.stage = 'Reconnecting';
    job.reconnects = (job.reconnects || 0) + 1;
    if (quickFails >= 1) {
      // The same URL failed straight away: get fresh ones (also tells us if the stream ended).
      try {
        streams = await resolveStreams(job, opts, cookieFile);
      } catch (e) {
        u.log(`live ${job.id}: stream no longer available (${e.message}) - finishing`);
        break;
      }
      if (job.stopRequested) break;
    }
    job.stage = 'Recording';
  }

  if (!parts.length) {
    throw job.stopRequested ? new Error('Stopped before any video was received.') : new Error(lastErr || 'Recording produced no data');
  }
  if (parts.length === 1) return { video: parts[0] };

  job.stage = `Joining ${parts.length} parts`;
  const list = path.join(dir, 'parts.txt');
  fs.writeFileSync(list, parts.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const joined = path.join(dir, 'joined.ts');
  await u.runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-f', 'mpegts', joined], { job });
  return { video: joined };
}

async function resolveStreams(job, opts, cookieFile) {
  const res = await yt.run([...yt.commonArgs({ cookieFile, headers: opts.headers }),
    '-j', '-f', LIVE_FORMATS[opts.quality] || LIVE_FORMATS[1080], opts.url], { job, keepStdout: true });
  if (res.code !== 0 || !res.stdout.trim()) throw yt.errorFrom(res.stderr, opts.cookies);
  const info = JSON.parse(res.stdout.trim().split('\n').pop());
  return (info.requested_formats || [info]).map(s => {
    const headers = Object.entries(s.http_headers || info.http_headers || {}).map(([k, v]) => `${k}: ${v}`);
    const ck = s.cookies || info.cookies;
    if (ck) headers.push(`Cookie: ${ck}`);
    return { url: s.url, headers };
  });
}

// One ffmpeg run into `ts`. Resolves { code, err } when it exits for any reason.
function recordPart(job, streams, ts) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const s of streams) {
    if (s.headers.length) args.push('-headers', s.headers.join('\r\n') + '\r\n');
    args.push('-fflags', '+genpts+discardcorrupt',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', s.url);
  }
  // Only picture and sound: Twitch feeds also carry a timed-ID3 metadata track whose odd
  // timestamps can make ffmpeg abort ("Error muxing a packet").
  streams.forEach((s, i) => args.push('-map', `${i}:v?`, '-map', `${i}:a?`));
  args.push('-c', 'copy', '-f', 'mpegts', ts);

  return new Promise(resolve => {
    const ff = spawn(config.ffmpegPath, args, { windowsHide: true });
    job._procs.add(ff);
    let ffErr = '';
    ff.stderr.on('data', d => { ffErr = (ffErr + d).slice(-3000); });
    ff.stdin.on('error', () => {});
    ff.on('error', e => resolve({ code: -1, err: e.message }));
    job._onStop = () => {
      job.stopRequested = true;
      try { ff.stdin.write('q'); } catch { /* already gone */ }
      setTimeout(() => { if (ff.exitCode === null) u.killTree(ff.pid); }, 15000);
    };
    ff.on('close', code => {
      job._procs.delete(ff);
      u.log(`live ${job.id} ffmpeg exited (code ${code}, stop requested: ${!!job.stopRequested}, ${Math.round(job.elapsed)}s, ${fileSize(ts)} bytes)`,
        ffErr ? `last output: ${u.lastLines(ffErr, 3)}` : '');
      resolve({ code, err: u.lastLines(ffErr, 2) });
    });
  });
}

async function recordFromStart(job, opts, dir, cookieFile) {
  const args = [...yt.commonArgs({ cookieFile, headers: opts.headers }),
    '--live-from-start', '--no-part',
    '-f', `bv*[height<=${opts.quality === 'best' ? 9999 : opts.quality || 1080}]+ba/b`,
    '-S', 'vcodec:h264,acodec:aac',
    '-P', dir, '-o', 'rec.%(ext)s', '--merge-output-format', 'mp4', opts.url];
  let stopped = false;
  job._onStop = () => { stopped = true; for (const p of job._procs) u.killTree(p.pid); };
  const res = await yt.run(args, { job });

  // Finished on its own (stream ended) -> merged file exists.
  const merged = path.join(dir, 'rec.mp4');
  if (!stopped && res.code === 0 && fs.existsSync(merged)) return { video: merged };

  // Stopped part-way: pick the biggest video-ish and audio-ish leftovers.
  const parts = fs.readdirSync(dir)
    .filter(f => /^rec\./.test(f) && !/\.(json|ytdl)$/.test(f))
    .map(f => path.join(dir, f))
    .filter(f => fileSize(f) > 10 * 1024);
  if (!parts.length) throw stopped ? new Error('Stopped before any video was received.') : yt.errorFrom(res.stderr, opts.cookies);
  const probed = [];
  for (const p of parts) probed.push({ p, info: await u.probe(p).catch(() => ({})), size: fileSize(p) });
  const video = probed.filter(x => x.info.vcodec).sort((a, b) => b.size - a.size)[0];
  const audio = probed.filter(x => x.info.acodec && !x.info.vcodec).sort((a, b) => b.size - a.size)[0]
    || probed.filter(x => x.info.acodec).sort((a, b) => b.size - a.size)[0];
  if (!video && !audio) throw new Error('Recording could not be read.');
  return { video: video && video.p, audio: audio && audio.p };
}

function fileSize(f) {
  try { return fs.statSync(f).size; } catch { return 0; }
}

function dirSize(dir) {
  try { return fs.readdirSync(dir).reduce((n, f) => n + fileSize(path.join(dir, f)), 0); } catch { return 0; }
}

module.exports = { record };
