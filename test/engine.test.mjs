// Regression tests for the built-in agent engine (src/engine/*): tools, web fetch, providers, message converters,
// compaction, skills, commands, export, catalog. No network, no project data folder: ORBIX_DATA points at a temp dir.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-test-'));
process.env.ORBIX_NO_RG = '1'; // the JS search engine everywhere, so results do not depend on an installed ripgrep
const DATA = path.join(TMP, 'data');
process.env.ORBIX_DATA = DATA;
fs.mkdirSync(path.join(DATA, 'cache'), { recursive: true });

const rec = (o) => ({ contextWindow: 200000, maxOutput: 8192, cost: { input: null, output: null, cacheRead: null, cacheWrite: null }, reasoning: false, vision: false, tools: true, efforts: null, budget: false, toggle: false, interleaved: null, canonical: null, ...o });
const CATALOG = {
  anthropic: {
    'claude-opus-4-7': rec({ maxOutput: 128000, reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }),
    'claude-sonnet-4-5': rec({ maxOutput: 64000, reasoning: true, budget: true, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }),
    'claude-3-5-haiku-latest': rec({ maxOutput: 8192 }),
  },
  openai: {
    o3: rec({ maxOutput: 100000, reasoning: true, efforts: ['low', 'medium', 'high'], cost: { input: 2, output: 8, cacheRead: null, cacheWrite: null } }),
    'gpt-4o': rec({ maxOutput: 16384, vision: true, cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: null } }),
    'gpt-5': rec({ maxOutput: 128000, reasoning: true, efforts: ['minimal', 'low', 'medium', 'high'] }),
    'gpt-5.1': rec({ maxOutput: 128000, reasoning: true, efforts: ['none', 'low', 'medium', 'high'] }),
  },
  deepseek: { 'deepseek-reasoner': rec({ maxOutput: 64000, reasoning: true, toggle: true, interleaved: 'reasoning_content' }) },
  google: { 'gemini-2.5-pro': rec({ maxOutput: 65536, reasoning: true }) },
};
fs.writeFileSync(path.join(DATA, 'cache', 'models-dev.json'), JSON.stringify({ fetchedAt: Date.now(), providers: CATALOG }));

const realFetch = globalThis.fetch;
let fetchHandler = async () => {
  throw new Error('network is blocked in tests');
};
const fetchCalls = [];
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  return fetchHandler(String(url), init);
};
const sse = (events) => new Response(events.map((e) => (typeof e === 'string' ? e : `${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`)).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

const tools_ = await import('../src/engine/tools.mjs');
const webfetch = await import('../src/engine/webfetch.mjs');
const providers = await import('../src/engine/providers.mjs');
const anthropic = await import('../src/engine/anthropic.mjs');
const openai = await import('../src/engine/openai.mjs');
const compact = await import('../src/engine/compact.mjs');
const skills = await import('../src/engine/skills.mjs');
const exporter = await import('../src/engine/export.mjs');
const catalog = await import('../src/engine/catalog.mjs');
const secrets = await import('../src/engine/secrets.mjs');
const subagent = await import('../src/engine/subagent.mjs');
const commands = await import('../src/engine/commands.mjs');
const context = await import('../src/engine/context.mjs');

after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const collect = async (it) => {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
};
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const u = (text, extra = {}) => ({ role: 'user', content: [{ type: 'text', text }], ...extra });
const a = (text, extra = {}) => ({ role: 'assistant', content: [{ type: 'text', text }], ...extra });
const call = (id, name = 'read', args = {}) => ({ type: 'toolCall', id, name, arguments: args });
const result = (id, text, extra = {}) => ({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text }], ...extra });

// =====================================================================================================
describe('tools: classification', () => {
  test('every tool definition is either read-only or needs approval, never both', () => {
    for (const d of tools_.TOOL_DEFS) {
      const ro = tools_.READ_ONLY.has(d.name);
      const ap = tools_.NEEDS_APPROVAL.has(d.name);
      assert.ok(ro !== ap || d.name === 'bash' && ap && !ro, `${d.name}: ro=${ro} approval=${ap}`);
      assert.ok(ro || ap, `${d.name} is in neither set`);
    }
  });
  test('mutating tools are not run side by side', () => {
    for (const n of ['write', 'edit', 'bash']) assert.ok(!tools_.READ_ONLY.has(n));
  });
});

describe('tools: createTools against a real folder', () => {
  const ws = path.join(TMP, 'ws');
  const backend = {
    hostPath: (p) => p,
    spawnShell: (command, { cwd }) => spawn(command, { cwd, shell: true }),
  };
  let T;
  const run = (name, input) => T.run(name, input, { onUpdate() {} });
  const put = (rel, content) => {
    const f = path.join(ws, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    return f;
  };
  before(() => {
    fs.mkdirSync(ws, { recursive: true });
    T = tools_.createTools({ backend, cwd: ws, getSignal: () => undefined });
    put('src/a.mjs', 'import x\nconst Foo = 1\n');
    put('src/deep/b.mjs', 'const foo = 2\r\nlet z\r\n');
    put('src/deep/c.txt', 'text Foo\n');
    put('.env', 'SECRET=Foo\n');
    put('README.md', '# Readme\n');
    put('node_modules/pkg/index.js', 'Foo\n');
    put('.git/config', 'Foo\n');
    put('bin.dat', Buffer.concat([Buffer.from('Foo\n'), Buffer.from([0, 1, 2])]));
    put('big.txt', 'Foo\n'.repeat(300000)); // > 1 MiB: grep skips it
    for (let i = 0; i < 310; i++) put(`many/f${String(i).padStart(3, '0')}.log`, 'x');
    put('lines/250.txt', Array.from({ length: 250 }, (_, i) => `x${i}`).join('\n'));
    put('lines/long.txt', 'y'.repeat(500));
  });

  describe('read', () => {
    test('numbers lines with a tab and strips \\r', async () => {
      const r = await run('read', { path: 'src/deep/b.mjs' });
      assert.ok(!r.isError);
      assert.ok(r.text.startsWith('1\tconst foo = 2\n2\tlet z'));
      assert.ok(!r.text.includes('\r'));
    });
    test('offset and limit select a window and say how to continue', async () => {
      put('five.txt', 'a\nb\nc\nd\ne');
      const r = await run('read', { path: 'five.txt', offset: 2, limit: 2 });
      assert.equal(r.text, '2\tb\n3\tc\n[showing lines 2-3 of 5; pass offset=4 to continue]');
      assert.equal(r.details.totalLines, 5);
    });
    test('a window that reaches the end has no continuation note', async () => {
      const r = await run('read', { path: 'five.txt', offset: 4 });
      assert.equal(r.text, '4\td\n5\te');
    });
    test('a missing file is an error result, not a throw', async () => {
      const r = await run('read', { path: 'nope/missing.txt' });
      assert.equal(r.isError, true);
      assert.match(r.text, /No such file or folder: nope\/missing\.txt/);
    });
    test('a missing path argument is an error result', async () => {
      const r = await run('read', {});
      assert.equal(r.isError, true);
      assert.match(r.text, /Missing required argument "path"/);
    });
    test('a directory lists sorted entries with a / suffix on folders', async () => {
      const r = await run('read', { path: 'src' });
      assert.equal(r.text, 'a.mjs\ndeep/');
    });
    test('an empty directory is reported', async () => {
      fs.mkdirSync(path.join(ws, 'empty'), { recursive: true });
      assert.equal((await run('read', { path: 'empty' })).text, '(empty folder)');
    });
    test('binary files are refused', async () => {
      const r = await run('read', { path: 'bin.dat' });
      assert.equal(r.isError, true);
      assert.match(r.text, /binary/i);
    });
    test('files over the 5 MiB read limit are refused with advice', async () => {
      put('huge.txt', Buffer.alloc(5 * 1024 * 1024 + 1, 97));
      const r = await run('read', { path: 'huge.txt' });
      assert.equal(r.isError, true);
      assert.match(r.text, /larger than/);
    });
    test('absolute paths are used as given', async () => {
      const r = await run('read', { path: path.join(ws, 'README.md') });
      assert.equal(r.text.split('\n')[0], '1\t# Readme');
      assert.equal(r.details.path, path.join(ws, 'README.md'));
    });
    test('relative paths resolve against cwd', async () => {
      const r = await run('read', { path: './src/../README.md' });
      assert.equal(r.text.split('\n')[0], '1\t# Readme');
    });
    test('windows-style relative paths work on Windows', { skip: process.platform !== 'win32' }, async () => {
      const r = await run('read', { path: 'src\\a.mjs' });
      assert.equal(r.text.split('\n')[0], '1\timport x');
    });
    test('a trailing newline does not show a phantom last line', async () => {
      put('two.txt', 'a\nb\n');
      const r = await run('read', { path: 'two.txt' });
      assert.equal(r.text, '1\ta\n2\tb');
      assert.equal(r.details.totalLines, 2);
    });
  });

  describe('write', () => {
    test('creates missing parent folders and reports Created with the byte count', async () => {
      const r = await run('write', { path: 'out/x/y/new.txt', content: 'héllo' });
      assert.ok(!r.isError);
      assert.match(r.text, /^Created .*new\.txt \(6 bytes, 1 line\)$/);
      assert.equal(fs.readFileSync(path.join(ws, 'out', 'x', 'y', 'new.txt'), 'utf8'), 'héllo');
      assert.equal(r.details.diff, undefined);
      assert.equal(r.details.undo.before, null);
    });
    test('overwriting says so and carries a diff and the previous content for undo', async () => {
      put('ow.txt', 'one\ntwo\n');
      const r = await run('write', { path: 'ow.txt', content: 'one\n2\n' });
      assert.match(r.text, /^Overwrote /);
      assert.ok(r.details.diff.includes('-2|two'));
      assert.ok(r.details.diff.includes('+2|2'));
      assert.equal(r.details.firstChangedLine, 2);
      assert.equal(r.details.undo.before, 'one\ntwo\n');
    });
    test('non-string content is rejected and nothing is created', async () => {
      const r = await run('write', { path: 'bad.txt', content: 42 });
      assert.equal(r.isError, true);
      assert.ok(!fs.existsSync(path.join(ws, 'bad.txt')));
    });
    test('an empty string is valid content', async () => {
      const r = await run('write', { path: 'empty.txt', content: '' });
      assert.ok(!r.isError);
      assert.equal(fs.readFileSync(path.join(ws, 'empty.txt'), 'utf8'), '');
    });
    test('writing over a directory is an error result', async () => {
      const r = await run('write', { path: 'src', content: 'x' });
      assert.equal(r.isError, true);
    });
  });

  describe('edit', () => {
    test('replaces one unique match and returns a diff', async () => {
      put('e1.txt', 'alpha\nbeta\ngamma\n');
      const r = await run('edit', { path: 'e1.txt', old_string: 'beta', new_string: 'BETA' });
      assert.ok(!r.isError);
      assert.equal(fs.readFileSync(path.join(ws, 'e1.txt'), 'utf8'), 'alpha\nBETA\ngamma\n');
      assert.equal(r.details.op, 'update');
      assert.ok(r.details.diff.includes('+2|BETA'));
    });
    test('a non-unique match fails and leaves the file untouched', async () => {
      put('e2.txt', 'x\nfoo\nx\nfoo\n');
      const r = await run('edit', { path: 'e2.txt', old_string: 'foo', new_string: 'bar' });
      assert.equal(r.isError, true);
      assert.match(r.text, /matches 2 places/);
      assert.equal(fs.readFileSync(path.join(ws, 'e2.txt'), 'utf8'), 'x\nfoo\nx\nfoo\n');
    });
    test('replace_all replaces every match and counts them', async () => {
      put('e3.txt', 'foo foo foo');
      const r = await run('edit', { path: 'e3.txt', old_string: 'foo', new_string: 'b', replace_all: true });
      assert.ok(!r.isError);
      assert.match(r.text, /\(3 replacements\)/);
      assert.equal(fs.readFileSync(path.join(ws, 'e3.txt'), 'utf8'), 'b b b');
    });
    test('a missing match fails and leaves the file untouched', async () => {
      put('e4.txt', 'hello\n');
      const r = await run('edit', { path: 'e4.txt', old_string: 'goodbye', new_string: 'x' });
      assert.equal(r.isError, true);
      assert.match(r.text, /not found/);
      assert.equal(fs.readFileSync(path.join(ws, 'e4.txt'), 'utf8'), 'hello\n');
    });
    test('whitespace-only differences fall back to a unique whole-line match and say so', async () => {
      put('e5.txt', '  indented\n');
      const r = await run('edit', { path: 'e5.txt', old_string: 'indented\n  ', new_string: '' });
      assert.ok(!r.isError, r.text);
      assert.match(r.text, /ignoring whitespace/);
      assert.equal(fs.readFileSync(path.join(ws, 'e5.txt'), 'utf8'), '\n');
    });
    test('empty old_string and identical old/new are rejected', async () => {
      put('e6.txt', 'abc');
      assert.match((await run('edit', { path: 'e6.txt', old_string: '', new_string: 'x' })).text, /must not be empty/);
      assert.match((await run('edit', { path: 'e6.txt', old_string: 'a', new_string: 'a' })).text, /identical/);
      assert.equal(fs.readFileSync(path.join(ws, 'e6.txt'), 'utf8'), 'abc');
    });
    test('non-string arguments are rejected', async () => {
      put('e7.txt', 'abc');
      const r = await run('edit', { path: 'e7.txt', old_string: 'a' });
      assert.equal(r.isError, true);
    });
    test('replacement text is literal: $& and $1 are not expanded', async () => {
      put('e8.txt', 'price: X');
      await run('edit', { path: 'e8.txt', old_string: 'X', new_string: '$& $1 $$' });
      assert.equal(fs.readFileSync(path.join(ws, 'e8.txt'), 'utf8'), 'price: $& $1 $$');
      put('e8b.txt', 'a a');
      await run('edit', { path: 'e8b.txt', old_string: 'a', new_string: '$&$&', replace_all: true });
      assert.equal(fs.readFileSync(path.join(ws, 'e8b.txt'), 'utf8'), '$&$& $&$&');
    });
    test('a multi-line old_string matches a CRLF file and keeps CRLF line ends', async () => {
      put('crlf.txt', 'one\r\ntwo\r\nthree\r\n');
      const r = await run('edit', { path: 'crlf.txt', old_string: 'one\ntwo', new_string: 'uno\ndos' });
      assert.ok(!r.isError, r.text);
      assert.equal(fs.readFileSync(path.join(ws, 'crlf.txt'), 'utf8'), 'uno\r\ndos\r\nthree\r\n');
    });
    test('a missing file is an error result', async () => {
      const r = await run('edit', { path: 'nope.txt', old_string: 'a', new_string: 'b' });
      assert.equal(r.isError, true);
      assert.match(r.text, /No such file or folder: nope\.txt/);
    });
  });

  describe('undo', () => {
    test('undoing an edit restores the previous text', async () => {
      put('u1.txt', 'before');
      const r = await run('edit', { path: 'u1.txt', old_string: 'before', new_string: 'after' });
      const res = await T.undo(r.details.undo);
      assert.equal(res.ok, true);
      assert.equal(fs.readFileSync(path.join(ws, 'u1.txt'), 'utf8'), 'before');
    });
    test('undoing a created file removes it', async () => {
      const r = await run('write', { path: 'u2.txt', content: 'new' });
      const res = await T.undo(r.details.undo);
      assert.equal(res.ok, true);
      assert.ok(!fs.existsSync(path.join(ws, 'u2.txt')));
    });
    test('undo refuses when the file was changed afterwards', async () => {
      put('u3.txt', 'v1');
      const r = await run('edit', { path: 'u3.txt', old_string: 'v1', new_string: 'v2' });
      fs.writeFileSync(path.join(ws, 'u3.txt'), 'user edit');
      const res = await T.undo(r.details.undo);
      assert.equal(res.ok, false);
      assert.equal(fs.readFileSync(path.join(ws, 'u3.txt'), 'utf8'), 'user edit');
    });
    test('undo of a very large previous version is declined', async () => {
      const big = 'x'.repeat(600 * 1024);
      put('u4.txt', big);
      const r = await run('write', { path: 'u4.txt', content: 'small' });
      assert.equal(r.details.undo.skipped, true);
      assert.equal((await T.undo(r.details.undo)).ok, false);
      assert.equal(fs.readFileSync(path.join(ws, 'u4.txt'), 'utf8'), 'small');
    });
    test('undo of nothing is declined', async () => {
      assert.equal((await T.undo(null)).ok, false);
    });
  });

  describe('glob', () => {
    const names = async (input) => {
      const r = await run('glob', input);
      return r.text === 'No files matched.' ? [] : r.text.split('\n').sort();
    };
    test('** with a directory prefix, using / separators on every OS', async () => {
      assert.deepEqual(await names({ pattern: 'src/**/*.mjs' }), ['src/a.mjs', 'src/deep/b.mjs']);
    });
    test('a pattern without / matches file names at any depth', async () => {
      assert.deepEqual(await names({ pattern: '*.mjs' }), ['src/a.mjs', 'src/deep/b.mjs']);
    });
    test('a pattern with / is matched against the relative path only', async () => {
      assert.deepEqual(await names({ pattern: 'src/*.mjs' }), ['src/a.mjs']);
    });
    test('** matches files at the top level too', async () => {
      assert.ok((await names({ pattern: '**/README.md' })).includes('README.md'));
    });
    test('dotfiles are found but .git and node_modules are skipped', async () => {
      const all = await names({ pattern: '*' });
      assert.ok(all.includes('.env'));
      assert.ok(!all.some((f) => f.startsWith('.git/') || f.startsWith('node_modules/')));
    });
    test('? and case-insensitivity', async () => {
      assert.deepEqual(await names({ pattern: 'readme.?d' }), ['README.md']);
    });
    test('path argument scopes the search and the output is relative to it', async () => {
      assert.deepEqual(await names({ pattern: '*.mjs', path: 'src/deep' }), ['b.mjs']);
    });
    test('no match is a plain message', async () => {
      assert.equal((await run('glob', { pattern: '*.nothing' })).text, 'No files matched.');
    });
    test('results are capped at 300 with a notice', async () => {
      const r = await run('glob', { pattern: 'many/*.log' });
      const lines = r.text.split('\n');
      assert.equal(lines.length, 301);
      assert.equal(lines[300], '[showing 300 of 310 files; use a narrower pattern or path]');
    });
    test('a missing search folder is a clear error, not a crash', async () => {
      const r = await run('glob', { pattern: '*', path: 'does-not-exist' });
      assert.equal(r.isError, true);
      assert.match(r.text, /^No such folder: does-not-exist/);
    });
    test('Windows backslash in the path argument', { skip: process.platform !== 'win32' }, async () => {
      assert.deepEqual(await names({ pattern: '*.mjs', path: 'src\\deep' }), ['b.mjs']);
    });
  });

  describe('grep', () => {
    test('prints path:line: text and skips node_modules, .git, binary and over-1MiB files', async () => {
      const r = await run('grep', { pattern: 'Foo' });
      const lines = r.text.split('\n');
      assert.deepEqual(lines.filter((l) => !l.startsWith('[')), ['.env:1: SECRET=Foo', 'src/a.mjs:2: const Foo = 1', 'src/deep/c.txt:1: text Foo']); // sorted by path
      assert.match(lines.at(-1), /^\[\d+ files? over 1\.0 MB not searched\]$/);
    });
    test('ignore_case', async () => {
      const r = await run('grep', { pattern: 'foo', ignore_case: true, glob: '*.mjs' });
      assert.deepEqual(r.text.split('\n').sort(), ['src/a.mjs:2: const Foo = 1', 'src/deep/b.mjs:1: const foo = 2']);
    });
    test('case sensitive by default', async () => {
      const r = await run('grep', { pattern: 'foo', glob: '*.mjs' });
      assert.equal(r.text, 'src/deep/b.mjs:1: const foo = 2');
    });
    test('glob filter can use a relative path pattern', async () => {
      const r = await run('grep', { pattern: 'Foo', glob: 'src/**/*.txt' });
      assert.equal(r.text, 'src/deep/c.txt:1: text Foo');
    });
    test('a single file path reports its base name', async () => {
      const r = await run('grep', { pattern: 'Foo', path: 'src/a.mjs' });
      assert.equal(r.text, 'a.mjs:2: const Foo = 1');
    });
    test('\\r of CRLF files is not shown', async () => {
      const r = await run('grep', { pattern: 'let z', path: 'src/deep' });
      assert.equal(r.text, 'b.mjs:2: let z');
    });
    test('an invalid regular expression is an error result', async () => {
      const r = await run('grep', { pattern: '(unclosed' });
      assert.equal(r.isError, true);
      assert.match(r.text, /Invalid regular expression/);
    });
    test('no matches is a plain message', async () => {
      assert.equal((await run('grep', { pattern: 'zzz_not_there_zzz', path: 'src' })).text, 'No matches.');
    });
    test('matches are capped at 200 with a notice', async () => {
      const r = await run('grep', { pattern: '^x', path: 'lines/250.txt' });
      const lines = r.text.split('\n');
      assert.equal(lines.length, 201);
      assert.equal(lines[200], '[showing 200 of 250 matching lines in 1 files; narrow the pattern, path or glob, or raise limit]');
    });
    test('very long lines are clipped to 300 characters, marked with …', async () => {
      const r = await run('grep', { pattern: 'y', path: 'lines/long.txt' });
      assert.equal(r.text, `long.txt:1: ${'y'.repeat(300)}…`);
    });
    test('a missing path is an error result', async () => {
      const r = await run('grep', { pattern: 'x', path: 'missing-folder' });
      assert.equal(r.isError, true);
    });
  });

  // Glob matching (search.mjs) and makeDiff (tools.mjs) are checked through the glob and write tools.
  describe('glob pattern semantics', () => {
    const FILES = ['a/b', 'a/x/b', 'a/x/y/b', 'a/xb', 'abc', 'ac', 'abbc', 'aab', 'a.js', 'a.js.map', 'a.jsx', 'xa.jsx', '.env', '.vscode/settings.json', 'p/q/x.txt', 'x.txt', 'a.b', 'axb', 'a+b', '(x)', '[ab]', 'a{2}', 'aa', '$x^', 'README.MD'];
    before(() => {
      for (const f of FILES) put('gfix/' + f, '');
    });
    const g = async (pattern) => {
      const r = await run('glob', { pattern, path: 'gfix' });
      assert.ok(!r.isError, r.text);
      return r.text === 'No files matched.' ? [] : r.text.split('\n').sort();
    };
    test('* stays inside one path segment, ** crosses segments', async () => {
      assert.deepEqual(await g('a/*'), ['a/b', 'a/xb']);
      assert.deepEqual(await g('a/**'), ['a/b', 'a/x/b', 'a/x/y/b', 'a/xb']);
    });
    test('**/ matches zero or more directories', async () => {
      assert.deepEqual(await g('a/**/b'), ['a/b', 'a/x/b', 'a/x/y/b']);
      assert.deepEqual(await g('**/x.txt'), ['p/q/x.txt', 'x.txt']);
    });
    test('? is exactly one character and never a path separator', async () => {
      assert.deepEqual(await g('a?c'), ['abc']);
      assert.deepEqual(await g('a?b'), ['a+b', 'a.b', 'aab', 'axb']); // not a/b
    });
    test('the whole name must match and case is ignored', async () => {
      assert.deepEqual(await g('*.js'), ['a.js']);
      assert.deepEqual(await g('*.JS'), ['a.js']);
      assert.deepEqual(await g('a.js'), ['a.js']);
      assert.deepEqual(await g('readme.md'), ['README.MD']);
    });
    test('dotfiles are matched like any other file', async () => {
      assert.ok((await g('*')).includes('.env'));
      assert.deepEqual(await g('.*'), ['.env']);
      assert.deepEqual(await g('**/*.json'), ['.vscode/settings.json']);
    });
    test('regex metacharacters in a pattern are literal', async () => {
      assert.deepEqual(await g('a.b'), ['a.b']); // not axb
      assert.deepEqual(await g('a+b'), ['a+b']); // not aab
      assert.deepEqual(await g('(x)'), ['(x)']);
      assert.deepEqual(await g('[ab]'), ['[ab]']); // not a character class (would match "a/b" by its base name)
      assert.deepEqual(await g('a{2}'), ['a{2}']); // not a quantifier (would match "aa")
      assert.deepEqual(await g('$x^'), ['$x^']);
    });
    test('{a,b} is an alternation; a brace group without a comma stays literal', async () => {
      for (const f of ['br/m.ts', 'br/m.tsx', 'br/m.js', 'br/d/n.ts']) put('gfix/' + f, '1');
      assert.deepEqual(await g('br/*.{ts,tsx}'), ['br/m.ts', 'br/m.tsx']);
      assert.deepEqual(await g('br/**/*.{ts,js}'), ['br/d/n.ts', 'br/m.js', 'br/m.ts']);
      assert.deepEqual(await g('br/m.{ts}'), []); // no comma: literal braces, like a shell
    });
    test('unbalanced or odd patterns find nothing instead of failing', async () => {
      for (const p of ['[', '((', '\\', 'a{', '*(']) assert.deepEqual(await g(p), [], p);
    });
  });

  describe('diffs reported by write and edit', () => {
    let n = 0;
    const diffOf = async (before, after) => {
      const name = `diff${++n}.txt`; // a fresh file each time: write refuses files changed behind its back
      put(name, before);
      const r = await run('write', { path: name, content: after });
      assert.ok(!r.isError, r.text);
      return r.details;
    };
    test('single changed line with a line of context each side', async () => {
      const d = await diffOf('a\nb\nc', 'a\nB\nc');
      assert.equal(d.diff, ' 1|a\n-2|b\n+2|B\n 3|c');
      assert.equal(d.firstChangedLine, 2);
    });
    test('context is limited to two lines on each side', async () => {
      const old = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n');
      const d = await diffOf(old, old.replace('5', 'FIVE'));
      assert.deepEqual(d.diff.split('\n'), [' 3|3', ' 4|4', '-5|5', '+5|FIVE', ' 6|6', ' 7|7']);
    });
    test('pure addition has + lines and no - lines', async () => {
      const lines = (await diffOf('a\nb', 'a\nx\nb')).diff.split('\n');
      assert.ok(lines.includes('+2|x'));
      assert.ok(!lines.some((l) => l.startsWith('-')));
    });
    test('pure removal has - lines and no + lines', async () => {
      const lines = (await diffOf('a\nx\nb', 'a\nb')).diff.split('\n');
      assert.ok(lines.includes('-2|x'));
      assert.ok(!lines.some((l) => l.startsWith('+')));
    });
    test('identical content produces no added or removed lines', async () => {
      const lines = (await diffOf('same\ntext', 'same\ntext')).diff.split('\n');
      assert.ok(!lines.some((l) => l.startsWith('+') || l.startsWith('-')));
    });
    test('a change on the first line reports line 1', async () => {
      const d = await diffOf('x\nb', 'y\nb');
      assert.equal(d.firstChangedLine, 1);
      assert.ok(d.diff.startsWith('-1|x\n+1|y'));
    });
    test('adding a trailing newline shows an added empty last line, removing it a removed one', async () => {
      const added = (await diffOf('a\nb', 'a\nb\n')).diff.split('\n');
      assert.ok(added.includes('+3|'));
      assert.ok(!added.some((l) => l.startsWith('-')));
      const removed = (await diffOf('a\nb\n', 'a\nb')).diff.split('\n');
      assert.ok(removed.includes('-3|'));
      assert.ok(!removed.some((l) => l.startsWith('+')));
    });
    test('replacing an empty file', async () => {
      const lines = (await diffOf('', 'x\ny')).diff.split('\n');
      assert.ok(lines.includes('+1|x'));
      assert.ok(lines.includes('+2|y'));
    });
  });

  describe('bash, todo and dispatch', () => {
    test('exit code 0 output and a marker', async () => {
      const r = await run('bash', { command: 'echo hello' });
      assert.ok(!r.isError);
      assert.match(r.text, /^hello\n\[exit code 0 · \d+\.\ds\]$/);
      assert.ok(Number.isFinite(r.details.durationMs));
      assert.equal(r.details.exitCode, 0);
    });
    test('a failing command is an error result carrying the exit code', async () => {
      const r = await run('bash', { command: 'exit 3' });
      assert.equal(r.isError, true);
      assert.equal(r.details.exitCode, 3);
      assert.match(r.text, /^\[exit code 3 · \d+\.\ds\]$/);
    });
    test('an empty command is rejected', async () => {
      const r = await run('bash', { command: '   ' });
      assert.equal(r.isError, true);
    });
    test('todo drops blank items and unknown statuses become pending', async () => {
      const r = await run('todo', { todos: [{ content: ' a ', status: 'completed' }, { content: '', status: 'pending' }, { content: 'b', status: 'weird' }, null, { content: 5, status: 'pending' }] });
      assert.equal(r.text, 'Task list updated: 1/2 done.');
      assert.deepEqual(r.details.phases[0].tasks, [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }]);
    });
    test('todo requires a list', async () => {
      assert.equal((await run('todo', { todos: 'x' })).isError, true);
    });
    test('an unknown tool is an error result', async () => {
      const r = await run('format_disk', {});
      assert.equal(r.isError, true);
      assert.match(r.text, /Unknown tool "format_disk"/);
    });
    test('names inherited from Object are not tools', async () => {
      for (const n of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        const r = await run(n, {});
        assert.equal(r.isError, true, n);
      }
    });
  });
});

