// Shared by popup, options, history and background.

export const DEFAULTS = { port: 47321, token: '', quality: '1080', mode: 'video', loginHosts: {} };

export async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

export class HelperError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// Calls the local helper. status 0 = helper not reachable.
export async function api(path, { method = 'GET', body, raw, headers = {}, settings } = {}) {
  const s = settings || await getSettings();
  if (!s.token) throw new HelperError('No access token set', 401);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${s.port}${path}`, {
      method,
      headers: {
        'X-ViD-Token': s.token,
        ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new HelperError('Helper is not running', 0);
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new HelperError(data.error || `HTTP ${res.status}`, res.status);
  return data;
}

// ---------------------------------------------------------------- cookies

const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'ac', 'edu']);

export function baseDomain(host) {
  const parts = host.replace(/^\.+/, '').split('.');
  if (parts.length > 2 && SECOND_LEVEL.has(parts[parts.length - 2])) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

// Cookies for one or more URLs' sites, trimmed to what yt-dlp needs.
export async function cookiesFor(...urls) {
  const seen = new Map();
  for (const url of urls) {
    let host;
    try { host = new URL(url).hostname; } catch { continue; }
    for (const c of await chrome.cookies.getAll({ domain: baseDomain(host) })) {
      const key = `${c.domain}|${c.path}|${c.name}`;
      if (!seen.has(key)) {
        seen.set(key, {
          name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure,
          httpOnly: c.httpOnly, hostOnly: c.hostOnly, expirationDate: c.expirationDate,
        });
      }
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- formatting

export function fmtBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function fmtDur(sec) {
  if (sec === null || sec === undefined || isNaN(sec)) return '';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

export function parseTime(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return NaN;
  return s.split(':').reduce((acc, part) => acc * 60 + parseFloat(part), 0);
}

export function platformOfUrl(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return null; }
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host)) return 'YouTube';
  if (/(^|\.)instagram\.com$/.test(host)) return 'Instagram';
  if (/(^|\.)tiktok\.com$/.test(host)) return 'TikTok';
  if (/(^|\.)twitch\.tv$/.test(host)) return 'Twitch';
  return null;
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

// Video/audio files can be opened in the trim editor (images can't).
export function isEditable(file) {
  return /\.(mp4|m4a|mp3|wav|webm|mkv|mov)$/i.test(file || '');
}

export function openEditor(file) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?file=${encodeURIComponent(file)}`) });
}

export function creditLine(row) {
  const who = row.uploader ? (/^@/.test(row.uploader) ? row.uploader : `@${row.uploader}`) : '';
  const where = row.platform && row.platform !== 'Other' ? row.platform : '';
  const src = row.sourceUrl || '';
  return [who && where ? `${who} on ${where}` : who || where, src].filter(Boolean).join(' — ');
}
