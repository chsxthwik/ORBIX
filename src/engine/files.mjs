// File and terminal text helpers shared by the agent's tools, @mentions and attachments:
// text decoding with encoding detection (BOM, UTF-8, Windows-1252), encoding back on write, image sniffing,
// terminal output cleanup and a small mtime-checked read cache.
import fs from 'node:fs';
import { looksBinary } from '../util.mjs';

// ---------- text encodings ----------
const CP1252 = { 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178 };
const CP1252_BACK = new Map(Object.entries(CP1252).map(([b, cp]) => [cp, +b]));

function decode1252(buf) {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(CP1252[buf[i]] ?? buf[i]);
  return s;
}

function swap16(buf) {
  const b = Buffer.from(buf.subarray(0, buf.length - (buf.length % 2)));
  return b.swap16();
}

/**
 * Decode file bytes. Returns { text, encoding } or null for binary data. `encoding` is one of
 * 'utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'windows-1252'. `partial` means the buffer may end mid-character.
 */
export function decodeText(buf, { partial = false } = {}) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2, buf.length - ((buf.length - 2) % 2)).toString('utf16le'), encoding: 'utf-16le' };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { text: swap16(buf.subarray(2)).toString('utf16le'), encoding: 'utf-16be' };
  if (looksBinary(buf)) return null;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: partial }), encoding: 'utf-8' };
  } catch {
    return { text: decode1252(buf), encoding: 'windows-1252' };
  }
}

/** Encode text for writing in `encoding` (as returned by decodeText). Returns { buf, encoding } (UTF-8 when it cannot be kept). */
export function encodeText(text, encoding = 'utf-8') {
  switch (encoding) {
    case 'utf-8-bom':
      return { buf: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]), encoding };
    case 'utf-16le':
      return { buf: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]), encoding };
    case 'utf-16be':
      return { buf: Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]), encoding };
    case 'windows-1252': {
      const out = Buffer.alloc(text.length);
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        const b = c < 0x80 || (c >= 0xa0 && c <= 0xff) ? c : CP1252_BACK.get(c);
        if (b === undefined) return { buf: Buffer.from(text, 'utf8'), encoding: 'utf-8' }; // not representable: keep the text, change the encoding
        out[i] = b;
      }
      return { buf: out, encoding };
    }
    default:
      return { buf: Buffer.from(text, 'utf8'), encoding: 'utf-8' };
  }
}

export const ENCODING_NAMES = { 'utf-8': 'UTF-8', 'utf-8-bom': 'UTF-8 with BOM', 'utf-16le': 'UTF-16 LE', 'utf-16be': 'UTF-16 BE', 'windows-1252': 'Windows-1252' };

/** 'crlf' when every line break is CRLF, 'lf' when none is, else 'mixed'. */
export function lineEnding(text) {
  const lf = (text.match(/\n/g) || []).length;
  if (!lf) return 'lf';
  const crlf = (text.match(/\r\n/g) || []).length;
  return crlf === lf ? 'crlf' : crlf === 0 ? 'lf' : 'mixed';
}

// ---------- images ----------
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Largest image a provider accepts (Anthropic: 5 MB per image; OpenAI allows more). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Images with a longer edge than this are downscaled by the provider (Claude); 8000 px is the hard limit. */
export const IMAGE_SCALE_EDGE = 1568;
export const IMAGE_MAX_EDGE = 8000;

/** { mimeType, width, height } of a PNG / JPEG / GIF / WebP from its bytes, or null when it is none of them. */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return { mimeType: 'image/png', width: buf.length >= 24 ? buf.readUInt32BE(16) : 0, height: buf.length >= 24 ? buf.readUInt32BE(20) : 0 };
  if (buf.toString('latin1', 0, 4) === 'GIF8') return { mimeType: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buf.toString('latin1', 12, 16);
    let width = 0;
    let height = 0;
    if (kind === 'VP8 ' && buf.length >= 30) {
      width = buf.readUInt16LE(26) & 0x3fff;
      height = buf.readUInt16LE(28) & 0x3fff;
    } else if (kind === 'VP8L' && buf.length >= 25) {
      const b = buf.subarray(21, 25);
      width = 1 + (b[0] | ((b[1] & 0x3f) << 8));
      height = 1 + ((b[1] >> 6) | (b[2] << 2) | ((b[3] & 0x0f) << 10));
    } else if (kind === 'VP8X' && buf.length >= 30) {
      width = 1 + buf.readUIntLE(24, 3);
      height = 1 + buf.readUIntLE(27, 3);
    }
    return { mimeType: 'image/webp', width, height };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let width = 0;
    let height = 0;
    for (let i = 2; i + 9 < buf.length; ) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        height = buf.readUInt16BE(i + 5);
        width = buf.readUInt16BE(i + 7);
        break;
      }
      i += 2 + len;
    }
    return { mimeType: 'image/jpeg', width, height };
  }
  return null;
}

const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export const formatBytes = kb;

