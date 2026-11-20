// Git for the Changes panel: status, diffs, and the small write set (stage, unstage, discard, commit).
// Also `git ls-files` for @-mention search, and the worktrees of sessions that work on their own branch.
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
  // `env` (e.g. GIT_INDEX_FILE for a scratch index) and `input` (stdin) apply to the call itself, not the guard lookup.
  const env = opts.env && Object.keys(opts.env).length ? opts.env : null;
  let run;
  if (onWinDrive && (await hasWinGit())) {
    const cwd = isWinPath(ws) ? ws : backend.hostPath(ws);
    run = (a, x = {}) => runProc('git.exe', [...GIT, '-c', `core.hooksPath=${NO_HOOKS_WIN}`, '-c', `safe.directory=*`, ...a], { cwd, ...o, ...x });
  } else {
    if (!backend.isWsl && !isWinPath(ws)) throw new Error('Not a Windows path');
    run = (a, x = {}) => backend.exec([...(x.env ? ['env', ...Object.entries(x.env).map(([k, v]) => `${k}=${v}`)] : []), 'git', ...GIT, '-c', `core.hooksPath=${NO_HOOKS_LINUX}`, ...a], { cwd: ws, ...o, ...(x.input != null ? { input: x.input } : {}) });
  }
  return run([...(await repoGuards(run, `${backend.kind}|${ws}`)), ...args], { ...(env ? { env } : {}), ...(opts.input != null ? { input: opts.input } : {}) });
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

/**
 * Git's own message, or a plain one for the failures people actually hit. A commit on a computer where git was never
 * told a name and email fails with a long hint; say what is missing and the two commands that fix it.
 */
export function gitFailure(text, what = 'git') {
  const msg = String(text || '').trim();
  if (/Please tell me who you are|unable to auto-detect email address|empty ident name/i.test(msg)) {
    return Object.assign(new Error('Git does not know your name and email yet, and it needs them to record a commit. Run these two commands once in a terminal, then try again:\n\n  git config --global user.name "Your Name"\n  git config --global user.email "you@example.com"\n\nNothing was changed.'), { status: 409, code: 'git_identity' });
  }
  return new Error(msg || `${what} failed`);
}

