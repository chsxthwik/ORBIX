// Client state + the reducer that turns the agent's session events into UI state.
import { api, rpc } from './api.js';
import { baseName, debounce, toast, makeTitle } from './dom.js';

/** Debounce per tab: a call for one tab never cancels the pending call for another. */
const perTab = (fn, ms) => {
  const timers = new Map();
  return (tab) => {
    if (!tab) return;
    clearTimeout(timers.get(tab.id));
    timers.set(tab.id, setTimeout(() => (timers.delete(tab.id), fn(tab)), ms));
  };
};

const listeners = {};
export const on = (ev, fn) => {
  (listeners[ev] ||= new Set()).add(fn);
  return () => listeners[ev].delete(fn);
};
export const emit = (ev, ...a) => {
  for (const fn of listeners[ev] || []) {
    try {
      fn(...a);
    } catch (e) {
      console.error(`listener for ${ev} failed`, e);
    }
  }
};

export const S = {
  env: null,
  ui: {},
  workspaces: [],
  sessions: [],
  tabs: new Map(),
  active: null,
  connected: false,
};

export const activeTab = () => S.tabs.get(S.active) || null;

function keyPath(p) {
  if (!p) return '';
  if (S.env?.backend.kind === 'native') return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  let x = p;
  const m = /^([A-Za-z]):[\\/]*(.*)$/.exec(x);
  if (m) x = `/mnt/${m[1].toLowerCase()}${m[2] ? '/' + m[2].replace(/\\/g, '/') : ''}`;
  else x = x.replace(/\\/g, '/');
  return x.replace(/\/+$/, '') || '/';
}

export class Tab {
  constructor(id, workspace, opts = {}) {
    this.id = id;
    this.workspace = workspace;
    this.resume = opts.resume || null;
    this.title = opts.title || '';
    this.state = null;
    this.models = null;
    this.commands = [];
    this.messages = [];
    this.seen = new Set();
    this.results = new Map(); // toolCallId -> toolResult message
    this.tools = new Map(); // toolCallId -> live run info
    this.live = null;
    this.streaming = false;
    this.compacting = false;
    this.stats = null;
    this.todos = [];
    this.subagents = new Map();
    this.statuses = new Map();
    this.dialogs = [];
    this.attach = []; // composer attachments (images, text files) not sent yet
    this.draft = '';
    this.dead = false;
    this.deadInfo = null;
    this.stderr = [];
    this.console = [];
    this.ready = false;
    this.buffer = [];
    this.unread = false;
    this.turnStartedAt = 0;
    this.retry = null;
  }
  get name() {
    return makeTitle(this.title) || makeTitle(this.firstUserText()) || baseName(this.workspace) || 'Session';
  }
  firstUserText() {
    const m = this.messages.find((x) => x.role === 'user');
    if (!m) return '';
    const t = textOf(m.content).replace(/\s+/g, ' ').trim();
    return t.length > 48 ? t.slice(0, 48) + '…' : t;
  }
  get model() {
    return this.state?.model || null;
  }
}

export const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : '');

const msgKey = (m) => `${m.role}:${m.timestamp ?? ''}:${m.toolCallId ?? ''}:${typeof m.content === 'string' ? m.content.length : Array.isArray(m.content) ? m.content.length : 0}`;

export async function openTab({ workspace, resume, noSession, model, title }) {
  const j = await api.post('/api/proc/start', { workspace, resume, noSession, model });
  const tab = new Tab(j.id, workspace, { resume, title });
  tab.commands = j.commands || [];
  if (j.notice) toast(j.notice, 'info', 10000);
  S.tabs.set(tab.id, tab);
  setActive(tab.id);
  emit('tabs');
  try {
    await attach(tab);
  } catch (e) {
    toast(`Loaded session but could not read its state: ${e.message}`, 'error');
  }
  tab.ready = true;
  for (const ev of tab.buffer.splice(0)) reduce(tab, ev);
  emit('tab:messages', tab, { type: 'reset' });
  emit('tab:state', tab);
  return tab;
}

/** A branch was made from `tab`: open it in a new tab (a message the branch was cut at goes back in its message box). */
async function openBranch(from, ev) {
  if (!ev.path || S.active !== from.id) return; // only the tab you are looking at opens it, so two windows do not both open one
  try {
    const t = await openTab({ workspace: ev.workspace || from.workspace, resume: ev.path, title: ev.title });
    if (ev.text) {
      t.draft = ev.text;
      emit('tab:editor', t);
    }
    toast(`Branch opened: ${ev.title}`, 'ok', 3000);
    loadSessionsSoon();
  } catch (e) {
    toast(`The branch was saved but could not be opened: ${e.message}`, 'error', 8000);
  }
}

