import {
  api, getSettings, saveSettings, cookiesFor, fmtBytes, fmtDur, parseTime, platformOfUrl, el,
  isEditable, openEditor,
} from './common.js';

const $ = id => document.getElementById(id);
const state = {
  settings: null,
  tab: null,
  info: null,          // summary from helper /info
  mode: 'video',
  liveFrom: 'now',
  jobEls: new Map(),
  rec: null,
  images: [],
  imgSel: new Set(),
  direct: null,        // browser-located media (Instagram) used instead of yt-dlp
  myJobs: new Set(),   // jobs started from this popup (their progress shows in the page card)
  finishedSig: null,
};

const ICON = {
  film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M17 9h4M3 15h4M17 15h4"/></svg>',
};

// ---------------------------------------------------------------- startup

init().catch(e => console.error(e));

async function init() {
  state.settings = await getSettings();
  state.mode = state.settings.mode || 'video';
  $('quality').value = state.settings.quality || '1080';
  $('liveQuality').value = state.settings.quality === 'best' ? 'best' : state.settings.quality || '1080';
  // popup.html?tabId=N lets the popup be opened as a page for a specific tab (handy for testing).
  const forced = new URLSearchParams(location.search).get('tabId');
  if (forced) state.tab = await chrome.tabs.get(Number(forced)).catch(() => null);
  else [state.tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  wireStatic();
  if (!state.settings.token) return showSetup();

  try {
    await api('/ping', { settings: state.settings });
    setStatus(true);
  } catch (e) {
    if (e.status === 401) return showSetup('That token was not accepted. Paste the current one from install.ps1.');
    setStatus(false);
    $('offline').hidden = false;
    return;
  }

  $('more').hidden = false;
  loadPage();
  pollJobs();
  setInterval(pollJobs, 1000);
  loadSniffed();
  setInterval(loadSniffed, 2500);
  loadRec();
  loadImages();
  $('viewHistory').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
  $('clearRecent').onclick = async () => {
    await chrome.storage.local.set({ recentClearedAt: Date.now() });
    loadRecent();
  };
}

function setStatus(ok) {
  const s = $('status');
  s.className = 'dot ' + (ok ? 'on' : 'off');
  s.title = ok ? 'Helper connected' : 'Helper not running';
}

function showSetup(msg) {
  $('setup').hidden = false;
  if (msg) { $('setupMsg').textContent = msg; $('setupMsg').hidden = false; }
  $('setupToken').focus();
}

function wireStatic() {
  $('settingsBtn').onclick = () => chrome.runtime.openOptionsPage();
  $('historyBtn').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
  $('openFolder').onclick = () => api('/open-folder', { method: 'POST' }).catch(showToastError);
  $('setupSave').onclick = async () => {
    const token = $('setupToken').value.trim();
    if (!token) return;
    await saveSettings({ token });
    location.reload();
  };
  $('setupToken').onkeydown = e => { if (e.key === 'Enter') $('setupSave').click(); };

  for (const b of $('modeSeg').querySelectorAll('button')) {
    b.onclick = () => { state.mode = b.dataset.mode; saveSettings({ mode: state.mode }); renderControls(); };
  }
  for (const b of $('liveSeg').querySelectorAll('button')) {
    b.onclick = () => { if (b.disabled) return; state.liveFrom = b.dataset.from; renderLive(); };
  }
  $('quality').onchange = () => { saveSettings({ quality: $('quality').value }); renderControls(); };
  $('start').oninput = $('end').oninput = renderControls;
  for (const b of document.querySelectorAll('.now')) b.onclick = e => { e.preventDefault(); grabCurrentTime(b.dataset.target); };
  $('downloadBtn').onclick = startDownload;
  $('recordLiveBtn').onclick = startLive;
  $('tabrecBtn').onclick = toggleTabRecording;
  $('frameBtn').onclick = saveFrame;
  $('imgBox').addEventListener('toggle', () => { if ($('imgBox').open) loadImages(); });
  $('imgAll').onclick = () => {
    const all = state.imgSel.size === state.images.length;
    state.imgSel = new Set(all ? [] : state.images.map((_, i) => i));
    renderImages();
  };
  $('imgSave').onclick = saveImages;
  $('useLogin').onchange = async () => {
    const host = pageHost();
    const loginHosts = { ...state.settings.loginHosts, [host]: $('useLogin').checked };
    state.settings.loginHosts = loginHosts;
    await saveSettings({ loginHosts });
    loadPage(true);
  };
}

// ---------------------------------------------------------------- current page

function pageHost() {
  try { return new URL(state.tab.url).hostname; } catch { return ''; }
}

function useLoginDefault() {
  const host = pageHost();
  const saved = state.settings.loginHosts[host];
  if (saved !== undefined) return saved;
  // YouTube works without cookies (and can flag accounts that send them). Everywhere else the
  // login matters: e.g. Twitch only serves ad-free streams/VODs to your subscribed account.
  return platformOfUrl(state.tab.url) !== 'YouTube';
}

async function loadPage(fresh = false) {
  const tab = state.tab;
  $('page').hidden = false;
  if (!tab || !/^https?:/.test(tab.url || '')) {
    renderMedia({ title: 'Open a video page', sub: [] , placeholder: true });
    pageMessage('Go to a YouTube, TikTok, Instagram, Twitch (or other) video, then click the ViDownloader icon.');
    $('dlControls').hidden = true;
    return;
  }
  $('loginRow').hidden = false;
  $('useLogin').checked = useLoginDefault();
  pageMessage(null);
  $('dlControls').hidden = true;
  $('liveControls').hidden = true;
  renderMedia(null); // skeleton

  state.direct = null;
  // yt-dlp's Instagram story support needs Instagram's private API, which often refuses it;
  // the story's files are already loaded in the browser, so use those instead.
  if (isIgStory(tab.url)) return loadInstagramStory();

  const cacheKey = `info_${tab.url}_${$('useLogin').checked ? 1 : 0}`;
  if (!fresh) {
    const cached = (await chrome.storage.session.get(cacheKey))[cacheKey];
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return showInfo(cached.info);
  }
  try {
    const info = await api('/info', { method: 'POST', body: { url: tab.url, cookies: await pageCookies() } });
    chrome.storage.session.set({ [cacheKey]: { at: Date.now(), info } });
    showInfo(info);
  } catch (e) {
    state.info = null;
    renderMedia({ title: tab.title || pageHost(), sub: [pageHost()], placeholder: true });
    if (e.status === 0) { setStatus(false); return pageMessage('Lost connection to the helper.', true); }
    if (platformOfUrl(tab.url) === 'Instagram' && await useInstagramFromBrowser('yt-dlp couldn\'t read this post, so this uses the copy your browser loaded.')) return;
    const unsupported = /not supported/i.test(e.message);
    pageMessage(unsupported
      ? 'This page isn\'t directly supported. Use Detected media or Record this tab below.'
      : e.message, !unsupported);
    if (unsupported) $('sniffBox').open = true;
  }
}

// ---------------------------------------------------------------- Instagram from the browser

function isIgStory(url) {
  return /^https:\/\/(www\.)?instagram\.com\/stories\//.test(url || '');
}

// Runs in the page: the video being shown (largest on screen).
function playingVideo() {
  const vids = [...document.querySelectorAll('video')].filter(v => v.readyState >= 1 && Number.isFinite(v.duration));
  const area = v => { const r = v.getBoundingClientRect(); return r.width * r.height; };
  vids.sort((a, b) => area(b) - area(a));
  return vids[0] ? { duration: vids[0].duration, height: vids[0].videoHeight } : null;
}

// Picks the Instagram video file (plus its separate audio file) for what's on screen, from the
// files the browser fetched: same duration as the visible video, the asset that was loaded most,
// at its highest resolution. No requests to Instagram are made here.
async function pickInstagramMedia() {
  const res = await chrome.runtime.sendMessage({ type: 'get-sniffed', tabId: state.tab.id, all: true });
  const items = ((res && res.ok && res.result) || []).filter(i => i.kind === 'IG');
  let vids = items.filter(i => !i.audio);
  if (!vids.length) return null;
  let playing = null;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: state.tab.id }, func: playingVideo });
    playing = r && r.result;
  } catch { /* page not scriptable */ }
  if (playing && playing.duration) {
    const near = vids.filter(v => v.duration && Math.abs(v.duration - playing.duration) <= 1.5);
    if (near.length) vids = near;
  }
  if (isIgStory(state.tab.url)) {
    const stories = vids.filter(v => v.use === 'story');
    if (stories.length) vids = stories;
  }
  const assets = new Map();
  for (const v of vids) {
    const k = v.assetId || v.key;
    const a = assets.get(k) || { loaded: 0, time: 0, variants: [] };
    a.loaded += v.loaded || 0;
    a.time = Math.max(a.time, v.time);
    a.variants.push(v);
    assets.set(k, a);
  }
  const top = [...assets.values()].sort((a, b) => b.loaded - a.loaded || b.time - a.time)[0];
  const video = top.variants.sort((a, b) => (b.height || 0) - (a.height || 0) || b.loaded - a.loaded)[0];
  const audio = items.find(i => i.audio && video.assetId && i.assetId === video.assetId)
    || items.filter(i => i.audio && i.use === video.use && (!video.duration || i.duration === video.duration))
      .sort((a, b) => b.loaded - a.loaded)[0];
  return { video, audio };
}

