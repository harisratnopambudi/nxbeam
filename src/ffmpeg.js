'use strict';
/* ffmpeg discovery and the MKV-over-stdin sink shared by recording, clips and restreaming */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { MkvWriter } = require('./mkv');

/*
 * npm 11+ may skip ffmpeg-static's install script (allow-scripts), leaving no
 * binary. Run its downloader ourselves once, the first time NXBeam starts.
 */
function ensureFfmpegStatic() {
  let bin, dir;
  try { bin = require('ffmpeg-static'); dir = path.dirname(require.resolve('ffmpeg-static/package.json')); } catch { return; }
  if (!bin || fs.existsSync(bin)) return;
  console.log('  Mengunduh ffmpeg (sekali saja) / downloading ffmpeg (one time)...');
  const r = spawnSync(process.execPath, [path.join(dir, 'install.js')], { cwd: dir, stdio: 'inherit', timeout: 300000 });
  if (r.status !== 0 || !fs.existsSync(bin)) console.log('  ffmpeg download failed - recordings will be .mkv, live streaming off.');
}

let cached;
function ffmpegPath(configured) {
  if (configured) return configured;
  if (cached !== undefined) return cached;
  const candidates = [];
  try { const p = require('ffmpeg-static'); if (p && fs.existsSync(p)) candidates.push(p); } catch { /* optional */ }
  candidates.push('ffmpeg');
  cached = null;
  for (const c of candidates) {
    if (c !== 'ffmpeg' && !fs.existsSync(c)) continue;
    try {
      const r = spawnSync(c, ['-hide_banner', '-version'], { timeout: 5000 });
      if (r.status === 0) { cached = c; break; }
    } catch { /* try next */ }
  }
  return cached;
}

/*
 * Feeds packets to one ffmpeg process as Matroska on stdin.
 * mode: 'mp4' (file), 'mkv-direct' (no ffmpeg: write the .mkv itself), 'rtmp'.
 */
class MediaSink extends EventEmitter {
  constructor({ ffmpeg, mode, target, audio, label, preset }) {
    super();
    this.preset = preset || 'source';
    this.ffmpeg = ffmpeg;
    this.mode = mode;
    this.target = target;
    this.audioInfo = audio;
    this.label = label || mode;
    this.writer = null;
    this.t0 = null;
    this.out = null;
    this.proc = null;
    this.bytes = 0;
    this.ended = false;
    this.startedAt = Date.now();
    this.log = '';
  }

  _spawn() {
    if (this.mode === 'mkv-direct') {
      this.out = fs.createWriteStream(this.target);
      this.out.on('close', () => this._done(0));
      return;
    }
    const args = ['-hide_banner', '-loglevel', 'error', '-fflags', '+genpts', '-f', 'matroska', '-i', 'pipe:0', '-map', '0'];
    /* 'source': the console's H.264 as it is (no CPU). '1080p60': scaled to
     * 1920x1080 at a steady 60 fps and encoded again (x264, needs a decent CPU) */
    const up = this.preset === '1080p60';
    const vUp = ['-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=60',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-g', '120', '-bf', '2'];
    if (this.mode === 'rtmp') {
      const v = up ? [...vUp, '-b:v', '9000k', '-maxrate', '9000k', '-bufsize', '18000k', '-tune', 'zerolatency'] : ['-c:v', 'copy'];
      args.push(...v, '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-f', 'flv', '-flvflags', 'no_duration_filesize', this.target);
    } else {
      const v = up ? [...vUp, '-crf', '18'] : ['-c:v', 'copy'];
      args.push(...v, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', this.target);
    }
    this.proc = spawn(this.ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    this.proc.stderr.on('data', (d) => { this.log = (this.log + d.toString()).slice(-4000); });
    this.proc.on('error', (e) => { this.log += String(e); this._done(-1); });
    this.proc.on('close', (code) => this._done(code));
    this.proc.stdin.on('error', () => {});
    this.out = this.proc.stdin;
  }

  _write(buf) {
    if (!this.out || this.ended || !buf.length) return;
    this.bytes += buf.length;
    this.out.write(buf);
  }

  /* pkt: {type:'video'|'audio', t (ms, hub clock), key, data, width, height, sps, pps, rate, channels} */
  push(pkt) {
    if (this.ended) return;
    if (!this.writer) {
      if (pkt.type !== 'video' || !pkt.key || !pkt.sps || !pkt.pps) return; // start on a keyframe
      this.writer = new MkvWriter(
        { sps: pkt.sps, pps: pkt.pps, width: pkt.width, height: pkt.height },
        this.audioInfo,
      );
      this.t0 = pkt.t;
      this.width = pkt.width; this.height = pkt.height;
      this._spawn();
      this._write(this.writer.header());
    }
    const ts = pkt.t - this.t0;
    if (pkt.type === 'video') this._write(this.writer.videoBlock(ts, pkt.key, pkt.data));
    else if (pkt.type === 'audio') this._write(this.writer.audioBlock(ts, pkt.data));
  }

  get started() { return !!this.writer; }

  stop() {
    if (this.ended) return Promise.resolve(this.result || { code: 0 });
    return new Promise((resolve) => {
      this.once('done', resolve);
      if (!this.out) { this._done(0); return; }
      this.out.end();
      // a stuck RTMP endpoint must not hang the hub
      setTimeout(() => { if (this.proc && !this.result) this.proc.kill('SIGKILL'); }, 8000);
    });
  }

  _done(code) {
    if (this.result) return;
    this.ended = true;
    this.result = { code, log: this.log.trim(), bytes: this.bytes, target: this.target };
    this.emit('done', this.result);
  }
}

module.exports = { ffmpegPath, ensureFfmpegStatic, MediaSink };