/** (Re)load state + history from the process. Safe to call after reconnects. */
export async function attach(tab) {
  const [st, msgs, ui] = await Promise.all([rpc(tab.id, { type: 'get_state' }), rpc(tab.id, { type: 'get_messages' }), api.get(`/api/proc/ui?proc=${encodeURIComponent(tab.id)}`).catch(() => ({ requests: [] }))]);
  applyState(tab, st.data);
  tab.messages = [];
  tab.seen.clear();
  tab.results.clear();
  for (const m of msgs.data?.messages || []) addMessage(tab, m, true);
  tab.streaming = !!st.data.isStreaming;
  // Events missed while disconnected: drop a stale live reply, and bring back questions still waiting for an answer.
  if (!tab.streaming) {
    tab.live = null;
    tab.retry = null;
  }
  const open = ui.requests || [];
  tab.dialogs = [...open];
  emit('tab:dialog', tab);
  // The agent lists its slash commands on request, so ask when none came with the start reply.
  if (!tab.commands.length) rpc(tab.id, { type: 'get_available_commands' }).then((r) => (tab.commands = r.data?.commands || tab.commands)).catch(() => {});
  refreshStats(tab);
  rpc(tab.id, { type: 'get_subagents' })
    .then((r) => {
      for (const s of r.data?.subagents || []) tab.subagents.set(s.id || s.progress?.id, s);
      emit('tab:panel', tab, 'agents');
    })
    .catch(() => {});
}

function applyState(tab, d) {
  tab.state = d;
  tab.streaming = !!d.isStreaming;
  // The agent knows when its turn began; a reload must not restart the timers at 0.
  if (tab.streaming && d.turnStartedAt) tab.turnStartedAt = d.turnStartedAt;
  tab.compacting = !!d.isCompacting;
  tab.todos = d.todoPhases || [];
  tab.queued = d.queuedMessages || { steering: [], followUp: [] };
  if (d.contextUsage) tab.stats = { ...(tab.stats || {}), contextUsage: d.contextUsage };
}

export async function refreshState(tab) {
  try {
    const st = await rpc(tab.id, { type: 'get_state' });
    applyState(tab, st.data);
    emit('tab:state', tab);
    emit('tab:status', tab);
  } catch {}
}

const refreshStats = perTab(async (tab) => {
  if (tab.dead) return;
  try {
    const r = await rpc(tab.id, { type: 'get_session_stats' });
    tab.stats = r.data;
    emit('tab:state', tab);
  } catch {}
}, 600);

export async function loadModels(tab) {
  if (tab.models) return tab.models;
  const r = await rpc(tab.id, { type: 'get_available_models' });
  tab.models = r.data.models || [];
  return tab.models;
}

export function setActive(id) {
  S.active = id;
  const t = S.tabs.get(id);
  if (t) t.unread = false;
  emit('tabs');
  emit('active', t || null);
}

export async function closeTab(id) {
  const t = S.tabs.get(id);
  if (!t) return;
  S.tabs.delete(id);
  const stopping = t.dead ? Promise.resolve() : api.post('/api/proc/stop', { proc: id }).catch(() => {});
  if (S.active === id) {
    const next = [...S.tabs.keys()].pop() || null;
    S.active = next;
  }
  emit('tabs');
  emit('active', activeTab());
  loadSessions();
  await stopping;
}

function addMessage(tab, m, bulk = false) {
  if (m.discard) return false; // a reply the user asked to redo
  const k = msgKey(m);
  if (tab.seen.has(k)) return false;
  tab.seen.add(k);
  if (m.role === 'toolResult' && m.toolCallId) tab.results.set(m.toolCallId, m);
  tab.messages.push(m);
  if (!bulk) emit('tab:messages', tab, { type: 'append', msg: m });
  return true;
}

function dropNotice(tab, text) {
  const msgs = tab.messages;
  for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 4); i--) {
    if (msgs[i].role === '_notice' && msgs[i].text === text) {
      const [m] = msgs.splice(i, 1);
      emit('tab:messages', tab, { type: 'remove', msg: m });
      return;
    }
  }
}

function note(tab, level, text, extra) {
  tab.messages.push({ role: '_notice', level, text, ts: Date.now(), ...extra });
  emit('tab:messages', tab, { type: 'append', msg: tab.messages[tab.messages.length - 1] });
}

