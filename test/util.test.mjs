// Regression tests for src/util.mjs (pure helpers + small file helpers).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clip, escapeHtml, makeTitle, mkdirp, readHead, readJson, writeJson } from '../src/util.mjs';

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-test-util-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('makeTitle', () => {
  test('empty / nullish / whitespace-only input gives an empty title', () => {
    for (const v of ['', '   \n\t ', null, undefined]) assert.equal(makeTitle(v), '');
  });

  test('capitalises the first letter and trims', () => {
    assert.equal(makeTitle('  fix the login bug  '), 'Fix the login bug');
  });

  test('keeps only the first sentence, but not a dot inside a token', () => {
    assert.equal(makeTitle('Fix the bug. Then deploy it!'), 'Fix the bug');
    assert.equal(makeTitle('Why does it fail? I do not know'), 'Why does it fail');
    assert.equal(makeTitle('Upgrade to v1.2 now. Later more'), 'Upgrade to v1.2 now');
  });

  test('strips polite filler words repeatedly, case-insensitively', () => {
    assert.equal(makeTitle('Please can you fix the login bug'), 'Fix the login bug');
    assert.equal(makeTitle('HEY, could you help me refactor the parser'), 'Refactor the parser');
    assert.equal(makeTitle("ok so now let's add tests"), 'Add tests');
    assert.equal(makeTitle('I want you to write a README'), 'Write a README');
  });

  test('filler must be a whole word: "something" / "sorted" / "history" are not touched', () => {
    assert.equal(makeTitle('something odd happens'), 'Something odd happens');
    assert.equal(makeTitle('sorted list is wrong'), 'Sorted list is wrong');
    assert.equal(makeTitle('history of commits'), 'History of commits');
  });

  test('a message that is only filler is kept as typed (minus trailing punctuation)', () => {
    assert.equal(makeTitle('hi'), 'Hi');
    assert.equal(makeTitle('ok.'), 'Ok');
    assert.equal(makeTitle('Can you?'), 'Can you');
  });

  test('removes emoji, variation selectors and ZWJ sequences', () => {
    assert.equal(makeTitle('🚀 Deploy the app 🎉'), 'Deploy the app');
    assert.equal(makeTitle('Fix ❤️ the 👩‍💻 bug'), 'Fix the bug');
  });

  test('removes fenced code blocks, including an unterminated one', () => {
    assert.equal(makeTitle('```js\nconsole.log(1)\n``` fix this please'), 'Fix this please');
    assert.equal(makeTitle('Explain this ```const x = 1;\nmore code'), 'Explain this');
    assert.equal(makeTitle('```\nonly code\n```'), '');
  });

  test('removes markdown decoration characters and collapses whitespace', () => {
    assert.equal(makeTitle('# **Fix**   `the`\n\n> [login] bug'), 'Fix the login bug');
  });

  test('a title of exactly `max` characters is not shortened', () => {
    const s = 'a'.repeat(48);
    assert.equal(makeTitle(s), 'A' + 'a'.repeat(47));
    assert.equal(makeTitle(s).length, 48);
  });

  test('longer titles are cut on a word boundary and end with an ellipsis', () => {
    const t = makeTitle('Implement the incremental parser for the configuration file format properly');
    assert.equal(t, 'Implement the incremental parser for the…');
    assert.ok(t.length <= 49);
    // The kept part is a whole-word prefix of the (capitalised) input.
    assert.ok('Implement the incremental parser for the configuration file format properly'.startsWith(t.slice(0, -1)));
  });

  test('a long unbroken token is hard-cut at `max` and gets an ellipsis', () => {
    assert.equal(makeTitle('x'.repeat(60)), 'X' + 'x'.repeat(47) + '…');
  });

  test('a late space (past 55% of max) is used as the cut, an early one is not', () => {
    // space at index 4 is too early to be a good cut -> hard cut
    const early = makeTitle('abcd ' + 'z'.repeat(70));
    assert.equal(early, 'Abcd ' + 'z'.repeat(43) + '…');
    // space at index 30 is past 55% of 48 -> cut there
    assert.equal(makeTitle('a'.repeat(30) + ' ' + 'b'.repeat(30)), 'A' + 'a'.repeat(29) + '…');
  });

  test('trailing punctuation before the ellipsis is dropped', () => {
    const t = makeTitle('Refactor the module, then, finally, update all of the callers, please');
    assert.ok(t.endsWith('…'));
    assert.ok(!/[\s.,:;-]…$/.test(t), t);
  });

  test('custom max is honoured', () => {
    assert.equal(makeTitle('one two three four five six', 12), 'One two…');
  });

  test('non-string input is coerced', () => {
    assert.equal(makeTitle(12345), '12345');
  });
});

describe('escapeHtml', () => {
  test('escapes all five special characters', () => {
    assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  });

  test('does not double-escape in a single pass, but is not idempotent by design', () => {
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
    assert.equal(escapeHtml('a & b < c'), 'a &amp; b &lt; c');
  });

  test('null / undefined become the empty string, other falsy values are kept', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(0), '0');
    assert.equal(escapeHtml(false), 'false');
    assert.equal(escapeHtml(''), '');
  });

  test('neutralises an attribute-breaking payload', () => {
    const out = escapeHtml('"><img src=x onerror=alert(1)>');
    assert.ok(!/[<>"]/.test(out));
  });

  test('leaves unicode and plain text alone', () => {
    assert.equal(escapeHtml('héllo wörld 日本 🚀'), 'héllo wörld 日本 🚀');
  });
});

