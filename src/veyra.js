'use strict';
/*
 * NXBeam + Veyra (https://github.com/Likely7/Veyra-NRVideo, Windows, D3D12):
 * Veyra adds frame generation, super resolution and denoising on the GPU
 * (DLSS / FSR / XeSS backends). NXBeam hands it the console's stream:
 *
 *   GET /live.mkv   the picture and sound exactly as the console sends them
 *                   (H.264 + PCM), as live Matroska over HTTP - Veyra opens it
 *                   with FFmpeg like any network address.
 *   openInVeyra()   asks a running Veyra to play it, through the local endpoint
 *                   Veyra keeps for its browser extension (POST
 *                   127.0.0.1:18765/play); when Veyra is not running, its
 *                   veyra:// link starts it if it was registered.
 *
 * Nothing of Veyra's is copied into NXBeam: the two only talk over HTTP.
 */
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { MkvWriter } = require('./mkv');

const VEYRA_PORT = 18765;

const isLoopback = (a) => !a || a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.');

/* the console's frame rate (30 or 60), from the spacing of its frames */
function liveFps(hub) {
  const v = [...(hub.srcIntervals || [])].sort((a, b) => a - b);
  const med = v.length ? v[v.length >> 1] : 16.7;
  return med > 25 ? 30 : 60;
}

/* one live viewer of the raw stream; starts at a fresh keyframe so it is not behind */
function serveLive(hub, req, res) {
  // no picture yet (the console is still connecting): wait for it a while
  if (!hub.video) {
    const deadline = Date.now() + 30000;
    const wait = setInterval(() => {
      if (hub.video) { clearInterval(wait); serveLive(hub, req, res); }
      else if (Date.now() > deadline || req.destroyed) { clearInterval(wait); res.writeHead(503, { 'retry-after': '1' }); res.end(); }
    }, 200);
    req.on('close', () => clearInterval(wait));
    return;
  }
  console.log(`[live] ${req.headers['user-agent'] || 'player'} opened /live.mkv (${hub.video.width}x${hub.video.height})`);
  res.writeHead(200, { 'content-type': 'video/x-matroska', 'cache-control': 'no-store', connection: 'close' });
  if (res.socket) res.socket.setNoDelay(true);
  const audio = hub.audio.seen ? { rate: hub.audio.rate, channels: hub.audio.channels } : { rate: 48000, channels: 2 };
  let writer = null;
  let t0 = 0;
  let size = '';
  let resync = false;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    console.log('[live] /live.mkv closed');
    hub.off('video', onVideo);
    hub.off('audio', onAudio);
    try { res.end(); } catch { /* gone */ }
  };
  function onVideo(pkt) {
    if (closed) return;
    if (!writer) {
      if (!pkt.key || !pkt.sps || !pkt.pps) return;
      writer = new MkvWriter({ sps: pkt.sps, pps: pkt.pps, width: pkt.width, height: pkt.height, fps: liveFps(hub) }, audio);
      t0 = pkt.t;
      size = `${pkt.width}x${pkt.height}`;
      res.write(writer.header());
    } else if (`${pkt.width}x${pkt.height}` !== size) {
      close(); // a new picture size: the player opens the address again
      return;
    }
    // a player that cannot keep up: skip to the next keyframe instead of falling behind
    if (res.writableLength > 6_000_000) { resync = true; hub.requestKeyframe(); return; }
    if (resync) { if (!pkt.key) return; resync = false; }
    res.write(writer.videoBlock(pkt.t - t0, pkt.key, pkt.data));
  }
  function onAudio(pkt) {
    if (closed || !writer || resync) return;
    if (pkt.rate !== audio.rate || pkt.channels !== audio.channels) return;
    res.write(writer.audioBlock(pkt.t - t0, pkt.data));
  }
  hub.on('video', onVideo);
  hub.on('audio', onAudio);
  hub.requestKeyframe();
  req.on('close', close);
  res.on('error', close);
}

function postPlay(url) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({ url }));
    const r = http.request({
      host: '127.0.0.1', port: VEYRA_PORT, path: '/play', method: 'POST', timeout: 2500,
      headers: { 'content-type': 'application/json', 'content-length': body.length, host: `127.0.0.1:${VEYRA_PORT}` },
    }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: s }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
    r.end(body);
  });
}

/* the veyra:// link, when Veyra registered it (its install-protocol.cmd) */
function protocolRegistered() {
  if (process.platform !== 'win32') return false;
  try {
    for (const key of ['HKCU\\Software\\Classes\\veyra', 'HKCR\\veyra']) {
      if (spawnSync('reg', ['query', key], { windowsHide: true, timeout: 3000 }).status === 0) return true;
    }
  } catch { /* no reg.exe */ }
  return false;
}

async function openInVeyra(port) {
  const url = `http://127.0.0.1:${port}/live.mkv`;
  const r = await postPlay(url);
  if (r.ok) return { ok: true, url };
  if (r.status) return { ok: false, url, error: `veyra-${r.status}` };
  if (protocolRegistered()) {
    const link = `veyra://play?url=${encodeURIComponent(url)}`;
    try {
      spawn('cmd', ['/c', 'start', '""', link], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return { ok: true, url, launched: true };
    } catch { /* fall through */ }
  }
  return { ok: false, url, error: 'not-running' };
}

module.exports = { serveLive, openInVeyra, isLoopback };
