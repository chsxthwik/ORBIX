// Tools the ORBIX agent can call. Each returns { text, images?, details?, isError? }; nothing is invented: a result is
// exactly what the file system or the command produced. Error texts say what went wrong and how to recover.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isWinPath, killTree } from '../backend.mjs';
import { webFetch, WEB_FETCH_DEF } from './webfetch.mjs';
import { webSearch, WEB_SEARCH_DEF } from './websearch.mjs';
import { TASK_DEF } from './subagent.mjs';
import { decodeText, encodeText, ENCODING_NAMES, lineEnding, prepareImage, sniffImage, cleanTerminal, looksBinaryText, formatBytes } from './files.mjs';
import { globFiles, grepFiles, MAX_GREP_BYTES, MAX_WALK_FILES } from './search.mjs';
import { syntaxNote } from './syntax.mjs';

const MAX_READ_BYTES = 5 * 1024 * 1024;
const MAX_READ_CHARS = 200000;
const MAX_LINE_CHARS = 2000;
const MAX_LIST = 1000;
const MAX_OUTPUT = 30000; // bash: characters kept, as the first HEAD and the last MAX_OUTPUT - HEAD
const HEAD = 10000;
// bash output keeps colour codes (SGR) for the UI; they are removed from what the model sees (proc.mjs _context).
const SGR_ON = { keepSgr: true };

const PATH = { type: 'string', description: 'Absolute path, or relative to the project folder.' };

const BASH_BASE = 'Runs in the project folder (each call starts there again: cd and variables do not carry over). Returns stdout and stderr combined (long output keeps the start and the end), then a status line with the exit code and duration. No input can be typed, so use non-interactive flags (-y, --no-pager, CI=1). Default timeout 120 s, max 600 s. Use read, grep, glob, edit and write for files instead of cat, grep, find, sed or echo redirects.';

const bashDef = ({ windows = false, distro = '' } = {}) => ({
  name: 'bash',
  description: windows
    ? `Run a command on Windows with cmd.exe (default) or, with shell "powershell", Windows PowerShell 5. A cmd command must be one line: join steps with && or use powershell for a multi-line script. ${BASH_BASE}`
    : `Run a command with bash${distro ? ` in WSL (${distro}); Windows drives are mounted at /mnt/<letter>/` : ''}. ${BASH_BASE}`,
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      timeout: { type: 'integer', description: 'Seconds before the command is stopped (1-600, default 120).' },
      ...(windows ? { shell: { type: 'string', enum: ['cmd', 'powershell'], description: 'cmd (default) or powershell.' } } : {}),
    },
    required: ['command'],
  },
});

