'use strict';
/*
 * A tiny live Matroska writer: H.264 (avcC) + 16-bit PCM, millisecond
 * timestamps. Used to hand recordings, replay clips and restreams to ffmpeg
 * as ONE timestamped input on stdin (works the same on Windows, Linux, macOS).
 */
const { avcC, toAvcc } = require('./h264');

function vint(n) {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const b = Buffer.alloc(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) { b[i] = v & 0xff; v = Math.floor(v / 256); }
      b[0] |= 1 << (8 - len);
      return b;
    }
  }
  throw new Error('vint too large');
}

const UNKNOWN = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const id = (hex) => Buffer.from(hex, 'hex');
const el = (hex, payload) => Buffer.concat([id(hex), vint(payload.length), payload]);
const uint = (hex, v) => {
  const bytes = [];
  do { bytes.unshift(v & 0xff); v = Math.floor(v / 256); } while (v > 0);
  return el(hex, Buffer.from(bytes));
};
const str = (hex, s) => el(hex, Buffer.from(s, 'utf8'));
const f64 = (hex, v) => { const b = Buffer.alloc(8); b.writeDoubleBE(v); return el(hex, b); };

class MkvWriter {
  /* video: {sps, pps, width, height}; audio: {rate, channels} or null */
  constructor(video, audio) {
    this.video = video;
    this.audio = audio;
    this.clusterTs = -1;
  }

  header() {
    const ebml = el('1a45dfa3', Buffer.concat([
      uint('4286', 1), uint('42f7', 1), uint('42f2', 4), uint('42f3', 8),
      str('4282', 'matroska'), uint('4287', 4), uint('4285', 2),
    ]));
    const info = el('1549a966', Buffer.concat([
      uint('2ad7b1', 1000000), str('4d80', 'NXBeam'), str('5741', 'NXBeam'),
    ]));
    const tracks = [el('ae', Buffer.concat([
      uint('d7', 1), uint('73c5', 1), uint('83', 1), uint('9c', 0),
      str('86', 'V_MPEG4/ISO/AVC'),
      el('63a2', avcC(this.video.sps, this.video.pps)),
      el('e0', Buffer.concat([uint('b0', this.video.width), uint('ba', this.video.height)])),
    ]))];
    if (this.audio) {
      tracks.push(el('ae', Buffer.concat([
        uint('d7', 2), uint('73c5', 2), uint('83', 2), uint('9c', 0),
        str('86', 'A_PCM/INT/LIT'),
        el('e1', Buffer.concat([f64('b5', this.audio.rate), uint('9f', this.audio.channels), uint('6264', 16)])),
      ])));
    }
    return Buffer.concat([ebml, id('18538067'), UNKNOWN, info, el('1654ae6b', Buffer.concat(tracks))]);
  }

  _block(track, ts, key, data) {
    const out = [];
    if (this.clusterTs < 0 || (key && track === 1) || ts - this.clusterTs > 30000) {
      this.clusterTs = ts;
      out.push(id('1f43b675'), UNKNOWN, uint('e7', ts));
    }
    const head = Buffer.alloc(4);
    head[0] = 0x80 | track;
    head.writeInt16BE(ts - this.clusterTs, 1);
    head[3] = key ? 0x80 : 0;
    out.push(el('a3', Buffer.concat([head, data])));
    return Buffer.concat(out);
  }

  videoBlock(tsMs, key, annexb) { return this._block(1, Math.max(0, Math.round(tsMs)), key, toAvcc(annexb)); }

  audioBlock(tsMs, pcm) {
    if (!this.audio) return Buffer.alloc(0);
    // never step back before the cluster start
    const ts = Math.max(this.clusterTs < 0 ? 0 : this.clusterTs, Math.round(tsMs));
    return this._block(2, ts, true, pcm);
  }
}

module.exports = { MkvWriter };
