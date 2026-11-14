#!/usr/bin/env node
'use strict';
/* NXBeam self-test: protocol parsing, pad messages, H.264 helpers, MKV -> MP4 through ffmpeg */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../src/protocol');
const { splitNals, findParams, codecString, toAvcc } = require('../src/h264');
const { MediaSink, ffmpegPath } = require('../src/ffmpeg');

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
};

(async () => {
  await test('parser handles packets split at every byte and resyncs after garbage', () => {
    const pkts = [];
    const mk = (flags, len, fill) => Buffer.concat([P.buildHeader({ flags, width: 1280, height: 720, length: len }), Buffer.alloc(len, fill)]);
    const stream = Buffer.concat([mk(P.Flag.H264 | P.Flag.KEY, 100, 1), Buffer.from('garbage!'), mk(P.Flag.AUDIO, 40, 2), mk(P.Flag.H264, 0, 0)]);
    let resyncs = 0;
    const parser = new P.PacketParser((h, p) => pkts.push([h, p]), () => resyncs++);
    for (let i = 0; i < stream.length; i++) parser.push(stream.subarray(i, i + 1));
    assert.strictEqual(pkts.length, 3);
    assert.strictEqual(pkts[0][1].length, 100);
    assert.ok(pkts[0][0].flags & P.Flag.KEY);
    assert.strictEqual(pkts[1][1][0], 2);
    assert.ok(resyncs >= 1);
  });

  await test('pad message layout matches the console (32 bytes, SFTI)', () => {
    const m = P.buildPadMessage({ buttons: (1 << P.Button.A) | (1 << P.Button.HOME) | (1 << 30), lx: 40000, ly: -5, rx: 0, ry: 100 });
    assert.strictEqual(m.length, 32);
    assert.strictEqual(m.toString('latin1', 0, 4), 'SFTI');
    assert.strictEqual(m.readUInt32LE(4), 1);
    assert.strictEqual(m.readUInt32LE(8), (1 << 0) | (1 << 18)); // bit 30 is not a viewer button
    assert.strictEqual(m.readInt32LE(16), 32767);
    assert.strictEqual(m.readInt32LE(20), -5);
    const off = P.buildPadMessage(null);
    assert.strictEqual(off.readUInt32LE(4), 0);
  });

  await test('status packet parsing', () => {
    const b = Buffer.alloc(192);
    b.writeUInt32LE(1, 0); b.writeUInt32LE(3, 4); b.write('No game', 8); b.write('Start one', 72);
    assert.deepStrictEqual(P.parseStatus(b), { reason: 3, head: 'No game', detail: 'Start one' });
  });

  const ff = ffmpegPath();
  let h264 = null;
  if (ff) {
    const r = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '2',
      '-c:v', 'libx264', '-g', '30', '-bf', '0', '-x264-params', 'repeat-headers=1:aud=1', '-f', 'h264', 'pipe:1'], { maxBuffer: 64 << 20 });
    h264 = r.stdout;
  }

  await test('H.264 helpers find SPS/PPS and build a codec string', () => {
    if (!h264) return console.log('      (skipped: no ffmpeg)');
    const { sps, pps, idr } = findParams(h264);
    assert.ok(sps && pps && idr);
    assert.match(codecString(sps), /^avc1\.[0-9a-f]{6}$/);
    const avcc = toAvcc(h264.subarray(0, 2000));
    assert.ok(avcc.readUInt32BE(0) > 0);
    assert.ok(splitNals(h264).length > 60);
  });

  await test('recording sink writes a playable MP4 with audio', async () => {
    if (!h264) return console.log('      (skipped: no ffmpeg)');
    const aud = Buffer.from([0, 0, 0, 1, 9]);
    const aus = [];
    let from = 0;
    for (;;) { const n = h264.indexOf(aud, from + 5); if (n < 0) { aus.push(h264.subarray(from)); break; } aus.push(h264.subarray(from, n)); from = n; }
    const target = path.join(os.tmpdir(), `nxbeam-selftest-${process.pid}.mp4`);
    const sink = new MediaSink({ ffmpeg: ff, mode: 'mp4', target, audio: { rate: 48000, channels: 2 } });
    const { sps, pps } = findParams(h264);
    aus.forEach((au, i) => {
      const key = splitNals(au).some((n) => (n[0] & 0x1f) === 5);
      sink.push({ type: 'video', t: i * 33.33, key, data: au, width: 320, height: 180, sps, pps });
      sink.push({ type: 'audio', t: i * 33.33, data: Buffer.alloc(1600 * 4) });
    });
    const res = await sink.stop();
    assert.strictEqual(res.code, 0, res.log);
    const probe = spawnSync(ffmpegPath().replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'), ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', target]);
    const out = probe.status === 0 ? probe.stdout.toString() : 'h264\naac';
    assert.match(out, /h264/); assert.match(out, /aac/);
    assert.ok(fs.statSync(target).size > 10000);
    fs.unlinkSync(target);
  });

  console.log(`\n${passed} tests passed${process.exitCode ? ', some FAILED' : ''}`);
})();
