// One session view: transcript (with live streaming), tool approvals, composer.
import { SessionBar } from './workbench.js';
import { quoteOnSelect } from './quote.js';
import { h, icon, replace, clear, toast, fmtDuration, rafThrottle, kbd, copyButtonFeedback, copyText, baseName, leave, errorState, fmtElapsed, lsGet, lsSet, logo } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { MarkdownBoundary, liveExcerpt, LIVE_MARKDOWN_LIMIT } from './markdown-stream.mjs';
import { renderToolCard, output, diffCounts, statChips } from './tools.js';
import { S, emit, textOf, sendPrompt, abort, setThinking, setModel, loadModels, refreshState, savePrefs, replyUi, openTab, closeTab } from './store.js';
import { rpc, api } from './api.js';
import { modelPicker, popMenu, isApproval, approvalLabel, thinkingLevels, thinkingName } from './dialogs.js';
import { asciiSpin } from './ascii.js';
import { fmtMsgTime, dateFormat } from './prefs-extra.js';
import { viewFile, reviewChanges, askSide } from './panels.js';
import { runInTerminal } from './terminal.js';
import { conversationToMarkdown } from './exporter.js';
import { rateModel } from './ratings.js';
import { shellCommand } from './tool-title.mjs';
import { Composer, ASK } from './composer.js';
import { addContext, permissionChip, modelLabel, effortChip } from './controls.js';
import { Timeline } from './timeline.js';

// How each thinking level reads in the interface.

const isReply = (m) => {
  if (m.role !== 'assistant') return false;
  const blocks = Array.isArray(m.content) ? m.content : [];
  return m.stopReason === 'error' || m.stopReason === 'aborted' || (!blocks.some((b) => b.type === 'toolCall') && blocks.some((b) => b.type === 'text' && b.text?.trim()));
};

/** The gist of a thinking block for its folded row: its first sentence, without Markdown, on one line. */
function thinkGist(text) {
  const plain = String(text || '').slice(0, 512).replace(/```[\s\S]*?(```|$)/g, ' ').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
  const m = /^(.{12,140}?[.!?:])(\s|$)/.exec(plain);
  return (m ? m[1] : plain.slice(0, 140)).replace(/[.:]$/, '');
}
function setGist(el, text) {
  const p = el.querySelector(':scope > summary .think-p');
  const g = thinkGist(text);
  if (p && p.textContent !== g) (p.textContent = g), (p.title = g);
}
import { projectTasks, sessionTasks } from './workspace.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)');

/** Conversation actions (the toolbar's ⋮ button and the conversation crumb). */
export function sessionMenu(t, anchor, { rename, close, find, outline, inspect, pin, move }) {
  const cmd = (c) => t.commands.some((x) => x.name === c);
  popMenu(anchor, [
    { header: t.name },
    { icon: 'pencil', label: 'Rename…', run: rename },
    pin ? { icon: 'bookmark', label: pin.on ? 'Unpin' : 'Pin', run: pin.run } : null,
    '-',
    { icon: 'search', label: 'Find in conversation', hint: 'Ctrl+F', run: find },
    { icon: 'list', label: 'Your messages…', hint: 'Ctrl+Shift+O', run: outline },
    { icon: 'activity', label: 'Inspect', hint: 'Ctrl+Shift+R', run: inspect },
    ...(cmd('compact') ? [{ icon: 'layers', label: 'Compact context', hint: '/compact', run: () => sendPrompt(t, '/compact').catch(() => {}) }] : []),
    '-',
    { icon: 'copy', label: 'Copy as Markdown', run: () => copyConversation(t) },
    { icon: 'external', label: 'Export as HTML', run: async () => {
      try {
        const r = await rpc(t.id, { type: 'export_html' }, 120000);
        const p = r.data?.path || r.data?.outputPath;
        toast(p ? `Exported to ${p}` : 'Exported', 'ok', 6000);
        if (p) api.post('/api/fs/reveal', { path: p }).catch(() => {});
      } catch (er) {
        toast(er.message, 'error');
      }
    } },
    move ? { icon: 'cloud', label: 'Move to a machine…', run: move } : null,
    '-',
    { icon: 'x', label: 'Close conversation', danger: true, run: close },
  ].filter(Boolean), { align: 'end', minWidth: 240 });
}

export async function copyConversation(t) {
  if (await copyText(conversationToMarkdown(t), { quiet: true })) toast('Conversation copied as Markdown', 'ok', 1800);
  else toast('Copy failed', 'error');
}

/** Markdown preview while streaming. The final render parses the whole reply for correct cross-block structure. */
class LiveMarkdown {
  constructor(onPath) {
    this.el = h('div', { class: 'md' });
    this.onPath = onPath;
    this.done = 0;
    this.text = '';
    this.tail = [];
    this.scanner = new MarkdownBoundary();
  }
  update(text) {
    if (text === this.text) return;
    if (!text.startsWith(this.text)) {
      clear(this.el);
      this.done = 0;
      this.tail = [];
      this.scanner.reset();
    }
    this.text = text;
    for (const n of this.tail) n.remove();
    this.tail = [];
    const cut = this.scanner.advance(text);
    if (cut > this.done) {
      this.appendFull(text.slice(this.done, cut));
      this.done = cut;
    }
    const rest = text.slice(this.done);
    if (rest.length > LIVE_MARKDOWN_LIMIT) {
      this.tail = [h('pre', { class: 'md-stream-preview', 'aria-label': 'Latest part of the streaming reply' }, liveExcerpt(rest))];
      this.el.append(this.tail[0]);
    } else if (rest.trim()) {
      this.tail = [...renderMarkdown(rest, { onPath: this.onPath, live: true }).childNodes];
      this.el.append(...this.tail);
    }
  }
  appendFull(text) {
    const parsed = renderMarkdown(text, { onPath: this.onPath });
    const fragment = document.createDocumentFragment();
    while (parsed.firstChild) fragment.append(parsed.firstChild);
    this.el.append(fragment);
  }

  /** A final render preserves lists, quotations and their spacing across preview boundaries. */
  finish(text) {
    clear(this.el);
    this.tail = [];
    if (text.trim()) this.appendFull(text);
    this.text = text;
    this.done = text.length;
  }
}

/** What to tell the user about a failed request, and the one action that most likely fixes it. */
function errorHelp(msg) {
  const m = String(msg || '');
  if (/\b(401|403)\b|unauthori[sz]ed|invalid.{0,20}(api.?)?key|incorrect api key|authentication|no api key/i.test(m)) return { hint: 'Check the key in Providers, or sign in again if you connected with a sign-in.', act: 'Open Providers', run: () => emit('settings', 'engine') };
  if (/\b429\b|rate.?limit|quota|overloaded|capacity|too many requests/i.test(m)) return { hint: 'The provider is busy, or your quota is used up. Wait a moment and try again.' };
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|fetch failed|network|socket hang up|timed? ?out/i.test(m)) return { hint: 'ORBIX couldn’t reach the provider. Check your internet connection, or make sure your local model server is running.' };
  if (/context|too long|maximum.{0,20}tokens|token limit/i.test(m) && /exceed|maximum|limit|too long|reduce/i.test(m)) return { hint: 'The conversation is too long for this model. Compact it with /compact, or start a new conversation.' };
  if (/model.{0,40}(not found|does not exist|not support|unknown|unavailable)|no such model/i.test(m)) return { hint: 'Choose another model.', act: 'Choose model', run: 'model' };
  return null;
}

/**
 * A sent message, split into its typed text (with @file mentions as links) and the text files attached to it
 * (the composer adds them as "File: name" / "Pasted text" followed by a fenced block).
 */
