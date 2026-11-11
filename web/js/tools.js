// Rendering of tool calls (bash, read, write, edit, glob, grep, todo, task, web_fetch, web_search, MCP tools) as collapsible cards.
import { h, icon, spinner, fmtDuration, fmtTokens, fmtCost, relPath, toast, copyButtonFeedback } from './dom.js';
import { ansiFragment, hasAnsi, stripAnsi } from './ansi.js';
import { codeBlock, renderMarkdown } from './markdown.js';
import { highlight, langFor } from './highlight.js';
import { rpc } from './api.js';
import { toolTitle } from './tool-title.mjs';
import { wordDiff } from './word-diff.mjs';

const ICONS = { bash: 'terminal', read: 'eye', write: 'file', edit: 'pencil', grep: 'search', glob: 'search', todo: 'list', task: 'users', web_search: 'globe', web_fetch: 'globe' };
const OPEN_BY_DEFAULT = new Set(['edit', 'write', 'todo', 'task']);

const resultText = (res) => (res?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
const resultImages = (res) => (res?.content || []).filter((c) => c?.type === 'image' && c.data);

function pretty(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}


export function toolSummary(call, res, ws) {
  const a = call.arguments || {};
  const rp = (p) => relPath(p, ws);
  switch (call.name) {
    case 'bash':
      return (a.command || '').split('\n')[0];
    case 'read':
    case 'write':
      return rp(a.path || '');
    case 'edit':
      return rp(res?.details?.path || a.path || '');
    case 'grep':
      return `${a.pattern || ''}${a.path ? '  in ' + rp(a.path) : ''}`;
    case 'glob':
      return `${a.pattern || ''}${a.path ? '  in ' + rp(a.path) : ''}`;
    case 'web_search':
      return a.query || '';
    case 'web_fetch':
      return a.url || '';
    case 'task':
      return (a.tasks || []).map((t) => t.name || t.task?.slice(0, 40)).filter(Boolean).join(', ');
    case 'todo': {
      if (!Array.isArray(a.todos)) return '';
      const done = a.todos.filter((x) => x.status === 'completed').length;
      return `${a.todos.length} task${a.todos.length === 1 ? '' : 's'} · ${done} done`;
    }
    default:
      return call.intent || '';
  }
}

/**
 * Command or tool output: ANSI colours rendered, long output cut to its last lines (where errors usually are)
 * with "Show all", and a copy button. Very large output is never put in the DOM in full.
 */
export function output(text, { maxLines = 300, cls = '', copy = true, tail = false } = {}) {
  const raw = String(text ?? '');
  const colour = hasAnsi(raw);
  const plain = colour ? stripAnsi(raw) : raw;
  const lines = plain.split('\n');
  const wrap = h('div', { class: 'out-wrap' });
  const pre = h('pre', { class: `out ${cls}`.trim() });
  const fill = (all) => {
    const cut = !all && lines.length > maxLines;
    const part = (arr) => (tail ? arr.slice(-maxLines) : arr.slice(0, maxLines)).join('\n');
    if (!colour || raw.length > 400000) pre.textContent = cut ? part(lines) : plain;
    else if (!cut) pre.replaceChildren(ansiFragment(raw));
    else {
      // Keep colours on the tail: render the raw lines that map to the last `maxLines` plain lines.
      const rawLines = raw.replace(/\r\n/g, '\n').split('\n');
      pre.replaceChildren(ansiFragment(part(rawLines)));
    }
    return cut;
  };
  const cut = fill(false);
  const tools = h('div', { class: 'out-tools' });
  if (copy && plain.trim()) {
    const b = h('button', { class: 'out-copy', type: 'button', title: 'Copy output', 'aria-label': 'Copy output' }, icon('copy', 12));
    b.dataset.done = '';
    b.addEventListener('click', () => copyButtonFeedback(b, plain));
    tools.append(b);
  }
  if (cut) {
    const more = h('button', { class: 'out-more', type: 'button' }, `${lines.length - maxLines} ${tail ? 'earlier' : 'more'} lines hidden · Show all ${lines.length}`);
    more.addEventListener('click', () => {
      fill(true);
      more.remove();
    });
    if (tail) wrap.append(more);
    wrap.append(h('div', { class: 'out-box' }, pre, tools));
    if (!tail) wrap.append(more);
    return wrap;
  }
  wrap.append(h('div', { class: 'out-box' }, pre, tools));
  return wrap;
}

export function codeView(text, lang, { startLine = 1, maxHeight = '360px' } = {}) {
  const pre = h('pre', { class: 'code view' }, h('code', null, highlight(text, lang)));
  const lines = text.split('\n');
  if (lines.length < 4000) {
    // One scroll box for numbers and code, so they never drift apart.
    const wrap = h('div', { class: 'codeview' }, h('div', { class: 'gutter', 'aria-hidden': 'true' }, lines.map((_, i) => String(startLine + i)).join('\n')), pre);
    if (maxHeight !== 'none') wrap.style.maxHeight = maxHeight;
    return wrap;
  }
  if (maxHeight !== 'none') pre.style.maxHeight = maxHeight;
  return pre;
}

/*
 * Diffs. Lines are parsed into rows first, then drawn: every line gets syntax colour for its file type, and a removed
 * line and the added line that replaced it get the exact words that changed marked.
 */
const BIG_DIFF = 3000; // past this many lines, rows are drawn plain: no syntax colour, no word marks
const extOf = (p) => (/\.([A-Za-z0-9]+)$/.exec(p || '') || [])[1] || '';
const metaRow = (cls, raw) => ({ el: h('div', { class: `dl ${cls}` }, h('span', { class: 'ln' }), h('span', { class: 'ln' }), h('span', { class: 'tx' }, raw)) });

/** Render a unified git diff string. `path` names the file when the diff has no header for it. */
export function renderUnifiedDiff(text, path = '') {
  const rows = [];
  let lang = langFor(extOf(path));
  let oldN = 0;
  let newN = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git')) {
      const name = raw.replace(/^diff --git a\/(.*) b\/.*$/, '$1');
      lang = langFor(extOf(name));
      rows.push({ el: h('div', { class: 'diff-file' }, name) });
      continue;
    }
    if (raw.startsWith('+++ ') && !raw.startsWith('+++ /dev/null')) lang = langFor(extOf(raw.slice(4).replace(/^b\//, '').trim()));
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      oldN = +hunk[1];
      newN = +hunk[2];
      rows.push(metaRow('hunk', raw));
      continue;
    }
    if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary)/.test(raw)) {
      if (!/^(--- |\+\+\+ |index )/.test(raw)) rows.push(metaRow('meta', raw));
      continue;
    }
    if (raw === '') continue;
    const c = raw[0];
    if (c === '+') rows.push({ cls: 'add', a: '', b: newN++, text: raw.slice(1), lang });
    else if (c === '-') rows.push({ cls: 'del', a: oldN++, b: '', text: raw.slice(1), lang });
    else if (c === '\\') rows.push({ cls: 'meta', a: '', b: '', text: raw });
    else rows.push({ cls: 'eq', a: oldN++, b: newN++, text: raw.slice(1), lang });
  }
  return drawRows(h('div', { class: 'diffview' }), rows);
}

