import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { frontMatter, loadRules } from '../src/engine/context.mjs';
import { buildSystemPrompt } from '../src/engine/prompt.mjs';

const backend = { hostPath: (p) => p };

describe('.agents/rules with triggers', () => {
  test('front matter is read, and a file without it is all body', () => {
    const r = frontMatter('---\ntrigger: glob\nglobs: "src/**/*.ts"\ndescription: TypeScript style\n---\nUse strict types.');
    assert.deepEqual(r.data, { trigger: 'glob', globs: 'src/**/*.ts', description: 'TypeScript style' });
    assert.equal(r.body, 'Use strict types.');
    assert.deepEqual(frontMatter('Just text').data, {});
  });

  test('always_on rules are loaded, model_decision and glob are listed, manual ones wait for a mention', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-rules-'));
    const dir = path.join(ws, '.agents', 'rules');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a-style.md'), 'Two spaces, no semicolons.');
    fs.writeFileSync(path.join(dir, 'b-db.md'), '---\ntrigger: model_decision\ndescription: Database migrations\n---\nAlways write a down migration.');
    fs.writeFileSync(path.join(dir, 'c-tests.md'), '---\ntrigger: glob\nglobs: test/**\n---\nUse node:test.');
    fs.writeFileSync(path.join(dir, 'd-release.md'), '---\ntrigger: manual\n---\nRelease steps.');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a rule');
    const r = await loadRules(backend, ws);
    assert.deepEqual(r.always.map((x) => x.text), ['Two spaces, no semicolons.']);
    assert.deepEqual(r.listed.map((x) => [path.basename(x.path), x.trigger]), [['b-db.md', 'model_decision'], ['c-tests.md', 'glob']]);
    const prompt = buildSystemPrompt({ env: { workspace: ws, shell: 'cmd', os: 'Windows', date: '2026-11-20' }, rules: r.always, ruleIndex: r.listed });
    assert.match(prompt, /Two spaces, no semicolons\./);
    assert.match(prompt, /b-db\.md: Database migrations/);
    assert.match(prompt, /c-tests\.md \(for files matching test\/\*\*\)/);
    assert.doesNotMatch(prompt, /Release steps/);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  test('a project without the folder has no rules', async () => {
    assert.deepEqual(await loadRules(backend, path.join(os.tmpdir(), 'no-such-project-orbix')), { always: [], listed: [] });
  });
});
