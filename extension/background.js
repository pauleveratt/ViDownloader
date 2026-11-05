// Service worker: media sniffer (per-tab list of detected streams/files) and tab-recording control.
import { api, getSettings } from './common.js';

// ---------------------------------------------------------------- media sniffer

const AD_HOSTS = /doubleclick|googlesyndication|googleadservices|imasdk|adservice|adnxs|moatads|amazon-adsystem|adsrvr|advertising|\bads?\./i;
// YouTube is handled by yt-dlp directly; its player fetches hundreds of range requests.
const SKIP_HOSTS = /(^|\.)googlevideo\.com$|(^|\.)ytimg\.com$/i;
const SEGMENT = /\.(ts|m4s|aac|m4a|vtt|webvtt|key)(\?|#|$)|[/_-](seg|segment|frag|chunk)[-_]?\d+|\/range\/|[?&](range|bytestart)=/i;
const FILE_EXT = /\.(mp4|webm|mov|m4v|mkv|flv)(\?|#|$)/i;
const MIN_FILE_SIZE = 512 * 1024;

const sniffed = new Map(); // tabId -> Map(key -> item)
let loaded = false;

async function loadState() {
  if (loaded) return;
  const all = await chrome.storage.session.get(null);
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('sniff_')) sniffed.set(Number(k.slice(6)), new Map(v.map(i => [i.key, i])));
  }
  loaded = true;
}

const saveTimers = new Map();
function saveTab(tabId) {
  clearTimeout(saveTimers.get(tabId));
  saveTimers.set(tabId, setTimeout(() => {
    const items = sniffed.get(tabId);
    if (items && items.size) chrome.storage.session.set({ [`sniff_${tabId}`]: [...items.values()].slice(-120) });
    else chrome.storage.session.remove(`sniff_${tabId}`);
    updateBadge(tabId);
  }, 300));
}

