// Skills: folders with a SKILL.md (YAML-ish frontmatter: name, description). Only the name, description and path
// go into the system prompt; the model reads the file with `read` when a skill fits the task.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../store.mjs';
import { cachedText } from './files.mjs';

const PROJECT_SKILL_DIRS = ['.agents/skills', '.claude/skills', '.omp/skills'];

/** Minimal frontmatter parser: `key: value` lines between --- fences (quotes stripped, folded `>`/`|` values joined). */
export function parseFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1].toLowerCase();
      let v = kv[2].trim();
      if (v === '>' || v === '|' || v === '>-' || v === '|-') v = '';
      meta[key] = v.replace(/^(["'])([\s\S]*)\1$/, '$2');
    } else if (key && /^\s+\S/.test(line)) meta[key] = (meta[key] ? meta[key] + ' ' : '') + line.trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

/**
 * Find skills. `hostRoot` is the project folder as this Node process can open it; `displayRoot` is how the agent's
 * tools address the same folder. Project skills win over user skills with the same name.
 */
export async function discoverSkills({ hostRoot, displayRoot, join }) {
  const roots = [...PROJECT_SKILL_DIRS.map((d) => ({ host: path.join(hostRoot, ...d.split('/')), shown: join(displayRoot, d), scope: 'project' })), { host: path.join(DATA_DIR, 'skills'), shown: path.join(DATA_DIR, 'skills'), scope: 'user' }];
  const out = new Map();
  for (const r of roots) {
    let ents;
    try {
      ents = await fs.promises.readdir(r.host, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const file = path.join(r.host, e.name, 'SKILL.md');
      const text = await cachedText(file, 16384).catch(() => null); // re-read only when the file changed
      if (text == null) continue;
      const { meta } = parseFrontmatter(text);
      const name = String(meta.name || e.name).trim().replace(/\s+/g, '-').slice(0, 64);
      if (!name || out.has(name.toLowerCase())) continue;
      const shownPath = r.scope === 'user' ? path.join(r.host, e.name, 'SKILL.md') : join(r.shown, `${e.name}/SKILL.md`);
      out.set(name.toLowerCase(), { name, description: String(meta.description || '').slice(0, 500), path: shownPath, hostPath: file, scope: r.scope });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function skillsPrompt(skills) {
  if (!skills.length) return '';
  return [
    '# Skills\nFolders of instructions for specific kinds of tasks. When a task matches a skill\'s description, read its SKILL.md with the read tool first and follow it (it may point to files next to it). Do not read skills that do not apply.',
    ...skills.map((s) => `- ${s.name}: ${s.description || '(no description)'} [${s.path}]`),
  ].join('\n');
}

export async function readSkill(skill) {
  const text = await fs.promises.readFile(skill.hostPath, 'utf8');
  return parseFrontmatter(text).body.trim();
}