/** One diff line: old number, new number, sign, and the text (syntax-coloured, changed words marked). */
function dl(cls, a, b, text, lang, marks) {
  const tx = h('span', { class: 'tx' }, lang && cls !== 'meta' ? highlight(text, lang) : text);
  if (marks?.length) markRanges(tx, marks, cls);
  return h('div', { class: `dl ${cls}` }, h('span', { class: 'ln' }, a === '' ? '' : String(a)), h('span', { class: 'ln' }, b === '' ? '' : String(b)), h('span', { class: 'sg' }, cls === 'add' ? '+' : cls === 'del' ? '−' : ''), tx);
}

function drawRows(root, rows) {
  const plain = rows.length > BIG_DIFF;
  if (!plain) pairChanges(rows);
  const frag = document.createDocumentFragment();
  for (const r of rows) frag.append(r.el || dl(r.cls, r.a, r.b, r.text, plain ? null : r.lang, r.marks));
  root.append(frag);
  return root;
}

/** A run of removed lines followed by a run of added ones: the n-th removed line pairs with the n-th added one. */
function pairChanges(rows) {
  for (let i = 0; i < rows.length; ) {
    if (rows[i].cls !== 'del') {
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].cls === 'del') j++;
    let k = j;
    while (k < rows.length && rows[k].cls === 'add') k++;
    for (let p = 0; p < Math.min(j - i, k - j); p++) {
      const w = wordDiff(rows[i + p].text, rows[j + p].text);
      if (w) [rows[i + p].marks, rows[j + p].marks] = w;
    }
    i = k;
  }
}

