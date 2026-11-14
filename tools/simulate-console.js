#!/usr/bin/env node
'use strict';
/*
 * NXBeam console simulator: behaves like a console with network streaming on.
 * Listens on TCP 9950, beacons on UDP 9951, streams a test picture (H.264,
 * one access unit per packet) and a test tone, and prints the controller
 * input it receives. For trying NXBeam without a console.
 *
 *   node tools/simulate-console.js [--size 1280x720] [--fps 60] [--port 9950] [--no-beacon] [--idle] [--no-audio] [--jitter 40] [--audio-burst 300] [--audio-drift 0.3]
 */
const net = require('net');
const dgram = require('dgram');
const { spawn } = require('child_process');
const { buildHeader, Flag, Button } = require('../src/protocol');
const { splitNals, nalType } = require('../src/h264');
const { ffmpegPath } = require('../src/ffmpeg');
const { localSubnets } = require('../src/sources');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const [W, H] = opt('size', '1280x720').split('x').map(Number);
const FPS = Number(opt('fps', 60));
const PORT = Number(opt('port', 9950));
const IDLE = args.includes('--idle');
const JITTER = Number(opt('jitter', 0)); // ms: Wi-Fi-like stalls and bursts
const AUDIO_BURST = Number(opt('audio-burst', 0)); // ms: hold audio and send it in bursts, like the console's ring after a stall
const AUDIO_DRIFT = Number(opt('audio-drift', 0)); // percent: the console's audio clock running fast (+) or slow (-)
const FF = ffmpegPath();
if (!FF) { console.error('ffmpeg not found'); process.exit(1); }

let viewer = null;
let ff = null;
let audioTimer = null;
const BASE_FLAGS = Flag.INPUT;

let releaseAt = 0;
function send(flags, w, h, payload) {
  if (!viewer || viewer.destroyed) return;
  if (JITTER > 0) {
    // hold some packets back, then let them out together - in order, like Wi-Fi does
    const now = Date.now();
    const delay = Math.random() < 0.2 ? Math.random() * JITTER : 0;
    releaseAt = Math.max(releaseAt, now + delay);
    const v = viewer;
    const out = Buffer.concat([buildHeader({ flags: flags | BASE_FLAGS, width: w, height: h, stride: 0, length: payload.length }), payload]);
    setTimeout(() => { if (!v.destroyed) v.write(out); }, releaseAt - now);
    return;
  }
  viewer.write(buildHeader({ flags: flags | BASE_FLAGS, width: w, height: h, stride: 0, length: payload.length }));
  viewer.write(payload);
}

function statusPacket(head, detail) {
  const b = Buffer.alloc(192);
  b.writeUInt32LE(1, 0); b.writeUInt32LE(2, 4);
  b.write(head, 8, 63, 'utf8'); b.write(detail, 72, 119, 'utf8');
  send(Flag.AUDIO | Flag.STATUS, 0, 0, b);
}

function startVideo() {
  ff = spawn(FF, [
    '-hide_banner', '-loglevel', 'error', '-re',
    '-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=${FPS}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'high',
    '-pix_fmt', 'yuv420p', '-g', String(FPS * 2), '-bf', '0', '-b:v', '6M',
    '-x264-params', 'repeat-headers=1:aud=1', '-f', 'h264', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = Buffer.alloc(0);
  ff.stdout.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    // an access unit ends where the next AUD (00 00 00 01 09) starts
    let from = 0;
    for (;;) {
      const next = buf.indexOf(Buffer.from([0, 0, 0, 1, 9]), from + 5);
      if (next < 0) break;
      emitAu(buf.subarray(from, next));
      from = next;
    }
    buf = buf.subarray(from);
  });
}

function emitAu(au) {
  const key = splitNals(au).some((n) => nalType(n) === 5);
  send(Flag.H264 | (key ? Flag.KEY : 0), W, H, Buffer.from(au));
}

