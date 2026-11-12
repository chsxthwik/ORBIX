// Start ORBIX's local server, which the app window (electron/main.mjs) shows. One server per data folder: when one is
// already running, its address is returned instead of starting another.
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { initLog, log, readJson, writeJson } from './util.mjs';
import { Store, DATA_DIR } from './store.mjs';
import { AppServer } from './server.mjs';
import { loadCatalog } from './engine/catalog.mjs';

const LOCK = path.join(DATA_DIR, 'instance.json');

/** True when an ORBIX server answers on `port`. */
export function ping(port) {
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

/**
 * Start the server, or find the one already running for this data folder.
 * Returns { url, existing, server, stop(code) }; `stop` saves, shuts the server down and removes the lock file.
 * `onQuit` runs when the app asks to quit (Settings → About → Quit ORBIX).
 */
export async function startOrbix({ port = 47821, onQuit } = {}) {
  initLog(path.join(DATA_DIR, 'logs', 'server.log'));
  const lock = readJson(LOCK, null);
  if (lock?.port && lock?.token && (await ping(lock.port))) {
    return { url: `http://127.0.0.1:${lock.port}/?t=${lock.token}`, existing: true, server: null, stop: async () => {} };
  }

  const store = new Store();
  const token = crypto.randomBytes(24).toString('hex');
  const h = new AppServer({ store, token });
  try {
    await h.listen(port);
  } catch {
    await h.listen(0);
  }
  // Backend detection runs in the background so the page can load at once (/api/state waits for it). The model
  // catalog (a 2.6 MB cache file) is read after the handshake, off the startup path.
  h.startEnv();
  writeJson(LOCK, { port: h.port, token, pid: process.pid, started: Date.now() });
  setTimeout(() => loadCatalog(), 50);
  h.envReady.then(() => log(`backend: ${store.data.backend.kind}${store.data.backend.distro ? ' (' + store.data.backend.distro + ')' : ''}${h.envInfo.error ? ' | ' + h.envInfo.error : ''}`));

  let stopping = null;
  const stop = () => {
    stopping ||= (async () => {
      try {
        store.save();
        await h.shutdown();
      } catch (e) {
        log('shutdown error', e);
      }
      try {
        if (readJson(LOCK, {})?.pid === process.pid) fs.rmSync(LOCK, { force: true });
      } catch {}
    })();
    return stopping;
  };
  h.onQuit = () => (onQuit ? onQuit() : stop());
  return { url: `http://127.0.0.1:${h.port}/?t=${token}`, existing: false, server: h, stop };
}
