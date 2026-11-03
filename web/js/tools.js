// Rendering of tool calls (bash, read, edit, write, grep, todo, task, ask, …) as collapsible cards.
import { h, icon, spinner, fmtDuration, fmtTokens, fmtCost, relPath, toast, copyButtonFeedback } from './dom.js';
import { ansiFragment, hasAnsi, stripAnsi } from './ansi.js';
import { codeBlock, renderMarkdown } from './markdown.js';
import { highlight, langFor } from './highlight.js';
import { rpc } from './api.js';

const ICONS = { bash: 'terminal', read: 'eye', write: 'file', edit: 'pencil', ast_edit: 'pencil', grep: 'search', glob: 'search', ast_grep: 'search', find: 'search', todo: 'list', task: 'users', web_search: 'globe', web_fetch: 'globe', ask: 'question', eval: 'play', wait: 'clock', lsp: 'bolt', debug: 'bolt', browser: 'globe', checkpoint: 'layers', rewind: 'layers' };
const OPEN_BY_DEFAULT = new Set(['edit', 'write', 'todo', 'task', 'ask', 'ast_edit']);

const resultText = (res) => (res?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
const resultImages = (res) => (res?.content || []).filter((c) => c?.type === 'image' && c.data);

function pretty(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function argsNoIntent(a) {
  if (!a || typeof a !== 'object') return a;
  const { i, ...rest } = a;
  return rest;
}

function editPath(call, res) {
  if (res?.details?.path) return res.details.path;
  const m = /^\[([^\]#]+)#?[0-9A-Fa-f]*\]/m.exec(call.arguments?.input || '');
  return m ? m[1] : '';
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
    case 'ast_edit':
      return rp(editPath(call, res) || a.path || '') || a.i || '';
    case 'grep':
      return `${a.pattern || ''}${a.path ? '  in ' + rp(a.path) : ''}`;
    case 'glob':
      return `${a.pattern || ''}${a.path ? '  in ' + rp(a.path) : ''}`;
    case 'web_search':
      return a.query || '';
    case 'web_fetch':
      return a.url || '';
    case 'task':
      return (a.tasks || []).map((t) => t.name || t.task?.slice(0, 40)).filter(Boolean).join(', ') || a.i || '';
    case 'ask':
      return a.questions?.[0]?.question || '';
    case 'eval':
      return a.title || a.language || '';
    case 'todo': {
      if (a.op || !Array.isArray(a.todos)) return a.op || '';
      const done = a.todos.filter((x) => x.status === 'completed').length;
      return `${a.todos.length} task${a.todos.length === 1 ? '' : 's'} · ${done} done`;
    }
    default:
      return call.intent || a.i || '';
  }
}

// ---------- shared pieces ----------
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

export function codeView(text, lang, { startLine = 1, lineNumbers = true, maxHeight = '360px' } = {}) {
  const pre = h('pre', { class: 'code view' }, h('code', null, highlight(text, lang)));
  const lines = text.split('\n');
  if (lineNumbers && lines.length < 4000) {
    // One scroll box for numbers and code, so they never drift apart.
    const wrap = h('div', { class: 'codeview' }, h('div', { class: 'gutter', 'aria-hidden': 'true' }, lines.map((_, i) => String(startLine + i)).join('\n')), pre);
    if (maxHeight !== 'none') wrap.style.maxHeight = maxHeight;
    return wrap;
  }
  if (maxHeight !== 'none') pre.style.maxHeight = maxHeight;
  return pre;
}

/** Render a unified git diff string. */
export function renderUnifiedDiff(text) {
  const root = h('div', { class: 'diffview' });
  let oldN = 0;
  let newN = 0;
  let file = null;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git')) {
      file = h('div', { class: 'diff-file' }, raw.replace(/^diff --git a\/(.*) b\/.*$/, '$1'));
      root.append(file);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      oldN = +hunk[1];
      newN = +hunk[2];
      root.append(h('div', { class: 'dl hunk' }, h('span', { class: 'ln' }), h('span', { class: 'ln' }), h('span', { class: 'tx' }, raw)));
      continue;
    }
    if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary)/.test(raw)) {
      if (!/^(--- |\+\+\+ |index )/.test(raw)) root.append(h('div', { class: 'dl meta' }, h('span', { class: 'ln' }), h('span', { class: 'ln' }), h('span', { class: 'tx' }, raw)));
      continue;
    }
    if (raw === '' ) continue;
    const c = raw[0];
    if (c === '+') root.append(dl('add', '', newN++, raw.slice(1)));
    else if (c === '-') root.append(dl('del', oldN++, '', raw.slice(1)));
    else if (c === '\\') root.append(dl('meta', '', '', raw));
    else root.append(dl('eq', oldN++, newN++, raw.slice(1)));
  }
  return root;
}
const dl = (cls, a, b, text) => h('div', { class: `dl ${cls}` }, h('span', { class: 'ln' }, a === '' ? '' : String(a)), h('span', { class: 'ln' }, b === '' ? '' : String(b)), h('span', { class: 'sg' }, cls === 'add' ? '+' : cls === 'del' ? '−' : ''), h('span', { class: 'tx' }, text));

/**
 * Edit diff format: " 1|text" (context, old line number), "-2|old" (old number), "+2|new" (new number).
 * The new-side number of a context line after the change is shifted by the lines added minus removed.
 */
