#!/usr/bin/env node
// ORBIX Cloud: the same ORBIX server with no window, for a Linux machine you own (a VPS, a home server, WSL). Agents
// keep working while your PC sleeps; the ORBIX app opens it from Settings → Machines, a browser opens its link.
//
//   ORBIX_DATA     data folder (default ~/.orbix)
//   ORBIX_LISTEN   host:port (default 127.0.0.1:47821; put HTTPS in front before you listen on a public address)
//   ORBIX_HOSTS    names it answers to besides localhost, comma-separated (orbix.example.com, my-vps:47821)
//   ORBIX_TOKEN    the access token (default: made once and kept in <data>/server-token, mode 0600)
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.ORBIX_DATA ||= path.join(os.homedir(), '.orbix');
const DATA = process.env.ORBIX_DATA;
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });

const tokenFile = path.join(DATA, 'server-token');
let token = (process.env.ORBIX_TOKEN || '').trim();
if (!token) {
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
  }
}
if (token.length < 24) {
  console.error('ORBIX_TOKEN must be at least 24 characters.');
  process.exit(2);
}

const listen = process.env.ORBIX_LISTEN || '127.0.0.1:47821';
const i = listen.lastIndexOf(':');
const host = i > 0 ? listen.slice(0, i).replace(/^\[|\]$/g, '') : '127.0.0.1';
const port = Number(i > 0 ? listen.slice(i + 1) : listen) || 47821;
const allowHosts = (process.env.ORBIX_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') allowHosts.push(`${host}:${port}`);

const { initLog, log, VERSION } = await import('./util.mjs');
const { Store } = await import('./store.mjs');
const { AppServer } = await import('./server.mjs');
const { loadCatalog } = await import('./engine/catalog.mjs');

initLog(path.join(DATA, 'logs', 'server.log'));
const store = new Store();
const server = new AppServer({ store, token });
await server.listen(port, { host, allowHosts, remote: true });
server.startEnv();
setTimeout(() => loadCatalog(), 50);

const shown = host === '0.0.0.0' || host === '::' ? os.hostname() : host;
console.log(`ORBIX ${VERSION} server is running.`);
console.log(`  Open:   http://${shown}:${server.port}/?t=${token}`);
console.log(`  Data:   ${DATA}`);
console.log(`  In the ORBIX app: Settings → Machines → Add, with this address and the token in ${tokenFile}`);
log(`headless server on ${host}:${server.port}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  try {
    store.save();
    await server.shutdown();
  } catch (e) {
    log('shutdown error', e);
  }
  process.exit(0);
};
server.onQuit = stop;
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
