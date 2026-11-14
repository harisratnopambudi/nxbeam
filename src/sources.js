'use strict';
/*
 * Ways to reach the console. Every source is an EventEmitter that emits
 *   'packet' (header, payload)   'open' (info)   'close' (reason)
 * and has send(buffer) and close().
 */
const net = require('net');
const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');
const { PacketParser, Cmd } = require('./protocol');

const NET_PORT = 9950;
const BEACON_PORT = 9951;
const USB_VID = 0x1209;
const USB_PID = 0x5f1e;

/* ---------------------------------------------------------------- network */
class NetworkSource extends EventEmitter {
  constructor(host, port = NET_PORT) {
    super();
    this.kind = 'network';
    this.host = host;
    this.port = port;
    this.sock = null;
    this.closed = false;
  }

  open(timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      const t = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, timeoutMs);
      s.once('error', (e) => { clearTimeout(t); reject(e); });
      s.once('connect', () => {
        clearTimeout(t);
        s.removeAllListeners('error');
        s.setNoDelay(true);
        s.setKeepAlive(true, 2000);
        this.sock = s;
        const parser = new PacketParser(
          (h, p) => this.emit('packet', h, p),
          (why) => this.emit('resync', why),
        );
        s.on('data', (d) => parser.push(d));
        s.on('error', () => {});
        s.on('close', () => this._closed('network connection closed'));
        this.emit('open', { kind: 'network', peer: this.host });
        resolve(this);
      });
    });
  }

  send(buf) { if (this.sock && !this.sock.destroyed) this.sock.write(buf); }

  close() { if (this.sock) { this.sock.destroy(); } this._closed('closed by hub'); }

  _closed(reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', reason);
  }
}

/* ---------------------------------------------------------------- USB */
/* node-usb 2.x (legacy API: findByIds / Device / InEndpoint) */
let usbLib = null;
let usbLoadError = '';
function loadUsb() {
  if (usbLib !== null) return usbLib;
  try {
    const m = require('usb');
    if (typeof m.findByIds === 'function') usbLib = m;
    else { usbLib = false; usbLoadError = 'usb module has the wrong API (version 3?) - run npm install'; }
  } catch (e) { usbLib = false; usbLoadError = e.message.split('\n')[0]; }
  return usbLib;
}

/* what libusb can see: for the USB check in the UI */
function usbDiagnostics() {
  const usb = loadUsb();
  let version = null;
  try { version = require('usb/package.json').version; } catch { /* missing */ }
  if (!usb) return { lib: false, version, error: usbLoadError, devices: [] };
  let devices = [];
  try {
    devices = usb.getDeviceList().map((d) => ({
      vid: d.deviceDescriptor.idVendor, pid: d.deviceDescriptor.idProduct,
      bus: d.busNumber, port: d.portNumbers ? d.portNumbers.join('.') : '',
    }));
  } catch (e) { return { lib: true, version, error: e.message, devices: [] }; }
  return { lib: true, version, error: '', devices };
}

/* what a failed open means, in words the UI can act on */
function usbOpenProblem(e) {
  const C = loadUsb() ? loadUsb().usb : {};
  const n = e && e.errno;
  if (n === C.LIBUSB_ERROR_ACCESS) return process.platform === 'win32' ? 'driver' : 'permission';
  if (n === C.LIBUSB_ERROR_NOT_SUPPORTED || n === C.LIBUSB_ERROR_NOT_FOUND) return 'driver';
  if (n === C.LIBUSB_ERROR_BUSY) return 'busy';
  return 'error';
}

class UsbSource extends EventEmitter {
  constructor() {
    super();
    this.kind = 'usb';
    this.dev = null;
    this.iface = null;
    this.inEp = null;
    this.outEp = null;
    this.closed = false;
    this.txQueue = [];
    this.txBusy = false;
  }

  static available() { return !!loadUsb(); }

  static present() {
    const usb = loadUsb();
    if (!usb) return false;
    try { return !!usb.findByIds(USB_VID, USB_PID); } catch { return false; }
  }