// =====================================================================================================
describe('webfetch: isPrivateAddress', () => {
  const { isPrivateAddress: p } = webfetch;
  const yes = (list) => list.forEach((ip) => assert.equal(p(ip), true, `${ip} should be private`));
  const no = (list) => list.forEach((ip) => assert.equal(p(ip), false, `${ip} should be public`));
  test('IPv4 loopback, this-network, private ranges', () => yes(['127.0.0.1', '127.255.255.255', '0.0.0.0', '10.0.0.1', '10.255.255.255', '192.168.0.1', '192.168.255.255', '172.16.0.1', '172.20.5.5', '172.31.255.255']));
  test('IPv4 link-local (cloud metadata), CGNAT, benchmarking, multicast', () => yes(['169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255', '198.18.0.1', '198.19.255.255', '224.0.0.1', '255.255.255.255', '192.0.0.1']));
  test('range boundaries just outside private space are public', () => no(['172.15.255.255', '172.32.0.1', '192.167.1.1', '192.169.0.1', '11.0.0.1', '9.255.255.255', '126.255.255.255', '128.0.0.1', '169.253.1.1', '169.255.0.1', '100.63.255.255', '100.128.0.1', '198.17.0.1', '198.20.0.1', '223.255.255.255']));
  test('ordinary public addresses', () => no(['8.8.8.8', '1.1.1.1', '93.184.216.34', '151.101.1.69']));
  test('IPv6 loopback, unspecified, unique-local, link-local, multicast, documentation', () => yes(['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', '2001:db8::1', '64:ff9b::7f00:1']));
  test('IPv6 is case-insensitive and bracketed forms are accepted', () => yes(['FE80::1', 'FC00::1', '[::1]', '[fe80::1]']));
  test('public IPv6', () => no(['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::200e']));
  test('IPv4-mapped IPv6, dotted and hex forms, judged by the embedded IPv4', () => {
    yes(['::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:192.168.1.1', '::ffff:7f00:1', '::ffff:a00:1', '::ffff:c0a8:101', '::ffff:ac10:1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:7f00:1', '::127.0.0.1', '[::ffff:7f00:1]']);
    no(['::ffff:8.8.8.8', '::ffff:808:808', '::ffff:ac0f:1', '::ffff:ac20:1', '0:0:0:0:0:ffff:808:808']);
  });
  test('anything that is not a canonical IP is treated as unsafe', () => yes(['example.com', 'localhost', '', null, undefined, '2130706433', '0177.0.0.1', '127.1', '0x7f.0.0.1', '1.2.3', '256.1.1.1', '8.8.8.8.8']));
});

describe('webfetch: decodeEntities', () => {
  const { decodeEntities: d } = webfetch;
  test('named entities, case-insensitive names', () => {
    assert.equal(d('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &AMP;'), 'a & b <c> "d" \'e\' &');
    assert.equal(d('&mdash;&ndash;&hellip;&copy;&trade;'), '—–…©™');
    assert.equal(d('x&nbsp;y'), 'x y');
  });
  test('numeric decimal and hex entities including astral code points', () => {
    assert.equal(d('&#65;&#x42;&#X43;&#x1F600;&#128512;'), 'ABC😀😀');
  });
  test('invalid code points and unknown names are left as written', () => {
    assert.equal(d('&#0;'), '&#0;');
    assert.equal(d('&#1114112;'), '&#1114112;');
    assert.equal(d('&#x110000;'), '&#x110000;');
    assert.equal(d('&bogus; &amp'), '&bogus; &amp');
  });
  test('decoding happens once: &amp;lt; becomes &lt; not <', () => {
    assert.equal(d('&amp;lt;script&amp;gt;'), '&lt;script&gt;');
    assert.equal(d('&amp;#65;'), '&#65;');
  });
});

