// Git for the Changes panel: status, diffs, and the small write set (stage, unstage, discard, commit).
// Also `git ls-files` for @-mention search.
import fs from 'node:fs';
import path from 'node:path';
import { isWinPath, runProc } from './backend.mjs';
import { looksBinary, ROOT } from './util.mjs';

// Repos can be anything the user opens (a downloaded archive too): never run repo-configured programs.
// Literal pathspecs: a file called [id].js or :/ must not act as a pattern. Hooks are looked up under a file (never a
// folder), so none exists; signatures are not checked by `log` (that runs gpg.program).
const GIT = ['--literal-pathspecs', '-c', 'core.quotepath=off', '-c', 'color.ui=never', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false'];
const NO_HOOKS_WIN = path.join(ROOT, 'package.json');
const NO_HOOKS_LINUX = '/dev/null';

// Filter drivers (run by status, diff, add, restore) and signing programs set by the repository's own config (not
// your system/global config) are switched off.
const TRUSTED_SCOPES = new Set(['system', 'global', 'command']);
const guardCache = new Map(); // backend kind|ws -> { at, args }
async function repoGuards(run, key) {
  const hit = guardCache.get(key);
  if (hit && Date.now() - hit.at < 3000) return hit.args;
  const re = '^(filter|gpg)\\.';
  let r = await run(['config', '--show-scope', '-z', '--get-regexp', re]);
  let scoped = true;
  if (r.code === 129) {
    r = await run(['config', '-z', '--get-regexp', re]); // git < 2.26: no scopes, so trust none
    scoped = false;
  }
  if (r.code !== 0) return []; // no matches (1), or git cannot run: then the real call fails too
  const parts = r.stdout.toString('utf8').split('\0');
  const names = new Set();
  let signer = false;
  for (let i = 0; i < parts.length; i += scoped ? 2 : 1) {
    const entry = scoped ? parts[i + 1] : parts[i];
    if (!entry || (scoped && TRUSTED_SCOPES.has(parts[i]))) continue;
    const k = entry.split('\n')[0];
    if (k.startsWith('gpg.')) signer = true;
    else if (k.startsWith('filter.') && k.lastIndexOf('.') > 7) names.add(k.slice(7, k.lastIndexOf('.')));
  }
  const args = signer ? ['-c', 'commit.gpgSign=false'] : [];
  for (const n of names) {
    if (n.includes('=')) throw new Error(`This repository's git config defines a filter ("${n}") that ORBIX cannot switch off, so git is not run here.`);
    for (const v of ['clean=', 'smudge=', 'process=', 'required=false']) args.push('-c', `filter.${n}.${v}`);
  }
  guardCache.set(key, { at: Date.now(), args });
  return args;
}

let winGit; // memoised: is Windows git available?
async function hasWinGit() {
  if (winGit !== undefined) return winGit;
  const r = await runProc('git.exe', ['--version'], { timeout: 8000 });
  return (winGit = r.code === 0);
}

/** Run git for `ws`. Windows-drive workspaces use Windows git (fast, native); Linux ones go through WSL. */
export async function git(backend, ws, args, opts = {}) {
  const onWinDrive = isWinPath(ws) || /^\/mnt\/[a-z](\/|$)/.test(ws);
  const o = { timeout: opts.timeout || 30000, maxBytes: opts.maxBytes || 4 * 1024 * 1024 };
  let run;
  if (onWinDrive && (await hasWinGit())) {
    const cwd = isWinPath(ws) ? ws : backend.hostPath(ws);
    run = (a) => runProc('git.exe', [...GIT, '-c', `core.hooksPath=${NO_HOOKS_WIN}`, '-c', `safe.directory=*`, ...a], { cwd, ...o });
  } else {
    if (!backend.isWsl && !isWinPath(ws)) throw new Error('Not a Windows path');
    run = (a) => backend.exec(['git', ...GIT, '-c', `core.hooksPath=${NO_HOOKS_LINUX}`, ...a], { cwd: ws, ...o });
  }
  return run([...(await repoGuards(run, `${backend.kind}|${ws}`)), ...args]);
}

/** Parser for `git status --porcelain=v1 -z -b`. */
export function parseStatus(buf) {
  const parts = buf.split('\0');
  const files = [];
  let branch = '';
  let upstream = '';
  let ahead = 0;
  let behind = 0;
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    if (e.startsWith('## ')) {
      let s = e.slice(3).replace(/^(No commits yet on|Initial commit on) /, '');
      const br = /\s\[([^\]]*)\]$/.exec(s);
      if (br) {
        ahead = +(/ahead (\d+)/.exec(br[1])?.[1] || 0);
        behind = +(/behind (\d+)/.exec(br[1])?.[1] || 0);
        s = s.slice(0, br.index);
      }
      const dots = s.indexOf('...');
      if (dots >= 0) {
        branch = s.slice(0, dots);
        upstream = s.slice(dots + 3);
      } else branch = s;
      continue;
    }
    const x = e[0];
    const y = e[1];
    const file = e.slice(3);
    let from = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') from = parts[++i] || null; // git emits the old path when either column is a rename/copy
    files.push({ x, y, path: file, from, untracked: x === '?', staged: x !== ' ' && x !== '?', unstaged: y !== ' ' && x !== '?' });
  }
  return { branch, upstream, ahead, behind, files };
}