function header(headers, name) {
  const h = (headers || []).find(x => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

// Instagram plays video as separate video-only and audio-only MP4s fetched in byte ranges.
// The `efg` parameter is base64 JSON describing the file (use, codec, resolution, duration,
// asset id). Without the byte range the URL returns the whole file.
function instagramStream(url) {
  if (!/(^|\.)(fbcdn\.net|cdninstagram\.com)$/.test(url.hostname) || !url.searchParams.has('efg')) return null;
  let efg;
  try { efg = JSON.parse(atob(decodeURIComponent(url.searchParams.get('efg')))); } catch { return null; }
  const tag = String(efg.vencode_tag || '');
  if (!/dash|audio/i.test(tag)) return null; // images also carry efg
  const use = (/^ig-xpvds\.([a-z_]+)\./i.exec(tag) || [, 'video'])[1].toLowerCase();
  if (use === 'ad') return { ad: true };
  const clean = new URL(url.href);
  clean.searchParams.delete('bytestart');
  clean.searchParams.delete('byteend');
  return {
    url: clean.href,
    use,
    audio: /audio/i.test(tag),
    height: +((/(\d{3,4})p\b/.exec(tag) || [])[1]) || null,
    duration: efg.duration_s || null,
    assetId: efg.xpv_asset_id ? String(efg.xpv_asset_id) : null,
  };
}

function classify(d) {
  if (d.tabId < 0 || d.statusCode >= 400) return null;
  let url;
  try { url = new URL(d.url); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || SKIP_HOSTS.test(url.hostname) || AD_HOSTS.test(url.hostname)) return null;
  const ig = instagramStream(url);
  if (ig) return ig.ad ? null : { kind: 'IG', ig, chunk: +header(d.responseHeaders, 'content-length') || 0 };
  const ct = header(d.responseHeaders, 'content-type').toLowerCase();
  const path = url.pathname;

  if (/\.m3u8$/i.test(path) || /mpegurl/.test(ct)) return { kind: 'HLS' };
  if (/\.mpd$/i.test(path) || /dash\+xml/.test(ct)) return { kind: 'DASH' };
  if (SEGMENT.test(d.url) || /mp2t|audio\//.test(ct)) return null;
  if (FILE_EXT.test(path) || /^video\//.test(ct)) {
    const range = header(d.responseHeaders, 'content-range');
    const total = range && /\/(\d+)$/.exec(range);
    const size = total ? +total[1] : (d.statusCode === 200 ? +header(d.responseHeaders, 'content-length') || 0 : 0);
    if (size && size < MIN_FILE_SIZE) return null;
    if (!size && d.type !== 'media') return null;
    return { kind: (/\.(\w+)(\?|$)/.exec(path) || [, 'video'])[1].toUpperCase().replace('VIDEO', 'FILE'), size };
  }
  return null;
}

chrome.webRequest.onHeadersReceived.addListener(async d => {
  const c = classify(d);
  if (!c) return;
  await loadState();
  const url = new URL(d.url);
  const key = url.origin + url.pathname;
  if (!sniffed.has(d.tabId)) sniffed.set(d.tabId, new Map());
  const items = sniffed.get(d.tabId);
  const existing = items.get(key);
  if (c.ig) {
    // Track how much of each file was fetched: the one being watched keeps growing.
    const item = existing || { key, kind: 'IG', host: url.hostname, live: false, size: 0, loaded: 0, ...c.ig, hidden: c.ig.audio };
    item.url = c.ig.url;
    item.loaded += c.chunk;
    item.time = Date.now();
    items.set(key, item);
    if (items.size > 120) items.delete(items.keys().next().value); // oldest first
    saveTab(d.tabId);
    return;
  }
  if (existing) {
    existing.url = d.url; // keep the freshest signed URL
    existing.time = Date.now();
    if (c.size > (existing.size || 0)) existing.size = c.size;
    saveTab(d.tabId);
    return;
  }
  const item = { key, url: d.url, kind: c.kind, size: c.size || 0, time: Date.now(), host: url.hostname,
    height: null, live: null, duration: null, hidden: false };
  items.set(key, item);
  // A variant playlist we already know belongs to a master is hidden from the list.
  for (const other of items.values()) if (other.variantKeys && other.variantKeys.includes(key)) item.hidden = true;
  saveTab(d.tabId);
  if (item.kind === 'HLS') inspectHls(d.tabId, item).catch(() => {});
}, { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] }, ['responseHeaders']);

// Reads an HLS playlist to find resolution, duration and whether it's live.
async function inspectHls(tabId, item) {
  const text = await (await fetch(item.url, { credentials: 'include' })).text();
  if (!/^#EXTM3U/.test(text.trim())) return;
  const items = sniffed.get(tabId);
  if (/#EXT-X-STREAM-INF/.test(text)) {
    const variants = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /^#EXT-X-STREAM-INF:(.*)$/.exec(lines[i]);
      if (!m) continue;
      const res = /RESOLUTION=\d+x(\d+)/.exec(m[1]);
      const uri = (lines.slice(i + 1).find(l => l && !l.startsWith('#')) || '').trim();
      if (uri) variants.push({ height: res ? +res[1] : 0, url: new URL(uri, item.url).href });
    }
    variants.sort((a, b) => b.height - a.height);
    item.height = variants[0] ? variants[0].height || null : null;
    item.variantKeys = variants.map(v => { const u = new URL(v.url); return u.origin + u.pathname; });
    for (const k of item.variantKeys) if (items.has(k)) items.get(k).hidden = true;
    if (variants[0]) {
      const sub = await (await fetch(variants[0].url, { credentials: 'include' })).text();
      Object.assign(item, mediaPlaylistInfo(sub));
    }
  } else {
    Object.assign(item, mediaPlaylistInfo(text));
  }
  saveTab(tabId);
}

function mediaPlaylistInfo(text) {
  const live = !/#EXT-X-ENDLIST/.test(text) && !/#EXT-X-PLAYLIST-TYPE:VOD/.test(text);
  let duration = 0;
  for (const m of text.matchAll(/#EXTINF:([\d.]+)/g)) duration += parseFloat(m[1]);
  return { live, duration: live ? null : Math.round(duration) || null };
}

// Reset a tab's list when it moves to another site. Within a site (e.g. Instagram, where every
// story/reel changes the URL and the next one is preloaded beforehand) the list is kept.
const tabOrigins = new Map();
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (!change.url) return;
  let origin = '';
  try { origin = new URL(change.url).origin; } catch { /* non-URL */ }
  const prev = tabOrigins.get(tabId);
  tabOrigins.set(tabId, origin);
  if (prev === origin) return;
  await loadState();
  if (sniffed.has(tabId)) { sniffed.delete(tabId); saveTab(tabId); }
});

chrome.tabs.onRemoved.addListener(async tabId => {
  await loadState();
  sniffed.delete(tabId);
  chrome.storage.session.remove(`sniff_${tabId}`);
  const { rec } = await chrome.storage.session.get('rec');
  if (rec && rec.tabId === tabId) stopTabRecording();
});

// Badge priority on every tab: recording ("REC", red) > downloading (progress, blue) >
// detected-media count for that tab (purple).
async function updateBadge(tabId) {
  const { rec } = await chrome.storage.session.get('rec');
  let text, color;
  if (activity.recording || rec) { text = 'REC'; color = '#e5383b'; }
  else if (activity.downloading) { text = activity.percent !== null ? `${Math.min(99, activity.percent)}%` : '•••'; color = '#2f6fdb'; }
  else {
    const items = [...(sniffed.get(tabId) || new Map()).values()].filter(i => !i.hidden);
    text = items.length ? String(items.length) : '';
    color = '#5b5bd6';
  }
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

// ---------------------------------------------------------------- activity indicator
// While anything runs in the helper, poll it every 2 s and show it on the toolbar icon:
// a red dot + "REC" while recording, progress while downloading. Each poll calls extension
// APIs, which keeps this service worker alive until the work is done.

const activity = { recording: 0, downloading: 0, percent: null, title: '' };
let monitoring = false;

async function pollActivity() {
  let jobs = [];
  try { jobs = await api('/jobs'); } catch { /* helper offline: treat as idle */ }
  const running = jobs.filter(j => !j.finishedAt);
  // A stopped recording that's being converted/saved counts as working, not recording.
  const recs = running.filter(j => (j.type === 'live' || j.type === 'tabrec') && j.status === 'running');
  const dls = running.filter(j => !recs.includes(j));
  const pcts = dls.map(j => j.progress).filter(p => typeof p === 'number');
  Object.assign(activity, {
    recording: recs.length,
    downloading: dls.length,
    percent: pcts.length ? Math.floor(Math.min(...pcts)) : null,
    title: recs.length ? `ViDownloader · recording: ${recs.map(j => j.title || 'stream').join(', ')}`
      : dls.length ? `ViDownloader · ${dls.length > 1 ? `${dls.length} downloads` : 'downloading'}${pcts.length ? ` (${Math.floor(Math.min(...pcts))}%)` : ''}`
      : 'ViDownloader',
  });
  await applyIndicator();
  return running.length > 0;
}

async function monitorActivity() {
  if (monitoring) return;
  monitoring = true;
  try {
    while (await pollActivity()) await new Promise(r => setTimeout(r, 2000));
  } finally {
    monitoring = false;
  }
}

let recordingIcon = null;
// The normal icon with a red dot in the top-right corner.
async function getRecordingIcon() {
  if (recordingIcon) return recordingIcon;
  const imageData = {};
  for (const size of [16, 32]) {
    const bmp = await createImageBitmap(await (await fetch(chrome.runtime.getURL(`icons/icon${size}.png`))).blob());
    const canvas = new OffscreenCanvas(size, size);
    const g = canvas.getContext('2d');
    g.drawImage(bmp, 0, 0, size, size);
    const r = size * 0.24;
    g.beginPath();
    g.arc(size - r - size * 0.03, r + size * 0.03, r, 0, Math.PI * 2);
    g.fillStyle = '#e5383b';
    g.fill();
    g.lineWidth = Math.max(1, size / 14);
    g.strokeStyle = '#ffffff';
    g.stroke();
    imageData[size] = g.getImageData(0, 0, size, size);
  }
  return (recordingIcon = imageData);
}

let lastIconState = null;
async function applyIndicator() {
  const { rec } = await chrome.storage.session.get('rec');
  const recording = !!(activity.recording || rec);
  if (recording !== lastIconState) {
    lastIconState = recording;
    if (recording) await chrome.action.setIcon({ imageData: await getRecordingIcon() }).catch(() => {});
    else await chrome.action.setIcon({ path: { 16: 'icons/icon16.png', 32: 'icons/icon32.png' } }).catch(() => {});
  }
  chrome.action.setTitle({ title: activity.title || 'ViDownloader' }).catch(() => {});
  // Global badge for tabs without their own, then refresh tabs that have their own badge.
  if (recording) { chrome.action.setBadgeBackgroundColor({ color: '#e5383b' }); chrome.action.setBadgeText({ text: 'REC' }); }
  else if (activity.downloading) { chrome.action.setBadgeBackgroundColor({ color: '#2f6fdb' }); chrome.action.setBadgeText({ text: activity.percent !== null ? `${Math.min(99, activity.percent)}%` : '•••' }); }
  else chrome.action.setBadgeText({ text: '' });
  await loadState();
  const tabs = new Set([...sniffed.keys(), ...(rec ? [rec.tabId] : [])]);
  for (const tabId of tabs) updateBadge(tabId);
}

// ---------------------------------------------------------------- tab recording

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Record the video and audio of a tab the user chose',
  });
}