function splitAttachments(text, onPath) {
  const files = [];
  const items = [];
  const re = /(?:^|\n\n)(Pasted text|File: [^\n]+)\n(`{3,})[^\n]*\n([\s\S]*?)\n\2(?=\n|$)/g;
  let rest = '';
  let last = 0;
  let mm;
  while ((mm = re.exec(text))) {
    rest += text.slice(last, mm.index);
    last = mm.index + mm[0].length;
    const lines = mm[3].split('\n').length;
    const pasted = mm[1] === 'Pasted text';
    items.push({ kind: 'text', pasted, name: pasted ? 'Pasted text' : mm[1].slice(6), text: mm[3], lines, size: mm[3].length });
    files.push(h('details', { class: 'b-file' }, h('summary', null, icon('chevron-right', 12, 'chev'), icon(mm[1] === 'Pasted text' ? 'list' : 'file', 13), h('span', { class: 'ell' }, mm[1].replace(/^File: /, '')), h('span', { class: 'b-file-n num' }, `${lines} line${lines === 1 ? '' : 's'}`)), h('pre', null, mm[3])));
  }
  rest = (rest + text.slice(last)).trim();
  const body = [];
  let at = 0;
  for (const x of rest.matchAll(/(^|\s)@([^\s@]+)/g)) {
    const start = x.index + x[1].length;
    if (start > at) body.push(rest.slice(at, start));
    const a = h('button', { class: 'b-mention', type: 'button', title: 'Open file' }, '@' + x[2]);
    a.addEventListener('click', () => onPath(x[2]));
    body.push(a);
    at = start + x[2].length + 1;
  }
  if (at < rest.length) body.push(rest.slice(at));
  return { body, files, rest, items };
}

/** What a step is doing, in a few words: [verb, object]. */
function stepLabel(call, workspace) {
  const a = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  const cut = (x, n = 60) => {
    const v = String(x || '').replace(/\s+/g, ' ').trim();
    return v.length > n ? v.slice(0, n - 1) + '…' : v;
  };
  const rel = (p) => {
    const x = String(p || '').replace(/\\/g, '/');
    const w = String(workspace || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return cut(w && x.toLowerCase().startsWith(w.toLowerCase() + '/') ? x.slice(w.length + 1) : x);
  };
  switch (call.name) {
    case 'read': return ['Reading', rel(a.path)];
    case 'edit': case 'ast_edit': return ['Editing', rel(a.path)];
    case 'write': return ['Writing', rel(a.path)];
    case 'bash': return ['Running', cut((typeof a.description === 'string' && a.description.trim()) || shellCommand(a.command))];
    case 'eval': return ['Running', cut(a.code)];
    case 'grep': case 'ast_grep': return ['Searching for', cut(a.pattern)];
    case 'glob': case 'find': return ['Looking for', cut(a.pattern || a.query)];
    case 'web_search': return ['Searching the web for', cut(a.query)];
    case 'web_fetch': {
      try {
        return ['Fetching', new URL(a.url).host];
      } catch {
        return ['Fetching', cut(a.url)];
      }
    }
    case 'task': return ['Helper agent:', cut(a.description || a.prompt)];
    default: return ['Using', call.name];
  }
}

/** "Tests" when the check command runs tests, else "Checks" (a lint, type check or build). */
const checkWord = (command) => (/\btest/i.test(command || '') ? 'Tests' : 'Checks');

/**
 * The run-end check or review as a step card: what ran and how it went, with the output or the issues inside.
 * A failure opens by itself, since the agent is about to act on it.
 */
function checkCard(m) {
  const d = m.details || {};
  const verify = m.customType === 'verify';
  const bad = d.status === 'failed' || d.status === 'issues';
  const n = d.issues?.length || 0;
  const verb = verify ? `${checkWord(d.command)} ${bad ? 'failed' : 'passed'}` : bad ? `Review found ${n} issue${n === 1 ? '' : 's'}` : 'Review found no issues';
  const subject = verify ? `${d.command || ''}${d.by === 'agent' ? '  (run by the agent)' : ''}` : d.lines ? `${d.files} file${d.files === 1 ? '' : 's'}, ${d.lines} changed lines` : '';
  const head = h('button', { class: 'tool-head', type: 'button', 'aria-expanded': String(bad), title: verify ? 'The project check ORBIX runs after the agent changes files' : `A review of this reply's changes${d.model ? ` by ${d.model}` : ''}` },
    h('span', { class: 'tool-ico' }, icon(verify ? 'terminal' : 'eye', 14)),
    h('span', { class: 'tool-name' }, verb),
    subject ? h('span', { class: 'tool-sum' }, subject) : h('span', { class: 'grow' }),
    verify && d.durationMs >= 0 ? h('span', { class: 'tool-dur' }, fmtDuration(d.durationMs)) : null,
    h('span', { class: `st ${bad ? 'err' : 'ok'}`, title: bad ? 'Found problems' : 'Done' }, icon(bad ? (verify ? 'x' : 'alert') : 'check', 14)),
    icon('chevron-right', 12, 'chev'));
  const body = h('div', { class: 'tool-body' });
  const card = h('div', { class: `tool ${bad ? 'error open' : 'done'}`, dataset: { id: `check-${m.timestamp}`, tool: m.customType } }, head, body);
  card._fill = () => {
    if (body.firstChild) return;
    if (verify) body.append(d.output?.trim() ? output(d.output, { tail: true, cls: bad ? 'err' : '' }) : h('div', { class: 'muted small' }, d.by === 'agent' ? 'The agent ran this check itself after its last change, so ORBIX did not run it again.' : 'No output.'));
    else body.append(n ? h('ul', { class: 'check-issues' }, d.issues.map((i) => h('li', null, i))) : h('div', { class: 'muted small' }, 'Nothing to fix was found in the changes.'));
    if (bad && d.by !== 'agent') body.append(h('div', { class: 'muted small' }, 'Sent to the agent to fix.'));
  };
  if (bad) card._fill();
  return card;
}

/** A message's time: just the time today, "Yesterday" and the time, or the date and the time for older messages. */
const clock = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  const time = dateFormat({ hour: '2-digit', minute: '2-digit' }).format(d);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const ago = Math.round((day(new Date()) - day(d)) / 86400000);
  if (ago === 0) return time;
  if (ago === 1) return `Yesterday ${time}`;
  return `${dateFormat({ month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) }).format(d)}, ${time}`;
};

/** "now", "5m ago", "2h ago", then the date: when a message was sent, kept fresh by the minute (the exact time is the hint). */
const ago = (ts) => {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  return s < 45 ? 'now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : clock(ts);
};
// The hint is toLocaleString()'s text, from one shared formatter.
const NUM = new Intl.NumberFormat();
const FIRST_DRAW = 160; // messages drawn when a conversation opens; the rest follow while the browser is idle
const FILL_CHUNK = 240; // messages drawn per idle slice after that
const SETTLE_CHUNK = 40; // drawn messages shown for one frame per idle slice, so their heights are remembered
const FULL = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' };
const msgTime = (ts) => h('time', { class: 'msg-time', dataset: { ts: String(ts) }, datetime: new Date(ts).toISOString(), title: dateFormat(FULL).format(ts) }, fmtMsgTime(ts, ago));
setInterval(() => {
  if (document.hidden) return;
  for (const el of document.querySelectorAll('#session time.msg-time[data-ts]')) {
    const text = fmtMsgTime(Number(el.dataset.ts), ago);
    if (el.textContent !== text) el.textContent = text;
  }
}, 30000);

export class TabView {
  constructor(tab) {
    this.tab = tab;
    // How many messages are drawn at once. Off-screen ones cost little (content-visibility in app.css), and all of them
    // stay in the page so Find and copy reach the whole conversation; only very long ones start with "Show earlier".
    this.limit = 3000;
    this.stick = true;
    this.liveBlocks = [];
    this.liveEl = null;
    this.approvalDlg = null;
    this.approvalEl = null;
    this.thinkOpen = new Set();
    this.workOpen = new Set(); // turns whose steps you unfolded (by the key of your message)
    this.workShut = new Set(); // with Settings → Appearance → Conversation steps: Verbose, turns you folded
    this.els = new WeakMap(); // message -> its element
    this.toolQ = new Set();
    this.tab.afterUndo = () => this.refreshSummary();
    this.build();
    this.renderAll();
    this.updateComposer();
    this.renderLive = rafThrottle(() => this._renderLive());
  }

  build() {
    const t = this.tab;
    this.tin = h('div', { class: 'tin' });
    this.scroller = h('div', { class: 'transcript', tabindex: '-1', role: 'log', 'aria-label': 'Conversation', 'aria-live': 'off' }, this.tin);
    this.jump = h('button', { class: 'jump', type: 'button', hidden: true, onclick: () => this.scrollBottom(true) }, icon('arrow-down', 14), 'Latest');
    this.queue = h('div', { class: 'queue' });
    this.composer = new Composer({
      placeholder: ASK,
      label: 'Message',
      state: t,
      workspace: () => t.workspace,
      commands: () => t.commands,
      model: () => t.model,
      // Settings → Preferences → While the agent works: Enter steers or queues, Alt+Enter does the other.
      onSubmit: (alt) => this.onSend(alt !== (S.ui.whileBusy === 'queue')),
      onEscape: () => this.onEscape(),
      onChange: () => this.updateSend(),
    });
    this.ta = this.composer.ta;
    this.sendBtn = h('button', { class: 'send', type: 'button', onclick: () => this.onSend(S.ui.whileBusy === 'queue', true) });
    this.modelBtn = h('button', { class: 'cbtn', type: 'button', title: 'Model', 'aria-haspopup': 'dialog', onclick: () => this.pickModel() });
    this.permBtn = permissionChip();
    this.effort = effortChip(async (level) => {
      try {
        await setThinking(t, level);
      } catch (e) {
        toast(e.message, 'error');
      }
      this.focus();
    });
    this.planBtn = h('button', { class: 'cbtn plan', type: 'button', title: 'Plan mode: the agent reads and proposes a plan, but changes nothing', onclick: () => this.togglePlan() });
    this.statusLine = h('div', { class: 'c-status', 'aria-live': 'polite' });
    this.composer.el.append(h('div', { class: 'c-row' }, addContext(this.composer), this.modelBtn, this.effort.el, this.planBtn, h('span', { class: 'grow' }), this.permBtn.el, this.sendBtn));
    this.dockCol = h('div', { class: 'dock-col' }, this.queue, this.composer.el, this.statusLine);
    this.dock = h('div', { class: 'dock' }, this.jump, this.dockCol);
    this.root = h('div', { class: 'session-inner' }, this.scroller, this.dock, h('div', { class: 'drop-hint', 'aria-hidden': 'true' }, icon('paperclip', 18), 'Drop images or text files to attach'));
    this.root._view = this;
    this.timeline = new Timeline(this);
    this.bar = new SessionBar(this);
    this.root.prepend(this.bar.el);
    this.quote = quoteOnSelect(this);
    this.composer.dropZone(this.root);

    // Follow new output only while the reader is at the bottom; any upward scroll stops it until they return.
    // Content growing never moves scrollTop, so only a decrease (with room left below) is the reader scrolling up.
    // Checked once per frame, not per scroll event: the read needs fresh layout, and a long transcript makes each
    // forced layout expensive.
    this.lastTop = 0;
    this.onScroll = rafThrottle(() => {
      const sc = this.scroller;
      if (!sc.isConnected) return;
      const d = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
      if (d <= 4) this.stick = true;
      else if (sc.scrollTop < this.lastTop - 1) this.stick = false;
      this.lastTop = sc.scrollTop;
      this.showJump(!this.stick);
    });
    this.scroller.addEventListener('scroll', this.onScroll, { passive: true });
    // A window, panel or composer resize keeps a reader who was at the bottom at the bottom.
    this.scrollerRo = new ResizeObserver(() => {
      if (this.stick && this.scroller.isConnected) this.scroller.scrollTop = this.scroller.scrollHeight;
      this.timeline.update();
    });
    this.scrollerRo.observe(this.scroller);
    this.scroller.addEventListener('wheel', (e) => {
      if (e.deltaY < 0 && this.scroller.scrollHeight > this.scroller.clientHeight) {
        this.stick = false;
        this.showJump(true);
      }
    }, { passive: true });
    this.scroller.addEventListener('keydown', (e) => {
      if (['PageUp', 'ArrowUp', 'Home'].includes(e.key)) this.stick = false;
    });
    this.tin.addEventListener('click', (e) => {
      const hd = e.target.closest('.tool-head');
      if (!hd || hd.classList.contains('static')) return;
      const card = hd.closest('.tool');
      const open = card.classList.toggle('open');
      hd.setAttribute('aria-expanded', String(open));
      (t.toolOpen ||= new Map()).set(card.dataset.id, open);
      if (open) card._fill?.();
    });
    this.tin.addEventListener('toggle', (e) => {
      const d = e.target;
      if (d.classList?.contains('think') && d.dataset.key) d.open ? this.thinkOpen.add(d.dataset.key) : this.thinkOpen.delete(d.dataset.key);
      else if (d.classList?.contains('work') && d.dataset.key) {
        if (d.dataset.auto) return void delete d.dataset.auto;
        d.open ? (this.workOpen.add(d.dataset.key), this.workShut.delete(d.dataset.key)) : (this.workOpen.delete(d.dataset.key), this.workShut.add(d.dataset.key));
        if (d.open) for (const c of d.querySelectorAll('.tool.open')) c._fill?.();
      }
    }, true);
  }

