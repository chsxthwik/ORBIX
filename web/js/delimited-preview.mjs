/** Parse enough CSV or TSV for a read-only preview, including quotes and newlines inside fields. */
export function delimitedPreview(source, separator, { maxRows = 201, maxColumns = 40 } = {}) {
  const text = source.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let truncated = false;
  const cell = () => {
    if (row.length < maxColumns) row.push(field);
    else truncated = true;
    field = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && !field) {
      quoted = true;
    } else if (ch === separator) {
      cell();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cell();
      rows.push(row);
      row = [];
      if (rows.length === maxRows) return { rows, truncated: truncated || i + 1 < text.length };
    } else {
      field += ch;
    }
  }
  if (field || row.length || text.endsWith('"')) {
    cell();
    rows.push(row);
  }
  return { rows, truncated: truncated || quoted };
}
