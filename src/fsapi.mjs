// Read-only file-system access for the file browser, file viewer, folder picker and @-mention search.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isWinPath, runProc } from './backend.mjs';
import { looksBinary } from './util.mjs';
import { git } from './gitapi.mjs';

const MAX_TEXT = 2 * 1024 * 1024;
const MAX_IMAGE = 6 * 1024 * 1024;
const IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml' };
const HIDDEN_DIRS = new Set(['$RECYCLE.BIN', 'System Volume Information']);
const SKIP_DIRS = new Set([...HIDDEN_DIRS, 'node_modules', '.git']);

/** Join using the separator style of `parent`. */
export function joinPath(parent, name) {
  if (isWinPath(parent)) return parent.replace(/[\\/]+$/, '') + '\\' + name;
  return (parent === '/' ? '' : parent.replace(/\/+$/, '')) + '/' + name;
}

export function parentPath(p) {
  if (!p) return '';
  if (isWinPath(p)) {
    const par = path.win32.dirname(p);
    return par === p || /^[A-Za-z]:\\?$/.test(p) ? '' : par;
  }
  if (p === '/') return '';
  return path.posix.dirname(p);
}

/** Convert a /mnt/x/... Linux path to its Windows display form when running under WSL. */
export function normalizeForUi(p, backend) {
  return backend.isWsl ? backend.displayPath(p) : p;
}

async function roots(backend) {
  const entries = [];
  for (let c = 67; c <= 90; c++) {
    const d = String.fromCharCode(c) + ':\\';
    try {
      await fs.promises.access(d);
      entries.push({ name: d, path: d, dir: true, kind: 'drive' });
    } catch {}
  }
  const home = await backend.home().catch(() => null);
  if (backend.isWsl) {
    if (home) entries.unshift({ name: `~ (WSL ${backend.distro}) ${home}`, path: home, dir: true, kind: 'home' });
    entries.push({ name: `/ (WSL ${backend.distro})`, path: '/', dir: true, kind: 'root' });
  } else {
    entries.unshift({ name: `~ ${os.homedir()}`, path: os.homedir(), dir: true, kind: 'home' });
  }
  return { path: '', parent: null, entries };
}

export async function listDir(backend, p, { dirsOnly = false } = {}) {
  if (!p) return roots(backend);
  const shown = normalizeForUi(p, backend);
  const host = backend.hostPath(shown);
  let ents;
  try {
    ents = await fs.promises.readdir(host, { withFileTypes: true });
  } catch (e) {
    throw Object.assign(new Error(`Cannot open ${shown}: ${e.code || e.message}`), { status: 404 });
  }
  const out = [];
  await Promise.all(
    ents.map(async (e) => {
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = (await fs.promises.stat(path.join(host, e.name))).isDirectory();
        } catch {}
      }
      if (dirsOnly && !isDir) return;
      if (isDir && HIDDEN_DIRS.has(e.name)) return;
      out.push({ name: e.name, path: joinPath(shown, e.name), dir: isDir });
    }),
  );
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.dir ? -1 : 1));
  return { path: shown, parent: parentPath(shown), entries: out };
}

export async function readFile(backend, p) {
  const host = backend.hostPath(normalizeForUi(p, backend));
  let st;
  try {
    st = await fs.promises.stat(host);
  } catch (e) {
    throw Object.assign(new Error(`Cannot read ${p}: ${e.code || e.message}`), { status: 404 });
  }
  if (st.isDirectory()) throw Object.assign(new Error('That’s a folder, not a file'), { status: 400 });
  if (!st.isFile()) throw Object.assign(new Error('That isn’t a regular file'), { status: 400 }); // a device (CON, NUL) can block a read
  const ext = path.extname(host).slice(1).toLowerCase();
  const base = { path: p, size: st.size, mtime: st.mtimeMs, ext };
  if (IMG[ext]) {
    if (st.size > MAX_IMAGE) return { ...base, image: true, tooLarge: true };
    const buf = await fs.promises.readFile(host);
    return { ...base, image: true, dataUrl: `data:${IMG[ext]};base64,${buf.toString('base64')}` };
  }
  const fh = await fs.promises.open(host, 'r');
  try {
    const len = Math.min(st.size, MAX_TEXT);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    const got = buf.subarray(0, bytesRead); // the file may have shrunk since stat
    if (looksBinary(got)) return { ...base, binary: true };
    return { ...base, content: got.toString('utf8'), truncated: st.size > MAX_TEXT };
  } finally {
    await fh.close();
  }
}