function igUser(url) {
  const m = /^\/(?:stories\/)?([A-Za-z0-9._]+)\//.exec(new URL(url).pathname);
  return m && !['p', 'reel', 'reels', 'highlights', 'explore'].includes(m[1]) ? m[1] : '';
}

// Sets up the download controls to use the browser-located files. Returns false if none found.
async function useInstagramFromBrowser(note) {
  const pick = await pickInstagramMedia();
  if (!pick) return false;
  const { video, audio } = pick;
  const user = igUser(state.tab.url);
  const storyId = (/\/stories\/[^/]+\/(\d+)/.exec(state.tab.url) || [])[1];
  const title = storyId ? `story ${storyId}` : igPageTitle(state.tab.title) || `${video.use} ${video.assetId || ''}`.trim();
  state.direct = { url: video.url, audioUrl: audio ? audio.url : null, uploader: user, title, duration: video.duration };
  state.info = { platform: 'Instagram', duration: video.duration, maxHeight: video.height, title, uploader: user };
  const sub = [el('span', { class: 'chip accent', text: 'Instagram' }), el('span', { class: 'chip', text: video.use === 'clips' ? 'Reel' : cap(video.use) })];
  if (user) sub.push(el('span', { class: 'ellipsis', text: user }));
  if (video.height) sub.push(el('span', { text: `· ${video.height}p` }));
  renderMedia({ title: storyId ? `${user ? `${user}'s` : 'Instagram'} story` : title, sub, duration: video.duration });
  pageMessage(note + (audio ? '' : ' (No separate audio was found, so it may be silent.)'));
  $('pageMsg').className = 'notice info';
  $('dlControls').hidden = false;
  renderControls();
  return true;
}

async function loadInstagramStory() {
  if (await useInstagramFromBrowser('Saving the story file your browser loaded, at its highest quality.')) return;
  renderMedia({ title: 'Instagram story', sub: [el('span', { class: 'chip accent', text: 'Instagram' })], placeholder: true });
  pageMessage('Let the story play for a second, then reopen this popup. For a photo story, use "Images on this page" below.');
  $('imgBox').open = true;
}

const cap = s => String(s || '').replace(/^\w/, c => c.toUpperCase());
// Instagram tab titles are mostly boilerplate ("Instagram", "Stories • Instagram").
const igPageTitle = t => (/^(\(\d+\)\s*)?(stories\s*•\s*)?instagram$/i.test(String(t || '').trim()) ? '' : String(t || '').trim());

async function pageCookies(extraUrl) {
  if (!$('useLogin').checked) return [];
  return cookiesFor(state.tab.url, ...(extraUrl ? [extraUrl] : []));
}

function showInfo(info) {
  state.info = info;
  const sub = [];
  sub.push(el('span', { class: 'chip accent', text: info.platform === 'Other' ? (info.extractor || pageHost()) : info.platform }));
  if (info.isLive) sub.push(el('span', { class: 'chip live', text: '● LIVE' }));
  if (info.uploader) sub.push(el('span', { class: 'ellipsis', text: info.uploader }));
  if (info.count > 1) sub.push(el('span', { text: `· ${info.count} videos` }));
  renderMedia({ title: info.title, sub, thumbnail: info.thumbnail, duration: info.isLive ? null : info.duration });

  if (info.problem) return pageMessage(info.problem);
  if (info.liveStatus === 'is_upcoming') return pageMessage('This stream hasn\'t started yet.');
  if (info.isLive) {
    $('liveControls').hidden = false;
    const canFromStart = info.platform === 'YouTube' || info.platform === 'Twitch';
    $('fromStartBtn').disabled = !canFromStart;
    $('fromStartBtn').title = canFromStart ? '' : 'Only available for YouTube and Twitch';
    renderLive();
  } else {
    $('dlControls').hidden = false;
    renderControls();
  }
}

function renderMedia(m) {
  const thumb = $('thumb');
  thumb.className = 'thumb';
  thumb.style.backgroundImage = '';
  thumb.innerHTML = '';
  if (!m) {
    thumb.classList.add('skeleton');
    $('title').innerHTML = '<span class="skeleton line"></span><span class="skeleton line short"></span>';
    $('sub').innerHTML = '';
    return;
  }
  if (m.thumbnail) thumb.style.backgroundImage = `url("${m.thumbnail.replace(/"/g, '%22')}")`;
  else { thumb.classList.add('placeholder'); thumb.innerHTML = ICON.film; }
  if (m.duration) thumb.append(el('span', { class: 'dur', text: fmtDur(m.duration) }));
  $('title').textContent = m.title || 'Untitled';
  $('title').title = m.title || '';
  $('sub').replaceChildren(...m.sub.map(s => (typeof s === 'string' ? el('span', { text: s }) : s)));
}

function pageMessage(text, isError) {
  const m = $('pageMsg');
  m.hidden = !text;
  m.className = 'notice' + (isError ? ' err' : '');
  m.textContent = text || '';
}

// ---------------------------------------------------------------- download controls

function trimState() {
  const start = parseTime($('start').value);
  const end = parseTime($('end').value);
  const dur = state.info && state.info.duration;
  let error = '';
  if (Number.isNaN(start)) error = 'Start time looks wrong — use 1:23 or 1:02:03.';
  else if (Number.isNaN(end)) error = 'End time looks wrong — use 1:23 or 1:02:03.';
  else if (start !== null && end !== null && end <= start) error = 'End must be after start.';
  else if (dur && start !== null && start >= dur) error = `Start is past the end of the video (${fmtDur(dur)}).`;
  else if (dur && end !== null && end > dur + 1) error = `End is past the end of the video (${fmtDur(dur)}).`;
  return { start, end, error, trimmed: !error && (start !== null || end !== null), dur };
}

function renderControls() {
  for (const b of $('modeSeg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === state.mode);
  const audio = state.mode !== 'video';
  // Browser-located files come in one quality (the best the page loaded).
  $('qualityField').style.visibility = audio || state.direct ? 'hidden' : '';

  const q = $('quality').value;
  const maxH = state.info && state.info.maxHeight;
  const qh = $('qualityHint');
  qh.hidden = !(!audio && q === 'best' && maxH > 1080);
  qh.className = 'hint warn';
  qh.textContent = `Up to ${maxH}p is available. Above 1080p, YouTube only offers VP9/AV1, so it will be converted to H.264 — this can take a while.`;

  const t = trimState();
  $('start').classList.toggle('invalid', /Start/.test(t.error));
  $('end').classList.toggle('invalid', /End/.test(t.error));
  const th = $('trimHint');
  if (t.error) { th.hidden = false; th.className = 'hint err'; th.textContent = t.error; }
  else if (t.trimmed) {
    const len = (t.end ?? t.dur ?? 0) - (t.start ?? 0);
    th.hidden = false; th.className = 'hint';
    th.textContent = len > 0 ? `Clip length ${fmtDur(len)}` : '';
  } else th.hidden = true;

  const what = audio ? state.mode.toUpperCase() : 'MP4';
  $('downloadLabel').textContent = t.trimmed ? `Download clip (${what})` : `Download ${what}`;
  $('downloadBtn').disabled = !!t.error;
}

async function grabCurrentTime(target) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: state.tab.id, allFrames: true },
      func: () => {
        const vids = [...document.querySelectorAll('video')].filter(v => v.readyState > 0);
        if (!vids.length) return null;
        const area = v => { const r = v.getBoundingClientRect(); return r.width * r.height; };
        vids.sort((a, b) => (b.paused ? 0 : 1) - (a.paused ? 0 : 1) || area(b) - area(a));
        return { t: vids[0].currentTime, area: area(vids[0]), playing: !vids[0].paused };
      },
    });
    const hits = results.map(r => r.result).filter(Boolean).sort((a, b) => b.playing - a.playing || b.area - a.area);
    if (!hits.length) return flash($(target), 'No video found');
    $(target).value = fmtDur(hits[0].t);
    renderControls();
  } catch (e) {
    flash($(target), 'Can\'t read the player');
  }
}