const BASE_DEFS = [
  {
    name: 'read',
    description: 'Read a file. Text comes back as numbered lines ("N<TAB>text"; the number is not part of the file). Large files: page with offset/limit (default: the first 2000 lines). PNG, JPEG, GIF and WebP images come back as images you can see. A folder path lists its entries (folders end with /). Read a file before you edit it.',
    input_schema: { type: 'object', properties: { path: PATH, offset: { type: 'integer', description: 'First line to read, 1-based (default 1).' }, limit: { type: 'integer', description: 'Number of lines (default 2000).' } }, required: ['path'] },
  },
  {
    name: 'write',
    description: 'Create a file, or replace a whole file, with `content` (parent folders are created). To change part of an existing file use edit. An existing file must be read first in this session, and keeps its encoding and CRLF line endings. Refused when the file changed on disk after you last read it: read it again first.',
    input_schema: { type: 'object', properties: { path: PATH, content: { type: 'string', description: 'The complete new file content.' } }, required: ['path', 'content'] },
  },
  {
    name: 'edit',
    description: 'Replace text in a file. `old_string` is copied from the current file (from read output, without the line-number prefix) and must match exactly one place: include enough surrounding lines to make it unique, or set replace_all to change every occurrence. When there is no exact match, a unique match that differs only in whitespace or indentation is used (the new text is re-indented to fit, and the result shows the diff). Returns the changed line range. The file must exist: use write to create one.',
    input_schema: { type: 'object', properties: { path: PATH, old_string: { type: 'string', description: 'Exact text to replace (not empty).' }, new_string: { type: 'string', description: 'Replacement text (may be empty to delete).' }, replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' } }, required: ['path', 'old_string', 'new_string'] },
  },
  bashDef(),
  {
    name: 'glob',
    description: 'Find files by path pattern. `*` and `?` match within one path segment, `**` across folders, `{a,b}` either; a pattern without / matches file names at any depth; case-insensitive. Skips .git, node_modules and anything .gitignore excludes. Returns paths relative to the search folder, sorted, at most 300 (with the total).',
    input_schema: { type: 'object', properties: { pattern: { type: 'string', description: 'e.g. "src/**/*.ts" or "*.test.js".' }, path: { type: 'string', description: 'Folder to search (default: the project folder).' } }, required: ['pattern'] },
  },
  {
    name: 'grep',
    description: 'Search file contents with a regular expression (JavaScript syntax; escape literal characters such as . ( [ { with \\). Skips binary files, files over 1 MB, .git, node_modules and anything .gitignore excludes. Results are sorted by path. output_mode "content" (default): "path:line: text" lines (with `context`, surrounding lines as "path-line- text"); "files": only the paths of matching files; "count": matching lines per file.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression.' },
        path: { type: 'string', description: 'File or folder (default: the project folder).' },
        glob: { type: 'string', description: 'Only files matching this glob, e.g. "*.ts" or "src/**/*.py".' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive (default false).' },
        output_mode: { type: 'string', enum: ['content', 'files', 'count'], description: 'Default "content".' },
        context: { type: 'integer', description: 'Lines of context before and after each match, 0-10 (content mode).' },
        limit: { type: 'integer', description: 'Maximum lines or files returned (default 200, max 2000).' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'todo',
    description: 'Track the steps of multi-step work. Send the FULL list each time (it replaces the previous one). Keep exactly one task in_progress while you work on it; mark it completed as soon as it is done. Skip this for one-step tasks.',
    input_schema: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { content: { type: 'string', description: 'The step, imperative ("Add tests for X").' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['content', 'status'] } } }, required: ['todos'] },
  },
  WEB_FETCH_DEF,
  WEB_SEARCH_DEF, // offered to the model only when a search service is set up (proc.mjs)
  TASK_DEF,
];

/** Tool definitions with the default (bash) shell description; toolDefsFor() gives the backend-specific set. */
export const TOOL_DEFS = BASE_DEFS;

/** Tool definitions for a backend: the bash tool describes the real shell (WSL bash, or cmd.exe / PowerShell). */
export function toolDefsFor(backend) {
  const bash = bashDef({ windows: backend && !backend.isWsl, distro: backend?.isWsl ? backend.distro || 'default distro' : '' });
  return BASE_DEFS.map((d) => (d.name === 'bash' ? bash : d));
}

/** Tools that only look and can safely run side by side. (`task` runs read-only subagents; the engine runs it.) */
export const READ_ONLY = new Set(['read', 'glob', 'grep', 'todo', 'web_fetch', 'web_search', 'task']);

/** Tools that change things and therefore ask for approval in "ask" mode. */
export const NEEDS_APPROVAL = new Set(['write', 'edit', 'bash']);

const sha1 = (t) => crypto.createHash('sha1').update(t).digest('hex');
const MAX_UNDO_BYTES = 500 * 1024;
function makeUndo(displayPath, before, written, encoding) {
  if (before != null && Buffer.byteLength(before) > MAX_UNDO_BYTES) return { skipped: true };
  return { path: displayPath, before, afterHash: sha1(written), ...(encoding && encoding !== 'utf-8' ? { encoding } : {}) };
}

/** Numbered diff text ("+12|new", "-12|old", " 12|context") with 2 lines of context; also the changed line range of the new text. */
function makeDiff(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) {
    ea--;
    eb--;
  }
  const strip = (l) => l.replace(/\r$/, '');
  // The changed middle, line by line: a longest-common-subsequence walk, so two edits far apart are two hunks and
  // the unchanged lines between them are not shown as removed and added. Very large middles fall back to one block.
  const n = ea - s + 1;
  const m = eb - s + 1;
  const ops = []; // ['=', i, j] | ['-', i] | ['+', j], indexes into a and b
  if (n > 0 && m > 0 && n * m <= 4_000_000) {
    const L = new Uint32Array((n + 1) * (m + 1));
    const at = (i, j) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[at(i, j)] = a[s + i] === b[s + j] ? L[at(i + 1, j + 1)] + 1 : Math.max(L[at(i + 1, j)], L[at(i, j + 1)]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[s + i] === b[s + j]) ops.push(['=', s + i++, s + j++]);
      else if (j >= m || (i < n && L[at(i + 1, j)] >= L[at(i, j + 1)])) ops.push(['-', s + i++]);
      else ops.push(['+', s + j++]);
    }
  } else {
    for (let i = s; i <= ea; i++) ops.push(['-', i]);
    for (let j = s; j <= eb; j++) ops.push(['+', j]);
  }
  // Removed lines before added ones within each run of changes, as diffs are read.
  for (let k = 0; k < ops.length; ) {
    if (ops[k][0] === '=') { k++; continue; }
    let e = k;
    while (e < ops.length && ops[e][0] !== '=') e++;
    const run = ops.slice(k, e);
    ops.splice(k, e - k, ...run.filter((o) => o[0] === '-'), ...run.filter((o) => o[0] === '+'));
    k = e;
  }
  // Two lines of context around each change; a gap between hunks is marked with "…".
  const all = [];
  for (let i = 0; i < s; i++) all.push(['=', i, i]);
  all.push(...ops);
  for (let i = ea + 1, j = eb + 1; i < a.length; i++, j++) all.push(['=', i, j]);
  const near = new Uint8Array(all.length);
  all.forEach((o, k) => {
    if (o[0] !== '=') for (let d = Math.max(0, k - 2); d <= Math.min(all.length - 1, k + 2); d++) near[d] = 1;
  });
  const out = [];
  let last = -1;
  all.forEach((o, k) => {
    if (!near[k]) return;
    if (last >= 0 && k > last + 1) out.push('…');
    last = k;
    out.push(o[0] === '=' ? ` ${o[1] + 1}|${strip(a[o[1]])}` : o[0] === '-' ? `-${o[1] + 1}|${strip(a[o[1]])}` : `+${o[1] + 1}|${strip(b[o[1]])}`);
  });
  return { diff: out.join('\n'), firstChangedLine: s + 1, lastChangedLine: Math.max(s + 1, eb + 1) };
}

/** `\\\\server\\share` of a UNC path (WSL's own \\\\wsl.localhost and \\\\wsl$ excepted), lower-cased, else ''. */
function shareOf(p) {
  const m = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(String(p || ''));
  if (!m || /^wsl(\.localhost|\$)$/i.test(m[1])) return '';
  return `\\\\${m[1]}\\${m[2]}`.toLowerCase();
}

