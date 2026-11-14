/*
 * NXBeam media worker: owns the WebSocket, decodes and draws the video on an
 * OffscreenCanvas, off the page's main thread. Layout, the stats panel, the
 * gallery or a garbage collection on the page can no longer delay a frame.
 * JSON messages and audio go back to the page.
 */
import { VideoPlayer } from './player.js';

let player = null;
let ws = null;
let wantAudio = true;
let audioPort = null;  // straight to the AudioWorklet, bypassing the page
const post = (m, transfer) => self.postMessage(m, transfer || []);
const raf = typeof self.requestAnimationFrame === 'function'
  ? (cb) => self.requestAnimationFrame(cb)
  : (cb) => setTimeout(() => cb(performance.now()), 4);
const send = (obj) => { if (ws && ws.readyState === 1) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); };

function connect(url, hello) {
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { send(hello); post({ type: 'open' }); };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') { post({ type: 'json', data: ev.data }); return; }
    const buf = ev.data;
    const u8 = new Uint8Array(buf);
    if (u8[0] === 1) {
      const dv = new DataView(buf);
      player.push(u8.subarray(20), (u8[1] & 1) === 1, dv.getUint32(4, true), dv.getUint32(8, true));
    } else if (u8[0] === 2 && wantAudio) {
      const dv = new DataView(buf);
      const rate = dv.getUint32(4, true), ch = u8[1];
      if (audioPort) audioPort.postMessage({ buf, off: 16, rate, ch }, [buf]);
      else post({ type: 'audio', buf, rate, ch }, [buf]);
    }
  };
  ws.onclose = () => { ws = null; post({ type: 'close' }); };
  ws.onerror = () => {};
}

self.onmessage = async (ev) => {
  const m = ev.data;
  switch (m.type) {
    case 'init': {
      player = new VideoPlayer(m.canvas, {
        raf,
        onStats: (s) => post({ type: 'stats', s }),
        onNeedKey: () => send({ type: 'needKey' }),
        onFirstFrame: () => post({ type: 'first' }),
        onCssSize: (w, h) => post({ type: 'css', w, h }),
      });
      post({ type: 'ready', supported: player.supported, canDraw: !!(player.gl || player.ctx2d) });
      break;
    }
    case 'connect': connect(m.url, m.hello); break;
    case 'send': send(m.msg); break;
    case 'box': player.setBox(m.w, m.h, m.dpr); break;
    case 'adjust': player.setAdjust(m.a); break;
    case 'mode': player.setMode(m.mode); break;
    case 'audio': wantAudio = !!m.on; break;
    case 'audioPort': audioPort = m.port; break;
    case 'reset': player.reset(); break;
    case 'shot': {
      const blob = await player.screenshot().catch(() => null);
      post({ type: 'shot', id: m.id, blob });
      break;
    }
    default: break;
  }
};
