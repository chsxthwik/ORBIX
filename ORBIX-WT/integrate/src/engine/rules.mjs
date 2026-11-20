// Rules: Markdown files with a `trigger` in their frontmatter, in `.agents/rules/` (or the older `.agent/rules/`) of
// the project folder and each parent folder up to the repository root, and in DATA_DIR/rules/ for every project.
//
//   ---
//   trigger: always_on | model_decision | glob | manual     ("always-on", "Model decision" … are accepted too)
//   description: When this rule applies                     (needed for model_decision)
//   globs: "*.py, src/**/*.ts"                              (needed for glob; `glob:`, [a, b] and `- a` lists work)
//   ---
//
//   always_on       the whole rule is in the system prompt
//   model_decision  only its name, description and path are; the agent reads the file when the description fits
//   glob            added to the conversation the first time the agent reads, writes or edits a matching file (or you
//                   @-mention one); a pattern without "/" matches the file name at any depth, otherwise the path
//                   relative to the project folder
//   manual          only when you @-mention it in a message: @<file name without .md>
//
// A file without frontmatter or with an unknown trigger is skipped and reported (in /memory), not loaded. A project rule
// wins over one of yours with the same name, a nearer folder over a farther one. AGENTS.md / CLAUDE.md are context.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { isWinPath } from '../backend.mjs';
import { DATA_DIR } from '../store.mjs';
import { cachedText } from './files.mjs';
import { parseFrontmatter } from './skills.mjs';
import { globMatcher } from './search.mjs';

export const TRIGGERS = ['always_on', 'model_decision', 'glob', 'manual'];
const RULE_DIRS = [path.join('.agents', 'rules'), path.join('.agent', 'rules')];
const FILE_CAP = 24000; // characters of one rule
const ALWAYS_BUDGET = 80000; // about 20k tokens shared by the always-on rules; the largest beyond it become pointers
const MAX_RULES = 100;

/** Where your rules for every project live. */
export const userRulesDir = (dir = DATA_DIR) => path.join(dir, 'rules');

/** "Always On", "always-on", "always_on" → "always_on"; null when it is not a trigger. */
export function normalizeTrigger(v) {
  const t = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return TRIGGERS.includes(t) ? t : null;
}

