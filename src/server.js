'use strict';
/* HTTP (web app, REST API, media library) + WebSocket fan-out */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.woff2': 'font/woff2',
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};
const MEDIA_KINDS = ['recordings', 'clips', 'screenshots'];

const BACKPRESSURE = 6 * 1024 * 1024;

function createServer(hub, config, saveConfig) {
  const tokens = new Set();
  const clients = new Map();
  let nextId = 1;

  const authed = (req) => {
    if (!config.pin) return true;
    const m = /(?:^|;\s*)nxb=([a-f0-9]+)/.exec(req.headers.cookie || '');
    return !!(m && tokens.has(m[1]));
  };

  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  const body = (req, limit = 20 * 1024 * 1024) => new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', (d) => { n += d.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else parts.push(d); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });

  const safeMediaPath = (kind, name) => {
    if (!MEDIA_KINDS.includes(kind)) return null;
    const base = path.basename(String(name || ''));
    if (!base || base.startsWith('.')) return null;
    return path.join(hub.mediaDir, kind, base);
  };

  const listMedia = () => {
    const out = {};
    for (const k of MEDIA_KINDS) {
      const dir = path.join(hub.mediaDir, k);
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) => !f.startsWith('.')).map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { name: f, size: st.size, mtime: st.mtimeMs };
        }).sort((a, b) => b.mtime - a.mtime);
      } catch { /* empty */ }
      out[k] = files;
    }
    return out;
  };

  const publicConfig = () => ({
    replaySeconds: config.replaySeconds,
    connection: config.connection,
    restreamTargets: (config.restreamTargets || []).map((t) => ({ id: t.id, name: t.name, url: t.url, hasKey: !!t.key })),
    pinSet: !!config.pin,
    lockSizeWhileRecording: config.lockSizeWhileRecording !== false,
    recordPreset: config.recordPreset || 'source',
    livePreset: config.livePreset || 'source',
    mediaDir: hub.mediaDir,
  });

  const sendFile = (req, res, file, download) => {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); res.end(); return; }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const headers = { 'content-type': type, 'accept-ranges': 'bytes' };
      if (download) headers['content-disposition'] = `attachment; filename="${path.basename(file)}"`;
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
        if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); res.end(); return; }
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
        fs.createReadStream(file, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { ...headers, 'content-length': st.size });
        fs.createReadStream(file).pipe(res);
      }
    });
  };

  /* ------------------------------------------------------------ REST */
  const api = async (req, res, url) => {
    const p = url.pathname;
    if (p === '/api/login' && req.method === 'POST') {
      const { pin } = JSON.parse((await body(req)).toString() || '{}');
      if (!config.pin || String(pin) === String(config.pin)) {
        const tok = crypto.randomBytes(16).toString('hex');
        tokens.add(tok);
        res.setHeader('set-cookie', `nxb=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
        return json(res, 200, { ok: true });
      }
      return json(res, 401, { ok: false });
    }
    if (p === '/api/session') return json(res, 200, { authed: authed(req), pinSet: !!config.pin });
    if (!authed(req)) return json(res, 401, { error: 'login required' });

    if (p === '/api/update' && req.method === 'GET') return json(res, 200, hub.updater ? hub.updater.info() : { enabled: false });
    if (p === '/api/update/check' && req.method === 'POST') {
      if (!hub.updater) return json(res, 400, { error: 'updates are off' });
      return json(res, 200, await hub.updater.check());
    }
    if (p === '/api/update/apply' && req.method === 'POST') {
      if (!hub.updater) return json(res, 400, { error: 'updates are off' });
      // answer at once; progress and the restart arrive over the WebSocket
      hub.updater.apply().then(() => hub.updater.restart()).catch(() => {});
      return json(res, 200, hub.updater.info());
    }
    if (p === '/api/state') return json(res, 200, { state: hub.publicState(), stats: hub.statsSnapshot(), history: hub.stats.history });
    if (p === '/api/config' && req.method === 'GET') return json(res, 200, publicConfig());
    if (p === '/api/config' && req.method === 'POST') {
      const c = JSON.parse((await body(req)).toString() || '{}');
      if (c.replaySeconds !== undefined) config.replaySeconds = Math.max(0, Math.min(300, Number(c.replaySeconds) || 0));
      for (const k of ['recordPreset', 'livePreset']) if (['source', '1080p60'].includes(c[k])) config[k] = c[k];
      if (c.lockSizeWhileRecording !== undefined) config.lockSizeWhileRecording = !!c.lockSizeWhileRecording;
      const prevMode = config.connection.mode;
      if (c.connection) {
        if (['auto', 'network', 'usb'].includes(c.connection.mode)) config.connection.mode = c.connection.mode;
        if (typeof c.connection.host === 'string') config.connection.host = c.connection.host.trim();
        if (c.connection.scan !== undefined) config.connection.scan = !!c.connection.scan;
      }
      if (typeof c.pin === 'string') { config.pin = c.pin.trim(); tokens.clear(); }
      if (Array.isArray(c.restreamTargets)) {
        const old = new Map((config.restreamTargets || []).map((t) => [t.id, t]));
        config.restreamTargets = c.restreamTargets.slice(0, 8).map((t) => {
          const id = t.id || crypto.randomBytes(4).toString('hex');
          const prev = old.get(id);
          return { id, name: String(t.name || 'RTMP').slice(0, 40), url: String(t.url || '').trim(), key: t.key === undefined ? prev?.key || '' : String(t.key).trim() };
        }).filter((t) => /^rtmps?:\/\//i.test(t.url));
      }
      saveConfig();
      if (config.connection.mode !== prevMode) hub.applyConnectionMode();
      hub.emit('state');
      return json(res, 200, publicConfig());
    }
    if (p === '/api/connect' && req.method === 'POST') {
      const { host } = JSON.parse((await body(req)).toString() || '{}');
      if (host && /^[\w.:-]+$/.test(host)) hub.connectTo(host); else hub.reconnect();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/keyframe' && req.method === 'POST') { hub.requestKeyframe(); return json(res, 200, { ok: true }); }
    if (p === '/api/record/start' && req.method === 'POST') return json(res, 200, hub.startRecording());
    if (p === '/api/record/stop' && req.method === 'POST') return json(res, 200, await hub.stopRecording());
    if (p === '/api/clip' && req.method === 'POST') {
      const { seconds } = JSON.parse((await body(req)).toString() || '{}');
      try { return json(res, 200, await hub.saveClip(seconds)); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/restream/start' && req.method === 'POST') {
      const { id } = JSON.parse((await body(req)).toString() || '{}');
      try { hub.startRestream(id); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/restream/stop' && req.method === 'POST') {
      const { id } = JSON.parse((await body(req)).toString() || '{}');
      await hub.stopRestream(id); return json(res, 200, { ok: true });
    }
    if (p === '/api/media' && req.method === 'GET') return json(res, 200, listMedia());
    if (p === '/api/screenshot' && req.method === 'POST') {
      const buf = await body(req);
      if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return json(res, 400, { error: 'PNG expected' });
      const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
      const name = `shot-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}.png`;
      fs.writeFileSync(path.join(hub.mediaDir, 'screenshots', name), buf);
      broadcastJson({ type: 'media', kind: 'screenshots' });
      return json(res, 200, { name });
    }
    let m = /^\/api\/media\/(\w+)\/([^/]+)$/.exec(p);
    if (m) {
      const file = safeMediaPath(m[1], decodeURIComponent(m[2]));
      if (!file) return json(res, 400, { error: 'bad path' });
      if (req.method === 'DELETE') {
        try { fs.unlinkSync(file); } catch { return json(res, 404, { error: 'not found' }); }
        broadcastJson({ type: 'media', kind: m[1] });
        return json(res, 200, { ok: true });
      }
      return sendFile(req, res, file, url.searchParams.has('download'));
    }
    return json(res, 404, { error: 'not found' });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      let p = decodeURIComponent(url.pathname);
      if (p === '/' ) p = '/index.html';
      if (p === '/overlay' || p === '/obs') p = '/overlay.html';
      const file = path.normalize(path.join(PUBLIC, p));
      if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        // no-store: OBS browser sources keep old scripts otherwise
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store, max-age=0' });
        res.end(data);
      });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });

  /* ------------------------------------------------------------ WebSocket */
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (!authed(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const clientList = () => [...clients.values()].map((c) => ({ id: c.id, name: c.name, role: c.role, addr: c.addr }));

  if (hub.updater) hub.updater.on('change', (info) => broadcastJson({ type: 'update', update: info }));

  function broadcastJson(obj, filter) {
    const s = JSON.stringify(obj);
    for (const c of clients.values()) if (!filter || filter(c)) c.ws.send(s);
  }
  const sendState = () => broadcastJson({ type: 'state', state: hub.publicState(), clients: clientList() });

  const videoFrame = (pkt) => {
    const b = Buffer.allocUnsafe(20 + pkt.data.length);
    b[0] = 1; b[1] = pkt.key ? 1 : 0; b.writeUInt16LE(0, 2);
    b.writeUInt32LE(pkt.width, 4); b.writeUInt32LE(pkt.height, 8);
    b.writeDoubleLE(pkt.t, 12);
    pkt.data.copy(b, 20);
    return b;
  };
  const audioFrame = (pkt) => {
    const b = Buffer.allocUnsafe(16 + pkt.data.length);
    b[0] = 2; b[1] = pkt.channels; b.writeUInt16LE(0, 2);
    b.writeUInt32LE(pkt.rate, 4); b.writeDoubleLE(pkt.t, 8);
    pkt.data.copy(b, 16);
    return b;
  };

  hub.on('video', (pkt) => {
    let frame = null;
    for (const c of clients.values()) {
      if (!c.wantsVideo) continue;
      if (c.needKey && !pkt.key) continue;
      if (c.ws.bufferedAmount > BACKPRESSURE) { c.needKey = true; c.dropped++; continue; }
      c.needKey = false;
      frame = frame || videoFrame(pkt);
      c.ws.send(frame);
    }
  });
  hub.on('audio', (pkt) => {
    let frame = null;
    for (const c of clients.values()) {
      if (!c.wantsAudio || c.ws.bufferedAmount > BACKPRESSURE) continue;
      frame = frame || audioFrame(pkt);
      c.ws.send(frame);
    }
  });
  let padThrottle = 0;
  hub.on('pad', (state) => {
    const t = Date.now();
    if (state && t - padThrottle < 30) return;
    padThrottle = t;
    broadcastJson({ type: 'pad', state }, (c) => c.wantsPad);
  });
  hub.on('state', sendState);
  hub.on('stats', (s) => broadcastJson({ type: 'stats', stats: s }));
  hub.on('media', (m) => broadcastJson({ type: 'media', kind: m.kind }));
  hub.on('toast', (t) => broadcastJson({ type: 'toast', ...t }));
  hub.on('pilotChanged', ({ from, to }) => {
    const c = clients.get(from.id);
    if (c) c.ws.send(JSON.stringify({ type: 'toast', level: 'info', key: 'controlTaken', arg: to.name }));
  });

  wss.on('connection', (ws, req) => {
    const id = nextId++;
    const client = {
      id, ws, name: `Viewer ${id}`, role: 'viewer', addr: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''),
      wantsVideo: true, wantsAudio: true, wantsPad: false, needKey: true, dropped: 0,
    };
    clients.set(id, client);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      switch (m.type) {
        case 'hello':
          client.name = String(m.name || client.name).slice(0, 32);
          client.role = m.role === 'overlay' ? 'overlay' : 'viewer';
          client.wantsVideo = m.video !== false;
          client.wantsAudio = m.audio !== false;
          client.wantsPad = !!m.padEvents;
          ws.send(JSON.stringify({ type: 'welcome', id, state: hub.publicState(), clients: clientList(), stats: hub.statsSnapshot(), history: hub.stats.history }));
          // instant picture: the GOP since the last keyframe; ask for a fresh one if it is long
          if (client.wantsVideo && hub.gop.length) {
            for (const pkt of hub.gop) ws.send(videoFrame(pkt));
            client.needKey = false;
          }
          if (hub.gop.length > 90 || !hub.gop.length) hub.requestKeyframe();
          sendState();
          break;
        case 'subscribe':
          if (m.audio !== undefined) client.wantsAudio = !!m.audio;
          if (m.video !== undefined) { client.wantsVideo = !!m.video; client.needKey = true; if (m.video) hub.requestKeyframe(); }
          break;
        case 'needKey': client.needKey = true; hub.requestKeyframe(); break;
        case 'rename': client.name = String(m.name || '').slice(0, 32) || client.name; sendState(); break;
        case 'takeControl': hub.takeControl(client); break;
        case 'releaseControl': hub.releaseControl(client); break;
        case 'pad':
          if (m.state && typeof m.state === 'object') hub.pad(client, m.state, m.index | 0);
          else if (m.state === null && (m.index | 0) > 0) hub.pad(client, null, m.index | 0);
          break;
        default: break;
      }
    });
    ws.on('close', () => {
      clients.delete(id);
      if (hub.pilot && hub.pilot.id === id) hub.releaseControl(client);
      sendState();
    });
    ws.on('error', () => {});
  });

  return server;
}

module.exports = { createServer };
