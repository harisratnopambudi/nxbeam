'use strict';
/*
 * The hub: one connection to the console, any number of viewers.
 * Keeps the GOP since the last keyframe (instant start for new viewers),
 * a replay ring buffer, stats, and the recording / restream sinks.
 */
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { Flag, Cmd, buildPadMessage, parseStatus } = require('./protocol');
const { NetworkSource, UsbSource, BeaconListener, scanSubnets } = require('./sources');
const { findParams, codecString } = require('./h264');
const { ffmpegPath, MediaSink } = require('./ffmpeg');

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, monotonic

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

class Hub extends EventEmitter {
  constructor(config, saveConfig) {
    super();
    this.config = config;
    this.saveConfig = saveConfig;
    this.source = null;
    this.connecting = false;
    this.conn = { state: 'searching', kind: null, peer: null, since: null, error: null };
    this.consoleStatus = null;
    this.takesInput = false;
    this.video = null;              // {width, height, codec, sps, pps}
    this.audio = { rate: 48000, channels: 2, seen: false };
    this.gop = [];                  // packets since the last keyframe
    this.replay = [];               // ring buffer for clips
    this.stats = { fps: 0, kbps: 0, akbps: 0, frames: 0, keys: 0, resyncs: 0, history: [] };
    this._win = { frames: 0, vbytes: 0, abytes: 0, maxGap: 0, hitches: 0 };
    this.srcIntervals = [];
    this.lastVideoAt = 0;
    this.recorder = null;
    this.restreams = new Map();     // id -> {sink, target, startedAt}
    this.pilot = null;              // {id, name, since}
    this.padState = null;
    this.padSentAt = 0;
    this.lastBeacon = 0;
    this.ffmpeg = ffmpegPath(config.ffmpegPath);
    this.mediaDir = path.resolve(config.mediaDir);
    for (const d of ['recordings', 'clips', 'screenshots']) fs.mkdirSync(path.join(this.mediaDir, d), { recursive: true });
  }

  /* ------------------------------------------------------------ connection */
  start() {
    this.beacon = new BeaconListener();
    this.beacon.on('beacon', (b) => this._onBeacon(b));
    this.beacon.on('error', (e) => this.emit('log', `beacon: ${e.message}`));
    try { this.beacon.start(); } catch (e) { this.emit('log', `beacon: ${e.message}`); }
    this._tick = setInterval(() => this._connectTick(), 2000);
    this._statTick = setInterval(() => this._statsTick(), 1000);
    this._padTick = setInterval(() => this._padRepeat(), 100);
    this._lastScan = 0;
    this._connectTick();
  }

  stop() {
    clearInterval(this._tick); clearInterval(this._statTick); clearInterval(this._padTick);
    if (this.beacon) this.beacon.stop();
    if (this.source) this.source.close();
  }

  _setConn(patch) {
    Object.assign(this.conn, patch);
    this.emit('state');
  }

  _onBeacon({ host, port }) {
    this.lastBeacon = Date.now();
    const mode = this.config.connection.mode;
    if (mode === 'usb') return;
    // a beacon means the console has no viewer: if we think we are its viewer, that link is dead
    if (this.source && this.source.kind === 'network' && this.source.host === host) {
      this.emit('log', 'console is beaconing again - reconnecting');
      this.source.close();
      return;
    }
    if (!this.source && !this.connecting) this._tryNetwork(host, port);
  }

