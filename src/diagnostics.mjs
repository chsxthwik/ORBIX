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
  add('node', 'Node.js 20 or newer', nodeMajor >= 20, `v${process.versions.node}`, 'Install Node.js 20+ from https://nodejs.org');
  add('data', 'App data folder is writable', writable(DATA_DIR), DATA_DIR, 'Move ORBIX to a folder you can write to, or set ORBIX_DATA.');

  let distros = [];
  if (backend.isWsl) {
    ({ distros } = await Backend.wslInfo().catch(() => ({ distros: [] })));
    add('wsl', 'WSL is available', distros.length > 0, distros.length ? distros.join(', ') : 'no distributions found', 'Install WSL and a Linux distribution (wsl --install), or switch the backend to Windows in Settings.');
    add('distro', `WSL distribution "${backend.distro}" exists`, distros.includes(backend.distro), backend.distro || '(none selected)', 'Pick an installed distribution in Settings → Backend.');
  }

  const omp = app.envInfo.omp || (await backend.resolveOmp().catch(() => null));
  const ids = app.engineCfg?.configuredIds() || [];
  add('engine', 'An AI provider is set up', ids.length > 0 || !!omp, ids.length ? ids.map((i) => app.engineCfg.provider(i).name).join(', ') : omp ? 'none yet (OMP sessions still work)' : 'none yet', 'Open Settings → AI providers and add a key, sign in with OpenRouter, or connect a local Ollama / LM Studio.');
  if (omp) add('omp', 'OMP CLI (optional)', true, `${omp}  ${app.envInfo.version || ''}`.trim());

  let sessionsRoot = '';
  let sessionDirs = 0;
  if (omp) {
    try {
      sessionsRoot = await backend.sessionsRoot();
      sessionDirs = (await fs.promises.readdir(backend.hostPath(sessionsRoot))).length;
      add('sessions', 'OMP session folder is readable', true, `${sessionsRoot} (${sessionDirs} project folder${sessionDirs === 1 ? '' : 's'})`);
    } catch (e) {
      add('sessions', 'OMP session folder is readable', false, sessionsRoot || String(e.message), 'It is created by OMP on first use; this is normal before your first OMP session.');
    }
  }

  return {
    ok: checks.every((c) => c.ok || c.id === 'sessions'),
    checks,
    info: {
      'ORBIX': VERSION,
      Backend: backend.isWsl ? `WSL (${backend.distro})` : 'Windows native',
      'OMP binary': omp || 'not found',
      'OMP version': app.envInfo.version || 'unknown',
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
