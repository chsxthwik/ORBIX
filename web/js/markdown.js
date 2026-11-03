// Safe Markdown → DOM renderer (GFM subset). Never uses innerHTML.
import { h, icon, copyButtonFeedback } from './dom.js';
import { highlight, langFor } from './highlight.js';

const SAFE_URL = /^(https?:|mailto:)/i;
// Inline code that is a file: anything with a folder part and an extension, or a bare name with a code extension
// ("src/a.ts:12", "hello.js"). "Date.now" or "os.path" are not files.
const CODE_EXT = 'js|mjs|cjs|jsx|ts|tsx|mts|cts|json|jsonc|md|mdx|py|pyi|rb|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|php|css|scss|less|html?|vue|svelte|astro|ya?ml|toml|ini|cfg|conf|sh|bash|zsh|ps1|psm1|bat|cmd|sql|txt|lock|xml|svg|gradle|swift|dart|lua|ipynb|csv|tsv|proto|graphql|tf|nix|zig|exs|erl|hs|scala|clj|mk|cmake|dockerfile';
const DOTFILE = 'env|gitignore|gitattributes|editorconfig|prettierrc|eslintrc|npmrc|nvmrc|dockerignore';
const PATH_LIKE = new RegExp(String.raw`^(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|~[\\/])?(?:(?:[\w@.\-+ ]+[\\/])+[\w@.\-+ ]*\.[A-Za-z0-9]{1,10}|[\w@\-+.]+\.(?:${CODE_EXT})|\.(?:${DOTFILE}))(?::\d+(?:-\d+)?)?$`, 'i');

const wrapLongLines = (code) => code.length > 90 && code.split('\n').some((l) => l.length > 100);

export function codeBlock(code, lang, { copy = true, maxHeight, plain = false } = {}) {
  const pre = h('pre', { class: 'code' + (langFor(lang) === 'diff' ? ' diff' : '') });
  const c = h('code');
  // While a long block is still streaming it is shown plain; it is highlighted once it is complete.
  c.append(plain && code.length > 2000 ? document.createTextNode(code) : highlight(code, lang));
  pre.append(c);
  const acts = h('span', { class: 'code-acts' });
  if (wrapLongLines(code)) {
    const wrapBtn = h('button', { class: 'code-btn', type: 'button', title: 'Wrap long lines', 'aria-pressed': 'false' }, icon('wrap', 13), 'Wrap');
    wrapBtn.addEventListener('click', () => wrapBtn.setAttribute('aria-pressed', String(pre.classList.toggle('wrap'))));
    acts.append(wrapBtn);
  }
  if (copy) {
    const copyBtn = h('button', { class: 'code-btn', type: 'button', title: 'Copy code', 'aria-label': 'Copy code' }, icon('copy', 13), 'Copy');
    copyBtn.addEventListener('click', () => copyButtonFeedback(copyBtn, code));
    acts.append(copyBtn);
  }
  const n = code.split('\n').length;
  const head = h('div', { class: 'code-head' }, h('span', { class: 'code-lang' }, lang || 'text'), n > 12 ? h('span', { class: 'code-n num' }, `${n} lines`) : null, h('span', { class: 'grow' }), acts);
  const wrap = h('div', { class: 'codeblock' }, head, pre);
  if (maxHeight) pre.style.maxHeight = maxHeight;
  return wrap;
}

// ---------- inline ----------
const INLINE = /\\(?<esc>[\\`*_{}[\]()#+\-.!|~<>])|(?<tick>`+)(?<code>[\s\S]+?)\k<tick>|\*\*(?<b1>[^\s*][\s\S]*?)\*\*|__(?<b2>[^\s_][\s\S]*?)__|(?<![*\w])\*(?<i1>[^\s*][^*]*?)\*(?!\w)|(?<![_\w])_(?<i2>[^\s_][^_]*?)_(?![_\w])|~~(?<del>[\s\S]+?)~~|(?<img>!?)\[(?<lt>[^\]]+)\]\((?<lu>[^)\s]+)(?:\s+"[^"]*")?\)|<(?<al>(?:https?:\/\/|mailto:)[^\s>]+)>|(?<url>https?:\/\/[^\s<>)\]]+[^\s<>)\].,;:!?'"])/g;

const link = (href, kids) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', title: href }, kids);