/** Wrap character ranges of `el`'s text in <mark>, splitting text nodes inside syntax spans where needed. */
function markRanges(el, ranges, cls) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  let pos = 0;
  let r = 0;
  for (let node of nodes) {
    let at = pos;
    const end = pos + node.data.length;
    pos = end;
    while (r < ranges.length && ranges[r][0] < end) {
      const [rs, re] = ranges[r];
      if (re <= at) {
        r++;
        continue;
      }
      const s = Math.max(rs, at);
      const e = Math.min(re, end);
      if (s > at) {
        node = node.splitText(s - at);
        at = s;
      }
      const rest = e < end ? node.splitText(e - at) : null;
      const mk = document.createElement('mark');
      // A range can span several syntax spans; only its first and last piece get rounded ends.
      mk.className = `wd ${cls}${s === rs ? ' wd-s' : ''}${e === re ? ' wd-e' : ''}`;
      node.replaceWith(mk);
      mk.append(node);
      if (!rest) break;
      node = rest;
      at = e;
      if (re <= e) r++;
    }
  }
}

/**
 * Edit diff format: " 1|text" (context, old line number), "-2|old" (old number), "+2|new" (new number).
 * The new-side number of a context line after the change is shifted by the lines added minus removed.
 */
function renderNumberedDiff(text, lang) {
  const rows = [];
  let shift = 0;
  for (const raw of text.split('\n')) {
    const m = /^([ +\-])\s*(\d*)\|(.*)$/.exec(raw);
    if (!m) {
      if (raw.trim()) rows.push(metaRow('meta', raw));
      continue;
    }
    const n = +m[2];
    if (m[1] === '+') {
      shift++;
      rows.push({ cls: 'add', a: '', b: m[2], text: m[3], lang });
    } else if (m[1] === '-') {
      shift--;
      rows.push({ cls: 'del', a: m[2], b: '', text: m[3], lang });
    } else rows.push({ cls: 'eq', a: m[2], b: m[2] ? String(n + shift) : '', text: m[3], lang });
  }
  return drawRows(h('div', { class: 'diffview' }), rows);
}

/** Lines added and removed by an edit (from its diff), for the card header. */
export function diffCounts(d) {
  const text = d?.diff;
  if (typeof text !== 'string') return null;
  let add = 0;
  let del = 0;
  for (const ln of text.split('\n')) {
    if (/^\+\s*\d*\|/.test(ln)) add++;
    else if (/^-\s*\d*\|/.test(ln)) del++;
  }
  return { add, del };
}
export const statChips = (c, cls = 'tool-stat num') => (c && (c.add || c.del) ? h('span', { class: cls }, c.add ? h('span', { class: 'ok-text' }, `+${c.add}`) : null, c.del ? h('span', { class: 'err-text' }, `−${c.del}`) : null) : null);
function diffStat(d) {
  return statChips(diffCounts(d));
}

function images(res) {
  return resultImages(res).map((c) => h('img', { class: 'tool-img', src: `data:${c.mimeType || 'image/png'};base64,${c.data}`, alt: 'tool image' }));
}

