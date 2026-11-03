// Project context for the ORBIX agent: instruction files (AGENTS.md / CLAUDE.md, found by walking up from the
// project folder to the repo root, as most coding agents do), files and folders attached to a prompt with @path,
// and files the UI attaches to a prompt (pasted text, text files, images).
import fs from 'node:fs';
import path from 'node:path';
import { isWinPath } from '../backend.mjs';
import { cachedText, decodeText, prepareImage, sniffImage, base64Bytes, formatBytes } from './files.mjs';
import { SKIP_DIRS } from './search.mjs';

const MENTION_FILE_CAP = 100 * 1024;
const MENTION_TOTAL_CAP = 300 * 1024;
const MAX_MENTIONS = 10;
const FOLDER_ENTRIES = 300;

const NAMES = ['AGENTS.md', 'CLAUDE.md', path.join('.omp', 'AGENTS.md')];
const CAP = 24000;

/** Instruction files from the project folder up to its repository root, nearest first (reads are mtime-cached). */
export async function loadInstructions(backend, workspace) {
  const found = [];
  let dir = path.resolve(backend.hostPath(workspace));
  let total = 0;
  for (let i = 0; i < 8; i++) {
    const texts = await Promise.all(NAMES.map((name) => cachedText(path.join(dir, name), CAP * 4).catch(() => null)));
    NAMES.forEach((name, k) => {
      const text = (texts[k] || '').trim();
      if (!text || total >= CAP) return;
      const clipped = text.slice(0, CAP - total);
      total += clipped.length;
      found.push({ path: path.join(dir, name), text: clipped, truncated: clipped.length < text.length });
    });
    let isRepoRoot = false;
    try {
      isRepoRoot = fs.existsSync(path.join(dir, '.git'));
    } catch {}
    const parent = path.dirname(dir);
    if (isRepoRoot || parent === dir) break;
    dir = parent;
  }
  return found;
}

/** One-level listing of a folder for an @mention: folders first (with /), then files with sizes. */
async function folderListing(host) {
  const ents = (await fs.promises.readdir(host, { withFileTypes: true })).filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)));
  const dirs = ents.filter((e) => e.isDirectory()).map((e) => e.name + '/').sort();
  const files = ents.filter((e) => !e.isDirectory()).map((e) => e.name).sort();
  const shown = [...dirs, ...files].slice(0, FOLDER_ENTRIES);
  const rows = await Promise.all(
    shown.map(async (n) => {
      if (n.endsWith('/')) return n;
      const st = await fs.promises.stat(path.join(host, n)).catch(() => null);
      return st ? `${n}  (${formatBytes(st.size)})` : n;
    }),
  );
  const more = dirs.length + files.length - shown.length;
  return `(folder listing: ${dirs.length} folder${dirs.length === 1 ? '' : 's'}, ${files.length} file${files.length === 1 ? '' : 's'})\n${rows.join('\n') || '(empty folder)'}${more > 0 ? `\n… ${more} more` : ''}`;
}

/**
 * `@path` in a prompt attaches that file, a folder listing, or (for PNG/JPEG/GIF/WebP) the image itself.
 * Returns [{ path, text, truncated? } | { path, image, text }]. Unknown paths and e-mail addresses are left alone.
 */
