import { h } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { delimitedPreview } from './delimited-preview.mjs';

const MAX_MARKUP = 256 * 1024;
const MARKDOWN = new Set(['md', 'markdown']);
const HTML = new Set(['htm', 'html']);
const TABLE = new Set(['csv', 'tsv']);
const STRUCTURE = new Set('article section div p h1 h2 h3 h4 h5 h6 b strong i em code pre blockquote ul ol li dl dt dd span br hr table caption thead tbody tfoot tr td th'.split(' '));
const IGNORE = new Set('script style svg math iframe object embed template link meta title base noscript audio video canvas'.split(' '));

export const previewableText = (file) => !file.binary && (MARKDOWN.has(file.ext) || HTML.has(file.ext) || TABLE.has(file.ext));

function staticHtml(text) {
  // Parse in an inert template. Only newly constructed formatting nodes and text are ever attached.
  const parsed = document.createElement('template');
  parsed.innerHTML = text;
  const result = h('div', { class: 'md' });
  let budget = 4000;
  const append = (target, node, depth) => {
    if (--budget < 0 || depth > 30) return;
    if (node.nodeType === Node.TEXT_NODE) {
      target.append(node.data);
    } else if (node.nodeType === Node.ELEMENT_NODE && !IGNORE.has(node.localName)) {
      const display = STRUCTURE.has(node.localName) ? h(node.localName) : target;
      if (display !== target) target.append(display);
      for (const child of node.childNodes) append(display, child, depth + 1);
    }
  };
  for (const node of parsed.content.childNodes) append(result, node, 0);
  return result;
}

function tablePreview(file) {
  const { rows, truncated } = delimitedPreview(file.content, file.ext === 'tsv' ? '\t' : ',');
  if (!rows.length) return h('div', { class: 'empty' }, 'There are no rows to preview.');
  const [headers, ...values] = rows;
  const width = Math.max(...rows.map((row) => row.length));
  const line = (row, tag) => h('tr', null, Array.from({ length: width }, (_, i) => h(tag, tag === 'th' ? { scope: 'col' } : null, row[i] ?? '')));
  const table = h('table', null, h('thead', null, line(headers, 'th')), h('tbody', null, values.map((row) => line(row, 'td'))));
  return h('div', { class: 'md' }, h('div', { class: 'table-wrap' }, table),
    truncated ? h('div', { class: 'p-note' }, 'Table preview is limited to the first 200 data rows and 40 columns. Use Source to see the file.') : null);
}

export function fileTextPreview(file) {
  if (TABLE.has(file.ext)) return tablePreview(file);
  if (file.content.length > MAX_MARKUP) return h('div', { class: 'empty' }, 'This file is too large to render. Use Source to see the file.');
  return MARKDOWN.has(file.ext) ? renderMarkdown(file.content) : staticHtml(file.content);
}