async function startTabRecording({ tabId, title, url }) {
  const { rec } = await chrome.storage.session.get('rec');
  if (rec) throw new Error('Already recording a tab. Stop that recording first.');
  const settings = await getSettings();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const { id } = await api('/tabrec/start', { method: 'POST', body: { pageTitle: title, pageUrl: url }, settings });
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId, jobId: id, port: settings.port, token: settings.token });
  if (!res || !res.ok) {
    api(`/tabrec/${id}/stop`, { method: 'POST', settings }).catch(() => {});
    throw new Error((res && res.error) || 'Could not start recording');
  }
  await chrome.storage.session.set({ rec: { tabId, jobId: id, startedAt: Date.now() } });
  updateBadge(tabId);
  // Many players (Instagram, TikTok...) pause when their tab is hidden or the window loses focus,
  // which would freeze the recording. Make the page believe it's visible and focused, and stop
  // Chrome discarding the tab to save memory.
  chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: keepPageActive }).catch(() => {});
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  applyIndicator();
  monitorActivity();
  return { jobId: id };
}

// Runs in the recorded page itself (main world). Turned off again when the recording ends.
function keepPageActive() {
  const first = window.__vidKeepActive === undefined;
  window.__vidKeepActive = true;
  if (!first) return;
  const fixed = (proto, prop, value) => {
    try { Object.defineProperty(proto, prop, { configurable: true, get: () => value }); } catch { /* not overridable */ }
  };
  fixed(Document.prototype, 'hidden', false);
  fixed(Document.prototype, 'webkitHidden', false);
  fixed(Document.prototype, 'visibilityState', 'visible');
  fixed(Document.prototype, 'webkitVisibilityState', 'visible');
  Document.prototype.hasFocus = () => true;
  const swallow = e => { if (window.__vidKeepActive) e.stopImmediatePropagation(); };
  for (const type of ['visibilitychange', 'webkitvisibilitychange', 'blur', 'pagehide', 'freeze']) {
    window.addEventListener(type, swallow, true);
    document.addEventListener(type, swallow, true);
  }
  // Listeners the site registered before this ran (e.g. window "blur") can't be blocked, so
  // also undo pauses the user didn't make: a pause with no click/key in the page just before.
  let lastInput = 0;
  for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => { lastInput = Date.now(); }, true);
  document.addEventListener('pause', e => {
    const media = e.target;
    if (!window.__vidKeepActive || !(media instanceof HTMLMediaElement) || media.ended) return;
    if (Date.now() - lastInput < 1500) return; // the user paused it
    setTimeout(() => { if (media.paused && !media.ended) media.play().catch(() => {}); }, 150);
  }, true);
}