function flash(input, msg) {
  const old = input.placeholder;
  input.value = '';
  input.placeholder = msg;
  input.classList.add('invalid');
  setTimeout(() => { input.placeholder = old; input.classList.remove('invalid'); }, 1800);
}

async function startDownload() {
  const t = trimState();
  if (t.error) return;
  const btn = $('downloadBtn');
  btn.disabled = true;
  try {
    if (state.direct) {
      await startJob('/download', { method: 'POST', body: directBody(state.direct) });
      buttonFeedback(btn, 'downloadLabel', 'Started ✓');
      pollJobs();
      return;
    }
    await startJob('/download', {
      method: 'POST',
      body: {
        url: state.tab.url,
        pageUrl: state.tab.url,
        pageTitle: state.tab.title,
        mode: state.mode,
        quality: $('quality').value,
        start: $('start').value.trim(),
        end: $('end').value.trim(),
        cookies: await pageCookies(),
      },
    });
    buttonFeedback(btn, 'downloadLabel', 'Started ✓');
    pollJobs();
  } catch (e) {
    btn.disabled = false;
    showToastError(e);
  }
}

// Download request for browser-located Instagram files (signed CDN URLs; no cookies needed).
function directBody(d) {
  return {
    url: d.url,
    audioUrl: d.audioUrl,
    direct: true,
    platform: 'Instagram',
    uploader: d.uploader,
    pageTitle: d.title,
    pageUrl: state.tab.url,
    duration: d.duration,
    mode: state.mode,
    start: $('start').value.trim(),
    end: $('end').value.trim(),
    headers: { Referer: 'https://www.instagram.com/', 'User-Agent': navigator.userAgent },
  };
}

