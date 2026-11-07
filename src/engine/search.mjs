// File search for the agent's glob and grep tools: a .gitignore-aware walker in JS, and ripgrep when it is
// installed where the files live (Windows rg.exe for Windows drives, rg inside WSL for Linux paths). Both produce
// the same sorted results, so the tools format them one way.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isWinPath, runProc, toLinuxPath } from '../backend.mjs';
import { looksBinary, pool } from '../util.mjs';
import { cachedText } from './files.mjs';

/** Folders never searched, ignored or not. */
export const SKIP_DIRS = new Set(['.git', 'node_modules', '$RECYCLE.BIN', 'System Volume Information', '.venv', '__pycache__']);
export const MAX_WALK_FILES = 50000;
export const MAX_GREP_BYTES = 1024 * 1024;
const MAX_COUNT = 20000; // matching lines counted before a search stops early
const LINE_CHARS = 300;

const escapeRe = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Brace groups that are alternations: balanced and holding a top-level comma. `{2}` and a lone `{` stay literal, as in a shell. */
function braceAlternations(glob) {
  const open = new Set();
  const close = new Set();
  const comma = new Set();
  const stack = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '{') stack.push({ at: i, commas: [] });
    else if (c === '}' && stack.length) {
      const g = stack.pop();
      if (g.commas.length) {
        open.add(g.at);
        close.add(i);
        for (const k of g.commas) comma.add(k);
      }
    } else if (c === ',' && stack.length) stack[stack.length - 1].commas.push(i);
  }
  return { open, close, comma };
}

/** Glob -> RegExp: `*` and `?` stay inside one path segment, `**` crosses folders, `{a,b}` is an alternation. Case-insensitive. */
export function globToRegExp(glob) {
  const alt = braceAlternations(glob);
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (alt.open.has(i)) re += '(?:';
    else if (alt.close.has(i)) re += ')';
    else if (alt.comma.has(i)) re += '|';
    else re += escapeRe(c);
  }
  return new RegExp('^' + re + '$', 'i');
}