describe('webfetch: htmlToText', () => {
  const { htmlToText: h } = webfetch;
  test('title is extracted and decoded; <head> content does not leak into the text', () => {
    const r = h('<html><head><title> My &amp; Page </title><meta charset=utf-8></head><body><p>Hi</p></body></html>');
    assert.equal(r.title, 'My & Page');
    assert.equal(r.text, 'Hi');
  });
  test('script, style, noscript, svg, template, iframe and comments are removed with their content', () => {
    const r = h('<body>A<script>var x="<b>evil</b>";</script>B<style>.a{color:red}</style>C<noscript>nojs</noscript>D<svg><text>vec</text></svg>E<template><p>tpl</p></template>F<iframe src=x>frame</iframe>G<!-- hidden -->H</body>');
    assert.equal(r.text.replace(/\s+/g, ''), 'ABCDEFGH');
    assert.ok(!/evil|color|nojs|vec|tpl|frame|hidden/.test(r.text));
  });
  test('tag names are case-insensitive', () => {
    const r = h('<P>x</P><SCRIPT>bad()</SCRIPT><STYLE>b{}</STYLE>');
    assert.equal(r.text, 'x');
  });
  test('markup characters that arrive as entities stay text and are not re-parsed as tags', () => {
    const r = h('<p>1 &lt; 2 &amp;&amp; &lt;script&gt;alert(1)&lt;/script&gt;</p>');
    assert.equal(r.text, '1 < 2 && <script>alert(1)</script>');
  });
  test('headings become Markdown headings, inline tags inside are stripped', () => {
    assert.equal(h('<h1>Top</h1><h3>Sub <b>bold</b></h3><p>body</p>').text, '# Top\n\n### Sub bold\n\nbody');
  });
  test('links become [text](absolute-url) using the base URL; entities in href are decoded', () => {
    const r = h('<a href="/docs?a=1&amp;b=2">Docs</a> and <a href=\'rel/x\'>rel</a>', 'https://ex.com/base/page');
    assert.equal(r.text, '[Docs](https://ex.com/docs?a=1&b=2) and [rel](https://ex.com/base/rel/x)');
  });
  test('javascript:, #fragment and empty links keep only the text', () => {
    const r = h('<a href="javascript:alert(1)">Click</a> <a href="#top">Top</a> <a href="">None</a>', 'https://ex.com/');
    assert.equal(r.text, 'Click Top None');
  });
  test('a relative link without a base URL keeps only the text', () => {
    assert.equal(h('<a href="/x">Go</a>').text, 'Go');
  });
  test('list items become "- " lines', () => {
    const lines = h('<ul><li>one</li><li>two <b>2</b></li></ul>').text.split('\n').filter(Boolean);
    assert.deepEqual(lines, ['- one', '- two 2']);
  });
  test('table cells are separated by " | "', () => {
    assert.match(h('<table><tr><td>a</td><td>b</td></tr></table>').text, /^a \| b \|$/);
  });
  test('code blocks are fenced and their line structure kept', () => {
    const r = h('<p>before</p><pre><code>line1\nline2</code></pre><p>after</p>');
    assert.equal(r.text.replace(/\n{3,}/g, '\n\n'), 'before\n\n```\nline1\nline2\n```\n\nafter');
  });
  test('tags inside code blocks are dropped and entities decoded', () => {
    const r = h('<pre>if (a &lt; b) <span class="k">return</span></pre>');
    assert.ok(r.text.includes('if (a < b) return'));
  });
  test('indentation inside code blocks is preserved', () => {
    const r = h('<pre>def f():\n    return 1</pre>');
    assert.ok(r.text.includes('\n    return 1'), JSON.stringify(r.text));
  });
  test('nav, footer and aside are dropped when there is no main content marker', () => {
    const r = h('<nav>MENU</nav><p>Real</p><footer>FOOT</footer><aside>SIDE</aside>');
    assert.equal(r.text, 'Real');
  });
  test('a substantial <main> is preferred over the rest of the page', () => {
    const body = 'Content paragraph. '.repeat(40);
    const r = h(`<div>Sidebar junk</div><main><p>${body}</p></main><div>Cookie banner</div>`);
    assert.ok(r.text.startsWith('Content paragraph.'));
    assert.ok(!/Sidebar|Cookie/.test(r.text));
  });
  test('blank lines collapse and whitespace is normalised', () => {
    const r = h('<p>a</p>\n\n\n\n<p>b   \t  c</p><br><br><br><br><p>d</p>');
    assert.ok(!/\n{3,}/.test(r.text));
    assert.ok(r.text.includes('b c'));
  });
  test('non-string input and empty documents do not crash', () => {
    assert.deepEqual(h(''), { title: '', text: '' });
    assert.equal(h(null).text, 'null');
  });
});

