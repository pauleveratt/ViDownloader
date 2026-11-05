// Fake `chrome` extension API for the dev harness. Query params:
//   url, title   - the "current tab"          sniff=1 - show sample detected media
//   rec=1        - pretend a tab recording is running
(() => {
  const params = new URLSearchParams(location.search);
  const tab = {
    id: 1,
    url: params.get('url') || 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    title: params.get('title') || 'Test page',
  };

  const read = name => { try { return JSON.parse(localStorage.getItem('shim_' + name)) || {}; } catch { return {}; } };
  const write = (name, obj) => localStorage.setItem('shim_' + name, JSON.stringify(obj));
  const area = (name, defaults = {}) => ({
    async get(keys) {
      const all = { ...defaults, ...read(name) };
      if (keys === null || keys === undefined) return all;
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(list.filter(k => k in all).map(k => [k, all[k]]));
    },
    async set(obj) { write(name, { ...read(name), ...obj }); },
    async remove(keys) { const all = read(name); [].concat(keys).forEach(k => delete all[k]); write(name, all); },
  });
  if (params.get('fresh') === '1') localStorage.removeItem('shim_session');

  const sample = [
    { key: 'a', url: 'https://cdn.example.net/hls/master.m3u8?token=abc', kind: 'HLS', height: 1080, duration: 1325, live: false, size: 0, host: 'cdn.example.net', time: Date.now() },
    { key: 'b', url: 'https://live.example.net/stream/index.m3u8', kind: 'HLS', height: 720, live: true, size: 0, host: 'live.example.net', time: Date.now() },
    { key: 'c', url: 'https://media.example.org/videos/clip_final.mp4', kind: 'MP4', size: 48_300_000, host: 'media.example.org', time: Date.now() },
  ];
  // ig=1: what the background sniffer records on an Instagram story (one playing, one preloaded).
  const igFile = (n, extra) => ({ key: 'ig' + n, kind: 'IG', host: 'scontent.cdninstagram.com', url: `https://example.invalid/ig/${n}.mp4`, time: Date.now() - n * 100, live: false, size: 0, hidden: !!extra.audio, ...extra });
  const igSample = [
    igFile(1, { use: 'story', audio: false, height: 1080, duration: 42, assetId: 'A', loaded: 3_100_000 }),
    igFile(2, { use: 'story', audio: false, height: 720, duration: 42, assetId: 'A', loaded: 450 }),
    igFile(3, { use: 'story', audio: true, height: null, duration: 42, assetId: 'A', loaded: 309_000 }),
    igFile(4, { use: 'story', audio: false, height: 1080, duration: 15, assetId: 'B', loaded: 900 }),
    igFile(5, { use: 'story', audio: true, height: null, duration: 15, assetId: 'B', loaded: 400 }),
  ];
  let rec = params.get('rec') === '1' ? { tabId: 1, jobId: 'demo', startedAt: Date.now() - 75_000 } : null;

  const handlers = {
    'get-sniffed': msg => [
      ...(params.get('sniff') === '1' ? sample : []),
      ...(params.get('ig') === '1' ? igSample.filter(i => msg.all || !i.hidden) : []),
    ],
    'get-rec': () => rec,
    'tabrec-start': () => { rec = { tabId: 1, jobId: 'demo', startedAt: Date.now() }; return { jobId: 'demo' }; },
    'tabrec-stop': () => { rec = null; return true; },
  };

  window.chrome = {
    storage: { local: area('local', { token: 'harness' }), session: area('session') },
    tabs: {
      query: async () => [tab],
      get: async () => tab,
      create: async ({ url }) => window.open(url),
      captureVisibleTab: async () => {
        const c = document.createElement('canvas');
        c.width = 1280; c.height = 720;
        const g = c.getContext('2d');
        g.fillStyle = '#5b5bd6'; g.fillRect(0, 0, 1280, 720);
        return c.toDataURL('image/png');
      },
    },
    runtime: {
      getURL: p => '/' + p,
      openOptionsPage: () => window.open('/options.html'),
      sendMessage: async msg => {
        const h = handlers[msg.type];
        return h ? { ok: true, result: h(msg) } : { ok: false, error: 'not in harness' };
      },
    },
    cookies: { getAll: async () => [] },
    scripting: {
      executeScript: async ({ func }) => {
        if (func.name === 'collectImages') {
          return [{ frameId: 0, result: { title: 'Blender on Instagram: "Big Buck Bunny stills"', items: [
            { url: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/maxresdefault.jpg', w: 1280, h: 720, thumb: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/mqdefault.jpg', visible: true },
            { url: 'https://i.ytimg.com/vi_webp/aqz-KE-bpKQ/maxresdefault.webp', w: 1280, h: 720, thumb: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg', visible: true },
            { url: 'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg', w: 480, h: 360, thumb: 'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg', visible: true, linked: true },
            { url: 'https://i.ytimg.com/vi/jNQXAC9IVRw/0.jpg', w: 0, h: 0, thumb: 'https://i.ytimg.com/vi/jNQXAC9IVRw/0.jpg', visible: false },
          ] } }];
        }
        if (func.name === 'playingVideo') return [{ frameId: 0, result: { duration: 42.1, height: 1280 } }];
        // drawVideoFrame / current-time lookups: pretend a 1080p video paused at 1:23.4
        return [{ frameId: 0, result: { t: 83.4, area: 1, playing: true, viewportWidth: 1280, rect: { x: 0, y: 0, width: 640, height: 360 }, tainted: true } }];
      },
    },
  };

  // The editor's <video> loads straight from the helper; send it via the proxy too.
  window.vidMediaUrl = src => { const u = new URL(src); return '/api' + u.pathname + u.search; };

  // Send helper calls through the harness server, which adds the real token.
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, opts) => {
    if (typeof input === 'string' && input.startsWith('http://127.0.0.1:')) {
      const u = new URL(input);
      input = '/api' + u.pathname + u.search;
    }
    return realFetch(input, opts);
  };

  // Frame the 400px popup like Chrome does.
  if (/popup\.html$/.test(location.pathname)) {
    const s = document.createElement('style');
    s.textContent = 'html{background:#3b3b46;min-height:100%}body{margin:24px auto!important;border-radius:10px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.45)}';
    document.documentElement.append(s);
  }
})();
