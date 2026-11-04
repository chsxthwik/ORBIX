// One session view: transcript (with live streaming), tool approvals, composer.
import { h, icon, iconBtn, replace, clear, toast, fmtTokens, fmtCost, rafThrottle, kbd, copyButtonFeedback, copyText, baseName, leave, logo } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { renderToolCard, output, diffCounts, statChips } from './tools.js';
import { S, emit, textOf, sendPrompt, abort, setThinking, setFast, setModel, loadModels, refreshState, savePrefs, replyUi } from './store.js';
import { rpc, api } from './api.js';
import { modelPicker, popMenu, isApproval } from './dialogs.js';
import { viewFile, reviewChanges } from './panels.js';
import { conversationToMarkdown } from './exporter.js';
import { Composer } from './composer.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)');

/** Session actions (topbar "more" button). */
export function sessionMenu(t, anchor, { rename, close }) {
  const cmd = (c) => t.commands.some((x) => x.name === c);
  popMenu(anchor, [
    { label: 'Rename…', run: rename },
    ...(cmd('compact') ? [{ label: 'Compact context', hint: '/compact', run: () => sendPrompt(t, '/compact').catch(() => {}) }] : []),
    ...(cmd('handoff') ? [{ label: 'Hand off to a new context', hint: '/handoff', run: () => sendPrompt(t, '/handoff').catch(() => {}) }] : []),
    '-',
    { label: 'Copy as Markdown', run: () => copyConversation(t) },
    { label: 'Export as HTML', run: async () => {
      try {
        const r = await rpc(t.id, { type: 'export_html' }, 120000);
        const p = r.data?.path || r.data?.outputPath;
        toast(p ? `Exported to ${p}` : 'Exported', 'ok', 6000);
        if (p) api.post('/api/fs/reveal', { path: p }).catch(() => {});
      } catch (er) {
        toast(er.message, 'error');
      }
    } },
    '-',
    { label: 'Close session', danger: true, run: close },
  ], { align: 'end' });
}

export async function copyConversation(t) {
  if (await copyText(conversationToMarkdown(t), { quiet: true })) toast('Conversation copied as Markdown', 'ok', 1800);
  else toast('Copy failed', 'error');
}

/**
 * Where a streaming Markdown text can be split: after the last blank line that is outside a code fence and
 * not followed by an indented continuation. Everything before it is complete and never re-rendered.
 */
function stableCut(text) {
  const lines = text.split('\n');
  let fence = null;
  let pos = 0;
  let cut = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const ln = lines[i];
    const f = /^\s*(`{3,}|~{3,})/.exec(ln);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && /^\s*[`~]+\s*$/.test(ln)) fence = null;
    } else if (f) fence = f[1];
    pos += ln.length + 1;
    if (!fence && !ln.trim() && !/^\s+\S/.test(lines[i + 1])) cut = pos;
  }
  return cut;
}

/** Markdown that grows while it streams: finished blocks are rendered once, only the last block is redrawn. */
class LiveMarkdown {
  constructor(onPath) {
    this.el = h('div', { class: 'md' });
    this.onPath = onPath;
    this.done = 0;
    this.text = '';
    this.tail = [];
  }
  update(text) {
    if (text === this.text) return;
    if (!text.startsWith(this.text.slice(0, this.done))) {
      clear(this.el);
      this.done = 0;
      this.tail = [];
    }
    this.text = text;
    for (const n of this.tail) n.remove();
    this.tail = [];
    const cut = stableCut(text);
    if (cut > this.done) {
      this.el.append(...renderMarkdown(text.slice(this.done, cut), { onPath: this.onPath }).childNodes);
      this.done = cut;
    }
    const rest = text.slice(this.done);
    if (rest.trim()) {
      this.tail = [...renderMarkdown(rest, { onPath: this.onPath, live: true }).childNodes];
      this.el.append(...this.tail);
    }
  }
  /** The reply is complete: render the last block in full (highlighting included). */
  finish(text) {
    for (const n of this.tail) n.remove();
    this.tail = [];
    if (!text.startsWith(this.text.slice(0, this.done))) {
      clear(this.el);
      this.done = 0;
    }
    const rest = text.slice(this.done);
    if (rest.trim()) this.el.append(...renderMarkdown(rest, { onPath: this.onPath }).childNodes);
    this.text = text;
    this.done = text.length;
  }
}