  showJump(on) {
    const j = this.jump;
    if (on) {
      j.classList.remove('leaving'); // cancels an exit still playing
      j.hidden = false;
    } else if (!j.hidden) leave(j, { hide: true });
  }

  /** The view leaves the screen (another tab): remember where the reader was. */
  detach() {
    this.bar.closeFind(true);
    this.saved = { top: this.scroller.scrollTop, stick: this.stick };
  }

  /** The tab is closed for good: release observers and callbacks that would keep this view and its DOM alive. */
  destroy() {
    this.fillGen = (this.fillGen || 0) + 1; // stop drawing earlier messages
    this.onScroll?.cancel?.();
    this.removeEmpty();
    clearInterval(this.pendingTimer);
    clearInterval(this.foldTimer);
    this.dead = true;
    this.renderLive?.cancel?.();
    if (this._tq) cancelAnimationFrame(this._tq);
    this._tq = 0;
    if (this._sb) cancelAnimationFrame(this._sb);
    this._sb = 0;
    this.timeline.destroy();
    this.bar?.destroy();
    this.quote?.destroy();
    this.scrollerRo?.disconnect();
    this.composer?.destroy?.();
    if (this.tab.afterUndo) this.tab.afterUndo = null;
    this.root._view = null;
  }

  /** Back on screen: the same scroll position, or the bottom when they were following. */
  reattach() {
    const s = this.saved;
    this.saved = null;
    if (s && !s.stick) {
      this.stick = false;
      this.lastTop = s.top;
      this.scroller.scrollTop = s.top;
      this.showJump(true);
    } else this.scrollBottom(true);
    this.timeline.update();
  }

  updateComposer() {
    const t = this.tab;
    const st = t.state;
    const m = t.model;
    const dead = t.dead;
    this.ta.disabled = dead;
    this.ta.placeholder = dead ? 'This conversation has ended' : t.streaming ? (S.ui.whileBusy === 'queue' ? 'Queue a follow-up…' : 'Add guidance…') : ASK;
    this.composer.el.classList.toggle('busy', !!t.streaming);
    this.updateSend();

    this.modelBtn.hidden = dead;
    const model = m ? m.name || m.id : 'Default model';
    const lvl = st?.thinkingLevel || 'off';
    const levels = thinkingLevels(m);
    const modelKey = `${m?.provider || ''}:${model}:${(S.engine?.providers || []).length}`;
    if (this.modelKey !== modelKey) {
      this.modelKey = modelKey;
      const provider = S.engine?.providers?.find((p) => p.id === m?.provider)?.name || m?.provider;
      this.modelBtn.title = provider ? `${model} · ${provider}` : 'Choose a model';
      this.modelBtn.replaceChildren(...modelLabel(m));
    }
    this.effort.update(dead ? [] : levels, lvl, { model, def: m?.thinking?.default });
    this.permBtn.update(dead);
    const hasPlan = !!st && 'planMode' in st;
    this.planBtn.hidden = dead || !hasPlan;
    if (this.planOn !== !!st?.planMode) {
      this.planOn = !!st?.planMode;
      this.planBtn.replaceChildren(icon('map', 14), h('span', null, this.planOn ? 'Plan mode' : 'Plan'));
    }
    this.planBtn.classList.toggle('on', !!st?.planMode);
    this.planBtn.setAttribute('aria-pressed', String(!!st?.planMode));


    const q = [...(t.queued?.steering || []).map((x) => ['Steer', x]), ...(t.queued?.followUp || []).map((x) => ['Next', x])];
    replace(this.queue, q.map(([k, x]) => {
      const text = typeof x === 'string' ? x : textOf(x.content || x.message || '');
      return h('span', { class: 'q-chip', title: text }, h('b', null, k), h('span', { class: 'ell' }, text));
    }));
    this.updateStatus();
    this.updatePending();
    this.refreshActs();
  }

  /** The send button follows the text box: send, steer while working, or stop. Cheap enough for every keystroke. */
  updateSend() {
    const t = this.tab;
    const typed = this.composer.hasContent();
    const stop = t.streaming && !typed;
    const mode = stop ? 'stop' : 'send';
    if (this.sendBtn.dataset.mode !== mode) {
      this.sendBtn.dataset.mode = mode;
      this.sendBtn.replaceChildren(icon(mode, 15));
    }
    this.sendBtn.classList.toggle('stop', stop);
    const key = S.ui.sendKey === 'ctrl' ? 'Ctrl+Enter' : 'Enter';
    const queue = S.ui.whileBusy === 'queue';
    const action = stop ? 'Stop the agent' : t.streaming ? (queue ? 'Queue message' : 'Steer') : 'Send';
    this.sendBtn.disabled = t.dead || this.sending === true || (!stop && !typed);
    this.sendBtn.title = stop ? `${action} (Esc)` : `${action} (${key})${t.streaming ? ` · ${queue ? 'Steer' : 'Queue'} (Alt+Enter)` : ''}`;
    this.sendBtn.setAttribute('aria-label', action);
  }

  updateStatus() {
    const t = this.tab;
    const rate = t.streaming && t.state?.tokensPerSecond ? t.state.tokensPerSecond.toFixed(0) : '';
    const sig = JSON.stringify([!!t.compacting, !!t.retry, this.planBtn.hidden, [...t.statuses], rate]);
    if (this.statusSig === sig) return;
    this.statusSig = sig;
    const bits = [];
    if (t.compacting) bits.push(h('span', null, 'Compacting context…'));
    if (t.retry) bits.push(h('span', { class: 'warn-text' }, 'Retrying…'));
    for (const [k, v] of t.statuses) if (!(k === 'plan' && !this.planBtn.hidden)) bits.push(h('span', null, v));
    if (rate) bits.push(h('span', { class: 'num' }, `${rate} tok/s`));
    replace(this.statusLine, bits);
  }

  /** The step in progress: a tool call without a result, else whether the model is thinking or writing. */
  nowDoing() {
    const t = this.tab;
    const id = this.unansweredCall();
    let call = null;
    if (id) for (const m of [t.live?.message, ...t.messages.slice(-6).reverse()]) {
      call = Array.isArray(m?.content) ? m.content.find((c) => c.type === 'toolCall' && c.id === id) : null;
      if (call) break;
    }
    let key;
    let label;
    if (call) {
      key = id;
      label = stepLabel(call, t.workspace);
    } else {
      const last = Array.isArray(t.live?.message?.content) ? t.live.message.content.at(-1) : null;
      key = last?.type === 'thinking' ? 'think' : last?.type === 'text' ? 'text' : 'wait';
      label = [key === 'text' ? 'Writing the reply' : 'Thinking', '']; // between steps the model is working out the next one
    }
    if (this.stepKey !== key) {
      this.stepKey = key;
      this.stepAt = Date.now();
    }
    return [label[0], label[1], this.stepAt];
  }

  pickModel() {
    const t = this.tab;
    modelPicker({
      anchor: this.modelBtn,
      load: () => loadModels(t),
      current: t.model,
      thinking: true,
      level: t.state?.thinkingLevel || 'off',
      onPick: async (x, level) => {
        const same = t.model && t.model.provider === x.provider && t.model.id === x.id;
        if (!same) await setModel(t, x);
        if (level && level !== t.state?.thinkingLevel) await setThinking(t, level);
        savePrefs({ homeModel: { provider: x.provider, id: x.id, name: x.name || x.id } });
        this.focus();
      },
    });
  }

  async togglePlan() {
    const t = this.tab;
    this.planBtn.disabled = true;
    try {
      await rpc(t.id, { type: 'prompt', message: '/plan' });
      await refreshState(t);
    } catch (e) {
      toast(e.message, 'error');
    }
    this.planBtn.disabled = false;
  }

  updateApproval() {
    const t = this.tab;
    const d = t.dead ? null : t.dialogs.find(isApproval) || null;
    if (d === this.approvalDlg) return;
    this.approvalDlg = d;
    const prevWait = t.waitingTool;
    t.waitingTool = d ? [...t.tools.entries()].reverse().find(([, r]) => r.status === 'running')?.[0] || this.unansweredCall() : null;
    if (prevWait && prevWait !== t.waitingTool) {
      // The tool's run time starts when you answer, not while it waited for you.
      const r = t.tools.get(prevWait);
      if (r?.status === 'running') r.startedAt = Date.now();
      this.updateTool(prevWait);
    }
    if (t.waitingTool) this.updateTool(t.waitingTool);
    const old = this.approvalEl;
    this.approvalEl = null;
    if (old) {
      const had = old.contains(document.activeElement);
      leave(old);
      if (had && !d) this.focus();
    }
    if (!d) {
      this.updateStatus();
      this.updatePending();
      return;
    }
    const [q, ...rest] = String(d.title || 'Allow this action?').split(/\s{2,}/);
    const detail = rest.join('  ').trim();
    const box = h('div', { class: 'approval', tabindex: '-1', role: 'alertdialog', 'aria-label': q },
      h('div', { class: 'ap-h' }, h('span', { class: 'ap-ico' }, icon('shield', 15)), h('span', { class: 'ap-q' }, q)),
      detail ? h('pre', { class: 'ap-d' }, detail) : null,
      h('div', { class: 'ap-acts' }, d.options.map((o, i) => [h('button', { class: 'btn sm ' + (o === 'Deny' ? 'ghost' : i === 0 ? 'primary' : ''), type: 'button', title: o, onclick: () => this.answerApproval(o) }, approvalLabel(o), kbd(o === 'Deny' ? 'Esc' : String(i + 1)))])));
    box.addEventListener('keydown', (e) => this.onApprovalKey(e));
    this.approvalEl = box;
    this.dockCol.prepend(box);
    this.updateStatus();
    this.updatePending();
    // Take focus only when that cannot swallow a half-typed message.
    const a = document.activeElement;
    const wasHere = old?.contains(a) || !a?.isConnected;
    if (S.active === t.id && !document.querySelector('.scrim') && (wasHere || !a || a === document.body || (a === this.ta && !this.ta.value.trim()))) box.focus({ preventScroll: true });
    this.scrollBottom();
  }