// =====================================================================================================
describe('providers: thinking levels and effort mapping', () => {
  const { thinkingLevels, mapEffort, nearestEffort, thinkingStyle, defaultMaxTokens, LEVELS, presetById, PRESETS } = providers;

  test('mapEffort without a list maps onto low/medium/high', () => {
    assert.equal(mapEffort('low'), 'low');
    assert.equal(mapEffort('medium', []), 'medium');
    assert.equal(mapEffort('high', null), 'high');
    assert.equal(mapEffort('minimal'), 'low');
    assert.equal(mapEffort('xhigh'), 'high');
    assert.equal(mapEffort('off'), null);
    assert.equal(mapEffort('max'), null);
  });
  test('mapEffort with a list only returns what the model accepts', () => {
    assert.equal(mapEffort('low', ['low', 'high']), 'low');
    assert.equal(mapEffort('medium', ['low', 'high']), null);
    assert.equal(mapEffort('xhigh', ['low', 'high', 'max']), 'max');
    assert.equal(mapEffort('xhigh', ['low', 'high']), null);
    assert.equal(mapEffort('xhigh', ['low', 'xhigh', 'max']), 'xhigh');
    assert.equal(mapEffort('minimal', ['low', 'high']), null);
  });
  test('nearestEffort always returns something usable', () => {
    assert.equal(nearestEffort('xhigh', ['low', 'medium', 'high']), 'high');
    assert.equal(nearestEffort('minimal', ['low', 'high']), 'low');
    assert.equal(nearestEffort('low', ['none', 'minimal']), 'minimal');
    assert.equal(nearestEffort('xhigh', ['low', 'medium', 'high', 'max']), 'max');
    assert.equal(nearestEffort('high', undefined), 'high');
    assert.equal(nearestEffort('off', undefined), 'medium');
    assert.equal(nearestEffort('medium', ['none', 'low', 'high', 'weird']), 'low'); // unknown names are ignored, "none" never chosen
  });

  test('thinkingStyle: modern Claude uses adaptive effort, older Claude a token budget, others none', () => {
    assert.deepEqual(thinkingStyle('anthropic', 'claude-opus-4-7'), { kind: 'effort', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
    assert.deepEqual(thinkingStyle('anthropic', 'claude-sonnet-4-5'), { kind: 'budget' });
    assert.deepEqual(thinkingStyle('anthropic', 'claude-3-5-haiku-latest'), { kind: 'none' });
  });
  test('thinkingStyle: an unlisted modern Claude still gets effort, an unlisted 3.7 gets a budget', () => {
    assert.deepEqual(thinkingStyle('anthropic', 'claude-sonnet-4-9'), { kind: 'effort', efforts: ['low', 'medium', 'high', 'max'] });
    assert.deepEqual(thinkingStyle('anthropic', 'claude-3-7-sonnet-20250219'), { kind: 'budget' });
    assert.deepEqual(thinkingStyle('anthropic', 'claude-unknown'), { kind: 'none' });
  });
  test('thinkingStyle: catalog reasoning flags for OpenAI-style providers', () => {
    assert.deepEqual(thinkingStyle('openai', 'gpt-4o'), { kind: 'none' });
    assert.deepEqual(thinkingStyle('openai', 'o3'), { kind: 'effort', efforts: ['low', 'medium', 'high'], toggle: false });
    assert.deepEqual(thinkingStyle('deepseek', 'deepseek-reasoner'), { kind: 'toggle' });
    assert.deepEqual(thinkingStyle('google', 'gemini-2.5-pro'), { kind: 'effort', efforts: ['minimal', 'low', 'medium', 'high'] });
  });
  test('thinkingStyle: unknown models fall back to well-known families', () => {
    assert.equal(thinkingStyle('openai', 'gpt-5-future').kind, 'effort');
    assert.equal(thinkingStyle('openai', 'o9-mini').kind, 'effort');
    assert.equal(thinkingStyle('openai', 'gpt-4.1-nano-x').kind, 'none');
    assert.equal(thinkingStyle('ollama', 'llama3').kind, 'none');
    assert.equal(thinkingStyle('openrouter', 'some/new-model').kind, 'effort');
    assert.equal(thinkingStyle('nobody', null).kind, 'none');
  });

  test('thinkingLevels always starts with off and respects what the model offers', () => {
    assert.deepEqual(thinkingLevels('openai', 'gpt-4o'), ['off']);
    assert.deepEqual(thinkingLevels('anthropic', 'claude-3-5-haiku-latest'), ['off']);
    assert.deepEqual(thinkingLevels('anthropic', 'claude-sonnet-4-5'), LEVELS);
    assert.deepEqual(thinkingLevels('anthropic', 'claude-opus-4-7'), ['off', 'low', 'medium', 'high', 'xhigh']);
    assert.deepEqual(thinkingLevels('openai', 'o3'), ['off', 'low', 'medium', 'high']);
    assert.deepEqual(thinkingLevels('openai', 'gpt-5'), ['off', 'minimal', 'low', 'medium', 'high']);
    assert.deepEqual(thinkingLevels('openai', 'gpt-5.1'), ['off', 'low', 'medium', 'high']);
    assert.deepEqual(thinkingLevels('deepseek', 'deepseek-reasoner'), ['off', 'high']);
    assert.deepEqual(thinkingLevels('openrouter', 'any/model'), LEVELS);
    assert.deepEqual(thinkingLevels('ollama', 'llama3'), ['off']);
  });
  test('thinkingLevels never throws on garbage', () => {
    assert.deepEqual(thinkingLevels(undefined, undefined), ['off']);
    assert.deepEqual(thinkingLevels(null, {}), ['off']);
  });

  test('defaultMaxTokens: catalog output limit capped at 32000, else 8192', () => {
    assert.equal(defaultMaxTokens('anthropic', 'claude-opus-4-7'), 32000);
    assert.equal(defaultMaxTokens('openai', 'gpt-4o'), 16384);
    assert.equal(defaultMaxTokens('anthropic', 'claude-3-5-haiku-latest'), 8192);
    assert.equal(defaultMaxTokens('openai', 'model-nobody-knows'), 8192);
    assert.equal(defaultMaxTokens('custom', undefined), 8192);
  });

  test('presets: unique ids, lookup works, every non-custom preset has an https/localhost base URL', () => {
    assert.equal(new Set(PRESETS.map((x) => x.id)).size, PRESETS.length);
    assert.equal(presetById('anthropic').type, 'anthropic');
    assert.equal(presetById('nope'), undefined);
    for (const x of PRESETS) {
      assert.ok(['anthropic', 'openai'].includes(x.type), x.id);
      if (x.id !== 'custom') assert.match(x.baseUrl, x.local ? /^http:\/\/localhost:\d+\/v1$/ : /^https:\/\//, x.id);
    }
  });
});

describe('providers: withRetries', () => {
  const { withRetries } = providers;
  const retryable = (msg, extra = {}) => Object.assign(new Error(msg), { retryable: true, retryAfterMs: 0, ...extra });

  test('retries a retryable failure and then succeeds, announcing the retry', async () => {
    let n = 0;
    const events = await collect(
      withRetries(async function* () {
        n++;
        yield { type: 'start' };
        if (n < 3) throw retryable('boom ' + n);
        yield { type: 'text', index: 0, text: 'ok' };
        yield { type: 'stop', reason: 'end_turn' };
      }),
    );
    assert.equal(n, 3);
    const retries = events.filter((e) => e.type === 'retry');
    assert.deepEqual(retries.map((r) => [r.attempt, r.reason]), [[2, 'boom 1'], [3, 'boom 2']]);
    assert.ok(retries.every((r) => r.delayMs >= 250));
    assert.deepEqual(events.filter((e) => e.type === 'text'), [{ type: 'text', index: 0, text: 'ok' }]);
  });
  test('gives up after 4 attempts and throws the last error', async () => {
    let n = 0;
    const seen = [];
    await assert.rejects(
      async () => {
        for await (const ev of withRetries(() => {
          n++;
          return (async function* () {
            throw retryable('still down ' + n);
          })();
        })) seen.push(ev);
      },
      /still down 4/,
    );
    assert.equal(n, 4);
    assert.equal(seen.filter((e) => e.type === 'retry').length, 3);
  });
  test('a non-retryable error is thrown at once, with no retry event', async () => {
    let n = 0;
    const seen = [];
    await assert.rejects(
      async () => {
        for await (const ev of withRetries(() => {
          n++;
          return (async function* () {
            throw Object.assign(new Error('bad key'), { retryable: false, status: 401 });
          })();
        })) seen.push(ev);
      },
      /bad key/,
    );
    assert.equal(n, 1);
    assert.deepEqual(seen, []);
  });
  test('errors without a retryable flag are not retried', async () => {
    let n = 0;
    await assert.rejects(async () => {
      for await (const _ of withRetries(() => (n++, (async function* () { throw new Error('plain'); })()))) void _;
    }, /plain/);
    assert.equal(n, 1);
  });
  test('once content was yielded a failure is not retried (it would duplicate output)', async () => {
    let n = 0;
    await assert.rejects(async () => {
      for await (const _ of withRetries(() => (n++, (async function* () { yield { type: 'text', index: 0, text: 'partial' }; throw retryable('cut'); })()))) void _;
    }, /cut/);
    assert.equal(n, 1);
  });
  test('start and usage events alone do not block a retry', async () => {
    let n = 0;
    const events = await collect(
      withRetries(() => (n++, (async function* () {
        yield { type: 'start' };
        yield { type: 'usage', input: 5, output: 0 };
        if (n === 1) throw retryable('early');
        yield { type: 'text', index: 0, text: 'fine' };
      })())),
    );
    assert.equal(n, 2);
    assert.ok(events.some((e) => e.type === 'retry'));
  });
  test('a provider asking for more than 60 s makes the error surface instead of hanging', async () => {
    let n = 0;
    await assert.rejects(async () => {
      for await (const _ of withRetries(() => (n++, (async function* () { throw retryable('slow down', { retryAfterMs: 61000 }); })()))) void _;
    }, /slow down/);
    assert.equal(n, 1);
  });
  test('retry-after is honoured (floored at 250 ms)', async () => {
    let n = 0;
    const events = await collect(withRetries(() => (n++, (async function* () { if (n === 1) throw retryable('r', { retryAfterMs: 300 }); yield { type: 'stop', reason: 'end_turn' }; })())));
    assert.equal(events.find((e) => e.type === 'retry').delayMs, 300);
  });
  test('an aborted signal stops retrying and rethrows the original error', async () => {
    const ac = new AbortController();
    let n = 0;
    await assert.rejects(async () => {
      for await (const _ of withRetries(() => (n++, (async function* () { ac.abort(); throw retryable('net down'); })()), ac.signal)) void _;
    }, /net down/);
    assert.equal(n, 1);
  });
  test('aborting during the wait rejects promptly', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    await assert.rejects(async () => {
      for await (const ev of withRetries(() => (async function* () { throw retryable('x', { retryAfterMs: 30000 }); })(), ac.signal)) if (ev.type === 'retry') setTimeout(() => ac.abort(new Error('user stop')), 20);
    }, /user stop/);
    assert.ok(Date.now() - t0 < 5000);
  });
});

describe('providers: clientFor end to end with a stubbed network', () => {
  const { clientFor } = providers;
  const reqBody = () => JSON.parse(fetchCalls.at(-1).init.body);

  test('openai: derives provider from base URL, maps thinking to the nearest supported effort, defaults max tokens from the catalog', async () => {
    fetchHandler = async () =>
      sse([
        { data: { choices: [{ delta: { content: 'Hel' } }] } },
        { data: { choices: [{ delta: { content: 'lo' } }] } },
        { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"pa' } }] } }] } },
        { data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] } },
        { data: { choices: [{ delta: {}, finish_reason: 'tool_calls' }] } },
        { data: { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } } },
        'data: [DONE]\n\n',
      ]);
    const tools = [{ name: 'read', description: 'Read', input_schema: { type: 'object' } }];
    const msg = await subagent.collectTurn(clientFor('openai').stream({ apiKey: 'sk-1', baseUrl: 'https://api.openai.com/v1/', model: 'o3', thinking: 'xhigh', system: 'SYS', messages: [u('hi')], tools }));
    const c = fetchCalls.at(-1);
    assert.equal(c.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(c.init.headers.authorization, 'Bearer sk-1');
    const b = reqBody();
    assert.equal(b.max_completion_tokens, 32000);
    assert.equal(b.max_tokens, undefined);
    assert.equal(b.reasoning_effort, 'high');
    assert.equal(b.stream, true);
    assert.deepEqual(b.messages[0], { role: 'system', content: 'SYS' });
    assert.deepEqual(b.messages[1], { role: 'user', content: 'hi' });
    assert.deepEqual(b.tools, [{ type: 'function', function: { name: 'read', description: 'Read', parameters: { type: 'object' } } }]);
    assert.equal(msg.content[0].text, 'Hello');
    assert.deepEqual(msg.content[1], { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a.txt' } });
    assert.deepEqual(msg.usage, { input: 60, output: 20, cacheRead: 40, cacheWrite: 0 }); // input excludes cached tokens
    assert.equal(msg.stopReason, 'toolUse');
  });

  test('openai: thinking off sends no effort unless the model has a "none" level', async () => {
    fetchHandler = async () => sse(['data: [DONE]\n\n']);
    await collect(clientFor('openai').stream({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'o3', thinking: 'off', messages: [u('x')] }));
    assert.equal('reasoning_effort' in reqBody(), false);
    await collect(clientFor('openai').stream({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.1', thinking: 'off', messages: [u('x')] }));
    assert.equal(reqBody().reasoning_effort, 'none');
  });

  test('openai: an explicit maxTokens wins; invalid values fall back to the default', async () => {
    fetchHandler = async () => sse(['data: [DONE]\n\n']);
    await collect(clientFor('openai').stream({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', maxTokens: 1234, messages: [u('x')] }));
    assert.equal(reqBody().max_completion_tokens, 1234);
    await collect(clientFor('openai').stream({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', maxTokens: -5, messages: [u('x')] }));
    assert.equal(reqBody().max_completion_tokens, 16384);
  });

  test('anthropic: adaptive thinking with effort, headers, prompt-cache markers, event assembly', async () => {
    fetchHandler = async () =>
      sse([
        { event: 'message_start', data: { message: { usage: { input_tokens: 10, cache_read_input_tokens: 5 } } } },
        { event: 'content_block_start', data: { index: 0, content_block: { type: 'thinking', thinking: '' } } },
        { event: 'content_block_delta', data: { index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } } },
        { event: 'content_block_delta', data: { index: 0, delta: { type: 'signature_delta', signature: 'abc' } } },
        { event: 'content_block_delta', data: { index: 0, delta: { type: 'signature_delta', signature: 'def' } } },
        { event: 'content_block_stop', data: { index: 0 } },
        { event: 'content_block_start', data: { index: 1, content_block: { type: 'text', text: '' } } },
        { event: 'content_block_delta', data: { index: 1, delta: { type: 'text_delta', text: 'Answer' } } },
        { event: 'content_block_stop', data: { index: 1 } },
        { event: 'content_block_start', data: { index: 2, content_block: { type: 'tool_use', id: 'tu1', name: 'read' } } },
        { event: 'content_block_delta', data: { index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } } },
        { event: 'content_block_delta', data: { index: 2, delta: { type: 'input_json_delta', partial_json: '"x"}' } } },
        { event: 'content_block_stop', data: { index: 2 } },
        { event: 'message_delta', data: { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } } },
      ]);
    const tools = [{ name: 'a', description: '', input_schema: {} }, { name: 'b', description: '', input_schema: {} }];
    const msg = await subagent.collectTurn(clientFor('anthropic').stream({ apiKey: 'ak', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-4-7', thinking: 'xhigh', system: 'SYS', messages: [u('hi')], tools }));
    const c = fetchCalls.at(-1);
    assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(c.init.headers['x-api-key'], 'ak');
    assert.equal(c.init.headers['anthropic-version'], '2023-06-01');
    const b = reqBody();
    assert.deepEqual(b.thinking, { type: 'adaptive', display: 'summarized' });
    assert.deepEqual(b.output_config, { effort: 'xhigh' });
    assert.equal(b.max_tokens, 32000);
    assert.deepEqual(b.system, [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
    assert.equal(b.tools[0].cache_control, undefined);
    assert.deepEqual(b.tools[1].cache_control, { type: 'ephemeral' });
    assert.equal('temperature' in b, false);
    assert.deepEqual(msg.content[0], { type: 'thinking', thinking: 'hmm', thinkingSignature: 'abcdef' });
    assert.equal(msg.content[1].text, 'Answer');
    assert.deepEqual(msg.content[2], { type: 'toolCall', id: 'tu1', name: 'read', arguments: { path: 'x' } });
    assert.deepEqual(msg.usage, { input: 10, output: 42, cacheRead: 5, cacheWrite: 0 });
    assert.equal(msg.stopReason, 'toolUse');
  });

  test('anthropic: budget models get budget_tokens below max_tokens; thinking off sends no thinking block', async () => {
    fetchHandler = async () => sse([{ event: 'message_stop', data: {} }]);
    await collect(clientFor('anthropic').stream({ apiKey: 'k', model: 'claude-sonnet-4-5', thinking: 'medium', messages: [u('x')] }));
    let b = reqBody();
    assert.deepEqual(b.thinking, { type: 'enabled', budget_tokens: 8192 });
    assert.ok(b.max_tokens > b.thinking.budget_tokens);
    await collect(clientFor('anthropic').stream({ apiKey: 'k', model: 'claude-sonnet-4-5', thinking: 'off', messages: [u('x')] }));
    b = reqBody();
    assert.equal('thinking' in b, false);
  });

  test('anthropic: messages go through toAnthropicMessages (empty assistant turns dropped)', async () => {
    fetchHandler = async () => sse([{ event: 'message_stop', data: {} }]);
    await collect(clientFor('anthropic').stream({ apiKey: 'k', model: 'claude-3-5-haiku-latest', messages: [u('a'), { role: 'assistant', content: [] }, u('b')] }));
    assert.deepEqual(reqBody().messages.map((m) => m.role), ['user', 'user']);
  });

  test('a retryable HTTP failure is retried transparently', async () => {
    let n = 0;
    fetchHandler = async () => {
      n++;
      if (n === 1) return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 529, headers: { 'retry-after-ms': '0' } });
      return sse([{ data: { choices: [{ delta: { content: 'ok' } }] } }, { data: { choices: [{ delta: {}, finish_reason: 'stop' }] } }]);
    };
    const events = await collect(clientFor('openai').stream({ apiKey: 'k', baseUrl: 'https://api.x.ai/v1', model: 'grok', messages: [u('x')] }));
    assert.equal(n, 2);
    assert.equal(events.filter((e) => e.type === 'retry').length, 1);
    assert.equal(events.find((e) => e.type === 'text').text, 'ok');
  });

  test('listModels falls back to the catalog on 404/405, rethrows other errors', async () => {
    const client = clientFor('openai');
    for (const status of [404, 405]) {
      fetchHandler = async () => new Response('nope', { status });
      const rows = await client.listModels({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1' });
      assert.deepEqual(rows.map((r) => r.id).sort(), ['gpt-4o', 'gpt-5', 'gpt-5.1', 'o3']);
    }
    fetchHandler = async () => new Response('{"error":"x"}', { status: 500 });
    await assert.rejects(() => client.listModels({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1' }), (e) => e.status === 500);
    fetchHandler = async () => new Response('nope', { status: 404 });
    await assert.rejects(() => client.listModels({ apiKey: 'k', baseUrl: 'http://localhost:9/v1' }), (e) => e.status === 404); // no catalog for an unknown provider
  });

  test('listModels returns the provider list, hits /models, and strips trailing slashes', async () => {
    fetchHandler = async () => new Response(JSON.stringify({ data: [{ id: 'z-model' }, { id: 'a-model' }] }), { status: 200 });
    const rows = await clientFor('openai').listModels({ apiKey: 'k', baseUrl: 'https://api.mistral.ai/v1//' });
    assert.equal(fetchCalls.at(-1).url, 'https://api.mistral.ai/v1/models');
    assert.deepEqual(rows.map((r) => r.id), ['a-model', 'z-model']);
  });

  test('a connection failure is reported as a retryable, readable error', async () => {
    fetchHandler = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };
    await assert.rejects(() => collect(openai.streamTurn({ apiKey: 'k', baseUrl: 'http://localhost:1/v1', model: 'm', messages: [u('x')] })), (e) => e.retryable === true && /Cannot reach .*ECONNREFUSED/.test(e.message));
  });
});

// =====================================================================================================
describe('anthropic: pure helpers', () => {
  const { retryAfterMs, isForeignSignature, toAnthropicMessages, httpError, buildBody, parseSSE, streamError } = anthropic;
  const H = (o) => new Headers(o);

  test('a stream that ends without a stop reason is a lost connection, not a finished reply', async () => {
    const start = { event: 'message_start', data: { message: { usage: { input_tokens: 1 } } } };
    const text = [{ event: 'content_block_start', data: { index: 0, content_block: { type: 'text', text: '' } } }, { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'Half' } } }];
    fetchHandler = async () => sse([start, ...text]);
    await assert.rejects(() => collect(anthropic.streamTurn({ apiKey: 'k', model: 'm', messages: [u('x')] })), (e) => /Connection lost/.test(e.message) && e.retryable === true);
    fetchHandler = async () => sse([start, ...text, { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } }]);
    const evs = await collect(anthropic.streamTurn({ apiKey: 'k', model: 'm', messages: [u('x')] }));
    assert.equal(evs.at(-1).reason, 'end_turn');
    fetchHandler = async () => sse([start, { event: 'message_stop', data: {} }]);
    assert.ok(await collect(anthropic.streamTurn({ apiKey: 'k', model: 'm', messages: [u('x')] })));
    const ctl = new AbortController();
    ctl.abort();
    fetchHandler = async () => sse([start]);
    assert.ok(await collect(anthropic.streamTurn({ apiKey: 'k', model: 'm', messages: [u('x')], signal: ctl.signal })), 'a stop by the user is not an error');
  });

  test('retryAfterMs: milliseconds header, seconds, HTTP date, junk', () => {
    assert.equal(retryAfterMs(H({ 'retry-after-ms': '1500' })), 1500);
    assert.equal(retryAfterMs(H({ 'retry-after': '3' })), 3000);
    assert.equal(retryAfterMs(H({ 'retry-after': '0' })), 0);
    assert.equal(retryAfterMs(H({ 'retry-after-ms': '0', 'retry-after': '9' })), 0); // the -ms header wins
    assert.equal(retryAfterMs(H({ 'retry-after-ms': '-5', 'retry-after': '2' })), 2000); // invalid -ms falls through
    assert.equal(retryAfterMs(H({ 'retry-after': '-4' })), 0); // never negative
    assert.ok(Number.isNaN(retryAfterMs(H({}))));
    assert.ok(Number.isNaN(retryAfterMs(H({ 'retry-after': 'soon' }))));
    assert.ok(Number.isNaN(retryAfterMs(null)));
    assert.ok(Number.isNaN(retryAfterMs(undefined)));
    assert.ok(Number.isNaN(retryAfterMs({})));
  });
  test('retryAfterMs: HTTP dates are relative to now and never negative', () => {
    const future = retryAfterMs(H({ 'retry-after': new Date(Date.now() + 10000).toUTCString() }));
    assert.ok(future > 7000 && future <= 10000, String(future));
    assert.equal(retryAfterMs(H({ 'retry-after': new Date(Date.now() - 60000).toUTCString() })), 0);
  });

  test('isForeignSignature recognises only our own oc:/gx: tags', () => {
    assert.equal(isForeignSignature('oc:[{}]'), true);
    assert.equal(isForeignSignature('gx:{}'), true);
    assert.equal(isForeignSignature('EuYBCkQYAiJA...'), false);
    assert.equal(isForeignSignature('oc'), false);
    assert.equal(isForeignSignature('xoc:1'), false);
    assert.equal(isForeignSignature(''), false);
  });

  describe('toAnthropicMessages', () => {
    test('user text, plain-string content, and images', () => {
      const out = toAnthropicMessages([
        { role: 'user', content: 'plain string' },
        u('hello'),
        { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }, { type: 'image', data: 'REVG' }, { type: 'image' }] },
      ]);
      assert.deepEqual(out[0], { role: 'user', content: [{ type: 'text', text: 'plain string' }] });
      assert.deepEqual(out[1], { role: 'user', content: [{ type: 'text', text: 'hello' }] });
      assert.deepEqual(out[2].content, [
        { type: 'text', text: 'see' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'REVG' } }, // default mime; image without data dropped
      ]);
    });
    test('empty user messages and empty assistant turns are dropped', () => {
      const out = toAnthropicMessages([{ role: 'user', content: [] }, { role: 'user', content: [{ type: 'text', text: '' }] }, { role: 'assistant', content: [] }, { role: 'assistant', content: [{ type: 'text', text: '' }] }, { role: 'assistant' }, u('kept')]);
      assert.deepEqual(out, [{ role: 'user', content: [{ type: 'text', text: 'kept' }] }]);
    });
    test('tool calls become tool_use and results are paired by id in a user turn', () => {
      const out = toAnthropicMessages([u('go'), { role: 'assistant', content: [{ type: 'text', text: 'on it' }, call('t1', 'read', { path: 'x' }), call('t2', 'glob')] }, result('t1', 'file body'), result('t2', '', { isError: true })]);
      assert.deepEqual(out[1].content, [{ type: 'text', text: 'on it' }, { type: 'tool_use', id: 't1', name: 'read', input: { path: 'x' } }, { type: 'tool_use', id: 't2', name: 'glob', input: {} }]);
      assert.equal(out.length, 3);
      assert.deepEqual(out[2], {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'file body', is_error: false },
          { type: 'tool_result', tool_use_id: 't2', content: '(no output)', is_error: true },
        ],
      });
    });
    test('a tool result is never merged into a real user message', () => {
      const out = toAnthropicMessages([result('t0', 'r'), u('after'), result('t1', 'r2')]);
      assert.equal(out.length, 3);
      assert.equal(out[1].content[0].type, 'text');
    });
    test('tool result text blocks are joined; images follow the text as image blocks', () => {
      const out = toAnthropicMessages([{ role: 'toolResult', toolCallId: 't', content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }] }]);
      assert.deepEqual(out[0].content[0].content, [{ type: 'text', text: 'a\nb' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }]);
      const plain = toAnthropicMessages([{ role: 'toolResult', toolCallId: 't', content: [{ type: 'text', text: 'only text' }] }]);
      assert.equal(plain[0].content[0].content, 'only text');
    });
    test('signed thinking is sent back unchanged; unsigned, empty-signature and foreign thinking is dropped', () => {
      const out = toAnthropicMessages([
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'kept', thinkingSignature: 'SIG' },
            { type: 'thinking', thinking: 'no sig' },
            { type: 'thinking', thinking: 'empty sig', thinkingSignature: '' },
            { type: 'thinking', thinking: 'other', thinkingSignature: 'oc:[{"type":"x"}]' },
            { type: 'thinking', thinking: '', thinkingSignature: 'RED', redacted: true },
            { type: 'text', text: 'answer' },
          ],
        },
      ]);
      assert.deepEqual(out[0].content, [{ type: 'thinking', thinking: 'kept', signature: 'SIG' }, { type: 'redacted_thinking', data: 'RED' }, { type: 'text', text: 'answer' }]);
    });
    test('an assistant turn that only had unsigned thinking disappears entirely', () => {
      assert.deepEqual(toAnthropicMessages([{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] }]), []);
    });
    test('compaction markers and unknown roles are ignored', () => {
      assert.deepEqual(toAnthropicMessages([{ role: 'compactionSummary', summary: 's' }, { role: '_internal' }]), []);
    });
    test('does not mutate its input', () => {
      const input = [u('a'), { role: 'assistant', content: [call('t1')] }, result('t1', 'r')];
      const snapshot = JSON.stringify(input);
      toAnthropicMessages(input);
      assert.equal(JSON.stringify(input), snapshot);
    });
  });

  describe('buildBody', () => {
    test('budget thinking: budget >= 1024, below max_tokens, and max_tokens within the model output limit', () => {
      for (const maxOutput of [null, 64000, 10000, 4096, 2000]) {
        for (const thinking of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
          const b = buildBody({ model: 'm', messages: [], maxTokens: 8192, thinking, style: { kind: 'budget' }, maxOutput });
          assert.ok(b.thinking.budget_tokens >= 1024, `${maxOutput}/${thinking}`);
          assert.ok(b.thinking.budget_tokens < b.max_tokens, `${maxOutput}/${thinking}`);
          if (maxOutput && maxOutput >= 2048) assert.ok(b.max_tokens <= maxOutput, `${maxOutput}/${thinking}: ${b.max_tokens}`);
        }
      }
    });
    test('without thinking nothing thinking-related is sent; tools and system get cache markers only on the last tool', () => {
      const b = buildBody({ model: 'm', system: 'S', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'a' }, { name: 'b' }] });
      assert.equal(b.thinking, undefined);
      assert.equal(b.output_config, undefined);
      assert.equal(b.stream, true);
      assert.equal(b.max_tokens, 8192);
      assert.equal(b.tools[0].cache_control, undefined);
      assert.ok(b.tools[1].cache_control);
    });
    test('no system and no tools means no such keys', () => {
      const b = buildBody({ model: 'm', messages: [], tools: [] });
      assert.equal('system' in b, false);
      assert.equal('tools' in b, false);
    });
  });

  describe('httpError', () => {
    const err = (status, body, headers) => httpError(new Response(body, { status, headers }));
    test('401/403: key rejected, not retryable', async () => {
      const e = await err(401, JSON.stringify({ error: { message: 'invalid x-api-key' } }));
      assert.equal(e.message, 'The API key was rejected (401): invalid x-api-key');
      assert.equal(e.retryable, false);
      assert.equal(e.status, 401);
      assert.equal((await err(403, '')).message, 'The API key was rejected (403)');
    });
    test('429 is retryable and carries retry-after', async () => {
      const e = await err(429, '{}', { 'retry-after': '2' });
      assert.equal(e.retryable, true);
      assert.equal(e.retryAfterMs, 2000);
      assert.match(e.message, /^Rate limited \(429\)/);
    });
    test('out-of-credit 429s are not retryable', async () => {
      for (const msg of ['You exceeded your current quota', 'insufficient_quota', 'Your credit balance is too low', 'check billing details']) {
        const e = await err(429, JSON.stringify({ error: { message: msg } }));
        assert.equal(e.retryable, false, msg);
      }
    });
    test('5xx, 529, 408 are retryable; other 4xx are not', async () => {
      for (const s of [408, 500, 502, 503, 504, 529]) assert.equal((await err(s, '')).retryable, true, String(s));
      for (const s of [400, 404, 413, 422]) assert.equal((await err(s, '')).retryable, false, String(s));
      assert.match((await err(529, '')).message, /overloaded/);
    });
    test('detail comes from JSON error shapes or the raw text, and is clipped', async () => {
      assert.match((await err(400, JSON.stringify({ error: 'plain string error' }))).message, /: plain string error$/);
      assert.match((await err(400, JSON.stringify({ message: 'top-level' }))).message, /: top-level$/);
      assert.match((await err(502, '<html>Bad Gateway</html>')).message, /: <html>Bad Gateway<\/html>$/);
      const long = await err(500, 'x'.repeat(5000));
      assert.ok(long.message.length < 400);
    });
  });

  describe('parseSSE and streamError', () => {
    const streamOf = (chunks) => new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } });
    const enc = new TextEncoder();
    test('events split across chunks, CRLF, comments, multi-line data and default event name', async () => {
      const body = streamOf([enc.encode('event: a\ndata: {"x"'), enc.encode(':1}\n'), enc.encode('\n: keepalive\n\ndata: l1\ndata: l2\r\n\r\nevent: z\r\ndata: end\r\n\r\n')]);
      const evs = await collect(parseSSE(body));
      assert.deepEqual(evs, [{ event: 'a', data: '{"x":1}' }, { event: 'message', data: 'l1\nl2' }, { event: 'z', data: 'end' }]);
    });
    test('a multi-byte character split across chunks is decoded intact', async () => {
      const bytes = enc.encode('data: caf\u00e9 \u20ac\n\n');
      const cut = bytes.indexOf(0xe2) + 1; // inside the euro sign
      const evs = await collect(parseSSE(streamOf([bytes.slice(0, cut), bytes.slice(cut)])));
      assert.deepEqual(evs, [{ event: 'message', data: 'caf\u00e9 \u20ac' }]);
    });
    test('a last event without the closing blank line is still delivered', async () => {
      assert.deepEqual(await collect(parseSSE(streamOf([enc.encode('data: a\n\ndata: [DONE]')]))), [{ event: 'message', data: 'a' }, { event: 'message', data: '[DONE]' }]);
      assert.deepEqual(await collect(parseSSE(streamOf([enc.encode('event: z\r\ndata: end\r\n')]))), [{ event: 'z', data: 'end' }]);
    });
    test('an event without data lines is skipped', async () => {
      assert.deepEqual(await collect(parseSSE(streamOf([enc.encode('event: ping\n\ndata: x\n\n')]))), [{ event: 'message', data: 'x' }]);
    });
    test('streamError makes connection loss retryable, but keeps user aborts and HTTP errors as they are', () => {
      const lost = streamError(Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } }));
      assert.equal(lost.retryable, true);
      assert.match(lost.message, /Connection lost: ECONNRESET/);
      const ac = new AbortController();
      ac.abort();
      const orig = new Error('aborted');
      assert.equal(streamError(orig, ac.signal), orig);
      const http = Object.assign(new Error('h'), { status: 500 });
      assert.equal(streamError(http), http);
    });
    test('a mid-stream error event surfaces as a classified error', async () => {
      fetchHandler = async () => sse([{ event: 'error', data: { error: { type: 'overloaded_error', message: 'Overloaded' } } }]);
      await assert.rejects(() => collect(anthropic.streamTurn({ apiKey: 'k', model: 'm', messages: [] })), (e) => e.status === 529 && e.retryable === true && e.message === 'Overloaded');
      fetchHandler = async () => sse([{ event: 'error', data: { error: { type: 'invalid_request_error', message: 'bad' } } }]);
      await assert.rejects(() => collect(anthropic.streamTurn({ apiKey: 'k', model: 'm', messages: [] })), (e) => e.status === 400 && e.retryable === false);
    });
  });
});