/** What to tell the user about a failed request, and the one action that most likely fixes it. */
function errorHelp(msg) {
  const m = String(msg || '');
  if (/\b(401|403)\b|unauthori[sz]ed|invalid.{0,20}(api.?)?key|incorrect api key|authentication|no api key/i.test(m)) return { hint: 'Check the API key for this provider.', act: 'Open AI providers', run: () => emit('settings', 'engine') };
  if (/\b429\b|rate.?limit|quota|overloaded|capacity|too many requests/i.test(m)) return { hint: 'The provider is busy or the quota is used up. Wait a moment, then retry.' };
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|fetch failed|network|socket hang up|timed? ?out/i.test(m)) return { hint: 'ORBIX could not reach the provider. Check the connection, or that the local model server is running.' };
  if (/context|too long|maximum.{0,20}tokens|token limit/i.test(m) && /exceed|maximum|limit|too long|reduce/i.test(m)) return { hint: 'The conversation is too long for this model. Compact it with /compact, or start a new session.' };
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

const clock = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

export class TabView {
  constructor(tab) {
    this.tab = tab;
    this.limit = 120;
    this.stick = true;
    this.liveBlocks = [];
    this.liveEl = null;
    this.approvalDlg = null;
    this.approvalEl = null;
    this.thinkOpen = new Set();
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
    this.widgets = h('div', { class: 'widgets' });
    this.composer = new Composer({
      placeholder: t.engine === 'builtin' ? 'Message ORBIX' : 'Message OMP CLI',
      label: 'Message',
      state: t,
      workspace: () => t.workspace,
      commands: () => t.commands,
      model: () => t.model,
      onSubmit: (alt) => this.onSend(alt),
      onEscape: () => this.onEscape(),
      onChange: () => this.updateSend(),
    });
    this.ta = this.composer.ta;
    this.sendBtn = h('button', { class: 'send', type: 'button', onclick: () => this.onSend(false, true) });
    this.modelBtn = h('button', { class: 'cbtn', type: 'button', title: 'Model', onclick: () => this.pickModel() });
    this.thinkBtn = h('button', { class: 'cbtn', type: 'button', title: 'Thinking level', 'aria-haspopup': 'menu', onclick: (e) => this.pickThinking(e.currentTarget) });
    this.planBtn = h('button', { class: 'cbtn plan', type: 'button', title: 'Plan mode: the agent only reads and proposes a plan, it changes nothing', onclick: () => this.togglePlan() });
    this.fastBtn = h('button', { class: 'cbtn', type: 'button', title: 'Fast mode', onclick: () => setFast(t, !t.state?.fastModeEnabled).catch((er) => toast(er.message, 'error')) });
    this.ctx = h('span', { class: 'ctx-meter' });
    this.statusLine = h('div', { class: 'c-status', 'aria-live': 'polite' });
    this.composer.el.append(h('div', { class: 'c-row' }, iconBtn('paperclip', 'Attach images or text files', () => this.composer.openFilePicker()), this.modelBtn, this.thinkBtn, this.planBtn, this.fastBtn, h('span', { class: 'grow' }), this.ctx, this.sendBtn));
    this.dockCol = h('div', { class: 'dock-col' }, this.widgets, this.queue, this.composer.el, this.statusLine);
    this.root = h('div', { class: 'session-inner' }, this.scroller, h('div', { class: 'dock' }, this.jump, this.dockCol), h('div', { class: 'drop-hint', 'aria-hidden': 'true' }, icon('paperclip', 18), 'Drop images or text files to attach'));
    this.root._view = this;
    this.composer.dropZone(this.root);

    // Follow new output only while the reader is at the bottom; any upward scroll stops it until they return.
    // Content growing never moves scrollTop, so only a decrease (with room left below) is the reader scrolling up.
    this.lastTop = 0;
    this.scroller.addEventListener('scroll', () => {
      const sc = this.scroller;
      const d = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
      if (d <= 4) this.stick = true;
      else if (sc.scrollTop < this.lastTop - 1) this.stick = false;
      this.lastTop = sc.scrollTop;
      this.showJump(!this.stick);
    }, { passive: true });
    // A window, panel or composer resize keeps a reader who was at the bottom at the bottom.
    new ResizeObserver(() => this.stick && this.scroller.isConnected && (this.scroller.scrollTop = this.scroller.scrollHeight)).observe(this.scroller);
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
    this.saved = { top: this.scroller.scrollTop, stick: this.stick };
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
  }