async function run(backend, ws, args, opts) {
  const r = await git(backend, ws, args, opts);
  if (r.code !== 0) throw gitFailure(r.stderr.toString('utf8').trim() || r.stdout.toString('utf8').trim(), `git ${args[0]}`);
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

// ---- Sessions on their own branch: each one works in a git worktree under <repo>/.orbix/worktrees/<slug>, on
// branch orbix/<slug>, cut from the commit the main checkout was on. Every call below runs through git() above,
// so the same guards apply (no hooks, no repo-defined filters or signing programs).

export const WORKTREE_DIR = '.orbix/worktrees';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const conflictErr = (msg) => Object.assign(new Error(msg), { status: 409 });

/** A new worktree name: date, time and a few random letters, e.g. 20261111-1432-k3f. */
export function worktreeSlug(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const rnd = Math.random().toString(36).slice(2, 5).padEnd(3, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-${rnd}`;
}

function checkSlug(slug) {
  const s = String(slug ?? '');
  if (!SLUG_RE.test(s)) throw bad('Not a session branch');
  return s;
}

const pathMod = (p) => (isWinPath(p) ? path.win32 : path.posix);

/**
 * Where `ws` sits in its repository: { repo, prefix, head, branch }. `repo` is the top folder written the same way
 * as `ws` (Windows or Linux path), `prefix` the folder of `ws` inside it ('' at the top), `head` the commit checked
 * out ('' before the first commit) and `branch` its branch ('' when detached). Null when `ws` is not in a repository.
 */
export async function repoInfo(backend, ws) {
  const r = await git(backend, ws, ['rev-parse', '--show-prefix']);
  if (r.code !== 0) {
    if (/not a git repository/i.test(r.stderr.toString('utf8'))) return null;
    throw new Error(r.stderr.toString('utf8').trim() || 'git rev-parse failed');
  }
  const prefix = r.stdout.toString('utf8').trim().replace(/\/+$/, '');
  const up = prefix ? prefix.split('/').map(() => '..') : [];
  const repo = up.length ? pathMod(ws).resolve(ws, ...up) : ws.replace(/[\\/]+$/, '') || ws;
  const head = (await git(backend, ws, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])).stdout.toString('utf8').trim();
  const br = await git(backend, ws, ['symbolic-ref', '-q', '--short', 'HEAD']);
  return { repo, prefix, head: SHA_RE.test(head) ? head : '', branch: br.code === 0 ? br.stdout.toString('utf8').trim() : '' };
}

/** Keep the worktrees folder out of `git status` of the main checkout (.git/info/exclude, never .gitignore). */
async function excludeWorktrees(backend, repo) {
  const out = (await run(backend, repo, ['rev-parse', '--git-common-dir'])).trim();
  const abs = isWinPath(out) || out.startsWith('/') ? backend.hostPath(out) : path.join(backend.hostPath(repo), out);
  const file = path.join(abs, 'info', 'exclude');
  const line = `/${WORKTREE_DIR}/`;
  let text = '';
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch {}
  if (text.split(/\r?\n/).some((l) => l.trim() === line)) return;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, text + (text && !text.endsWith('\n') ? '\n' : '') + line + '\n');
}

/**
 * Create the worktree of a new session: `git worktree add .orbix/worktrees/<slug> -b orbix/<slug> <HEAD>`.
 * Returns { repo, slug, path, workspace, branch, base, baseBranch }: `workspace` is the same folder as `ws` inside
 * the new worktree (a session started in a subfolder works in that subfolder).
 */
export async function worktreeAdd(backend, ws, { slug } = {}) {
  const s = checkSlug(slug || worktreeSlug());
  const info = await repoInfo(backend, ws);
  if (!info) throw bad('This folder is not a git repository, so the session cannot get its own branch.');
  if (!info.head) throw bad('This repository has no commit yet. Make a first commit, then start a session on its own branch.');
  if (/[\\/]\.orbix[\\/]worktrees[\\/][^\\/]+$/.test(info.repo)) throw bad('This folder is already a session branch. Start the new session from the main project folder.');
  const branch = `orbix/${s}`;
  await excludeWorktrees(backend, info.repo);
  await run(backend, info.repo, ['worktree', 'add', '-b', branch, `${WORKTREE_DIR}/${s}`, info.head]);
  const pm = pathMod(info.repo);
  const wt = pm.join(info.repo, ...WORKTREE_DIR.split('/'), s);
  return { repo: info.repo, slug: s, path: wt, workspace: info.prefix ? pm.join(wt, ...info.prefix.split('/')) : wt, branch, base: info.head, baseBranch: info.branch };
}

/** Parser for `git worktree list --porcelain -z`. */
export function parseWorktrees(text) {
  const out = [];
  let cur = null;
  for (const f of text.split('\0')) {
    if (!f) {
      cur = null;
      continue;
    }
    const sp = f.indexOf(' ');
    const key = sp < 0 ? f : f.slice(0, sp);
    const val = sp < 0 ? '' : f.slice(sp + 1);
    if (key === 'worktree') out.push((cur = { path: val, head: '', branch: '', detached: false, bare: false, locked: false, prunable: false }));
    else if (!cur) continue;
    else if (key === 'HEAD') cur.head = val;
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
    else if (key in cur) cur[key] = true;
  }
  return out;
}

export async function listWorktrees(backend, ws) {
  return parseWorktrees(await run(backend, ws, ['worktree', 'list', '--porcelain', '-z']));
}

/** NUL-separated paths of `git diff -z --name-status` / `--numstat`. */
function parseNameStatus(text) {
  const parts = text.split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i];
    if (!st) continue;
    const file = parts[++i];
    if (file) out.push({ status: st[0], path: file });
  }
  return out;
}
function parseNumstat(text) {
  const m = new Map();
  for (const rec of text.split('\0')) {
    const x = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(rec);
    if (x) m.set(x[3], { add: x[1] === '-' ? null : +x[1], del: x[2] === '-' ? null : +x[2] });
  }
  return m;
}

/**
 * What a session changed on its branch: its folder (commits and edits not committed yet, new files too) against the
 * commit it started from. Returns { files: [{ path, status, add, del, untracked }], commits, pending, ahead }:
 * `ahead` counts the branch's commits not in `baseBranch` yet (null without one), so a merged branch says 0.
 */
export async function branchDiff(backend, wt, base, { baseBranch = '' } = {}) {
  if (!SHA_RE.test(String(base || ''))) throw bad('Unknown base commit');
  const opts = ['--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=dirty', '-z'];
  const [ns, num, other, count, st] = await Promise.all([
    run(backend, wt, ['diff', ...opts, '--name-status', base, '--']),
    run(backend, wt, ['diff', ...opts, '--numstat', base, '--']),
    run(backend, wt, ['ls-files', '-z', '--others', '--exclude-standard']),
    run(backend, wt, ['rev-list', '--count', `${base}..HEAD`]),
    run(backend, wt, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty']),
  ]);
  const counts = parseNumstat(num);
  const files = parseNameStatus(ns).map((f) => ({ ...f, ...(counts.get(f.path) || { add: 0, del: 0 }), untracked: false }));
  const root = backend.hostPath(wt);
  for (const p of other.split('\0').filter(Boolean)) {
    let add = null;
    try {
      const buf = await fs.promises.readFile(path.join(root, p));
      if (!looksBinary(buf)) add = buf.toString('utf8').split('\n').length - (buf.length && buf[buf.length - 1] === 0x0a ? 1 : 0);
    } catch {}
    files.push({ status: 'A', path: p, add, del: 0, untracked: true });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  let ahead = null;
  if (baseBranch) {
    const a = await git(backend, wt, ['rev-list', '--count', `refs/heads/${baseBranch}..HEAD`]);
    if (a.code === 0) ahead = +a.stdout.toString('utf8').trim() || 0;
  }
  return { files, commits: +count.trim() || 0, pending: st.split('\0').some(Boolean), ahead };
}

/** The diff of one file of a session branch, against the commit the session started from. */
export async function branchFileDiff(backend, wt, base, file, { untracked = false } = {}) {
  if (!SHA_RE.test(String(base || ''))) throw bad('Unknown base commit');
  const [p] = cleanPaths([file]);
  if (untracked) return diff(backend, wt, p, { untracked: true });
  const r = await git(backend, wt, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--ignore-submodules=dirty', '-U3', base, '--', p], { maxBytes: 1.5 * 1024 * 1024 });
  if (r.code !== 0) throw new Error(r.stderr.toString('utf8').trim() || 'git diff failed');
  return { text: r.stdout.toString('utf8') };
}

/** Has the main checkout edits to tracked files (staged or not)? Untracked files do not count. */
async function dirtyFiles(backend, repo) {
  const out = await run(backend, repo, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=dirty']);
  return parseStatus(out).files.map((f) => f.path);
}

/** State of the main checkout for the review panel: { branch, dirty }. */
export async function mainState(backend, repo) {
  const info = await repoInfo(backend, repo);
  return { branch: info?.branch || '', dirty: (await dirtyFiles(backend, repo)).length > 0 };
}

/**
 * Merge a session branch into the branch the session started from, in the main checkout, with a merge commit
 * (--no-ff). Edits the session has not committed are committed on its branch first (`message`).
 * Refuses when the main checkout is on another branch, has uncommitted edits or is in the middle of a merge.
 * With `changed` (the paths the branch touched), uncommitted edits to other files are left alone and do not stop it.
 * On a conflict the merge is aborted and the commit made here is taken back (its edits stay in the session's
 * folder), so both checkouts are as they were: returns { merged: false, conflict: true, files }.
 * Otherwise { merged: true, hash, committed }.
 */
export async function merge(backend, { repo, wt, slug, baseBranch, message, changed = null }) {
  const s = checkSlug(slug);
  const branch = `orbix/${s}`;
  if (!baseBranch) throw bad('This session started on a detached HEAD, so there is no branch to merge into. Merge it with git yourself.');
  const main = await repoInfo(backend, repo);
  if (!main) throw bad('The project folder is no longer a git repository.');
  if (main.branch !== baseBranch) throw conflictErr(`The project folder is on ${main.branch || 'a detached HEAD'}, not ${baseBranch}. Switch it back to ${baseBranch}, then merge.`);
  if ((await git(backend, repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0) throw conflictErr(`A merge is already in progress in the project folder. Finish or abort it first.`);
  const dirty = await dirtyFiles(backend, repo);
  // `changed` (the paths the branch touched): uncommitted edits to other files stay exactly as they are through the
  // merge, so only edits to the same files stop it. Without the list, any uncommitted edit does.
  const clash = changed ? dirty.filter((p) => changed.includes(p)) : dirty;
  if (clash.length) throw conflictErr(changed ? `You have uncommitted changes to ${clash.slice(0, 3).join(', ')}${clash.length > 3 ? ` and ${clash.length - 3} more` : ''}, which this would overwrite. Commit or stash them, then apply.` : `The project folder has uncommitted changes (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''}). Commit or stash them, then merge.`);
  const onBranch = (await git(backend, wt, ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.toString('utf8').trim();
  if (onBranch !== branch) throw conflictErr(`The session folder is on ${onBranch || 'a detached HEAD'}, not ${branch}.`);

  let committed = false;
  if ((await run(backend, wt, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty'])).split('\0').some(Boolean)) {
    await run(backend, wt, ['add', '-A']);
    await run(backend, wt, ['commit', '--no-verify', '-q', '-m', String(message || '').trim().slice(0, 2000) || `ORBIX session ${s}`]);
    committed = true;
  }
  const undo = async () => {
    if (committed) await run(backend, wt, ['reset', '-q', '--mixed', 'HEAD~1']);
  };
  const ahead = +(await run(backend, repo, ['rev-list', '--count', `${baseBranch}..${branch}`])).trim();
  if (!ahead) {
    await undo();
    throw bad('Nothing to merge: the branch has no changes that are not in ' + baseBranch + ' already.');
  }
  const r = await git(backend, repo, ['merge', '--no-ff', '--no-edit', '--no-verify', '-m', `Merge ${branch} into ${baseBranch}`, branch]);
  if (r.code === 0) {
    const hash = (await run(backend, repo, ['rev-parse', 'HEAD'])).trim();
    return { merged: true, hash, committed };
  }
  const why = r.stderr.toString('utf8').trim() || r.stdout.toString('utf8').trim() || 'git merge failed';
  const files = (await git(backend, repo, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout.toString('utf8').split('\0').filter(Boolean);
  if ((await git(backend, repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0) await run(backend, repo, ['merge', '--abort']);
  await undo();
  if (files.length) return { merged: false, conflict: true, files };
  throw gitFailure(why, 'git merge');
}

/** Remove a session's worktree and delete its branch. Edits in it are lost: the UI asks before calling this. */
export async function worktreeRemove(backend, { repo, slug }) {
  const s = checkSlug(slug);
  const rel = `${WORKTREE_DIR}/${s}`;
  const r = await git(backend, repo, ['worktree', 'remove', '--force', rel]);
  if (r.code !== 0) {
    // Already gone from disk: drop git's record of it.
    const gone = !fs.existsSync(path.join(backend.hostPath(repo), ...rel.split('/')));
    if (!gone) throw new Error(r.stderr.toString('utf8').trim() || 'git worktree remove failed');
    await git(backend, repo, ['worktree', 'prune']);
  }
  await dropAccepted(backend, repo, s);
  const b = await git(backend, repo, ['branch', '-D', `orbix/${s}`]);
  if (b.code !== 0 && !/not found/i.test(b.stderr.toString('utf8'))) throw new Error(b.stderr.toString('utf8').trim() || 'git branch -D failed');
  return { removed: true };
}

// ---- Partial apply: some files, or some hunks of a file, go to the base branch; the rest stays in the session's
// folder. Nothing here touches the session's index, HEAD or files: its current state is read into a scratch index.
// What has been applied so far is a commit (base + the applied parts) kept under refs/orbix/accepted/<slug>, so the
// changes still to review are always "that commit → the folder now".

export const ACCEPTED_REF = 'refs/orbix/accepted';
const PATCH_MAX = 64 * 1024 * 1024;
const DIFF = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--no-relative', '--ignore-submodules=dirty', '--src-prefix=a/', '--dst-prefix=b/'];

/** Forget what was applied part by part (when the run is finished). Fine when there is nothing to forget. */
export async function dropAccepted(backend, repo, slug) {
  await git(backend, repo, ['update-ref', '-d', `${ACCEPTED_REF}/${checkSlug(slug)}`]);
}

/** Run `fn(env)` with GIT_INDEX_FILE pointing at a scratch index of `ws`, seeded from `seed` (a tree) or the real index. */
async function withScratchIndex(backend, ws, fn, { seed = '' } = {}) {
  const name = `orbix-index-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const [gitForm, realIndex] = (await run(backend, ws, ['rev-parse', '--path-format=absolute', '--git-path', name, '--git-path', 'index'])).split('\n').map((l) => l.trim());
  const host = (p) => (isWinPath(p) ? p : backend.hostPath(p));
  const env = { GIT_INDEX_FILE: gitForm };
  try {
    if (seed) await run(backend, ws, ['read-tree', seed], { env });
    else {
      // A copy of the real index keeps git's file timestamps, so only files that changed are read again.
      try {
        await fs.promises.copyFile(host(realIndex), host(gitForm));
      } catch {}
    }
    return await fn(env);
  } finally {
    for (const f of [gitForm, `${gitForm}.lock`]) await fs.promises.rm(host(f), { force: true }).catch(() => {});
  }
}

/** The tree of everything in the session's folder now: edits not committed yet and new (not ignored) files too. */
export async function snapshotTree(backend, wt) {
  return withScratchIndex(backend, wt, async (env) => {
    await run(backend, wt, ['add', '-A'], { env });
    return (await run(backend, wt, ['write-tree'], { env })).trim();
  });
}

/** The changes from `from` (a commit) to the folder now: { tree, files: [{ path, status, add, del, untracked: false }] }. */
export async function snapshotDiff(backend, wt, from, { tree = '' } = {}) {
  if (!SHA_RE.test(String(from || ''))) throw bad('Unknown base commit');
  const t = tree && SHA_RE.test(tree) ? tree : await snapshotTree(backend, wt);
  const opts = ['--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=dirty', '-z'];
  const [ns, num] = await Promise.all([run(backend, wt, ['diff', ...opts, '--name-status', from, t, '--']), run(backend, wt, ['diff', ...opts, '--numstat', from, t, '--'])]);
  const counts = parseNumstat(num);
  const files = parseNameStatus(ns).map((f) => ({ ...f, ...(counts.get(f.path) || { add: 0, del: 0 }), untracked: false }));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { tree: t, files };
}

/** The diff of one file from `from` to `tree` (a snapshot), for reading. Hunks are numbered as `parsePatch` numbers them. */
export async function treeFileDiff(backend, wt, from, tree, file) {
  if (!SHA_RE.test(String(from || '')) || !SHA_RE.test(String(tree || ''))) throw bad('Unknown commit');
  const [p] = cleanPaths([file]);
  const r = await git(backend, wt, ['diff', ...DIFF, '-U3', from, tree, '--', p], { maxBytes: 1.5 * 1024 * 1024 });
  if (r.code !== 0) throw new Error(r.stderr.toString('utf8').trim() || 'git diff failed');
  return { text: r.stdout.toString('utf8') };
}

/** `diff --git a/x b/x` → x (no renames, so both sides name the same file; a quoted name is unquoted). */
function patchPath(line) {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    let out = '';
    for (let i = 1; i < rest.length; i++) {
      const c = rest[i];
      if (c === '"') break;
      if (c !== '\\') {
        out += c;
        continue;
      }
      const n = rest[++i];
      if (/[0-7]/.test(n)) {
        const bytes = [parseInt(rest.slice(i, i + 3), 8)];
        i += 2;
        while (rest[i + 1] === '\\' && /[0-7]/.test(rest[i + 2] || '')) bytes.push(parseInt(rest.slice(i + 2, i + 5), 8)), (i += 4);
        out += Buffer.from(bytes).toString('utf8');
      } else out += { n: '\n', t: '\t', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', r: '\r', v: '\v' }[n] ?? n;
    }
    return out.replace(/^a\//, '');
  }
  return rest.slice(2, 2 + (rest.length - 5) / 2); // "a/" + x + " b/" + x
}

/**
 * Split a git patch into files: [{ path, head: [lines], hunks: [[lines]], whole }]. `whole` marks a file whose
 * hunks cannot be picked one by one (new, deleted, binary, mode change only): it is applied or left as a whole.
 */
export function parsePatch(text) {
  const files = [];
  let cur = null;
  let hunk = null;
  const lines = String(text || '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      files.push((cur = { path: patchPath(line), head: [line], hunks: [], whole: false }));
      hunk = null;
    } else if (!cur) continue;
    else if (line.startsWith('@@ ')) cur.hunks.push((hunk = [line]));
    else if (hunk) hunk.push(line);
    else {
      cur.head.push(line);
      if (/^(new file mode|deleted file mode|GIT binary patch|Binary files )/.test(line)) cur.whole = true;
    }
  }
  for (const f of files) if (!f.hunks.length) f.whole = true;
  return files;
}

/**
 * A patch with only the chosen parts. `hunks` maps a path to the hunk numbers (0-based, in file order) to keep; a path
 * not in it keeps all its hunks. A file left with no hunk is left out.
 */
export function pickPatch(files, hunks = {}) {
  const out = [];
  for (const f of files) {
    const want = Object.hasOwn(hunks, f.path) ? hunks[f.path] : null;
    if (!want || f.whole) {
      if (want && f.whole && !want.length) continue;
      out.push(...f.head, ...f.hunks.flat());
      continue;
    }
    const keep = f.hunks.filter((_, i) => want.includes(i));
    if (keep.length) out.push(...f.head, ...keep.flat());
  }
  return out.length ? out.join('\n') + '\n' : '';
}

/**
 * Apply some of a session's changes to the branch it started from, in the main checkout.
 *   from    the commit everything is compared with (the base, or what was applied before: refs/orbix/accepted/<slug>)
 *   tree    the session folder's snapshot (snapshotTree) the choice was made on
 *   paths   the files to apply; `hunks` optionally narrows a file to some of its hunks
 * The new commit is built in a scratch index on top of the base branch with a three-way apply, so a conflict is found
 * before anything changes: then { applied: false, conflict: true, files } and both checkouts are as they were. On
 * success the main checkout is fast-forwarded to it (your uncommitted edits to other files stay) and the accepted
 * commit moves on: { applied: true, hash, accepted, paths }.
 */
export async function applyPartial(backend, { repo, wt, slug, baseBranch, from, tree, paths, hunks = {}, message }) {
  const s = checkSlug(slug);
  if (!SHA_RE.test(String(from || '')) || !SHA_RE.test(String(tree || ''))) throw bad('Unknown commit');
  const list = cleanPaths(paths);
  if (!baseBranch) throw bad('This session started on a detached HEAD, so there is no branch to apply to. Merge it with git yourself.');
  const main = await repoInfo(backend, repo);
  if (!main) throw bad('The project folder is no longer a git repository.');
  if (main.branch !== baseBranch) throw conflictErr(`The project folder is on ${main.branch || 'a detached HEAD'}, not ${baseBranch}. Switch it back to ${baseBranch}, then apply.`);
  if ((await git(backend, repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0) throw conflictErr('A merge is already in progress in the project folder. Finish or abort it first.');
  const clash = (await dirtyFiles(backend, repo)).filter((p) => list.includes(p));
  if (clash.length) throw conflictErr(`You have uncommitted changes to ${clash.slice(0, 3).join(', ')}${clash.length > 3 ? ` and ${clash.length - 3} more` : ''}, which this would overwrite. Commit or stash them, then apply.`);

  const r = await git(backend, wt, ['diff', ...DIFF, '-U3', '--binary', '--full-index', from, tree, '--', ...list], { maxBytes: PATCH_MAX });
  if (r.code !== 0) throw gitFailure(r.stderr.toString('utf8'), 'git diff');
  if (r.stdout.length >= PATCH_MAX) throw bad('These changes are too large to apply part by part. Apply the whole run instead.');
  const patch = pickPatch(parsePatch(r.stdout.toString('utf8')), hunks);
  if (!patch) throw bad('Nothing is selected to apply.');

  // What has been applied, as a commit on top of `from`: the patch was made from it, so it always applies.
  const accepted = await withScratchIndex(backend, wt, async (env) => {
    await run(backend, wt, ['apply', '--cached', '--whitespace=nowarn', '-'], { env, input: patch });
    const t = (await run(backend, wt, ['write-tree'], { env })).trim();
    return (await run(backend, wt, ['commit-tree', t, '-p', from, '-m', `ORBIX: applied from orbix/${s}`], { env })).trim();
  }, { seed: from });

  // The commit for the base branch, made without touching the main checkout.
  const tip = (await run(backend, repo, ['rev-parse', '--verify', `refs/heads/${baseBranch}^{commit}`])).trim();
  const made = await withScratchIndex(backend, repo, async (env) => {
    const a = await git(backend, repo, ['apply', '--cached', '--3way', '--whitespace=nowarn', '-'], { env, input: patch });
    if (a.code !== 0) {
      const unmerged = (await git(backend, repo, ['ls-files', '-u', '-z'], { env })).stdout.toString('utf8').split('\0').filter(Boolean).map((l) => l.slice(l.indexOf('\t') + 1));
      const why = a.stderr.toString('utf8');
      const failed = [...why.matchAll(/^error: (?:patch failed: (.+):\d+|(.+): (?:does not exist in index|already exists in index|patch does not apply))$/gm)].map((m) => m[1] || m[2]);
      const files = [...new Set([...unmerged, ...failed])];
      if (files.length) return { conflict: true, files };
      throw gitFailure(why, 'git apply');
    }
    const t = (await run(backend, repo, ['write-tree'], { env })).trim();
    const hash = (await run(backend, repo, ['commit-tree', t, '-p', tip, '-m', String(message || '').trim().slice(0, 2000) || `Apply part of orbix/${s}`], { env })).trim();
    return { hash };
  }, { seed: tip });
  if (made.conflict) return { applied: false, conflict: true, files: made.files };

  // Move the main checkout to it. A fast-forward changes only the files of the commit and refuses (changing nothing)
  // if one of yours is in the way.
  const ff = await git(backend, repo, ['merge', '--ff-only', '--no-verify', '-q', made.hash]);
  if (ff.code !== 0) throw conflictErr(`The project folder could not take the changes, so nothing was changed: ${ff.stderr.toString('utf8').trim() || ff.stdout.toString('utf8').trim() || 'git merge failed'}`);
  await run(backend, repo, ['update-ref', `${ACCEPTED_REF}/${s}`, accepted]);
  return { applied: true, hash: made.hash, accepted, paths: list };
}
