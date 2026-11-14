#!/usr/bin/env node
'use strict';
/* NXBeam - entry point */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { Hub } = require('./hub');
const { createServer } = require('./server');
const { localSubnets } = require('./sources');
const pkg = require('../package.json');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };

if (flag('help') || flag('h')) {
  console.log(`NXBeam ${pkg.version}
  --port N          web port (default 8090)
  --console IP      connect to this console address
  --mode M          auto | network | usb
  --config FILE     config file (default ./nxbeam.config.json)
  --media DIR       where recordings, clips and screenshots go
  --no-open         do not open the browser`);
  process.exit(0);
}

const configFile = path.resolve(opt('config', path.join(process.cwd(), 'nxbeam.config.json')));
const defaults = {
  port: 8090,
  mediaDir: path.join(os.homedir(), 'Videos', 'NXBeam'),
  replaySeconds: 30,
  lockSizeWhileRecording: true,
  recordPreset: 'source',
  livePreset: 'source',
  pin: '',
  ffmpegPath: '',
  connection: { mode: 'auto', host: '', scan: true },
  restreamTargets: [],
};
let config = { ...defaults };
try {
  const loaded = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config = { ...defaults, ...loaded, connection: { ...defaults.connection, ...(loaded.connection || {}) } };
} catch { /* first run */ }
if (opt('port')) config.port = Number(opt('port'));
if (opt('console')) config.connection.host = opt('console');
if (opt('mode')) config.connection.mode = opt('mode');
if (opt('media')) config.mediaDir = opt('media');

const saveConfig = () => {
  try { fs.writeFileSync(configFile, JSON.stringify(config, null, 2)); } catch (e) { console.error('config:', e.message); }
};
saveConfig();

if (!config.ffmpegPath) require('./ffmpeg').ensureFfmpegStatic();
// the hub relays every frame: ask the OS to schedule it ahead of background work
try { os.setPriority(0, os.constants.priority.PRIORITY_HIGH); } catch { /* needs rights on Linux/macOS */ }
const hub = new Hub(config, saveConfig);
hub.on('log', (m) => console.log(`[hub] ${m}`));
const server = createServer(hub, config, saveConfig);

const openBrowser = (u) => {
  if (flag('no-open') || process.env.NXBEAM_NO_OPEN) return;
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* headless */ }
};

server.on('listening', () => {
  config.port = server.address().port;
  const urls = [`http://localhost:${config.port}`, ...localSubnets().map((s) => `http://${s.self}:${config.port}`)];
  console.log(`\n  NXBeam ${pkg.version}`);
  console.log('  ----------------------------------------');
  for (const u of urls) console.log(`  ${u}`);
  console.log(`  OBS overlay: http://localhost:${config.port}/overlay`);
  console.log(`  ffmpeg: ${hub.ffmpeg || 'not found (recordings saved as .mkv, no restream)'}`);
  console.log(`  media:  ${hub.mediaDir}\n`);
  hub.start();
  openBrowser(urls[0]);
});

/* port taken: if it is NXBeam already running, just open it; otherwise try the next port */
let tryPort = config.port;
server.on('error', async (e) => {
  if (e.code !== 'EADDRINUSE') { console.error(e.message); process.exit(1); }
  try {
    const r = await fetch(`http://127.0.0.1:${tryPort}/api/session`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    if (j && 'pinSet' in j) {
      console.log(`\n  NXBeam sudah berjalan di http://localhost:${tryPort} (jendela lain).`);
      console.log('  NXBeam is already running there - opening it.\n');
      openBrowser(`http://localhost:${tryPort}`);
      setTimeout(() => process.exit(0), 500);
      return;
    }
  } catch { /* something else holds the port */ }
  if (tryPort - config.port >= 10) { console.error(`Ports ${config.port}-${tryPort} are in use. Start with --port N`); process.exit(1); }
  console.log(`  Port ${tryPort} dipakai program lain, mencoba ${tryPort + 1}...`);
  tryPort++;
  server.listen(tryPort);
});
server.listen(tryPort);

const shutdown = async () => {
  console.log('\nstopping...');
  await hub.stopRecording().catch(() => {});
  for (const id of [...hub.restreams.keys()]) await hub.stopRestream(id).catch(() => {});
  hub.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
