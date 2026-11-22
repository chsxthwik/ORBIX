// Skills: folders with a SKILL.md (YAML-ish frontmatter: name, description). Only the name, description and path
// go into the system prompt; the model reads the file with `read` when a skill fits the task.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../store.mjs';
import { cachedText } from './files.mjs';

const PROJECT_SKILL_DIRS = ['.agents/skills', '.claude/skills', '.omp/skills'];
const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Minimal frontmatter parser: `key: value` lines between --- fences (quotes stripped, folded `>`/`|` values joined). */
export function parseFrontmatter(text) {
  const m = FRONTMATTER.exec(text);
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

/** A skill name as a folder: lower-case words joined by dashes ("Write release notes" → "write-release-notes"). */
function skillSlug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

/** SKILL.md text for a name, a one-line description and the instructions. */
function skillText({ name, description, body }) {
  const one = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  return `---\nname: ${skillSlug(name)}\ndescription: ${one(description)}\n---\n\n${String(body || '').trim()}\n`;
}

/** Change only the fields the editor exposes, leaving other frontmatter untouched. */
export function editSkillText(text, { name, description, body }) {
  const m = FRONTMATTER.exec(text);
  if (!m) return skillText({ name, description, body });
  const nl = m[0].includes('\r\n') ? '\r\n' : '\n';
  const value = String(description).replace(/\s+/g, ' ').trim();
  const lines = m[1].split(/\r?\n/);
  const idx = lines.findIndex((line) => /^description:/i.test(line));
  if (idx < 0) lines.push(`description: ${value}`);
  else {
    let end = idx + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end]) && !/^\s*#/.test(lines[end])) end++;
    lines.splice(idx, end - idx, `description: ${value}`);
  }
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const instructions = String(body).replace(/\r?\n/g, nl);
  return `${bom}---${nl}${lines.join(nl)}${nl}---${nl}${nl}${instructions}${instructions.endsWith(nl) ? '' : nl}`;
}

/**
 * Write a skill: a new one in the project (`.agents/skills/<name>/SKILL.md`) or for you in every project
 * (`<data>/skills/<name>/SKILL.md`), or over an existing one's own file (`hostPath`). Returns the file written.
 */
export async function saveSkill({ hostRoot, scope, name, description, body, hostPath }) {
  const slug = skillSlug(name);
  if (!slug) throw Object.assign(new Error('Give the skill a name'), { status: 400 });
  if (!String(description || '').trim()) throw Object.assign(new Error('Say in one line when the agent should use it'), { status: 400 });
  if (!String(body || '').trim()) throw Object.assign(new Error('Write the instructions'), { status: 400 });
  if (String(body).length > 100000) throw Object.assign(new Error('Keep a skill under 100,000 characters'), { status: 400 });
  let file = hostPath;
  if (!file) {
    const base = scope === 'user' ? path.join(DATA_DIR, 'skills') : path.join(hostRoot, '.agents', 'skills');
    file = path.join(base, slug, 'SKILL.md');
  }
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const fields = { name: slug, description, body };
  if (hostPath) {
    const original = await fs.promises.readFile(file, 'utf8');
    await fs.promises.writeFile(file, editSkillText(original, fields));
  } else {
    try {
      await fs.promises.writeFile(file, skillText(fields), { flag: 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') throw Object.assign(new Error(`A skill named ${slug} is already there`), { status: 409 });
      throw e;
    }
  }
  return file;
}

/** Delete a skill: its folder moves to <data>/trash/skills, so it can be put back by hand. Returns where it went. */
export async function trashSkill(hostPath) {
  const dir = path.dirname(hostPath);
  const to = path.join(DATA_DIR, 'trash', 'skills', `${Date.now()}~${path.basename(dir)}`);
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.promises.rename(dir, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e; // another drive: copy, then remove
    await fs.promises.cp(dir, to, { recursive: true });
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
  return to;
}