  updateComposer() {
    const t = this.tab;
    const st = t.state;
    const m = t.model;
    const dead = t.dead;
    this.ta.disabled = dead;
    this.ta.placeholder = dead ? 'This session has ended' : t.streaming ? 'Steer the agent, or Esc to stop' : t.engine === 'builtin' ? 'Message ORBIX' : 'Message OMP CLI';
    this.composer.el.classList.toggle('busy', !!t.streaming);
    this.updateSend();

    this.modelBtn.hidden = dead;
    this.modelBtn.replaceChildren(icon('cpu', 14), h('span', { class: 'ell' }, m ? m.name || m.id : 'Default model'), icon('chevron-down', 12, 'cbtn-chev'));
    const efforts = m?.thinking?.efforts || [];
    const lvl = st?.thinkingLevel || 'off';
    this.thinkBtn.hidden = dead || !(m?.reasoning || efforts.length);
    this.thinkBtn.replaceChildren(icon('brain', 14), h('span', null, lvl === 'off' ? 'Thinking off' : `Thinking ${lvl}`), icon('chevron-down', 12, 'cbtn-chev'));
    this.thinkBtn.classList.toggle('on', lvl !== 'off');
    const hasPlan = !!st && 'planMode' in st;
    this.planBtn.hidden = dead || !hasPlan;
    this.planBtn.replaceChildren(icon('map', 14), h('span', null, st?.planMode ? 'Plan mode' : 'Plan'));
    this.planBtn.classList.toggle('on', !!st?.planMode);
    this.planBtn.setAttribute('aria-pressed', String(!!st?.planMode));
    const hasFast = st && st.fastModeEnabled !== undefined;
    this.fastBtn.hidden = dead || !hasFast;
    this.fastBtn.replaceChildren(icon('bolt', 14), h('span', null, 'Fast'));
    this.fastBtn.classList.toggle('on', !!st?.fastModeEnabled);
    this.fastBtn.setAttribute('aria-pressed', String(!!st?.fastModeEnabled));

    const cu = t.stats?.contextUsage;
    if (cu?.contextWindow && cu.tokens > 0 && !dead) {
      const pct = Math.min(100, cu.percent ?? (cu.tokens / cu.contextWindow) * 100);
      this.ctx.hidden = false;
      this.ctx.className = 'ctx-meter' + (pct > 90 ? ' crit' : pct > 70 ? ' hot' : '');
      this.ctx.style.setProperty('--p', pct.toFixed(1));
      this.ctx.title = `Context: ${fmtTokens(cu.tokens)} of ${fmtTokens(cu.contextWindow)} tokens${cu.estimated ? ' (estimated)' : ''}${t.stats?.cost ? ` · cost ${fmtCost(t.stats.cost)}` : ''}`;
      this.ctx.replaceChildren(h('i', { 'aria-hidden': 'true' }), pct < 0.1 ? '<0.1%' : `${pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}%`);
    } else this.ctx.hidden = true;

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
    this.sendBtn.disabled = t.dead || (!stop && !typed);
    this.sendBtn.title = stop ? 'Stop (Esc)' : t.streaming ? 'Steer (Enter) · Queue (Alt+Enter)' : 'Send (Enter)';
    this.sendBtn.setAttribute('aria-label', stop ? 'Stop the agent' : t.streaming ? 'Steer' : 'Send');
  }

