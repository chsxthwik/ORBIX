import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delimitedPreview } from '../web/js/delimited-preview.mjs';

test('CSV and TSV previews keep quoted separators, line breaks, and empty cells', () => {
  assert.deepEqual(delimitedPreview('\uFEFFname,value,\r\n"Alpha, Beta","a\r\n""quote""",\r\n', ','), {
    rows: [['name', 'value', ''], ['Alpha, Beta', 'a\r\n"quote"', '']],
    truncated: false,
  });
  assert.deepEqual(delimitedPreview('a\t\t', '\t').rows, [['a', '', '']]);
  assert.deepEqual(delimitedPreview('a,b,c\n1,2,3\nx,y,z', ',', { maxRows: 2, maxColumns: 2 }), {
    rows: [['a', 'b'], ['1', '2']],
    truncated: true,
  });
});
