// Lists OMP session files (JSONL) without starting an agent process.
import fs from 'node:fs';
import path from 'node:path';
import { clip, log, makeTitle, pool, readHead, textOf } from './util.mjs';

const cache = new Map(); // host path -> { mtime, size, meta }

/** Extract header info from the first bytes of a session file. */
export function parseSessionHead(text) {
  const meta = { id: '', cwd: '', title: '', firstUser: '', timestamp: '', continuationOf: '' };
  const lines = text.split('\n');
  lines.pop(); // last line may be cut
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'title' && o.title && !meta.title) meta.title = String(o.title);
    else if (o.type === 'session') {
      meta.id = o.id || '';
      meta.cwd = o.cwd || '';
      meta.timestamp = o.timestamp || '';
      meta.continuationOf = o.continuationOf || '';
      if (o.title) meta.title = String(o.title);
    } else if (o.type === 'title_change' && o.title) meta.title = String(o.title);
    else if (o.type === 'message' && o.message?.role === 'user' && !meta.firstUser) {
      meta.firstUser = textOf(o.message.content).replace(/\s+/g, ' ').trim();
    }
    if (meta.id && meta.title && meta.firstUser) break;
  }
  return meta;
}

/**
 * OMP resumes a conversation by writing a NEW file whose header says `continuationOf: <old id>`.
 * Show each conversation once (its newest file) and remember the older files in `chain`, so an open tab
 * started from any file of the chain still matches the single list entry.
 */
export function collapseChains(entries) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const hidden = new Set();
  for (const e of entries) if (e.continuationOf && e.continuationOf !== e.id && byId.has(e.continuationOf)) hidden.add(e.continuationOf);
  const covered = new Set(); // ids that appear in some listed entry's chain
  const build = (e) => {
    const chain = [e.path];
    const ids = [e.id];
    const seen = new Set([e.id]);
    for (let p = byId.get(e.continuationOf); p && !seen.has(p.id); p = byId.get(p.continuationOf)) {
      seen.add(p.id);
      chain.push(p.path);
      ids.push(p.id);
    }
    for (const id of ids) covered.add(id);
    return { ...e, chain, chainIds: ids, resumes: chain.length - 1 };
  };
  const out = [];
  for (const e of entries) if (!hidden.has(e.id)) out.push(build(e));
  // Corrupt data can make files continue each other in a loop; then every member is "hidden". Keep one so the conversation stays visible.
  for (const e of entries) if (!covered.has(e.id)) out.push(build(e));
  return out;
}

export async function listSessions(backend, { limit = 300 } = {}) {
  const rootLinux = await backend.sessionsRoot();
  const root = backend.hostPath(rootLinux);
  let dirs;
  try {
    dirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const sep = backend.isWsl ? '/' : path.sep;
  const files = [];
  await pool(
    dirs.filter((d) => d.isDirectory()),
    12,
    async (d) => {
      const dir = path.join(root, d.name);
      let names;
      try {
        names = await fs.promises.readdir(dir);
      } catch {
        return;
      }
      for (const n of names) if (n.endsWith('.jsonl')) files.push({ host: path.join(dir, n), exec: `${rootLinux}${sep}${d.name}${sep}${n}`, name: n });
    },
  );
  const stats = await pool(files, 24, async (f) => {
    const st = await fs.promises.stat(f.host);
    return { ...f, mtime: st.mtimeMs, size: st.size };
  });
  const top = stats
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
  const metas = await pool(top, 16, async (f) => {
    const hit = cache.get(f.host);
    let meta;
    if (hit && hit.mtime === f.mtime && hit.size === f.size) meta = hit.meta;
    else {
      meta = parseSessionHead(await readHead(f.host, 96 * 1024));
      cache.set(f.host, { mtime: f.mtime, size: f.size, meta });
    }
    return meta;
  });
  const live = new Set(top.map((f) => f.host));
  for (const k of cache.keys()) if (!live.has(k)) cache.delete(k); // forget deleted and old files
  const entries = top
    .map((f, i) => {
      const m = metas[i];
      if (!m || !m.id) return null;
      return {
        id: m.id,
        continuationOf: m.continuationOf,
        path: f.exec,
        cwd: m.cwd,
        cwdKey: backend.keyPath(m.cwd),
        cwdDisplay: backend.displayPath(m.cwd),
        title: makeTitle(m.title || m.firstUser) || 'Untitled',
        preview: clip(m.firstUser || '', 140),
        mtime: f.mtime,
        size: f.size,
      };
    })
    .filter(Boolean);
  return collapseChains(entries);
}

/**
 * Permanently delete session files (and the artifacts folder OMP keeps next to each one).
 * Only `<sessions root>/<project>/<file>.jsonl` paths are accepted; anything else is refused.
 */
export async function deleteSessions(backend, paths) {
  const root = path.resolve(backend.hostPath(await backend.sessionsRoot()));
  // Validate every path before deleting anything, so a bad entry never leaves a half-done batch.
  const files = paths.map((p) => {
    if (typeof p !== 'string' || !p.endsWith('.jsonl')) throw Object.assign(new Error('Not a session file'), { status: 400 });
    const file = path.resolve(backend.hostPath(p));
    if (path.dirname(path.dirname(file)) !== root) throw Object.assign(new Error('Refusing to delete outside the OMP sessions folder'), { status: 403 });
    return file;
  });
  for (const file of files) {
    await fs.promises.rm(file, { force: true });
    await fs.promises.rm(file.slice(0, -'.jsonl'.length), { recursive: true, force: true });
    cache.delete(file);
    log('deleted session', file); // audit trail: data/logs/server.log
  }
  return files.length;
}
