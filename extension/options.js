import { api, getSettings, saveSettings } from './common.js';

const $ = id => document.getElementById(id);

async function init() {
  const s = await getSettings();
  $('token').value = s.token;
  $('port').value = s.port;
  $('quality').value = s.quality;
  $('mode').value = s.mode;
  $('showToken').onclick = () => {
    const show = $('token').type === 'password';
    $('token').type = show ? 'text' : 'password';
    $('showToken').textContent = show ? 'Hide' : 'Show';
  };
  $('saveConn').onclick = async () => {
    await saveSettings({ token: $('token').value.trim(), port: parseInt($('port').value, 10) || 47321 });
    test(true);
  };
  $('saveDl').onclick = saveDownloads;
  $('openFolder').onclick = () => api('/open-folder', { method: 'POST' }).catch(e => msg('dlMsg', e.message, true));
  $('update').onclick = update;
  test(false);
}

async function test(report) {
  try {
    const ping = await api('/ping');
    setStatus(true, `Helper connected · v${ping.version}`);
    const cfg = await api('/config');
    $('outputDir').value = cfg.outputDir;
    $('ytVersion').textContent = cfg.ytdlp || 'unknown';
    if (report) msg('connMsg', 'Connected ✓');
  } catch (e) {
    const text = e.status === 401 ? 'Token not accepted' : e.status === 0 ? 'Helper not running — double-click start-helper.vbs' : e.message;
    setStatus(false, text);
    if (report) msg('connMsg', text, true);
  }
}

async function saveDownloads() {
  await saveSettings({ quality: $('quality').value, mode: $('mode').value });
  try {
    const dir = $('outputDir').value.trim();
    if (dir) {
      const r = await api('/config', { method: 'POST', body: { outputDir: dir } });
      $('outputDir').value = r.outputDir;
    }
    msg('dlMsg', 'Saved ✓');
  } catch (e) {
    msg('dlMsg', e.message, true);
  }
}

async function update() {
  const b = $('update');
  b.disabled = true;
  b.textContent = 'Updating…';
  try {
    const r = await api('/update', { method: 'POST' });
    $('ytVersion').textContent = r.ytdlp;
    $('updateOut').textContent = r.output;
  } catch (e) {
    $('updateOut').textContent = e.message;
  }
  $('updateOut').hidden = false;
  b.disabled = false;
  b.textContent = 'Update now';
}

function setStatus(ok, text) {
  $('status').className = 'dot ' + (ok ? 'on' : 'off');
  $('statusText').textContent = text;
}

function msg(id, text, err) {
  const m = $(id);
  m.textContent = text;
  m.style.color = err ? 'var(--err)' : 'var(--ok)';
  clearTimeout(m._t);
  m._t = setTimeout(() => { m.textContent = ''; }, 4000);
}

init();