// =====================================================================================================
describe('openai: pure helpers', () => {
  const { modelRows, toOpenAIMessages, buildBody } = openai;

  describe('modelRows', () => {
    test('accepts {data}, {models}, a bare array and bare strings', () => {
      assert.deepEqual(modelRows({ data: [{ id: 'b' }, { id: 'a' }] }).map((m) => m.id), ['a', 'b']);
      assert.deepEqual(modelRows({ models: [{ name: 'x' }] }), [{ id: 'x', name: 'x' }]);
      assert.deepEqual(modelRows([{ id: 'together/model' }]), [{ id: 'together/model', name: 'together/model' }]);
      assert.deepEqual(modelRows(['s1', 's2']), [{ id: 's1', name: 's1' }, { id: 's2', name: 's2' }]);
      assert.deepEqual(modelRows(null), []);
      assert.deepEqual(modelRows({}), []);
      assert.deepEqual(modelRows('nope'), []);
    });
    test('strips the Gemini "models/" prefix, uses the display name, dedupes and sorts', () => {
      const rows = modelRows({ models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }, { id: 'models/gemini-2.5-pro' }, { id: 'abc' }] });
      assert.deepEqual(rows, [{ id: 'abc', name: 'abc' }, { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }]);
    });
    test('drops entries without a string id, and non-chat types / Mistral non-chat models', () => {
      const rows = modelRows({ data: [null, {}, { id: 5 }, { id: 'ok-1', type: 'chat' }, { id: 'emb-1', type: 'embedding' }, { id: 'img-1', type: 'image' }, { id: 'ok-2', type: 'language' }, { id: 'mistral-nochat', capabilities: { completion_chat: false } }, { id: 'ok-3', capabilities: { completion_chat: true } }] });
      assert.deepEqual(rows.map((r) => r.id), ['ok-1', 'ok-2', 'ok-3']);
    });
    test('embedding, speech, image and moderation models are hidden from the picker', () => {
      const ids = ['gpt-4o', 'text-embedding-3-small', 'whisper-1', 'tts-1', 'dall-e-3', 'gpt-image-1', 'omni-moderation-latest', 'gpt-4o-realtime-preview', 'gpt-4o-mini-transcribe', 'llama-guard-3-8b', 'gemini-2.5-flash-image', 'imagen-4', 'veo-3', 'o3'];
      assert.deepEqual(modelRows(ids.map((id) => ({ id }))).map((r) => r.id), ['gpt-4o', 'o3']);
    });
    test('ordinary chat model names that merely contain those letters are kept', () => {
      const ids = ['gpt-4o-mini', 'claude-sonnet-4-5', 'qwen3:8b', 'llama-3.3-70b', 'deepseek-chat', 'mistral-large-latest', 'meta/llama-3.1-405b-instruct'];
      assert.deepEqual(modelRows(ids.map((id) => ({ id }))).map((r) => r.id), [...ids].sort());
    });
    test('if every model looks non-chat the full list is returned rather than nothing', () => {
      assert.deepEqual(modelRows(['text-embedding-3-small', 'whisper-1']).map((r) => r.id), ['text-embedding-3-small', 'whisper-1']);
    });
  });

  describe('toOpenAIMessages', () => {
    test('text parts are joined into a string; with an image the parts array is kept', () => {
      const out = toOpenAIMessages([
        { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
        { role: 'user', content: 'plain' },
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: 'QUJD', mimeType: 'image/webp' }, { type: 'image', data: 'REVG' }, { type: 'image' }] },
      ]);
      assert.equal(out[0].content, 'a\nb');
      assert.equal(out[1].content, 'plain');
      assert.deepEqual(out[2].content, [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/webp;base64,QUJD' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,REVG' } },
      ]);
    });
    test('empty user messages are dropped', () => {
      assert.deepEqual(toOpenAIMessages([{ role: 'user', content: [] }, { role: 'user', content: [{ type: 'text', text: '' }] }]), []);
    });
    test('assistant tool calls carry JSON arguments, null content when there is no text; results are role "tool"', () => {
      const out = toOpenAIMessages([u('go'), { role: 'assistant', content: [call('c1', 'read', { path: 'x' }), call('c2', 'glob')] }, result('c1', 'body'), result('c2', '')]);
      assert.deepEqual(out[1], { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } }, { id: 'c2', type: 'function', function: { name: 'glob', arguments: '{}' } }] });
      assert.deepEqual(out[2], { role: 'tool', tool_call_id: 'c1', content: 'body' });
      assert.deepEqual(out[3], { role: 'tool', tool_call_id: 'c2', content: '(no output)' });
    });
    test('assistant text segments are concatenated; text and calls can coexist', () => {
      const out = toOpenAIMessages([{ role: 'assistant', content: [{ type: 'text', text: 'one ' }, { type: 'text', text: 'two' }, call('c1')] }]);
      assert.equal(out[0].content, 'one two');
      assert.equal(out[0].tool_calls.length, 1);
    });
    test('empty assistant turns and turns with only plain thinking are dropped', () => {
      assert.deepEqual(toOpenAIMessages([{ role: 'assistant', content: [] }, { role: 'assistant' }, { role: 'assistant', content: [{ type: 'text', text: '' }] }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }] }]), []);
    });
    test('provider tags: gx: becomes extra_content on the call, oc: becomes reasoning_details; bad JSON is ignored', () => {
      const out = toOpenAIMessages([
        { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'n', arguments: {}, thinkingSignature: 'gx:{"google":{"thought_signature":"S"}}' }, { type: 'toolCall', id: 'c2', name: 'n', arguments: {}, thinkingSignature: 'gx:{broken' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'r', thinkingSignature: 'oc:[{"type":"reasoning.text","text":"r"}]' }, { type: 'text', text: 'ans' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'r', thinkingSignature: 'oc:{bad' }] },
      ]);
      assert.deepEqual(out[0].tool_calls[0].extra_content, { google: { thought_signature: 'S' } });
      assert.equal('extra_content' in out[0].tool_calls[1], false);
      assert.deepEqual(out[1].reasoning_details, [{ type: 'reasoning.text', text: 'r' }]);
      assert.equal(out.length, 2); // the third (undecodable thinking only) is dropped
    });
    test('reasoning_content is sent back only when the provider asks for it', () => {
      const m = [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'step 1 ' }, { type: 'thinking', thinking: 'step 2' }, { type: 'text', text: 'ans' }] }];
      assert.equal('reasoning_content' in toOpenAIMessages(m)[0], false);
      assert.equal(toOpenAIMessages(m, { interleaved: 'reasoning_content' })[0].reasoning_content, 'step 1 step 2');
    });
    test('compaction markers are not sent', () => {
      assert.deepEqual(toOpenAIMessages([{ role: 'compactionSummary', summary: 's' }]), []);
    });
  });

  describe('buildBody', () => {
    const base = { model: 'm', messages: [u('x')], tools: [] };
    test('OpenAI uses max_completion_tokens, everyone else max_tokens; usage is always requested', () => {
      const o = buildBody({ ...base, providerId: 'openai', maxTokens: 100 });
      assert.equal(o.max_completion_tokens, 100);
      assert.equal('max_tokens' in o, false);
      const x = buildBody({ ...base, providerId: 'xai', maxTokens: 100 });
      assert.equal(x.max_tokens, 100);
      assert.equal('max_completion_tokens' in x, false);
      assert.deepEqual(x.stream_options, { include_usage: true });
    });
    test('system prompt is the first message; no tools key when there are no tools', () => {
      const b = buildBody({ ...base, providerId: 'xai', system: 'SYS' });
      assert.deepEqual(b.messages[0], { role: 'system', content: 'SYS' });
      assert.equal('tools' in b, false);
    });
    test('OpenRouter: reasoning object; off means effort none only for models that support a toggle', () => {
      assert.deepEqual(buildBody({ ...base, providerId: 'openrouter', thinking: 'high', style: { kind: 'effort' } }).reasoning, { effort: 'high' });
      assert.deepEqual(buildBody({ ...base, providerId: 'openrouter', thinking: 'off', style: { kind: 'toggle' } }).reasoning, { effort: 'none' });
      assert.equal('reasoning' in buildBody({ ...base, providerId: 'openrouter', thinking: 'off', style: { kind: 'effort', efforts: ['low'] } }), false);
    });
    test('toggle providers: DeepSeek/GLM/Kimi use thinking{type}, Qwen enable_thinking', () => {
      assert.deepEqual(buildBody({ ...base, providerId: 'deepseek', thinking: 'high', style: { kind: 'toggle' } }).thinking, { type: 'enabled' });
      assert.deepEqual(buildBody({ ...base, providerId: 'zai', thinking: 'off', style: { kind: 'toggle' } }).thinking, { type: 'disabled' });
      assert.equal(buildBody({ ...base, providerId: 'qwen', thinking: 'high', style: { kind: 'toggle' } }).enable_thinking, true);
      assert.equal(buildBody({ ...base, providerId: 'qwen', thinking: 'off', style: { kind: 'toggle' } }).enable_thinking, false);
    });
    test('effort style: reasoning_effort when thinking, nothing when off', () => {
      assert.equal(buildBody({ ...base, providerId: 'openai', thinking: 'medium', effort: 'medium', style: { kind: 'effort', efforts: ['low', 'medium'] } }).reasoning_effort, 'medium');
      assert.equal('reasoning_effort' in buildBody({ ...base, providerId: 'openai', thinking: 'off', style: { kind: 'effort', efforts: ['low'] } }), false);
    });
    test('budget-style models on OpenAI-compatible APIs get a clamped reasoning_effort', () => {
      assert.equal(buildBody({ ...base, providerId: 'groq', thinking: 'xhigh', style: { kind: 'budget' } }).reasoning_effort, 'high');
      assert.equal(buildBody({ ...base, providerId: 'groq', thinking: 'low', style: { kind: 'budget' } }).reasoning_effort, 'low');
    });
    test('DeepSeek, Kimi and GLM get earlier reasoning sent back even without catalog hints', () => {
      const msgs = [u('q'), { role: 'assistant', content: [{ type: 'thinking', thinking: 'why' }, { type: 'text', text: 'a' }] }];
      assert.equal(buildBody({ ...base, providerId: 'deepseek', messages: msgs }).messages[1].reasoning_content, 'why');
      assert.equal('reasoning_content' in buildBody({ ...base, providerId: 'openai', messages: msgs }).messages[1], false);
    });
  });

  describe('streamTurn event normalisation', () => {
    const turn = async (chunks, args = {}) => {
      fetchHandler = async () => sse(chunks);
      return collect(openai.streamTurn({ apiKey: 'k', baseUrl: 'https://x.test/v1', model: 'm', messages: [u('x')], ...args }));
    };
    test('finish reasons map onto Anthropic-style stop reasons', async () => {
      const map = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'end_turn' };
      for (const [finish, want] of Object.entries(map)) {
        const evs = await turn([{ data: { choices: [{ delta: { content: 'x' }, finish_reason: finish }] } }]);
        assert.equal(evs.find((e) => e.type === 'stop').reason, want, finish);
      }
    });
    test('a stream that ends without finish_reason still stops (tool_use if tools were started)', async () => {
      const evs = await turn([{ data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'n', arguments: '{}' } }] } }] } }]);
      assert.equal(evs.at(-1).reason, 'tool_use');
      assert.ok(evs.some((e) => e.type === 'block_stop' && e.index === 1000));
      const evs2 = await turn([{ data: { choices: [{ delta: { content: 'x' } }] } }]);
      assert.equal(evs2.at(-1).reason, 'end_turn');
    });
    test('reasoning text becomes thinking events; OpenRouter reasoning_details are merged into one signed block', async () => {
      const evs = await turn([
        { data: { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'He' }] } }] } },
        { data: { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'llo', signature: 'sg' }] } }] } },
        { data: { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] } },
      ]);
      assert.equal(evs.filter((e) => e.type === 'thinking').map((e) => e.text).join(''), 'Hello');
      const sig = evs.find((e) => e.type === 'signature');
      assert.ok(sig.signature.startsWith('oc:'));
      assert.deepEqual(JSON.parse(sig.signature.slice(3)), [{ type: 'reasoning.text', index: 0, text: 'Hello', signature: 'sg' }]);
    });
    test('Gemini thought signatures ride on the tool call as gx:', async () => {
      const evs = await turn([
        { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'g1', function: { name: 'n', arguments: '{}' }, extra_content: { google: { thought_signature: 'T' } } }] }, finish_reason: 'tool_calls' }] } },
      ]);
      const sig = evs.find((e) => e.type === 'signature');
      assert.equal(sig.index, 1000);
      assert.deepEqual(JSON.parse(sig.signature.slice(3)), { google: { thought_signature: 'T' } });
    });
    test('usage: OpenRouter cost passes through, cache-write tokens are separated from input', async () => {
      const evs = await turn([{ data: { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 5, cost: 0.0123, prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 200 } } } }]);
      assert.deepEqual(evs.find((e) => e.type === 'usage'), { type: 'usage', input: 500, output: 5, cacheRead: 300, cacheWrite: 200, costUsd: 0.0123 });
    });
    test('DeepSeek style cache-hit field is understood and input never goes negative', async () => {
      const evs = await turn([{ data: { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 50 } } }]);
      const us = evs.find((e) => e.type === 'usage');
      assert.equal(us.input, 0);
      assert.equal(us.cacheRead, 50);
    });
    test('a mid-stream error object is thrown with status and retryability', async () => {
      await assert.rejects(() => turn([{ data: { error: { message: 'overloaded', code: 503 } } }]), (e) => e.status === 503 && e.retryable === true);
      await assert.rejects(() => turn([{ data: { error: { message: 'bad request', code: 400 } } }]), (e) => e.status === 400 && e.retryable === false);
    });
    test('malformed JSON chunks are skipped, [DONE] ends the stream', async () => {
      const evs = await turn(['data: {not json\n\n', { data: { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] } }, 'data: [DONE]\n\n', { data: { choices: [{ delta: { content: 'after' } }] } }]);
      assert.equal(evs.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'ok');
    });
    test('a tool call without an id from the server gets a generated unique-ish id', async () => {
      const evs = await turn([{ data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'n', arguments: '{}' } }, { index: 1, function: { name: 'm', arguments: '{}' } }] } }] } }]);
      const starts = evs.filter((e) => e.type === 'tool_start');
      assert.equal(starts.length, 2);
      assert.ok(starts.every((s) => s.id));
      assert.notEqual(starts[0].id, starts[1].id);
    });
    const callsOf = (evs) => {
      const out = new Map();
      for (const e of evs) {
        if (e.type === 'tool_start') out.set(e.index, { id: e.id, name: e.name, json: '' });
        else if (e.type === 'tool_json') out.get(e.index).json += e.json;
      }
      return [...out.values()];
    };
    test('tool calls without an index are told apart by id (one whole call per chunk)', async () => {
      const evs = await turn([
        { data: { choices: [{ delta: { tool_calls: [{ id: 'a', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } }] } }] } },
        { data: { choices: [{ delta: { tool_calls: [{ id: 'b', type: 'function', function: { name: 'glob', arguments: '{"pattern":"*"}' } }] } }] } },
        { data: { choices: [{ delta: {}, finish_reason: 'tool_calls' }] } },
      ]);
      assert.deepEqual(callsOf(evs), [{ id: 'a', name: 'read', json: '{"path":"x"}' }, { id: 'b', name: 'glob', json: '{"pattern":"*"}' }]);
      assert.equal(evs.filter((e) => e.type === 'block_stop').length, 2);
    });
    test('a server that numbers every call 0 but gives each its own id still yields separate calls', async () => {
      const evs = await turn([
        { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'read', arguments: '{"path":' } }] } }] } },
        { data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] } },
        { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'b', function: { name: 'read', arguments: '{"path":"y"}' } }] } }] } },
        { data: { choices: [{ delta: {}, finish_reason: 'tool_calls' }] } },
      ]);
      assert.deepEqual(callsOf(evs), [{ id: 'a', name: 'read', json: '{"path":"x"}' }, { id: 'b', name: 'read', json: '{"path":"y"}' }]);
    });
    test('a tool name that arrives after the id and first arguments is not lost', async () => {
      const evs = await turn([
        { data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { arguments: '{"pa' } }] } }] } },
        { data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read', arguments: 'th":"x"}' } }] } }] } },
        { data: { choices: [{ delta: {}, finish_reason: 'tool_calls' }] } },
      ]);
      assert.deepEqual(callsOf(evs), [{ id: 'a', name: 'read', json: '{"path":"x"}' }]);
      const nameless = await turn([{ data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'z', function: { arguments: '{}' } }] } }] } }]);
      assert.deepEqual(callsOf(nameless), [{ id: 'z', name: '', json: '{}' }], 'a call that never gets a name still starts (and fails as an unknown tool)');
    });
    test('arguments sent as an object instead of a JSON string are serialised', async () => {
      const evs = await turn([{ data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'read', arguments: { path: 'x' } } }] }, finish_reason: 'tool_calls' }] } }]);
      assert.deepEqual(callsOf(evs), [{ id: 'a', name: 'read', json: '{"path":"x"}' }]);
    });
  });
});