export function routeEvent(procId, ev) {
  const tab = S.tabs.get(procId);
  if (!tab) return;
  if (!tab.ready && ev.type !== 'proc_exit' && ev.type !== 'stderr') {
    tab.buffer.push(ev);
    return;
  }
  reduce(tab, ev);
}

function reduce(tab, ev) {
  switch (ev.type) {
    case 'agent_start':
      if (!tab.streaming || !tab.turnStartedAt) tab.turnStartedAt = Date.now();
      tab.streaming = true;
      emit('tab:status', tab);
      if (!tab.state?.model) refreshState(tab); // the first turn picks the model: show it, not "Choose model"
      break;
    case 'agent_end':
      if (ev.isTerminal === false) break;
      tab.streaming = false;
      tab.turnStartedAt = 0;
      tab.live = null;
      emit('tab:live', tab);
      emit('tab:status', tab);
      emit('tab:panel', tab, 'git');
      refreshState(tab);
      refreshStats(tab);
      loadSessionsSoon(); // a new chat appears in the sidebar as soon as its first reply is saved
      if (S.active !== tab.id) tab.unread = true;
      emit('tabs');
      break;
    case 'prompt_result':
      if (ev.agentInvoked === false) {
        tab.streaming = false;
        emit('tab:status', tab);
      }
      break;
    case 'session_rewound':
      attachSoft(tab);
      break;
    case 'branch_created':
      openBranch(tab, ev);
      break;
    case 'message_start':
      if (ev.message?.role === 'assistant') {
        tab.live = { message: ev.message };
        emit('tab:live', tab);
      }
      break;
    case 'message_update':
      tab.live = { message: ev.message };
      emit('tab:live', tab);
      break;
    case 'message_end': {
      const m = ev.message;
      if (!m) break;
      if (m.role === 'assistant') {
        tab.live = null;
        emit('tab:live', tab);
        refreshStats(tab);
        // The agent also reports a failed request as a notice; the reply's own error box says it once.
        if (m.errorMessage) dropNotice(tab, m.errorMessage);
      }
      if (m.role === 'toolResult') {
        addMessage(tab, m);
        emit('tab:tool', tab, m.toolCallId);
      } else addMessage(tab, m);
      break;
    }
    case 'tool_execution_start':
      tab.tools.set(ev.toolCallId, { name: ev.toolName, args: ev.args, intent: ev.intent, status: 'running', startedAt: Date.now() });
      emit('tab:tool', tab, ev.toolCallId);
      break;
    case 'tool_execution_update': {
      const r = tab.tools.get(ev.toolCallId) || { name: ev.toolName, args: ev.args, status: 'running', startedAt: Date.now() };
      r.partial = ev.partialResult;
      tab.tools.set(ev.toolCallId, r);
      emit('tab:tool', tab, ev.toolCallId);
      break;
    }
    case 'tool_execution_end': {
      const r = tab.tools.get(ev.toolCallId) || { name: ev.toolName, startedAt: Date.now() };
      r.status = ev.isError ? 'error' : 'done';
      r.result = ev.result;
      r.endedAt = Date.now();
      tab.tools.set(ev.toolCallId, r);
      emit('tab:tool', tab, ev.toolCallId);
      if (ev.toolName === 'todo' && ev.result?.details?.phases) {
        tab.todos = ev.result.details.phases;
        emit('tab:panel', tab, 'todos');
      }
      if (/^(edit|write|bash)$/.test(ev.toolName)) emit('tab:panel', tab, 'git');
      break;
    }
    case 'command_output':
      tab.messages.push({ role: '_out', text: ev.text || '', ts: Date.now() });
      emit('tab:messages', tab, { type: 'append', msg: tab.messages[tab.messages.length - 1] });
      break;
    case 'notice':
      note(tab, ev.level || 'info', ev.message || '', { source: ev.source });
      break;
    case 'auto_compaction_start':
      tab.compacting = true;
      emit('tab:status', tab);
      note(tab, 'info', 'Compacting context…');
      break;
    case 'auto_compaction_end': {
      tab.compacting = false;
      emit('tab:status', tab);
      if (ev.skipped) {
        note(tab, 'info', 'Nothing to compact yet');
        break;
      }
      const failed = ev.aborted || ev.result === null || !!ev.errorMessage;
      if (!failed) {
        note(tab, 'info', 'Context compacted');
        attachSoft(tab);
      } // otherwise the agent reports its own reason
      break;
    }
    case 'auto_retry_start':
      tab.retry = ev;
      note(tab, 'warn', `Retrying request${ev.attempt ? ` (attempt ${ev.attempt}${ev.maxAttempts ? '/' + ev.maxAttempts : ''})` : ''}${ev.errorMessage ? ': ' + ev.errorMessage : ''}`);
      break;
    case 'auto_retry_end':
      tab.retry = null;
      if (ev.success === false) note(tab, 'error', `Retry failed${ev.finalError ? ': ' + ev.finalError : ''}`);
      break;
    case 'model_changed':
    case 'thinking_level_changed':
      refreshState(tab);
      break;
    case 'session_info_update': {
      const t = ev.title;
      if (t) {
        tab.title = t;
        emit('tabs');
        emit('tab:status', tab);
      }
      break;
    }
    case 'available_commands_update':
      tab.commands = ev.commands || [];
      break;
    case 'extension_ui_request':
      handleUi(tab, ev);
      break;
    case 'subagent_lifecycle': {
      const p = ev.payload || {};
      const prev = tab.subagents.get(p.id) || {};
      tab.subagents.set(p.id, { ...prev, ...p, progress: prev.progress });
      emit('tab:panel', tab, 'agents');
      break;
    }
    case 'subagent_progress': {
      const p = ev.payload || {};
      const id = p.progress?.id;
      if (!id) break;
      const prev = tab.subagents.get(id) || {};
      tab.subagents.set(id, { ...prev, ...p, id, progress: p.progress });
      emit('tab:panel', tab, 'agents');
      break;
    }
    case 'stderr':
      tab.stderr.push(ev.line);
      if (tab.stderr.length > 400) tab.stderr.shift();
      emit('tab:stderr', tab);
      break;
    case 'proc_exit':
      tab.dead = true;
      tab.streaming = false;
      tab.live = null;
      tab.deadInfo = { code: ev.code, message: ev.message, stderr: ev.stderr || [] };
      tab.dialogs = [];
      emit('tab:live', tab);
      emit('tab:status', tab);
      emit('tab:dialog', tab);
      emit('tabs');
      loadSessions();
      break;
    default:
      break;
  }
}