function buttonFeedback(btn, labelId, text) {
  const label = $(labelId);
  const old = label.textContent;
  label.textContent = text;
  setTimeout(() => { label.textContent = old; btn.disabled = false; renderControls(); }, 1500);
}

// ---------------------------------------------------------------- live

function renderLive() {
  for (const b of $('liveSeg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.from === state.liveFrom);
}

async function startLive() {
  const btn = $('recordLiveBtn');
  btn.disabled = true;
  try {
    await startJob('/record', {
      method: 'POST',
      body: {
        url: state.tab.url,
        pageUrl: state.tab.url,
        pageTitle: state.tab.title,
        quality: $('liveQuality').value,
        fromStart: state.liveFrom === 'start',
        maxMinutes: parseFloat($('maxMinutes').value) || 0,
        cookies: await pageCookies(),
      },
    });
    pollJobs();
  } catch (e) {
    showToastError(e);
  }
  setTimeout(() => { btn.disabled = false; }, 1500);
}

// ---------------------------------------------------------------- jobs

// Starts a helper job and remembers it, so its progress shows in the page card until the popup closes.
async function startJob(path, opts) {
  const res = await api(path, opts);
  if (res && res.id) state.myJobs.add(res.id);
  chrome.runtime.sendMessage({ type: 'jobs-changed' }).catch(() => {}); // toolbar icon indicator
  pollJobs();
  return res;
}

// Jobs started from this popup (or still running for this page) show inside the page card;
// running jobs for other tabs show at the bottom so they can still be stopped. Finished jobs
// from earlier popups aren't shown - they're in "Recent downloads".
async function pollJobs() {
  let jobs;
  try { jobs = await api('/jobs'); setStatus(true); } catch (e) { if (e.status === 0) setStatus(false); return; }
  const tabUrl = state.tab && state.tab.url;
  const here = jobs.filter(j => state.myJobs.has(j.id) || (!j.finishedAt && j.url === tabUrl));
  const elsewhere = jobs.filter(j => !here.includes(j) && !j.finishedAt);
  const shown = new Set([...here, ...elsewhere].map(j => j.id));
  for (const [id, node] of state.jobEls) if (!shown.has(id)) { node.root.remove(); state.jobEls.delete(id); }
  renderJobs($('pageJobs'), here, true);
  renderJobs($('otherJobs'), elsewhere, false);
  $('pageJobs').hidden = !here.length || $('page').hidden;
  $('otherJobs').hidden = !elsewhere.length;

  // Something finished -> refresh the recent list.
  const finished = jobs.filter(j => j.status === 'done').map(j => j.id).join();
  if (finished !== state.finishedSig) { state.finishedSig = finished; loadRecent(); }
}

function renderJobs(box, list, inline) {
  list.forEach((job, i) => {
    let node = state.jobEls.get(job.id);
    if (!node) { node = makeJobEl(job); state.jobEls.set(job.id, node); }
    node.inline = inline;
    if (box.children[i] !== node.root) box.insertBefore(node.root, box.children[i] || null);
    updateJobEl(node, job);
  });
}

// ---------------------------------------------------------------- recent downloads

const KIND_LABEL = { live: 'Live', tab: 'Tab rec', image: 'Images', frame: 'Frame', sniffed: 'Detected', edit: 'Edited' };

// "Clear" only hides what's listed here (by remembering when it was pressed);
// the History page keeps everything.
async function loadRecent() {
  let all;
  try { all = await api('/history'); } catch { return; }
  const { recentClearedAt = 0 } = await chrome.storage.local.get('recentClearedAt');
  const rows = all.filter(r => new Date(r.date).getTime() > recentClearedAt);
  $('recentSec').hidden = !all.length && $('otherJobs').hidden;
  $('recentEmpty').hidden = rows.length > 0;
  $('clearRecent').hidden = !rows.length;
  $('recent').replaceChildren(...rows.slice(0, 6).map(r => {
    const name = r.title || r.file.split('\\').pop();
    const sub = [r.uploader, KIND_LABEL[r.kind], r.mode && r.mode !== 'video' && r.mode !== 'image' ? r.mode.toUpperCase() : null,
      r.trim ? `clip ${fmtDur(r.trim.start || 0)}–${r.trim.end != null ? fmtDur(r.trim.end) : 'end'}` : null,
      r.count > 1 ? `${r.count} images` : null, r.parts > 1 ? `${r.parts} parts` : null, timeAgo(r.date)].filter(Boolean).join(' · ');
    const show = el('button', { class: 'btn small', text: 'Show', title: r.file });
    show.onclick = () => api('/reveal', { method: 'POST', body: { file: r.file } }).catch(e => {
      show.textContent = e.status === 404 ? 'Moved' : 'Error';
      show.disabled = true;
    });
    const edit = isEditable(r.file) ? el('button', { class: 'btn small', text: 'Edit', title: 'Trim or cut segments', onclick: () => openEditor(r.file) }) : null;
    return el('div', { class: 'recent-row' },
      el('span', { class: 'chip accent', text: r.platform || 'Other' }),
      el('div', { class: 'grow', style: 'min-width:0' },
        el('div', { class: 'recent-title ellipsis', text: name, title: name }),
        el('div', { class: 'hint ellipsis', text: sub })),
      edit, show);
  }));
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function makeJobEl(job) {
  const n = {};
  n.title = el('div', { class: 'job-title ellipsis grow' });
  n.actions = el('div', { class: 'job-actions' });
  n.stage = el('span', { class: 'stage' });
  n.detail = el('span', { class: 'grow ellipsis' });
  n.chip = el('span', { class: 'chip' });
  n.bar = el('div', { class: 'bar' }, n.fill = el('i'));
  n.err = el('div', { class: 'err-msg', hidden: true });
  n.root = el('div', { class: 'job card' },
    el('div', { class: 'job-top' }, n.chip, n.title, n.actions),
    n.bar,
    el('div', { class: 'job-info' }, n.stage, n.detail),
    n.err);
  n.actionKey = '';
  return n;
}

const TYPE_LABEL = { download: null, live: 'LIVE', tabrec: 'TAB', images: 'IMG', frame: 'FRAME' };

// In the page card the video is already shown, so the row says what is being saved instead.
function inlineName(job) {
  if (job.type === 'live') return 'Live recording';
  if (job.type === 'tabrec') return 'Tab recording';
  if (job.type === 'frame') return 'Frame';
  if (job.type === 'images') return 'Images';
  if (job.type === 'edit') return 'Edit';
  const what = job.mode && job.mode !== 'video' ? job.mode.toUpperCase() : 'MP4';
  return job.trim ? `${what} · clip ${job.trim}` : what;
}

function updateJobEl(n, job) {
  const running = !job.finishedAt;
  n.root.className = `job ${n.inline ? 'inline' : 'card'} ${job.status}`;
  const name = n.inline ? inlineName(job) : job.title || job.url || 'Download';
  n.title.textContent = name;
  n.title.title = name;
  const typeLabel = TYPE_LABEL[job.type] || (job.mode && job.mode !== 'video' ? job.mode.toUpperCase() : job.platform || 'VIDEO');
  n.chip.textContent = n.inline ? (running ? '' : job.status === 'done' ? '✓' : '!') : typeLabel;
  n.chip.hidden = n.inline && running;
  n.chip.className = 'chip' + (job.type !== 'download' && running ? ' live' : job.status === 'done' ? ' ok' : '');

  n.stage.textContent = job.status === 'error' ? 'Failed' : job.status === 'stopped' ? 'Stopped' : job.stage;
  const bits = [];
  if (running && job.type !== 'download') bits.push(fmtDur(job.elapsed || 0), fmtBytes(job.bytes));
  else if (running && job.progress !== null) bits.push(`${Math.floor(job.progress)}%`);
  if (running && job.type === 'download' && job.status === 'running') bits.push(job.speed, job.eta && job.eta !== 'NA' ? `${job.eta} left` : '');
  if (job.status === 'done' && job.files[0]) {
    const many = job.type === 'images' ? `${job.files.length} image${job.files.length > 1 ? 's' : ''}` : `${job.files.length} files`;
    bits.push(job.files.length > 1 || job.type === 'images' ? many : `Saved to ${job.platform || 'folder'}`, fmtBytes(job.fileBytes));
  }
  n.detail.textContent = bits.filter(Boolean).join(' · ');
  n.detail.title = job.files[0] || '';

  const pct = job.progress;
  n.bar.hidden = !running && job.status !== 'done';
  n.bar.className = 'bar' + (pct === null && running ? ' indeterminate' : '') + (job.type !== 'download' && running && job.status === 'running' ? ' rec' : '') + (job.status === 'done' ? ' ok' : '');
  n.fill.style.width = `${pct ?? 100}%`;
  if (job.status === 'done') n.bar.hidden = true;

  n.err.hidden = !job.error || job.status !== 'error';
  n.err.textContent = job.error;

  const key = `${job.status}|${job.canStop}|${job.files.length}|${n.inline}`;
  if (key !== n.actionKey) {
    n.actionKey = key;
    const acts = [];
    if (job.canStop) {
      acts.push(el('button', {
        class: 'btn small' + (job.type === 'download' ? '' : ' rec'),
        text: job.type === 'download' ? 'Cancel' : 'Stop',
        onclick: () => stopJob(job),
      }));
    }
    if (job.status === 'done' && job.files.length === 1 && isEditable(job.files[0])) {
      acts.push(el('button', { class: 'btn small', text: 'Edit', title: 'Trim or cut segments', onclick: () => openEditor(job.files[0]) }));
    }
    if (job.status === 'done' && job.files[0]) {
      acts.push(el('button', { class: 'btn small', text: 'Show', title: 'Show in folder', onclick: () => api('/reveal', { method: 'POST', body: { file: job.files[0] } }).catch(showToastError) }));
    }
    if (!running) {
      acts.push(el('button', { class: 'btn ghost small', text: '✕', title: 'Dismiss', onclick: () => { state.myJobs.delete(job.id); pollJobs(); } }));
    }
    n.actions.replaceChildren(...acts);
  }
}

async function stopJob(job) {
  if (job.type === 'tabrec') await chrome.runtime.sendMessage({ type: 'tabrec-stop' });
  else await api(`/jobs/${job.id}/stop`, { method: 'POST' }).catch(showToastError);
  setTimeout(loadRec, 400);
  pollJobs();
}

// ---------------------------------------------------------------- sniffed media

async function loadSniffed() {
  if (!state.tab) return;
  const res = await chrome.runtime.sendMessage({ type: 'get-sniffed', tabId: state.tab.id, all: true });
  const all = (res && res.ok && res.result) || [];
  state.sniffedAll = all;
  // Instagram lists every resolution of a clip separately; show one row per clip (its best).
  const bestIg = new Map();
  for (const i of all) {
    if (i.kind !== 'IG' || i.audio) continue;
    const k = i.assetId || i.key;
    const cur = bestIg.get(k);
    if (!cur || (i.height || 0) > (cur.height || 0)) bestIg.set(k, { ...i, loaded: (cur ? cur.loaded : 0) + (i.loaded || 0) });
    else cur.loaded += i.loaded || 0;
  }
  const items = [...all.filter(i => !i.hidden && i.kind !== 'IG'), ...bestIg.values()].sort((a, b) => b.time - a.time);
  $('sniffCount').textContent = items.length;
  $('sniffCount').className = 'chip' + (items.length ? ' accent' : '');
  $('sniffEmpty').hidden = items.length > 0;
  const list = $('sniffList');
  const sig = JSON.stringify(items.map(i => [i.key, i.height, i.live, i.size, i.duration]));
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  list.replaceChildren(...items.map(item => {
    const meta = [];
    if (item.kind === 'IG') meta.push(item.use === 'clips' ? 'Reel' : cap(item.use));
    if (item.height) meta.push(`${item.height}p`);
    if (item.duration) meta.push(fmtDur(item.duration));
    if (item.size) meta.push(fmtBytes(item.size));
    const name = decodeURIComponent(new URL(item.url).pathname.split('/').pop() || item.host);
    return el('div', { class: 'sniff' },
      el('div', { class: 'info' },
        el('div', { class: 'line1' },
          el('span', { class: 'chip', text: item.kind }),
          item.live ? el('span', { class: 'chip live', text: 'LIVE' }) : null,
          el('span', { class: 'ellipsis', text: meta.join(' · ') || name, title: item.url })),
        el('div', { class: 'host ellipsis', text: item.host })),
      item.live
        ? el('button', { class: 'btn small rec', text: 'Record', onclick: e => sniffAction(item, e.currentTarget, true) })
        : el('button', { class: 'btn small', text: 'Download', onclick: e => sniffAction(item, e.currentTarget, false) }));
  }));
}

async function sniffAction(item, btn, live) {
  btn.disabled = true;
  if (item.kind === 'IG') {
    const all = state.sniffedAll || [];
    const audio = all.find(i => i.kind === 'IG' && i.audio && item.assetId && i.assetId === item.assetId);
    const user = igUser(state.tab.url);
    const storyId = (/\/stories\/[^/]+\/(\d+)/.exec(state.tab.url) || [])[1];
    const title = storyId ? `story ${storyId}` : igPageTitle(state.tab.title) || `${item.use === 'clips' ? 'reel' : item.use} ${item.assetId || ''}`.trim();
    try {
      await startJob('/download', { method: 'POST', body: directBody({ url: item.url, audioUrl: audio ? audio.url : null, uploader: user, title, duration: item.duration }) });
      btn.textContent = 'Started ✓';
      pollJobs();
    } catch (e) {
      btn.disabled = false;
      showToastError(e);
    }
    return;
  }
  const body = {
    url: item.url,
    sniffed: true,
    pageUrl: state.tab.url,
    pageTitle: state.tab.title,
    headers: { Referer: state.tab.url, 'User-Agent': navigator.userAgent },
    cookies: await cookiesFor(state.tab.url, item.url),
  };
  try {
    if (live) {
      await startJob('/record', { method: 'POST', body: { ...body, maxMinutes: parseFloat($('maxMinutes').value) || 0 } });
    } else {
      const t = trimState();
      await startJob('/download', { method: 'POST', body: { ...body, mode: state.mode, quality: $('quality').value, start: t.error ? '' : $('start').value.trim(), end: t.error ? '' : $('end').value.trim() } });
    }
    btn.textContent = 'Started ✓';
    pollJobs();
  } catch (e) {
    btn.disabled = false;
    showToastError(e);
  }
}

// ---------------------------------------------------------------- tab recording

let recTimer = null;

async function loadRec() {
  const res = await chrome.runtime.sendMessage({ type: 'get-rec' });
  state.rec = res && res.ok ? res.result : null;
  renderRec();
}

function renderRec() {
  const rec = state.rec;
  const box = $('tabrec');
  const btn = $('tabrecBtn');
  clearInterval(recTimer);
  if (!rec) {
    box.classList.remove('recording');
    $('tabrecTitle').textContent = 'Record this tab';
    $('tabrecHint').textContent = 'Captures what\'s playing, with sound, in real time. Works anywhere (e.g. Instagram Live). Tip: make the video fill the tab first.';
    btn.className = 'btn';
    btn.innerHTML = '<span class="rec-dot"></span> Record';
    btn.disabled = !state.tab || !/^https?:/.test(state.tab.url || '');
    return;
  }
  const here = rec.tabId === state.tab.id;
  box.classList.add('recording');
  btn.className = 'btn rec';
  btn.disabled = false;
  btn.textContent = '■ Stop';
  const tick = () => {
    $('tabrecTitle').innerHTML = '';
    $('tabrecTitle').append(el('span', { class: 'dot rec', style: 'display:inline-block;margin-right:6px' }),
      here ? 'Recording this tab ' : 'Recording another tab ',
      el('span', { class: 'timer', text: fmtDur((Date.now() - rec.startedAt) / 1000) }));
  };
  tick();
  recTimer = setInterval(tick, 1000);
  $('tabrecHint').textContent = 'Keep the video playing. You can switch tabs; the recording continues. Press Stop when done.';
}

async function toggleTabRecording() {
  const btn = $('tabrecBtn');
  btn.disabled = true;
  if (state.rec) {
    await chrome.runtime.sendMessage({ type: 'tabrec-stop' });
    setTimeout(loadRec, 500);
    pollJobs();
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'tabrec-start', tabId: state.tab.id, title: state.tab.title, url: state.tab.url });
  if (!res || !res.ok) {
    btn.disabled = false;
    return showToastError(new Error((res && res.error) || 'Could not start recording'));
  }
  await loadRec();
  pollJobs();
}

// ---------------------------------------------------------------- frames

// Runs in the page: the largest video, drawn to a canvas at its native resolution when the
// browser allows it (cross-origin/DRM video "taints" the canvas, then we screenshot instead).
function drawVideoFrame() {
  const vids = [...document.querySelectorAll('video')].filter(v => v.readyState >= 2 && v.videoWidth);
  if (!vids.length) return null;
  const area = v => { const r = v.getBoundingClientRect(); return r.width * r.height; };
  vids.sort((a, b) => area(b) - area(a));
  const v = vids[0];
  const r = v.getBoundingClientRect();
  const base = { area: area(v), t: v.currentTime, viewportWidth: innerWidth, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  try {
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return { ...base, dataUrl: c.toDataURL('image/png') };
  } catch {
    return { ...base, tainted: true };
  }
}

async function saveFrame() {
  const btn = $('frameBtn');
  btn.disabled = true;
  $('frameLabel').textContent = 'Saving…';
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: state.tab.id, allFrames: true }, func: drawVideoFrame });
    const hits = results.filter(r => r.result).map(r => ({ ...r.result, frameId: r.frameId })).sort((a, b) => b.area - a.area);
    if (!hits.length) throw new Error('No video found on this page.');
    const hit = hits[0];

    // Best: the exact frame from the source stream at full resolution.
    let saved = false;
    // (Not for browser-located media: yt-dlp can't read those pages, and asking Instagram again
    // only adds to its rate limit.)
    if (state.info && !state.info.isLive && !state.info.problem && !state.direct) {
      try {
        await startJob('/frame', { method: 'POST', body: { url: state.tab.url, time: hit.t, cookies: await pageCookies(), pageUrl: state.tab.url, pageTitle: state.tab.title } });
        saved = true;
      } catch (e) {
        if (e.status === 0) throw e; // helper down; anything else -> capture from the page
      }
    }
    if (!saved) await uploadFrame(hit);
    $('frameLabel').textContent = 'Saved ✓';
    pollJobs();
  } catch (e) {
    showToastError(e);
  }
  setTimeout(() => { btn.disabled = false; $('frameLabel').textContent = 'Save frame'; }, 1500);
}

