#!/usr/bin/env node
// ORBIX entry point.
//   node src/main.mjs            start the desktop app (bin/ORBIX.exe), which runs this file with --serve
//   node src/main.mjs --serve    run the local server for the desktop host (prints ORBIX-URL / ORBIX-DATA, exits when idle)
//   node src/main.mjs --no-window   same, but never exits by itself (development / tests)
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { initLog, log, readJson, writeJson } from './util.mjs';
import { Store, DATA_DIR } from './store.mjs';
import { AppServer, VERSION } from './server.mjs';
import { loadCatalog } from './engine/catalog.mjs';
import { launchDesktop } from './launcher.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag('--help') || flag('-h')) {
  console.log(`ORBIX ${VERSION}
Usage: node src/main.mjs [options]
  (no options)       start the desktop app
  --serve            server for the desktop host: prints ORBIX-URL / ORBIX-DATA, exits when idle
  --no-window        server only, never exits by itself (development / tests)
  --port <n>         preferred port (default 47821; falls back to a random one)
  --version`);
  process.exit(0);
}
if (flag('--version')) {
  console.log(VERSION);
  process.exit(0);
}

const serveMode = flag('--serve') || flag('--no-window');
if (!serveMode) {
  if (launchDesktop()) process.exit(0);
  console.error('The desktop app is not built yet. Run:  npm run build\n(or start the server only with: node src/main.mjs --no-window)');
  process.exit(1);
}

initLog(path.join(DATA_DIR, 'logs', 'server.log'));
process.on('uncaughtException', (e) => log('uncaughtException', e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e));

const LOCK = path.join(DATA_DIR, 'instance.json');

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1500 }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(b).app === 'orbix');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** The desktop host reads exactly these two lines from stdout. */
const handshake = (url) => {
  console.log(`ORBIX-URL ${url}`);
  console.log(`ORBIX-DATA ${DATA_DIR}`);
};

async function main() {
  // Single instance: when a server is already running, hand its address to the new window and leave.
  const lock = readJson(LOCK, null);
  if (lock?.port && lock?.token && (await ping(lock.port))) {
    handshake(`http://127.0.0.1:${lock.port}/?t=${lock.token}`);
    return;
  }

  const store = new Store();
  const token = crypto.randomBytes(24).toString('hex');
  const h = new AppServer({ store, token });
  const want = Number(opt('--port')) || 47821;
  try {
    await h.listen(want);
  } catch {
    await h.listen(0);
  }
  // Backend detection runs in the background so the window can load at once (/api/state waits for it). The model
  // catalog (a 2.6 MB cache file) is read after the handshake, off the startup path.
  h.startEnv();
  const url = `http://127.0.0.1:${h.port}/?t=${token}`;
  writeJson(LOCK, { port: h.port, token, pid: process.pid, started: Date.now() });
  handshake(url);
  setTimeout(() => loadCatalog(), 50);
  h.envReady.then(() => log(`backend: ${store.data.backend.kind}${store.data.backend.distro ? ' (' + store.data.backend.distro + ')' : ''}${h.envInfo.error ? ' | ' + h.envInfo.error : ''}`));

  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    try {
      store.save();
      await h.shutdown();
    } catch (e) {
      log('shutdown error', e);
    }
    try {
      if (readJson(LOCK, {})?.pid === process.pid) fs.rmSync(LOCK, { force: true });
    } catch {}
    process.exit(code);
  };
  h.onQuit = () => stop(0);
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  process.on('SIGHUP', () => stop(0));

  // The desktop host keeps our stdin open while it runs (--watch-stdin). When it closes, the host is gone for good
  // (closed, crashed or killed), so nothing restarts this server's window: we exit as soon as no agent works.
  let orphanedAt = 0;
  if (flag('--watch-stdin')) {
    const gone = () => {
      if (orphanedAt) return;
      orphanedAt = Date.now();
      log('desktop host closed');
    };
    process.stdin.on('end', gone);
    process.stdin.on('close', gone);
    process.stdin.on('error', gone);
    process.stdin.resume();
  }
  process.stdout.on('error', () => {}); // the host may be gone: never crash on a closed pipe

  // Exit once the window is gone and no agent is working (running work is finished first). Work that waits for an
  // answer nobody can give (the host is gone) is stopped after 10 minutes; anything else after 6 hours.
  if (!flag('--no-window')) {
    setInterval(() => {
      if (h.clients.size) return;
      const idle = Date.now() - h.lastClientAt;
      if (orphanedAt) {
        const age = Date.now() - orphanedAt;
        if ((!h.busy && idle > 3000) || (h.waitingForUser && age > 10 * 60000) || age > 6 * 3600000) stop(0);
      } else if (!h.busy && idle > (h.hadClient ? 20000 : 90000)) stop(0);
    }, 5000);
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  log('fatal', e);
  process.exit(1);
});