  async _connectTick() {
    if (this.source || this.connecting) return;
    const { mode, host } = this.config.connection;
    if (mode === 'auto' || mode === 'usb') {
      if (!UsbSource.available()) this.usbProblem = 'nolib';
      else if (!UsbSource.present()) this.usbProblem = 'absent';
      else {
        const s = new UsbSource();
        try {
          this.connecting = true;
          this._attach(s);
          s.open();
          this.usbProblem = null;
          return;
        } catch (e) {
          this._detach();
          this.usbProblem = e.problem || 'error';
          if (this._lastUsbErr !== e.message) { this._lastUsbErr = e.message; this.emit('log', `USB: ${e.message} (${this.usbProblem})`); }
        } finally { this.connecting = false; }
      }
    }
    if (mode === 'usb') { this._setConn({ state: 'searching', kind: 'usb', peer: null, error: null }); return; }
    if (host) { await this._tryNetwork(host); if (this.source) return; }
    if (mode === 'auto' || mode === 'network') {
      const t = Date.now();
      if (t - this._lastScan > 20000 && t - this.lastBeacon > 5000 && this.config.connection.scan !== false) {
        this._lastScan = t;
        this._setConn({ state: 'scanning' });
        const found = await scanSubnets();
        if (found && !this.source && this.config.connection.mode !== 'usb') await this._tryNetwork(found);
        else if (!this.source) this._setConn({ state: 'searching' });
      }
    }
  }

  /* the mode changed in Settings: drop a link the new mode does not allow */
  applyConnectionMode() {
    const mode = this.config.connection.mode;
    if (this.source && ((mode === 'usb' && this.source.kind !== 'usb') || (mode === 'network' && this.source.kind !== 'network'))) {
      this.emit('log', `connection mode is now ${mode} - closing the ${this.source.kind} link`);
      this.source.close();
    }
    this._setConn({ state: 'searching', kind: mode === 'usb' ? 'usb' : null, peer: null, error: null });
    setTimeout(() => this._connectTick(), 300);
  }

  async _tryNetwork(host, port) {
    if (this.source || this.connecting) return;
    this.connecting = true;
    this._setConn({ state: 'connecting', kind: 'network', peer: host });
    const s = new NetworkSource(host, port);
    try {
      this._attach(s);
      await s.open();
      if (this.config.connection.host !== host) {
        this.config.connection.host = host;
        this.saveConfig();
      }
    } catch (e) {
      this._detach();
      this._setConn({ state: 'searching', error: `${host}: ${e.code || e.message}` });
    } finally { this.connecting = false; }
  }

  _attach(s) {
    this.source = s;
    s.on('open', (info) => {
      this._setConn({ state: 'connected', kind: info.kind, peer: info.peer, since: Date.now(), error: null });
      this.emit('log', `connected over ${info.kind} (${info.peer})`);
      this.sendCommands(true);
    });
    s.on('packet', (h, p) => this._onPacket(h, p));
    s.on('resync', () => { this.stats.resyncs++; this.sendCommands(true); });
    s.on('close', (why) => {
      this.emit('log', `disconnected: ${why}`);
      this._detach();
      this._setConn({ state: 'searching', since: null, error: why });
    });
  }

  _detach() {
    if (this.source) this.source.removeAllListeners();
    this.source = null;
    this.takesInput = false;
    this.gop = [];
    this.lastVideoAt = 0;
    this.srcIntervals = [];
    if (!this.recorder && !this.restreams.size) this.video = null; // the next console may send another size
  }

  reconnect() { if (this.source) this.source.close(); else this._connectTick(); }

  connectTo(host) {
    if (this.config.connection.mode === 'usb') { this.reconnect(); return; }
    this.config.connection.host = host;
    this.saveConfig();
    if (this.source) this.source.close();
    this._tryNetwork(host);
  }

  /* SFTK + SFTD (the console crops for us) + SFTL/SFTU (lock the size while a file or restream runs) */
  sendCommands(withKey) {
    if (!this.source) return;
    const lock = (this.recorder || this.restreams.size > 0) && this.config.lockSizeWhileRecording !== false;
    const parts = [];
    if (withKey) parts.push(Cmd.KEYFRAME);
    parts.push(Cmd.CONSOLE_CROPS, lock ? Cmd.LOCK_SIZE : Cmd.FOLLOW_SIZE);
    this.source.send(Buffer.concat(parts));
  }

  requestKeyframe() { this.sendCommands(true); }