async function uploadFrame(hit) {
  let blob;
  if (hit.dataUrl) {
    blob = await (await fetch(hit.dataUrl)).blob();
  } else {
    const shot = await chrome.tabs.captureVisibleTab(state.tab.windowId, { format: 'png' });
    const bmp = await createImageBitmap(await (await fetch(shot)).blob());
    const scale = bmp.width / hit.viewportWidth;
    // Only the top frame's rect is in viewport coordinates; for iframes keep the whole view.
    const r = hit.frameId === 0 ? hit.rect : { x: 0, y: 0, width: hit.viewportWidth, height: bmp.height / scale };
    const x = Math.max(0, Math.round(r.x * scale)), y = Math.max(0, Math.round(r.y * scale));
    const w = Math.min(bmp.width - x, Math.round(r.width * scale)), h = Math.min(bmp.height - y, Math.round(r.height * scale));
    if (w < 16 || h < 16) throw new Error('The video is not visible on screen.');
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, w, h);
    blob = await canvas.convertToBlob({ type: 'image/png' });
  }
  const d = state.direct;
  const pageTitle = d ? [d.uploader, d.title].filter(Boolean).join(' - ') : state.tab.title || '';
  const qs = new URLSearchParams({ pageUrl: state.tab.url, pageTitle, time: String(hit.t || 0) });
  await startJob(`/image-upload?${qs}`, { method: 'POST', body: blob, raw: true });
}

