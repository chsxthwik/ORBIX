// A syntax check right after the agent writes or edits a file: JSON is parsed, JavaScript is compiled (never run).
// The result is appended to the tool's answer, so a broken bracket is fixed in the next step instead of surfacing
// later as a confusing test failure. It only ever adds a note; the write itself has already happened.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_BYTES = 512 * 1024;
const JS = new Set(['.js', '.mjs', '.cjs']);
// JSON files that are allowed comments and trailing commas by the tools that read them.
const JSONC = /(^|[\\/])(tsconfig|jsconfig)[^\\/]*\.json$|(^|[\\/])\.(vscode|devcontainer)[\\/]|\.(jsonc|json5)$/i;

/** "line 3, column 7" for a character offset in `text`. */
function where(text, at) {
  const before = text.slice(0, at);
  const line = before.split('\n').length;
  return `line ${line}, column ${at - before.lastIndexOf('\n')}`;
}

/** null when `text` is valid JSON, else what is wrong and where. */
export function checkJson(text) {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!body.trim()) return null; // an empty file is a choice, not a typo
  try {
    JSON.parse(body);
    return null;
  } catch (e) {
    const msg = String(e.message || e);
    const pos = /position (\d+)/.exec(msg);
    const lc = /line (\d+) column (\d+)/.exec(msg);
    const at = lc ? `line ${lc[1]}, column ${lc[2]}` : pos ? where(body, Number(pos[1])) : '';
    return `${msg.replace(/\s*\(line \d+ column \d+\)/, '').replace(/ in JSON at position \d+/, '').replace(/^JSON\.parse: /, '')}${at ? ` (${at})` : ''}`;
  }
}

/** Compile a JavaScript file with this runtime's own parser (`node --check`); resolves null when it parses. */
export function checkJs(text, ext, { timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `orbix-syntax-${crypto.randomBytes(6).toString('hex')}${ext}`);
    const done = (v) => {
      fs.promises.unlink(tmp).catch(() => {});
      resolve(v);
    };
    fs.promises.writeFile(tmp, text).then(() => {
      let err = '';
      let child;
      try {
        // In the Windows app the runtime is ORBIX.exe; this variable makes it behave as plain Node for this one call.
        child = spawn(process.execPath, ['--check', tmp], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      } catch {
        return done(null);
      }
      const timer = setTimeout(() => child.kill(), timeout);
      child.stderr.on('data', (d) => (err.length < 8000 ? (err += d) : null));
      child.on('error', () => (clearTimeout(timer), done(null)));
      child.on('close', (code) => {
        clearTimeout(timer);
        const m = /^SyntaxError: (.+)$/m.exec(err);
        if (!code || !m) return done(null);
        // JSX and type annotations are not JavaScript to this parser, but they are not mistakes either.
        if (/Unexpected token '<'|Unexpected token ':'|Unexpected identifier '(type|interface|as|enum|declare)'/.test(m[1])) return done(null);
        const line = new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+)').exec(err);
        done(`${m[1]}${line ? ` (line ${line[1]})` : ''}`);
      });
    }, () => resolve(null));
  });
}

/**
 * A sentence for the tool result when the text just written to `file` does not parse, else ''.
 * Never throws and never blocks for long: any trouble running the check means no note.
 */
export async function syntaxNote(file, text) {
  try {
    if (typeof text !== 'string' || !text || Buffer.byteLength(text) > MAX_BYTES) return '';
    const ext = path.extname(file).toLowerCase();
    let problem = null;
    if (ext === '.json' && !JSONC.test(file)) problem = checkJson(text);
    else if (JS.has(ext)) problem = await checkJs(text, ext);
    return problem ? `\nSyntax check: this file does not parse now: ${problem}. Fix it before going on.` : '';
  } catch {
    return '';
  }
}