  updateStatus() {
    const t = this.tab;
    const bits = [];
    if (t.compacting) bits.push(h('span', null, 'Compacting context…'));
    if (t.retry) bits.push(h('span', { class: 'warn-text' }, 'Retrying…'));
    for (const [k, v] of t.statuses) if (!(k === 'plan' && !this.planBtn.hidden)) bits.push(h('span', null, v));
    if (t.streaming && t.state?.tokensPerSecond) bits.push(h('span', { class: 'num' }, `${t.state.tokensPerSecond.toFixed(0)} tok/s`));
    if (t.streaming && !bits.length && !this.approvalDlg) bits.push(h('span', null, kbd('Enter'), ' steer  ', kbd('Alt+Enter'), ' queue  ', kbd('Esc'), ' stop'));
    replace(this.statusLine, bits);
    replace(this.widgets, [...t.widgets.values()].map((w) => h('pre', { class: 'widget' }, w.lines.join('\n'))));
  }

  pickModel() {
    const t = this.tab;
    modelPicker({
      load: () => loadModels(t),
      current: t.model,
      onPick: async (x) => {
        await setModel(t, x);
        if (t.engine === 'builtin') savePrefs({ homeModel: { provider: x.provider, id: x.id, name: x.name || x.id } });
        this.focus();
      },
    });
  }