/** `"*.py, *_test.py"`, `[*.py, "*.ts"]` or a block list (joined by the frontmatter parser) → ['*.py', …]. */
export function splitGlobs(v) {
  return String(v ?? '')
    .trim()
    .replace(/^\[([\s\S]*)\]$/, '$1')
    .split(',')
    .map((s) => s.trim().replace(/^(["'])(.*)\1$/, '$2').trim())
    .filter(Boolean);
}

/**
 * One rule file → { rule } or { error }. `info`: { name, path (as the agent's tools address it), hostPath, scope }.
 */
export function parseRule(text, info) {
  const { meta, body } = parseFrontmatter(String(text ?? ''));
  if (meta.trigger == null || meta.trigger === '') return { error: `${info.name}: no frontmatter with a trigger, so it is not loaded` };
  const trigger = normalizeTrigger(meta.trigger);
  if (!trigger) return { error: `${info.name}: unknown trigger "${meta.trigger}" (use ${TRIGGERS.join(', ')})` };
  const description = String(meta.description || '').trim().slice(0, 500);
  const globs = splitGlobs(meta.globs ?? meta.glob);
  if (trigger === 'model_decision' && !description) return { error: `${info.name}: a model_decision rule needs a description` };
  if (trigger === 'glob' && !globs.length) return { error: `${info.name}: a glob rule needs globs` };
  const full = body.trim();
  const clipped = full.slice(0, FILE_CAP);
  return { rule: { ...info, trigger, description, globs, text: clipped, truncated: clipped.length < full.length } };
}

async function readRuleDir(hostDir, shown, scope, out) {
  let ents;
  try {
    ents = await fs.promises.readdir(hostDir, { withFileTypes: true });
  } catch {
    return;
  }
  const files = ents.filter((e) => e.isFile() && /\.md$/i.test(e.name)).map((e) => e.name).sort();
  for (const f of files) {
    if (out.rules.length + out.errors.length >= MAX_RULES) return;
    const hostPath = path.join(hostDir, f);
    const text = await cachedText(hostPath, FILE_CAP * 4).catch(() => null);
    if (text == null) continue;
    const r = parseRule(text, { name: f.replace(/\.md$/i, ''), path: shown(f), hostPath, scope });
    if (r.error) out.errors.push(r.error);
    else if (!out.rules.some((x) => x.name.toLowerCase() === r.rule.name.toLowerCase())) out.rules.push(r.rule);
  }
}

/**
 * Rules for a project: { rules, errors }. Project folders nearest first, then yours. `workspace` is the project folder
 * as the tools address it; rule paths are given the same way, so the agent can read them.
 */
export async function loadRules(backend, workspace, { userDir = userRulesDir() } = {}) {
  const out = { rules: [], errors: [] };
  const hostRoot = path.resolve(backend.hostPath(workspace));
  const join = isWinPath(workspace) ? path.win32.join : path.posix.join;
  let dir = hostRoot;
  for (let i = 0; i < 8; i++) {
    for (const sub of RULE_DIRS) {
      const hostDir = path.join(dir, sub);
      const rel = path.relative(hostRoot, hostDir).split(path.sep).join('/');
      await readRuleDir(hostDir, (f) => join(workspace, rel, f), 'project', out);
    }
    let isRepoRoot = false;
    try {
      isRepoRoot = fs.existsSync(path.join(dir, '.git'));
    } catch {}
    const parent = path.dirname(dir);
    if (isRepoRoot || parent === dir) break;
    dir = parent;
  }
  await readRuleDir(userDir, (f) => path.join(userDir, f), 'user', out);
  return out;
}

/**
 * The system prompt's rules section: always-on rules in full, then the rules the agent reads when they apply
 * (model_decision, and always-on rules over the budget, largest first). '' when there is nothing to say.
 */
export function rulesPrompt(rules, { budget = ALWAYS_BUDGET } = {}) {
  const always = rules.filter((r) => r.trigger === 'always_on');
  const demoted = new Set();
  let total = always.reduce((n, r) => n + r.text.length, 0);
  for (const r of [...always].sort((a, b) => b.text.length - a.text.length)) {
    if (total <= budget) break;
    demoted.add(r);
    total -= r.text.length;
  }
  const full = always.filter((r) => !demoted.has(r));
  const listed = [...rules.filter((r) => r.trigger === 'model_decision'), ...always.filter((r) => demoted.has(r))];
  if (!full.length && !listed.length) return '';
  const parts = ['# Rules\nRules for this project. A rule from the project wins over one of the user\'s own rules.'];
  if (full.length) parts.push(full.map((r) => `<rule name="${r.name}" path="${r.path}"${r.truncated ? ' truncated="true"' : ''}>\n${r.text}\n</rule>`).join('\n\n'));
  if (listed.length) {
    parts.push(
      [
        'Read these rules with the read tool when the task matches their description, then follow them. Do not read rules that do not apply.',
        ...listed.map((r) => `- ${r.name}: ${r.description || '(no description; read it when it may apply)'} [${r.path}]`),
      ].join('\n'),
    );
  }
  return parts.join('\n\n');
}

/** Files the agent may read without the outside-the-project question: the rules it is told to read. */
export const readableRuleFiles = (rules) => rules.filter((r) => r.trigger === 'model_decision' || r.trigger === 'always_on').map((r) => r.hostPath);

/** Glob rules that cover `rel` (a path relative to the project folder, either slash). */
export function rulesForFile(rules, rel) {
  const p = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p) return [];
  return rules.filter((r) => r.trigger === 'glob' && r.globs.some((g) => globMatcher(g)(p)));
}

/** Rules @-mentioned by name in a message (`@name` or `@name.md`); always-on rules are already in the prompt. */
export function mentionedRules(rules, text) {
  const out = [];
  const re = /(?:^|[\s(])@("[^"]+"|[^\s"'`()<>]+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const raw = m[1].replace(/^"|"$/g, '').replace(/[.,;:!?)\]]+$/, '').toLowerCase();
    const hit = rules.find((r) => r.trigger !== 'always_on' && (raw === r.name.toLowerCase() || raw === `${r.name.toLowerCase()}.md`));
    if (hit && !out.some((x) => x.rule === hit)) out.push({ rule: hit, mention: m[1].replace(/^"|"$/g, '').replace(/[.,;:!?)\]]+$/, '') });
  }
  return out;
}

/** How a rule travels as an attachment or as a note in a tool result. */
export const ruleBlock = (r, why) => `<rule name="${r.name}" path="${r.path}" trigger="${r.trigger}"${why ? ` applies="${why}"` : ''}${r.truncated ? ' truncated="true"' : ''}>\n${r.text}\n</rule>`;
