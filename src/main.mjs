#!/usr/bin/env node
// ORBIX entry point. Starts the local web app and opens it in the default browser.
// --serve and --no-window run the server without opening a browser.
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { initLog, log, readJson, writeJson } from './util.mjs';
import { Store, DATA_DIR } from './store.mjs';
import { AppServer, VERSION } from './server.mjs';
import { loadCatalog } from './engine/catalog.mjs';
import { openExternal } from './launcher.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag('--help') || flag('-h')) {
  console.log(`ORBIX ${VERSION}
Usage: node src/main.mjs [options]
  (no options)       start ORBIX and open it in your browser
  --serve            start the local web server without opening a browser
  --no-window        server only; keep it running until stopped
  --port <n>         preferred port (default 47821; falls back to a random one)
  --version`);
  process.exit(0);
}
if (flag('--version')) {
  console.log(VERSION);
  process.exit(0);
}

const headless = flag('--serve') || flag('--no-window');

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

async function main() {
  // Single instance: reuse the existing local server and browser session.
  const lock = readJson(LOCK, null);
  if (lock?.port && lock?.token && (await ping(lock.port))) {
    if (!headless) openExternal(`http://127.0.0.1:${lock.port}/?t=${lock.token}`);
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
  if (!headless) openExternal(url);
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

  // Headless invocations are useful for scripts and local development. The normal browser app
  // remains available even when its last tab is closed, until the user stops this process.
  if (flag('--serve')) {
    setInterval(() => {
      if (h.clients.size) return;
      const idle = Date.now() - h.lastClientAt;
      if (!h.busy && idle > (h.hadClient ? 20000 : 90000)) stop(0);
    }, 5000);
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  log('fatal', e);
  process.exit(1);
});