// =====================================================================================================
describe('subagent: tool results', () => {
  test('clipResult keeps the start and the end with a marker that counts the omitted lines', () => {
    assert.equal(subagent.clipResult('short'), 'short');
    const text = Array.from({ length: 100 }, (_, i) => `row ${String(i).padStart(3, '0')}`).join('\n');
    const t = subagent.clipResult(text, 400);
    assert.ok(t.startsWith('row 000\n'));
    assert.ok(t.endsWith('row 099'));
    const m = /\n\[… (\d+) lines \((\d+) characters\) omitted; narrow the search or read a smaller range …\]\n/.exec(t);
    assert.ok(m);
    assert.equal(Number(m[2]), text.length - 400);
  });
  test('invalid tool arguments get the caller-provided message', async () => {
    const defs = [{ name: 'read', description: '', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
    let n = 0;
    const seen = [];
    const stream = async function* ({ messages }) {
      seen.push(messages);
      yield { type: 'start' };
      if (n++ === 0) {
        yield { type: 'tool_start', index: 0, id: 'c1', name: 'read' };
        yield { type: 'tool_json', index: 0, json: '{"path": "a' + '"x"}' };
        yield { type: 'block_stop', index: 0 };
        yield { type: 'stop', reason: 'tool_use' };
      } else {
        yield { type: 'text', index: 0, text: 'done' };
        yield { type: 'stop', reason: 'end_turn' };
      }
    };
    const r = await subagent.runTasks({ tasks: [{ task: 'look' }] }, { stream, system: 'S', toolDefs: defs, runTool: async () => ({ text: 'ran' }), idPrefix: 's', invalidArgs: (d) => `BAD ${d.name}` });
    assert.match(r.text, /done/);
    const tr = seen[1].find((m) => m.role === 'toolResult');
    assert.equal(tr.content[0].text, 'BAD read');
    assert.equal(tr.isError, true);
  });
});

describe('subagent.collectTurn: assembling a message from stream events', () => {
  const { collectTurn } = subagent;
  async function* gen(evs) {
    for (const e of evs) yield e;
  }
  test('text chunks accumulate per block index and call on.text', async () => {
    const seen = [];
    const m = await collectTurn(gen([{ type: 'text', index: 0, text: 'a' }, { type: 'text', index: 0, text: 'b' }, { type: 'text', index: 3, text: 'c' }]), { text: (t) => seen.push(t) });
    assert.deepEqual(m.content, [{ type: 'text', text: 'ab' }, { type: 'text', text: 'c' }]);
    assert.deepEqual(seen, ['a', 'b', 'c']);
  });
  test('tool JSON fragments assemble into arguments at block_stop; broken JSON is flagged', async () => {
    const m = await collectTurn(
      gen([
        { type: 'tool_start', index: 1, id: 't1', name: 'read' },
        { type: 'tool_json', index: 1, json: '{"a":' },
        { type: 'tool_json', index: 1, json: '1}' },
        { type: 'block_stop', index: 1 },
        { type: 'tool_start', index: 2, id: 't2', name: 'bash' },
        { type: 'tool_json', index: 2, json: '{"cmd": "ls' },
        { type: 'block_stop', index: 2 },
        { type: 'tool_start', index: 3, id: 't3', name: 'glob' },
        { type: 'block_stop', index: 3 },
      ]),
    );
    assert.deepEqual(m.content[0].arguments, { a: 1 });
    assert.equal(m.content[1].invalidArguments, true);
    assert.deepEqual(m.content[2].arguments, {});
  });
  test('arguments are recovered when a server never sends block_stop', async () => {
    const m = await collectTurn(gen([{ type: 'tool_start', index: 5, id: 't', name: 'n' }, { type: 'tool_json', index: 5, json: '{"x":2}' }]));
    assert.deepEqual(m.content[0].arguments, { x: 2 });
  });
  test('signatures attach to the thinking block; a signature with no preceding block creates one', async () => {
    const m = await collectTurn(gen([{ type: 'thinking', index: 0, text: 'hm' }, { type: 'signature', index: 0, signature: 'S' }, { type: 'signature', index: 7, signature: 'R', redacted: true }]));
    assert.deepEqual(m.content[0], { type: 'thinking', thinking: 'hm', thinkingSignature: 'S' });
    assert.deepEqual(m.content[1], { type: 'thinking', thinking: '', thinkingSignature: 'R', redacted: true });
  });
  test('usage: input events replace, outputIsTotal only updates output, cost is kept', async () => {
    const m = await collectTurn(gen([{ type: 'usage', input: 10, output: 1, cacheRead: 2, cacheWrite: 3 }, { type: 'usage', output: 99, outputIsTotal: true }, { type: 'usage', input: 11, output: 5, costUsd: 0.5 }]));
    assert.deepEqual(m.usage, { input: 11, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.5 });
  });
  test('stop reasons map to the internal vocabulary', async () => {
    for (const [reason, want] of [['tool_use', 'toolUse'], ['max_tokens', 'length'], ['end_turn', 'stop'], ['stop_sequence', 'stop']]) {
      assert.equal((await collectTurn(gen([{ type: 'stop', reason }]))).stopReason, want);
    }
    assert.equal((await collectTurn(gen([]))).stopReason, 'stop');
  });
  test('retry events reach on.retry and do not end up in the message', async () => {
    const seen = [];
    const m = await collectTurn(gen([{ type: 'retry', attempt: 2, delayMs: 1000, reason: 'x' }, { type: 'text', index: 0, text: 'ok' }]), { retry: (e) => seen.push(e.attempt) });
    assert.deepEqual(seen, [2]);
    assert.equal(m.content.length, 1);
  });
});

// =====================================================================================================
describe('compact: estimates, cut points, context', () => {
  const { estimateTokens, summaryText, findCut, contextMessages, contextTokens, tokenScale, lastMarker, transcript, rebuildSession, summarize } = compact;
  const marker = (summary = 'SUM') => ({ role: 'compactionSummary', summary, timestamp: 1 });

  test('compactLimit reserves the reply max_tokens, at most half the window', () => {
    assert.equal(compact.compactLimit(200000, 32000), 160000);
    assert.equal(compact.compactLimit(128000, 32000), 96000);
    assert.equal(compact.compactLimit(128000), 128000 * 0.8);
    assert.equal(compact.compactLimit(32000, 64000), 16000);
  });

  describe('estimateTokens', () => {
    test('about 3.6 characters per token, rounded up', () => {
      assert.equal(estimateTokens([u('x'.repeat(36))]), 10);
      assert.equal(estimateTokens([u('x'.repeat(37))]), 11);
      assert.equal(estimateTokens([]), 0);
    });
    test('string content is counted like text parts', () => {
      assert.equal(estimateTokens([{ role: 'user', content: 'x'.repeat(36) }]), 10);
    });
    test('each image costs a flat 1600 tokens', () => {
      assert.equal(estimateTokens([{ role: 'user', content: [{ type: 'image', data: 'x'.repeat(1e6) }] }]), 1600);
      assert.equal(estimateTokens([{ role: 'user', content: [{ type: 'image', data: 'a' }, { type: 'image', data: 'b' }] }]) >= 3200, true);
    });
    test('thinking text, tool call name and arguments, attachments and compaction summaries all count', () => {
      assert.equal(estimateTokens([{ role: 'assistant', content: [{ type: 'thinking', thinking: 'y'.repeat(36) }] }]), 10);
      const t = estimateTokens([{ role: 'assistant', content: [call('c', 'read', { path: 'p'.repeat(100) })] }]);
      assert.ok(t >= Math.ceil(100 / 3.6));
      assert.equal(estimateTokens([u('', { attachments: [{ path: 'f', text: 'z'.repeat(360) }] })]), 100);
      assert.equal(estimateTokens([marker('s'.repeat(72))]), 20);
    });
    test('missing content does not crash', () => {
      assert.equal(estimateTokens([{ role: 'assistant' }, { role: 'toolResult', content: null }]), 0);
    });
  });

  test('summaryText wraps the summary in the tags the model is told about', () => {
    const s = summaryText('Did X.');
    assert.ok(s.startsWith('<conversation-summary>\n'));
    assert.ok(s.endsWith('\nDid X.\n</conversation-summary>'));
  });

  test('lastMarker finds the newest marker or -1', () => {
    assert.equal(lastMarker([u('a')]), -1);
    assert.equal(lastMarker([marker(), u('a'), marker('2'), u('b')]), 2);
  });

  describe('findCut', () => {
    const mk = (n, len = 360) => Array.from({ length: n }, (_, i) => (i % 2 ? a('a'.repeat(len)) : u('u'.repeat(len)))); // each ~100 tokens
    test('nothing to summarize when there is at most one turn', () => {
      assert.equal(findCut([], 100), -1);
      assert.equal(findCut([u('only')], 100), -1);
    });
    test('keeps roughly keepTokens of recent history and starts the kept part on a user turn when close', () => {
      const msgs = mk(10); // u a u a u a u a u a
      assert.equal(findCut(msgs, 250), 8);
      assert.equal(msgs[8].role, 'user');
    });
    test('the last user/assistant message is always kept, even for a huge keep budget', () => {
      const msgs = mk(6);
      const cut = findCut(msgs, 1e9);
      assert.ok(cut >= 1 && cut <= 5, String(cut));
    });
    test('a tiny budget still leaves the last message uncompacted', () => {
      const msgs = mk(6);
      const cut = findCut(msgs, 1);
      assert.ok(cut <= 5);
      assert.ok(cut > 0);
    });
    test('never cuts between a tool call and its result, for any budget', () => {
      const msgs = [u('start'), { role: 'assistant', content: [call('1'), call('2')] }, result('1', 'r'.repeat(600)), result('2', 'r'.repeat(600)), { role: 'assistant', content: [call('3')] }, result('3', 'r'.repeat(300)), a('done'), u('next'), a('end')];
      for (let keep = 1; keep < 1500; keep += 7) {
        const cut = findCut(msgs, keep);
        if (cut === -1) continue;
        assert.ok(['user', 'assistant'].includes(msgs[cut].role), `keep=${keep} cut=${cut} lands on ${msgs[cut].role}`);
        assert.ok(cut >= 1);
      }
    });
    test('messages before an existing marker are never summarized again', () => {
      const msgs = [u('old'), a('old'), marker(), ...mk(6)];
      for (const keep of [1, 100, 250, 1e6]) {
        const cut = findCut(msgs, keep);
        assert.ok(cut === -1 || cut > 3, `keep=${keep} cut=${cut}`);
      }
    });
    test('only one message after a marker: nothing to cut', () => {
      assert.equal(findCut([u('x'), a('y'), marker(), u('z')], 10), -1);
    });
  });

  describe('contextMessages', () => {
    test('without a marker it is the messages themselves', () => {
      const m = [u('a'), a('b')];
      assert.deepEqual(contextMessages(m), m);
    });
    test('the summary replaces everything before the marker and is a user message', () => {
      const out = contextMessages([u('old'), a('old'), marker('S'), a('after')]);
      assert.equal(out.length, 2);
      assert.equal(out[0].role, 'user');
      assert.equal(out[0].content[0].text, summaryText('S'));
      assert.equal(out[1].content[0].text, 'after');
    });
    test('a user message right after the marker is merged into the summary turn (no two user turns in a row)', () => {
      const out = contextMessages([marker('S'), u('question'), a('ans')]);
      assert.equal(out.length, 2);
      assert.equal(out[0].role, 'user');
      assert.equal(out[0].content.length, 2);
      assert.equal(out[0].content[1].text, 'question');
    });
    test('tool calls that never got a result are removed (providers reject them)', () => {
      const out = contextMessages([u('go'), { role: 'assistant', content: [{ type: 'text', text: 'trying' }, call('done'), call('lost')] }, result('done', 'r')]);
      assert.deepEqual(out[1].content.map((c) => c.id || c.type), ['text', 'done']);
    });
    test('@file attachments are inlined as <file> blocks', () => {
      const out = contextMessages([u('look', { attachments: [{ path: 'src/a.js', text: 'CODE' }, { path: 'big.txt', text: 'BIG', truncated: true }] })]);
      assert.equal(out[0].content.length, 2);
      assert.equal(out[0].content[1].text, '<file path="src/a.js">\nCODE\n</file>\n\n<file path="big.txt" truncated="true">\nBIG\n</file>');
    });
    test('underscore-prefixed internal roles are skipped', () => {
      assert.deepEqual(contextMessages([u('a'), { role: '_note', text: 'x' }, a('b')]).map((m) => m.role), ['user', 'assistant']);
    });
    test('does not mutate the stored history', () => {
      const msgs = [u('go', { attachments: [{ path: 'p', text: 't' }] }), { role: 'assistant', content: [call('lost')] }];
      const snap = JSON.stringify(msgs);
      contextMessages(msgs);
      assert.equal(JSON.stringify(msgs), snap);
    });
  });

  describe('contextTokens and tokenScale', () => {
    test('uses the last reported usage plus an estimate of what came after', () => {
      const msgs = [u('q'), a('ans', { usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0 } }), u('x'.repeat(36))];
      assert.equal(contextTokens(msgs), 100 + 10 + 0 + 50 + 10);
    });
    test('usage from before a compaction marker is ignored', () => {
      const msgs = [u('q'), a('ans', { usage: { input: 9999, output: 1, cacheRead: 0, cacheWrite: 0 } }), marker('x'.repeat(36)), u('y'.repeat(36))];
      assert.equal(contextTokens(msgs), estimateTokens(contextMessages(msgs)));
    });
    test('without usable usage it falls back to the estimate', () => {
      const msgs = [u('x'.repeat(36)), a('y'.repeat(36), { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })];
      assert.equal(contextTokens(msgs), 20);
    });
    test('tokenScale is never below 1 and reflects system prompt overhead', () => {
      assert.equal(tokenScale([]), 1);
      const msgs = [u('x'.repeat(360)), a('y'.repeat(360), { usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } })];
      assert.ok(tokenScale(msgs) > 1);
      assert.equal(tokenScale([u('x'.repeat(3600)), a('y', { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } })]), 1);
    });
  });

  describe('transcript', () => {
    test('labels roles, tool calls and results; clips long tool output keeping its start and end', () => {
      const t = transcript([u('hello'), { role: 'assistant', content: [{ type: 'text', text: 'hi' }, call('1', 'read', { path: 'a' })] }, result('1', 'R'.repeat(2000)), result('2', 'S'.repeat(1990) + '[exit code 2]'), { role: 'toolResult', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'fail' }] }], 1e6);
      assert.ok(t.includes('USER: hello'));
      assert.ok(t.includes('ASSISTANT: hi'));
      assert.ok(t.includes('ASSISTANT CALLED read: {"path":"a"}'));
      assert.ok(t.includes(`RESULT of read: ${'R'.repeat(1000)} … [500 characters omitted] … ${'R'.repeat(500)}\n`));
      assert.ok(t.includes(' … [503 characters omitted] … ') && t.includes('S[exit code 2]'), 'the end of tool output (exit code) survives');
      assert.ok(t.includes('RESULT of bash (error): fail'));
    });
    test('earlier summaries and attachments are included; assistant errors are noted', () => {
      const t = transcript([marker('EARLIER'), u('q', { attachments: [{ path: 'f.txt', text: 'body' }] }), { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'rate limited' }], 1e6);
      assert.ok(t.includes('[Earlier summary]\nEARLIER'));
      assert.ok(t.includes('(attached file f.txt: body)'));
      assert.ok(t.includes('(error: rate limited)'));
    });
    test('when too long, the oldest part is dropped and the budget respected', () => {
      const msgs = Array.from({ length: 50 }, (_, i) => u(`message-${i} ${'x'.repeat(100)}`));
      const t = transcript(msgs, 1000);
      assert.ok(t.startsWith('[…the oldest part is omitted…]'));
      assert.ok(t.includes('message-49'));
      assert.ok(!t.includes('message-0 '));
      assert.ok(t.length <= 1000 + 60);
    });
  });

  describe('summarize', () => {
    test('returns the trimmed text of the model reply and its usage; the stream gets the transcript and no tools', async () => {
      let seen;
      const stream = (args) => {
        seen = args;
        return (async function* () {
          yield { type: 'text', index: 0, text: '  The summary.  ' };
          yield { type: 'usage', input: 7, output: 3 };
        })();
      };
      const r = await summarize({ stream, older: [u('please do X')], focus: 'the tests', contextWindow: 100000 });
      assert.equal(r.summary, 'The summary.');
      assert.equal(r.usage.input, 7);
      assert.deepEqual(seen.tools, []);
      const prompt = seen.messages[0].content[0].text;
      assert.ok(prompt.includes('USER: please do X'));
      assert.ok(prompt.includes('focus the summary on: the tests'));
    });
    test('an empty summary is an error', async () => {
      const stream = () => (async function* () { yield { type: 'text', index: 0, text: '   ' }; })();
      await assert.rejects(() => summarize({ stream, older: [u('x')] }), /empty summary/);
    });
  });

  describe('rebuildSession', () => {
    const file = path.join(TMP, 'session.jsonl');
    const lines = (...objs) => objs.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n');
    test('rebuilds messages and inserts the compaction marker before the kept tail', () => {
      fs.writeFileSync(file, lines({ type: 'message', message: u('1') }, { type: 'message', message: a('2') }, { type: 'message', message: u('3') }, { type: 'message', message: a('4') }, { type: 'compaction', summary: 'S', keptCount: 2, tokensBefore: 500, timestamp: 42, usage: { input: 1 }, cost: 0.25 }, { type: 'message', message: u('5') }));
      const { messages } = rebuildSession(file);
      assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'compactionSummary', 'user', 'assistant', 'user']);
      assert.equal(messages[2].summary, 'S');
      assert.equal(messages[2].tokensBefore, 500);
      assert.equal(messages[2].timestamp, 42);
      assert.equal(messages[2].cost, 0.25);
      assert.deepEqual(messages[2].usage, { input: 1 });
      // the model sees: [summary + first kept user turn, assistant 4, user 5]
      assert.deepEqual(contextMessages(messages).map((m) => m.role), ['user', 'assistant', 'user']);
    });
    test('keptCount larger than the history puts the marker first; zero or missing puts it last', () => {
      fs.writeFileSync(file, lines({ type: 'message', message: u('1') }, { type: 'compaction', summary: 'A', keptCount: 99 }));
      assert.deepEqual(rebuildSession(file).messages.map((m) => m.role), ['compactionSummary', 'user']);
      fs.writeFileSync(file, lines({ type: 'message', message: u('1') }, { type: 'compaction', summary: 'B' }));
      assert.deepEqual(rebuildSession(file).messages.map((m) => m.role), ['user', 'compactionSummary']);
    });
    test('engine settings are recovered, the latest wins', () => {
      fs.writeFileSync(file, lines({ type: 'thinking', level: 'low' }, { type: 'thinking', level: 'high' }, { type: 'plan', on: true }, { type: 'model', model: 'm1', provider: 'p1' }, { type: 'model', model: 'm2', provider: 'p2' }));
      const { droppedUsage, ...ex } = rebuildSession(file).extras;
      assert.deepEqual(ex, { thinkingLevel: 'high', planMode: true, model: 'm2', provider: 'p2', roles: null });
      assert.deepEqual(droppedUsage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
    });
    test('corrupt and blank lines are skipped; a missing file is an empty session', () => {
      fs.writeFileSync(file, lines('{broken', '', '   ', { type: 'message', message: u('ok') }, { type: 'message' }, { type: 'compaction', summary: 5 }, '[1,2]'));
      assert.equal(rebuildSession(file).messages.length, 1);
      const none = rebuildSession(path.join(TMP, 'absent.jsonl'));
      assert.deepEqual(none.messages, []);
      assert.deepEqual({ ...none.extras, droppedUsage: undefined }, { thinkingLevel: null, planMode: false, model: null, provider: null, roles: null, droppedUsage: undefined });
    });
  });
});

