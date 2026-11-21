// Compare the current streaming boundary scanner with a prior packaged ORBIX build.
// node tools/bench-markdown.mjs dist/3.9.5/win-unpacked/resources/app.asar
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { extractFile } from '@electron/asar';
import { MarkdownBoundary } from '../web/js/markdown-stream.mjs';

const archive = process.argv[2];
if (!archive) throw new Error('Pass the path to a baseline app.asar.');
const before = extractFile(archive, path.join('web', 'js', 'session.js')).toString();
const code = before.match(/^function stableCut\(text\) \{[\s\S]*?^\}/m)?.[0];
if (!code) throw new Error('Baseline has no stableCut scanner.');
const legacy = vm.runInThisContext(`(${code})`);
const input = ('A project note.\n\n' + '```js\n' + 'const fixture = [1, 2, 3];\n'.repeat(125) + '```\n\n').repeat(54) + 'Finished.';
const updates = Array.from({ length: Math.ceil(input.length / 127) }, (_, n) => input.slice(0, (n + 1) * 127));
function measure(create) {
  const samples = [];
  for (let run = 0; run < 4; run++) {
    const advance = create();
    const start = performance.now();
    let cut;
    for (const text of updates) cut = advance(text);
    const elapsed = performance.now() - start;
    assert.equal(cut, input.lastIndexOf('Finished.'));
    if (run) samples.push(elapsed);
  }
  return samples.sort((a, b) => a - b)[1];
}
const old = measure(() => legacy);
const now = measure(() => { const scanner = new MarkdownBoundary(); return (s) => scanner.advance(s); });
console.log(`Scanner only · ${input.length} characters in ${updates.length} updates · median of three runs\n` +
  `Before: ${old.toFixed(1)} ms · after: ${now.toFixed(1)} ms · ${(old / now).toFixed(1)}× faster.`);