describe('clip', () => {
  test('returns short strings untouched, including exactly n characters', () => {
    assert.equal(clip('abc', 5), 'abc');
    assert.equal(clip('abcde', 5), 'abcde');
  });
  test('cuts to n characters and appends an ellipsis when longer', () => {
    assert.equal(clip('abcdef', 5), 'abcde…');
    assert.equal(clip('abc', 0), '…');
    assert.equal(clip('', 0), '');
  });
});

describe('readHead', () => {
  test('file shorter than N: returns the whole file', async () => {
    const f = path.join(tmp, 'short.txt');
    fs.writeFileSync(f, 'hello\nworld');
    assert.equal(await readHead(f, 1024), 'hello\nworld');
  });

  test('file longer than N: returns exactly the first N bytes', async () => {
    const f = path.join(tmp, 'long.txt');
    fs.writeFileSync(f, '0123456789'.repeat(100));
    const h = await readHead(f, 25);
    assert.equal(h, '0123456789012345678901234');
  });

  test('empty file gives an empty string', async () => {
    const f = path.join(tmp, 'empty.txt');
    fs.writeFileSync(f, '');
    assert.equal(await readHead(f, 100), '');
  });

  test('N is a byte count: a multi-byte character cut at the boundary becomes U+FFFD, earlier text is intact', async () => {
    const f = path.join(tmp, 'mb.txt');
    fs.writeFileSync(f, 'ab€cd'); // € = 3 bytes (E2 82 AC)
    assert.equal(await readHead(f, 4), 'ab\uFFFD'); // cuts inside €
    assert.equal(await readHead(f, 5), 'ab€');
  });

  test('missing file rejects', async () => {
    await assert.rejects(() => readHead(path.join(tmp, 'nope.txt'), 10), { code: 'ENOENT' });
  });
});

describe('readJson / writeJson / mkdirp', () => {
  test('writeJson creates missing parent directories and round-trips values', () => {
    const f = path.join(tmp, 'a', 'b', 'c.json');
    const v = { n: 1, s: 'é日本', arr: [1, { x: null }], nested: { ok: true } };
    writeJson(f, v);
    assert.deepEqual(readJson(f, null), v);
  });

  test('a failed writeJson leaves no temp file behind', () => {
    const dir = path.join(tmp, 'failwrite');
    const f = path.join(dir, 'target.json');
    fs.mkdirSync(f, { recursive: true }); // the rename onto a folder fails
    assert.throws(() => writeJson(f, { a: 1 }));
    assert.deepEqual(fs.readdirSync(dir), ['target.json']);
  });
  test('writeJson pretty-prints with two-space indentation', () => {
    const f = path.join(tmp, 'pretty.json');
    writeJson(f, { a: [1] });
    assert.equal(fs.readFileSync(f, 'utf8'), '{\n  "a": [\n    1\n  ]\n}');
  });

  test('writeJson replaces an existing file and leaves no temp files behind', () => {
    const dir = path.join(tmp, 'replace');
    const f = path.join(dir, 'cfg.json');
    writeJson(f, { v: 1 });
    writeJson(f, { v: 2 });
    assert.deepEqual(readJson(f), { v: 2 });
    assert.deepEqual(fs.readdirSync(dir), ['cfg.json']);
  });

  test('writeJson with an unserialisable value throws and keeps the previous file intact', () => {
    const dir = path.join(tmp, 'atomic');
    const f = path.join(dir, 'cfg.json');
    writeJson(f, { keep: 'me' });
    const cyc = {};
    cyc.self = cyc;
    assert.throws(() => writeJson(f, cyc), TypeError);
    assert.throws(() => writeJson(f, { big: 10n }), TypeError);
    assert.deepEqual(readJson(f), { keep: 'me' });
    assert.deepEqual(fs.readdirSync(dir), ['cfg.json']);
  });

  test('readJson returns the fallback for missing, empty, truncated and garbage files', () => {
    const fb = { fallback: true };
    assert.equal(readJson(path.join(tmp, 'missing.json'), fb), fb);
    const cases = { empty: '', truncated: '{"a": [1, 2', garbage: 'not json at all', html: '<html>' };
    for (const [name, body] of Object.entries(cases)) {
      const f = path.join(tmp, `bad-${name}.json`);
      fs.writeFileSync(f, body);
      assert.equal(readJson(f, fb), fb, name);
    }
  });

  test('readJson without a fallback yields undefined on failure; a stored JSON null is returned as null', () => {
    assert.equal(readJson(path.join(tmp, 'missing2.json')), undefined);
    const f = path.join(tmp, 'null.json');
    fs.writeFileSync(f, 'null');
    assert.equal(readJson(f, 'fb'), null);
  });

  test('readJson on a directory path yields the fallback', () => {
    assert.equal(readJson(tmp, 'fb'), 'fb');
  });

  test('readJson accepts a UTF-8 BOM (Notepad / PowerShell 5 write one on Windows)', () => {
    const f = path.join(tmp, 'bom.json');
    fs.writeFileSync(f, '\uFEFF{"a":1}');
    assert.deepEqual(readJson(f, 'fb'), { a: 1 });
  });

  test('mkdirp is recursive, idempotent and returns the directory', () => {
    const d = path.join(tmp, 'x', 'y', 'z');
    assert.equal(mkdirp(d), d);
    assert.equal(mkdirp(d), d);
    assert.ok(fs.statSync(d).isDirectory());
  });
});