function statusBadge(status) {
  if (status === 'waiting') return h('span', { class: 'st wait' }, 'Needs approval');
  if (status === 'running' || status === 'pending') return h('span', { class: 'st', title: 'Running' }, spinner(12));
  if (status === 'error') return h('span', { class: 'st err', title: 'Failed' }, icon('x', 14));
  if (status === 'denied') return h('span', { class: 'st denied' }, 'Denied');
  if (status === 'interrupted') return h('span', { class: 'st warn', title: 'No result recorded' }, icon('alert', 14));
  return h('span', { class: 'st ok', title: 'Done' }, icon('check', 14));
}

const BODY = {
  bash(call, res, ctx) {
    const wrap = h('div');
    wrap.append(h('pre', { class: 'out cmd' }, h('span', { class: 'prompt' }, '$ '), call.arguments?.command || ''));
    const t = resultText(res).replace(/\n?\[exit code -?\d+\]\s*$/, '');
    if (ctx.denied) wrap.append(h('div', { class: 'muted small' }, 'You denied this command.'));
    else if (t.trim()) wrap.append(output(t, { cls: ctx.error ? 'err' : '', tail: true }));
    else if (res && ctx.status !== 'running') wrap.append(h('div', { class: 'muted small' }, ctx.error ? 'Failed with no output.' : 'No output.'));
    else if (ctx.status === 'running') wrap.append(h('div', { class: 'muted small' }, 'Running…'));
    else if (ctx.status === 'waiting') wrap.append(h('div', { class: 'muted small' }, 'Waiting for your approval.'));
    return wrap;
  },
  read(call, res) {
    const d = res?.details;
    const lang = langFor((call.arguments?.path || '').split('.').pop());
    const t = resultText(res).replace(/^\[[^\]]*\]\n/, '');
    // The ORBIX agent returns numbered lines ("12<TAB>text"): show them as code with real line numbers.
    const num = /^(\d+)\t/.exec(t);
    if (num && !res?.isError) {
      const lines = t.split('\n');
      const body = [];
      for (const ln of lines) {
        const m = /^\d+\t(.*)$/.exec(ln);
        if (!m) break;
        body.push(m[1]);
      }
      const rest = lines.slice(body.length).join('\n').trim();
      return h('div', null, codeView(body.join('\n'), lang, { startLine: +num[1] }), rest || d?.totalLines ? h('div', { class: 'muted small' }, rest || `${d.totalLines} lines`) : null);
    }
    return t ? output(t) : h('div', { class: 'muted small' }, 'Reading…');
  },
  write(call, res) {
    const a = call.arguments || {};
    const wrap = h('div');
    if (typeof a.content === 'string') wrap.append(codeView(a.content, langFor((a.path || '').split('.').pop())));
    const t = resultText(res);
    if (t) wrap.append(h('div', { class: 'muted small' }, t.replace(/^\[[^\]]*\]\n/, '')));
    return wrap;
  },
  edit(call, res) {
    const d = res?.details;
    const a = call.arguments || {};
    const lang = langFor(extOf(d?.path || a.path));
    if (d?.diff) return renderNumberedDiff(d.diff, lang);
    // Not applied yet (waiting for approval, or denied): show the proposed change from the arguments.
    if (typeof a.old_string === 'string' && typeof a.new_string === 'string') {
      const rows = [
        ...a.old_string.split('\n').map((text) => ({ cls: 'del', a: '', b: '', text, lang })),
        ...a.new_string.split('\n').map((text) => ({ cls: 'add', a: '', b: '', text, lang })),
      ];
      const root = drawRows(h('div', { class: 'diffview proposed' }), rows);
      const t = resultText(res);
      return h('div', null, root, t && res?.isError ? output(t) : null);
    }
    const t = resultText(res);
    return t ? output(t) : h('div', { class: 'muted small' }, 'Editing…');
  },
  grep(call, res) {
    const t = resultText(res);
    return t ? output(t) : h('div', { class: 'muted small' }, 'Searching…');
  },
  todo(call, res) {
    const phases = res?.details?.phases;
    if (!phases) return output(resultText(res) || '…');
    return todoList(phases);
  },
  task(call, res, ctx) {
    const agents = ctx.agents.length ? ctx.agents : (res?.details?.progress || []).map((p) => ({ id: p.id, progress: p }));
    const wrap = h('div', { class: 'agents' });
    for (const a of agents) wrap.append(agentRow(a));
    const t = resultText(res);
    if (!agents.length && t) wrap.append(output(t));
    return wrap;
  },
  web_search(call, res) {
    const t = resultText(res);
    return t ? h('div', { class: 'out-md' }, renderMarkdown(t)) : h('div', { class: 'muted small' }, 'Searching the web…');
  },
  generic(call, res) {
    const wrap = h('div');
    const a = call.arguments;
    if (a && Object.keys(a).length) wrap.append(codeBlock(pretty(a), 'json', { copy: false, maxHeight: '240px' }));
    const t = resultText(res);
    if (t) wrap.append(output(t));
    for (const im of images(res)) wrap.append(im);
    return wrap;
  },
};
BODY.glob = BODY.grep;