// Stops keepPageActive's interference once the recording is over.
function releasePage() {
  window.__vidKeepActive = false;
}

async function stopTabRecording() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
  else await recordingEnded();
}

async function recordingEnded() {
  const { rec } = await chrome.storage.session.get('rec');
  await chrome.storage.session.remove('rec');
  pollActivity(); // the helper may still be converting; the indicator follows it
  monitorActivity();
  if (rec) {
    updateBadge(rec.tabId);
    chrome.scripting.executeScript({ target: { tabId: rec.tabId, allFrames: true }, world: 'MAIN', func: releasePage }).catch(() => {});
    chrome.tabs.update(rec.tabId, { autoDiscardable: true }).catch(() => {});
  }
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) chrome.offscreen.closeDocument().catch(() => {});
}

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target === 'offscreen') return false;
  const handlers = {
    'get-sniffed': async () => {
      await loadState();
      // msg.all includes hidden items (e.g. Instagram audio files the popup pairs with video).
      return [...(sniffed.get(msg.tabId) || new Map()).values()].filter(i => msg.all || !i.hidden).sort((a, b) => b.time - a.time);
    },
    'clear-sniffed': async () => {
      await loadState();
      sniffed.delete(msg.tabId);
      saveTab(msg.tabId);
      return true;
    },
    'get-rec': async () => (await chrome.storage.session.get('rec')).rec || null,
    'tabrec-start': () => startTabRecording(msg),
    'tabrec-stop': async () => { await stopTabRecording(); return true; },
    'tabrec-ended': async () => { await recordingEnded(); return true; },
    'jobs-changed': async () => { monitorActivity(); return true; },
  };
  const h = handlers[msg.type];
  if (!h) return false;
  h().then(result => reply({ ok: true, result }), e => reply({ ok: false, error: e.message }));
  return true;
});

// ---------------------------------------------------------------- dev auto-reload
// Reloads the unpacked extension when its files change on disk (skipped while recording a tab).

let devVersion = null;
async function checkDevReload() {
  try {
    const { version } = await api('/dev/ext-version');
    const { rec } = await chrome.storage.session.get('rec');
    if (devVersion === null) devVersion = version;
    else if (version !== devVersion && !rec) chrome.runtime.reload();
  } catch { /* helper offline */ }
}
chrome.alarms.clear('dev-reload'); // old name of the alarm below
chrome.alarms.create('tick', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name !== 'tick') return;
  checkDevReload();
  monitorActivity(); // also picks up jobs started while the worker was asleep
});
checkDevReload();
monitorActivity();

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  const { token } = await getSettings();
  if (!token) chrome.runtime.openOptionsPage();
});