  /** The latest tool call with no result yet (after a reload the live run info is gone, the call is not). */
  unansweredCall() {
    const t = this.tab;
    for (const m of [t.live?.message, ...t.messages.slice(-6).reverse()]) {
      const calls = Array.isArray(m?.content) ? m.content.filter((c) => c.type === 'toolCall' && !t.results.has(c.id)) : [];
      if (calls.length) return calls[calls.length - 1].id;
    }
    return null;
  }

  answerApproval(value) {
    const d = this.approvalDlg;
    if (!d || d._answered) return; // one answer per request, even on a double click
    d._answered = true;
    this.approvalEl?.querySelectorAll('button').forEach((b) => (b.disabled = true));
    replyUi(this.tab, d, { value });
  }

  onApprovalKey(e) {
    const d = this.approvalDlg;
    if (!d || e.ctrlKey || e.metaKey || e.altKey) return;
    const n = +e.key;
    if (n >= 1 && n <= d.options.length && d.options[n - 1] !== 'Deny') (e.preventDefault(), this.answerApproval(d.options[n - 1]));
    else if (e.key === 'Escape' && d.options.includes('Deny')) (e.preventDefault(), e.stopPropagation(), this.answerApproval('Deny'));
  }

  renderAll() {
    const t = this.tab;
    // Keep the reader's place (measured from the bottom, so earlier messages can be added above).
    const sc = this.scroller;
    const fromBottom = !this.stick && sc.isConnected ? sc.scrollHeight - sc.scrollTop : null;
    this.removeEmpty();
    clear(this.tin);
    this.liveEl = null;
    this.liveFoldEl = null;
    this.liveBlocks = [];
    this.pendingEl = null;
    this.deadShown = false;
    const msgs = t.messages;
    const start = Math.max(0, msgs.length - this.limit);
    if (start > 0) this.tin.append(h('button', { class: 'btn sm earlier', type: 'button', onclick: () => ((this.limit += 150), this.renderAll()) }, `Show ${Math.min(150, start)} earlier messages`));
    // The newest messages are drawn now, from the start of a turn; older ones follow in the background (fillEarlier),
    // so a long conversation opens as fast as a short one.
    let cut = Math.max(start, msgs.length - FIRST_DRAW);
    while (cut > start && msgs[cut].role !== 'user') cut--;
    this.tin.append(this.drawRange(cut, msgs.length));
    for (const el of [...this.tin.children].slice(-10)) el.classList.add('cv-keep'); // always rendered: see app.css
    this.foldTurns(cut);
    this.fillEarlier(start, cut);
    this.timeline.refresh();
    if (t.dead) this.showDead(false);
    this._renderLive();
    this.updateEmpty();
    if (fromBottom != null) sc.scrollTop = sc.scrollHeight - fromBottom;
    else this.scrollBottom(true);
  }

  /** Draw messages [from, to) into a fragment, remembering each one's element. */
  drawRange(from, to) {
    const msgs = this.tab.messages;
    const frag = document.createDocumentFragment();
    for (let i = from; i < to; i++) {
      const el = this.renderMessage(msgs[i], i);
      if (el) {
        this.els.set(msgs[i], el);
        frag.append(el);
      }
    }
    return frag;
  }

  /**
   * Draw the messages before `cut` (down to `start`) in chunks while the browser is idle, newest first, each chunk
   * inserted above what is drawn. Scroll anchoring keeps the reader's place. A new renderAll cancels a fill in progress.
   */
  fillEarlier(start, cut) {
    const gen = (this.fillGen = (this.fillGen || 0) + 1);
    const msgs = this.tab.messages;
    const idle = window.requestIdleCallback ? (fn) => requestIdleCallback(fn, { timeout: 120 }) : (fn) => setTimeout(fn, 16);
    const chunk = (size) => {
      const anchor = this.els.get(msgs[cut]);
      if (anchor?.parentNode !== this.tin) return (cut = start); // redrawn meanwhile: nothing left to do here
      let from = Math.max(start, cut - size);
      while (from > start && msgs[from].role !== 'user') from--;
      anchor.before(this.drawRange(from, cut));
      this.foldTurns(from, cut);
      cut = from;
    };
    const step = () => {
      if (gen !== this.fillGen || !this.tin.isConnected) return;
      if (cut > start) chunk(FILL_CHUNK);
      if (cut > start) idle(step);
      else settle();
    };
    // Then, still while idle, show each drawn message for one frame so the browser remembers its real height
    // (contain-intrinsic-size: auto). Scrolling into old messages then never changes their size, which would make
    // the whole column lay out again on that frame.
    const settle = () => {
      const kids = [...this.tin.children].filter((el) => !el.classList.contains('cv-sized'));
      let i = 0;
      const pass = () => {
        if (gen !== this.fillGen || i >= kids.length || !this.tin.isConnected) return;
        const part = kids.slice(i, (i += SETTLE_CHUNK));
        for (const el of part) el.classList.add('cv-measure');
        requestAnimationFrame(() => requestAnimationFrame(() => {
          for (const el of part) el.classList.replace('cv-measure', 'cv-sized');
          idle(pass);
        }));
      };
      idle(pass);
    };
    // Find and jumps need every message in the page: they finish the fill at once.
    this.finishFill = () => {
      if (gen !== this.fillGen) return;
      while (cut > start) chunk(Infinity);
    };
    idle(step);
  }

  /** Draw any earlier messages still waiting (see fillEarlier). */
  finishFill() {}

  appendMsg(msg) {
    const idx = this.tab.messages.lastIndexOf(msg);
    if (msg.role === 'assistant' && this.liveEl) {
      // The streamed reply becomes the saved one in place, reusing what is already drawn: no flash, no jump.
      const el = this.renderAssistant(msg, idx, (p) => viewFile(this.tab, p), this.liveBlocks);
      this.liveEl.replaceWith(el || '');
      this.liveEl = null;
      this.liveBlocks = [];
      if (el) this.els.set(msg, el);
      this.refreshActs();
      this.updatePending();
      this.scrollBottom();
      return;
    }
    const el = this.renderMessage(msg, idx);
    if (!el) return;
    this.els.set(msg, el);
    el.classList.add('enter');
    this.tin.insertBefore(el, this.tinRef());
    if (msg.role === 'user') this.timeline.refresh();
    if (msg.role === 'assistant' || msg.role === 'user') this.refreshActs();
    this.updateEmpty();
    this.updatePending();
    this.scrollBottom();
  }

  removeMsg(msg) {
    const el = this.els.get(msg);
    if (el) leave(el);
  }

  removeEmpty() {
    this.emptyEl?.remove();
    this.emptyEl = null;
  }

  updateEmpty() {
    const t = this.tab;
    const show = !t.messages.length && !t.live && !t.dead && !t.streaming;
    if (!show) return this.removeEmpty();
    if (this.emptyEl?.parentNode === this.tin) return;
    // Three suggested first tasks for this project, as on Home; the slot keeps its height while the folder is read, so nothing jumps.
    const tasks = h('div', { class: 'ce-tasks-slot' });
    this.emptyEl = h('div', { class: 'chat-empty' },
      h('span', { class: 'empty-mark', 'aria-hidden': 'true' }, logo(48)),
      h('h2', { class: 'ce-name' }, 'Where should we pick up?'),
      tasks);
    const empty = this.emptyEl;
    this.tin.append(empty);
    if (!t.workspace) return;
    const ws = encodeURIComponent(t.workspace);
    Promise.all([
      api.get(`/api/fs/list?path=${ws}`).then((r) => r.listing.entries),
      api.get(`/api/git/status?ws=${ws}`).then((r) => !!r.git?.files?.length).catch(() => false),
    ])
      .then(([entries, changed]) => projectTasks(entries, { changed }))
      .catch(() => projectTasks([{ name: 'readme.md' }]))
      .then((list) => this.emptyEl === empty && tasks.replaceChildren(sessionTasks(this.composer, list)));
  }

  /** Where to insert a message in the transcript: before the live reply or the status line, when they are in it. */
  tinRef() {
    return [this.liveEl, this.pendingEl].find((x) => x?.parentNode === this.tin) || null;
  }

