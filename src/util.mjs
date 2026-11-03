// Small shared helpers. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

export function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); // Notepad and PowerShell 5 write a BOM
  } catch {
    return fallback;
  }
}

/** Atomic write: temp file + rename, so a crash never leaves a half-written config. */
export function writeJson(file, value) {
  mkdirp(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function uid(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

// Server log: data/logs/server.log, capped at LOG_MAX bytes. When full it moves to server.log.1 (one old copy).
const LOG_MAX = 1024 * 1024;
let logFile = null;
let logSize = 0;
export function initLog(file) {
  try {
    mkdirp(path.dirname(file));
    logFile = file;
    try {
      logSize = fs.statSync(file).size;
    } catch {
      logSize = 0;
    }
    if (logSize > LOG_MAX) rotateLog();
  } catch {
    logFile = null;
  }
}
function rotateLog() {
  try {
    fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    try {
      fs.writeFileSync(logFile, '');
    } catch {}
  }
  logSize = 0;
}
export function log(...a) {
  const line = `${new Date().toISOString()} ${a
    .map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.stack || x.message : JSON.stringify(x)))
    .join(' ')}\n`;
  if (logFile) {
    try {
      if (logSize + line.length > LOG_MAX) rotateLog();
      fs.appendFileSync(logFile, line);
      logSize += Buffer.byteLength(line);
    } catch {}
  }
  if (process.env.ORBIX_DEBUG) process.stderr.write(line);
}

/** Run `fn` over `items` with at most `n` in flight. Results keep their order; a failed item becomes null. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]).catch(() => null);
      }
    }),
  );
  return out;
}

/** Plain text of a message's content (a string, or the text parts of a content array joined with `sep`). */
export function textOf(content, sep = ' ') {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join(sep);
}

/** A NUL byte in the first 8 KiB: treat the file as binary. */
export const looksBinary = (buf) => buf.subarray(0, Math.min(buf.length, 8192)).includes(0);

export function clip(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape text for HTML element content and quoted attributes. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** First `bytes` bytes of a file as UTF-8 (the tail may cut a multi-byte character; fine for sniffing headers). */
export async function readHead(file, bytes) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/**
 * A short, plain session title from free text: first sentence, no emoji/markdown/code, no "please / can you"
 * filler, at most `max` characters cut on a word boundary. Same rule on the server and in the UI.
 */
export function makeTitle(text, max = 48) {
  let t = String(text || '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[`*_#>]|\[|\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.split(/(?<=[.!?])\s/)[0] || t;
  const whole = t;
  for (let i = 0; i < 6; i++) t = t.replace(/^(please|pls|hey|hi|hello|ok|okay|so|now|can you|could you|would you|will you|i want you to|i need you to|i want to|help me|let's|lets)\b[\s,:;-]*/i, '');
  if (!t.replace(/[\s.!?,:;-]/g, '')) t = whole; // only filler ("hi"): keep it as typed
  t = t.replace(/[\s.!?,:;-]+$/, '');
  if (t.length > max) {
    t = t.slice(0, max);
    const cut = t.lastIndexOf(' ');
    if (cut > max * 0.55) t = t.slice(0, cut);
    t = t.replace(/[\s.,:;-]+$/, '') + '…';
  }
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}
