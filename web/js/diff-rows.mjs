/** Keep file metadata separate from content, even when a hunk adds a line beginning with "++ ". */
export function diffRows(text, file = '') {
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      file = line.replace(/^diff --git a\/(.+) b\/.+$/, '$1');
      oldLeft = newLeft = 0;
      rows.push({ cls: 'file', text: file });
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      oldLeft = Number(hunk[2] ?? 1);
      newLine = Number(hunk[3]);
      newLeft = Number(hunk[4] ?? 1);
      rows.push({ cls: 'hunk', text: line });
      continue;
    }
    if (line === '\\ No newline at end of file') {
      rows.push({ cls: 'meta', text: line });
    } else if (oldLeft > 0 && line.startsWith('-')) {
      rows.push({ cls: 'del', a: oldLine++, b: '', text: line.slice(1), file });
      oldLeft--;
    } else if (newLeft > 0 && line.startsWith('+')) {
      rows.push({ cls: 'add', a: '', b: newLine++, text: line.slice(1), file });
      newLeft--;
    } else if (oldLeft > 0 && newLeft > 0 && line.startsWith(' ')) {
      rows.push({ cls: 'eq', a: oldLine++, b: newLine++, text: line.slice(1), file });
      oldLeft--;
      newLeft--;
    } else if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
      file = line.slice(4).replace(/^b\//, '').trim();
    } else if (line && !/^(--- |\+\+\+ |index )/.test(line)) {
      rows.push({ cls: 'meta', text: line });
    }
  }
  return rows;
}

/** Changes on the two sides stay aligned within a hunk; excess lines get an empty opposite cell. */
export function splitDiffRows(rows) {
  const result = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (row.cls !== 'del' && row.cls !== 'add') {
      result.push(row.cls === 'eq' ? { before: row, after: row } : { meta: row });
      index++;
      continue;
    }
    const before = [];
    const after = [];
    while (rows[index]?.cls === 'del') before.push(rows[index++]);
    while (rows[index]?.cls === 'add') after.push(rows[index++]);
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      result.push({ before: before[i], after: after[i] });
    }
  }
  return result;
}
