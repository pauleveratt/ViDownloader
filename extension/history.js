import { api, el, fmtDur, creditLine, isEditable, openEditor } from './common.js';

const $ = id => document.getElementById(id);
let rows = [];

const KIND = { download: null, sniffed: 'Detected media', live: 'Live recording', tab: 'Tab recording', image: 'Image', frame: 'Frame', edit: 'Edited' };

async function load() {
  try {
    rows = await api('/history');
  } catch (e) {
    $('summary').textContent = e.status === 0 ? 'Helper is not running.' : e.message;
    return;
  }
  const platforms = [...new Set(rows.map(r => r.platform).filter(Boolean))].sort();
  const sel = $('platform');
  const cur = sel.value;
  sel.replaceChildren(el('option', { value: '', text: 'All platforms' }), ...platforms.map(p => el('option', { value: p, text: p })));
  sel.value = platforms.includes(cur) ? cur : '';
  render();
}

function filtered() {
  const q = $('search').value.trim().toLowerCase();
  const p = $('platform').value;
  return rows.filter(r => (!p || r.platform === p) &&
    (!q || [r.title, r.uploader, r.platform, r.sourceUrl, r.file].join(' ').toLowerCase().includes(q)));
}

function render() {
  const list = filtered();
  $('summary').textContent = `${rows.length} item${rows.length === 1 ? '' : 's'}${list.length !== rows.length ? ` · ${list.length} shown` : ''}`;
  if (!list.length) {
    $('list').replaceChildren(el('div', { class: 'empty', text: rows.length ? 'Nothing matches your search.' : 'Nothing downloaded yet. Open a video and click the ViDownloader icon.' }));
    return;
  }
  $('list').replaceChildren(...list.map(row));
}

function row(r) {
  const d = new Date(r.date);
  const meta = [];
  if (r.platform) meta.push(el('span', { class: 'chip accent', text: r.platform }));
  if (KIND[r.kind]) meta.push(el('span', { class: 'chip', text: KIND[r.kind] }));
  if (r.mode && r.mode !== 'video' && r.mode !== 'image') meta.push(el('span', { class: 'chip', text: r.mode.toUpperCase() }));
  if (r.uploader) meta.push(el('span', { text: r.uploader }));
  if (r.count > 1) meta.push(el('span', { text: `${r.count} images` }));
  if (r.kind === 'frame' && r.time != null) meta.push(el('span', { text: `at ${fmtDur(r.time)}${r.resolution ? ` · ${r.resolution}` : ''}` }));
  else if (r.trim) meta.push(el('span', { text: `clip ${fmtDur(r.trim.start || 0)}–${r.trim.end != null ? fmtDur(r.trim.end) : 'end'}` }));
  else if (r.duration) meta.push(el('span', { text: fmtDur(r.duration) }));
  if (r.sourceUrl) meta.push(el('a', { href: r.sourceUrl, target: '_blank', rel: 'noreferrer', text: 'source ↗' }));

  const copyBtn = el('button', { class: 'btn small', text: 'Copy credit', title: creditLine(r) });
  copyBtn.onclick = async () => {
    await navigator.clipboard.writeText(creditLine(r));
    copyBtn.textContent = 'Copied ✓';
    copyBtn.classList.add('copied');
    setTimeout(() => { copyBtn.textContent = 'Copy credit'; copyBtn.classList.remove('copied'); }, 1500);
  };
  const showBtn = el('button', { class: 'btn small', text: 'Show file', title: r.file });
  showBtn.onclick = () => api('/reveal', { method: 'POST', body: { file: r.file } }).catch(e => {
    showBtn.textContent = e.status === 404 ? 'File moved' : 'Error';
    showBtn.disabled = true;
  });
  const editBtn = isEditable(r.file) ? el('button', { class: 'btn small', text: 'Edit', title: 'Trim or cut segments', onclick: () => openEditor(r.file) }) : null;
  const delBtn = el('button', { class: 'btn ghost small', text: '✕', title: 'Remove from history (keeps the file)' });
  delBtn.onclick = async () => { await api('/history/delete', { method: 'POST', body: { id: r.id } }); load(); };

  return el('div', { class: 'hrow' },
    el('div', { class: 'hdate' }, d.toLocaleDateString(), el('br'), d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
    el('div', { class: 'hmain' },
      el('div', { class: 'htitle', text: r.title || r.file.split('\\').pop(), title: r.file }),
      el('div', { class: 'hmeta' }, meta)),
    el('div', { class: 'hactions' }, copyBtn, editBtn, showBtn, delBtn));
}

$('search').oninput = render;
$('platform').onchange = render;
$('openFolder').onclick = () => api('/open-folder', { method: 'POST' });
$('copyAll').onclick = async () => {
  await navigator.clipboard.writeText(filtered().map(creditLine).join('\n'));
  $('copyAll').textContent = 'Copied ✓';
  setTimeout(() => { $('copyAll').textContent = 'Copy all credits'; }, 1500);
};
$('clearAll').onclick = async () => {
  if (!rows.length) return;
  if (!confirm(`Clear all ${rows.length} items from your download history?\n\nYour downloaded files stay where they are. Tip: use "Export CSV" first if you want to keep the credits list.`)) return;
  await api('/history/clear', { method: 'POST' });
  load();
};
$('exportCsv').onclick = () => {
  const cols = ['date', 'platform', 'title', 'uploader', 'sourceUrl', 'kind', 'mode', 'duration', 'file'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...filtered().map(r => cols.map(c => q(r[c])).join(','))].join('\r\n');
  const a = el('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: 'vidownloader-history.csv' });
  a.click();
};

load();
