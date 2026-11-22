import { baseName } from './dom.js';
import { S, groupSessions } from './store.js';

/** Saved projects plus those that only have conversations. */
export function hubProjects() {
  const seen = new Map();
  for (const g of groupSessions()) if (g.path) seen.set(g.path, g.name);
  for (const w of S.workspaces || []) seen.set(w.path, w.name || baseName(w.path));
  return [...seen.entries()];
}
