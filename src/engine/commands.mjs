// Slash-command list for the ORBIX agent: its own commands plus custom Markdown prompt files
// (<project>/.omp/commands, <project>/.claude/commands, DATA_DIR/commands). A file `review.md` becomes /review;
// `git/commit.md` becomes /git:commit. `$ARGUMENTS` (and $1..$9) are replaced with what follows the command.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../store.mjs';
import { parseFrontmatter } from './skills.mjs';
import { cachedText } from './files.mjs';

export const BUILTIN_COMMANDS = [
  { name: 'compact', description: 'Summarize older messages to free up context', input: { hint: '[focus]' } },
  { name: 'plan', description: 'Toggle plan mode: the agent only reads and plans, it changes nothing' },
  { name: 'retry', description: 'Answer the last message again' },
  { name: 'undo', description: 'Undo the file changes from the last reply' },
  { name: 'model', description: 'Show or switch the model (fast and plan are extra roles)', input: { hint: '[fast|plan] [provider/model]' } },
  { name: 'branch', description: 'Continue this conversation in a new tab (files are not reverted)' },
  { name: 'goal', description: 'Keep working on a goal by itself (up to 6 rounds) until it is done', input: { hint: '<what to achieve>' } },
  { name: 'memory', description: 'Show the project memory file (AGENTS.md)' },
  { name: 'hooks', description: 'Show the hooks that run around the agent\'s work' },
  { name: 'mcp', description: 'Show MCP servers and their tools' },
  { name: 'skills', description: 'List the skills the agent can use' },
  { name: 'cost', description: 'Tokens and cost of this session' },
  { name: 'init', overridable: true, description: 'Write an AGENTS.md with this project\'s rules for future sessions', input: { hint: '[focus]' } },
  { name: 'review', overridable: true, description: 'Review the uncommitted changes for bugs and risks', input: { hint: '[focus]' } },
  { name: 'commit', overridable: true, description: 'Write a commit message for the staged changes and commit', input: { hint: '[notes]' } },
  { name: 'help', description: 'What the ORBIX agent can do' },
];

const PROJECT_DIRS = ['.omp/commands', '.claude/commands'];
const NAME_OK = /^[A-Za-z0-9][\w.-]*$/;

async function walkMd(dir, prefix, out, depth = 0) {
  let ents;
  try {
    ents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth < 2 && NAME_OK.test(e.name)) await walkMd(full, `${prefix}${e.name}:`, out, depth + 1);
    else if (e.isFile() && /\.md$/i.test(e.name)) {
      const base = e.name.replace(/\.md$/i, '');
      if (NAME_OK.test(base)) out.push({ name: `${prefix}${base}`, file: full });
    }
  }
}

/** Custom commands; project files win over user files with the same name. Built-in names cannot be overridden, except the prompt ones (/init /review /commit). */
export async function discoverCommands(hostRoot) {
  const found = new Map();
  const reserved = new Set(BUILTIN_COMMANDS.filter((c) => !c.overridable).map((c) => c.name));
  const roots = [...PROJECT_DIRS.map((d) => ({ dir: path.join(hostRoot, ...d.split('/')), scope: 'project' })), { dir: path.join(DATA_DIR, 'commands'), scope: 'user' }];
  for (const r of roots) {
    const list = [];
    await walkMd(r.dir, '', list);
    for (const c of list) {
      const key = c.name.toLowerCase();
      if (found.has(key) || reserved.has(key)) continue;
      let meta = {};
      let first = '';
      try {
        const text = await cachedText(c.file); // re-read only when the file changed
        if (text == null) continue;
        const fm = parseFrontmatter(text);
        meta = fm.meta;
        first = fm.body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '';
      } catch {
        continue;
      }
      found.set(key, { name: c.name, description: String(meta.description || first).slice(0, 160), input: meta['argument-hint'] ? { hint: meta['argument-hint'] } : undefined, source: r.scope, file: c.file });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The prompt text for a custom command. */
export async function expandCommand(cmd, args) {
  const { body } = parseFrontmatter(await fs.promises.readFile(cmd.file, 'utf8'));
  const argv = String(args || '').trim().match(/"[^"]*"|'[^']*'|\S+/g)?.map((a) => a.replace(/^(["'])(.*)\1$/, '$2')) || [];
  let used = false;
  const whole = String(args || '').trim();
  // One pass, so text that arrives through $ARGUMENTS is never expanded a second time.
  let text = body.replace(/\$ARGUMENTS\b|\$([1-9])\b/g, (m, n) => {
    used = true;
    return n ? (argv[+n - 1] ?? '') : whole;
  });
  text = text.trim();
  if (!used && String(args || '').trim()) text += `\n\n${String(args).trim()}`;
  return text;
}