export async function status(backend, ws) {
  const r = await git(backend, ws, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all', '--ignore-submodules=dirty']);
  if (r.code !== 0) {
    const msg = r.stderr.toString('utf8').trim();
    if (/not a git repository/i.test(msg)) return { repo: false, files: [] };
    // No git on this PC (or in WSL): not an error, the panel just says so.
    if (!msg || /not recognized|not found|ENOENT|cannot find/i.test(msg)) return { repo: false, files: [], gitMissing: true };
    throw new Error(msg);
  }
  return { repo: true, ...parseStatus(r.stdout.toString('utf8')) };
}

export async function diff(backend, ws, file, { untracked = false } = {}) {
  const MAX = 1.5 * 1024 * 1024;
  if (untracked) {
    const root = path.resolve(backend.hostPath(ws));
    const full = path.resolve(root, String(file || ''));
    if (!full.startsWith(root + path.sep)) throw Object.assign(new Error('That file is outside the project folder'), { status: 400 });
    let buf;
    try {
      buf = await fs.promises.readFile(full);
    } catch (e) {
      throw new Error(`Cannot read ${file}: ${e.code}`);
    }
    if (looksBinary(buf)) return { text: `Binary file ${file} (untracked)\n` };
    const lines = buf.subarray(0, MAX).toString('utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return { text: `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => '+' + l).join('\n') + '\n' };
  }
  let r = await git(backend, ws, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=dirty', '-U3', 'HEAD', '--', file], { maxBytes: MAX });
  if (r.code !== 0) r = await git(backend, ws, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=dirty', '-U3', '--cached', '--', file], { maxBytes: MAX });
  if (r.code !== 0) throw new Error(r.stderr.toString('utf8').trim() || 'git diff failed');
  return { text: r.stdout.toString('utf8') };
}



const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/** Paths the panel may touch: relative, inside the project, never a drive or parent path. */
function cleanPaths(paths) {
  if (!Array.isArray(paths) || !paths.length) throw bad('No files given');
  if (paths.length > 500) throw bad('Too many files at once');
  return paths.map((p) => {
    const s = String(p ?? '').replace(/\\/g, '/');
    if (!s || s.includes('\0') || s.startsWith('/') || /^[a-z]:/i.test(s) || s.split('/').includes('..')) throw bad(`Not a project path: ${s || '(empty)'}`);
    return s;
  });
}

async function run(backend, ws, args) {
  const r = await git(backend, ws, args);
  if (r.code !== 0) throw new Error(r.stderr.toString('utf8').trim() || r.stdout.toString('utf8').trim() || `git ${args[0]} failed`);
  return r.stdout.toString('utf8');
}

export async function stage(backend, ws, paths) {
  await run(backend, ws, ['add', '-A', '--', ...cleanPaths(paths)]);
}

export async function unstage(backend, ws, paths) {
  const list = cleanPaths(paths);
  const hasHead = (await git(backend, ws, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
  // A repo with no commit yet has no HEAD to restore from: take the files back out of the index instead.
  await run(backend, ws, hasHead ? ['restore', '--staged', '--', ...list] : ['rm', '--cached', '-r', '-q', '--', ...list]);
}

/** Throw away the working-tree edits of tracked files (the index is kept), or delete untracked files. Cannot be undone. */
export async function discard(backend, ws, { tracked = [], untracked = [] } = {}) {
  const t = tracked?.length ? cleanPaths(tracked) : [];
  const u = untracked?.length ? cleanPaths(untracked) : [];
  if (!t.length && !u.length) throw bad('No files given');
  if (t.length) await run(backend, ws, ['restore', '--worktree', '--', ...t]);
  if (u.length) await run(backend, ws, ['clean', '-f', '-q', '--', ...u]);
}

/** Commit what is staged. Repository hooks are skipped: a project folder is not trusted to run programs. */
export async function commit(backend, ws, message) {
  const msg = String(message ?? '').trim();
  if (!msg) throw bad('Write a commit message first');
  if (msg.length > 20000) throw bad('That commit message is too long');
  const out = await run(backend, ws, ['commit', '--no-verify', '-m', msg]);
  const hash = (/\[[^\]]*?([0-9a-f]{7,40})\]/.exec(out) || [])[1] || '';
  return { hash, summary: out.split('\n')[0] || '' };
}