export async function readMentions(backend, workspace, text) {
  const out = [];
  let total = 0;
  const seen = new Set();
  const re = /(?:^|[\s(])@("[^"]+"|[^\s"'`()<>]+)/g;
  let m;
  while ((m = re.exec(text)) && out.length < MAX_MENTIONS) {
    const raw = m[1].replace(/^"|"$/g, '').replace(/[.,;:!?)\]]+$/, '');
    if (!raw || seen.has(raw) || /^[\w.-]+@/.test(raw)) continue;
    seen.add(raw);
    const abs = isWinPath(raw) || raw.startsWith('/') ? raw : isWinPath(workspace) ? path.win32.resolve(workspace, raw) : path.posix.resolve(workspace, raw);
    const host = backend.hostPath(abs);
    let st;
    try {
      st = await fs.promises.stat(host);
    } catch {
      continue;
    }
    try {
      if (st.isDirectory()) {
        const t = await folderListing(host);
        total += t.length;
        out.push({ path: raw, text: t });
        continue;
      }
      if (!st.isFile()) continue;
      const fd = await fs.promises.open(host, 'r');
      let buf;
      try {
        const headBuf = Buffer.alloc(Math.min(64, st.size));
        await fd.read(headBuf, 0, headBuf.length, 0);
        if (sniffImage(headBuf)) {
          buf = Buffer.alloc(Math.min(st.size, 6 * 1024 * 1024));
          await fd.read(buf, 0, buf.length, 0);
        } else {
          const room = Math.min(MENTION_FILE_CAP, MENTION_TOTAL_CAP - total);
          if (room <= 0) break;
          buf = Buffer.alloc(Math.min(room, st.size));
          await fd.read(buf, 0, buf.length, 0);
        }
      } finally {
        await fd.close();
      }
      if (sniffImage(buf)) {
        const prep = st.size > buf.length ? { ok: false, note: `${raw} is an image larger than the limit, so it was not attached.` } : prepareImage(buf, { label: raw });
        out.push(prep.ok ? { path: raw, image: prep.image, text: prep.note } : { path: raw, text: `(${prep.note})` });
        continue;
      }
      const dec = decodeText(buf, { partial: st.size > buf.length });
      if (!dec) {
        out.push({ path: raw, text: `(binary file, ${formatBytes(st.size)}, not attached)` });
        continue;
      }
      total += dec.text.length;
      out.push({ path: raw, text: dec.text, truncated: st.size > buf.length });
    } catch {}
  }
  return out;
}

/**
 * Files the UI attached to a prompt: `[{ name, text }]` (pasted text, text files) or `[{ name, data, mimeType }]`
 * (base64; images are sent as images, text files are decoded). Returns { attachments, images, notes }.
 */
export function promptAttachments(list) {
  const attachments = [];
  const images = [];
  const notes = [];
  let total = 0;
  for (const [i, a] of (Array.isArray(list) ? list : []).slice(0, 20).entries()) {
    if (!a || typeof a !== 'object') continue;
    const name = String(a.name || a.path || `attachment-${i + 1}`).slice(0, 200);
    let text = typeof a.text === 'string' ? a.text : null;
    if (text == null && a.data != null) {
      const buf = base64Bytes(a.data);
      if (!buf) {
        notes.push(`${name}: not valid base64, not attached.`);
        continue;
      }
      if (sniffImage(buf)) {
        const prep = prepareImage(buf, { label: name, declaredType: a.mimeType });
        if (prep.ok) images.push(prep.image);
        else notes.push(prep.note);
        continue;
      }
      const dec = decodeText(buf);
      if (!dec) {
        notes.push(`${name} is a binary file (${formatBytes(buf.length)}), not attached.`);
        continue;
      }
      text = dec.text;
    }
    if (text == null) continue;
    const room = MENTION_TOTAL_CAP * 2 - total;
    if (room <= 0) {
      notes.push(`${name}: over the attachment limit, not attached.`);
      continue;
    }
    const clipped = text.slice(0, room);
    total += clipped.length;
    attachments.push({ path: name, text: clipped, ...(clipped.length < text.length ? { truncated: true } : {}) });
  }
  return { attachments, images, notes };
}

/**
 * Images sent with a prompt ({ type:'image', data, mimeType } or { data: 'data:image/png;base64,...' }): decoded,
 * the type taken from the bytes, size checked. Returns { images, notes }.
 */
export function promptImages(list) {
  const images = [];
  const notes = [];
  for (const [i, im] of (Array.isArray(list) ? list : []).entries()) {
    if (!im?.data) continue;
    const buf = base64Bytes(im.data);
    const label = `Image ${i + 1}`;
    if (!buf) {
      notes.push(`${label} is not valid base64, so it was not sent.`);
      continue;
    }
    const prep = prepareImage(buf, { label, declaredType: im.mimeType });
    if (prep.ok) images.push(prep.image);
    else notes.push(prep.note);
  }
  return { images, notes };
}
