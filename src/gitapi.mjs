// Git for the Changes panel: status, diffs, log, and the small write set (stage, unstage, discard, commit).
// Also `git ls-files` for @-mention search.
import fs from 'node:fs';
import path from 'node:path';
import { isWinPath, runProc } from './backend.mjs';
import { looksBinary } from './util.mjs';

// Repos can be anything the user opens (a downloaded archive too): never run repo-configured programs from a read.
const GIT = ['-c', 'core.quotepath=off', '-c', 'color.ui=never', '-c', 'core.fsmonitor=false'];

let winGit; // memoised: is Windows git available?
async function hasWinGit() {
  if (winGit !== undefined) return winGit;
  const r = await runProc('git.exe', ['--version'], { timeout: 8000 });
  return (winGit = r.code === 0);
}

/** Run git for `ws`. Windows-drive workspaces use Windows git (fast, native); Linux ones go through WSL. */
export async function git(backend, ws, args, opts = {}) {
  const onWinDrive = isWinPath(ws) || /^\/mnt\/[a-z](\/|$)/.test(ws);
  if (onWinDrive && (await hasWinGit())) {
    const cwd = isWinPath(ws) ? ws : backend.hostPath(ws);
    return runProc('git.exe', [...GIT, '-c', `safe.directory=*`, ...args], { cwd, timeout: opts.timeout || 30000, maxBytes: opts.maxBytes || 4 * 1024 * 1024 });
  }
  if (!backend.isWsl && !isWinPath(ws)) throw new Error('Not a Windows path');
  return backend.exec(['git', ...GIT, ...args], { cwd: ws, timeout: opts.timeout || 30000, maxBytes: opts.maxBytes || 4 * 1024 * 1024 });
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
  const r = await git(backend, ws, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all']);
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
  let r = await git(backend, ws, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-U3', 'HEAD', '--', file], { maxBytes: MAX });
  if (r.code !== 0) r = await git(backend, ws, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-U3', '--cached', '--', file], { maxBytes: MAX });
  if (r.code !== 0) throw new Error(r.stderr.toString('utf8').trim() || 'git diff failed');
  return { text: r.stdout.toString('utf8') };
}

export async function log(backend, ws, n = 20) {
  const r = await git(backend, ws, ['log', `-n${n}`, '--pretty=format:%h%x1f%an%x1f%ar%x1f%s']);
  if (r.code !== 0) return [];
  return r.stdout
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, author, when, subject] = l.split('\x1f');
      return { hash, author, when, subject };
    });
}


// ---------- writes ----------
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