  /* ------------------------------------------------------------ packets */
  _onPacket(h, payload) {
    const t = now();
    const isAudio = (h.flags & Flag.AUDIO) !== 0;
    if (!isAudio || (h.flags & Flag.STATUS)) {
      const ti = (h.flags & Flag.INPUT) !== 0;
      if (ti !== this.takesInput) { this.takesInput = ti; this.emit('state'); }
    }
    if (isAudio) {
      if (h.flags & Flag.STATUS) {
        const st = parseStatus(payload);
        if (st) { this.consoleStatus = { ...st, at: Date.now() }; this.emit('state'); }
        return;
      }
      if (!h.width || !h.height) return;
      if (!this.audio.seen || this.audio.rate !== h.width || this.audio.channels !== h.height) {
        this.audio = { rate: h.width, channels: h.height, seen: true };
        this.emit('state');
      }
      const pkt = { type: 'audio', t, data: payload, rate: h.width, channels: h.height };
      this._win.abytes += payload.length;
      this._toReplay(pkt);
      this._toSinks(pkt);
      this.emit('audio', pkt);
      return;
    }
    if (!(h.flags & Flag.H264)) return; // raw / packed pictures are debug modes of the console
    const key = (h.flags & Flag.KEY) !== 0;
    const pkt = { type: 'video', t, key, data: payload, width: h.width, height: h.height };
    if (key) {
      const { sps, pps } = findParams(payload);
      if (sps && pps) {
        const codec = codecString(sps);
        const changed = !this.video || this.video.width !== h.width || this.video.height !== h.height || this.video.codec !== codec;
        this.video = { width: h.width, height: h.height, codec, sps, pps };
        if (changed) { this.emit('state'); this._onVideoFormatChange(); }
      }
      this.gop = [];
      this.stats.keys++;
    }
    if (!this.video) return; // nothing decodable before the first keyframe
    // how evenly the console delivers frames: gaps here are the console's (or the link's), not the browser's
    if (this.lastVideoAt) {
      const gap = t - this.lastVideoAt;
      this.srcIntervals.push(gap);
      if (this.srcIntervals.length > 120) this.srcIntervals.shift();
      const sorted = [...this.srcIntervals].sort((x, y) => x - y);
      const med = sorted[sorted.length >> 1] || 16.7;
      if (gap > this._win.maxGap) this._win.maxGap = gap;
      if (this.srcIntervals.length > 30 && gap > Math.max(med * 2.2, med + 20)) this._win.hitches++;
    }
    this.lastVideoAt = t;
    pkt.sps = this.video.sps; pkt.pps = this.video.pps;
    if (this.gop.length < 1200) this.gop.push(pkt);
    this.stats.frames++;
    this._win.frames++;
    this._win.vbytes += payload.length;
    this._toReplay(pkt);
    this._toSinks(pkt);
    this.emit('video', pkt);
  }

  _statsTick() {
    const w = this._win;
    this.stats.fps = w.frames;
    this.stats.kbps = Math.round((w.vbytes * 8) / 1000);
    this.stats.akbps = Math.round((w.abytes * 8) / 1000);
    this.stats.srcMaxGap = Math.round(w.maxGap);
    this.stats.srcHitches = w.hitches;
    this.stats.srcHitchTotal = (this.stats.srcHitchTotal || 0) + w.hitches;
    this.stats.history.push({ t: Date.now(), fps: w.frames, kbps: this.stats.kbps, gap: Math.round(w.maxGap) });
    if (this.stats.history.length > 180) this.stats.history.shift();
    this._win = { frames: 0, vbytes: 0, abytes: 0, maxGap: 0, hitches: 0 };
    this.emit('stats', this.statsSnapshot());
  }

  statsSnapshot() {
    const replaySec = this.replay.length ? (this.replay[this.replay.length - 1].t - this.replay[0].t) / 1000 : 0;
    return {
      fps: this.stats.fps, kbps: this.stats.kbps, akbps: this.stats.akbps,
      frames: this.stats.frames, keys: this.stats.keys, resyncs: this.stats.resyncs,
      srcMaxGap: this.stats.srcMaxGap || 0, srcHitches: this.stats.srcHitches || 0, srcHitchTotal: this.stats.srcHitchTotal || 0,
      replaySeconds: Math.round(replaySec),
      recording: this.recorder ? { since: this.recorder.startedAt, bytes: this.recorder.bytes, file: path.basename(this.recorder.target) } : null,
      restreams: [...this.restreams.entries()].map(([id, r]) => ({ id, name: r.name, since: r.sink.startedAt, bytes: r.sink.bytes })),
      last: this.stats.history[this.stats.history.length - 1] || null,
    };
  }