  /**
   * While a turn works, its steps (thinking, tool calls, notes) sit in one row whose header says what happens now
   * and how long the turn has taken ("Running check free disk space   1m 12s"). The row is folded unless you open it
   * (or Settings → Appearance → Verbose). An answer that streams (text, no tool call) stays in view below. When the
   * turn ends, the fold is handed back and foldTurn folds it again as "Worked for…". It opens by itself while an
   * approval waits, so you see the step.
   */
  liveFold() {
    const t = this.tab;
    if (!t.streaming || t.dead) return this.settleLiveFold();
    let u = t.messages.length - 1;
    while (u >= 0 && t.messages[u].role !== 'user') u--;
    if (u < 0) return null;
    const key = String(t.messages[u]?.id || t.messages[u]?.timestamp || u);
    const after = t.messages.slice(u + 1);
    // Only the terminal event ends a turn. A model can write text, then continue after checks or a token limit.
    // If the saved turn is already folded, don't unroll it while waiting for the next user message to arrive.
    const completed = this.tin.querySelector(`:scope > details.work:not(.live)[data-key="${CSS.escape(key)}"]`);
    if (completed) return this.settleLiveFold();
    const own = this.liveFoldEl?.dataset.key === key ? this.liveFoldEl.lastChild : null;
    const blocks = t.live?.message?.content || [];
    const answering = blocks.some((b) => b.type === 'text' && b.text?.trim()) && !blocks.some((b) => b.type === 'toolCall');
    const reply = answering ? null : this.els.get(after.findLast(isReply));
    // Keep the current answer visible, but put any activity that follows it in the same fold above it.
    const steps = after.map((m) => this.els.get(m)).filter((el) => el && el !== reply && (el.parentNode === this.tin || (own && el.parentNode === own)));
    if (this.liveEl && !answering && this.liveEl.childElementCount) steps.push(this.liveEl);
    let f = this.liveFoldEl?.parentNode === this.tin && this.liveFoldEl.dataset.key === key ? this.liveFoldEl : null;
    if (!f && !steps.length && (answering || reply) && !this.approvalDlg) return null; // a plain answer needs no fold
    if (!f) {
      this.settleLiveFold();
      f = h('details', { class: 'work live', dataset: { key } }, h('summary', { class: 'work-h' }, icon('chevron-right', 12, 'chev'), h('span', { class: 'work-l' }, 'Working'), h('span', { class: 'work-t num' })), h('div', { class: 'work-b' }));
      if (S.ui.steps === 'verbose' || S.ui.screenReader === true ? !this.workShut.has(key) : this.workOpen.has(key)) f.open = true;
      const first = steps.find((el) => el.parentNode === this.tin) || (this.liveEl?.parentNode === this.tin && !answering ? this.liveEl : this.tinRef());
      this.tin.insertBefore(f, first);
      this.liveFoldEl = f;
      this.turnAt = t.messages[u]?.timestamp || Date.now();
    }
    const body = f.lastChild;
    for (const el of steps) if (el.parentNode !== body) body.append(el);
    if (reply?.parentNode === body) f.after(reply);
    else if (reply?.parentNode === this.tin && (reply.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING)) reply.before(f);
    // The reply that streams now follows the fold, outside it.
    if (this.liveEl && answering && this.liveEl.parentNode !== this.tin) f.after(this.liveEl);
    // Open while an approval waits, so the step being approved is in view; closed again after, unless you opened it.
    if (this.approvalDlg && !f.open) (f.dataset.auto = '1'), (f.dataset.autoOpen = '1'), (f.open = true);
    else if (!this.approvalDlg && f.dataset.autoOpen && f.open && !this.workOpen.has(key)) (f.dataset.auto = '1'), delete f.dataset.autoOpen, (f.open = false);
    this.tickLiveFold();
    return f;
  }

  /** The live fold's header: what happens now ("Running check free disk space") and how long the turn has taken. */
  tickLiveFold() {
    const f = this.liveFoldEl;
    const l = f?.querySelector('.work-l');
    if (!l) return;
    const t = this.tab;
    const [verb, obj] = this.nowDoing();
    const answering = (t.live?.message?.content || []).some((b) => b.type === 'text' && b.text?.trim());
    const text = this.approvalDlg ? 'Waiting for your OK' : answering ? 'Writing the reply' : obj ? `${verb} ${obj}` : verb;
    if (l.textContent !== text) (l.textContent = text), (l.title = text);
    const secs = Math.max(0, Math.floor((Date.now() - (this.turnAt || Date.now())) / 1000));
    const tt = f.querySelector('.work-t');
    const time = secs >= 1 ? fmtElapsed(secs) : '';
    if (tt && tt.textContent !== time) tt.textContent = time;
  }

  /** The turn ended (or the view is redrawn): give the steps back to the transcript, where foldTurn folds them. */
  settleLiveFold() {
    const f = this.liveFoldEl;
    this.liveFoldEl = null;
    if (f?.parentNode !== this.tin) return null;
    f.replaceWith(...f.lastChild.childNodes);
    return null;
  }

  /**
   * What the agent does now ("Running npm test") and for how long: in the working row's header once the turn has
   * steps, otherwise on its own line at the end of the conversation (before the first step).
   */
  updatePending() {
    const t = this.tab;
    const fold = this.liveFold();
    const answering = this.liveEl?.parentNode === this.tin && this.liveEl.childElementCount;
    const idle = !t.streaming || t.dead || this.approvalDlg || answering || !!fold;
    if (fold && !this.foldTimer) this.foldTimer = setInterval(() => (this.liveFoldEl ? this.tickLiveFold() : (clearInterval(this.foldTimer), (this.foldTimer = 0))), 1000);
    if (idle) {
      clearInterval(this.pendingTimer);
      this.pendingTimer = 0;
      return void (this.pendingEl?.remove(), (this.pendingEl = null));
    }
    if (!this.pendingEl) {
      const verb = h('span', { class: 'pending-l' });
      const what = h('span', { class: 'pending-o ell' });
      const time = h('span', { class: 'pending-t num' });
      this.pendingEl = h('div', { class: 'pending', role: 'status', 'aria-live': 'off' }, asciiSpin(), verb, what, time);
      const tick = () => {
        if (!this.pendingEl) return;
        const [v, o, since] = this.nowDoing();
        const secs = Math.max(0, Math.floor((Date.now() - since) / 1000));
        if (verb.textContent !== v) verb.textContent = v;
        if (what.textContent !== (o || '')) (what.textContent = o || ''), (what.title = o || '');
        const tt = secs >= 3 ? fmtElapsed(secs) : '';
        if (time.textContent !== tt) time.textContent = tt;
        this.tickLiveFold();
      };
      tick();
      this.pendingTimer = setInterval(tick, 1000);
    }
    if (this.pendingEl.parentNode !== this.tin || this.pendingEl.nextSibling) this.tin.append(this.pendingEl);
    this.removeEmpty();
  }

  renderMessage(m, idx) {
    const t = this.tab;
    const onPath = (p) => viewFile(t, p);
    switch (m.role) {
      case 'user':
        if (m.attribution === 'goal') return this.renderGoalNote(m);
        return this.renderUser(m);
      case 'assistant':
        return this.renderAssistant(m, idx, onPath);
      case 'toolResult':
        return null;
      case 'bashExecution':
        return h('div', { class: 'tool done open' }, h('div', { class: 'tool-head static' }, h('span', { class: 'tool-ico' }, icon('terminal', 14)), h('span', { class: 'tool-name' }, 'shell'), h('span', { class: 'tool-sum' }, m.command || '')), h('div', { class: 'tool-body' }, output(String(m.output ?? textOf(m.content) ?? ''))));
      case '_notice':
        return h('div', { class: `note ${m.level || ''}` }, icon(m.level === 'error' || m.level === 'warn' ? 'alert' : 'info', 14), h('span', null, m.text));
      case '_cmd':
        return h('div', { class: 'cmd-echo' }, m.text);
      case '_out':
        return h('div', { class: 'cmd-out' }, renderMarkdown(m.text, { onPath }));
      case 'compactionSummary':
      case 'branchSummary':
        return h('details', { class: 'fold' }, h('summary', null, icon('chevron-right', 12, 'chev'), m.role === 'compactionSummary' ? 'Earlier messages were summarized' : 'Branch summary'), renderMarkdown(m.summary || textOf(m.content) || '', { onPath }));
      case 'custom':
        if (m.customType === 'verify' || m.customType === 'review') return checkCard(m);
      // falls through
      case 'hookMessage':
      case 'developer': {
        const txt = textOf(m.content);
        return txt ? h('div', { class: 'note' }, icon('info', 14), h('span', null, txt.length > 600 ? txt.slice(0, 600) + '…' : txt)) : null;
      }
      default: {
        const txt = textOf(m.content);
        return txt ? h('div', { class: 'note' }, h('span', null, `${m.role}: ${txt.slice(0, 400)}`)) : null;
      }
    }
  }

  /** A goal-mode request is shown as one short note, not as something you typed. */
  renderGoalNote(m) {
    const lines = textOf(m.content).split('\n');
    const round = (lines[0] || '').replace(/^\[|\]$/g, '');
    const goal = lines.find((l) => l.startsWith('Goal: ') || l.startsWith('Continue working toward the goal: ')) || '';
    return h('div', { class: 'note goal' }, icon('refresh', 13), h('span', null, `${round}${goal ? ` · ${goal.replace(/^[^:]*: /, '').slice(0, 160)}` : ''}`));
  }

  renderUser(m) {
    const text = textOf(m.content);
    const imgs = Array.isArray(m.content) ? m.content.filter((c) => c.type === 'image' && c.data) : [];
    const { body, files, rest, items } = splitAttachments(text, (p) => viewFile(this.tab, p));
    const bubble = h('div', { class: 'bubble' }, body.length ? h('div', { class: 'b-text' }, body) : null, files.length ? h('div', { class: 'b-files' }, files) : null, imgs.length ? h('div', { class: 'imgs' }, imgs.map((c, i) => h('img', { src: `data:${c.mimeType || 'image/png'};base64,${c.data}`, alt: `Attached image ${i + 1}` }))) : null);
    // Long messages fold to a few lines.
    const plain = body.map((x) => (typeof x === 'string' ? x : x.textContent)).join('');
    if (plain.length > 1400 || plain.split('\n').length > 16) {
      bubble.classList.add('clamp');
      const more = h('button', { class: 'b-more', type: 'button', 'aria-expanded': 'false' }, 'Show all');
      more.addEventListener('click', () => {
        const open = bubble.classList.toggle('clamp');
        more.textContent = open ? 'Show all' : 'Show less';
        more.setAttribute('aria-expanded', String(!open));
      });
      bubble.append(more);
    }
    const copy = h('button', { class: 'msg-act copy', type: 'button', title: 'Copy message' }, icon('copy', 13), 'Copy');
    copy.addEventListener('click', () => copyButtonFeedback(copy, text));
    const edit = h('button', { class: 'msg-act', type: 'button', title: 'Put this message in the message box to change and send it again' }, icon('pencil', 13), 'Edit');
    edit.addEventListener('click', () => {
      // The typed text goes back in the box and the attachments back on it, ready to change and resend.
      this.composer.restore({ raw: rest, items: [...items, ...imgs.map((c, i) => ({ kind: 'image', name: `image ${i + 1}`, url: `data:${c.mimeType || 'image/png'};base64,${c.data}`, b64: c.data, mime: c.mimeType || 'image/png', size: Math.round(c.data.length * 0.75) }))] });
      this.focus();
    });
    const canBranch = m.id && this.tab.state?.features?.includes('branch') && !this.tab.dead;
    const branch = canBranch ? h('button', { class: 'msg-act', type: 'button', title: 'Start a new conversation with the messages up to here. Your files are not changed.' }, icon('branch', 13), 'Branch') : null;
    branch?.addEventListener('click', async () => {
      branch.disabled = true;
      try {
        await rpc(this.tab.id, { type: 'branch', messageId: m.id });
      } catch (e) {
        toast(e.message, 'error', 7000);
      }
      branch.disabled = false;
    });
    const when = m.timestamp ? msgTime(m.timestamp) : null;
    return h('div', { class: 'msg user' }, bubble, h('div', { class: 'msg-acts' }, copy, when, this.tab.dead ? null : edit, branch));
  }