// The list of a project's files is reused for a few seconds. Search runs on every keystroke; without this, each
// query would start `git ls-files` (or walk the tree) again. A very large list is not cached, to keep memory flat.
const FIND_TTL = 4000;
const FIND_MAX = 8;
const FIND_MAX_FILES = 40000;
const findCache = new Map();
const findPending = new Map();
let findGen = 0;

function findKey(backend, root) {
  return `${backend.isWsl ? `wsl:${backend.distro || ''}` : 'native'}|${normalizeForUi(root, backend)}`;
}

async function listProjectFiles(backend, root) {
  // `--cached` also lists files deleted from the work tree but still in the index; subtract those so search never
  // offers a file that is not there to open.
  const [r, gone] = await Promise.all([
    git(backend, root, ['ls-files', '--cached', '--others', '--exclude-standard'], { timeout: 15000, maxBytes: 16 * 1024 * 1024 }).catch(() => null),
    git(backend, root, ['ls-files', '--deleted'], { timeout: 15000, maxBytes: 4 * 1024 * 1024 }).catch(() => null),
  ]);
  if (r && r.code === 0) {
    const removed = gone && gone.code === 0 ? new Set(gone.stdout.toString('utf8').split('\n').filter(Boolean)) : null;
    return r.stdout.toString('utf8').split('\n').filter((f) => f && !removed?.has(f));
  }
  const files = [];
  const host = backend.hostPath(normalizeForUi(root, backend));
  const stack = [['', 0]];
  while (stack.length && files.length < 8000) {
    const [rel, depth] = stack.pop();
    let ents;
    try {
      ents = await fs.promises.readdir(path.join(host, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && depth < 6 && !e.name.startsWith('.')) stack.push([rel ? `${rel}/${e.name}` : e.name, depth + 1]);
      } else files.push(rel ? `${rel}/${e.name}` : e.name);
    }
  }
  return files;
}

/** Forget cached file lists. Used by tests and after a bulk change to a project. */
export function clearFileIndex() {
  findGen++;
  findCache.clear();
  findPending.clear();
}

async function cachedProjectFiles(backend, root) {
  const key = findKey(backend, root);
  const hit = findCache.get(key);
  if (hit && Date.now() - hit.at < FIND_TTL) return hit.files;
  let pending = findPending.get(key);
  if (!pending) {
    const gen = findGen;
    pending = listProjectFiles(backend, root).then((files) => {
      // The project may have been cleared while the list was being built: return it, but do not cache it.
      if (gen === findGen && files.length <= FIND_MAX_FILES) {
        findCache.set(key, { at: Date.now(), files });
        if (findCache.size > FIND_MAX) findCache.delete(findCache.keys().next().value);
      }
      return files;
    });
    findPending.set(key, pending);
    pending.finally(() => findPending.get(key) === pending && findPending.delete(key)).catch(() => {});
  }
  return pending;
}

/** Fuzzy file search for @-mentions: prefers `git ls-files`, falls back to a bounded walk. */
export async function findFiles(backend, root, query, limit = 40) {
  const q = (query || '').toLowerCase();
  const files = await cachedProjectFiles(backend, root);
  const scored = [];
  for (const f of files) {
    const lf = f.toLowerCase();
    if (!q) {
      scored.push([f.length, f]);
      continue;
    }
    const base = lf.slice(lf.lastIndexOf('/') + 1);
    let s = -1;
    if (base === q) s = 0;
    else if (base.startsWith(q)) s = 1;
    else if (base.includes(q)) s = 2;
    else if (lf.includes(q)) s = 3;
    else {
      // subsequence match
      let i = 0;
      for (const ch of lf) if (ch === q[i]) i++;
      if (i === q.length) s = 4;
    }
    if (s >= 0) scored.push([s * 1000 + f.length, f]);
  }
  scored.sort((a, b) => a[0] - b[0]);
  return scored.slice(0, limit).map((x) => x[1]);
}

/** Reveal a path in Windows Explorer. Never executes the target. */
export async function reveal(backend, p) {
  const host = backend.hostPath(normalizeForUi(p, backend));
  let st;
  try {
    st = await fs.promises.stat(host);
  } catch (e) {
    throw Object.assign(new Error(`Cannot open ${p}: ${e.code || e.message}`), { status: 404 }); // only existing files and folders reach Explorer
  }
  const args = st.isDirectory() ? [host] : [`/select,${host}`];
  await runProc('explorer.exe', args, { timeout: 5000 });
}

