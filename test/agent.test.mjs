// Tests for the agent's inputs and outputs: file decoding, images, search (.gitignore), tool results, partial JSON,
// provider converters, the system prompt, prompt attachments, and the agent loop end to end against a mock provider
// (continue after max_tokens, empty-reply and mid-stream retries, regenerate, edit-and-resend, status events).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-agent-test-'));
const DATA = path.join(TMP, 'data');
process.env.ORBIX_DATA = DATA;
process.env.ORBIX_NO_RG = '1';
fs.mkdirSync(path.join(DATA, 'cache'), { recursive: true });

const rec = (o) => ({ contextWindow: 200000, maxOutput: 8192, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, reasoning: false, vision: true, tools: true, efforts: null, budget: false, toggle: false, interleaved: null, canonical: null, ...o });
fs.writeFileSync(path.join(DATA, 'cache', 'models-dev.json'), JSON.stringify({ fetchedAt: Date.now(), providers: { anthropic: { 'claude-test': rec({}), 'claude-blind': rec({ vision: false }) }, openai: { 'gpt-test': rec({}) } } }));

const realFetch = globalThis.fetch;
const requests = [];
let script = []; // queued provider responses (functions returning a Response)
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (/mock\.(anthropic|openai)/.test(u)) {
    requests.push({ url: u, body: JSON.parse(init.body) });
    const next = script.shift();
    if (!next) throw new Error('no scripted response left');
    return next();
  }
  throw new Error('network is blocked in tests');
};

const files = await import('../src/engine/files.mjs');
const search = await import('../src/engine/search.mjs');
const tools_ = await import('../src/engine/tools.mjs');
const assemble = await import('../src/engine/assemble.mjs');
const anthropic = await import('../src/engine/anthropic.mjs');
const openai = await import('../src/engine/openai.mjs');
const prompt = await import('../src/engine/prompt.mjs');
const context = await import('../src/engine/context.mjs');
const compact = await import('../src/engine/compact.mjs');
const { AgentProc } = await import('../src/engine/proc.mjs');
const { PRESETS } = await import('../src/engine/providers.mjs');
const { Backend } = await import('../src/backend.mjs');

after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const put = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

/** A minimal PNG header (signature + IHDR) of the given size; enough for sniffing. */
function png(w, h, pad = 0) {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

// =====================================================================================================
describe('files: decoding, encoding, images, terminal output', () => {
  test('decodeText detects UTF-8 BOM, UTF-16 LE/BE, Windows-1252 and binary', () => {
    assert.deepEqual(files.decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69])), { text: 'hi', encoding: 'utf-8-bom' });
    assert.deepEqual(files.decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('héllo', 'utf16le')])), { text: 'héllo', encoding: 'utf-16le' });
    assert.deepEqual(files.decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('ab', 'utf16le').swap16()])), { text: 'ab', encoding: 'utf-16be' });
    assert.deepEqual(files.decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80])), { text: 'café €', encoding: 'windows-1252' });
    assert.equal(files.decodeText(Buffer.from([1, 0, 2, 0, 3])), null);
    assert.deepEqual(files.decodeText(Buffer.from('plain ✓')), { text: 'plain ✓', encoding: 'utf-8' });
  });
  test('a partial buffer that ends mid-character is still UTF-8', () => {
    const buf = Buffer.from('aé').subarray(0, 2);
    assert.equal(files.decodeText(buf, { partial: true }).encoding, 'utf-8');
  });
  test('encodeText round-trips every encoding; unrepresentable 1252 text falls back to UTF-8', () => {
    for (const enc of ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'windows-1252']) {
      const { buf, encoding } = files.encodeText('café € “q”', enc);
      assert.equal(encoding, enc);
      assert.deepEqual(files.decodeText(buf), { text: 'café € “q”', encoding: enc });
    }
    assert.equal(files.encodeText('日本', 'windows-1252').encoding, 'utf-8');
  });
  test('lineEnding', () => {
    assert.equal(files.lineEnding('a\r\nb\r\n'), 'crlf');
    assert.equal(files.lineEnding('a\nb'), 'lf');
    assert.equal(files.lineEnding('a\r\nb\n'), 'mixed');
    assert.equal(files.lineEnding('one line'), 'lf');
  });
  test('sniffImage reads type and size of PNG, GIF, JPEG and WebP', () => {
    assert.deepEqual(files.sniffImage(png(640, 480)), { mimeType: 'image/png', width: 640, height: 480 });
    const gif = Buffer.alloc(16);
    gif.write('GIF89a', 0, 'latin1');
    gif.writeUInt16LE(10, 6);
    gif.writeUInt16LE(20, 8);
    assert.deepEqual(files.sniffImage(gif), { mimeType: 'image/gif', width: 10, height: 20 });
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0x03, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(files.sniffImage(jpg), { mimeType: 'image/jpeg', width: 600, height: 300 });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBPVP8X', 8, 'latin1');
    webp.writeUIntLE(99, 24, 3);
    webp.writeUIntLE(49, 27, 3);
    assert.deepEqual(files.sniffImage(webp), { mimeType: 'image/webp', width: 100, height: 50 });
    assert.equal(files.sniffImage(Buffer.from('not an image at all')), null);
  });
  test('prepareImage: base64 block, downscale note, size and type limits', () => {
    const ok = files.prepareImage(png(2000, 1000), { label: 'shot.png' });
    assert.equal(ok.ok, true);
    assert.equal(ok.image.mimeType, 'image/png');
    assert.equal(Buffer.from(ok.image.data, 'base64').length, 33);
    assert.match(ok.note, /^shot\.png \(PNG, 2000x1000 px, 1 KB\)\. The model sees it downscaled/);
    assert.doesNotMatch(files.prepareImage(png(800, 600)).note, /downscaled/);
    assert.match(files.prepareImage(png(9000, 10)).note, /larger than 8000 px/);
    assert.match(files.prepareImage(png(10, 10, 6 * 1024 * 1024)).note, /larger than the 5\.0 MB limit/);
    assert.match(files.prepareImage(Buffer.from('<svg/>xxxxxxxxxxxx'), { declaredType: 'image/svg+xml' }).note, /not a PNG, JPEG, GIF or WebP image \(image\/svg\+xml\)/);
  });
  test('base64Bytes accepts plain base64, data URLs and URL-safe base64; rejects junk', () => {
    assert.equal(files.base64Bytes('aGk=').toString(), 'hi');
    assert.equal(files.base64Bytes('data:image/png;base64,aGk=').toString(), 'hi');
    assert.equal(files.base64Bytes('aG k=\n').toString(), 'hi');
    assert.equal(files.base64Bytes('not base64!'), null);
    assert.equal(files.base64Bytes(''), null);
  });
  test('cleanTerminal strips ANSI and OSC, keeps the final state of \\r redraws, applies backspaces', () => {
    assert.equal(files.cleanTerminal('\x1b[31mred\x1b[0m \x1b]0;title\x07ok\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\'), 'red oklink');
    assert.equal(files.cleanTerminal('10%\r50%\r100%\ndone\r\n'), '100%\ndone\n');
    assert.equal(files.cleanTerminal('abc\x08\x08X'), 'aX');
    assert.equal(files.cleanTerminal('a\x00b\x07c'), 'abc');
  });
  test('keepSgr keeps colour codes only; stripSgr removes them', () => {
    const raw = '\x1b[1;31mERR\x1b[0m\x1b[2K\x1b[1A\x1b]0;t\x07 ok\x1b';
    assert.equal(files.cleanTerminal(raw, { keepSgr: true }), '\x1b[1;31mERR\x1b[0m ok');
    assert.equal(files.stripSgr(files.cleanTerminal(raw, { keepSgr: true })), 'ERR ok');
  });
  test('looksBinaryText', () => {
    assert.equal(files.looksBinaryText('normal text\n'.repeat(100)), false);
    assert.equal(files.looksBinaryText('\ufffd\x00'.repeat(200)), true);
  });
  test('cachedText re-reads only when the file changes', async () => {
    const f = put(path.join(TMP, 'cache', 'a.md'), 'one');
    assert.equal(await files.cachedText(f), 'one');
    fs.writeFileSync(f, 'two!');
    assert.equal(await files.cachedText(f), 'two!');
    assert.equal(await files.cachedText(path.join(TMP, 'cache', 'missing.md')), null);
  });
});

