// Environment self-check shown in the app (Diagnostics) and by `node tools/doctor.mjs`.
// Everything here is measured, never assumed: a check passes only when it was actually verified.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Backend } from './backend.mjs';
import { DATA_DIR } from './store.mjs';
import { ROOT, VERSION } from './util.mjs';

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(f, 'ok');
    fs.rmSync(f, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** `app`: the running AppServer (or the same fields: backend, envInfo, engineCfg, port, procs). */
export async function collect(app) {
  const backend = app.backend;
  const checks = [];
  const add = (id, label, ok, detail, fix) => checks.push({ id, label, ok: !!ok, detail: detail || '', fix: ok ? '' : fix || '' });

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node', 'Node.js 22 or newer', nodeMajor >= 22, `v${process.versions.node}`, 'Install Node.js 22+ from https://nodejs.org');
  add('data', 'App data folder is writable', writable(DATA_DIR), DATA_DIR, 'Move ORBIX to a folder you can write to, or set ORBIX_DATA.');

  let distros = [];
  if (backend.isWsl) {
    ({ distros } = await Backend.wslInfo().catch(() => ({ distros: [] })));
    add('wsl', 'WSL is available', distros.length > 0, distros.length ? distros.join(', ') : 'no distributions found', 'Install WSL and a Linux distribution (wsl --install), or switch the backend to Windows in Settings.');
    add('distro', `WSL distribution "${backend.distro}" exists`, distros.includes(backend.distro), backend.distro || '(none selected)', 'Pick an installed distribution in Settings → Backend.');
    if (distros.includes(backend.distro)) {
      const home = (await backend.probe().catch(() => ({}))).home;
      add('wsl-start', `WSL distribution "${backend.distro}" starts`, !!home, home ? `home ${home}` : 'no answer from the distribution', 'Start it once from a terminal (wsl -d <name>) to finish its setup, then run this check again.');
    }
  }

  const ids = app.engineCfg?.configuredIds() || [];
  add('engine', 'An AI provider is set up', ids.length > 0, ids.length ? ids.map((i) => app.engineCfg.provider(i).name).join(', ') : 'none yet', 'Open Settings → Providers and add a key, sign in with OpenRouter, or connect a local Ollama / LM Studio.');

  return {
    ok: checks.every((c) => c.ok),
    checks,
    info: {
      'ORBIX': VERSION,
      Backend: backend.isWsl ? `WSL (${backend.distro})` : 'Windows native',
      'Node.js': process.version,
      System: `${os.type()} ${os.release()} ${process.arch}`,
      'App folder': ROOT,
      'Data folder': DATA_DIR,
      'Server port': String(app.port),
      'Running sessions': String(app.procs.size),
      Uptime: `${Math.round(process.uptime())} s`,
    },
  };
}