/**
 * True for a network path outside the project's own share. Opening \\\\host\\share makes Windows sign in to that
 * host with the user's credentials, so a prompt-injected path must not be able to trigger it.
 */
export function isForeignShare(p, cwd) {
  const s = shareOf(p);
  return !!s && s !== shareOf(cwd);
}

const typeName = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
/** "edit(path: string, old_string: string, replace_all?: boolean)": a tool's arguments in one line, for error texts. */
export const signature = (def) => {
  const props = def.input_schema?.properties || {};
  const req = new Set(def.input_schema?.required || []);
  return `${def.name}(${Object.entries(props).map(([k, s]) => `${k}${req.has(k) ? '' : '?'}: ${s?.enum ? s.enum.map((e) => JSON.stringify(e)).join('|') : s?.type || 'any'}`).join(', ')})`;
};

/** Result text for a tool call whose arguments were not valid JSON. `def`: the tool's definition, when known. */
export const invalidArgsText = (def) => `Not run: the arguments were not valid JSON. Send the call again with one complete JSON object${def ? `: ${signature(def)}` : ' matching the tool schema'}. Escape quotes, backslashes and line breaks inside strings (\\" \\\\ \\n).`;

/** Check (and gently coerce: "10" -> 10, "true" -> true, a JSON string -> array) tool arguments. Returns { args } or { error }. */
export function checkArgs(def, input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return { error: `Arguments must be a JSON object. Expected ${signature(def)}.` };
  const props = def.input_schema.properties || {};
  const args = { ...input };
  const bad = (k, want) => ({ error: `Invalid argument "${k}": expected ${want}, got ${typeName(args[k])}. Expected ${signature(def)}.` });
  for (const k of def.input_schema.required || []) if (args[k] === undefined || args[k] === null) return { error: `Missing required argument "${k}". Expected ${signature(def)}.` };
  for (const [k, s] of Object.entries(props)) {
    let v = args[k];
    if (v === undefined || v === null) {
      delete args[k];
      continue;
    }
    if (s.type === 'integer' || s.type === 'number') {
      if (typeof v === 'string' && v.trim() && Number.isFinite(+v)) v = args[k] = +v;
      if (typeof v !== 'number' || !Number.isFinite(v)) return bad(k, s.type);
      if (s.type === 'integer') args[k] = Math.trunc(v);
    } else if (s.type === 'boolean') {
      if (v === 'true' || v === 'false') v = args[k] = v === 'true';
      if (typeof v !== 'boolean') return bad(k, 'boolean');
    } else if (s.type === 'string') {
      if (typeof v !== 'string') return bad(k, 'string');
    } else if (s.type === 'array') {
      if (typeof v === 'string') {
        try {
          v = args[k] = JSON.parse(v);
        } catch {}
      }
      if (!Array.isArray(v)) return bad(k, 'array');
    }
    if (s.enum && !s.enum.includes(args[k])) return { error: `Invalid argument "${k}": must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}.` };
  }
  return { args };
}

const fmtDuration = (ms) => (ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const lineAt = (text, index) => {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < index; i = text.indexOf('\n', i + 1)) n++;
  return n;
};
function occurrences(text, s) {
  const at = [];
  for (let i = text.indexOf(s); i >= 0; i = text.indexOf(s, i + s.length)) at.push(i);
  return at;
}
const countLines = (s) => {
  let n = 0;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
  return n;
};
const clipLines = (s, max) => {
  const l = s.split('\n');
  return l.length > max ? `${l.slice(0, max).join('\n')}\n[… ${l.length - max} more diff lines]` : s;
};
const listLines = (lines) => (lines.length > 8 ? `${lines.slice(0, 8).join(', ')}, …` : lines.join(', '));

/** Levenshtein distance, stopping early beyond `max`. */
function distance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Whitespace-tolerant match of `old` against whole lines of `text`. Returns { matches: [{ start, end, line, indent, oldIndent }] }.
 * Lines compare equal when they differ only in leading/trailing whitespace or runs of inner whitespace.
 */
function fuzzyLines(text, old) {
  const norm = (l) => l.trim().replace(/\s+/g, ' ');
  let oldLines = old.replace(/\r\n/g, '\n').split('\n');
  const endsNl = oldLines.length > 1 && oldLines[oldLines.length - 1] === '';
  if (endsNl) oldLines = oldLines.slice(0, -1);
  while (oldLines.length && !oldLines[0].trim()) oldLines = oldLines.slice(1);
  while (oldLines.length && !oldLines[oldLines.length - 1].trim()) oldLines = oldLines.slice(0, -1);
  if (!oldLines.length) return { matches: [] };
  const want = oldLines.map(norm);
  const lines = text.split('\n');
  const starts = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.length + 1;
  }
  const matches = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length && ok; k++) ok = norm(lines[i + k]) === want[k];
    if (!ok) continue;
    const last = i + want.length - 1;
    const end = starts[last] + lines[last].replace(/\r$/, '').length;
    matches.push({ start: starts[i], end, line: i + 1, indent: /^[ \t]*/.exec(lines[i])[0], oldIndent: /^[ \t]*/.exec(oldLines[0])[0] });
  }
  return { matches };
}

/** Re-indent `text` written for `from` indentation to `to`, line by line. */
function reindent(text, from, to) {
  if (from === to) return text;
  return text
    .split('\n')
    .map((l) => (l.trim() && l.startsWith(from) ? to + l.slice(from.length) : l))
    .join('\n');
}

