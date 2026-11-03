// Small, dependency-free syntax highlighter. Produces DOM nodes (never HTML strings).
const W = (s) => new Set(s.split(/\s+/));
const KW = {
  js: W('abstract as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return set static super switch this throw true try type typeof undefined var void while with yield declare namespace'),
  py: W('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self cls match case print'),
  sh: W('if then else elif fi for while until do done case esac function in select time return exit export local readonly declare unset source alias cd echo set shift trap eval exec true false'),
  go: W('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota'),
  rs: W('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'),
  c: W('auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename public private protected virtual new delete this nullptr true false bool using try catch throw override final string var let fn interface abstract extends implements import package null foreach in is as async await out ref params readonly'),
  sql: W('select from where insert into values update set delete create table drop alter add join left right inner outer on group by order having limit offset as and or not null is in like distinct union all index primary key foreign references default unique case when then else end begin commit rollback'),
  css: W('important inherit initial unset auto none block inline flex grid absolute relative fixed sticky solid dashed var calc'),
  yaml: W('true false null yes no on off'),
  ps: W('function param if else elseif foreach for while do switch return break continue try catch finally throw begin process end exit param true false null'),
};

const ALIAS = {
  js: 'js', javascript: 'js', jsx: 'js', ts: 'js', tsx: 'js', typescript: 'js', mjs: 'js', cjs: 'js', json: 'json', jsonc: 'json', json5: 'json',
  py: 'py', python: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh', go: 'go', rs: 'rs', rust: 'rs',
  c: 'c', h: 'c', cpp: 'c', cc: 'c', hpp: 'c', cs: 'c', java: 'c', kt: 'c', swift: 'c', dart: 'c', php: 'c',
  sql: 'sql', css: 'css', scss: 'css', less: 'css', html: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html',
  yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml', ps1: 'ps', powershell: 'ps', diff: 'diff', patch: 'diff', md: 'md', markdown: 'md', rb: 'py', lua: 'py', txt: 'plain',
};

export function langFor(nameOrExt) {
  return ALIAS[(nameOrExt || '').toLowerCase().replace(/^\./, '')] || 'plain';
}

const COMMENT = { js: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/, py: /#[^\n]*/, sh: /#[^\n]*/, go: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/, rs: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/, c: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/, sql: /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/, css: /\/\*[\s\S]*?(?:\*\/|$)/, yaml: /#[^\n]*/, ps: /#[^\n]*|<#[\s\S]*?(?:#>|$)/, json: /\/\/[^\n]*/, html: /<!--[\s\S]*?(?:-->|$)/ };
const STR = /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?/;
const cache = {};

function regexFor(lang) {
  if (cache[lang]) return cache[lang];
  const c = (COMMENT[lang] || /(?!)/).source;
  const src = lang === 'html'
    ? `(${c})|(<\\/?[A-Za-z][\\w:-]*|\\/?>)|(\\s[\\w:-]+(?==))|(${STR.source})`
    : `(${c})|(${STR.source})|(\\b0x[\\da-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?\\b)|([A-Za-z_$][\\w$]*)|(\\$\\{?[A-Za-z_][\\w]*\\}?)`;
  return (cache[lang] = new RegExp(src, 'g'));
}

function span(cls, text) {
  const s = document.createElement('span');
  s.className = 't-' + cls;
  s.textContent = text;
  return s;
}

function highlightDiff(text, frag) {
  const lines = text.split('\n');
  lines.forEach((ln, i) => {
    const cls = ln.startsWith('+++') || ln.startsWith('---') ? 'meta' : ln.startsWith('@@') ? 'hunk' : ln.startsWith('+') ? 'add' : ln.startsWith('-') ? 'del' : null;
    frag.append(cls ? span(cls, ln) : document.createTextNode(ln));
    if (i < lines.length - 1) frag.append('\n');
  });
}

/** Returns a DocumentFragment with highlighted spans. */
export function highlight(text, langName) {
  const frag = document.createDocumentFragment();
  const lang = langFor(langName);
  if (lang === 'plain' || lang === 'md' || text.length > 200000) {
    frag.append(document.createTextNode(text));
    return frag;
  }
  if (lang === 'diff') {
    highlightDiff(text, frag);
    return frag;
  }
  const re = regexFor(lang);
  re.lastIndex = 0;
  const kw = KW[lang] || KW.js;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
    last = m.index + m[0].length;
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    if (lang === 'html') {
      frag.append(m[1] ? span('comment', m[0]) : m[2] ? span('tag', m[0]) : m[3] ? span('attr', m[0]) : span('string', m[0]));
    } else if (m[1]) frag.append(span('comment', m[0]));
    else if (m[2]) {
      const isKey = (lang === 'json' || lang === 'yaml') && /^\s*:/.test(text.slice(last, last + 8));
      frag.append(span(isKey ? 'prop' : 'string', m[0]));
    } else if (m[3]) frag.append(span('number', m[0]));
    else if (m[4]) {
      const w = m[4];
      if (lang === 'json') frag.append(/^(true|false|null)$/.test(w) ? span('kw', w) : document.createTextNode(w));
      else if (kw.has(w)) frag.append(span('kw', w));
      else if (text[last] === '(') frag.append(span('fn', w));
      else if (/^[A-Z][A-Za-z0-9]+$/.test(w)) frag.append(span('type', w));
      else frag.append(document.createTextNode(w));
    } else if (m[5]) frag.append(span('var', m[0]));
  }
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
  return frag;
}