/**
 * Check image bytes for sending to a model. Returns { ok, image: {type, data, mimeType}, note } or { ok: false, note }.
 * `note` is a one-line description (size, pixels, downscale advice) for the model and the user.
 */
export function prepareImage(buf, { label = 'image', declaredType } = {}) {
  const info = sniffImage(buf);
  if (!info) return { ok: false, note: `${label} is not a PNG, JPEG, GIF or WebP image${declaredType ? ` (${declaredType})` : ''}, so it was not sent.` };
  const dims = info.width && info.height ? `${info.width}x${info.height} px` : 'unknown size';
  const desc = `${label} (${info.mimeType.slice(6).toUpperCase()}, ${dims}, ${kb(buf.length)})`;
  if (buf.length > MAX_IMAGE_BYTES) return { ok: false, note: `${desc} is larger than the ${kb(MAX_IMAGE_BYTES)} limit for images, so it was not sent. Save it smaller (or as JPEG) and attach it again.` };
  if (Math.max(info.width, info.height) > IMAGE_MAX_EDGE) return { ok: false, note: `${desc} is larger than ${IMAGE_MAX_EDGE} px on a side, so it was not sent. Resize it and attach it again.` };
  const scaled = Math.max(info.width, info.height) > IMAGE_SCALE_EDGE ? ` The model sees it downscaled to about ${IMAGE_SCALE_EDGE} px on the long edge, so small text may be unreadable.` : '';
  return { ok: true, image: { type: 'image', data: buf.toString('base64'), mimeType: info.mimeType }, note: desc + '.' + scaled, info };
}

/** Bytes of a base64 string or data: URL (whitespace tolerated). null when it is not valid base64. */
export function base64Bytes(data) {
  let s = String(data || '');
  const m = /^data:[^;,]*(?:;[^,]*)?,/.exec(s);
  if (m) s = s.slice(m[0].length);
  s = s.replace(/\s+/g, '');
  if (!s || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(s)) return null;
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// ---------- terminal output ----------
// CSI (colors, cursor moves), OSC (titles, hyperlinks) and two-byte escapes.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*\x1b\\|[@-Z\\-_])|\x9b[0-?]*[ -/]*[@-~]/g;

const SGR = /^\x1b\[[0-9;:]*m$/;

/** Remove ANSI escape sequences; with `keepSgr`, colour/style codes (ESC[...m) stay and everything else goes. */
export const stripAnsi = (s, { keepSgr = false } = {}) => String(s).replace(ANSI, (m) => (keepSgr && SGR.test(m) ? m : ''));

/** Remove only the colour/style codes (what is left after cleanTerminal(s, { keepSgr: true })). */
export const stripSgr = (s) => String(s).replace(/\x1b\[[0-9;:]*m/g, '');

/**
 * Terminal output as a person would read it: no ANSI codes (with `keepSgr`, colour codes stay for the UI), CRLF -> LF,
 * a carriage-return redraw (progress bars) keeps only its final state, backspaces applied, other control characters dropped.
 */
export function cleanTerminal(s, { keepSgr = false } = {}) {
  let t = stripAnsi(s, { keepSgr }).replace(/\r+\n/g, '\n');
  if (t.includes('\r')) {
    t = t
      .split('\n')
      .map((line) => {
        if (!line.includes('\r')) return line;
        const parts = line.split('\r');
        for (let i = parts.length - 1; i >= 0; i--) if (parts[i]) return parts[i];
        return '';
      })
      .join('\n');
  }
  if (t.includes('\x08')) {
    let prev;
    do {
      prev = t;
      t = t.replace(/[^\n\x08]\x08/g, '');
    } while (t !== prev);
    t = t.replace(/\x08/g, '');
  }
  return t.replace(keepSgr ? /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]|\x1b(?!\[[0-9;:]*m)/g : /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** True when decoded output is mostly not text (a binary file printed to the terminal). */
export function looksBinaryText(s) {
  if (!s) return false;
  const sample = s.length > 65536 ? s.slice(0, 32768) + s.slice(-32768) : s;
  const bad = (sample.match(/[\x00�]/g) || []).length;
  return bad > 16 && bad / sample.length > 0.02;
}

// ---------- cached reads ----------
const textCache = new Map(); // host path -> { mtimeMs, size, value }
const MAX_CACHE = 256;

/**
 * Read a small text file, reusing the last result while its mtime and size are unchanged (AGENTS.md, SKILL.md,
 * command files are read for every prompt). Returns null when it does not exist. `bytes` limits the read.
 */
export async function cachedText(file, bytes = 256 * 1024) {
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch {
    textCache.delete(file);
    return null;
  }
  if (!st.isFile()) return null;
  const hit = textCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.bytes === bytes) return hit.value;
  const fh = await fs.promises.open(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(Math.min(bytes, st.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    buf = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  const dec = decodeText(buf, { partial: st.size > buf.length });
  const value = dec ? dec.text : '';
  if (textCache.size >= MAX_CACHE) textCache.delete(textCache.keys().next().value);
  textCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, bytes, value });
  return value;
}
