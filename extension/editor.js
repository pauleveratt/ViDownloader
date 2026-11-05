import { api, getSettings, el, parseTime } from './common.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const file = params.get('file');

const state = {
  info: null,
  fps: 30,
  duration: 0,
  segments: [],      // [{ id, start, end }]
  active: null,      // id of the selected segment
  inPoint: null,     // pending start set with I
  join: true,
  jobId: null,
};
let nextId = 1;
const video = $('video');

// ---------------------------------------------------------------- time helpers

// 72.4 -> "1:12.40"
function tc(sec) {
  if (!Number.isFinite(sec)) return '0:00.00';
  const sign = sec < 0 ? '-' : '';
  sec = Math.abs(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ss = s.toFixed(2).padStart(5, '0');
  return h ? `${sign}${h}:${String(m).padStart(2, '0')}:${ss}` : `${sign}${m}:${ss}`;
}

const snap = t => Math.min(state.duration, Math.max(0, Math.round(t * state.fps) / state.fps));
const pct = t => `${(t / state.duration) * 100}%`;

// ---------------------------------------------------------------- load

init().catch(e => fail(e.message));

async function init() {
  if (!file) return fail('No file was given.');
  const settings = await getSettings();
  const info = await api(`/probe?file=${encodeURIComponent(file)}`).catch(e => {
    throw new Error(e.status === 404 ? 'This file was moved or deleted.' : e.status === 0 ? 'The helper is not running.' : e.message);
  });
  state.info = info;
  state.fps = info.fps && info.fps < 240 ? info.fps : 30;
  document.title = `Edit · ${info.title || info.name}`;
  $('title').textContent = info.title || info.name;
  $('title').title = info.name;
  $('meta').replaceChildren(
    ...(info.platform ? [el('span', { class: 'chip accent', text: info.platform })] : []),
    ...(info.uploader ? [el('span', { text: info.uploader })] : []),
    el('span', { class: 'ellipsis', text: info.name, title: file }),
    ...(info.height ? [el('span', { text: `${info.width}×${info.height}${info.fps ? ` · ${Math.round(info.fps)} fps` : ''}` })] : []),
  );
  const audioOnly = !info.vcodec;
  $('player').classList.toggle('audio', audioOnly);
  $('audioOnly').hidden = !audioOnly;
  const ext = (file.match(/\.(\w+)$/) || [, ''])[1].toLowerCase();
  $('exportHint').textContent = audioOnly
    ? `Saved next to the original as ${ext.toUpperCase() || 'audio'}. The original isn't changed.`
    : 'Saved next to the original as H.264/AAC MP4. The original isn\'t changed.';

  const src = `http://127.0.0.1:${settings.port}/media?file=${encodeURIComponent(file)}&t=${encodeURIComponent(settings.token)}`;
  video.src = window.vidMediaUrl ? window.vidMediaUrl(src) : src; // dev harness routes it through its proxy
  video.addEventListener('loadedmetadata', () => {
    state.duration = Number.isFinite(video.duration) ? video.duration : info.duration || 0;
    $('dur').textContent = tc(state.duration);
    $('editor').hidden = false;
    $('lower').hidden = false;
    drawTicks();
    render();
  }, { once: true });
  video.addEventListener('error', () => fail('The file could not be played in the browser.'), { once: true });
  wire();
}

function fail(msg) {
  $('loadError').textContent = msg;
  $('loadError').hidden = false;
  $('title').textContent = 'Can\'t open this file';
}

// ---------------------------------------------------------------- controls

function wire() {
  $('showOriginal').onclick = () => api('/reveal', { method: 'POST', body: { file } }).catch(() => {});
  $('playBtn').onclick = togglePlay;
  $('backFrame').onclick = () => step(-1 / state.fps);
  $('fwdFrame').onclick = () => step(1 / state.fps);
  $('markIn').onclick = markIn;
  $('markOut').onclick = markOut;
  $('clearSegs').onclick = () => { state.segments = []; state.active = null; state.inPoint = null; render(); };
  $('exportBtn').onclick = exportEdit;
  $('exportCancel').onclick = () => state.jobId && api(`/jobs/${state.jobId}/stop`, { method: 'POST' });
  for (const b of $('joinSeg').querySelectorAll('button')) {
    b.onclick = () => { state.join = b.dataset.join === '1'; render(); };
  }
  video.addEventListener('play', syncPlayIcon);
  video.addEventListener('pause', syncPlayIcon);
  video.addEventListener('timeupdate', onTime);
  requestAnimationFrame(function tick() { movePlayhead(); requestAnimationFrame(tick); });

  // Click the track to seek.
  $('track').addEventListener('pointerdown', e => {
    if (e.target.closest('.seg-block')) return;
    const seekTo = clientToTime(e.clientX);
    video.currentTime = seekTo;
    const move = ev => { video.currentTime = clientToTime(ev.clientX); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  document.addEventListener('keydown', e => {
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); togglePlay(); }
    else if (k === 'i') markIn();
    else if (k === 'o') markOut();
    else if (k === 'arrowleft') { e.preventDefault(); step(e.shiftKey ? -1 : -1 / state.fps); }
    else if (k === 'arrowright') { e.preventDefault(); step(e.shiftKey ? 1 : 1 / state.fps); }
    else if ((k === 'delete' || k === 'backspace') && state.active) removeSegment(state.active);
  });
}

function togglePlay() {
  if (video.paused) video.play(); else video.pause();
}

function syncPlayIcon() {
  $('playIcon').innerHTML = video.paused ? '<path d="M8 5v14l11-7z"/>' : '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';
}

function step(delta) {
  video.pause();
  video.currentTime = Math.min(state.duration, Math.max(0, video.currentTime + delta));
}

let stopAt = null; // when previewing a segment
function onTime() {
  $('cur').textContent = tc(video.currentTime);
  if (stopAt !== null && video.currentTime >= stopAt) { video.pause(); stopAt = null; }
}

function movePlayhead() {
  if (state.duration) $('playhead').style.left = pct(video.currentTime);
}

function clientToTime(x) {
  const r = $('track').getBoundingClientRect();
  return Math.min(1, Math.max(0, (x - r.left) / r.width)) * state.duration;
}

// ---------------------------------------------------------------- marking

function markIn() {
  state.inPoint = snap(video.currentTime);
  render();
}

function markOut() {
  const end = snap(video.currentTime);
  let start = state.inPoint;
  if (start === null) {
    // No start marked: begin where the previous segment ended (or at 0).
    const before = state.segments.filter(s => s.end <= end).sort((a, b) => b.end - a.end)[0];
    start = before ? before.end : 0;
  }
  if (end - start < 0.05) {
    flash('Set end must be after the start. Move the playhead forward first.');
    return;
  }
  const seg = { id: nextId++, start, end };
  state.segments.push(seg);
  state.active = seg.id;
  state.inPoint = null;
  render();
}

function removeSegment(id) {
  state.segments = state.segments.filter(s => s.id !== id);
  if (state.active === id) state.active = null;
  render();
}

function sorted() {
  return [...state.segments].sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- render

function render() {
  const segs = sorted();
  // timeline blocks
  $('segLayer').replaceChildren(...segs.map((s, i) => {
    const block = el('div', { class: 'seg-block' + (s.id === state.active ? ' active' : ''), title: `${tc(s.start)} → ${tc(s.end)}` },
      el('span', { class: 'handle l' }), String(i + 1), el('span', { class: 'handle r' }));
    block.style.left = pct(s.start);
    block.style.width = pct(s.end - s.start);
    block.addEventListener('pointerdown', e => {
      state.active = s.id;
      const edge = e.target.classList.contains('l') ? 'start' : e.target.classList.contains('r') ? 'end' : null;
      if (!edge) { video.currentTime = s.start; render(); return; }
      e.preventDefault();
      dragEdge(s, edge);
    });
    return block;
  }));
  $('inMarker').hidden = state.inPoint === null;
  if (state.inPoint !== null) $('inMarker').style.left = pct(state.inPoint);

  // list
  $('segCount').textContent = segs.length;
  $('segCount').className = 'chip' + (segs.length ? ' accent' : '');
  $('segEmpty').hidden = segs.length > 0;
  $('clearSegs').hidden = !segs.length;
  $('segList').replaceChildren(...segs.map((s, i) => segRow(s, i)));

  // export
  for (const b of $('joinSeg').querySelectorAll('button')) b.classList.toggle('on', (b.dataset.join === '1') === state.join);
  $('joinSeg').hidden = segs.length < 2;
  const total = segs.reduce((n, s) => n + s.end - s.start, 0);
  $('exportBtn').disabled = !segs.length || !!state.jobId;
  $('exportBtn').textContent = !segs.length ? 'Export'
    : segs.length === 1 ? `Export clip (${tc(total)})`
    : state.join ? `Export ${segs.length} segments as one file (${tc(total)})` : `Export ${segs.length} separate clips`;
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

function segRow(s, i) {
  const input = which => {
    const inp = el('input', { type: 'text', value: tc(s[which]), spellcheck: 'false', title: which === 'start' ? 'Start' : 'End' });
    inp.addEventListener('focus', () => { state.active = s.id; markActive(); });
    inp.addEventListener('change', () => {
      const t = parseTime(inp.value);
      const other = which === 'start' ? s.end : s.start;
      if (t === null || Number.isNaN(t) || t > state.duration || (which === 'start' ? t >= other - 0.05 : t <= other + 0.05)) {
        inp.classList.add('invalid');
        setTimeout(() => { inp.classList.remove('invalid'); inp.value = tc(s[which]); }, 1200);
        return;
      }
      s[which] = snap(t);
      video.currentTime = s[which];
      render();
    });
    return inp;
  };
  const play = el('button', { class: 'btn ghost small', title: 'Play this segment' });
  play.innerHTML = ICONS.play;
  play.onclick = () => { state.active = s.id; markActive(); video.currentTime = s.start; stopAt = s.end; video.play(); };
  const del = el('button', { class: 'btn ghost small', title: 'Remove (Delete)' });
  del.innerHTML = ICONS.del;
  del.onclick = () => removeSegment(s.id);
  return el('div', { class: 'seg-row' + (s.id === state.active ? ' active' : ''), dataset: { id: s.id } },
    el('span', { class: 'num', text: i + 1 }),
    input('start'), input('end'),
    el('span', { class: 'len', text: tc(s.end - s.start) }),
    el('div', { class: 'acts' }, play, del));
}

function markActive() {
  for (const r of document.querySelectorAll('.seg-row')) r.classList.toggle('active', Number(r.dataset.id) === state.active);
  const segs = sorted();
  document.querySelectorAll('.seg-block').forEach((b, i) => b.classList.toggle('active', segs[i] && segs[i].id === state.active));
}

// Drag a segment's start/end edge; the video follows so you can see the exact frame.
function dragEdge(s, edge) {
  video.pause();
  const move = ev => {
    const t = snap(clientToTime(ev.clientX));
    if (edge === 'start') s.start = Math.min(t, s.end - 1 / state.fps);
    else s.end = Math.max(t, s.start + 1 / state.fps);
    video.currentTime = s[edge];
    render();
  };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function drawTicks() {
  const n = 6;
  $('ticks').replaceChildren(...Array.from({ length: n + 1 }, (_, i) => {
    const t = (state.duration * i) / n;
    const span = el('span', { text: tc(t).replace(/\.\d\d$/, '') });
    span.style.left = `${(i / n) * 100}%`;
    return span;
  }));
}

function flash(msg) {
  const e = $('loadError');
  e.textContent = msg;
  e.hidden = false;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { e.hidden = true; }, 3000);
}

// ---------------------------------------------------------------- export

async function exportEdit() {
  const segments = sorted().map(s => ({ start: s.start, end: s.end }));
  try {
    const { id } = await api('/edit', { method: 'POST', body: { file, segments, join: state.join } });
    state.jobId = id;
  } catch (e) {
    return flash(e.message);
  }
  $('exportStatus').hidden = false;
  render();
  pollExport();
}

async function pollExport() {
  const jobs = await api('/jobs').catch(() => []);
  const job = jobs.find(j => j.id === state.jobId);
  if (!job) { state.jobId = null; $('exportStatus').hidden = true; render(); return; }
  const bar = $('exportBar');
  bar.querySelector('i').style.width = `${job.progress ?? 0}%`;
  $('exportStage').textContent = `${job.stage}${job.progress != null && !job.finishedAt ? ` · ${Math.floor(job.progress)}%` : ''}`;
  if (!job.finishedAt) { setTimeout(pollExport, 500); return; }

  state.jobId = null;
  $('exportStatus').hidden = true;
  if (job.status === 'done') {
    $('exportResults').prepend(...job.files.map(f => {
      const show = el('button', { class: 'btn small', text: 'Show' });
      show.onclick = () => api('/reveal', { method: 'POST', body: { file: f } });
      return el('div', { class: 'result-row' },
        el('span', { class: 'ok-text', text: '✓' }),
        el('span', { class: 'name ellipsis', text: f.split('\\').pop(), title: f }),
        show);
    }));
  } else if (job.status === 'error') {
    flash(job.error || 'Export failed');
  }
  render();
}
