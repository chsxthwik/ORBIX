// The syntax check that follows the agent's writes and edits.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkJson, checkJs, syntaxNote } from '../src/engine/syntax.mjs';
import { createTools } from '../src/engine/tools.mjs';

describe('syntax check', () => {
  test('JSON: valid, empty and BOM text pass', () => {
    assert.equal(checkJson('{"a": [1, 2]}'), null);
    assert.equal(checkJson('  \n'), null);
    assert.equal(checkJson('\ufeff{"a":1}'), null);
  });

  test('JSON: a mistake is named with its line', () => {
    const p = checkJson('{\n  "a": 1,\n  "b": 2,\n}');
    assert.match(p, /line 4/);
  });

  test('JSON: files that allow comments are not checked', async () => {
    assert.equal(await syntaxNote('C:\\p\\tsconfig.json', '{ // comment\n }'), '');
    assert.equal(await syntaxNote('/p/.vscode/settings.json', '{ "a": 1, }'), '');
    assert.match(await syntaxNote('/p/package.json', '{ "a": 1, }'), /does not parse/);
  });

  test('JavaScript: modules and scripts that parse pass', async () => {
    assert.equal(await checkJs("import fs from 'node:fs';\nexport const a = () => fs;\n", '.mjs'), null);
    assert.equal(await checkJs("const fs = require('node:fs');\nmodule.exports = fs;\n", '.cjs'), null);
  });

  test('JavaScript: a missing bracket is reported with its line', async () => {
    const p = await checkJs('const a = 1;\nfunction f() {\n  return (a;\n}\n', '.mjs');
    assert.match(p, /line 3/);
  });

  test('JavaScript: JSX is not called a mistake', async () => {
    assert.equal(await checkJs('export const A = () => <div>hi</div>;\n', '.js'), null);
  });

  test('other files and oversized text are left alone', async () => {
    assert.equal(await syntaxNote('a.py', 'def f(:'), '');
    assert.equal(await syntaxNote('a.json', '{' + ' '.repeat(600 * 1024)), '');
  });

  test('write and edit carry the note, and say nothing when the file parses', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-syntax-'));
    try {
      const backend = { hostPath: (p) => p, isWsl: false };
      const tools = createTools({ backend, cwd: dir, getSignal: () => null });
      const run = (name, args) => tools.run(name, args);
      const bad = await run('write', { path: 'a.json', content: '{"a": 1,}' });
      assert.match(bad.text, /^Created .*\nSyntax check: this file does not parse now/s);
      const fixed = await run('edit', { path: 'a.json', old_string: '1,}', new_string: '1}' });
      assert.doesNotMatch(fixed.text, /Syntax check/);
      const broke = await run('edit', { path: 'a.json', old_string: '{"a"', new_string: '{"a' });
      assert.match(broke.text, /Syntax check/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