  /* ------------------------------------------------------------ replay buffer */
  _toReplay(pkt) {
    const keep = Number(this.config.replaySeconds) || 0;
    if (keep <= 0) { this.replay = []; return; }
    this.replay.push(pkt);
    const cutoff = pkt.t - keep * 1000;
    // drop whole GOPs: keep the buffer starting on a keyframe
    let firstKeepKey = -1;
    for (let i = 1; i < this.replay.length; i++) {
      const p = this.replay[i];
      if (p.type === 'video' && p.key) {
        if (p.t <= cutoff) firstKeepKey = i; else break;
      }
    }
    if (firstKeepKey > 0) this.replay.splice(0, firstKeepKey);
  }

  async saveClip(seconds) {
    if (!this.replay.length) throw new Error('replay buffer is empty');
    const end = this.replay[this.replay.length - 1].t;
    const want = Math.max(5, Number(seconds) || Number(this.config.replaySeconds) || 30);
    // start on the last keyframe at or before end - want
    let start = 0;
    for (let i = 0; i < this.replay.length; i++) {
      const p = this.replay[i];
      if (p.type === 'video' && p.key && p.t <= end - want * 1000) start = i;
    }
    const pkts = this.replay.slice(start);
    const name = `clip-${stamp()}.${this.ffmpeg ? 'mp4' : 'mkv'}`;
    const target = path.join(this.mediaDir, 'clips', name);
    const sink = new MediaSink({ ffmpeg: this.ffmpeg, mode: this.ffmpeg ? 'mp4' : 'mkv-direct', target, audio: this.audio.seen ? this.audio : null, preset: this.ffmpeg ? this.config.recordPreset : 'source' });
    for (const p of pkts) sink.push(p);
    const res = await sink.stop();
    if (res.code !== 0) throw new Error(`clip failed: ${res.log || res.code}`);
    this.emit('media', { kind: 'clips', name });
    return { name, seconds: Math.round((end - pkts[0].t) / 1000) };
  }

  /* ------------------------------------------------------------ recording / restream */
  _toSinks(pkt) {
    if (this.recorder) this.recorder.push(pkt);
    for (const r of this.restreams.values()) r.sink.push(pkt);
  }

  _onVideoFormatChange() {
    // a new picture size cannot continue in the same file: roll the recording
    if (this.recorder && this.recorder.started &&
        (this.recorder.width !== this.video.width || this.recorder.height !== this.video.height)) {
      this.emit('log', 'picture size changed - starting a new recording file');
      const old = this.recorder;
      this.recorder = null;
      old.stop().then(() => this.emit('media', { kind: 'recordings' }));
      this.startRecording();
    }
  }

  /* start a new sink from the current GOP (video and the audio beside it) so nothing is lost */
  _primeSink(sink) {
    if (!this.gop.length) return;
    const from = this.gop[0].t;
    const src = this.replay.length && this.replay[0].t <= from ? this.replay : this.gop;
    for (const p of src) if (p.t >= from) sink.push(p);
  }

  startRecording() {
    if (this.recorder) return { file: path.basename(this.recorder.target) };
    const ext = this.ffmpeg ? 'mp4' : 'mkv';
    const target = path.join(this.mediaDir, 'recordings', `nxbeam-${stamp()}.${ext}`);
    const sink = new MediaSink({ ffmpeg: this.ffmpeg, mode: this.ffmpeg ? 'mp4' : 'mkv-direct', target, audio: this.audio.seen ? this.audio : { rate: 48000, channels: 2 }, preset: this.ffmpeg ? this.config.recordPreset : 'source' });
    this.recorder = sink;
    this._primeSink(sink);
    this.sendCommands(true);
    this.emit('state');
    return { file: path.basename(target) };
  }