function startAudio() {
  const RATE = 48000, CH = 2, CHUNK = 1024; // 4096 bytes, ~21 ms: the console's grc:d chunk
  const realRate = RATE * (1 + AUDIO_DRIFT / 100);
  let phase = 0, sent = 0;
  const t0 = Date.now();
  let held = [], holdUntil = 0;
  audioTimer = setInterval(() => {
    const due = Math.floor(((Date.now() - t0) / 1000) * realRate / CHUNK);
    while (sent < due) {
      const b = Buffer.alloc(CHUNK * CH * 2);
      for (let i = 0; i < CHUNK; i++) {
        // a steady tone with a short beep every second: any gap is audible
        const tSec = (sent * CHUNK + i) / RATE;
        const amp = (tSec % 1) < 0.15 ? 7000 : 2500;
        const v = Math.round(Math.sin(phase) * amp);
        phase += (2 * Math.PI * 440) / RATE;
        b.writeInt16LE(v, i * 4); b.writeInt16LE(v, i * 4 + 2);
      }
      sent++;
      if (AUDIO_BURST > 0) {
        held.push(b);
        const now = Date.now();
        if (!holdUntil) holdUntil = now + Math.random() * AUDIO_BURST;
        if (now >= holdUntil) { for (const x of held) send(Flag.AUDIO, RATE, CH, x); held = []; holdUntil = 0; }
      } else {
        send(Flag.AUDIO, RATE, CH, b);
      }
    }
  }, 5);
}

function stopStreams() {
  if (ff) { ff.kill(); ff = null; }
  clearInterval(audioTimer);
}

const names = Object.fromEntries(Object.entries(Button).map(([k, v]) => [v, k]));
let lastPad = '';
function onViewerData(state, d) {
  state.buf = Buffer.concat([state.buf, d]);
  let i = 0;
  while (state.buf.length - i >= 4) {
    if (state.buf.toString('latin1', i, i + 3) !== 'SFT') { i++; continue; }
    const c = String.fromCharCode(state.buf[i + 3]);
    if (c === 'I') {
      if (state.buf.length - i < 32) break;
      const m = state.buf.subarray(i, i + 32);
      const on = m.readUInt32LE(4);
      const b = m.readUInt32LE(8);
      const sticks = [16, 20, 24, 28].map((o) => m.readInt32LE(o));
      const pressed = Object.keys(names).filter((bit) => b & (1 << bit)).map((bit) => names[bit]);
      const line = on ? `pad: [${pressed.join(' ')}] L(${sticks[0]},${sticks[1]}) R(${sticks[2]},${sticks[3]})` : 'pad: released';
      if (line !== lastPad) { console.log(line); lastPad = line; }
      i += 32;
    } else {
      if (c === 'K') console.log('viewer: keyframe requested');
      else if (c === 'L') console.log('viewer: lock size');
      else if (c === 'U') console.log('viewer: follow size');
      i += 4;
    }
  }
  state.buf = state.buf.subarray(i);
}

const server = net.createServer((sock) => {
  if (viewer) { sock.destroy(); return; } // one viewer at a time, like the console
  viewer = sock;
  sock.setNoDelay(true);
  console.log(`viewer connected: ${sock.remoteAddress}`);
  const st = { buf: Buffer.alloc(0) };
  sock.on('data', (d) => onViewerData(st, d));
  sock.on('error', () => {});
  sock.on('close', () => { console.log('viewer left'); viewer = null; stopStreams(); });
  if (IDLE) {
    const t = setInterval(() => { if (!viewer) return clearInterval(t); statusPacket('No game running', 'Start a game on the console'); }, 2000);
  } else {
    startVideo();
    if (!args.includes('--no-audio')) startAudio();
  }
});
server.listen(PORT, () => console.log(`simulated console on TCP ${PORT} (${W}x${H}@${FPS}${IDLE ? ', idle' : ''})`));

if (!args.includes('--no-beacon')) {
  const b = dgram.createSocket('udp4');
  b.bind(() => {
    b.setBroadcast(true);
    setInterval(() => {
      if (viewer) return;
      for (const s of localSubnets()) {
        const msg = Buffer.from(`SFTAP1 ${s.self} ${PORT} sim`);
        b.send(msg, 9951, s.base + '255');
      }
      b.send(Buffer.from(`SFTAP1 127.0.0.1 ${PORT} sim`), 9951, '127.0.0.1');
    }, 1000);
  });
}
