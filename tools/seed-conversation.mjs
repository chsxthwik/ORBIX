#!/usr/bin/env node
// Seed one long conversation into an ORBIX data folder, for profiling and for trying the app with real volume.
//
//   ORBIX_DATA=<folder> node tools/seed-conversation.mjs [--messages 2000] [--cwd <project folder>]
//
// The conversation is saved the way ORBIX saves its own (a JSONL session file under <data>/sessions), so it opens
// from the sidebar like any other. It mixes what real ones hold: short questions, answers with paragraphs, lists,
// inline code, tables and fenced code, and turns where the agent reads and searches files before it answers.
// Deterministic: the same arguments write the same messages.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const QUESTIONS = [
  'Why does the login test fail when the email has capital letters?',
  'Add rate limiting to the sign-in endpoint: five attempts per minute per email.',
  'Explain how the session cookie is refreshed.',
  'Refactor `src/users.js` so lookups go through one function.',
  'What happens if the reset token expires while the form is open?',
  'Write a test for the password reset flow.',
  'Is there any place that compares emails without normalising them?',
  'Summarise the changes so far for the pull request.',
];
const FILES = ['src/auth.js', 'src/users.js', 'src/reset.js', 'src/limit.js', 'test/auth.test.js', 'src/session.js'];

function answer(i) {
  const f = FILES[i % FILES.length];
  const g = FILES[(i + 2) % FILES.length];
  const parts = [`Turn ${i}: the cause is in \`${f}\`. It reads the value before it is normalised, so two spellings of the same address reach different branches.`];
  if (i % 3 === 0) parts.push(`- \`${f}\` now trims and lower-cases the input first.\n- \`${g}\` calls the same helper.\n- The old path is kept for one release, with a warning in the log.`);
  if (i % 4 === 0) {
    parts.push([
      '```js',
      `// ${f}`,
      "import { findByEmail } from './users.js';",
      '',
      'export function normalizeEmail(email) {',
      "  return String(email || '').trim().toLowerCase();",
      '}',
      '',
      'export function login(email, password) {',
      '  const user = findByEmail(normalizeEmail(email));',
      '  if (!user || user.password !== `h4sh:${password}`) return null;',
      '  return { id: user.id, name: user.name };',
      '}',
      '```',
    ].join('\n'));
  }
  if (i % 7 === 0) parts.push(`| File | Before | After |\n| --- | --- | --- |\n| \`${f}\` | ${12 + (i % 9)} lines | ${10 + (i % 7)} lines |\n| \`${g}\` | ${30 + (i % 5)} lines | ${28 + (i % 4)} lines |`);
  parts.push(`All ${3 + (i % 4)} tests pass. **Next:** ${QUESTIONS[(i + 1) % QUESTIONS.length].toLowerCase()}`);
  return parts.join('\n\n');
}

/**
 * Write a conversation of `messages` messages (user, assistant and tool results together) and return its file.
 * `data` is the ORBIX data folder; `cwd` the project folder the conversation belongs to.
 */
export function seedConversation({ data, cwd, messages = 2000, title = 'A long conversation (seeded)', start = Date.UTC(2026, 10, 1, 9) }) {
  const id = 'b' + crypto.createHash('sha1').update(`${cwd}:${messages}`).digest('hex').slice(0, 10);
  const dir = path.join(data, 'sessions', crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 10));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date(start).toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`);
  const lines = [
    { type: 'session', engine: 'builtin', version: 1, id, cwd, model: 'orbix-fixture', provider: 'custom', timestamp: new Date(start).toISOString() },
    { type: 'title', title, by: 'user' },
  ];
  let t = start;
  let n = 0;
  let turn = 0;
  const usage = (out) => ({ input: 6000 + n * 3, output: out, cacheRead: 0, cacheWrite: 0, totalTokens: 6000 + n * 3 + out });
  const push = (message) => {
    lines.push({ type: 'message', message });
    n++;
  };
  while (n < messages) {
    t += 45_000;
    push({ role: 'user', id: `u${turn}`, content: [{ type: 'text', text: QUESTIONS[turn % QUESTIONS.length] + (turn % 5 === 0 ? `\n\nContext: this is request ${turn}.` : '') }], attribution: 'user', timestamp: t });
    // Every third turn the agent reads and searches before it answers: a call, its results, then the answer.
    if (turn % 3 === 1 && n + 4 <= messages) {
      const f = FILES[turn % FILES.length];
      push({ role: 'assistant', content: [{ type: 'text', text: 'I will look at the code first.' }, { type: 'toolCall', id: `c${turn}_0`, name: 'grep', arguments: { pattern: 'findByEmail', path: 'src' } }, { type: 'toolCall', id: `c${turn}_1`, name: 'read', arguments: { path: f } }], api: 'openai', provider: 'custom', model: 'orbix-fixture', usage: usage(40), stopReason: 'toolUse', timestamp: t + 400 });
      push({ role: 'toolResult', toolCallId: `c${turn}_0`, toolName: 'grep', content: [{ type: 'text', text: `${f}:1: import { findByEmail } from './users.js';\n${f}:4:   const user = findByEmail(email);` }], isError: false, timestamp: t + 450 });
      push({ role: 'toolResult', toolCallId: `c${turn}_1`, toolName: 'read', content: [{ type: 'text', text: Array.from({ length: 14 }, (_, k) => `${k + 1}\t// line ${k + 1} of ${f}`).join('\n') }], isError: false, timestamp: t + 480 });
    }
    if (n < messages) push({ role: 'assistant', content: [{ type: 'text', text: answer(turn) }], api: 'openai', provider: 'custom', model: 'orbix-fixture', usage: usage(180), stopReason: 'stop', timestamp: t + 2000, firstTokenAt: t + 700, doneAt: t + 2000 });
    turn++;
  }
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { file, id, messages: n };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, d) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const data = process.env.ORBIX_DATA;
  if (!data) {
    console.error('Set ORBIX_DATA to the data folder to seed (use a copy, not your real one).');
    process.exit(1);
  }
  const cwd = path.resolve(arg('cwd', process.cwd()));
  const r = seedConversation({ data, cwd, messages: Number(arg('messages', 2000)) });
  console.log(`Seeded ${r.messages} messages into ${r.file}`);
}