// ---------------------------------------------------------------- page images

// Runs in the page: real content images (not icons/avatars), each at its largest srcset size.
// Images wrapped in a link to another page are thumbnails (e.g. Instagram's "More posts" grid):
// they're listed last and not preselected.
function collectImages() {
  const out = [];
  const seen = new Set();
  const add = (url, w, h, thumb, extra) => {
    try { url = new URL(url, location.href).href; } catch { return; }
    if (!/^https?:/.test(url)) return;
    const key = url.split('?')[0];
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url, w, h, thumb: thumb || url, visible: false, linked: false, shown: 0, ...extra });
  };
  for (const img of document.images) {
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if (nw < 300 || nh < 300) continue;
    let url = img.currentSrc || img.src, best = nw;
    for (const part of (img.srcset || '').split(/,\s+/)) {
      const [u, d] = part.trim().split(/\s+/);
      const n = parseInt(d, 10);
      if (u && d && d.endsWith('w') && n > best) { best = n; url = u; }
    }
    const link = img.closest('a[href]');
    let linked = false;
    if (link) {
      if (/\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(link.pathname)) url = link.href; // link to the full-size file
      else linked = true;
    }
    const r = img.getBoundingClientRect();
    add(url, best, Math.round(nh * best / nw), img.currentSrc || img.src, {
      visible: r.width > 0 && r.bottom > 0 && r.top < innerHeight,
      shown: r.width * r.height,
      linked,
    });
  }
  // Cover image (e.g. photo reels) when it isn't already in the page as an <img>.
  const meta = p => (document.querySelector(`meta[property="${p}"]`) || {}).content || '';
  if (meta('og:image')) add(meta('og:image'), 0, 0, meta('og:image'), {});
  out.sort((a, b) => (a.linked - b.linked) || (b.visible - a.visible) || (b.shown - a.shown) || (b.w * b.h - a.w * a.h));
  return { items: out, title: meta('og:title') || document.title };
}