const attachSoft = perTab(async (tab) => {
  try {
    const msgs = await rpc(tab.id, { type: 'get_messages' });
    tab.messages = [];
    tab.seen.clear();
    tab.results.clear();
    for (const m of msgs.data?.messages || []) addMessage(tab, m, true);
    emit('tab:messages', tab, { type: 'reset' });
  } catch {}
}, 800);

function handleUi(tab, ev) {
  switch (ev.method) {
    case 'select':
      tab.dialogs.push(ev);
      emit('tab:dialog', tab);
      if (S.active !== tab.id) {
        tab.unread = true;
        emit('tabs');
      }
      break;
    case 'cancel':
      tab.dialogs = tab.dialogs.filter((d) => d.id !== ev.targetId);
      emit('tab:dialog', tab);
      break;
    case 'setStatus': {
      const key = ev.statusKey ?? ev.key ?? 'status';
      const text = ev.statusText ?? ev.text;
      if (text) tab.statuses.set(key, text);
      else tab.statuses.delete(key);
      emit('tab:state', tab);
      break;
    }
    default:
      break;
  }
}

export async function replyUi(tab, dlg, payload) {
  tab.dialogs = tab.dialogs.filter((d) => d !== dlg);
  emit('tab:dialog', tab);
  try {
    await api.post('/api/reply', { proc: tab.id, msg: { type: 'extension_ui_response', id: dlg.id, ...payload } });
  } catch (e) {
    toast(e.message, 'error');
  }
}

/** Send a message (or steer / queue it while the agent works). `images`: [{ type: 'image', data, mimeType }]. */
export async function sendPrompt(tab, text, { followUp = false, images = [] } = {}) {
  const cmd = { type: 'prompt', message: text };
  if (images.length) cmd.images = images;
  if (tab.streaming) cmd.streamingBehavior = followUp ? 'followUp' : 'steer';
  const isSlash = text.trim().startsWith('/');
  if (isSlash) {
    tab.messages.push({ role: '_cmd', text: text.trim(), ts: Date.now() });
    emit('tab:messages', tab, { type: 'append', msg: tab.messages[tab.messages.length - 1] });
  }
  try {
    const r = await rpc(tab.id, cmd);
    if (r.data?.agentInvoked === false) tab.streaming = false;
    if (tab.streaming) refreshState(tab);
    return r;
  } catch (e) {
    note(tab, 'error', e.message);
    throw e;
  }
}

