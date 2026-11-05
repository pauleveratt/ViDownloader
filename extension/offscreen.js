// Offscreen document: records a captured tab with MediaRecorder and streams the WebM
// to the helper in small chunks so nothing large is kept in browser memory.
let recorder = null;
let stream = null;
let audioCtx = null;
let queue = Promise.resolve();
let seq = 0;
let job = null; // { id, base, token }
let failed = null;

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target !== 'offscreen') return false;
  if (msg.type === 'start') {
    start(msg).then(() => reply({ ok: true }), e => { cleanup(); reply({ ok: false, error: e.message }); });
    return true;
  }
  if (msg.type === 'stop') { stop(); reply({ ok: true }); }
  return false;
});

async function start({ streamId, jobId, port, token }) {
  if (recorder) throw new Error('Already recording');
  job = { id: jobId, base: `http://127.0.0.1:${port}`, token };
  seq = 0;
  failed = null;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: {
      mandatory: {
        chromeMediaSource: 'tab', chromeMediaSourceId: streamId,
        maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30,
      },
    },
  });
  // Capturing mutes the tab for the user; route the audio back out so they can still hear it.
  audioCtx = new AudioContext();
  audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);

  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(m => MediaRecorder.isTypeSupported(m));
  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
  recorder.ondataavailable = e => {
    if (e.data && e.data.size) queue = queue.then(() => send(e.data));
  };
  recorder.onstop = () => { queue = queue.then(finish); };
  stream.getVideoTracks()[0].addEventListener('ended', stop); // tab closed or navigated away
  recorder.start(2000);
}

async function send(blob) {
  if (failed) return;
  try {
    const res = await fetch(`${job.base}/tabrec/${job.id}/chunk`, {
      method: 'POST',
      headers: { 'X-ViD-Token': job.token, 'X-ViD-Seq': String(seq) },
      body: blob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    seq++;
    if (data.stopRequested) stop(); // Stop was pressed in the job list
  } catch (e) {
    failed = e.message;
    stop();
  }
}

async function finish() {
  try {
    await fetch(`${job.base}/tabrec/${job.id}/stop`, { method: 'POST', headers: { 'X-ViD-Token': job.token } });
  } catch { /* helper gone; it times out on its own */ }
  cleanup();
  chrome.runtime.sendMessage({ type: 'tabrec-ended', error: failed });
}

function stop() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

function cleanup() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  if (audioCtx) audioCtx.close().catch(() => {});
  recorder = null;
  stream = null;
  audioCtx = null;
}