function renderOmpDiff(text) {
  const root = h('div', { class: 'diffview' });
  let shift = 0;
  for (const raw of text.split('\n')) {
    const m = /^([ +\-])\s*(\d*)\|(.*)$/.exec(raw);
    if (!m) {
      if (raw.trim()) root.append(h('div', { class: 'dl meta' }, h('span', { class: 'ln' }), h('span', { class: 'ln' }), h('span', { class: 'tx' }, raw)));
      continue;
    }
    const n = +m[2];
    if (m[1] === '+') {
      shift++;
      root.append(dl('add', '', m[2], m[3]));
    } else if (m[1] === '-') {
      shift--;
      root.append(dl('del', m[2], '', m[3]));
    } else root.append(dl('eq', m[2], m[2] ? String(n + shift) : '', m[3]));
  }
  return root;
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

// ---------- bodies ----------
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
    if (d?.displayContent?.text != null) {
      return h('div', null, codeView(d.displayContent.text, lang, { startLine: d.displayContent.startLine || 1 }), d.totalLines ? h('div', { class: 'muted small' }, `${d.totalLines} lines`) : null);
    }
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
    if (d?.diff) return renderOmpDiff(d.diff);
    const a = call.arguments || {};
    // Not applied yet (waiting for approval, or denied): show the proposed change from the arguments.
    if (typeof a.old_string === 'string' && typeof a.new_string === 'string') {
      const root = h('div', { class: 'diffview proposed' });
      for (const ln of a.old_string.split('\n')) root.append(dl('del', '', '', ln));
      for (const ln of a.new_string.split('\n')) root.append(dl('add', '', '', ln));
      const t = resultText(res);
      return h('div', null, root, t && res?.isError ? output(t) : null);
    }
    const wrap = h('div');
    if (call.arguments?.input) wrap.append(h('pre', { class: 'out cmd' }, call.arguments.input));
    const t = resultText(res);
    if (t) wrap.append(output(t));
    return wrap;
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
  ask(call, res) {
    const d = res?.details;
    const wrap = h('div', { class: 'ask' });
    for (const q of call.arguments?.questions || []) {
      wrap.append(h('div', { class: 'ask-q' }, q.question));
      wrap.append(h('div', { class: 'ask-opts' }, (q.options || []).map((o) => h('span', { class: 'tag' + (d?.selectedOptions?.includes(o.label) ? ' on' : '') }, o.label))));
    }
    const t = resultText(res);
    if (t) wrap.append(h('div', { class: 'muted small' }, t));
    return wrap;
  },
  web_search(call, res) {
    const t = resultText(res);
    return t ? h('div', { class: 'out-md' }, renderMarkdown(t)) : h('div', { class: 'muted small' }, 'Searching the web…');
  },
  eval(call, res) {
    const a = call.arguments || {};
    const wrap = h('div');
    if (a.code) wrap.append(codeView(a.code, a.language === 'py' ? 'py' : 'js', { lineNumbers: false }));
    const t = resultText(res);
    if (t) wrap.append(output(t));
    return wrap;
  },
  generic(call, res) {
    const wrap = h('div');
    const a = argsNoIntent(call.arguments);
    if (a && Object.keys(a).length) wrap.append(codeBlock(pretty(a), 'json', { copy: false, maxHeight: '240px' }));
    const t = resultText(res);
    if (t) wrap.append(output(t));
    for (const im of images(res)) wrap.append(im);
    return wrap;
  },
};
BODY.glob = BODY.grep;
BODY.ast_grep = BODY.grep;
BODY.ast_edit = BODY.edit;

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
  const task = (p.assignment || p.task || a.assignment || '').toString().replace(/^Complete assignment thoroughly:\s*/i, '');
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

// ---------- card ----------
export function renderToolCard(tab, call, run, open) {
  const finalRes = tab.results.get(call.id);
  const result = finalRes ? { content: finalRes.content, details: finalRes.details } : run?.result || run?.partial || null;
  let status = run?.status;
  if (!status) status = finalRes ? (finalRes.isError ? 'error' : 'done') : tab.live && tab.live.message?.content?.some((c) => c.id === call.id) ? 'pending' : 'interrupted';
  if (finalRes && status === 'running') status = finalRes.isError ? 'error' : 'done';
  if (status === 'running' && tab.waitingTool === call.id) status = 'waiting';
  if (status === 'error' && /^The user denied/i.test(resultText(result))) status = 'denied';
  const isOpen = open ?? (status === 'running' || OPEN_BY_DEFAULT.has(call.name));
  const agents = call.name === 'task' ? [...tab.subagents.values()].filter((s) => s.parentToolCallId === call.id) : [];
  const ctx = { status, error: status === 'error', denied: status === 'denied', agents, tab };

  const dur = run?.startedAt && run?.endedAt ? run.endedAt - run.startedAt : finalRes?.details?.wallTimeMs;
  const summary = toolSummary(call, result, tab.workspace);
  const exit = call.name === 'bash' ? result?.details?.exitCode : null;
  const extra = call.name === 'edit' || call.name === 'ast_edit' ? diffStat(result?.details) : exit ? h('span', { class: 'tool-exit num', title: 'Exit code' }, `exit ${exit}`) : result?.details?.timedOut ? h('span', { class: 'tool-exit' }, 'timed out') : null;
  const head = h(
    'button',
    { class: 'tool-head', type: 'button', 'aria-expanded': String(isOpen) },
    h('span', { class: 'tool-ico' }, icon(ICONS[call.name] || 'wrench', 14)),
    h('span', { class: 'tool-name' }, call.name),
    h('span', { class: 'tool-sum', title: summary }, summary),
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
  if (ctx.tab?.engine === 'builtin' && d?.undoable && (call.name === 'edit' || call.name === 'write')) {
    const msg = ctx.tab.results.get(call.id);
    if (d.undone || msg?.details?.undone) body.append(h('div', { class: 'muted small undo-row' }, 'Undone'));
    else {
      const b = h('button', { class: 'btn sm', type: 'button' }, icon('refresh', 13), 'Undo this change');
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
