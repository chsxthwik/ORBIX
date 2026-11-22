// The project popover: where a project runs (Windows, or which WSL distribution and user), the apps that can open it
// (File Explorer, VS Code, Cursor, Windsurf, Zed, Windows Terminal: whichever are installed), and `git init`.
import os from 'node:os';
import { spawn } from 'node:child_process';
import { runProc, wslUncPath, POSIX } from './backend.mjs';
import * as fsapi from './fsapi.mjs';

// Editors open a WSL folder through their WSL remote ("--remote wsl+<distro> /path"), a Windows folder directly.
const APPS = [
  { id: 'code', name: 'VS Code', bin: 'code', remote: true },
  { id: 'cursor', name: 'Cursor', bin: 'cursor', remote: true },
  { id: 'windsurf', name: 'Windsurf', bin: 'windsurf', remote: true },
  { id: 'zed', name: 'Zed', bin: 'zed', remote: false },
  { id: 'wt', name: 'Windows Terminal', bin: 'wt', remote: false },
];

let found = null;
let foundAt = 0;
/** Installed apps from APPS (Windows only), with their paths. Cached for five minutes. */
async function installed() {
  if (POSIX) return [];
  if (found && Date.now() - foundAt < 300000) return found;
  const r = await runProc('where.exe', APPS.map((a) => a.bin), { timeout: 8000 }).catch(() => null);
  const hits = String(r?.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  found = APPS.map((a) => {
    const mine = hits.filter((p) => new RegExp(`[\\\\/]${a.bin}(\\.(exe|cmd|bat))?$`, 'i').test(p));
    const path = mine.find((p) => /\.exe$/i.test(p)) || mine.find((p) => /\.cmd$/i.test(p)) || '';
    return path ? { ...a, path } : null;
  }).filter(Boolean);
  foundAt = Date.now();
  return found;
}

const users = new Map();
/** Where `ws` runs: { kind: 'wsl' | 'windows' | 'linux', distro, user }. */
async function where(backend, ws) {
  const unc = !backend.isWsl && !POSIX && wslUncPath(ws);
  if (POSIX) return { kind: 'linux', distro: '', user: os.userInfo().username };
  if (!backend.isWsl && !unc) return { kind: 'windows', distro: '', user: os.userInfo().username };
  const distro = unc ? unc.distro : backend.distro || '';
  if (!users.has(distro)) {
    const argv = unc ? ['wsl.exe', '-d', distro, '-e', 'whoami'] : ['whoami'];
    const r = await (unc ? runProc(argv[0], argv.slice(1), { timeout: 10000 }) : backend.exec(argv, { timeout: 10000 })).catch(() => null);
    users.set(distro, String(r?.stdout || '').trim().split(/\s+/)[0] || '');
  }
  return { kind: 'wsl', distro: distro || 'default', user: users.get(distro) };
}

export async function info(backend, ws, gitapi) {
  const [env, apps, git] = await Promise.all([where(backend, ws), installed(), gitapi.status(backend, ws).catch(() => ({ repo: false }))]);
  return { env, apps: [{ id: 'explorer', name: 'File Explorer' }, ...apps.map(({ id, name }) => ({ id, name }))], repo: !!git.repo, gitMissing: !!git.gitMissing, branch: git.branch || '' };
}

/** Open project `ws` in app `id` (detached: ORBIX does not wait for it). */
export async function open(backend, ws, id) {
  if (id === 'explorer') return fsapi.reveal(backend, ws);
  const app = (await installed()).find((a) => a.id === id);
  if (!app) throw Object.assign(new Error('That app is not installed'), { status: 400 });
  const unc = wslUncPath(backend.hostPath(ws));
  const linux = backend.isWsl ? backend.execPath(ws) : unc?.linux;
  const distro = backend.isWsl ? backend.distro : unc?.distro;
  let args;
  if (app.id === 'wt') args = linux ? ['wsl.exe', ...(distro ? ['-d', distro] : []), '--cd', linux] : ['-d', backend.hostPath(ws)];
  else if (linux && app.remote && distro) args = ['--remote', `wsl+${distro}`, linux];
  else args = [backend.hostPath(ws)];
  const shim = /\.(cmd|bat)$/i.test(app.path);
  const child = shim
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[app.path, ...args].map((a) => `"${String(a).replace(/"/g, '')}"`).join(' ')}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true })
    : spawn(app.path, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
}