function inline(text, opts) {
  const frag = document.createDocumentFragment();
  let last = 0;
  let m;
  // A fresh regex per call: inline() recurses (bold inside links, etc.) and a shared global regex would
  // have its lastIndex reset by the inner call, making the outer loop spin forever.
  const re = new RegExp(INLINE.source, 'g');
  while ((m = re.exec(text))) {
    const g = m.groups;
    if (m.index > last) frag.append(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (g.esc != null) frag.append(g.esc);
    else if (g.code != null) {
      const code = g.code.length > 2 && g.code[0] === ' ' && g.code.at(-1) === ' ' ? g.code.slice(1, -1) : g.code;
      const el = h('code', { class: 'ic' }, code);
      if (opts.onPath && PATH_LIKE.test(code.trim()) && !/^https?:/.test(code)) {
        el.classList.add('pathref');
        el.title = 'Open file';
        el.tabIndex = 0;
        el.setAttribute('role', 'link');
        el.addEventListener('click', () => opts.onPath(code.trim()));
        el.addEventListener('keydown', (e) => e.key === 'Enter' && opts.onPath(code.trim()));
      }
      frag.append(el);
    } else if (g.b1 != null || g.b2 != null) frag.append(h('strong', null, inline(g.b1 ?? g.b2, opts)));
    else if (g.i1 != null || g.i2 != null) frag.append(h('em', null, inline(g.i1 ?? g.i2, opts)));
    else if (g.del != null) frag.append(h('del', null, inline(g.del, opts)));
    else if (g.lt != null) {
      // Remote images are blocked by the CSP: an image is shown as a link to it.
      if (SAFE_URL.test(g.lu)) frag.append(g.img ? link(g.lu, [icon('eye', 12, 'md-img-ico'), g.lt]) : link(g.lu, inline(g.lt, opts)));
      else frag.append(m[0]);
    } else if (g.al != null) frag.append(link(g.al, g.al));
    else if (g.url != null) frag.append(link(g.url, g.url));
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

function inlineLines(text, opts) {
  const frag = document.createDocumentFragment();
  text.split('\n').forEach((ln, i) => {
    if (i) frag.append(h('br'));
    frag.append(inline(ln.replace(/\s{2,}$/, ''), opts));
  });
  return frag;
}

// ---------- blocks ----------
const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
const splitRow = (l) => {
  let s = l.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
};
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

export function renderMarkdown(src, opts = {}) {
  const root = h('div', { class: 'md' });
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // fenced code
    const fence = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/.exec(line);
    if (fence) {
      const [, indent, tick, lang] = fence;
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${tick[0]}{${tick.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i]);
        i++;
      }
      i++; // closing fence (or EOF while streaming)
      root.append(codeBlock(body.join('\n'), lang, { plain: !!opts.live }));
      continue;
    }
    const hd = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (hd) {
      root.append(h('h' + hd[1].length, null, inline(hd[2], opts)));
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      root.append(h('hr'));
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) q.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      const inner = renderMarkdown(q.join('\n'), opts);
      inner.className = 'md quote';
      root.append(h('blockquote', null, inner));
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      const cell = (tag, t, k) => h(tag, { style: aligns[k] ? { textAlign: aligns[k] } : null }, inline(t, opts));
      root.append(h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, head.map((t, k) => cell('th', t, k)))), h('tbody', null, rows.map((r) => h('tr', null, head.map((_, k) => cell('td', r[k] ?? '', k))))))));
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      const base = li[1].length;
      const ordered = /\d/.test(li[2]);
      const list = h(ordered ? 'ol' : 'ul');
      if (ordered && parseInt(li[2], 10) !== 1) list.setAttribute('start', parseInt(li[2], 10));
      while (i < lines.length) {
        const m = LIST.exec(lines[i]);
        if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
        let text = m[3];
        i++;
        const sub = [];
        while (i < lines.length) {
          const l2 = lines[i];
          if (!l2.trim()) {
            if (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && (lines[i + 1].match(/^\s*/)[0].length > base)) {
              sub.push('');
              i++;
              continue;
            }
            break;
          }
          const ind = l2.match(/^\s*/)[0].length;
          if (ind > base) {
            sub.push(l2.slice(Math.min(ind, base + 2)));
            i++;
          } else break;
        }
        const item = h('li');
        const task = /^\[([ xX])\]\s+/.exec(text);
        if (task) {
          item.classList.add('task');
          item.append(h('input', { type: 'checkbox', disabled: true, checked: task[1] !== ' ' ? true : null }));
          text = text.slice(task[0].length);
        }
        item.append(inlineLines(text, opts));
        if (sub.length) {
          const nested = renderMarkdown(sub.join('\n'), opts);
          while (nested.firstChild) item.append(nested.firstChild);
        }
        list.append(item);
      }
      root.append(list);
      continue;
    }
    // paragraph
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(\s*)(`{3,}|~{3,})/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !/^\s{0,3}>/.test(lines[i]) && !(LIST.test(lines[i]) && para.length) && !/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(lines[i])) {
      if (lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]) && para.length) break;
      para.push(lines[i++]);
    }
    if (!para.length) {
      para.push(lines[i++]);
    }
    root.append(h('p', null, inlineLines(para.join('\n'), opts)));
  }
  return root;
}
