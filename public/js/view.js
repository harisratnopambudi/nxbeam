/*
 * The stream connection + video, behind one interface. Uses the media worker
 * (decode and draw off the main thread) where the browser can, and the
 * main-thread player otherwise. Audio is always played on the page.
 */
import { VideoPlayer } from './player.js';

function workerCapable() {
  return typeof Worker === 'function' && typeof OffscreenCanvas === 'function' &&
    typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function' &&
    typeof VideoDecoder === 'function';
}

export class StreamView {
  /* handlers: onJson(obj), onAudio(u8, rate, ch), onStats(s), onFirstFrame(), onOpen(), onClose() */
  constructor(canvas, handlers, { allowWorker = true } = {}) {
    this.canvas = canvas;
    this.h = handlers;
    this.supported = typeof VideoDecoder === 'function';
    this.useWorker = allowWorker && workerCapable() && this._probeOffscreen();
    this.shotWaiters = new Map();
    this.shotId = 0;
    this.hasFrame = false;
    if (this.useWorker) this._initWorker(); else this._initMain();
    const parent = canvas.parentElement;
    const measure = () => {
      const r = parent.getBoundingClientRect();
      this._box(r.width, r.height, window.devicePixelRatio || 1);
    };
    if (window.ResizeObserver) new ResizeObserver(measure).observe(parent);
    window.addEventListener('resize', measure);
    measure();
  }

  _probeOffscreen() {
    try { const t = new OffscreenCanvas(2, 2); return !!(t.getContext('webgl') || t.getContext('2d')); } catch { return false; }
  }

  get mode() { return this.useWorker ? 'worker' : 'main'; }

  _setCss(w, h) { this.canvas.style.width = `${w}px`; this.canvas.style.height = `${h}px`; }

  _first() { this.hasFrame = true; this.h.onFirstFrame && this.h.onFirstFrame(); }

  /* ------------------------------------------------ worker path */
  _initWorker() {
    const off = this.canvas.transferControlToOffscreen();
    this.worker = new Worker(new URL('./media-worker.js', import.meta.url), { type: 'module', name: 'nxb-media' });
    this.worker.onmessage = (ev) => {
      const m = ev.data;
      switch (m.type) {
        case 'json': this.h.onJson && this.h.onJson(JSON.parse(m.data)); break;
        case 'audio': this.h.onAudio && this.h.onAudio(new Uint8Array(m.buf, 16), m.rate, m.ch); break;
        case 'stats': this.h.onStats && this.h.onStats(m.s); break;
        case 'first': this._first(); break;
        case 'css': this._setCss(m.w, m.h); break;
        case 'open': this.open = true; this.h.onOpen && this.h.onOpen(); break;
        case 'close': this.open = false; this.h.onClose && this.h.onClose(); break;
        case 'shot': { const r = this.shotWaiters.get(m.id); if (r) { this.shotWaiters.delete(m.id); r(m.blob); } break; }
        default: break;
      }
    };
    this.worker.postMessage({ type: 'init', canvas: off }, [off]);
  }

  /* ------------------------------------------------ main-thread path */
  _initMain() {
    this.player = new VideoPlayer(this.canvas, {
      onStats: (s) => this.h.onStats && this.h.onStats(s),
      onNeedKey: () => this.send({ type: 'needKey' }),
      onFirstFrame: () => this._first(),
      onCssSize: (w, h) => this._setCss(w, h),
    });
  }

  _connectMain(url, hello) {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => { ws.send(JSON.stringify(hello)); this.open = true; this.h.onOpen && this.h.onOpen(); };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') { this.h.onJson && this.h.onJson(JSON.parse(ev.data)); return; }
      const u8 = new Uint8Array(ev.data), dv = new DataView(ev.data);
      if (u8[0] === 1) this.player.push(u8.subarray(20), (u8[1] & 1) === 1, dv.getUint32(4, true), dv.getUint32(8, true));
      else if (u8[0] === 2 && this.wantAudio !== false) this.h.onAudio && this.h.onAudio(u8.subarray(16), dv.getUint32(4, true), u8[1]);
    };
    ws.onclose = () => { this.ws = null; this.open = false; this.h.onClose && this.h.onClose(); };
  }

  /* ------------------------------------------------ common interface */
  connect(hello) {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    if (this.useWorker) this.worker.postMessage({ type: 'connect', url, hello });
    else this._connectMain(url, hello);
  }

  send(obj) {
    if (this.useWorker) this.worker.postMessage({ type: 'send', msg: JSON.stringify(obj) });
    else if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  _box(w, h, dpr) {
    if (this.useWorker) this.worker.postMessage({ type: 'box', w, h, dpr });
    else this.player.setBox(w, h, dpr);
  }

  remeasure() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this._box(r.width, r.height, window.devicePixelRatio || 1);
  }

  setAdjust(a) { if (this.useWorker) this.worker.postMessage({ type: 'adjust', a }); else this.player.setAdjust(a); }

  setMode(mode) { if (this.useWorker) this.worker.postMessage({ type: 'mode', mode }); else this.player.setMode(mode); }

  /* worker -> AudioWorklet directly (port from AudioPlayer.connectPort) */
  attachAudioPort(port) {
    if (!port || !this.useWorker) return false;
    this.worker.postMessage({ type: 'audioPort', port }, [port]);
    return true;
  }

  setAudio(on) { this.wantAudio = on; if (this.useWorker) this.worker.postMessage({ type: 'audio', on }); }

  reset() { this.hasFrame = false; if (this.useWorker) this.worker.postMessage({ type: 'reset' }); else this.player.reset(); }

  screenshot() {
    if (!this.useWorker) return this.player.screenshot();
    const id = ++this.shotId;
    return new Promise((res) => { this.shotWaiters.set(id, res); this.worker.postMessage({ type: 'shot', id }); });
  }
}