  pickThinking(anchor) {
    const t = this.tab;
    const lvl = t.state?.thinkingLevel || 'off';
    popMenu(anchor, ['off', ...(t.model?.thinking?.efforts || [])].map((l) => ({ label: l === 'off' ? 'Off' : l[0].toUpperCase() + l.slice(1), on: l === lvl, run: () => setThinking(t, l).catch((er) => toast(er.message, 'error')) })), { minWidth: 160 });
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
      h('div', { class: 'ap-acts' }, d.options.map((o, i) => h('button', { class: 'btn sm ' + (o === 'Deny' ? 'ghost' : i === 0 ? 'primary' : ''), type: 'button', onclick: () => this.answerApproval(o) }, o, kbd(o === 'Deny' ? 'Esc' : String(i + 1))))));
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
    clear(this.tin);
    this.liveEl = null;
    this.liveBlocks = [];
    this.pendingEl = null;
    this.deadShown = false;
    const msgs = t.messages;
    const start = Math.max(0, msgs.length - this.limit);
    if (start > 0) this.tin.append(h('button', { class: 'btn sm earlier', type: 'button', onclick: () => ((this.limit += 150), this.renderAll()) }, `Show ${Math.min(150, start)} earlier messages`));
    const frag = document.createDocumentFragment();
    for (let i = start; i < msgs.length; i++) {
      const el = this.renderMessage(msgs[i], i);
      if (el) {
        this.els.set(msgs[i], el);
        frag.append(el);
      }
    }
    this.tin.append(frag);
    if (t.dead) this.showDead(false);
    this._renderLive();
    this.updateEmpty();
    if (fromBottom != null) sc.scrollTop = sc.scrollHeight - fromBottom;
    else this.scrollBottom(true);
  }

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
    this.tin.insertBefore(el, this.liveEl || this.pendingEl || null);
    if (msg.role === 'assistant' || msg.role === 'user') this.refreshActs();
    this.updateEmpty();
    this.updatePending();
    this.scrollBottom();
  }

  removeMsg(msg) {
    const el = this.els.get(msg);
    if (el) leave(el);
  }

  updateEmpty() {
    const t = this.tab;
    const show = !t.messages.length && !t.live && !t.dead && !t.streaming;
    if (!show) return void this.emptyEl?.remove();
    if (this.emptyEl?.isConnected) return;
    this.emptyEl = h('div', { class: 'chat-empty' },
      h('div', { class: 'ce-name' }, baseName(t.workspace)),
      h('div', { class: 'ce-path' }, h('bdi', null, t.workspace)),
      h('div', { class: 'ce-keys' }, h('span', null, kbd('/'), ' commands'), h('span', null, kbd('@'), ' mention a file'), h('span', null, kbd('Shift+Enter'), ' new line')));
    this.tin.append(this.emptyEl);
  }

  /** Three dots at the end while the agent works but nothing streams yet (between steps). */
  updatePending() {
    const t = this.tab;
    const idle = !t.streaming || t.dead || this.approvalDlg || (this.liveEl && this.liveEl.childElementCount);
    if (idle) return void (this.pendingEl?.remove(), (this.pendingEl = null));
    if (!this.pendingEl) this.pendingEl = h('div', { class: 'pending', role: 'status', 'aria-label': 'Working' }, h('span', { class: 'pending-dots' }, h('i'), h('i'), h('i')));
    if (this.pendingEl.parentNode !== this.tin || this.pendingEl.nextSibling) this.tin.append(this.pendingEl);
    this.emptyEl?.remove();
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
    const copy = h('button', { class: 'msg-act', type: 'button', title: 'Copy message' }, icon('copy', 13), 'Copy');
    copy.addEventListener('click', () => copyButtonFeedback(copy, text));
    const edit = h('button', { class: 'msg-act', type: 'button', title: 'Put this message in the message box to change and send it again' }, icon('pencil', 13), 'Edit');
    edit.addEventListener('click', () => {
      // The typed text goes back in the box and the attachments back on it, ready to change and resend.
      this.composer.restore({ raw: rest, items: [...items, ...imgs.map((c, i) => ({ kind: 'image', name: `image ${i + 1}`, url: `data:${c.mimeType || 'image/png'};base64,${c.data}`, b64: c.data, mime: c.mimeType || 'image/png', size: Math.round(c.data.length * 0.75) }))] });
      this.focus();
    });
    const canBranch = m.id && this.tab.state?.features?.includes('branch') && !this.tab.dead;
    const branch = canBranch ? h('button', { class: 'msg-act', type: 'button', title: 'Open a new tab with the conversation up to here. Your files are not changed.' }, icon('branch', 13), 'Branch') : null;
    branch?.addEventListener('click', async () => {
      branch.disabled = true;
      try {
        await rpc(this.tab.id, { type: 'branch', messageId: m.id });
      } catch (e) {
        toast(e.message, 'error', 7000);
      }
      branch.disabled = false;
    });
    const by = h('div', { class: 'msg-by' }, h('span', null, 'You'), m.timestamp ? h('time', { class: 'msg-time', title: new Date(m.timestamp).toLocaleString() }, clock(m.timestamp)) : null);
    return h('div', { class: 'msg user' }, by, bubble, h('div', { class: 'msg-acts' }, copy, this.tab.dead ? null : edit, branch));
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
    if (this.firstOfTurn(idx)) wrap.prepend(this.byline(m));
    const text = blocks.filter((b) => b.type === 'text' && b.text?.trim()).map((b) => b.text.trim()).join('\n\n');
    const acts = h('div', { class: 'msg-acts' });
    if (text) {
      const copy = h('button', { class: 'msg-act', type: 'button', title: 'Copy reply as Markdown' }, icon('copy', 13), 'Copy');
      copy.addEventListener('click', () => copyButtonFeedback(copy, text));
      acts.append(copy);
    }
    if (m.stopReason === 'error' || m.stopReason === 'aborted' || this.tab.state?.features?.includes('regenerate')) {
      const retry = h('button', { class: 'msg-act retry', type: 'button', title: 'Answer your last message again' }, icon('refresh', 13), 'Retry');
      retry.addEventListener('click', () => this.retry());
      acts.append(retry);
    }
    if (m.timestamp) acts.prepend(h('time', { class: 'msg-time', title: new Date(m.timestamp).toLocaleString() }, clock(m.timestamp)));
    if (acts.childElementCount) wrap.append(acts);
    return wrap;
  }

  /** The first reply after your message carries the agent's name (later steps of the same turn do not). */
  firstOfTurn(idx) {
    const p = this.tab.messages[idx - 1];
    return !p || p.role === 'user' || p.role === '_cmd';
  }

  byline(m) {
    const model = typeof m?.model === 'string' ? m.model : this.tab.model?.id || '';
    return h('div', { class: 'msg-by asst-by' }, logo(14), h('span', null, this.tab.engine === 'builtin' ? 'ORBIX' : 'OMP CLI'), model ? h('span', { class: 'by-model' }, model) : null);
  }

  errorBox(msg) {
    const help = errorHelp(msg);
    const act = help?.act ? h('button', { class: 'btn sm', type: 'button' }, help.act) : null;
    act?.addEventListener('click', () => (help.run === 'model' ? this.pickModel() : help.run()));
    return h('div', { class: 'errbox', role: 'alert' }, icon('alert', 14), h('div', { class: 'err-main' }, h('span', { class: 'err-msg' }, msg), help ? h('span', { class: 'err-hint' }, help.hint) : null, act ? h('div', { class: 'err-acts' }, act) : null));
  }

  /** Retry is offered only on the latest reply, and only while the agent is idle. */
  refreshActs() {
    const t = this.tab;
    const last = t.messages[t.messages.length - 1];
    const can = !t.streaming && !t.dead;
    this.tin.querySelectorAll('.msg-act.retry').forEach((b) => (b.hidden = !can || b.closest('.msg') !== this.els.get(last)));
    this.refreshSummary();
  }

  /** After a finished reply that changed files: what changed, with a way to review it or undo it all. */
  refreshSummary() {
    const t = this.tab;
    this.summaryEl?.remove();
    this.summaryEl = null;
    if (t.streaming || t.dead || t.engine !== 'builtin') return;
    let start = t.messages.length - 1;
    while (start >= 0 && t.messages[start].role !== 'user') start--;
    const files = new Map(); // path -> { add, del, ids }
    let lastAsst = null;
    for (const m of t.messages.slice(start + 1)) {
      if (m.role !== 'assistant') continue;
      lastAsst = m;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type !== 'toolCall' || (b.name !== 'edit' && b.name !== 'write')) continue;
        const r = t.results.get(b.id);
        const d = r?.details;
        if (!d?.undoable || d.undone || r.isError) continue;
        const f = files.get(d.path) || { add: 0, del: 0, ids: [] };
        const c = diffCounts(d);
        if (c) (f.add += c.add), (f.del += c.del);
        f.ids.push(b.id);
        files.set(d.path, f);
      }
    }
    const anchor = lastAsst && this.els.get(lastAsst);
    if (!files.size || !anchor) return;
    const all = [...files.values()];
    const total = { add: all.reduce((n, f) => n + f.add, 0), del: all.reduce((n, f) => n + f.del, 0) };
    const undo = h('button', { class: 'btn sm', type: 'button', title: 'Put every file changed in this reply back as it was' }, icon('refresh', 13), 'Undo all');
    undo.addEventListener('click', () => this.undoAll(all.flatMap((f) => f.ids)));
    const rel = (p) => {
      const a = p.replace(/\\/g, '/');
      const b = t.workspace.replace(/\\/g, '/').replace(/\/+$/, '');
      return a.toLowerCase().startsWith(b.toLowerCase() + '/') ? a.slice(b.length + 1) : p;
    };
    const rows = [...files].slice(0, 6).map(([p, f]) => h('button', { class: 'ts-file', type: 'button', title: p, onclick: () => reviewChanges(t, p) }, h('span', { class: 'ell grow' }, h('bdi', null, rel(p))), statChips(f, 'ts-stat num')));
    if (files.size > 6) rows.push(h('div', { class: 'ts-more' }, `and ${files.size - 6} more`));
    this.summaryEl = h('div', { class: 'turn-sum enter' },
      h('div', { class: 'ts-head' }, icon('pencil', 14), h('b', null, `${files.size} file${files.size === 1 ? '' : 's'} changed`), statChips(total, 'ts-stat num'), h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', type: 'button', onclick: () => reviewChanges(t, null) }, icon('branch', 13), 'Review'), undo),
      h('div', { class: 'ts-files' }, ...rows));
    anchor.after(this.summaryEl);
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
        if (l) l.textContent = 'Thinking';
        return reuse.el;
      }
      return this.thinkBlock(key, renderMarkdown(b.thinking, { onPath }), false);
    }
    if (b.type === 'toolCall') return this.toolCard(b);
    if (b.type === 'image' && b.data) return h('img', { class: 'tool-img', src: `data:${b.mimeType || 'image/png'};base64,${b.data}`, alt: 'Image from the agent' });
    return null;
  }

  thinkBlock(key, body, live) {
    const d = h('details', { class: 'think' + (live ? ' live' : ''), dataset: { key } }, h('summary', null, icon('chevron-right', 12, 'chev'), h('span', { class: 'think-l' }, live ? 'Thinking…' : 'Thinking')), h('div', { class: 'think-b' }, body));
    d.open = this.thinkOpen.has(key);
    return d;
  }

  toolCard(call) {
    const t = this.tab;
    return renderToolCard(t, { id: call.id, name: call.name, arguments: call.arguments, intent: call.intent }, t.tools.get(call.id), t.toolOpen?.get(call.id));
  }

  _renderLive() {
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
      if (this.firstOfTurn(t.messages.length)) this.liveEl.append((this.liveEl._by = this.byline(live)));
      this.tin.insertBefore(this.liveEl, this.pendingEl || null);
      this.liveBlocks = [];
      this.emptyEl?.remove();
    }
    const blocks = live.content || [];
    const onPath = (p) => viewFile(t, p);
    const idx = t.messages.length;
    const showThink = S.ui.showThinking !== false;
    blocks.forEach((b, i) => {
      const prev = this.liveBlocks[i];
      const last = i === blocks.length - 1;
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
          const want = last ? 'Thinking…' : 'Thinking';
          if (l && l.textContent !== want) l.textContent = want;
          cur.el.classList.toggle('live', last);
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
    if (prev?.el?.isConnected) {
      if (el) prev.el.replaceWith(el);
      else prev.el.remove();
      return;
    }
    if (!el) return;
    const after = this.liveBlocks.slice(0, i).reverse().find((x) => x?.el?.isConnected)?.el;
    if (after) after.after(el);
    else if (this.liveEl._by?.isConnected) this.liveEl._by.after(el);
    else this.liveEl.prepend(el);
  }

  /** Tool updates arrive in bursts (streamed command output): redraw each card at most once per frame. */
  updateTool(id) {
    this.toolQ.add(id);
    if (this._tq) return;
    this._tq = requestAnimationFrame(() => {
      this._tq = 0;
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
    this.tin.append(h('div', { class: 'errbox enter' }, icon('alert', 14), h('span', null, `This session ended${d.code != null ? ` (exit code ${d.code})` : ''}.${d.message ? '\n' + d.message : ''}${d.stderr?.length ? '\n\n' + d.stderr.join('\n') : ''}`)));
    this.updateComposer();
    this.refreshActs();
    if (scroll) this.scrollBottom(true);
  }

  scrollBottom(force) {
    if (force) this.stick = true;
    else if (!(this.stick && S.ui.autoScroll !== false)) return;
    if (this._sb) return;
    this._sb = requestAnimationFrame(() => {
      this._sb = 0;
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
    if (t.dead) return;
    const p = this.composer.payload();
    if (!p) {
      // Enter on an empty box does nothing; only the stop button (or Esc) stops the agent.
      if (fromButton && t.streaming) abort(t);
      return;
    }
    this.composer.reset(p.raw);
    const svg = this.sendBtn.querySelector('svg');
    if (svg && !reduced.matches) svg.animate([{ transform: 'none' }, { opacity: 0, transform: 'translateY(-14px)', offset: 0.45 }, { opacity: 0, transform: 'translateY(12px)', offset: 0.46 }, { opacity: 1, transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' });
    this.scrollBottom(true);
    if (t.engine === 'omp' && p.images.length) warnBlockedImages();
    try {
      await sendPrompt(t, p.text || '(see the attached image)', { followUp, images: p.images });
    } catch {
      // The error is in the transcript; give the message back so nothing typed is lost.
      if (!this.composer.hasContent()) this.composer.restore(p);
    }
    this.updateComposer();
  }
}

let blockChecked = false;
function warnBlockedImages() {
  if (blockChecked) return;
  blockChecked = true;
  api.get('/api/omp/config').then((j) => {
    const blocked = j.groups.flatMap((g) => g.items).find((i) => i.key === 'images.blockImages');
    if (blocked?.value === 'true') toast('The OMP setting images.blockImages is on, so the model will not see attached images. Change it in Settings → OMP CLI.', 'info', 9000);
  }).catch(() => {});
}
