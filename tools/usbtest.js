#!/usr/bin/env node
'use strict';
/*
 * USB path test without hardware: a fake node-usb module that behaves like the
 * console (header and payload in separate bulk transfers, read timeouts,
 * commands accepted only after a few tries), then the real hub in USB mode.
 */
const Module = require('module');
const assert = require('assert');
const os = require('os');
const path = require('path');
const P = require('../src/protocol');

const C = { LIBUSB_TRANSFER_TIMED_OUT: 2, LIBUSB_ERROR_TIMEOUT: -7, LIBUSB_TRANSFER_NO_DEVICE: 5, LIBUSB_ERROR_NO_DEVICE: -4,
  LIBUSB_ERROR_ACCESS: -3, LIBUSB_ERROR_NOT_SUPPORTED: -12, LIBUSB_ERROR_NOT_FOUND: -5, LIBUSB_ERROR_BUSY: -6 };
const err = (errno, msg) => Object.assign(new Error(msg), { errno });

const fake = { present: true, openErr: null, transfers: [], received: [], outFailFirst: 3, unplugged: false };
// the console's bulk IN transfers: a header, then its payload in pieces
function queuePacket(flags, w, h, payload) {
  fake.transfers.push(P.buildHeader({ flags, width: w, height: h, length: payload.length }));
  for (let o = 0; o < payload.length; o += 100000) fake.transfers.push(payload.subarray(o, o + 100000));
}
const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac]), pps = Buffer.from([0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80]);
const idr = Buffer.concat([sps, pps, Buffer.from([0, 0, 0, 1, 0x65]), Buffer.alloc(250000, 7)]);
const pf = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x41]), Buffer.alloc(30000, 3)]);

const { EventEmitter } = require('events');
const inEp = Object.assign(new EventEmitter(), {
  direction: 'in', timeout: 0, pollActive: false,
  startPoll(n, size) {
    // libusb with n reads queued: each completes at the end of a console transfer (short packet) or when full
    this.pollActive = true;
    const tick = () => {
      if (!this.pollActive) return;
      if (fake.unplugged) { this.pollActive = false; this.emit('error', err(C.LIBUSB_TRANSFER_NO_DEVICE, 'LIBUSB_TRANSFER_NO_DEVICE')); return; }
      const t = fake.transfers[0];
      if (t) {
        if (t.length > size) { fake.transfers[0] = t.subarray(size); this.emit('data', t.subarray(0, size)); }
        else { fake.transfers.shift(); this.emit('data', t); }
      }
      setTimeout(tick, 1);
    };
    tick();
  },
  stopPoll() { this.pollActive = false; this.emit('end'); },
  transfer(len, cb) {
    setTimeout(() => {
      if (fake.unplugged) return cb(err(C.LIBUSB_TRANSFER_NO_DEVICE, 'LIBUSB_TRANSFER_NO_DEVICE'));
      const t = fake.transfers[0];
      if (!t) return cb(err(C.LIBUSB_TRANSFER_TIMED_OUT, 'LIBUSB_TRANSFER_TIMED_OUT'));
      if (t.length > len) {
        // a real device would overflow here: the hub must ask for at least what the console sends
        if (len < 512 || len % 512) return cb(err(-8, 'LIBUSB_ERROR_OVERFLOW (asked ' + len + ' got ' + t.length + ')'));
        fake.transfers[0] = t.subarray(len);
        return cb(null, t.subarray(0, len));
      }
      fake.transfers.shift();
      cb(null, t);
    }, 2);
  },
});
let outTries = 0;
const outEp = {
  direction: 'out', timeout: 0,
  transfer(buf, cb) {
    setTimeout(() => {
      if (++outTries <= fake.outFailFirst) return cb(err(C.LIBUSB_TRANSFER_TIMED_OUT, 'timeout'));
      fake.received.push(Buffer.from(buf).toString('latin1', 0, 4)); cb(null);
    }, 5);
  },
};
const iface = { endpoints: [inEp, outEp], isKernelDriverActive: () => false, detachKernelDriver() {}, claim() {}, release(_c, cb) { cb && cb(); } };
const device = {
  open() { if (fake.openErr) throw err(fake.openErr, 'LIBUSB_ERROR'); },
  close() {}, interface: () => iface,
};
const fakeUsb = { findByIds: (v, p) => (fake.present && v === 0x1209 && p === 0x5f1e ? device : undefined), usb: C };
const load = Module._load;
Module._load = function (req, ...rest) { return req === 'usb' ? fakeUsb : load.call(this, req, ...rest); };

const { Hub } = require('../src/hub');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const config = { mediaDir: path.join(os.tmpdir(), 'nxb-usbtest'), replaySeconds: 10, connection: { mode: 'usb', host: '', scan: false }, restreamTargets: [] };
  // 1) driver problem is reported, not hidden
  fake.openErr = C.LIBUSB_ERROR_NOT_SUPPORTED;
  let hub = new Hub(config, () => {});
  hub.start();
  await wait(300);
  assert.strictEqual(hub.publicState().usbProblem, process.platform === 'win32' ? 'driver' : 'driver');
  assert.strictEqual(hub.conn.state, 'searching');
  console.log('  ok  driver problem reported:', hub.publicState().usbProblem);

  // 2) open works: frames flow, commands get through after retries
  fake.openErr = null;
  await wait(2200);
  assert.strictEqual(hub.conn.state, 'connected');
  assert.strictEqual(hub.conn.kind, 'usb');
  let frames = 0, keys = 0;
  hub.on('video', (p) => { frames++; if (p.key) keys++; });
  queuePacket(P.Flag.H264 | P.Flag.KEY | P.Flag.INPUT, 1920, 1080, idr);
  for (let i = 0; i < 20; i++) queuePacket(P.Flag.H264 | P.Flag.INPUT, 1920, 1080, pf);
  queuePacket(P.Flag.AUDIO, 48000, 2, Buffer.alloc(3840));
  await wait(800);
  assert.strictEqual(frames, 21, `frames ${frames}`);
  assert.strictEqual(keys, 1);
  assert.strictEqual(hub.video.width, 1920);
  assert.ok(hub.takesInput);
  assert.ok(fake.received.includes('SFTK'), 'keyframe request retried until accepted: ' + fake.received);
  console.log(`  ok  USB stream: ${frames} frames 1920x1080, audio ${hub.audio.rate} Hz, commands after ${fake.outFailFirst} timeouts: ${fake.received.join(' ')}`);

  // 3) controller goes out over USB
  hub.takeControl({ id: 1, name: 't' });
  hub.pad({ id: 1 }, { buttons: 1, lx: 0, ly: 0, rx: 0, ry: 0 });
  await wait(300);
  assert.ok(fake.received.includes('SFTI'));
  console.log('  ok  controller message sent over USB');

  // 4) cable pulled: back to searching, then reconnects when it is back
  fake.unplugged = true; fake.present = false;
  await wait(300);
  assert.strictEqual(hub.conn.state, 'searching');
  fake.unplugged = false; fake.present = true;
  await wait(2300);
  assert.strictEqual(hub.conn.state, 'connected');
  console.log('  ok  unplug detected and reconnected');

  // 5) mode switch to network drops the USB link
  config.connection.mode = 'network';
  hub.applyConnectionMode();
  await wait(400);
  assert.ok(!hub.source || hub.source.kind !== 'usb');
  console.log('  ok  switching mode drops the other link');
  hub.stop();
  console.log('\nUSB path OK');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