// =====================================================================================================
describe('search: .gitignore rules and the walker', () => {
  const ign = (text, rel, dir = false) => search.isIgnored([{ rules: search.compileIgnore(text), base: '' }], rel, dir);
  test('basic, anchored, directory-only, negated and ** patterns', () => {
    assert.equal(ign('*.log', 'a/b/x.log'), true);
    assert.equal(ign('*.log\n!keep.log', 'a/keep.log'), false);
    assert.equal(ign('/build', 'build', true), true);
    assert.equal(ign('/build', 'src/build', true), false);
    assert.equal(ign('dist/', 'dist', false), false);
    assert.equal(ign('dist/', 'x/dist', true), true);
    assert.equal(ign('docs/**/*.md', 'docs/a/b/c.md'), true);
    assert.equal(ign('**/tmp', 'a/tmp', true), true);
    assert.equal(ign('a/**', 'a/b/c'), true);
    assert.equal(ign('# comment\n\n  \n', 'x'), false);
    assert.equal(ign('\\#hash', '#hash'), true);
    assert.equal(ign('file[0-9].txt', 'file3.txt'), true);
    assert.equal(ign('file[!0-9].txt', 'file3.txt'), false);
  });
  test('walk honours nested .gitignore files and the repository root above the search folder', async () => {
    const repo = path.join(TMP, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    put(path.join(repo, '.gitignore'), '*.tmp\nout/\n');
    put(path.join(repo, 'pkg', '.gitignore'), 'secret.txt\n!keep.tmp\n');
    for (const f of ['pkg/a.js', 'pkg/b.tmp', 'pkg/keep.tmp', 'pkg/secret.txt', 'pkg/out/x.js', 'pkg/sub/c.js', 'pkg/node_modules/m.js', 'top.js']) put(path.join(repo, ...f.split('/')), 'x');
    const all = await search.walk(repo);
    assert.deepEqual(all.files, ['.gitignore', 'pkg/.gitignore', 'pkg/a.js', 'pkg/keep.tmp', 'pkg/sub/c.js', 'top.js']);
    const inner = await search.walk(path.join(repo, 'pkg'));
    assert.deepEqual(inner.files, ['.gitignore', 'a.js', 'keep.tmp', 'sub/c.js']);
    assert.deepEqual((await search.walk(repo, { gitignore: false })).files.length, 9);
    const capped = await search.walk(repo, { maxFiles: 2 });
    assert.equal(capped.capped, true);
    assert.equal(capped.files.length, 2);
  });
  test('ripgrepFor is off when ORBIX_NO_RG is set or the path is not local', async () => {
    assert.equal(await search.ripgrepFor({ isWsl: false }, 'C:\\x'), null);
  });
});

// =====================================================================================================
describe('tools: inputs and outputs', () => {
  const ws = path.join(TMP, 'tools-ws');
  const backend = new Backend({ kind: 'native' });
  let T;
  const run = (name, input, hooks = {}) => T.run(name, input, hooks);
  const at = (rel) => path.join(ws, ...rel.split('/'));
  before(() => {
    fs.mkdirSync(ws, { recursive: true });
    T = tools_.createTools({ backend: process.platform === 'win32' ? backend : { hostPath: (p) => p, isWsl: false }, cwd: ws, getSignal: () => undefined });
  });

  test('toolDefsFor describes the real shell: cmd.exe/PowerShell natively, bash in WSL', () => {
    const nat = tools_.toolDefsFor(new Backend({ kind: 'native' })).find((d) => d.name === 'bash');
    assert.match(nat.description, /cmd\.exe/);
    assert.deepEqual(nat.input_schema.properties.shell.enum, ['cmd', 'powershell']);
    const wsl = tools_.toolDefsFor(new Backend({ kind: 'wsl', distro: 'Ubuntu' })).find((d) => d.name === 'bash');
    assert.match(wsl.description, /bash in WSL \(Ubuntu\)/);
    assert.equal(wsl.input_schema.properties.shell, undefined);
  });
  test('every tool schema is a well-formed object schema with described properties', () => {
    for (const d of tools_.toolDefsFor(backend)) {
      assert.equal(d.input_schema.type, 'object', d.name);
      for (const r of d.input_schema.required || []) assert.ok(d.input_schema.properties[r], `${d.name}.${r}`);
      assert.ok(d.description.length > 40, d.name);
    }
  });
  test('checkArgs coerces numeric and boolean strings and JSON arrays; reports bad types with the signature', () => {
    const read = tools_.TOOL_DEFS.find((d) => d.name === 'read');
    assert.deepEqual(tools_.checkArgs(read, { path: 'a', offset: '10', limit: 5.7 }).args, { path: 'a', offset: 10, limit: 5 });
    assert.match(tools_.checkArgs(read, { path: 'a', offset: 'x' }).error, /Invalid argument "offset": expected integer, got string\. Expected read\(path: string, offset\?: integer, limit\?: integer\)/);
    assert.match(tools_.checkArgs(read, {}).error, /Missing required argument "path"/);
    assert.match(tools_.checkArgs(read, 'nope').error, /JSON object/);
    const grep = tools_.TOOL_DEFS.find((d) => d.name === 'grep');
    assert.equal(tools_.checkArgs(grep, { pattern: 'x', ignore_case: 'true' }).args.ignore_case, true);
    assert.match(tools_.checkArgs(grep, { pattern: 'x', output_mode: 'lines' }).error, /must be one of "content", "files", "count"/);
    const todo = tools_.TOOL_DEFS.find((d) => d.name === 'todo');
    assert.deepEqual(tools_.checkArgs(todo, { todos: '[{"content":"a","status":"pending"}]' }).args.todos, [{ content: 'a', status: 'pending' }]);
  });
  test('read: an image comes back as an image block with a note; without vision only the note', async () => {
    put(at('img/pic.png'), png(3000, 2000));
    const r = await run('read', { path: 'img/pic.png' });
    assert.ok(!r.isError, r.text);
    assert.equal(r.images.length, 1);
    assert.equal(r.images[0].mimeType, 'image/png');
    assert.match(r.text, /PNG, 3000x2000 px/);
    const blind = await run('read', { path: 'img/pic.png' }, { vision: false });
    assert.equal(blind.images, undefined);
    assert.match(blind.text, /cannot view images/);
  });
  test('read: UTF-16 and Windows-1252 files are decoded and the encoding is named', async () => {
    put(at('enc/u16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('line one\r\nline two\r\n', 'utf16le')]));
    const r = await run('read', { path: 'enc/u16.txt' });
    assert.equal(r.text, '1\tline one\n2\tline two\n[encoding: UTF-16 LE; edit and write keep it]');
    put(at('enc/latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    assert.match((await run('read', { path: 'enc/latin.txt' })).text, /^1\tcafé\n\[encoding: Windows-1252/);
  });
  test('read: a PDF is named as such; offset past the end and an empty file are clear', async () => {
    put(at('doc.pdf'), Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0, 1, 2, 3])]));
    assert.match((await run('read', { path: 'doc.pdf' })).text, /is a PDF document/);
    put(at('short.txt'), 'a\nb\n');
    assert.match((await run('read', { path: 'short.txt', offset: 9 })).text, /has 2 lines; offset 9 is past the end/);
    put(at('empty.txt'), '');
    assert.equal((await run('read', { path: 'empty.txt' })).text, '(empty file)');
  });
  test('a missing file names similar files in its folder', async () => {
    put(at('src/config.json'), '{}');
    const r = await run('read', { path: 'src/confg.json' });
    assert.equal(r.isError, true);
    assert.match(r.text, /^No such file or folder: src\/confg\.json\. Similar names in that folder: config\.json\./);
    assert.match((await run('read', { path: 'nowhere/deep/x.txt' })).text, /The folder nowhere\\deep|The folder nowhere\/deep/);
  });
  test('edit keeps a UTF-16 file UTF-16 and undo restores the original bytes', async () => {
    const orig = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('alpha\r\nbeta\r\n', 'utf16le')]);
    put(at('enc/edit16.txt'), orig);
    const r = await run('edit', { path: 'enc/edit16.txt', old_string: 'alpha\nbeta', new_string: 'ALPHA\nbeta' });
    assert.ok(!r.isError, r.text);
    assert.deepEqual(files.decodeText(fs.readFileSync(at('enc/edit16.txt'))), { text: 'ALPHA\r\nbeta\r\n', encoding: 'utf-16le' });
    assert.equal((await T.undo(r.details.undo)).ok, true);
    assert.deepEqual(fs.readFileSync(at('enc/edit16.txt')), orig);
  });
  test('write keeps CRLF line endings and the encoding of the file it replaces', async () => {
    put(at('crlf.txt'), 'a\r\nb\r\n');
    await run('read', { path: 'crlf.txt' });
    const r = await run('write', { path: 'crlf.txt', content: 'x\ny\n' });
    assert.match(r.text, /CRLF line endings kept/);
    assert.equal(fs.readFileSync(at('crlf.txt'), 'utf8'), 'x\r\ny\r\n');
    put(at('bom.txt'), Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
    await run('read', { path: 'bom.txt' });
    await run('write', { path: 'bom.txt', content: 'b' });
    assert.deepEqual([...fs.readFileSync(at('bom.txt'))], [0xef, 0xbb, 0xbf, 0x62]);
  });
  test('write refuses to replace an existing file the agent has not read, and leaves it untouched', async () => {
    fs.writeFileSync(at('unread.txt'), 'keep me');
    const r = await run('write', { path: 'unread.txt', content: 'guess' });
    assert.equal(r.isError, true);
    assert.match(r.text, /have not read it/);
    assert.equal(fs.readFileSync(at('unread.txt'), 'utf8'), 'keep me');
    await run('read', { path: 'unread.txt' });
    assert.ok(!(await run('write', { path: 'unread.txt', content: 'known' })).isError);
    assert.ok(!(await run('write', { path: 'brand-new.txt', content: 'new' })).isError, 'a new file needs no read');
  });

  test('write refuses a file that changed on disk after the agent read it, until it is read again', async () => {
    put(at('stale.txt'), 'v1');
    await run('read', { path: 'stale.txt' });
    await new Promise((r) => setTimeout(r, 30));
    fs.writeFileSync(at('stale.txt'), 'user edit');
    fs.utimesSync(at('stale.txt'), new Date(), new Date(Date.now() + 5000));
    const r = await run('write', { path: 'stale.txt', content: 'agent' });
    assert.equal(r.isError, true);
    assert.match(r.text, /changed on disk after you last read it/);
    assert.equal(fs.readFileSync(at('stale.txt'), 'utf8'), 'user edit');
    await run('read', { path: 'stale.txt' });
    assert.ok(!(await run('write', { path: 'stale.txt', content: 'agent' })).isError);
  });
  test('edit: a whitespace-tolerant match needs a current read of the file', async () => {
    put(at('fz.js'), 'function f() {\n    if (a) {\n        go();\n    }\n}\n');
    const unread = await run('edit', { path: 'fz.js', old_string: 'if (a) {\n    go();\n}', new_string: 'if (a) {\n    stop();\n}' });
    assert.equal(unread.isError, true);
    assert.match(unread.text, /not read this file/);
    await run('read', { path: 'fz.js' });
    await new Promise((r) => setTimeout(r, 30));
    fs.writeFileSync(at('fz.js'), 'function f() {\n    if (a) {\n        go();\n    }\n}\n// user\n');
    fs.utimesSync(at('fz.js'), new Date(), new Date(Date.now() + 5000));
    const stale = await run('edit', { path: 'fz.js', old_string: 'if (a) {\n    go();\n}', new_string: 'if (a) {\n    stop();\n}' });
    assert.equal(stale.isError, true);
    assert.match(stale.text, /changed after you last read it/);
    assert.match(fs.readFileSync(at('fz.js'), 'utf8'), /go\(\);/);
    // An exact match is grounded in the file itself and needs no read.
    assert.ok(!(await run('edit', { path: 'fz.js', old_string: '// user', new_string: '// done' })).isError);
  });
  test('edit: line-number prefixes copied from read output are removed', async () => {
    put(at('num.txt'), 'one\ntwo\nthree\n');
    const r = await run('edit', { path: 'num.txt', old_string: '2\ttwo\n3\tthree', new_string: '2\tTWO\n3\tthree' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /line-number prefixes removed/);
    assert.equal(fs.readFileSync(at('num.txt'), 'utf8'), 'one\nTWO\nthree\n');
  });
  test('edit: an indentation mismatch matches uniquely and the new text is re-indented', async () => {
    put(at('ind.js'), 'function f() {\n    if (a) {\n        go();\n    }\n}\n');
    await run('read', { path: 'ind.js' });
    const r = await run('edit', { path: 'ind.js', old_string: 'if (a) {\n    go();\n}', new_string: 'if (a) {\n    go();\n    stop();\n}' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /ignoring whitespace differences; new text re-indented/);
    assert.match(r.text, /\n\+4\|        stop\(\);/, 'a whitespace-tolerant edit shows its diff');
    assert.equal(fs.readFileSync(at('ind.js'), 'utf8'), 'function f() {\n    if (a) {\n        go();\n        stop();\n    }\n}\n');
  });
  test('edit: an exact match returns only the line range; a missing file points to write', async () => {
    put(at('exact.txt'), 'a\nb\n');
    assert.equal((await run('edit', { path: 'exact.txt', old_string: 'b', new_string: 'c' })).text.split('\n').length, 1);
    const miss = await run('edit', { path: 'nofile.txt', old_string: 'a', new_string: 'b' });
    assert.equal(miss.isError, true);
    assert.match(miss.text, /^No such file or folder: nofile\.txt\..* To create a new file, use write\.$/);
  });
  test('invalidArgsText names the expected arguments and how to escape strings', () => {
    const edit = tools_.TOOL_DEFS.find((d) => d.name === 'edit');
    const t = tools_.invalidArgsText(edit);
    assert.match(t, /^Not run: the arguments were not valid JSON\./);
    assert.match(t, /edit\(path: string, old_string: string, new_string: string, replace_all\?: boolean\)/);
    assert.match(tools_.invalidArgsText(undefined), /matching the tool schema/);
    assert.equal(tools_.signature({ name: 'mcp_x', input_schema: { properties: { q: {} } } }), 'mcp_x(q?: any)');
  });
  test('edit: ambiguous matches and misses say where to look', async () => {
    put(at('amb.txt'), 'x = 1\ny = 2\nx = 1\n');
    const r = await run('edit', { path: 'amb.txt', old_string: 'x = 1', new_string: 'x = 3' });
    assert.match(r.text, /matches 2 places \(lines 1, 3\)/);
    const fz = await run('edit', { path: 'amb.txt', old_string: '  x  =  1  ', new_string: 'z' });
    assert.match(fz.text, /Ignoring whitespace it matches 2 places \(lines 1, 3\)/);
    const miss = await run('edit', { path: 'amb.txt', old_string: 'y = 2\nnot there', new_string: 'q' });
    assert.match(miss.text, /Its first line appears at line 2, but the lines after it differ/);
    const ok = await run('edit', { path: 'amb.txt', old_string: 'y = 2', new_string: 'y = 5' });
    assert.match(ok.text, /: line 2$/);
  });
  test('bash: long output keeps the start and the end with a marker; ANSI is removed; duration reported', async () => {
    const cmd = process.platform === 'win32' ? 'for /L %i in (1,1,6000) do @echo line %i' : 'for i in $(seq 1 6000); do echo line $i; done';
    const r = await run('bash', { command: cmd });
    assert.ok(!r.isError, r.text.slice(-300));
    assert.ok(r.text.startsWith('line 1\n'));
    const m = /\n\[… (\d+) lines \((\d+) characters\) omitted; filter the output or redirect it to a file to see them …\]\n/.exec(r.text);
    assert.ok(m, r.text.slice(9000, 11000));
    const kept = r.text.split('\n').filter((l) => /^line \d+$/.test(l)).length;
    assert.equal(kept + Number(m[1]), 6000, 'kept + omitted lines = all lines');
    assert.match(r.text, /line 6000\n\[exit code 0 · \d+\.\ds\]$/);
    assert.ok(r.text.length < 31000);
    assert.equal(r.details.truncated, true);
    const colored = await run('bash', { command: process.platform === 'win32' ? 'echo \x1b[32mgreen\x1b[0m' : "printf '\\033[32mgreen\\033[0m\\n'" });
    assert.match(colored.text, /^\x1b\[32mgreen\x1b\[0m\s*\n\[exit code 0/); // colour codes stay for the UI
  });
  test('bash: PowerShell on Windows', { skip: process.platform !== 'win32' }, async () => {
    const r = await run('bash', { command: '$x = 6 * 7; Write-Output "answer $x"', shell: 'powershell' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /^answer 42\n\[exit code 0/);
    assert.equal(r.details.shell, 'powershell');
    const bad = await run('bash', { command: 'exit 4', shell: 'powershell' });
    assert.equal(bad.details.exitCode, 4);
  });
  test('grep: files and count modes, context lines with separators, sorted by path', async () => {
    put(at('g/b.txt'), 'hit 1\nx\nx\nx\nhit 2\n');
    put(at('g/a.txt'), 'nothing\nhit\n');
    assert.equal((await run('grep', { pattern: 'hit', path: 'g', output_mode: 'files' })).text, 'a.txt\nb.txt');
    assert.equal((await run('grep', { pattern: 'hit', path: 'g', output_mode: 'count' })).text, 'a.txt: 1\nb.txt: 2');
    const c = await run('grep', { pattern: 'hit', path: 'g', context: 1 });
    assert.equal(c.text, 'a.txt-1- nothing\na.txt:2: hit\n--\nb.txt:1: hit 1\nb.txt-2- x\n--\nb.txt-4- x\nb.txt:5: hit 2');
    const lim = await run('grep', { pattern: 'hit', path: 'g', limit: 1 });
    assert.equal(lim.text, 'a.txt:2: hit\n[showing 1 of 3 matching lines in 2 files; narrow the pattern, path or glob, or raise limit]');
  });
  test('grep and glob respect .gitignore', async () => {
    put(at('gi/.gitignore'), 'gen/\n*.min.js\n');
    put(at('gi/gen/out.js'), 'needle');
    put(at('gi/app.min.js'), 'needle');
    put(at('gi/app.js'), 'needle');
    assert.equal((await run('grep', { pattern: 'needle', path: 'gi' })).text, 'app.js:1: needle');
    assert.equal((await run('glob', { pattern: '**/*.js', path: 'gi' })).text, 'app.js');
  });
  test('an unknown tool lists the real ones', async () => {
    assert.match((await run('nope', {})).text, /Unknown tool "nope"\. Available: read, write, edit, bash, glob, grep, todo, web_fetch, web_search\./);
  });
});

// =====================================================================================================
describe('assemble: partial JSON and the turn assembler', () => {
  const { parsePartialJson, TurnAssembler } = assemble;
  test('parsePartialJson shows tool arguments while they stream', () => {
    assert.deepEqual(parsePartialJson('{"path":"a.js","content":"line 1\\nli'), { path: 'a.js', content: 'line 1\nli' });
    assert.deepEqual(parsePartialJson('{"path":"a.js","con'), { path: 'a.js' });
    assert.deepEqual(parsePartialJson('{"a":12'), { a: 12 });
    assert.deepEqual(parsePartialJson('{"a":'), {});
    assert.deepEqual(parsePartialJson('{"a":[1,2,'), { a: [1, 2] });
    assert.deepEqual(parsePartialJson('{"a":{"b":"c'), { a: { b: 'c' } });
    assert.deepEqual(parsePartialJson('{"t":"x\\'), { t: 'x' });
    assert.deepEqual(parsePartialJson('{"t":"\\u00'), { t: '' });
    assert.deepEqual(parsePartialJson('{"done":true}'), { done: true });
    assert.equal(parsePartialJson(''), undefined);
    assert.equal(parsePartialJson('[1,2'), undefined);
    assert.equal(parsePartialJson('nonsense'), undefined);
  });
  test('arguments are parsed lazily (refreshPartial) and finally at block_stop', () => {
    const msg = { content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: 'stop' };
    const asm = new TurnAssembler(msg);
    asm.push({ type: 'tool_start', index: 1, id: 't', name: 'write' });
    assert.equal(asm.push({ type: 'tool_json', index: 1, json: '{"path":"x","content":"ab' }).kind, 'toolcall_delta');
    assert.deepEqual(msg.content[0].arguments, {});
    asm.refreshPartial();
    assert.deepEqual(msg.content[0].arguments, { path: 'x', content: 'ab' });
    asm.push({ type: 'tool_json', index: 1, json: 'c"}' });
    assert.equal(asm.push({ type: 'block_stop', index: 1 }).kind, 'toolcall_end');
    assert.deepEqual(msg.content[0].arguments, { path: 'x', content: 'abc' });
  });
  test('a cut-off tool call keeps its readable part and is flagged; refusal is recorded', () => {
    const msg = { content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: 'stop' };
    const asm = new TurnAssembler(msg);
    asm.push({ type: 'tool_start', index: 0, id: 't', name: 'write' });
    asm.push({ type: 'tool_json', index: 0, json: '{"path":"big.txt","content":"aaa' });
    asm.push({ type: 'stop', reason: 'max_tokens' });
    asm.finish();
    assert.equal(msg.content[0].invalidArguments, true);
    assert.deepEqual(msg.content[0].arguments, { path: 'big.txt', content: 'aaa' });
    assert.equal(msg.stopReason, 'length');
    const m2 = { content: [], usage: {}, stopReason: 'stop' };
    new TurnAssembler(m2).push({ type: 'stop', reason: 'refusal' });
    assert.equal(m2.refusal, true);
  });
  test('usage at message_delta may update input and cache counts too', () => {
    const msg = { content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: 'stop' };
    const asm = new TurnAssembler(msg);
    asm.push({ type: 'usage', input: 5, output: 1, cacheRead: 2, cacheWrite: 3 });
    asm.push({ type: 'usage', output: 40, outputIsTotal: true, input: 7 });
    assert.deepEqual(msg.usage, { input: 7, output: 40, cacheRead: 2, cacheWrite: 3 });
  });
});

// =====================================================================================================
describe('providers: images, cache breakpoints', () => {
  test('withCacheBreakpoint marks the last cacheable block of the last message without mutating the input', () => {
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'a' }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }, { type: 'text', text: 'b' }] }];
    const out = anthropic.withCacheBreakpoint(msgs);
    assert.deepEqual(out[1].content[1].cache_control, { type: 'ephemeral' });
    assert.equal(msgs[1].content[1].cache_control, undefined);
    assert.equal(out[0], msgs[0]);
    assert.equal(anthropic.buildBody({ model: 'm', messages: msgs }).messages[1].content[1].cache_control.type, 'ephemeral');
  });
  test('imageBlock: jpg alias, unsupported types and oversized images become notes', () => {
    assert.equal(anthropic.imageBlock({ data: 'QUJD', mimeType: 'image/jpg' }).source.media_type, 'image/jpeg');
    assert.match(anthropic.imageBlock({ data: 'QUJD', mimeType: 'image/bmp' }).text, /only PNG, JPEG, GIF and WebP/);
    assert.match(anthropic.imageBlock({ data: 'A'.repeat(8 * 1024 * 1024), mimeType: 'image/png' }).text, /larger than 5 MB/);
  });
  test('Anthropic tool results carry images; OpenAI gets them as a user message after the tool messages', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'look' }] },
      { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.png' } }, { type: 'toolCall', id: 't2', name: 'read', arguments: { path: 'b.txt' } }] },
      { role: 'toolResult', toolCallId: 't1', toolName: 'read', content: [{ type: 'text', text: 'Image a.png' }, { type: 'image', data: 'QUJD', mimeType: 'image/png' }] },
      { role: 'toolResult', toolCallId: 't2', toolName: 'read', content: [{ type: 'text', text: '1\tx' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];
    const a = anthropic.toAnthropicMessages(msgs);
    assert.deepEqual(a[2].content[0].content, [{ type: 'text', text: 'Image a.png' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }]);
    const o = openai.toOpenAIMessages(msgs);
    assert.deepEqual(o.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'user', 'assistant']);
    assert.deepEqual(o[4].content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } });
    assert.equal(o[2].content, 'Image a.png');
  });
  test('whitespace-only text blocks are not sent to Anthropic', () => {
    const out = anthropic.toAnthropicMessages([{ role: 'user', content: [{ type: 'text', text: 'q' }] }, { role: 'assistant', content: [{ type: 'text', text: '  \n' }, { type: 'text', text: 'a' }] }]);
    assert.deepEqual(out[1].content, [{ type: 'text', text: 'a' }]);
  });
});