/** Lines copied from read output carry "N<TAB>" prefixes; strip them when every non-empty line has one. */
function stripLineNumbers(s) {
  const lines = s.split('\n');
  const body = lines.filter((l) => l.trim());
  if (!body.length || !body.every((l) => /^\s*\d+\t/.test(l))) return null;
  return lines.map((l) => l.replace(/^\s*\d+\t/, '')).join('\n');
}

export function createTools({ backend, cwd, getSignal }) {
  const resolve = (p) => {
    const raw = String(p ?? '').trim();
    if (!raw) throw new Error('A path is required');
    if (isWinPath(raw) || raw.startsWith('/')) {
      if (isForeignShare(raw, cwd)) throw new Error(`Network paths are not opened by the agent: ${raw}. Copy the file into the project folder first.`);
      return raw;
    }
    return isWinPath(cwd) ? path.win32.resolve(cwd, raw) : path.posix.resolve(cwd, raw);
  };
  const host = (p) => backend.hostPath(resolve(p));
  const seen = new Map(); // host path -> mtimeMs when the agent last read or wrote it

  const remember = async (file) => {
    try {
      seen.set(file, (await fs.promises.stat(file)).mtimeMs);
    } catch {}
  };

  /** Close names in the parent folder (or the nearest existing folder) of a missing path, for the error text. */
  async function suggest(p) {
    let file;
    try {
      file = host(p);
    } catch {
      return '';
    }
    const dir = path.dirname(file);
    let names;
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      let up = dir;
      for (let i = 0; i < 12; i++) {
        const parent = path.dirname(up);
        if (parent === up) break;
        up = parent;
        if (fs.existsSync(up)) return ` The folder ${path.relative(up, dir) || dir} does not exist under ${up}.`;
      }
      return '';
    }
    const want = path.basename(file).toLowerCase();
    const stem = want.replace(/\.[^.]+$/, '');
    const close = names.filter((n) => {
      const l = n.toLowerCase();
      return l === want || (stem.length > 2 && l.replace(/\.[^.]+$/, '') === stem) || distance(l, want, 2) <= 2;
    });
    return close.length ? ` Similar names in that folder: ${close.slice(0, 6).join(', ')}.` : '';
  }

  async function readText(file) {
    const buf = await fs.promises.readFile(file);
    const dec = decodeText(buf);
    return dec ? { ...dec, buf } : null;
  }

  async function imageResult(file, shown, buf, { vision }) {
    const prep = prepareImage(buf, { label: `Image ${shown}` });
    if (!prep.ok) return { text: prep.note, isError: true, details: { path: shown } };
    if (vision === false) return { text: `${prep.note} The current model cannot view images; describe what you need or switch to a vision model.`, details: { path: shown, image: true } };
    return { text: prep.note, images: [prep.image], details: { path: shown, image: true, mimeType: prep.image.mimeType } };
  }

  const impl = {
    async read({ path: p, offset = 1, limit = 2000 }, hooks = {}) {
      const file = host(p);
      const shown = resolve(p);
      const st = await fs.promises.stat(file);
      if (st.isDirectory()) {
        const ents = (await fs.promises.readdir(file, { withFileTypes: true })).map((e) => e.name + (e.isDirectory() ? '/' : '')).sort();
        const more = ents.length > MAX_LIST ? `\n[${ents.length - MAX_LIST} more entries not shown; use glob to search]` : '';
        return { text: ents.slice(0, MAX_LIST).join('\n') + more || '(empty folder)', details: { path: shown, entries: ents.length } };
      }
      if (!st.isFile()) return { text: `${shown} is not a regular file (a device or pipe), so it is not read.`, isError: true };
      if (!st.size) {
        await remember(file); // seen: an empty file can be written over
        return { text: '(empty file)', details: { path: shown, totalLines: 0 } };
      }
      const head = Buffer.alloc(Math.min(st.size, 64));
      const fh = await fs.promises.open(file, 'r');
      try {
        await fh.read(head, 0, head.length, 0);
      } finally {
        await fh.close();
      }
      if (sniffImage(head)) {
        if (st.size > MAX_READ_BYTES) return { text: `${shown} is a ${formatBytes(st.size)} image, larger than the ${formatBytes(MAX_READ_BYTES)} limit for images.`, isError: true };
        await remember(file);
        return imageResult(file, shown, await fs.promises.readFile(file), hooks);
      }
      if (st.size > MAX_READ_BYTES) return { text: `${shown} is ${formatBytes(st.size)}, larger than the ${formatBytes(MAX_READ_BYTES)} read limit. Search it with grep, or show a part with bash (head, tail, sed -n 'A,Bp').`, isError: true };
      const dec = await readText(file);
      if (!dec) {
        const kind = head.toString('latin1', 0, 5) === '%PDF-' ? 'a PDF document' : head[0] === 0x50 && head[1] === 0x4b ? 'a ZIP archive (or docx/xlsx/jar)' : 'a binary file';
        return { text: `${shown} is ${kind} (${formatBytes(st.size)}), not text, so it cannot be shown. Inspect it with a command-line tool through bash if needed.`, isError: true };
      }
      await remember(file);
      const content = dec.text;
      const lines = (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n'); // a final newline ends the last line; it does not start another
      const start = Math.max(1, offset | 0 || 1);
      if (start > lines.length) return { text: `${shown} has ${lines.length} line${lines.length === 1 ? '' : 's'}; offset ${start} is past the end.`, isError: true, details: { path: shown, totalLines: lines.length } };
      const slice = lines.slice(start - 1, start - 1 + Math.max(1, limit | 0 || 2000));
      // Very long lines (minified code, data) and huge reads would flood the context, the UI and the session file.
      const out = [];
      let size = 0;
      let longLines = 0;
      for (let i = 0; i < slice.length && size < MAX_READ_CHARS; i++) {
        let l = slice[i].replace(/\r$/, '');
        if (l.length > MAX_LINE_CHARS) {
          l = l.slice(0, MAX_LINE_CHARS) + ` … [line cut: ${l.length} characters]`;
          longLines++;
        }
        const row = `${start + i}\t${l}`;
        out.push(row);
        size += row.length + 1;
      }
      let text = out.join('\n');
      const last = start + out.length - 1;
      if (last < lines.length) text += `\n[showing lines ${start}-${last} of ${lines.length}${out.length < slice.length ? ` (output limit of ${MAX_READ_CHARS} characters)` : ''}; pass offset=${last + 1} to continue]`;
      if (longLines) text += `\n[${longLines} long line${longLines === 1 ? '' : 's'} cut at ${MAX_LINE_CHARS} characters; use grep or bash to see more]`;
      if (dec.encoding !== 'utf-8') text += `\n[encoding: ${ENCODING_NAMES[dec.encoding]}; edit and write keep it]`;
      return { text, details: { path: shown, totalLines: lines.length, ...(dec.encoding !== 'utf-8' ? { encoding: dec.encoding } : {}) } };
    },

    async write({ path: p, content }) {
      const file = host(p);
      const shown = resolve(p);
      let old = null;
      let st = null;
      try {
        st = await fs.promises.stat(file);
      } catch {}
      if (st?.isDirectory()) return { text: `${shown} is a folder; give a file path.`, isError: true };
      if (st) {
        // Replacing a whole file the agent has not seen would rest on a guess of what is in it.
        if (!seen.has(file)) return { text: `${shown} already exists and you have not read it in this session. Read it first; then change it with edit, or write the complete new content.`, isError: true };
        if (seen.get(file) !== st.mtimeMs) return { text: `${shown} was changed on disk after you last read it (by the user or another program). Read it again, then write.`, isError: true };
        old = await readText(file).catch(() => null);
      }
      let text = content;
      const notes = [];
      if (old && lineEnding(old.text) === 'crlf' && text.includes('\n') && !text.includes('\r')) {
        text = text.replace(/\n/g, '\r\n');
        notes.push('CRLF line endings kept');
      }
      const enc = encodeText(text, old?.encoding);
      if (old && enc.encoding !== old.encoding) notes.push(`saved as UTF-8: the text has characters that ${ENCODING_NAMES[old.encoding]} cannot store`);
      else if (old && old.encoding !== 'utf-8') notes.push(`${ENCODING_NAMES[old.encoding]} kept`);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, enc.buf);
      await remember(file);
      // Undo restores the previous text, or removes a file that did not exist. An overwritten binary file has no text copy.
      const undo = st && !old ? { skipped: true } : makeUndo(shown, old ? old.text : null, enc.buf, old?.encoding);
      const details = { path: shown, ...(old ? makeDiff(old.text, text) : {}), undo };
      const lineCount = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
      const syntax = await syntaxNote(shown, text);
      return { text: `${st ? 'Overwrote' : 'Created'} ${shown} (${enc.buf.length} bytes, ${lineCount} line${lineCount === 1 ? '' : 's'})${notes.length ? `; ${notes.join('; ')}` : ''}${syntax}`, details: { ...details, ...(syntax ? { syntaxError: true } : {}) } };
    },

    async edit({ path: p, old_string: oldS, new_string: newS, replace_all: all }) {
      const file = host(p);
      const shown = resolve(p);
      if (oldS === '') return { text: 'old_string must not be empty (use write to create a file).', isError: true };
      if (oldS === newS) return { text: 'old_string and new_string are identical; nothing to change.', isError: true };
      const dec = await readText(file);
      if (!dec) return { text: `${shown} is not a text file, so it cannot be edited.`, isError: true };
      const text = dec.text;
      // The file's own line ending, by majority: one stray CRLF line must not turn new lines in an LF file into CRLF.
      const crlf = (text.match(/\r\n/g) || []).length * 2 > (text.match(/\n/g) || []).length;
      const toFile = (s) => (crlf && !s.includes('\r') ? s.replace(/\n/g, '\r\n') : s);
      let from = oldS;
      let to = newS;
      let at = occurrences(text, from);
      // An exact match on a CRLF file still writes the new text with the file's CRLF line ends (no mixed endings).
      if (at.length && crlf) to = toFile(newS);
      // `read` shows lines without their \r, so on a CRLF file match (and write) with CRLF line ends.
      if (!at.length && crlf && oldS.includes('\n') && !oldS.includes('\r')) {
        from = toFile(oldS);
        to = toFile(newS);
        at = occurrences(text, from);
      }
      const notes = [];
      // Text copied from read output with its "N<TAB>" prefixes.
      if (!at.length) {
        const bare = stripLineNumbers(oldS);
        if (bare && bare !== oldS) {
          const f2 = toFile(bare);
          const inFileEnds = occurrences(text, f2);
          const at2 = inFileEnds.length ? inFileEnds : occurrences(text, bare);
          if (at2.length) {
            from = inFileEnds.length ? f2 : bare;
            to = toFile(stripLineNumbers(newS) ?? newS);
            at = at2;
            notes.push('line-number prefixes removed from old_string');
          }
        }
      }
      let next;
      if (at.length > 1 && !all) return { text: `old_string matches ${at.length} places (lines ${listLines(at.map((i) => lineAt(text, i)))}). Add surrounding lines to make it unique, or set replace_all to change all of them.`, isError: true };
      if (at.length) {
        next = all ? text.split(from).join(to) : text.slice(0, at[0]) + to + text.slice(at[0] + from.length);
      } else {
        const { matches } = fuzzyLines(text, stripLineNumbers(oldS) ?? oldS);
        if (matches.length > 1) return { text: `old_string was not found exactly. Ignoring whitespace it matches ${matches.length} places (lines ${listLines(matches.map((m) => m.line))}); add surrounding lines to make it unique, copying the text exactly from a fresh read.`, isError: true };
        if (!matches.length) {
          const first = oldS.split('\n').map((l) => l.trim()).find((l) => l.length > 3);
          const hint = first ? occurrences(text, first).map((i) => lineAt(text, i)) : [];
          return { text: `old_string was not found in ${shown}. ${hint.length ? `Its first line appears at line ${listLines(hint)}, but the lines after it differ. ` : ''}Read the file again and copy the exact current text (whitespace matters).`, isError: true };
        }
        // A whitespace-tolerant match rewrites lines that were not quoted exactly, so it is only applied to text the
        // agent has actually seen: a file it read (or wrote) in this session that has not changed since.
        const mtime = await fs.promises.stat(file).then((s) => s.mtimeMs, () => null);
        if (!seen.has(file) || seen.get(file) !== mtime) {
          return { text: `old_string was not found exactly in ${shown}; it matches line ${matches[0].line} only when whitespace is ignored, and ${seen.has(file) ? 'the file changed after you last read it' : 'you have not read this file in this session'}. Read it, then copy the exact current text into old_string.`, isError: true };
        }
        const m = matches[0];
        let repl = (stripLineNumbers(newS) ?? newS).replace(/\r\n/g, '\n');
        repl = reindent(repl, m.oldIndent, m.indent);
        // The match covers whole lines without their final line break.
        if (oldS.replace(/\r\n/g, '\n').endsWith('\n') && repl.endsWith('\n')) repl = repl.slice(0, -1);
        next = text.slice(0, m.start) + toFile(repl) + text.slice(m.end);
        notes.push(`matched at line ${m.line} ignoring whitespace differences${m.indent !== m.oldIndent ? '; new text re-indented' : ''}`);
      }
      const enc = encodeText(next, dec.encoding);
      await fs.promises.writeFile(file, enc.buf);
      await remember(file);
      const d = makeDiff(text, next);
      const where = d.firstChangedLine === d.lastChangedLine ? `line ${d.firstChangedLine}` : `lines ${d.firstChangedLine}-${d.lastChangedLine}`;
      const count = all && at.length > 1 ? ` (${at.length} replacements)` : '';
      if (enc.encoding !== dec.encoding) notes.push(`saved as UTF-8: the text has characters that ${ENCODING_NAMES[dec.encoding]} cannot store`);
      // A whitespace-tolerant match changed text the model did not quote exactly: show it so it can be checked.
      const shownDiff = at.length ? '' : `\n${clipLines(d.diff, 40)}`;
      const syntax = await syntaxNote(shown, next);
      return { text: `Edited ${shown}${count}: ${where}${notes.length ? `; ${notes.join('; ')}` : ''}${shownDiff}${syntax}`, details: { path: shown, op: 'update', ...d, undo: makeUndo(shown, text, enc.buf, dec.encoding), ...(syntax ? { syntaxError: true } : {}) } };
    },

    async bash({ command, timeout = 120, shell }, { onUpdate } = {}) {
      if (!command.trim()) return { text: 'command is empty.', isError: true };
      const secs = Math.min(600, Math.max(1, timeout | 0 || 120));
      const useShell = !backend.isWsl && shell === 'powershell' ? 'powershell' : backend.isWsl ? 'bash' : 'cmd';
      // cmd.exe stops at the first line break and reports success, so the other lines would silently never run.
      if (useShell === 'cmd' && /[\r\n]/.test(command.trim())) {
        return { text: 'cmd runs only the first line of a multi-line command, so nothing was run. Join the steps on one line with && (stop at the first failure) or & (run all), or set shell to "powershell" to run a multi-line script.', isError: true };
      }
      const t0 = Date.now();
      const child = backend.spawnShell(command, { cwd, ...(useShell === 'powershell' ? { shell: 'powershell' } : {}) });
      let head = '';
      let tail = '';
      let total = 0;
      let totalLines = 0;
      let dropped = false;
      let last = 0;
      const push = (d) => {
        total += d.length;
        totalLines += countLines(d);
        if (head.length < HEAD) {
          const room = HEAD - head.length;
          head += d.slice(0, room);
          d = d.slice(room);
        }
        if (d) {
          tail += d;
          if (tail.length > (MAX_OUTPUT - HEAD) * 2) {
            tail = tail.slice(-(MAX_OUTPUT - HEAD));
            dropped = true;
          }
        }
        const now = Date.now();
        if (onUpdate && now - last > 150) {
          last = now;
          onUpdate(cleanTerminal(dropped || head.length + tail.length > MAX_OUTPUT ? tail.slice(-MAX_OUTPUT) : head + tail, SGR_ON));
        }
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', push);
      child.stderr.on('data', push);
      let timedOut = false;
      let aborted = false;
      // A process the command left running in the background can keep the pipes open: once killed, stop waiting.
      let release = null;
      const kill = () => {
        killTree(child);
        setTimeout(() => release?.(), 3000).unref?.();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, secs * 1000);
      const sig = getSignal();
      const onAbort = () => {
        aborted = true;
        kill();
      };
      if (sig?.aborted) onAbort();
      else sig?.addEventListener('abort', onAbort, { once: true });
      child.stdin.on('error', () => {});
      child.stdin.end();
      const code = await new Promise((res) => {
        child.on('error', () => res(-1));
        child.on('close', (c) => res(c ?? -1));
        // The shell is done but something it started in the background still holds its output open.
        child.on('exit', () => setTimeout(() => release?.(), 2000).unref?.());
        release = () => {
          child.stdout.destroy();
          child.stderr.destroy();
          res(child.exitCode ?? -1);
        };
      });
      clearTimeout(timer);
      sig?.removeEventListener('abort', onAbort);
      const durationMs = Date.now() - t0;
      let text;
      let truncated = false;
      if (looksBinaryText(head + tail)) text = `[binary output: ${total} characters not shown; redirect it to a file or pipe it through a converter]\n`;
      else if (!dropped && head.length + tail.length <= MAX_OUTPUT) text = cleanTerminal(head + tail, SGR_ON);
      else {
        truncated = true;
        // Cut on line boundaries: the start (often the first error) and the end (summary, last error).
        const h = head.lastIndexOf('\n') > HEAD / 2 ? head.slice(0, head.lastIndexOf('\n') + 1) : head;
        let t = tail.slice(-(MAX_OUTPUT - HEAD));
        const nl = t.indexOf('\n');
        if (nl >= 0 && nl < t.length / 2) t = t.slice(nl + 1);
        const omitted = total - h.length - t.length;
        const lines = Math.max(0, totalLines - countLines(h) - countLines(t));
        text = `${cleanTerminal(h, SGR_ON)}${h.endsWith('\n') ? '' : '\n'}[… ${lines} lines (${omitted} characters) omitted; filter the output or redirect it to a file to see them …]\n${cleanTerminal(t, SGR_ON)}`;
      }
      if (text && !text.endsWith('\n')) text += '\n';
      const took = fmtDuration(durationMs);
      if (timedOut) text += `[stopped: exceeded the ${secs}s timeout; pass a larger timeout (max 600) or run it in the background]`;
      else if (aborted) text += '[stopped by the user]';
      else text += `[exit code ${code} · ${took}]`;
      return { text, details: { exitCode: code, timedOut, aborted, durationMs, wallTimeMs: durationMs, truncated, shell: useShell }, isError: code !== 0 || timedOut };
    },

    async web_fetch(input, { allowHost, signal, vision } = {}) {
      return webFetch(input, { signal: signal || getSignal(), allowHost, vision });
    },

    async web_search(input, { search, signal } = {}) {
      const cfg = await search?.();
      if (!cfg) return { text: 'Web search is not set up. The user can add a search service in Settings → Tools & MCP.', isError: true };
      return webSearch(input, cfg, { signal: signal || getSignal() });
    },

    async todo({ todos }) {
      const ok = new Set(['pending', 'in_progress', 'completed']);
      const tasks = todos.filter((t) => t && typeof t.content === 'string' && t.content.trim()).map((t) => ({ content: t.content.trim(), status: ok.has(t.status) ? t.status : 'pending' }));
      const done = tasks.filter((t) => t.status === 'completed').length;
      const now = tasks.find((t) => t.status === 'in_progress');
      return { text: `Task list updated: ${done}/${tasks.length} done.${now ? ` In progress: ${now.content}` : ''}`, details: { phases: [{ name: 'Plan', tasks }] } };
    },

    async glob({ pattern, path: p }, hooks = {}) {
      const base = host(p || '.');
      const st = await fs.promises.stat(base).catch(() => null);
      if (!st) return { text: `No such folder: ${p}.${await suggest(p)}`, isError: true };
      if (!st.isDirectory()) return { text: `${resolve(p)} is a file, not a folder. Pass its folder as path.`, isError: true };
      const r = await globFiles({ hostRoot: base, pattern, limit: 300, backend, signal: hooks.signal || getSignal() });
      if (!r.files.length) return { text: r.capped ? `No files matched in the first ${MAX_WALK_FILES} files; search a narrower path.` : 'No files matched.', details: { total: 0 } };
      const notes = [];
      if (r.total > r.files.length) notes.push(`[showing ${r.files.length} of ${r.total} files; use a narrower pattern or path]`);
      if (r.capped) notes.push(`[search stopped after ${MAX_WALK_FILES} files; search a narrower path]`);
      return { text: [r.files.join('\n'), ...notes].join('\n'), details: { total: r.total, engine: r.engine } };
    },

    async grep({ pattern, path: p, glob, ignore_case: ic, output_mode: mode = 'content', context = 0, limit = 200 }, hooks = {}) {
      let regex;
      try {
        regex = new RegExp(pattern, ic ? 'i' : '');
      } catch (e) {
        return { text: `Invalid regular expression: ${e.message}. Escape literal characters such as . ( ) [ ] { } + * ? with a backslash.`, isError: true };
      }
      const base = host(p || '.');
      const st = await fs.promises.stat(base);
      const cap = Math.min(2000, Math.max(1, limit | 0 || 200));
      const ctx = mode === 'content' ? Math.min(10, Math.max(0, context | 0)) : 0;
      const r = await grepFiles({ hostRoot: base, single: st.isFile(), regex, glob, context: ctx, limit: mode === 'content' ? cap : 1e9, backend, signal: hooks.signal || getSignal() });
      if (!r.total) return { text: `No matches.${r.skippedLarge ? ` (${r.skippedLarge} file${r.skippedLarge === 1 ? '' : 's'} over ${formatBytes(MAX_GREP_BYTES)} not searched)` : ''}`, details: { total: 0, files: 0 } };
      const out = [];
      let shown = 0;
      if (mode === 'files' || mode === 'count') {
        for (const [f, n] of r.counts) {
          if (shown >= cap) break;
          out.push(mode === 'count' ? `${f}: ${n}` : f);
          shown++;
        }
      } else {
        let prev = null;
        for (const hit of r.hits) {
          if (ctx && prev && (prev.file !== hit.file || hit.line > prev.line + 1)) out.push('--');
          out.push(`${hit.file}${hit.match ? ':' : '-'}${hit.line}${hit.match ? ':' : '-'} ${hit.text}`);
          if (hit.match) shown++;
          prev = hit;
        }
      }
      const more = r.overflow ? '+' : '';
      const unit = mode === 'content' ? 'matching lines' : 'files';
      const all = mode === 'content' ? r.total : r.files;
      if (shown < all || r.overflow) out.push(`[showing ${shown} of ${all}${more} ${unit}${mode === 'content' ? ` in ${r.files}${more} files` : ''}; narrow the pattern, path or glob, or raise limit]`);
      if (r.skippedLarge) out.push(`[${r.skippedLarge} file${r.skippedLarge === 1 ? '' : 's'} over ${formatBytes(MAX_GREP_BYTES)} not searched]`);
      if (r.capped) out.push(`[search stopped after ${MAX_WALK_FILES} files; search a narrower path]`);
      return { text: out.join('\n'), details: { total: r.total, files: r.files, engine: r.engine } };
    },
  };

  const defs = new Map(toolDefsFor(backend).map((d) => [d.name, d]));

  return {
    /** Revert one recorded change. Refuses if the file was modified by someone else since. */
    async undo(u) {
      if (!u || u.skipped) return { ok: false, text: 'This change was too large to keep a copy of, so it cannot be undone automatically.' };
      const file = host(u.path);
      let cur = null;
      try {
        cur = await fs.promises.readFile(file);
      } catch {}
      if (cur !== null && sha1(cur) !== u.afterHash) return { ok: false, text: `${u.path} was changed after the agent edited it, so it was not reverted. Undo it by hand if you want it.` };
      if (u.before === null) {
        if (cur !== null) await fs.promises.rm(file);
        seen.delete(file);
        return { ok: true, text: `Removed ${u.path} (it did not exist before).` };
      }
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, encodeText(u.before, u.encoding || 'utf-8').buf);
      await remember(file);
      return { ok: true, text: `Restored ${u.path}` };
    },

    /** Whether a path the model gave is inside the project folder (compared as Windows paths, ignoring case). */
    inProject(p) {
      let file;
      try {
        file = path.win32.resolve(host(p)).toLowerCase();
      } catch {
        return true; // no usable path: the tool itself reports the error
      }
      const root = path.win32.resolve(backend.hostPath(cwd)).toLowerCase();
      return file === root || file.startsWith(root.endsWith('\\') ? root : `${root}\\`);
    },

    /**
     * What changed in a file since a recorded checkpoint: { path, diff, added, removed }, or null when nothing did
     * or the file cannot be read as text. `u.before` null means the file was created.
     */
    async diffSince(u) {
      if (!u || u.skipped) return null;
      let now = '';
      try {
        const r = await readText(host(u.path));
        if (!r) return null;
        now = r.text;
      } catch (e) {
        if (e.code !== 'ENOENT') return null;
      }
      const before = u.before ?? '';
      if (before === now) return null;
      const d = makeDiff(before.replace(/\r\n/g, '\n'), now.replace(/\r\n/g, '\n'));
      let added = 0;
      let removed = 0;
      for (const l of d.diff.split('\n')) {
        if (l[0] === '+') added++;
        else if (l[0] === '-') removed++;
      }
      return { path: u.path, diff: d.diff, added, removed, created: u.before == null };
    },

    /** Run a tool. `hooks`: { onUpdate(text), allowHost(host), signal, vision }. */
    async run(name, input, hooks = {}) {
      const fn = Object.hasOwn(impl, name) ? impl[name] : undefined; // not impl["constructor"] and friends
      const def = defs.get(name);
      if (!fn || !def) return { text: `Unknown tool "${name}". Available: ${[...defs.keys()].filter((n) => n !== 'task' && Object.hasOwn(impl, n)).join(', ')}.`, isError: true };
      const checked = checkArgs(def, input ?? {});
      if (checked.error) return { text: checked.error, isError: true };
      try {
        return await fn(checked.args, hooks);
      } catch (e) {
        const p = checked.args?.path ?? '';
        if (e.code === 'ENOENT') return { text: `No such file or folder: ${p}.${await suggest(p)}${name === 'edit' ? ' To create a new file, use write.' : ''}`, isError: true };
        if (e.code === 'EACCES' || e.code === 'EPERM') return { text: `Permission denied: ${p}. The file may be read-only or open in another program.`, isError: true };
        if (e.code === 'EISDIR') return { text: `${p} is a folder; give a file path.`, isError: true };
        if (e.code === 'EBUSY') return { text: `${p} is locked by another program; close it and try again.`, isError: true };
        return { text: e.message, isError: true };
      }
    },
  };
}