  renderAssistant(m, idx, onPath, reuse = null) {
    const wrap = h('div', { class: 'msg asst' });
    const blocks = Array.isArray(m.content) ? m.content : [];
    blocks.forEach((b, i) => {
      const el = this.renderBlock(b, `${idx}:${i}`, onPath, reuse?.[i]);
      if (el) wrap.append(el);
    });
    if (m.stopReason === 'error' && m.errorMessage) wrap.append(this.errorBox(m.errorMessage));
    else if (m.stopReason === 'aborted') wrap.append(h('div', { class: 'note' }, icon('stop', 12), h('span', null, 'Stopped')));
    if (!wrap.childElementCount) return null;
    if (!this.firstOfTurn(idx)) wrap.classList.add('cont');
    const text = blocks.filter((b) => b.type === 'text' && b.text?.trim()).map((b) => b.text.trim()).join('\n\n');
    const acts = h('div', { class: 'msg-acts' });
    if (text) {
      const copy = h('button', { class: 'msg-act copy', type: 'button', title: 'Copy reply as Markdown' }, icon('copy', 13), 'Copy');
      copy.addEventListener('click', () => copyButtonFeedback(copy, text));
      acts.append(copy);
    }
    // 👍 / 👎, kept on this PC. 👎 also offers what to do next: answer again, another model, or report it.
    if (text && m.timestamp) acts.append(...this.rateButtons(m));
    // A failed reply has Retry in its error box.
    if (m.stopReason === 'aborted' || (m.stopReason !== 'error' && this.tab.state?.features?.includes('regenerate'))) {
      const retry = h('button', { class: 'msg-act retry', type: 'button', title: 'Regenerate this reply' }, icon('refresh', 13), 'Retry');
      retry.addEventListener('click', () => this.retry());
      acts.append(retry);
    }
    // A step that only ran tools gets no action row (it would only add a gap between tool rows); a stopped or failed
    // one keeps it for Retry.
    const ended = m.stopReason === 'error' || m.stopReason === 'aborted';
    if (!text && !ended) return wrap;
    if (m.timestamp) acts.append(msgTime(m.timestamp));
    // Which model wrote it, how long the turn took and how fast it wrote, at the end of the row.
    const meta = this.replyMeta(m, idx);
    if (meta) acts.append(meta);
    wrap.append(acts);
    return wrap;
  }

  /** "Claude Opus 5.5 Medium · 5s · 103.5 tok/s": the model and its reasoning, the turn's time, the writing speed. */
  replyMeta(m, idx) {
    const t = this.tab;
    const id = typeof m.model === 'string' ? m.model : '';
    if (!id) return null;
    const known = (t.models || []).find((x) => x.id === id && (!m.provider || x.provider === m.provider));
    const lvl = m.thinkingLevel && m.thinkingLevel !== 'off' ? ` ${thinkingName(m.thinkingLevel)}` : '';
    const bits = [`${known?.name || id}${lvl}`];
    // The turn: from your message to the end of this reply.
    let u = t.messages[idx] === m ? idx : t.messages.indexOf(m); // the index is known when drawing: no search per reply
    while (u > 0 && t.messages[u].role !== 'user') u--;
    const start = t.messages[u]?.role === 'user' ? t.messages[u].timestamp : m.timestamp;
    const out = m.usage?.output || 0;
    const writing = m.doneAt && m.firstTokenAt ? (m.doneAt - m.firstTokenAt) / 1000 : 0;
    // One fact on screen, the model; the turn's time, the writing speed and the rest are in the tooltip.
    const tip = [
      m.provider ? `${m.provider}/${id}` : id,
      start && m.doneAt > start ? `Took ${fmtDuration(m.doneAt - start)}` : '',
      out > 0 && writing > 0.25 ? `${(out / writing).toFixed(1)} tokens a second` : '',
      m.firstTokenAt && m.timestamp ? `First token after ${fmtDuration(m.firstTokenAt - m.timestamp)}` : '',
      out ? `${NUM.format(out)} output tokens` : '',
    ].filter(Boolean).join('\n');
    return h('span', { class: 'msg-model num', title: tip }, bits[0]);
  }

  /**
   * 👍 and 👎 on a reply. Kept on this PC only: the mark per reply, and a count per model that Settings → Models
   * shows, so you can see which models answer well for you. 👎 also offers to answer again, switch or report.
   */
  rateButtons(m) {
    const key = `rate.${this.tab.state?.sessionId || this.tab.resume || this.tab.id}.${m.timestamp}`;
    const modelId = typeof m.model === 'string' && m.model ? `${m.provider ? `${m.provider}/` : ''}${m.model}` : '';
    const up = h('button', { class: 'msg-act rate', type: 'button', title: 'Good reply', 'aria-label': 'Good reply' }, icon('thumb-up', 13));
    const down = h('button', { class: 'msg-act rate', type: 'button', title: 'Bad reply: retry, change model or report it', 'aria-label': 'Bad reply' }, icon('thumb-down', 13));
    const show = (v) => {
      up.setAttribute('aria-pressed', String(v === 1));
      down.setAttribute('aria-pressed', String(v === -1));
    };
    const set = (v) => {
      const prev = lsGet(key, 0);
      const next = prev === v ? 0 : v;
      lsSet(key, next || null);
      if (modelId) rateModel(modelId, prev, next);
      show(next);
      return next;
    };
    show(lsGet(key, 0));
    up.addEventListener('click', () => set(1));
    down.addEventListener('click', () => {
      if (set(-1) !== -1) return;
      const model = modelId;
      const latest = this.tab.messages[this.tab.messages.length - 1] === m || this.els.get(this.tab.messages[this.tab.messages.length - 1])?.contains(down);
      popMenu(down, [
        { header: 'Not a good reply?' },
        latest && !this.tab.streaming && !this.tab.dead ? { icon: 'refresh', label: 'Answer again', run: () => this.retry() } : null,
        !this.tab.dead ? { icon: 'cpu', label: 'Use another model…', run: () => this.pickModel() } : null,
        { icon: 'alert', label: 'Report a problem…', run: () => emit('feedback', { kind: 'model', text: `${model ? `Model: ${model}\n\n` : ''}What was wrong with the reply:\n` }) },
      ].filter(Boolean));
    });
    return [up, down];
  }

  /** The first reply after your message carries the agent's name (later steps of the same turn do not). */
  firstOfTurn(idx) {
    const p = this.tab.messages[idx - 1];
    return !p || p.role === 'user' || p.role === '_cmd';
  }

  /** A failed reply: the provider's message, what to do about it, and Retry (shown on the latest reply only). */
  errorBox(msg) {
    const help = errorHelp(msg);
    const el = errorState(msg, {
      hint: help?.hint,
      retry: () => this.retry(),
      action: help?.act ? { label: help.act, run: () => (help.run === 'model' ? this.pickModel() : help.run()) } : null,
    });
    el.querySelector('.err-retry').classList.add('retry');
    return el;
  }

  /** Retry is offered only on the latest reply, and only while the agent is idle. */
  refreshActs() {
    const t = this.tab;
    const last = t.messages[t.messages.length - 1];
    const can = !t.streaming && !t.dead;
    // Only the last reply's Retry shows. Touch just the buttons that change: setting `hidden` on every reply's button
    // (a thousand in a long conversation) restyles each of them, on every message.
    const show = can ? this.els.get(last)?.querySelector('.retry') : null;
    for (const b of this.tin.querySelectorAll('.retry:not([hidden])')) if (b !== show) b.hidden = true;
    if (show?.hidden) show.hidden = false;
    this.refreshSummary();
  }