// =====================================================================================================
describe('system prompt', () => {
  const env = { workspace: 'C:\\proj', shell: 'Windows cmd.exe', os: 'Windows_NT 10.0 (x64)', date: '2026-11-03', git: 'branch main, working tree clean' };
  test('sections in a fixed order; plan mode and approvals change only their own part', () => {
    const p = prompt.buildSystemPrompt({ env, model: 'anthropic/claude-test', approvals: 'ask', rules: [{ path: 'C:\\proj\\sub\\AGENTS.md', text: 'NEAR' }, { path: 'C:\\proj\\AGENTS.md', text: 'ROOT' }], skills: '# Skills\n- s', mcp: '' });
    const order = ['You are ORBIX', '# How to work', '# Replies', '# Context conventions', '# Environment', '# Approvals', '# Project instructions', '# Skills'];
    let last = -1;
    for (const h of order) {
      const i = p.indexOf(h);
      assert.ok(i > last, h);
      last = i;
    }
    assert.ok(p.indexOf('ROOT') < p.indexOf('NEAR'), 'root rules first, nearest last');
    assert.match(p, /- Git at session start: branch main, working tree clean/);
    assert.match(p, /- Model: anthropic\/claude-test/);
    assert.doesNotMatch(p, /PLAN MODE/);
    const planned = prompt.buildSystemPrompt({ env, approvals: 'ask', planMode: true });
    assert.match(planned, /# PLAN MODE IS ON/);
    assert.match(prompt.buildSystemPrompt({ env, approvals: 'auto' }), /run without asking/);
    assert.match(prompt.buildSystemPrompt({ env, approvals: 'edits' }), /write and edit run without asking.*bash asks/s);
    assert.doesNotMatch(prompt.buildSystemPrompt({ env, approvals: null }), /# Approvals/);
    assert.equal(prompt.buildSystemPrompt({ env, approvals: 'ask' }), prompt.buildSystemPrompt({ env, approvals: 'ask' }), 'deterministic');
  });
  test('summarizeStatus', () => {
    assert.equal(prompt.summarizeStatus({ repo: false }), 'not a git repository');
    assert.equal(prompt.summarizeStatus({ repo: true, branch: 'dev', upstream: 'origin/dev', ahead: 2, behind: 0, files: [] }), 'branch dev tracking origin/dev (ahead 2), working tree clean');
    const files14 = Array.from({ length: 14 }, (_, i) => ({ x: 'M', y: ' ', path: `f${i}.js` }));
    const s = prompt.summarizeStatus({ repo: true, branch: 'main', files: [{ x: '?', y: '?', path: 'new.txt', untracked: true }, ...files14] });
    assert.match(s, /^branch main, 15 changed: \?\? new\.txt, M f0\.js/);
    assert.match(s, /… 3 more$/);
  });
  test('subagentPrompt adds the read-only role', () => {
    assert.match(prompt.subagentPrompt('BASE'), /^BASE\n\n# You are a subagent/);
    const s = prompt.subagentPrompt('BASE', ['read', 'grep', 'web_search']);
    assert.match(s, /your only tools are read, grep, web_search;/);
    assert.match(s, /overrides the instructions above/);
    assert.match(s, /cannot edit files, run commands, delegate or ask anyone questions/);
  });
  test('the core prompt covers verification honesty and truncated tool output', () => {
    const p = prompt.buildSystemPrompt({ env, approvals: null });
    assert.match(p, /Do not weaken, skip or delete tests/);
    assert.match(p, /Long tool output is cut in the middle at a "\[… omitted …\]" marker/);
  });
});

// =====================================================================================================
describe('prompt inputs: mentions, attachments, images', () => {
  const ws = path.join(TMP, 'mention-ws');
  const backend = new Backend({ kind: 'native' });
  before(() => {
    put(path.join(ws, 'shot.png'), png(100, 50));
    put(path.join(ws, 'u16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('wide text', 'utf16le')]));
    put(path.join(ws, 'dir', 'a.txt'), 'aaaa');
    fs.mkdirSync(path.join(ws, 'dir', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'dir', 'node_modules'), { recursive: true });
  });
  test('@image attaches the image; @utf16 is decoded; a folder lists folders first with file sizes', async () => {
    if (process.platform !== 'win32') return;
    const got = await context.readMentions(backend, ws, 'see @shot.png @u16.txt and @dir');
    assert.equal(got[0].image.mimeType, 'image/png');
    assert.match(got[0].text, /PNG, 100x50 px/);
    assert.equal(got[1].text, 'wide text');
    assert.equal(got[2].text, '(folder listing: 1 folder, 1 file)\nsub/\na.txt  (1 KB)');
  });
  test('promptAttachments: text, base64 text, images, binary and bad base64', () => {
    const r = context.promptAttachments([
      { name: 'notes.md', text: '# hi' },
      { name: 'log.txt', data: Buffer.from('log line').toString('base64') },
      { name: 'p.png', data: png(10, 10).toString('base64'), mimeType: 'image/png' },
      { name: 'x.bin', data: Buffer.from([0, 1, 2, 0]).toString('base64') },
      { name: 'bad', data: '***' },
      null,
    ]);
    assert.deepEqual(r.attachments, [{ path: 'notes.md', text: '# hi' }, { path: 'log.txt', text: 'log line' }]);
    assert.equal(r.images.length, 1);
    assert.equal(r.notes.length, 2);
    assert.match(r.notes[0], /x\.bin is a binary file/);
  });
  test('promptImages: data URLs, type from the bytes, notes for unusable images', () => {
    const r = context.promptImages([{ type: 'image', data: `data:image/jpeg;base64,${png(4, 4).toString('base64')}`, mimeType: 'image/jpeg' }, { data: 'Zm9v' }, { data: '%%' }, {}]);
    assert.equal(r.images.length, 1);
    assert.equal(r.images[0].mimeType, 'image/png'); // the bytes say PNG, whatever the label said
    assert.equal(r.notes.length, 2);
  });
});

// =====================================================================================================
// The agent loop against a scripted Anthropic-compatible mock.
const enc = new TextEncoder();
const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function turn({ text = '', tools = [], stop = 'end_turn', input = 100, output = 20, cacheRead = 0 }) {
  const out = [ev('message_start', { message: { usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 } } })];
  let i = 0;
  if (text) {
    out.push(ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } }));
    out.push(ev('content_block_delta', { index: i, delta: { type: 'text_delta', text } }));
    out.push(ev('content_block_stop', { index: i }));
    i++;
  }
  for (const t of tools) {
    out.push(ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: t.id, name: t.name } }));
    out.push(ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: t.json ?? JSON.stringify(t.args) } }));
    if (t.json == null) out.push(ev('content_block_stop', { index: i }));
    i++;
  }
  out.push(ev('message_delta', { delta: { stop_reason: stop }, usage: { output_tokens: output } }));
  out.push(ev('message_stop', {}));
  return out.join('');
}
const sseResponse = (body) => () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
/** A response that sends `body` and then breaks the connection. */
const brokenResponse = (body) => () => {
  let n = 0;
  return new Response(new ReadableStream({ pull(c) { if (n++ === 0) c.enqueue(enc.encode(body)); else c.error(new TypeError('terminated')); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

describe('agent loop end to end (mock provider)', () => {
  const ws = path.join(TMP, 'agent-ws');
  const config = {
    data: { approvals: 'auto', providers: {}, defaultModel: 'anthropic/claude-test' },
    provider: (id) => PRESETS.find((p) => p.id === id),
    type: (id) => PRESETS.find((p) => p.id === id)?.type,
    baseUrl: (id) => (id === 'anthropic' ? 'http://mock.anthropic' : 'http://mock.openai/v1'),
    configured: (id) => id === 'anthropic' || id === 'openai',
    configuredIds: () => ['anthropic', 'openai'],
    getKey: async () => 'test-key',
  };
  const procs = [];
  const make = async (opts = {}) => {
    const p = new AgentProc({ id: 'p' + procs.length, backend: new Backend({ kind: 'native' }), workspace: ws, config, ...opts });
    p.events = [];
    p.on('event', (e) => p.events.push(e));
    procs.push(p);
    await p.start();
    return p;
  };
  /** Send a command and wait for the run it starts to end; returns the agent_end event. */
  const runCmd = async (p, cmd) => {
    const from = p.events.length;
    const res = await p.request(cmd);
    assert.equal(res.success, true);
    for (let i = 0; i < 400; i++) {
      const end = p.events.slice(from).find((e) => e.type === 'agent_end');
      if (end) return end;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('the run did not end');
  };
  const send = (p, message, extra = {}) => runCmd(p, { type: 'prompt', message, ...extra });
  const lastBody = () => requests[requests.length - 1].body;
  before(() => {
    put(path.join(ws, 'AGENTS.md'), 'Always answer in English.');
    put(path.join(ws, 'hello.txt'), 'hello world\n');
  });
  after(async () => {
    for (const p of procs) await p.stop();
  });

  test('a plain reply: system prompt with environment and project rules, cache breakpoints, status and cost', async () => {
    const p = await make();
    script = [sseResponse(turn({ text: 'Hi there.', input: 1000, output: 10 }))];
    const end = await send(p, 'hello');
    const body = lastBody();
    assert.match(body.system[0].text, /^You are ORBIX/);
    assert.match(body.system[0].text, /# Environment\n- Project folder: .*agent-ws/);
    assert.match(body.system[0].text, /<instructions path=".*AGENTS\.md">\nAlways answer in English\.\n<\/instructions>/);
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(body.messages.at(-1).content.at(-1).cache_control, { type: 'ephemeral' });
    assert.ok(body.tools.some((t) => t.name === 'bash' && /cmd\.exe/.test(t.description)));
    assert.equal(end.status, 'completed');
    assert.equal(end.stopReason, 'stop');
    assert.equal(end.turns, 1);
    assert.deepEqual(end.usage, { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0 });
    assert.ok(Math.abs(end.cost - (1000 * 3 + 10 * 15) / 1e6) < 1e-12);
    const pr = p.events.find((e) => e.type === 'prompt_result');
    assert.equal(pr.status, 'completed');
    assert.equal(p.messages[0].id.startsWith('u'), true);
    // The system prompt is byte-identical on the next prompt (prompt cache keeps hitting).
    script = [sseResponse(turn({ text: 'Again.' }))];
    await send(p, 'again');
    assert.equal(lastBody().system[0].text, body.system[0].text);
  });

  test('tool calls run, results go back, partial arguments stream to the UI', async () => {
    const p = await make();
    script = [sseResponse(turn({ tools: [{ id: 'tu1', name: 'read', args: { path: 'hello.txt' } }], stop: 'tool_use' })), sseResponse(turn({ text: 'It says hello world.' }))];
    const end = await send(p, 'what is in hello.txt?');
    assert.equal(end.toolCalls, 1);
    assert.equal(end.turns, 2);
    const tr = p.messages.find((m) => m.role === 'toolResult');
    assert.equal(tr.content[0].text, '1\thello world');
    assert.ok(Number.isFinite(tr.details.wallTimeMs));
    const sent = lastBody().messages;
    assert.equal(sent.at(-1).content[0].type, 'tool_result');
    assert.ok(p.events.some((e) => e.type === 'message_update' && e.assistantMessageEvent.type === 'toolcall_end'));
    // bash colour codes are kept in the result (UI) but not sent to the model
    script = [sseResponse(turn({ tools: [{ id: 'b1', name: 'bash', args: { command: 'echo \x1b[32mgreen\x1b[0m' } }], stop: 'tool_use' })), sseResponse(turn({ text: 'ok' }))];
    await send(p, 'run it');
    assert.match(p.messages.filter((m) => m.role === 'toolResult').at(-1).content[0].text, /\x1b\[32m/);
    assert.doesNotMatch(lastBody().messages.at(-1).content[0].content, /\x1b/);
  });

  test('max_tokens on a text reply continues automatically once', async () => {
    const p = await make();
    script = [sseResponse(turn({ text: 'Part one', stop: 'max_tokens' })), sseResponse(turn({ text: ' and part two.' }))];
    const end = await send(p, 'long answer please');
    assert.equal(end.status, 'completed');
    assert.equal(end.turns, 2);
    const note = p.messages.find((m) => m.role === 'custom');
    assert.equal(note.customType, 'continue');
    const sent = lastBody().messages;
    assert.match(sent.at(-1).content.at(-1).text, /cut off by the output token limit\. Continue exactly where it stopped/);
    assert.equal(sent.at(-2).role, 'assistant');
  });

  test('a tool call cut off by max_tokens is not run and the model is told to make smaller calls', async () => {
    const p = await make();
    script = [sseResponse(turn({ tools: [{ id: 'tw', name: 'write', json: '{"path":"big.txt","content":"aaa' }], stop: 'max_tokens' })), sseResponse(turn({ text: 'Will split it.' }))];
    await send(p, 'write a big file');
    assert.ok(!fs.existsSync(path.join(ws, 'big.txt')));
    const tr = p.messages.find((m) => m.role === 'toolResult');
    assert.equal(tr.isError, true);
    assert.match(tr.content[0].text, /cut off because the reply reached the output token limit/);
  });

  test('a tool call with malformed JSON is not run; the model is told the expected arguments', async () => {
    const p = await make();
    script = [sseResponse(turn({ tools: [{ id: 'tj', name: 'edit', json: '{"path":"hello.txt","old_string":"hello" "new_string":"bye"}' }], stop: 'tool_use' })), sseResponse(turn({ text: 'Retrying.' }))];
    // json without content_block_stop: the assembler closes it at the end of the stream
    await send(p, 'edit it');
    assert.equal(fs.readFileSync(path.join(ws, 'hello.txt'), 'utf8'), 'hello world\n');
    const tr = p.messages.find((m) => m.role === 'toolResult');
    assert.equal(tr.isError, true);
    assert.match(tr.content[0].text, /^Not run: the arguments were not valid JSON\. Send the call again with one complete JSON object: edit\(path: string, old_string: string, new_string: string, replace_all\?: boolean\)/);
  });

  test('a subagent is told exactly which tools it has', async () => {
    const p = await make();
    script = [sseResponse(turn({ tools: [{ id: 'tk', name: 'task', args: { tasks: [{ task: 'look around' }] } }], stop: 'tool_use' })), sseResponse(turn({ text: 'Found it.' })), sseResponse(turn({ text: 'Summary.' }))];
    await send(p, 'research');
    const sub = requests.find((r) => /# You are a subagent/.test(r.body.system?.[0]?.text || ''));
    assert.ok(sub, 'the subagent request was made');
    assert.match(sub.body.system[0].text, /your only tools are read, glob, grep, web_fetch;/);
    assert.deepEqual(sub.body.tools.map((t) => t.name), ['read', 'glob', 'grep', 'web_fetch']);
  });

  test('an empty reply is retried once and left out of the context', async () => {
    const p = await make();
    script = [sseResponse(turn({})), sseResponse(turn({ text: 'Now an answer.' }))];
    const end = await send(p, 'answer me');
    assert.equal(end.status, 'completed');
    assert.equal(end.stopReason, 'stop');
    assert.equal(p.messages.filter((m) => m.role === 'assistant')[0].discard, true);
    assert.deepEqual(lastBody().messages.map((m) => m.role), ['user']);
    script = [sseResponse(turn({})), sseResponse(turn({}))];
    const twice = await send(p, 'again');
    assert.equal(twice.stopReason, 'empty');
    assert.ok(p.events.some((e) => e.type === 'notice' && /empty reply/.test(e.message)));
  });

  test('a connection that breaks mid-reply is retried once from the start', async () => {
    const p = await make();
    const partial = [ev('message_start', { message: { usage: { input_tokens: 10 } } }), ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }), ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Half an ans' } })].join('');
    script = [brokenResponse(partial), sseResponse(turn({ text: 'Whole answer.' }))];
    const end = await send(p, 'question');
    assert.equal(end.status, 'completed');
    const asst = p.messages.filter((m) => m.role === 'assistant');
    assert.equal(asst[0].discard, true);
    assert.match(asst[0].errorMessage, /Connection lost.*\(retrying\)/);
    assert.equal(asst[1].content[0].text, 'Whole answer.');
    assert.deepEqual(lastBody().messages.map((m) => m.role), ['user']);
    assert.ok(p.events.some((e) => e.type === 'auto_retry_start' && /Connection lost/.test(e.errorMessage)));
  });

  test('a provider error ends the run with status error and a clear message', async () => {
    const p = await make();
    script = [() => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 })];
    const end = await send(p, 'hi');
    assert.equal(end.status, 'error');
    assert.match(end.errorMessage, /The API key was rejected \(401\): invalid x-api-key/);
  });

  test('regenerate replaces the last reply; the session file rebuilds the same and keeps the spent tokens', async () => {
    const p = await make();
    script = [sseResponse(turn({ text: 'First try.', input: 50, output: 5 }))];
    await send(p, 'tell me a joke');
    script = [sseResponse(turn({ text: 'Second try.', input: 50, output: 7 }))];
    const end = await runCmd(p, { type: 'regenerate' });
    assert.equal(end.status, 'completed');
    assert.deepEqual(p.messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(p.messages[1].content[0].text, 'Second try.');
    assert.ok(p.events.some((e) => e.type === 'session_rewound' && e.removed === 1));
    assert.equal(p.usage.output, 12, 'both replies were paid for');
    const rebuilt = compact.rebuildSession(p.session.file);
    assert.deepEqual(rebuilt.messages.map((m) => m.content[0].text), ['tell me a joke', 'Second try.']);
    assert.equal(rebuilt.extras.droppedUsage.output, 5);
    const resumed = await make({ resume: p.session.file });
    assert.equal(resumed.usage.output, 12);
    await resumed.stop();
  });

  test('edit_message rewinds to that message, can undo its file changes, and runs the new text', async () => {
    const p = await make();
    script = [sseResponse(turn({ tools: [{ id: 'w1', name: 'write', args: { path: 'made.txt', content: 'v1' } }], stop: 'tool_use' })), sseResponse(turn({ text: 'Wrote it.' }))];
    await send(p, 'create made.txt');
    assert.equal(fs.readFileSync(path.join(ws, 'made.txt'), 'utf8'), 'v1');
    const first = p.messages[0];
    script = [sseResponse(turn({ text: 'Okay, nothing written.' }))];
    const from = p.events.length;
    const end = await runCmd(p, { type: 'edit_message', messageId: first.id, message: 'never mind', undo: true });
    assert.equal(end.status, 'completed');
    assert.ok(!fs.existsSync(path.join(ws, 'made.txt')), 'undo removed the created file');
    assert.deepEqual(p.messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(p.messages[0].content[0].text, 'never mind');
    assert.ok(p.events.slice(from).some((e) => e.type === 'session_rewound' && /Removed/.test(e.undo)));
    await assert.rejects(p.request({ type: 'edit_message', messageId: 'nope', message: 'x' }), /not found/);
  });

  test('images and attachments sent with a prompt reach the model; a model without vision gets notes instead', async () => {
    const p = await make();
    script = [sseResponse(turn({ text: 'I see a tiny PNG.' }))];
    await send(p, 'what is this?', { images: [{ type: 'image', data: png(8, 8).toString('base64'), mimeType: 'image/png' }], attachments: [{ name: 'notes.txt', text: 'attached text' }] });
    const content = lastBody().messages[0].content;
    assert.equal(content.find((c) => c.type === 'image').source.media_type, 'image/png');
    assert.ok(content.some((c) => c.type === 'text' && c.text.includes('<file path="notes.txt">\nattached text\n</file>')));
    const blind = await make({ model: 'anthropic/claude-blind' });
    script = [sseResponse(turn({ text: 'Cannot see.' }))];
    await send(blind, 'and now?', { images: [{ data: png(8, 8).toString('base64') }] });
    const c2 = lastBody().messages[0].content;
    assert.ok(!c2.some((c) => c.type === 'image'));
    assert.ok(c2.some((c) => /cannot view images/.test(c.text || '')));
  });

  test('a steer sent while the agent works is added before the next step', async () => {
    const p = await make();
    let release;
    const gate = new Promise((r) => (release = r));
    script = [
      async () => {
        await gate;
        return sseResponse(turn({ tools: [{ id: 'r1', name: 'read', args: { path: 'hello.txt' } }], stop: 'tool_use' }))();
      },
      sseResponse(turn({ text: 'Done, and noted.' })),
    ];
    const from = p.events.length;
    await p.request({ type: 'prompt', message: 'read hello.txt' });
    const q = await p.request({ type: 'prompt', message: 'also be brief' });
    assert.equal(q.data.queued, true);
    release();
    for (let i = 0; i < 400 && !p.events.slice(from).some((e) => e.type === 'agent_end'); i++) await new Promise((r) => setTimeout(r, 10));
    const users = p.messages.filter((m) => m.role === 'user');
    assert.deepEqual(users.map((m) => [m.content[0].text, m.attribution]), [['read hello.txt', 'user'], ['also be brief', 'steer']]);
    // It reaches the model on the next request after it arrived (before the first call or after the tool step).
    assert.ok(lastBody().messages.some((m) => m.role === 'user' && m.content.some((c) => c.text === 'also be brief')));
  });

  test('/retry regenerates; get_state lists the protocol features', async () => {
    const p = await make();
    script = [sseResponse(turn({ text: 'one' }))];
    await send(p, 'q');
    script = [sseResponse(turn({ text: 'two' }))];
    await runCmd(p, { type: 'prompt', message: '/retry' });
    assert.equal(p.messages.at(-1).content[0].text, 'two');
    const st = await p.request({ type: 'get_state' });
    assert.deepEqual(st.data.features, ['regenerate', 'edit_message', 'attachments', 'prompt_status', 'branch']);
  });
});
