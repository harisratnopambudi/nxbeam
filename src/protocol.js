'use strict';
/*
 * NXBeam - wire format spoken by the console-side sysmodule.
 *
 * Console -> PC: a stream of packets, each a 32-byte little-endian header
 * followed by `length` payload bytes.
 *   magic u32 ("SFTR"), version u16, flags u16,
 *   width u32, height u32, stride u32, length u32, extra u32, kind u32
 *
 * PC -> console: 4-byte commands ("SFTK" keyframe, "SFTD" console crops,
 * "SFTL"/"SFTU" lock/unlock picture size) and the 32-byte "SFTI" pad message.
 */

const MAGIC = 0x52544653;
const HEADER_SIZE = 32;
const MAX_PAYLOAD = 64 * 1024 * 1024;

const Flag = Object.freeze({
  PACKED420: 1,
  H264: 2,
  KEY: 4,
  AUDIO: 8,
  STATUS: 16,
  CROP: 32,
  CROP_MID: 64,
  INPUT: 128,
});

const Cmd = Object.freeze({
  KEYFRAME: Buffer.from('SFTK'),
  CONSOLE_CROPS: Buffer.from('SFTD'),
  LOCK_SIZE: Buffer.from('SFTL'),
  FOLLOW_SIZE: Buffer.from('SFTU'),
  BYE: Buffer.from('SFTQ'),
});

/* Switch button bits (HidNpadButton) the console accepts from a viewer */
const Button = Object.freeze({
  A: 0, B: 1, X: 2, Y: 3, LSTICK: 4, RSTICK: 5, L: 6, R: 7, ZL: 8, ZR: 9,
  PLUS: 10, MINUS: 11, LEFT: 12, UP: 13, RIGHT: 14, DOWN: 15, HOME: 18, CAPTURE: 19,
});
const BUTTON_MASK = 0xFFFF | (1 << 18) | (1 << 19);

function parseHeader(buf, off = 0) {
  return {
    magic: buf.readUInt32LE(off),
    version: buf.readUInt16LE(off + 4),
    flags: buf.readUInt16LE(off + 6),
    width: buf.readUInt32LE(off + 8),
    height: buf.readUInt32LE(off + 12),
    stride: buf.readUInt32LE(off + 16),
    length: buf.readUInt32LE(off + 20),
    extra: buf.readUInt32LE(off + 24),
    kind: buf.readUInt32LE(off + 28),
  };
}

function buildHeader(h) {
  const b = Buffer.alloc(HEADER_SIZE);
  b.writeUInt32LE(MAGIC, 0);
  b.writeUInt16LE(h.version || 1, 4);
  b.writeUInt16LE(h.flags || 0, 6);
  b.writeUInt32LE(h.width >>> 0, 8);
  b.writeUInt32LE(h.height >>> 0, 12);
  b.writeUInt32LE((h.stride || 0) >>> 0, 16);
  b.writeUInt32LE(h.length >>> 0, 20);
  b.writeUInt32LE((h.extra || 0) >>> 0, 24);
  b.writeUInt32LE((h.kind || 0) >>> 0, 28);
  return b;
}

function clampStick(v) {
  v = Math.round(Number(v) || 0);
  return v < -32767 ? -32767 : v > 32767 ? 32767 : v;
}

/* the 32-byte SFTI message; state null = release the virtual controller */
function buildPadMessage(state) {
  const m = Buffer.alloc(32);
  m.write('SFTI', 0, 'latin1');
  if (!state) return m;
  m.writeUInt32LE(1, 4);
  const buttons = (Number(state.buttons) >>> 0) & BUTTON_MASK;
  m.writeUInt32LE(buttons, 8);
  m.writeUInt32LE(0, 12);
  m.writeInt32LE(clampStick(state.lx), 16);
  m.writeInt32LE(clampStick(state.ly), 20);
  m.writeInt32LE(clampStick(state.rx), 24);
  m.writeInt32LE(clampStick(state.ry), 28);
  return m;
}

/* status payload: u32 version, u32 reason, char head[64], char detail[120] */
function parseStatus(buf) {
  if (buf.length < 8 + 64 + 120) return null;
  const cstr = (b) => { const z = b.indexOf(0); return b.toString('utf8', 0, z < 0 ? b.length : z); };
  return {
    reason: buf.readUInt32LE(4),
    head: cstr(buf.subarray(8, 72)),
    detail: cstr(buf.subarray(72, 192)),
  };
}

/*
 * Incremental parser for a byte stream (TCP or USB). Feed it chunks; it emits
 * whole packets. Resyncs on a bad magic by scanning for the next "SFTR".
 */
class PacketParser {
  constructor(onPacket, onResync) {
    this.onPacket = onPacket;
    this.onResync = onResync || (() => {});
    this.chunks = [];
    this.size = 0;
    this.header = null;
  }

  reset() { this.chunks = []; this.size = 0; this.header = null; }

  push(chunk) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    for (;;) {
      if (!this.header) {
        if (this.size < HEADER_SIZE) return;
        const head = this._peek(HEADER_SIZE);
        const h = parseHeader(head);
        if (h.magic !== MAGIC) { this._resync(); continue; }
        this._take(HEADER_SIZE);
        if (h.length > MAX_PAYLOAD) { this.onResync('oversize'); continue; }
        this.header = h;
      }
      if (this.size < this.header.length) return;
      const payload = this.header.length ? this._take(this.header.length) : Buffer.alloc(0);
      const h = this.header;
      this.header = null;
      this.onPacket(h, payload);
    }
  }

  /* the payload length still needed for the packet in progress (USB reads ask for exactly that) */
  wanted() {
    if (!this.header) return Math.max(0, HEADER_SIZE - this.size);
    return Math.max(0, this.header.length - this.size);
  }

  _peek(n) {
    if (this.chunks[0].length >= n) return this.chunks[0].subarray(0, n);
    const all = Buffer.concat(this.chunks);
    this.chunks = [all];
    return all.subarray(0, n);
  }

  _take(n) {
    let out;
    if (this.chunks[0].length >= n) {
      out = this.chunks[0].subarray(0, n);
      if (this.chunks[0].length === n) this.chunks.shift();
      else this.chunks[0] = this.chunks[0].subarray(n);
    } else {
      const all = Buffer.concat(this.chunks);
      out = all.subarray(0, n);
      this.chunks = all.length > n ? [all.subarray(n)] : [];
    }
    this.size -= n;
    return out;
  }

  _resync() {
    const all = Buffer.concat(this.chunks);
    const idx = all.indexOf('SFTR', 1, 'latin1');
    if (idx < 0) {
      const keep = all.subarray(Math.max(0, all.length - 3));
      this.chunks = keep.length ? [keep] : [];
      this.size = keep.length;
    } else {
      this.chunks = [all.subarray(idx)];
      this.size = all.length - idx;
    }
    this.onResync('magic');
  }
}

module.exports = {
  MAGIC, HEADER_SIZE, Flag, Cmd, Button, BUTTON_MASK,
  parseHeader, buildHeader, buildPadMessage, parseStatus, PacketParser,
};