export async function abort(tab) {
  try {
    await rpc(tab.id, { type: 'abort' });
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function setModel(tab, m) {
  await rpc(tab.id, { type: 'set_model', provider: m.provider, modelId: m.id });
  await refreshState(tab);
}

export async function setThinking(tab, level) {
  await rpc(tab.id, { type: 'set_thinking_level', level });
  await refreshState(tab);
}

export async function renameSession(tab, name) {
  await rpc(tab.id, { type: 'set_session_name', name });
  tab.title = name;
  emit('tabs');
  emit('tab:status', tab);
}

export async function loadEnv() {
  const j = await api.get('/api/state');
  S.env = { app: j.app, backend: j.backend };
  S.ui = j.ui;
  S.workspaces = j.workspaces;
  await loadEngine();
  return j;
}

const loadSessionsSoon = debounce(() => loadSessions(), 400);

export async function loadSessions() {
  try {
    const j = await api.get('/api/sessions');
    S.sessions = j.sessions;
    emit('sessions');
  } catch (e) {
    console.warn('sessions', e.message);
  }
}

export async function savePrefs(patch) {
  Object.assign(S.ui, patch);
  emit('prefs', patch);
  try {
    await api.post('/api/prefs', { ui: patch });
  } catch {}
}

/** Reconcile after SSE (re)connect. */
export async function onHello(procs, fresh = new Set()) {
  const alive = new Set(procs.map((p) => p.id));
  for (const t of S.tabs.values()) {
    if (!alive.has(t.id) && !t.dead) {
      reduce(t, { type: 'proc_exit', code: null, message: 'The session process is no longer running.', stderr: [] });
    } else if (alive.has(t.id) && t.ready && !fresh.has(t.id)) {
      attach(t).then(() => {
        emit('tab:messages', t, { type: 'reset' });
        emit('tab:state', t);
      });
    }
  }
}

export function onProcs(procs) {
  for (const p of procs) {
    const t = S.tabs.get(p.id);
    if (t && t.streaming !== p.streaming && t.ready) {
      t.streaming = p.streaming;
      if (p.streaming && !t.turnStartedAt) t.turnStartedAt = p.turnStartedAt || Date.now();
      emit('tab:status', t);
    }
  }
}

/** True when the agent has at least one AI provider it can use. */
export const engineReady = () => !!S.engine?.providers?.some((p) => p.configured);

export async function loadEngine() {
  try {
    S.engine = (await api.get('/api/engine')).engine;
  } catch {
    S.engine = S.engine || null;
  }
  emit('engine');
  return S.engine;
}

/** The open tab (if any) that belongs to a session-list entry: matches any file of its resume chain. */
export function tabForSession(s) {
  const chain = new Set([s.path, ...(s.chain || [])]);
  const ids = new Set([s.id, ...(s.chainIds || [])]);
  return [...S.tabs.values()].find((t) => !t.dead && ((t.resume && chain.has(t.resume)) || (t.state?.sessionId && ids.has(t.state.sessionId)))) || null;
}

/** Open tabs of a project that the session list does not have yet (a new conversation is listed once it is saved). */
export function unlistedTabs(g) {
  const listed = new Set(g.sessions.map(tabForSession).filter(Boolean));
  return [...S.tabs.values()].filter((t) => !t.dead && t.workspace && keyPath(t.workspace) === g.key && !listed.has(t));
}

export function groupSessions() {
  // Projects = saved workspaces ∪ any cwd seen in session history.
  const groups = new Map();
  for (const w of S.workspaces) groups.set(keyPath(w.path), { key: keyPath(w.path), path: w.path, name: w.name, saved: true, id: w.id, sessions: [] });
  for (const s of S.sessions) {
    let g = groups.get(s.cwdKey);
    if (!g) {
      g = { key: s.cwdKey, path: s.cwdDisplay || s.cwd, name: baseName(s.cwdDisplay || s.cwd), saved: false, sessions: [] };
      groups.set(s.cwdKey, g);
    }
    g.sessions.push(s);
  }
  const arr = [...groups.values()];
  for (const g of arr) g.latest = g.sessions[0]?.mtime || 0;
  arr.sort((a, b) => (b.latest || 0) - (a.latest || 0) || a.name.localeCompare(b.name));
  return arr;
}