async function loadImages() {
  if (!state.tab || !/^https?:/.test(state.tab.url || '')) { $('imgCount').textContent = '0'; return; }
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: state.tab.id }, func: collectImages });
    state.images = (res && res.result && res.result.items) || [];
    state.imagesTitle = (res && res.result && res.result.title) || '';
  } catch {
    state.images = [];
  }
  const visible = state.images.map((im, i) => (im.visible && im.w && !im.linked ? i : -1)).filter(i => i >= 0);
  state.imgSel = new Set(visible.length ? visible : state.images.length ? [0] : []);
  renderImages();
}

function renderImages() {
  const n = state.images.length;
  $('imgCount').textContent = n;
  $('imgCount').className = 'chip' + (n ? ' accent' : '');
  $('imgEmpty').hidden = n > 0;
  $('imgActions').hidden = n === 0;
  $('imgGrid').replaceChildren(...state.images.map((im, i) => {
    const tile = el('button', {
      class: 'img-tile' + (state.imgSel.has(i) ? ' on' : ''),
      title: (im.w ? `${im.w}×${im.h}` : 'Cover image') + (im.linked ? ' · links to another page (probably a thumbnail)' : ''),
      onclick: () => { state.imgSel.has(i) ? state.imgSel.delete(i) : state.imgSel.add(i); renderImages(); },
    }, el('span', { class: 'tick' }), im.w ? el('span', { class: 'size', text: `${im.w}px` }) : null);
    tile.style.backgroundImage = `url("${im.thumb.replace(/"/g, '%22')}")`;
    return tile;
  }));
  const sel = state.imgSel.size;
  $('imgSel').textContent = sel ? `${sel} selected` : '';
  $('imgAll').textContent = sel === n ? 'Select none' : 'Select all';
  $('imgSave').disabled = !sel;
  $('imgSave').textContent = sel > 1 ? `Save ${sel} images` : 'Save image';
}

async function saveImages() {
  const btn = $('imgSave');
  btn.disabled = true;
  try {
    const items = [...state.imgSel].sort((a, b) => a - b).map(i => ({ url: state.images[i].url }));
    await startJob('/images', {
      method: 'POST',
      body: {
        items,
        pageUrl: state.tab.url,
        pageTitle: state.imagesTitle || state.tab.title,
        headers: { 'User-Agent': navigator.userAgent },
        cookies: await pageCookies(...items.slice(0, 1).map(i => i.url)),
      },
    });
    btn.textContent = 'Started ✓';
    pollJobs();
  } catch (e) {
    showToastError(e);
  }
  setTimeout(renderImages, 1500);
}

// ---------------------------------------------------------------- errors

let toastTimer = null;
function showToastError(e) {
  let t = document.querySelector('.toast');
  if (!t) { t = el('div', { class: 'toast' }); document.body.append(t); }
  t.textContent = e.message || String(e);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 5000);
}