  /**
   * What one turn did, from the message after yours up to `end` (exclusive): files read and changed, searches,
   * commands, helpers, failed steps, the run-end check and review, and how long it took.
   */
  turnStats(start, end) {
    const t = this.tab;
    const files = new Map(); // path -> { add, del, ids }
    const read = new Set();
    const n = { search: 0, run: 0, help: 0, failed: 0, calls: 0 };
    let lastAsst = null;
    let lastEl = null; // the last message drawn in this turn: the summary goes under it
    let check = null; // the last run-end check, and how many failed before it
    let checkFails = 0;
    let review = null;
    let edits = 0;
    for (const m of t.messages.slice(start + 1, end)) {
      if (m.role === 'custom' && (m.customType === 'verify' || m.customType === 'review')) {
        lastEl = m;
        if (m.customType === 'review') review = { ...m.details, editsBefore: edits };
        else {
          if (check?.status === 'failed') checkFails++;
          check = m.details || {};
        }
        continue;
      }
      if (m.role !== 'assistant') continue;
      lastAsst = m;
      lastEl = m;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type !== 'toolCall') continue;
        n.calls++;
        const r = t.results.get(b.id);
        // A failed step counts once, as failed, not also as a file read or a command run.
        if (r?.isError) {
          n.failed++;
          continue;
        }
        const a = b.arguments || {};
        if (b.name === 'read') a.path && read.add(a.path);
        else if (/^(glob|grep|find|web_search|web_fetch)$/.test(b.name)) n.search++;
        else if (b.name === 'bash') n.run++;
        else if (b.name === 'task') n.help++;
        if (b.name !== 'edit' && b.name !== 'write') continue;
        const d = r?.details;
        if (d?.undone) continue;
        const path = d?.path || a.path;
        if (!path) continue;
        const f = files.get(path) || { add: 0, del: 0, ids: [] };
        const c = diffCounts(d);
        if (c) (f.add += c.add), (f.del += c.del);
        edits++;
        if (d?.undoable) f.ids.push(b.id);
        files.set(path, f);
      }
    }
    const u = t.messages[start];
    const endAt = lastAsst?.doneAt || lastAsst?.timestamp;
    const secs = u?.timestamp && endAt ? Math.max(0, Math.round((endAt - u.timestamp) / 1000)) : null;
    return { files, read, n, check, checkFails, review, edits, lastAsst, lastEl, secs };
  }

  /** The facts of a turn as small labelled items: "Read 2 files", "Ran 1 command", "Tests passed"… */
  turnFacts(st) {
    const pl = (k, one, many = one + 's') => `${k} ${k === 1 ? one : many}`;
    const { read, n, files, check, checkFails, review, edits } = st;
    return [
      n.failed ? [icon('alert', 12), pl(n.failed, 'failed step'), true] : null,
      read.size ? [icon('eye', 12), `Read ${pl(read.size, 'file')}`] : null,
      n.search ? [icon('search', 12), pl(n.search, 'search', 'searches')] : null,
      n.run ? [icon('terminal', 12), `Ran ${pl(n.run, 'command')}`] : null,
      n.help ? [icon('users', 12), pl(n.help, 'helper')] : null,
      files.size ? [icon('pencil', 12), `Changed ${pl(files.size, 'file')}`] : null,
      check ? (check.status === 'passed' ? [icon('check', 12), `${checkWord(check.command)} passed${checkFails ? ` after ${pl(checkFails, 'fix', 'fixes')}` : ''}`] : [icon('alert', 12), `${checkWord(check.command)} ${check.status === 'skipped' ? 'skipped' : 'failed'}`, check.status !== 'skipped']) : null,
      review ? (review.status === 'issues' ? [icon('eye', 12), `Review found ${pl(review.issues?.length || 0, 'issue')}${edits > review.editsBefore ? ', fixed' : ''}`] : [icon('eye', 12), 'Review found no issues']) : null,
    ].filter(Boolean).map(([ic, txt, bad]) => h('span', { class: 'ts-fact' + (bad ? ' bad' : '') }, ic, txt));
  }

  /** Fold every finished turn from message `from` on (the turn still running stays open). */
  foldTurns(from = 0, to = this.tab.messages.length) {
    const t = this.tab;
    const users = [];
    for (let i = from; i < to; i++) if (t.messages[i].role === 'user') users.push(i);
    users.forEach((u, k) => {
      const end = users[k + 1] ?? to;
      if (end === t.messages.length && (t.streaming || t.live?.message)) return;
      this.foldTurn(u, end);
    });
  }

  /**
   * The steps of a finished turn (the agent's notes between tools and every tool call) go into one fold that reads
   * "Worked for 14s · Read 2 files · Ran 1 command"; the final reply stays in view below it. Opening the fold shows
   * every step as it was. Turns without tool calls are left as they are.
   */
  foldTurn(start, end, st = this.turnStats(start, end)) {
    const t = this.tab;
    if (!st.n.calls) return null;
    const msgs = t.messages.slice(start + 1, end);
    // Keep the last standalone answer or terminal error visible even if the turn ended with tool-only messages.
    const fi = msgs.findLastIndex(isReply);
    const steps = msgs.filter((m, i) => i < fi || fi < 0 || (i > fi && (
      m.role === 'assistant' ||
      (m.role === 'custom' && (m.customType === 'verify' || m.customType === 'review') && !['failed', 'issues'].includes(m.details?.status))
    )));
    const key = String(t.messages[start]?.id || t.messages[start]?.timestamp || start);
    const old = this.tin.querySelector(`details.work[data-key="${CSS.escape(key)}"]`);
    // Membership of the transcript, not of the page: a view is drawn (and its turns folded) before it is shown.
    const els = steps.map((m) => this.els.get(m)).filter((el) => el && el.parentNode === this.tin);
    if (!els.length) return old; // already folded
    const first = els[0];
    const head = h('summary', { class: 'work-h' },
      icon('chevron-right', 12, 'chev'),
      h('span', { class: 'work-l' }, st.secs != null ? `Worked for ${st.secs >= 1 ? fmtElapsed(st.secs) : '<1s'}` : 'Worked'),
      h('span', { class: 'work-facts' }, this.turnFacts(st)));
    const fold = old || h('details', { class: 'work', dataset: { key } });
    if (old) old.firstChild.replaceWith(head);
    else {
      fold.append(head, h('div', { class: 'work-b' }));
      // Default: each turn's steps fold into "Worked for…"; Verbose (or screen reader mode) keeps them open.
      fold.open = S.ui.steps === 'verbose' || S.ui.screenReader === true ? !this.workShut.has(key) : this.workOpen.has(key);
    }
    const finalEl = fi >= 0 && this.els.get(msgs[fi]);
    if (!old) first.before(fold);
    if (finalEl?.parentNode === this.tin && (finalEl.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING)) finalEl.before(fold);
    const body = fold.lastChild;
    for (const el of els) {
      el.classList.remove('enter');
      body.append(el);
    }
    // The final reply follows the fold directly: it reads as the continuation of the same turn. Its thinking is
    // one of the steps, so it goes in the fold too and the answer starts right under "Worked for…".
    if (finalEl?.parentNode === this.tin) {
      finalEl.classList.add('cont');
      for (const th of finalEl.querySelectorAll(':scope > details.think')) body.append(th);
    }
    return fold;
  }

  /** After a finished reply that changed files: what changed, with a way to review it or undo it all. */
  refreshSummary() {
    const t = this.tab;
    this.summaryEl?.remove();
    this.summaryEl = null;
    if (t.streaming || t.dead) return;
    this.settleLiveFold();
    let start = t.messages.length - 1;
    while (start >= 0 && t.messages[start].role !== 'user') start--;
    if (start < 0) return;
    const st = this.turnStats(start, t.messages.length);
    this.foldTurn(start, t.messages.length, st); // a turn that changed files always ran tools, so it is always folded
    const { files, lastEl } = st;
    const anchor = lastEl && this.els.get(lastEl);
    if (!anchor || !files.size) return;
    const all = [...files.values()];
    const ids = all.flatMap((f) => f.ids);
    const total = { add: all.reduce((s, f) => s + f.add, 0), del: all.reduce((s, f) => s + f.del, 0) };
    const undo = ids.length ? h('button', { class: 'btn sm', type: 'button', title: 'Put every file changed in this reply back as it was' }, icon('undo', 13), 'Undo all') : null;
    undo?.addEventListener('click', () => this.undoAll(ids));
    const rel = (p) => {
      const a = p.replace(/\\/g, '/');
      const b = t.workspace.replace(/\\/g, '/').replace(/\/+$/, '');
      return a.toLowerCase().startsWith(b.toLowerCase() + '/') ? a.slice(b.length + 1) : p;
    };
    const rows = [...files].slice(0, 6).map(([p, f]) => h('button', { class: 'ts-file', type: 'button', title: p, onclick: () => reviewChanges(t, p) }, icon('file', 12), h('span', { class: 'ell grow' }, h('bdi', null, rel(p))), statChips(f, 'ts-stat num')));
    if (files.size > 6) rows.push(h('div', { class: 'ts-more' }, `and ${files.size - 6} more`));
    this.summaryEl = h('div', { class: 'turn-sum enter' },
      h('div', { class: 'ts-head' }, h('b', null, `${files.size} file${files.size === 1 ? '' : 's'} changed`), statChips(total, 'ts-stat num'), h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', type: 'button', onclick: () => reviewChanges(t, null) }, icon('branch', 13), 'Review'), undo),
      h('div', { class: 'ts-files' }, ...rows));
    // Under the turn: after whatever of it is drawn last (the final reply, a failed check, or the fold).
    const last = [...this.tin.children].filter((x) => x !== this.pendingEl && x !== this.liveEl && x !== this.emptyEl && !x.classList.contains('dead')).pop();
    (last || anchor.closest('details.work') || anchor).after(this.summaryEl);
    if (this.stick) this.scrollBottom();
  }

  async undoAll(ids) {
    const t = this.tab;
    let n = 0;
    for (const id of [...ids].reverse()) {
      try {
        await rpc(t.id, { type: 'undo', toolCallId: id });
        const msg = t.results.get(id);
        if (msg) msg.details = { ...(msg.details || {}), undone: true };
        n++;
      } catch (e) {
        toast(e.message, 'error', 7000);
        break;
      }
    }
    if (n) toast(`Undid ${n} change${n === 1 ? '' : 's'}`, 'ok', 3500);
    this.renderAll();
  }

  async retry() {
    const t = this.tab;
    if (t.streaming || t.dead) return;
    if (t.state?.features?.includes('regenerate')) {
      // The agent drops its last reply and answers again; the rewound conversation comes back as session_rewound.
      this.scrollBottom(true);
      try {
        await rpc(t.id, { type: 'regenerate' });
      } catch (e) {
        toast(e.message, 'error');
      }
      return;
    }
    const u = [...t.messages].reverse().find((m) => m.role === 'user');
    if (!u) return;
    const images = Array.isArray(u.content) ? u.content.filter((c) => c.type === 'image' && c.data).map((c) => ({ type: 'image', data: c.data, mimeType: c.mimeType || 'image/png' })) : [];
    this.scrollBottom(true);
    try {
      await sendPrompt(t, textOf(u.content) || '(see the attached image)', { images });
    } catch {}
    this.updateComposer();
  }

  renderBlock(b, key, onPath, reuse) {
    if (b.type === 'text') {
      if (!b.text?.trim()) return null;
      if (reuse?.type === 'text' && reuse.md) {
        reuse.md.finish(b.text);
        return reuse.md.el;
      }
      return renderMarkdown(b.text, { onPath });
    }
    if (b.type === 'thinking') {
      if (S.ui.showThinking === false || !b.thinking?.trim()) return null;
      if (reuse?.type === 'thinking' && reuse.md) {
        reuse.md.finish(b.thinking);
        reuse.el.classList.remove('live');
        const l = reuse.el.querySelector('.think-l');
        if (l) l.textContent = 'Thought';
        setGist(reuse.el, b.thinking);
        return reuse.el;
      }
      return this.thinkBlock(key, renderMarkdown(b.thinking, { onPath }), false, b.thinking);
    }
    if (b.type === 'toolCall') return this.toolCard(b);
    if (b.type === 'image' && b.data) return h('img', { class: 'tool-img', src: `data:${b.mimeType || 'image/png'};base64,${b.data}`, alt: 'Image from the agent' });
    return null;
  }

  /** A thinking block: one quiet row ("Thought  what it was about…") that opens to the full text. */
  thinkBlock(key, body, live, text = '') {
    const d = h('details', { class: 'think' + (live ? ' live' : ''), dataset: { key } }, h('summary', null, icon('chevron-right', 12, 'chev'), h('span', { class: 'think-l' }, live ? 'Thinking' : 'Thought'), h('span', { class: 'think-p ell' })), h('div', { class: 'think-b' }, body));
    setGist(d, text);
    d.open = this.thinkOpen.has(key);
    return d;
  }

  toolCard(call) {
    const t = this.tab;
    return renderToolCard(t, { id: call.id, name: call.name, arguments: call.arguments, intent: call.intent }, t.tools.get(call.id), t.toolOpen?.get(call.id));
  }

  _renderLive() {
    if (this.dead) return;
    const t = this.tab;
    const live = t.live?.message;
    if (!live) {
      this.liveEl?.remove();
      this.liveEl = null;
      this.liveBlocks = [];
      this.updatePending();
      this.updateEmpty();
      this.refreshActs();
      return;
    }
    if (!this.liveEl) {
      this.liveEl = h('div', { class: 'msg asst live enter' });
      this.tin.insertBefore(this.liveEl, this.pendingEl?.parentNode === this.tin ? this.pendingEl : null);
      this.liveBlocks = [];
      this.removeEmpty();
    }
    const blocks = live.content || [];
    const onPath = (p) => viewFile(t, p);
    const idx = t.messages.length;
    const showThink = S.ui.showThinking !== false;
    blocks.forEach((b, i) => {
      const prev = this.liveBlocks[i];
      const last = i === blocks.length - 1;
      // Providers open a thinking block before any text (some never send any): no row until there is something to read.
      if (b.type === 'thinking' && !(b.thinking || '').trim()) {
        if (prev?.el?.parentNode === this.liveEl) prev.el.remove();
        this.liveBlocks[i] = undefined;
        return;
      }
      if (b.type === 'text' || (b.type === 'thinking' && showThink)) {
        const text = (b.type === 'text' ? b.text : b.thinking) || '';
        if (prev?.type !== b.type) {
          const md = new LiveMarkdown(onPath);
          const el = b.type === 'text' ? md.el : this.thinkBlock(`${idx}:${i}`, md.el, true);
          this.placeLive(prev, el, i);
          this.liveBlocks[i] = { type: b.type, md, el };
        }
        const cur = this.liveBlocks[i];
        cur.md.update(text);
        if (b.type === 'thinking') {
          const l = cur.el.querySelector('.think-l');
          const want = last ? 'Thinking' : 'Thought';
          if (l && l.textContent !== want) l.textContent = want;
          cur.el.classList.toggle('live', last);
          setGist(cur.el, text);
        }
        return;
      }
      const sig = b.type === 'toolCall' ? b.id + JSON.stringify(b.arguments) + (t.tools.get(b.id)?.status || '') + (t.waitingTool === b.id) : b.type + (b.data?.length || '');
      if (prev && prev.sig === sig) return;
      const el = b.type === 'toolCall' ? this.toolCard(b) : this.renderBlock(b, `${idx}:${i}`, onPath);
      if (el && !prev) el.classList.add('enter');
      this.placeLive(prev, el, i);
      this.liveBlocks[i] = { type: b.type, sig, el };
    });
    for (let i = blocks.length; i < this.liveBlocks.length; i++) this.liveBlocks[i]?.el?.remove();
    this.liveBlocks.length = blocks.length;
    const typing = blocks[blocks.length - 1]?.type === 'text';
    if (typing !== this.liveEl.classList.contains('typing')) this.liveEl.classList.toggle('typing', typing);
    this.updatePending();
    // Already inside an animation frame: follow in this same frame so the new text never paints below the fold.
    if (this.stick && S.ui.autoScroll !== false) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  /** Put a live block's element in place of the previous one (or after the blocks before it). */
  placeLive(prev, el, i) {
    if (prev?.el?.parentNode === this.liveEl) {
      if (el) prev.el.replaceWith(el);
      else prev.el.remove();
      return;
    }
    if (!el) return;
    const after = this.liveBlocks.slice(0, i).reverse().find((x) => x?.el?.parentNode === this.liveEl)?.el;
    if (after) after.after(el);
    else this.liveEl.prepend(el);
  }

  /** Tool updates arrive in bursts (streamed command output): redraw each card at most once per frame. */
  updateTool(id) {
    if (this.dead) return;
    this.toolQ.add(id);
    if (this._tq) return;
    this._tq = requestAnimationFrame(() => {
      this._tq = 0;
      if (this.dead) return;
      const ids = [...this.toolQ];
      this.toolQ.clear();
      for (const x of ids) this._updateTool(x);
      this.scrollBottom();
    });
  }

  _updateTool(id) {
    const old = this.tin.querySelector(`.tool[data-id="${CSS.escape(id)}"]`);
    if (!old) return;
    const t = this.tab;
    let call = null;
    for (const m of [t.live?.message, ...t.messages.slice(-80).reverse()]) {
      call = Array.isArray(m?.content) ? m.content.find((c) => c.type === 'toolCall' && c.id === id) : null;
      if (call) break;
    }
    if (!call) return;
    const el = this.toolCard(call);
    if (el.classList.contains('done') && /\b(running|pending|waiting)\b/.test(old.className)) el.classList.add('just-done');
    // Streaming output: keep following its end if the reader was there.
    const out = old.querySelector('.tool-body pre.out:last-of-type');
    const follow = out && out.scrollHeight - out.scrollTop - out.clientHeight < 8;
    old.replaceWith(el);
    if (follow) {
      const n = el.querySelector('.tool-body pre.out:last-of-type');
      if (n) n.scrollTop = n.scrollHeight;
    }
    const j = this.liveBlocks.findIndex((x) => x?.el === old);
    if (j >= 0) this.liveBlocks[j].el = el;
  }

  showDead(scroll = true) {
    const d = this.tab.deadInfo || {};
    this.deadShown = true;
    this.pendingEl?.remove();
    this.pendingEl = null;
    const detail = [d.message, d.stderr?.length ? d.stderr.join('\n') : ''].filter(Boolean).join('\n\n');
    this.tin.append(errorState(detail, { title: `This conversation ended${d.code != null ? ` (exit code ${d.code})` : ''}.`, retry: () => this.reopen(), retryLabel: 'Reopen conversation', cls: 'enter' }));
    this.updateComposer();
    this.refreshActs();
    if (scroll) this.scrollBottom(true);
  }

  /** Start the conversation again in a fresh process, in place of the one that ended. */
  async reopen() {
    const t = this.tab;
    const file = t.state?.sessionFile || t.resume;
    try {
      await openTab({ workspace: t.workspace, resume: file || undefined, title: t.name });
      closeTab(t.id);
    } catch (e) {
      toast(e.message, 'error', 8000);
    }
  }

  scrollBottom(force) {
    if (force) this.stick = true;
    else if (!(this.stick && S.ui.autoScroll !== false)) return;
    if (this._sb) return;
    this._sb = requestAnimationFrame(() => {
      this._sb = 0;
      if (this.dead) return;
      this.scroller.scrollTop = this.scroller.scrollHeight;
      this.showJump(false);
    });
  }

  focus() {
    this.composer.focus();
  }

  setText(v) {
    this.composer.value = v;
  }

  /** Esc in the message box: deny a pending approval, else stop the agent. */
  onEscape() {
    const t = this.tab;
    if (this.approvalDlg?.options.includes('Deny')) return this.answerApproval('Deny'), true;
    if (t.streaming) return abort(t), true;
    return false;
  }

  async onSend(followUp = false, fromButton = false) {
    const t = this.tab;
    if (t.dead || this.sending) return;
    const p = this.composer.payload();
    if (!p) {
      // Enter on an empty box does nothing; only the stop button (or Esc) stops the agent.
      if (fromButton && t.streaming) abort(t);
      return;
    }
    // /btw <question>: a side question, answered in the side panel without interrupting the agent.
    const btw = /^\/btw\s+([\s\S]+)/.exec(p.text || '');
    if (btw && !p.images?.length) {
      this.composer.reset(p.raw);
      return askSide(t, btw[1]);
    }
    // !command: a shell command, run in the project's Terminal (the side panel), not sent to the agent.
    const bang = /^!\s*(\S[\s\S]*)/.exec(p.raw || '');
    if (bang && !p.images?.length && !p.items?.length) {
      this.composer.reset(p.raw);
      return runInTerminal(bang[1].trim());
    }
    this.sending = true;
    this.composer.reset(p.raw);
    const svg = this.sendBtn.querySelector('svg');
    if (svg && !reduced.matches) svg.animate([{ transform: 'none' }, { opacity: 0, transform: 'translateY(-14px)', offset: 0.45 }, { opacity: 0, transform: 'translateY(12px)', offset: 0.46 }, { opacity: 1, transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' });
    this.scrollBottom(true);
    try {
      await sendPrompt(t, p.text || '(see the attached image)', { followUp, images: p.images });
    } catch {
      // The error is in the transcript; give the message back so nothing typed is lost.
      if (!this.composer.hasContent()) this.composer.restore(p);
    } finally {
      this.sending = false;
      this.updateComposer();
    }
  }
}
