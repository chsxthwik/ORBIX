// Tests for the prompt-style slash commands: /init /review /commit (and that a project's own command of that name wins).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { runSlash } = await import('../src/engine/slash.mjs');
const { BUILTIN_COMMANDS } = await import('../src/engine/commands.mjs');

describe('prompt slash commands', () => {
  let dir;
  const agent = () => ({ workspace: 'x', backend: { hostPath: () => dir }, _out: () => {} });
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-slash-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('are listed for autocomplete', () => {
    for (const n of ['init', 'review', 'commit']) assert.ok(BUILTIN_COMMANDS.some((c) => c.name === n && c.description), n);
  });

  test('each turns into a request for the agent', async () => {
    for (const [cmd, word] of [['init', 'AGENTS.md'], ['review', 'git diff'], ['commit', 'git diff --cached']]) {
      const r = await runSlash(agent(), `/${cmd}`);
      assert.ok(r && typeof r.text === 'string' && r.text.includes(word), cmd);
    }
  });

  test('text after the command becomes the focus', async () => {
    const r = await runSlash(agent(), '/review the login code');
    assert.match(r.text, /Focus: the login code$/);
  });

  test('a project command file with the same name is used instead', async () => {
    fs.mkdirSync(path.join(dir, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'commands', 'review.md'), 'My own review rules: $ARGUMENTS');
    const r = await runSlash(agent(), '/review now');
    assert.match(r.text, /My own review rules: now/);
    assert.doesNotMatch(r.text, /git status/);
  });
});
