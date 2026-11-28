// A disposable in-memory search index. JSONL remains the source of truth for saved conversations.
import fs from 'node:fs';
import readline from 'node:readline';
import { textOf } from './util.mjs';

const normalize = (text) => text.replace(/\s+/g, ' ').trim();

function excerpt(text, query) {
  const match = text.toLowerCase().indexOf(query.toLowerCase());
  if (match < 0) return '';
  const start = Math.max(0, match - 36);
  const end = Math.min(text.length, match + query.length + 36);
  return `${start ? '… ' : ''}${normalize(text.slice(start, end))}${end < text.length ? ' …' : ''}`;
}

async function transcript(file) {
  if (!(await fs.promises.lstat(file)).isFile()) return '';
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const messages = [];
  try {
    for await (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a crash or an in-flight append can leave an incomplete final record
      }
      const message = entry?.type === 'message' && entry.message;
      if (message) {
        messages.push(message.role === 'user' || message.role === 'assistant' ? normalize(textOf(message.content)) : '');
      } else if (entry?.type === 'compaction' && typeof entry.summary === 'string') {
        messages.splice(Math.max(0, messages.length - Math.max(0, entry.keptCount | 0)), 0, '');
      } else if (entry?.type === 'rewind' && Number.isInteger(entry.count) && entry.count >= 0) {
        messages.length = Math.min(messages.length, entry.count);
      }
    }
  } finally {
    input.destroy();
  }
  return messages.filter(Boolean).join('\n\n');
}

async function openIndex() {
  // Early Node 22 builds and some downstream builds of SQLite do not provide FTS5.
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(':memory:');
    db.exec('CREATE VIRTUAL TABLE messages USING fts5(path UNINDEXED, transcript, tokenize=trigram)');
    db.function('orbix_excerpt', excerpt);
    return db;
  } catch {
    db?.close();
    return null;
  }
}

export class ConversationSearch {
  constructor(listSessions) {
    this.listSessions = listSessions;
    this.indexed = new Map();
  }

  async refresh() {
    const sessions = await this.listSessions();
    const live = new Set(sessions.map((session) => session.path));
    const db = await (this.index ||= openIndex());
    const remove = db?.prepare('DELETE FROM messages WHERE rowid = ?');
    for (const [file, entry] of this.indexed) {
      if (live.has(file)) continue;
      if (remove) remove.run(entry.rowid);
      this.indexed.delete(file);
    }
    const insert = db?.prepare('INSERT INTO messages (path, transcript) VALUES (?, ?)');
    const update = db?.prepare('UPDATE messages SET transcript = ? WHERE rowid = ?');
    for (const session of sessions) {
      const previous = this.indexed.get(session.path);
      if (previous?.mtime === session.mtime && previous.size === session.size) continue;
      let text;
      try {
        text = await transcript(session.path);
      } catch {
        if (previous && remove) remove.run(previous.rowid);
        this.indexed.delete(session.path);
        continue;
      }
      const { mtime, size } = session;
      if (previous && update) {
        update.run(text, previous.rowid);
        this.indexed.set(session.path, { mtime, size, rowid: previous.rowid });
      } else if (insert) {
        this.indexed.set(session.path, { mtime, size, rowid: insert.run(session.path, text).lastInsertRowid });
      } else {
        this.indexed.set(session.path, { mtime, size, text });
      }
    }
    return { db, sessions };
  }

  async find(raw) {
    const query = normalize(String(raw || '').slice(0, 150));
    if ([...query].length < 3 || query.includes('\0')) return [];
    // Share an in-flight refresh between palettes instead of indexing the same files twice.
    this.refreshing ||= this.refresh().finally(() => (this.refreshing = null));
    const { db, sessions } = await this.refreshing;
    const index = new Map(sessions.map((s) => [s.path, s]));
    if (!db) {
      const matches = [];
      for (const session of sessions.sort((a, b) => b.mtime - a.mtime)) {
        const text = this.indexed.get(session.path)?.text || '';
        const snippet = excerpt(text, query);
        if (!snippet) continue;
        matches.push({ ...session, snippet });
        if (matches.length === 30) break;
      }
      return matches;
    }
    const literal = `"${query.replaceAll('"', '""')}"`;
    const hits = db.prepare(`
      SELECT path, COALESCE(NULLIF(orbix_excerpt(transcript, ?), ''), snippet(messages, 1, '', '', ' … ', 80)) AS preview
      FROM messages WHERE messages MATCH ? ORDER BY rank, path LIMIT 30
    `).all(query, literal);
    return hits.map(({ path, preview }) => ({ ...index.get(path), snippet: normalize(preview) }));
  }
}