/** Matcher for a glob: a pattern without `/` also matches a file's base name at any depth. */
function globMatcher(pattern) {
  const p = String(pattern ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  const re = globToRegExp(p);
  const nameOnly = !p.includes('/');
  return (rel) => re.test(rel) || (nameOnly && re.test(rel.slice(rel.lastIndexOf('/') + 1)));
}

function ignoreRegExp(pat) {
  let anchored = pat.includes('/');
  if (pat.startsWith('/')) pat = pat.slice(1);
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') {
      const segStart = i === 0 || pat[i - 1] === '/';
      if (pat[i + 1] === '*' && segStart && pat[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else if (pat[i + 1] === '*' && segStart && i + 2 === pat.length) {
        re += '.*';
        i++;
      } else {
        while (pat[i + 1] === '*') i++;
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const close = pat.indexOf(']', i + 2);
      if (close < 0) {
        re += '\\[';
        continue;
      }
      let body = pat.slice(i + 1, close).replace(/\\/g, '\\\\');
      if (body[0] === '!') body = '^' + body.slice(1);
      re += `[${body}]`;
      i = close;
    } else if (c === '\\' && i + 1 < pat.length) re += escapeRe(pat[++i]);
    else re += escapeRe(c);
  }
  try {
    return new RegExp((anchored ? '^' : '^(?:.*/)?') + re + '$');
  } catch {
    return null;
  }
}

/** Parse .gitignore text into rules { re, neg, dirOnly }. */
export function compileIgnore(text) {
  const rules = [];
  for (let line of String(text).split(/\r?\n/)) {
    line = line.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let neg = false;
    if (line.startsWith('!')) {
      neg = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.replace(/\/+$/, '');
    }
    if (!line) continue;
    const re = ignoreRegExp(line.replace(/\\ /g, ' '));
    if (re) rules.push({ re, neg, dirOnly });
  }
  return rules;
}

/** Is `rel` (relative to the walk root, `/` separators) ignored by the stacked .gitignore levels? Last match wins. */
export function isIgnored(levels, rel, isDir) {
  let ignored = false;
  for (const lv of levels) {
    let r;
    if (lv.prefix) r = `${lv.prefix}/${rel}`;
    else if (lv.base) {
      if (!rel.startsWith(lv.base + '/')) continue;
      r = rel.slice(lv.base.length + 1);
    } else r = rel;
    for (const rule of lv.rules) if ((!rule.dirOnly || isDir) && rule.re.test(r)) ignored = !rule.neg;
  }
  return ignored;
}

/** .gitignore files of the folders above `root` up to its repository root (they apply to the search too). */
async function ancestorLevels(root) {
  const chain = [];
  let dir = root;
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      const levels = [];
      for (const d of chain.reverse()) {
        const text = await cachedText(path.join(d, '.gitignore'));
        const rules = text ? compileIgnore(text) : [];
        if (rules.length) levels.push({ rules, prefix: path.relative(d, root).split(path.sep).join('/') });
      }
      return levels;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    chain.push(dir);
  }
  return [];
}

/**
 * Every file under `root` (relative paths with `/`, sorted), skipping SKIP_DIRS, symlinks and .gitignore'd paths.
 * Returns { files, capped } where capped means the walk stopped at `maxFiles`.
 */
export async function walk(root, { maxFiles = MAX_WALK_FILES, signal, gitignore = true } = {}) {
  const files = [];
  let capped = false;
  let queue = [{ dir: root, rel: '', levels: gitignore ? await ancestorLevels(root) : [] }];
  while (queue.length && !capped && !signal?.aborted) {
    const batch = queue.splice(0, 16);
    const listed = await Promise.all(batch.map(async (d) => ({ d, ents: await fs.promises.readdir(d.dir, { withFileTypes: true }).catch(() => null) })));
    const next = [];
    for (const { d, ents } of listed) {
      if (!ents) continue;
      let levels = d.levels;
      if (gitignore && ents.some((e) => e.name === '.gitignore' && e.isFile())) {
        const text = await cachedText(path.join(d.dir, '.gitignore'));
        const rules = text ? compileIgnore(text) : [];
        if (rules.length) levels = [...levels, { rules, base: d.rel }];
      }
      for (const e of ents) {
        const rel = d.rel ? `${d.rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !isIgnored(levels, rel, true)) next.push({ dir: path.join(d.dir, e.name), rel, levels });
        } else if (e.isFile() && !isIgnored(levels, rel, false)) {
          if (files.length >= maxFiles) {
            capped = true;
            break;
          }
          files.push(rel);
        }
      }
    }
    queue = next.concat(queue);
  }
  return { files: files.sort(byPath), capped };
}

const rgFound = new Map(); // 'win' | 'wsl:<distro>' -> { path, at }
const RG_SKIP = [...SKIP_DIRS].flatMap((d) => ['-g', `!${d}`]);
const RG_BASE = ['--no-config', '--hidden', '--no-require-git', '--color', 'never', '--sort', 'path', ...RG_SKIP];

/** How to run ripgrep for files under `hostRoot`, or null to use the JS walker. */
export async function ripgrepFor(backend, hostRoot) {
  if (process.env.ORBIX_NO_RG) return null;
  const wslUnc = /^\\\\wsl(?:\.localhost|\$)\\/i.test(hostRoot);
  const key = wslUnc ? `wsl:${backend?.distro || ''}` : 'win';
  if (wslUnc ? !(backend?.isWsl && typeof backend.exec === 'function' && typeof backend.spawn === 'function') : !(process.platform === 'win32' && isWinPath(hostRoot))) return null;
  let hit = rgFound.get(key);
  if (!hit || (!hit.path && Date.now() - hit.at > 5 * 60 * 1000)) {
    let found = null;
    if (wslUnc) {
      const r = await backend.exec(['sh', '-c', 'command -v rg'], { timeout: 10000 }).catch(() => null);
      const p = r?.code === 0 ? r.stdout.toString('utf8').trim().split('\n').pop() : '';
      found = p?.startsWith('/') ? p : null;
    } else {
      const r = await runProc('where.exe', ['rg'], { timeout: 8000 });
      found = (r.code === 0 && r.stdout.toString('utf8').split(/\r?\n/)[0]?.trim()) || null;
    }
    hit = { path: found, at: Date.now() };
    rgFound.set(key, hit);
  }
  if (!hit.path) return null;
  return {
    spawn: (args) => (wslUnc ? backend.spawn([hit.path, ...args], { cwd: toLinuxPath(hostRoot), quiet: true }) : spawn(hit.path, args, { cwd: hostRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })),
  };
}

/** Run rg, calling onLine(line) per stdout line; onLine returns false to stop early. Resolves { code, stderr, stopped }. */
function runRg(rg, args, onLine, signal) {
  return new Promise((resolve) => {
    let child;
    try {
      child = rg.spawn(args);
    } catch (e) {
      return resolve({ code: -1, stderr: e.message, stopped: false });
    }
    let buf = '';
    let stderr = '';
    let stopped = false;
    const stop = () => {
      stopped = true;
      try {
        child.kill();
      } catch {}
    };
    signal?.addEventListener('abort', stop, { once: true });
    child.stdin?.end();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (stopped) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line && onLine(line) === false) return stop();
      }
    });
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.on('error', (e) => resolve({ code: -1, stderr: e.message, stopped }));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop);
      if (!stopped && buf.trim()) onLine(buf.replace(/\r$/, ''));
      resolve({ code: code ?? -1, stderr, stopped });
    });
  });
}

const relOf = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
const rgText = (o) => (o?.text != null ? o.text : o?.bytes ? Buffer.from(o.bytes, 'base64').toString('utf8') : '');

/**
 * Files under `hostRoot` matching `pattern`, sorted. Returns { files (at most `limit`), total, capped, engine }.
 */
export async function globFiles({ hostRoot, pattern, limit = 300, backend, signal }) {
  const match = globMatcher(pattern);
  const rg = await ripgrepFor(backend, hostRoot).catch(() => null);
  if (rg) {
    const files = [];
    let total = 0;
    const r = await runRg(rg, ['--files', ...RG_BASE, '.'], (line) => {
      const rel = relOf(line);
      if (!match(rel)) return true;
      total++;
      if (files.length < limit) files.push(rel);
      return total < MAX_WALK_FILES;
    }, signal);
    if (r.code === 0 || r.code === 1 || r.stopped) return { files, total, capped: r.stopped && !signal?.aborted, engine: 'rg' };
  }
  const { files: all, capped } = await walk(hostRoot, { signal });
  const hits = all.filter(match);
  return { files: hits.slice(0, limit), total: hits.length, capped, engine: 'js' };
}

/** Shorten a long line to a window around its first match. */
function clipLine(text, re) {
  if (text.length <= LINE_CHARS) return text;
  const at = re ? Math.max(0, text.search(re)) : 0;
  const from = at > LINE_CHARS - 100 ? at - 100 : 0;
  return `${from ? '…' : ''}${text.slice(from, from + LINE_CHARS)}…`;
}

/**
 * Search file contents. Returns { hits: [{ file, line, text, match }], counts: Map(file -> matching lines),
 * total (matching lines, at most MAX_COUNT), files, skippedLarge, capped, overflow, engine }.
 * `hits` holds the first `limit` matching lines in path order plus `context` lines around each.
 */
export async function grepFiles({ hostRoot, single, regex, glob, context = 0, limit = 200, backend, signal }) {
  const filter = glob ? globMatcher(glob) : null;
  const rg = single ? null : await ripgrepFor(backend, hostRoot).catch(() => null);
  if (rg) {
    const out = await grepRg(rg, { regex, glob, context, limit, filter, signal });
    if (out) return out;
  }
  let list;
  let capped = false;
  if (single) list = [{ full: hostRoot, rel: path.basename(hostRoot) }];
  else {
    const w = await walk(hostRoot, { signal });
    capped = w.capped;
    list = w.files.filter((f) => !filter || filter(f)).map((rel) => ({ full: path.join(hostRoot, ...rel.split('/')), rel }));
  }
  let skippedLarge = 0;
  let total = 0;
  const scanned = await pool(list, 16, async (f) => {
    if (signal?.aborted || total >= MAX_COUNT) return null;
    const st = await fs.promises.stat(f.full);
    if (st.size > MAX_GREP_BYTES) {
      skippedLarge++;
      return null;
    }
    const buf = await fs.promises.readFile(f.full);
    if (looksBinary(buf)) return null;
    const lines = buf.toString('utf8').split('\n');
    const found = [];
    // Match without the line's \r, so `$` works on CRLF files as it does in an editor.
    for (let i = 0; i < lines.length; i++) if (regex.test(lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i])) found.push(i);
    if (!found.length) return null;
    total += found.length;
    return { rel: f.rel, lines, found };
  });
  const files = scanned.filter(Boolean).sort((a, b) => byPath(a.rel, b.rel));
  const counts = new Map(files.map((f) => [f.rel, f.found.length]));
  const hits = [];
  let shown = 0;
  for (const f of files) {
    if (shown >= limit) break;
    const take = f.found.slice(0, limit - shown);
    shown += take.length;
    const want = new Map();
    for (const i of take) {
      for (let k = Math.max(0, i - context); k <= Math.min(f.lines.length - 1, i + context); k++) if (!want.has(k)) want.set(k, false);
      want.set(i, true);
    }
    for (const k of [...want.keys()].sort((x, y) => x - y)) {
      const text = f.lines[k].replace(/\r$/, '');
      if (k === f.lines.length - 1 && !text && !want.get(k)) continue;
      hits.push({ file: f.rel, line: k + 1, text: clipLine(text, want.get(k) ? regex : null), match: want.get(k) });
    }
  }
  const sum = [...counts.values()].reduce((a, b) => a + b, 0);
  return { hits, counts, total: sum, files: counts.size, skippedLarge, capped, overflow: total >= MAX_COUNT, engine: 'js' };
}

async function grepRg(rg, { regex, glob, context, limit, filter, signal }) {
  // --crlf: `$` matches before \r\n as well. --iglob: file globs are case-insensitive, as in the JS engine.
  const args = ['--json', ...RG_BASE, '--crlf', '--max-filesize', '1M', '-e', regex.source];
  if (regex.flags.includes('i')) args.push('-i');
  if (context > 0) args.push('-C', String(context));
  if (glob) args.push('--iglob', glob);
  args.push('.');
  const counts = new Map();
  const hits = [];
  let shown = 0;
  let total = 0;
  const lastMatch = new Map(); // file -> last shown match line (keeps trailing context of shown matches only)
  const r = await runRg(rg, args, (line) => {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return true;
    }
    if (o.type !== 'match' && o.type !== 'context') return true;
    const file = relOf(rgText(o.data.path));
    if (filter && !filter(file)) return true;
    const ln = o.data.line_number;
    const text = rgText(o.data.lines).replace(/\r?\n$/, '');
    if (o.type === 'match') {
      counts.set(file, (counts.get(file) || 0) + 1);
      total++;
      if (shown < limit) {
        shown++;
        hits.push({ file, line: ln, text: clipLine(text, regex), match: true });
        lastMatch.set(file, ln);
      }
      return total < MAX_COUNT;
    }
    // Context: before a shown match it is added and dropped again if no match follows within `context` lines.
    if (shown < limit || (lastMatch.has(file) && ln - lastMatch.get(file) <= context)) hits.push({ file, line: ln, text: clipLine(text, null), match: false });
    return true;
  }, signal);
  if (!(r.code === 0 || r.code === 1 || r.stopped)) return null; // a pattern rg rejects (look-around...): use the JS engine
  // Drop context lines that do not sit within `context` lines of a shown match.
  const shownSet = new Map();
  for (const h of hits) if (h.match) (shownSet.get(h.file) || shownSet.set(h.file, []).get(h.file)).push(h.line);
  const kept = hits.filter((h) => h.match || (shownSet.get(h.file) || []).some((m) => Math.abs(m - h.line) <= context));
  return { hits: kept, counts, total, files: counts.size, skippedLarge: 0, capped: false, overflow: total >= MAX_COUNT, engine: 'rg' };
}