export function todoList(phases) {
  const root = h('div', { class: 'todos' });
  for (const ph of phases) {
    const tasks = ph.tasks || [];
    const done = tasks.filter((t) => t.status === 'completed').length;
    root.append(h('div', { class: 'todo-phase' }, h('span', null, ph.name || 'Tasks'), h('span', { class: 'muted small num' }, `${done}/${tasks.length}`)));
    for (const t of tasks) {
      const st = t.status || 'pending';
      root.append(h('div', { class: `todo ${st}` }, h('span', { class: 'todo-mark' }, st === 'completed' ? icon('check', 12) : st === 'in_progress' ? spinner(11) : st === 'abandoned' || st === 'dropped' ? icon('x', 12) : null), h('span', { class: 'todo-text' }, t.content || t.title || '')));
    }
  }
  return root;
}

export function agentRow(a) {
  const p = a.progress || a;
  const status = p.status || a.status || 'pending';
  const running = status === 'running' || status === 'started' || status === 'pending';
  const row = h('div', { class: `agent ${status}` });
  row.append(
    h('div', { class: 'agent-head' }, running ? spinner(12) : status === 'completed' || status === 'done' ? icon('check', 13, 'ok-text') : status === 'failed' || status === 'error' ? icon('x', 13, 'err-text') : icon('circle', 12), h('strong', { class: 'ell' }, p.id || a.id || 'agent'), h('span', { class: 'tag' }, p.agent || a.agent || 'task'), h('span', { class: 'muted small' }, status)),
  );
  const task = (p.assignment || p.task || a.assignment || '').toString();
  if (task) row.append(h('div', { class: 'agent-task' }, task.length > 240 ? task.slice(0, 240) + '…' : task));
  const meta = [];
  if (p.toolCount != null) meta.push(`${p.toolCount} tools`);
  if (p.tokens) meta.push(`${fmtTokens(p.tokens)} tok`);
  if (p.cost) meta.push(fmtCost(p.cost));
  if (p.durationMs) meta.push(fmtDuration(p.durationMs));
  if (p.resolvedModel) meta.push(p.resolvedModel.replace(/^anthropic\//, ''));
  if (meta.length) row.append(h('div', { class: 'muted small' }, meta.join(' · ')));
  const recent = (p.recentOutput || []).slice(-3);
  if (recent.length) row.append(h('pre', { class: 'out small' }, recent.join('\n')));
  return row;
}

export function renderToolCard(tab, call, run, open) {
  const finalRes = tab.results.get(call.id);
  const result = finalRes ? { content: finalRes.content, details: finalRes.details } : run?.result || run?.partial || null;
  let status = run?.status;
  if (!status) status = finalRes ? (finalRes.isError ? 'error' : 'done') : tab.live && tab.live.message?.content?.some((c) => c.id === call.id) ? 'pending' : 'interrupted';
  if (finalRes && status === 'running') status = finalRes.isError ? 'error' : 'done';
  if (tab.waitingTool === call.id && !finalRes) status = 'waiting';
  if (status === 'error' && /^The user denied/i.test(resultText(result))) status = 'denied';
  const isOpen = open ?? (status === 'running' || OPEN_BY_DEFAULT.has(call.name));
  const agents = call.name === 'task' ? [...tab.subagents.values()].filter((s) => s.parentToolCallId === call.id) : [];
  const ctx = { status, error: status === 'error', denied: status === 'denied', agents, tab };

  const dur = run?.startedAt && run?.endedAt ? run.endedAt - run.startedAt : finalRes?.details?.wallTimeMs;
  const summary = toolSummary(call, result, tab.workspace);
  const title = toolTitle(call, result, status, { rel: (p) => relPath(p || '', tab.workspace), summary });
  const exit = call.name === 'bash' ? result?.details?.exitCode : null;
  const extra = call.name === 'edit' ? diffStat(result?.details) : exit ? h('span', { class: 'tool-exit num', title: 'Exit code' }, `exit ${exit}`) : result?.details?.timedOut ? h('span', { class: 'tool-exit' }, 'timed out') : null;
  const head = h(
    'button',
    // The plain title is for reading; the tool's own name and arguments stay one hover away.
    { class: 'tool-head', type: 'button', 'aria-expanded': String(isOpen), title: `${call.name}${summary ? `: ${summary}` : ''}` },
    h('span', { class: 'tool-ico' }, icon(ICONS[call.name] || 'wrench', 14)),
    h('span', { class: 'tool-name' }, title.verb),
    title.subject ? h('span', { class: 'tool-sum' }, title.subject) : h('span', { class: 'grow' }),
    extra,
    dur >= 0 ? h('span', { class: 'tool-dur' }, fmtDuration(dur)) : null,
    statusBadge(status),
    icon('chevron-right', 12, 'chev'),
  );
  const body = h('div', { class: 'tool-body' });
  const card = h('div', { class: `tool ${status}${isOpen ? ' open' : ''}`, dataset: { id: call.id, tool: call.name } }, head, body);
  if (isOpen) fillBody(body, call, result, ctx);
  card._fill = () => {
    if (!body.firstChild) fillBody(body, call, result, ctx);
  };
  return card;
}

function fillBody(body, call, result, ctx) {
  let el;
  try {
    el = (BODY[call.name] || BODY.generic)(call, result, ctx);
  } catch (e) {
    el = h('div', { class: 'muted small' }, `Could not render this tool call (${e.message}).`);
  }
  body.append(el);
  const d = result?.details;
  if (ctx.tab && d?.undoable && (call.name === 'edit' || call.name === 'write')) {
    const msg = ctx.tab.results.get(call.id);
    if (d.undone || msg?.details?.undone) body.append(h('div', { class: 'muted small undo-row' }, 'Undone'));
    else {
      const b = h('button', { class: 'btn sm', type: 'button' }, icon('undo', 13), 'Undo this change');
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const r = await rpc(ctx.tab.id, { type: 'undo', toolCallId: call.id });
          toast(r.data?.text || 'Undone', 'ok', 3500);
          if (msg) msg.details = { ...(msg.details || {}), undone: true };
          b.replaceWith(h('span', { class: 'muted small' }, 'Undone'));
          ctx.tab.afterUndo?.();
        } catch (e) {
          toast(e.message, 'error', 7000);
          b.disabled = false;
        }
      });
      body.append(h('div', { class: 'undo-row' }, b));
    }
  }
  if (ctx.error && !resultText(result)) body.append(h('div', { class: 'err-text' }, 'The tool reported an error.'));
  else if (ctx.error && call.name !== 'bash') body.classList.add('failed');
}