  async stopRecording() {
    const r = this.recorder;
    if (!r) return null;
    this.recorder = null;
    this.sendCommands(false);
    this.emit('state');
    const res = await r.stop();
    if (!r.started) { try { fs.unlinkSync(r.target); } catch { /* never created */ } }
    this.emit('media', { kind: 'recordings' });
    return { file: path.basename(r.target), ok: res.code === 0, log: res.log };
  }

  startRestream(targetId) {
    if (!this.ffmpeg) throw new Error('restreaming needs ffmpeg');
    const t = (this.config.restreamTargets || []).find((x) => x.id === targetId);
    if (!t) throw new Error('unknown restream target');
    if (this.restreams.has(t.id)) return;
    const url = t.key ? `${t.url.replace(/\/+$/, '')}/${t.key}` : t.url;
    const sink = new MediaSink({ ffmpeg: this.ffmpeg, mode: 'rtmp', target: url, audio: this.audio.seen ? this.audio : { rate: 48000, channels: 2 }, preset: this.config.livePreset });
    sink.on('done', (res) => {
      if (this.restreams.get(t.id)?.sink === sink) {
        this.restreams.delete(t.id);
        this.emit('log', `restream ${t.name} ended${res.code ? ': ' + res.log : ''}`);
        this.emit('toast', { level: res.code ? 'error' : 'info', key: res.code ? 'restreamFailed' : 'restreamEnded', arg: t.name });
        this.sendCommands(false);
        this.emit('state');
      }
    });
    this.restreams.set(t.id, { sink, name: t.name });
    this._primeSink(sink);
    this.sendCommands(true);
    this.emit('state');
  }

  async stopRestream(id) {
    const r = this.restreams.get(id);
    if (!r) return;
    this.restreams.delete(id);
    this.sendCommands(false);
    this.emit('state');
    await r.sink.stop();
  }

  /* ------------------------------------------------------------ controller */
  takeControl(client) {
    const prev = this.pilot;
    this.pilot = { id: client.id, name: client.name, since: Date.now() };
    this.padState = null;
    if (prev && prev.id !== client.id) this.emit('pilotChanged', { from: prev, to: this.pilot });
    this.emit('state');
  }

  releaseControl(client) {
    if (!this.pilot || (client && this.pilot.id !== client.id)) return;
    this.pilot = null;
    this.padState = null;
    if (this.source) this.source.send(buildPadMessage(null));
    this.emit('pad', null);
    this.emit('state');
  }

  pad(client, state) {
    if (!this.pilot || this.pilot.id !== client.id) return false;
    this.padState = state;
    this._sendPad();
    this.emit('pad', state);
    return true;
  }

  _sendPad() {
    if (!this.source || !this.padState) return;
    this.source.send(buildPadMessage(this.padState));
    this.padSentAt = Date.now();
  }

  _padRepeat() {
    // the console lets the virtual controller go after 3 s of silence
    if (this.padState && Date.now() - this.padSentAt >= 100) this._sendPad();
  }

  /* ------------------------------------------------------------ state */
  publicState() {
    return {
      now: Date.now(),
      conn: this.conn,
      consoleStatus: this.consoleStatus && Date.now() - this.consoleStatus.at < 6000 ? this.consoleStatus : null,
      takesInput: this.takesInput,
      video: this.video ? { width: this.video.width, height: this.video.height, codec: this.video.codec } : null,
      audio: this.audio.seen ? { rate: this.audio.rate, channels: this.audio.channels } : null,
      recording: this.recorder ? { file: path.basename(this.recorder.target), since: this.recorder.startedAt } : null,
      restreams: [...this.restreams.keys()],
      restreamSince: Math.min(...[...this.restreams.values()].map((r) => r.sink.startedAt), Infinity),
      pilot: this.pilot,
      ffmpeg: !!this.ffmpeg,
      usb: UsbSource.available(),
      usbProblem: this.config.connection.mode === 'network' ? null : this.usbProblem || null,
      mode: this.config.connection.mode,
      replaySeconds: Number(this.config.replaySeconds) || 0,
    };
  }
}

module.exports = { Hub };