  open() {
    const usb = loadUsb();
    if (!usb) { const e = new Error('USB support is not installed'); e.problem = 'nolib'; throw e; }
    const dev = usb.findByIds(USB_VID, USB_PID);
    if (!dev) { const e = new Error('console not found on USB'); e.problem = 'absent'; throw e; }
    try {
      dev.open();
      const iface = dev.interface(0);
      try { if (iface.isKernelDriverActive()) iface.detachKernelDriver(); } catch { /* not on Windows / macOS */ }
      iface.claim();
      this.iface = iface;
      this.inEp = iface.endpoints.find((ep) => ep.direction === 'in');
      this.outEp = iface.endpoints.find((ep) => ep.direction === 'out');
      if (!this.inEp) throw Object.assign(new Error('no IN endpoint'), { errno: -99 });
    } catch (e) {
      try { dev.close(); } catch { /* ignore */ }
      e.problem = e.problem || usbOpenProblem(e);
      throw e;
    }
    this.dev = dev;
    const C = usb.usb;
    const parser = new PacketParser(
      (h, p) => this.emit('packet', h, p),
      (why) => this.emit('resync', why),
    );
    /*
     * Keep four 256 KB reads queued in libusb at all times, so the console never
     * waits for the PC between transfers (one read at a time leaves a gap after
     * each, while the callback hops through the event loop). The parser takes
     * the data as a byte stream, so where a read ends does not matter.
     */
    this.inEp.timeout = 0;
    this.inEp.on('data', (d) => { if (!this.closed && d.length) parser.push(d); });
    this.inEp.on('error', (err) => {
      if (this.closed) return;
      const gone = err.errno === C.LIBUSB_TRANSFER_NO_DEVICE || err.errno === C.LIBUSB_ERROR_NO_DEVICE;
      this._closed(gone ? 'the console left USB' : `USB read: ${err.message}`);
    });
    this.inEp.on('end', () => { if (!this.closed) this._closed('USB reads stopped'); });
    this.emit('open', { kind: 'usb', peer: 'USB' });
    this.inEp.startPoll(4, 0x40000);
    return this;
  }

  /*
   * The console takes a request over USB only while a buffer of its own waits
   * for it, so a command can time out: try again, 150 ms apart (as the original
   * viewer does). Pad states are only worth sending once: the hub repeats them.
   */
  send(buf) {
    if (!this.outEp || this.closed) return;
    const isPad = buf.length === 32 && buf.toString('latin1', 0, 4) === 'SFTI';
    if (isPad) {
      const i = this.txQueue.findIndex((m) => m.pad);
      if (i >= 0) this.txQueue.splice(i, 1);
    }
    this.txQueue.push({ buf, pad: isPad, tries: isPad ? 1 : 14 });
    this._pump();
  }

  _pump() {
    if (this.txBusy || this.closed || !this.txQueue.length) return;
    const m = this.txQueue[0];
    this.txBusy = true;
    this.outEp.timeout = 40;
    this.outEp.transfer(m.buf, (err) => {
      this.txBusy = false;
      if (this.closed) return;
      if (err && --m.tries > 0) { setTimeout(() => this._pump(), 150); return; }
      this.txQueue.shift();
      this._pump();
    });
  }

  close() {
    if (this.closed) return;
    const dev = this.dev, iface = this.iface, out = this.outEp, inEp = this.inEp;
    this._closed('closed by hub');
    try { if (inEp && inEp.pollActive) inEp.stopPoll(); } catch { /* ignore */ }
    try { if (out) { out.timeout = 200; out.transfer(Cmd.BYE, () => {}); } } catch { /* ignore */ }
    setTimeout(() => {
      try { iface.release(true, () => { try { dev.close(); } catch { /* ignore */ } }); } catch { try { dev.close(); } catch { /* ignore */ } }
    }, 250);
  }

  _closed(reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', reason);
  }
}

/* ---------------------------------------------------------------- discovery */

/* listens for the console's "SFTAP1 <ip> <port>" beacon on UDP 9951 */
class BeaconListener extends EventEmitter {
  start() {
    this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock.on('error', (e) => this.emit('error', e));
    this.sock.on('message', (msg, rinfo) => {
      const m = /^SFTAP1\s+(\S+)\s+(\d+)/.exec(msg.toString('latin1'));
      if (!m) return;
      // connect to where it came from: the address inside may be another interface's
      this.emit('beacon', { host: rinfo.address, port: Number(m[2]) || NET_PORT });
    });
    this.sock.bind(BEACON_PORT);
    return this;
  }
  stop() { try { this.sock.close(); } catch { /* ignore */ } }
}

function localSubnets() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const p = a.address.split('.').map(Number);
      out.push({ self: a.address, base: `${p[0]}.${p[1]}.${p[2]}.` });
    }
  }
  return out;
}

/*
 * Access points often drop broadcasts between wireless clients, so the beacon
 * may never arrive: probe every host of the local /24s on TCP 9950.
 * Resolves with the first host that accepts, or null.
 */
function scanSubnets(port = NET_PORT, timeoutMs = 600) {
  const hosts = [];
  for (const s of localSubnets()) {
    for (let i = 1; i < 255; i++) { const h = s.base + i; if (h !== s.self) hosts.push(h); }
  }
  if (!hosts.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    let pending = hosts.length, done = false;
    const sockets = [];
    for (const h of hosts) {
      const s = net.createConnection({ host: h, port });
      sockets.push(s);
      s.setTimeout(timeoutMs);
      const fin = (ok) => {
        s.destroy();
        if (ok && !done) { done = true; sockets.forEach((x) => x.destroy()); resolve(h); }
        if (--pending === 0 && !done) resolve(null);
      };
      s.once('connect', () => fin(true));
      s.once('timeout', () => fin(false));
      s.once('error', () => fin(false));
    }
  });
}

module.exports = { usbDiagnostics, NetworkSource, UsbSource, BeaconListener, scanSubnets, localSubnets, NET_PORT, BEACON_PORT };