// =====================================================================================================
describe('skills', () => {
  const { parseFrontmatter: pf } = skills;

  describe('parseFrontmatter', () => {
    test('simple key/value pairs; the body is what follows the closing fence', () => {
      const r = pf('---\nname: demo\ndescription: Does things\n---\n# Body\nText');
      assert.deepEqual(r.meta, { name: 'demo', description: 'Does things' });
      assert.equal(r.body, '# Body\nText');
    });
    test('keys are lower-cased and values trimmed', () => {
      assert.deepEqual(pf('---\nName:   Spaced   \nARGUMENT-hint: [x]\n---\n').meta, { name: 'Spaced', 'argument-hint': '[x]' });
    });
    test('matching surrounding quotes are stripped; mismatched or inner quotes stay', () => {
      const r = pf('---\na: "double"\nb: \'single\'\nc: "mismatch\'\nd: say "hi" now\ne: ""\n---\n');
      assert.deepEqual(r.meta, { a: 'double', b: 'single', c: '"mismatch\'', d: 'say "hi" now', e: '' });
    });
    test('a colon inside the value is kept', () => {
      assert.equal(pf('---\ndescription: Use when: the user says "go"\n---\n').meta.description, 'Use when: the user says "go"');
    });
    test('folded (>) and literal (|) block values are joined into one line, with chomp indicators', () => {
      const text = '---\nname: x\ndescription: >\n  first line\n  second line\nother: |\n  a\n  b\nthird: >-\n  c\n  d\nlast: v\n---\nbody';
      const r = pf(text);
      assert.equal(r.meta.description, 'first line second line');
      assert.equal(r.meta.other, 'a b');
      assert.equal(r.meta.third, 'c d');
      assert.equal(r.meta.last, 'v');
      assert.equal(r.body, 'body');
    });
    test('an indented continuation after an inline value is appended', () => {
      assert.equal(pf('---\ndescription: start\n  and more\n---\n').meta.description, 'start and more');
    });
    test('a leading BOM is accepted', () => {
      const r = pf('\uFEFF---\nname: bom\n---\nbody');
      assert.equal(r.meta.name, 'bom');
      assert.equal(r.body, 'body');
    });
    test('CRLF files parse the same', () => {
      const r = pf('---\r\nname: crlf\r\ndescription: >\r\n  a\r\n  b\r\n---\r\nbody\r\n');
      assert.deepEqual(r.meta, { name: 'crlf', description: 'a b' });
      assert.equal(r.body, 'body\r\n');
    });
    test('no fence: no metadata and the text untouched', () => {
      const t = '# Just markdown\nname: not metadata\n';
      assert.deepEqual(pf(t), { meta: {}, body: t });
    });
    test('an unterminated fence is not frontmatter', () => {
      const t = '---\nname: x\nno closing fence\n';
      assert.deepEqual(pf(t), { meta: {}, body: t });
    });
    test('the fence must be at the very start', () => {
      const t = '\n---\nname: x\n---\nbody';
      assert.deepEqual(pf(t).meta, {});
    });
    test('comment lines and junk between keys are ignored', () => {
      assert.deepEqual(pf('---\n# comment\nname: n\n- list item\ndescription: d\n---\n').meta, { name: 'n', description: 'd' });
    });
    test('a later --- in the body is not mistaken for the closing fence', () => {
      const r = pf('---\nname: n\n---\nbody\n---\nmore');
      assert.equal(r.body, 'body\n---\nmore');
    });
  });

  describe('discoverSkills', () => {
    const proj = path.join(TMP, 'skillproj');
    const userSkills = path.join(DATA, 'skills');
    const write = (file, content) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    const join = (...p) => p.join('/');
    before(() => {
      write(path.join(proj, '.agents', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Project alpha\n---\nBody A');
      write(path.join(proj, '.claude', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Claude-dir alpha (loses to .agents)\n---\n');
      write(path.join(proj, '.claude', 'skills', 'beta', 'SKILL.md'), '---\ndescription: Folder name is the name\n---\nBody B');
      write(path.join(proj, '.omp', 'skills', 'My Skill', 'SKILL.md'), '---\nname: Fancy   Name\ndescription: spaces become dashes\n---\n');
      write(path.join(proj, '.omp', 'skills', 'bare', 'SKILL.md'), 'No frontmatter at all');
      write(path.join(proj, '.omp', 'skills', 'long', 'SKILL.md'), `---\nname: ${'n'.repeat(100)}\ndescription: ${'d'.repeat(900)}\n---\n`);
      write(path.join(proj, '.omp', 'skills', 'nofile', 'README.md'), 'not a skill');
      write(path.join(proj, '.omp', 'skills', 'stray.md'), 'a file, not a folder');
      write(path.join(userSkills, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: USER alpha (must lose to project)\n---\n');
      write(path.join(userSkills, 'ALPHA-case', 'SKILL.md'), '---\nname: Alpha\ndescription: duplicate by case\n---\n');
      write(path.join(userSkills, 'gamma', 'SKILL.md'), '---\nname: gamma\ndescription: User only\n---\n');
    });
    test('finds project and user skills, sorted by name, project winning on duplicate names (case-insensitive)', async () => {
      const list = await skills.discoverSkills({ hostRoot: proj, displayRoot: '/work/proj', join });
      const byName = Object.fromEntries(list.map((s) => [s.name, s]));
      assert.deepEqual(list.map((s) => s.name), [...list.map((s) => s.name)].sort((x, y) => x.localeCompare(y)));
      assert.equal(byName.alpha.description, 'Project alpha');
      assert.equal(byName.alpha.scope, 'project');
      assert.equal(list.filter((s) => s.name.toLowerCase() === 'alpha').length, 1);
      assert.equal(byName.gamma.scope, 'user');
      assert.equal(byName.gamma.description, 'User only');
    });
    test('.agents beats .claude beats .omp for the same name', async () => {
      const list = await skills.discoverSkills({ hostRoot: proj, displayRoot: '/work/proj', join });
      assert.equal(list.find((s) => s.name === 'alpha').path, '/work/proj/.agents/skills/alpha/SKILL.md');
    });
    test('the display path uses the agent-facing root; hostPath is the real file', async () => {
      const list = await skills.discoverSkills({ hostRoot: proj, displayRoot: '/work/proj', join });
      const beta = list.find((s) => s.name === 'beta');
      assert.equal(beta.path, '/work/proj/.claude/skills/beta/SKILL.md');
      assert.equal(beta.hostPath, path.join(proj, '.claude', 'skills', 'beta', 'SKILL.md'));
      assert.ok(fs.existsSync(beta.hostPath));
      const gamma = list.find((s) => s.name === 'gamma');
      assert.equal(gamma.path, path.join(userSkills, 'gamma', 'SKILL.md'));
    });
    test('without a name field the folder name is used; spaces in names become dashes; names are capped at 64', async () => {
      const list = await skills.discoverSkills({ hostRoot: proj, displayRoot: '/work/proj', join });
      const names = list.map((s) => s.name);
      assert.ok(names.includes('beta'));
      assert.ok(names.includes('bare'));
      assert.ok(names.includes('Fancy-Name'));
      assert.ok(names.includes('n'.repeat(64)));
      assert.ok(names.every((n) => n.length <= 64));
    });
    test('descriptions are capped at 500 characters and empty when absent', async () => {
      const list = await skills.discoverSkills({ hostRoot: proj, displayRoot: '/work/proj', join });
      assert.equal(list.find((s) => s.name === 'n'.repeat(64)).description.length, 500);
      assert.equal(list.find((s) => s.name === 'bare').description, '');
    });
    test('folders without SKILL.md and loose files are ignored', async () => {
      const list = await skills.discoverSkills({ hostRoot: proj, displayRoot: '/work/proj', join });
      assert.ok(!list.some((s) => /nofile|stray/.test(s.name)));
    });
    test('a project without any skill folders yields only user skills', async () => {
      const list = await skills.discoverSkills({ hostRoot: path.join(TMP, 'no-such-project'), displayRoot: '/x', join });
      assert.ok(list.every((s) => s.scope === 'user'));
      assert.ok(list.some((s) => s.name === 'gamma'));
    });
    test('skillsPrompt lists name, description and path; empty list gives an empty prompt', async () => {
      assert.equal(skills.skillsPrompt([]), '');
      const p = skills.skillsPrompt([{ name: 'a', description: 'does a', path: '/p/a/SKILL.md' }, { name: 'b', description: '', path: '/p/b/SKILL.md' }]);
      assert.ok(p.includes('- a: does a [/p/a/SKILL.md]'));
      assert.ok(p.includes('- b: (no description) [/p/b/SKILL.md]'));
    });
    test('readSkill returns the body without frontmatter', async () => {
      const list = await skills.discoverSkills({ hostRoot: proj, displayRoot: '/work/proj', join });
      assert.equal(await skills.readSkill(list.find((s) => s.name === 'alpha')), 'Body A');
      assert.equal(await skills.readSkill(list.find((s) => s.name === 'bare')), 'No frontmatter at all');
    });
  });
});

// =====================================================================================================
describe('commands and instruction files', () => {
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  describe('discoverCommands / expandCommand', () => {
    const proj = path.join(TMP, 'cmdproj');
    before(() => {
      write(path.join(proj, '.omp', 'commands', 'review.md'), '---\ndescription: Review the diff\nargument-hint: "[files]"\n---\nReview $ARGUMENTS carefully.');
      write(path.join(proj, '.claude', 'commands', 'review.md'), 'claude-dir duplicate, loses');
      write(path.join(proj, '.claude', 'commands', 'git', 'commit.md'), '# Heading is skipped\n\nWrite a commit message.\nMore.');
      write(path.join(proj, '.claude', 'commands', 'compact.md'), 'tries to override a built-in');
      write(path.join(proj, '.claude', 'commands', 'bad name.md'), 'space in name');
      write(path.join(proj, '.claude', 'commands', 'notes.txt'), 'not markdown');
      write(path.join(proj, '.claude', 'commands', 'swap.md'), 'Swap $2 and $1, ignore $9.');
      write(path.join(proj, '.claude', 'commands', 'plain.md'), 'Do the thing.');
      write(path.join(DATA, 'commands', 'review.md'), 'USER review loses to project');
      write(path.join(DATA, 'commands', 'mine.md'), 'user command');
    });
    test('project commands, nested folders as name:sub, user commands; project wins; built-ins cannot be overridden', async () => {
      const list = await commands.discoverCommands(proj);
      const by = Object.fromEntries(list.map((c) => [c.name, c]));
      assert.deepEqual(Object.keys(by).sort(), ['git:commit', 'mine', 'plain', 'review', 'swap']);
      assert.equal(by.review.source, 'project');
      assert.ok(by.review.file.includes(path.join('.omp', 'commands')));
      assert.equal(by.mine.source, 'user');
    });
    test('description comes from frontmatter, else the first non-heading line; argument-hint becomes input.hint', async () => {
      const by = Object.fromEntries((await commands.discoverCommands(proj)).map((c) => [c.name, c]));
      assert.equal(by.review.description, 'Review the diff');
      assert.deepEqual(by.review.input, { hint: '[files]' });
      assert.equal(by['git:commit'].description, 'Write a commit message.');
      assert.equal(by.plain.input, undefined);
    });
    test('$ARGUMENTS and positional $1..$9 are substituted; missing positions become empty', async () => {
      const by = Object.fromEntries((await commands.discoverCommands(proj)).map((c) => [c.name, c]));
      assert.equal(await commands.expandCommand(by.review, '  src/a.js  '), 'Review src/a.js carefully.');
      assert.equal(await commands.expandCommand(by.swap, 'one "two words"'), 'Swap two words and one, ignore .');
    });
    test('arguments are appended when the template has no placeholder; no arguments adds nothing', async () => {
      const by = Object.fromEntries((await commands.discoverCommands(proj)).map((c) => [c.name, c]));
      assert.equal(await commands.expandCommand(by.plain, 'extra please'), 'Do the thing.\n\nextra please');
      assert.equal(await commands.expandCommand(by.plain, ''), 'Do the thing.');
      assert.equal(await commands.expandCommand(by.plain), 'Do the thing.');
    });
    test('arguments are inserted literally: a "$1" typed in the arguments is not expanded again', async () => {
      const by = Object.fromEntries((await commands.discoverCommands(proj)).map((c) => [c.name, c]));
      assert.equal(await commands.expandCommand(by.review, '$& $1'), 'Review $& $1 carefully.');
    });
  });

  describe('loadInstructions', () => {
    const repo = path.join(TMP, 'instr-repo');
    const backend = { hostPath: (p) => p };
    before(() => {
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
      write(path.join(repo, 'AGENTS.md'), 'ROOT RULES\n');
      write(path.join(repo, 'pkg', 'sub', 'CLAUDE.md'), 'SUB RULES');
      write(path.join(repo, 'pkg', 'sub', 'AGENTS.md'), '   \n');
      write(path.join(TMP, 'AGENTS.md'), 'ABOVE THE REPO: must never be read');
    });
    test('walks up from the workspace to the repo root, nearest first, skipping blank files and stopping at .git', async () => {
      const found = await context.loadInstructions(backend, path.join(repo, 'pkg', 'sub'));
      assert.deepEqual(found.map((f) => [path.relative(repo, f.path), f.text, f.truncated]), [[path.join('pkg', 'sub', 'CLAUDE.md'), 'SUB RULES', false], ['AGENTS.md', 'ROOT RULES', false]]);
    });
    test('a workspace with no instruction files gives an empty list', async () => {
      const bare = path.join(TMP, 'instr-bare');
      fs.mkdirSync(path.join(bare, '.git'), { recursive: true });
      assert.deepEqual(await context.loadInstructions(backend, bare), []);
    });
    test('total size is capped at 24000 characters and flagged as truncated', async () => {
      const big = path.join(TMP, 'instr-big');
      fs.mkdirSync(path.join(big, '.git'), { recursive: true });
      write(path.join(big, 'AGENTS.md'), 'x'.repeat(30000));
      write(path.join(big, 'CLAUDE.md'), 'second file, over budget');
      const found = await context.loadInstructions(backend, big);
      assert.equal(found.length, 1);
      assert.equal(found[0].text.length, 24000);
      assert.equal(found[0].truncated, true);
    });
  });
});

// =====================================================================================================
describe('export: conversationHtml', () => {
  const { conversationHtml, writeExport } = exporter;
  const EVIL = '<script>alert(1)</script>';
  const hostile = () =>
    conversationHtml({
      title: `T ${EVIL} "q"`,
      workspace: `C:\\ws\\${EVIL}`,
      model: `m"><img src=x onerror=alert(2)>`,
      messages: [
        { role: 'user', content: [{ type: 'text', text: `hello ${EVIL}\n\n\`\`\`html\n${EVIL}\n\`\`\`\n\n# <b>head</b>\n\`</code>${EVIL}\`` }], attachments: [{ path: `a"><script>x</script>.txt` }] },
        {
          role: 'assistant',
          model: `gpt"${EVIL}`,
          content: [
            { type: 'thinking', thinking: `think ${EVIL}` },
            { type: 'text', text: `**bold ${EVIL}**` },
            { type: 'toolCall', id: 'c1', name: `read${EVIL}`, arguments: { path: `"><script>1</script>` } },
          ],
          stopReason: 'error',
          errorMessage: `boom ${EVIL}`,
        },
        { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: `result ${EVIL}` }], isError: true },
        { role: 'compactionSummary', summary: `summary ${EVIL}` },
      ],
    });

  test('hostile content never produces a script tag or any raw tag from the conversation', () => {
    const html = hostile();
    assert.ok(!/<script/i.test(html));
    assert.ok(!html.includes('<img'));
    assert.ok(!/onerror=alert/.test(html.replace(/&lt;img[^]*?&gt;/g, '')));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });
  test('quotes and ampersands are escaped', () => {
    const html = conversationHtml({ title: `"quoted" & 'single'`, workspace: '', messages: [u(`a "b" & c <d>`)] });
    assert.ok(html.includes('<title>&quot;quoted&quot; &amp; &#39;single&#39;</title>'));
    assert.ok(html.includes('a &quot;b&quot; &amp; c &lt;d&gt;'));
  });
  test('the only element sources are the fixed template ones (no external loads, strict CSP present)', () => {
    const html = hostile();
    assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">/);
    assert.ok(!/<(link|iframe|object|embed|form|base)\b/i.test(html));
    assert.ok(!/<[a-z][^>]*\b(src|href)\s*=/i.test(html)); // no element loads or links anything
  });
  test('tool calls are paired with their results; errors are marked; a missing result is stated', () => {
    const html = conversationHtml({
      title: 't',
      workspace: 'w',
      messages: [
        { role: 'assistant', content: [call('ok', 'read', { path: 'a' }), call('bad', 'bash', { command: 'x' }), call('none', 'glob', {})] },
        result('ok', 'OK-OUTPUT'),
        result('bad', 'BAD-OUTPUT', { isError: true }),
      ],
    });
    assert.ok(html.includes('OK-OUTPUT'));
    assert.ok(html.includes('<details class="tool err"><summary><b>bash</b>'));
    assert.ok(html.includes('<details class="tool"><summary><b>read</b>'));
    assert.ok(html.includes('(no result)'));
  });
  test('huge tool output is clipped with a note', () => {
    const html = conversationHtml({ title: 't', workspace: 'w', messages: [{ role: 'assistant', content: [call('1')] }, result('1', 'z'.repeat(25000))] });
    assert.ok(html.includes('… [5000 more characters]'));
    assert.ok(!html.includes('z'.repeat(20001)));
  });
  test('light Markdown: fenced code, inline code, bold, headings; steer messages and images are labelled', () => {
    const html = conversationHtml({
      title: 't',
      workspace: 'w',
      messages: [{ role: 'user', attribution: 'steer', content: [{ type: 'text', text: '# Title\n\nsome `code` and **bold**\n\n```js\nlet a = 1 < 2;\n```' }, { type: 'image', data: 'x' }] }],
    });
    assert.ok(html.includes('<h3>Title</h3>'));
    assert.ok(html.includes('<code>code</code>'));
    assert.ok(html.includes('<strong>bold</strong>'));
    assert.ok(html.includes('<pre><code>let a = 1 &lt; 2;</code></pre>'));
    assert.ok(html.includes('You (steer)'));
    assert.ok(html.includes('[image attached]'));
  });
  test('empty assistant turns are omitted and a conversation without messages still renders', () => {
    const html = conversationHtml({ title: 'Empty', workspace: 'w', messages: [{ role: 'assistant', content: [{ type: 'text', text: '   ' }] }] });
    assert.ok(!html.includes('class="a"'));
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.trimEnd().endsWith('</html>'));
  });
  test('writeExport stays inside the exports folder whatever the title says, and the file holds the escaped page', () => {
    const file = writeExport({ title: '../../evil title/..\\x', workspace: 'w', messages: [u(`hi ${EVIL}`)] });
    const dir = path.join(DATA, 'exports');
    assert.equal(path.dirname(file), dir);
    assert.ok(path.basename(file).endsWith('.html'));
    assert.ok(!/[\\/:]/.test(path.basename(file)));
    const body = fs.readFileSync(file, 'utf8');
    assert.ok(!/<script/i.test(body));
    assert.ok(body.includes('hi &lt;script&gt;'));
  });
  test('writeExport falls back to a default name for an empty or symbol-only title', () => {
    assert.match(path.basename(writeExport({ title: '', workspace: 'w', messages: [] })), /^conversation-\d{4}-/);
    assert.match(path.basename(writeExport({ title: '***', workspace: 'w', messages: [] })), /^conversation-\d{4}-/);
  });
});

// =====================================================================================================
describe('catalog', () => {
  const { modelInfo, modelRecord, costOf, catalogModels } = catalog;

  test('modelInfo returns facts for a known model and null for unknown ones', () => {
    const i = modelInfo('anthropic', 'claude-opus-4-7');
    assert.equal(i.contextWindow, 200000);
    assert.equal(i.maxOutput, 128000);
    assert.deepEqual(i.cost, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
    assert.equal(i.reasoning, true);
    assert.equal(modelInfo('anthropic', 'claude-nonexistent-9'), null);
    assert.equal(modelInfo('anthropic', ''), null);
    assert.equal(modelInfo('anthropic', undefined), null);
  });
  test('model ids are matched ignoring case/dots and the Gemini "models/" prefix', () => {
    assert.equal(modelInfo('anthropic', 'claude-opus-4.7')?.maxOutput, 128000);
    assert.equal(modelInfo('anthropic', 'CLAUDE-OPUS-4-7')?.maxOutput, 128000);
    assert.equal(modelInfo('google', 'models/gemini-2.5-pro')?.maxOutput, 65536);
    assert.equal(modelInfo('openai', 'gpt-5.1')?.maxOutput, 128000);
  });
  test('aggregators and local servers match by the model id alone', () => {
    assert.equal(modelInfo('openrouter', 'anthropic/claude-opus-4-7')?.maxOutput, 128000);
    assert.equal(modelInfo('ollama', 'o3:latest')?.maxOutput, 100000);
    assert.equal(modelInfo('custom', 'gpt-4o')?.maxOutput, 16384);
    assert.equal(modelInfo('ollama', 'unknown-model:7b'), null);
  });
  test('a provider id is not mixed up with another provider\'s models', () => {
    assert.equal(modelInfo('deepseek', 'deepseek-reasoner').maxOutput, 64000);
    assert.equal(modelRecord('deepseek', 'deepseek-reasoner').toggle, true);
  });
  test('modelInfo hands out a copy of the prices (callers cannot corrupt the cache)', () => {
    const i = modelInfo('openai', 'o3');
    i.cost.input = 999;
    assert.equal(modelInfo('openai', 'o3').cost.input, 2);
  });
  test('catalogModels lists a provider\'s models; unknown or local providers give an empty list', () => {
    assert.deepEqual(catalogModels('deepseek'), [{ id: 'deepseek-reasoner', name: 'deepseek-reasoner' }]);
    assert.deepEqual(catalogModels('ollama'), []);
    assert.deepEqual(catalogModels('nobody'), []);
    assert.deepEqual(catalogModels(undefined), []);
  });

  describe('costOf', () => {
    const info = { cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
    test('USD per million tokens for each usage bucket', () => {
      close(costOf(info, { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }), 3);
      close(costOf(info, { input: 0, output: 1e6 }), 15);
      close(costOf(info, { cacheRead: 1e6 }), 0.3);
      close(costOf(info, { cacheWrite: 1e6 }), 3.75);
      close(costOf(info, { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 100 }), (3 * 1000 + 15 * 500 + 0.3 * 2000 + 3.75 * 100) / 1e6);
    });
    test('a missing cache price falls back to the input price', () => {
      close(costOf({ cost: { input: 2, output: 8, cacheRead: null, cacheWrite: null } }, { cacheRead: 1e6, cacheWrite: 1e6 }), 4);
    });
    test('unknown prices give null, never a made-up zero', () => {
      assert.equal(costOf(null, { input: 1 }), null);
      assert.equal(costOf({}, { input: 1 }), null);
      assert.equal(costOf({ cost: { input: null, output: 5 } }, { input: 1 }), null);
      assert.equal(costOf({ cost: { input: 1, output: null } }, { input: 1 }), null);
      assert.equal(costOf(info, undefined), null);
    });
    test('missing or non-numeric usage fields count as zero', () => {
      assert.equal(costOf(info, {}), 0);
      close(costOf(info, { input: 'abc', output: '1000000' }), 15);
      assert.equal(costOf(info, { input: NaN, output: undefined }), 0);
    });
    test('works with a record straight from modelInfo', () => {
      close(costOf(modelInfo('openai', 'gpt-4o'), { input: 1e6, output: 1e6, cacheRead: 1e6 }), 2.5 + 10 + 1.25);
      assert.equal(costOf(modelInfo('openai', 'gpt-5'), { input: 1 }), null); // no prices in the catalog
    });
  });

  test('a fresh download is slimmed from the models.dev shape (reasoning options, modalities, limits)', async () => {
    const cacheFile = path.join(DATA, 'cache', 'models-dev.json');
    const saved = fs.readFileSync(cacheFile);
    fs.rmSync(cacheFile);
    const raw = {
      anthropic: { models: { 'claude-x-1': { reasoning: true, limit: { context: 1000000, output: 64000 }, cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 }, modalities: { input: ['text', 'image'] }, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }, { type: 'toggle' }], canonical_model_id: 'claude-x' } } },
      broken: { models: 'not-an-object' },
      weird: null,
      textonly: { models: { 'plain-1': { limit: { context: 8000, output: 2000 }, attachment: false, tool_call: false }, bad: 'str' } },
      budgeted: { models: { 'b-1': { reasoning: true, reasoning_options: [{ type: 'budget_tokens' }], interleaved: { field: 'reasoning_content' }, attachment: true } } },
    };
    fetchHandler = async (url) => {
      assert.equal(url, 'https://models.dev/api.json');
      return new Response(JSON.stringify(raw), { status: 200 });
    };
    try {
      const fresh = await import('../src/engine/catalog.mjs?fresh=' + Date.now());
      assert.equal(await fresh.loadCatalog(), true);
      assert.deepEqual(fresh.modelInfo('anthropic', 'claude-x-1'), { contextWindow: 1000000, maxOutput: 64000, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, reasoning: true, vision: true, tools: true, efforts: ['low', 'high'], interleaved: null });
      assert.equal(fresh.modelRecord('anthropic', 'claude-x-1').toggle, true);
      assert.equal(fresh.modelRecord('anthropic', 'claude-x-1').canonical, 'claude-x');
      const plain = fresh.modelInfo('textonly', 'plain-1');
      assert.equal(plain.vision, false);
      assert.equal(plain.tools, false);
      assert.equal(plain.reasoning, false);
      assert.equal(plain.cost.input, null);
      const b = fresh.modelRecord('budgeted', 'b-1');
      assert.equal(b.budget, true);
      assert.equal(b.interleaved, 'reasoning_content');
      assert.equal(b.vision, true); // no modalities list: falls back to "attachment"
      assert.equal(fresh.modelInfo('broken', 'x'), null);
      assert.ok(fs.existsSync(cacheFile), 'the download is cached for offline use');
    } finally {
      fs.writeFileSync(cacheFile, saved);
      fetchHandler = async () => {
        throw new Error('network is blocked in tests');
      };
    }
  });
  test('a failed download with no cache leaves the catalog empty without throwing', async () => {
    const cacheFile = path.join(DATA, 'cache', 'models-dev.json');
    const saved = fs.readFileSync(cacheFile);
    fs.rmSync(cacheFile);
    fetchHandler = async () => new Response('server error', { status: 500 });
    try {
      const fresh = await import('../src/engine/catalog.mjs?failed=' + Date.now());
      assert.equal(await fresh.loadCatalog(), false);
      assert.equal(fresh.modelInfo('openai', 'gpt-4o'), null);
      assert.deepEqual(fresh.catalogModels('openai'), []);
    } finally {
      fs.writeFileSync(cacheFile, saved);
    }
  });
});

// =====================================================================================================
describe('secrets', () => {
  test('unprotect refuses anything that is not a dpapi: value, on every platform', async () => {
    await assert.rejects(() => secrets.unprotect('plain-text-key'), /Unsupported secret format/);
    await assert.rejects(() => secrets.unprotect(undefined), /Unsupported secret format/);
    await assert.rejects(() => secrets.unprotect('sk-ant-123'), /Unsupported secret format/);
  });
  test('DPAPI round trip: stored value is tagged, differs from the key, and decrypts back (incl. unicode)', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
    const key = 'sk-test-\u00e9\u20ac-1234567890';
    const stored = await secrets.protect(key);
    assert.ok(stored.startsWith('dpapi:'));
    assert.ok(!stored.includes('sk-test'));
    assert.equal(await secrets.unprotect(stored), key);
    const again = await secrets.protect(key);
    assert.equal(await secrets.unprotect(again), key);
  });
  test('corrupt DPAPI data is an error, not garbage', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
    await assert.rejects(() => secrets.unprotect('dpapi:AAAA'), /Secure storage failed/);
  });
});
