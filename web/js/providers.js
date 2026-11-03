// Providers & sign-in: OAuth subscriptions, API keys, accounts and plan usage.
// Talks to the server's private auth process, so it works with no session open.
import { h, icon, replace, toast, spinner, copyText, debounce, skeleton } from './dom.js';
import { api } from './api.js';
import { S, on, emit } from './store.js';
import { modal, btn } from './dialogs.js';

// Shown first, in this order, when the user has not connected them yet.
const FEATURED = ['anthropic', 'openai-codex', 'github-copilot', 'google-gemini-cli', 'google-antigravity', 'cursor', 'xai-oauth', 'openrouter', 'deepseek', 'zai-coding-plan', 'kimi-code', 'ollama'];

// Providers OMP told us need an API key (remembered so the row leads with "Add API key").
const KEY_KIND = 'orbix.keyProviders';
const keyKinds = new Set(readLs(KEY_KIND, []));
function readLs(k, d) {
  try {
    return JSON.parse(localStorage.getItem(k) || 'null') ?? d;
  } catch {
    return d;
  }
}
const rememberKeyKind = (id) => {
  keyKinds.add(id);
  try {
    localStorage.setItem(KEY_KIND, JSON.stringify([...keyKinds]));
  } catch {}
};

const AUTH = { login: null, requests: [], progress: '', providers: null, flow: null };

/** Server pushes `{ g: 'auth', e }` frames for the running sign-in. */
export function onAuthEvent(e) {
  if (e.type === 'login_start') {
    AUTH.login = { provider: e.provider };
    AUTH.requests = [];
    AUTH.progress = '';
  } else if (e.type === 'request') AUTH.requests.push(e.request);
  else if (e.type === 'cancel') AUTH.requests = AUTH.requests.filter((r) => r.id !== e.id);
  else if (e.type === 'progress') AUTH.progress = e.message;
  else if (e.type === 'login_end') {
    AUTH.login = null;
    AUTH.requests = [];
    const name = providerName(e.provider);
    if (e.ok) {
      toast(`${name}: signed in`, 'ok');
      for (const t of S.tabs.values()) t.models = null;
    } else if (e.fallback === 'key') {
      rememberKeyKind(e.provider);
      AUTH.flow?.close('__end');
      emit('auth:needs-key', e.provider);
    } else if (e.fallback === 'terminal') {
      AUTH.flow?.close('__end');
      terminalSignIn(e.provider);
    } else if (e.error && e.error !== 'Cancelled') toast(`${name}: ${e.error}`, 'error', 9000);
    AUTH.providers = null;
  }
  syncFlow();
  emit('auth');
}

export function onAuthHello(status) {
  AUTH.login = status?.login || null;
  AUTH.requests = status?.requests || [];
  syncFlow();
  emit('auth');
}

const providerName = (id) => AUTH.providers?.find((p) => p.id === id)?.name || id;

/** Sign-ins that ask setup questions run as `omp login <id>` in a console window. */
function terminalSignIn(id) {
  const m = modal({
    title: `Sign in to ${providerName(id)}`,
    body: h('div', null,
      h('p', null, `${providerName(id)} asks a few setup questions first, which only OMP's terminal sign-in can do.`),
      h('p', { class: 'muted small' }, 'A console window opens running ', h('code', null, `omp login ${id}`), '. Follow it, close it when it says Done, and this list refreshes when you come back.')),
    actions: [
      btn('Cancel', () => m.close()),
      btn('Open terminal sign-in', () => {
        openTerminalLogin(id);
        m.close();
      }, 'primary'),
    ],
  });
}

function openTerminalLogin(id) {
  api.post('/api/auth/terminal', { provider: id }).then(
    () => {
      // Refresh once the user switches back from the console window.
      addEventListener('focus', () => ((AUTH.providers = null), emit('auth')), { once: true });
    },
    (e) => toast(e.message, 'error'),
  );
}

function syncFlow() {
  if (!AUTH.login) {
    AUTH.flow?.close('__end');
    AUTH.flow = null;
    return;
  }
  if (!AUTH.flow) {
    const body = h('div');
    AUTH.flow = modal({
      title: `Sign in to ${providerName(AUTH.login.provider)}`,
      body,
      actions: [btn('Cancel sign-in', () => AUTH.flow?.close())],
      onClose: (v) => {
        AUTH.flow = null;
        if (v !== '__end' && AUTH.login) api.post('/api/auth/cancel').catch(() => {});
      },
    });
    AUTH.flow.bodyEl = body;
  }
  drawFlow(AUTH.flow.bodyEl);
}

function drawFlow(el) {
  const url = AUTH.requests.find((r) => r.method === 'open_url');
  const ask = AUTH.requests.find((r) => r.method !== 'open_url');
  const parts = [];
  if (url) {
    parts.push(
      h('div', { class: 'flow-step' }, icon('external', 16), h('div', { class: 'grow' }, h('b', null, 'Your browser opened the sign-in page.'), h('div', { class: 'muted small' }, 'Approve access there. ', url.instructions || ''))),
      h('div', { class: 'row' }, h('code', { class: 'url-box grow ell', title: url.url }, url.url), btn('Open again', () => api.post('/api/open-url', { url: url.url }).catch((e) => toast(e.message, 'error')), 'sm'), btn('Copy', () => copyText(url.url), 'sm')),
    );
  }
  if (ask) parts.push(askForm(ask));
  if (!url && !ask) parts.push(h('div', { class: 'flow-step' }, spinner(16), h('span', null, AUTH.progress || 'Starting sign-in…')));
  else if (AUTH.progress) parts.push(h('p', { class: 'muted small' }, AUTH.progress));
  if (url && !ask) parts.push(h('div', { class: 'flow-step muted small' }, spinner(14), 'Waiting for the provider to confirm…'));
  replace(el, parts);
  el.querySelector('input,select')?.focus();
}

function askForm(req) {
  const send = (payload) => {
    AUTH.requests = AUTH.requests.filter((r) => r !== req);
    api.post('/api/auth/reply', { msg: { type: 'extension_ui_response', id: req.id, ...payload } }).catch((e) => toast(e.message, 'error'));
    drawFlow(AUTH.flow.bodyEl);
  };
  if (req.method === 'select') {
    const opts = (req.options || []).map((o) => (typeof o === 'string' ? { label: o, value: o } : { label: o.label ?? String(o.value), value: o.value ?? o.label }));
    return h('div', { class: 'field' }, h('span', null, req.title || req.message || 'Choose'), h('div', { class: 'list' }, opts.map((o) => h('button', { class: 'list-it', type: 'button', onclick: () => send({ value: o.value }) }, h('span', { class: 'grow' }, o.label)))));
  }
  if (req.method === 'confirm') {
    return h('div', { class: 'stack' }, h('p', null, req.message || req.title), h('div', { class: 'row' }, btn('No', () => send({ confirmed: false })), btn('Yes', () => send({ confirmed: true }), 'primary')));
  }
  const secret = /key|token|secret|password/i.test(`${req.title || ''} ${req.message || ''}`);
  const inp = h('input', { type: secret ? 'password' : 'text', placeholder: req.placeholder || '', autocomplete: 'off', spellcheck: 'false', class: 'grow' });
  const ok = () => inp.value.trim() && send({ value: inp.value.trim() });
  inp.addEventListener('keydown', (e) => e.key === 'Enter' && ok());
  return h('label', { class: 'field' }, h('span', null, req.title || req.message || 'Paste the code from the browser'), h('div', { class: 'row' }, inp, btn('Continue', ok, 'primary')));
}

async function startLogin(id) {
  try {
    await api.post('/api/auth/login', { provider: id });
  } catch (e) {
    toast(e.message, 'error');
  }
}

export function providersView(el) {
  const q = h('input', { type: 'search', placeholder: 'Search providers…', 'aria-label': 'Search providers', class: 'grow' });
  let filter = 'all';
  const filters = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Show' });
  const list = h('div', { class: 'prov-list' }, skeleton(5, 'pad'));
  const usageEl = h('div');
  const open = new Map(); // provider id -> 'key' | 'accounts'
  const accounts = new Map();

  const drawFilters = () =>
    replace(filters, [['all', 'All'], ['connected', 'Connected']].map(([k, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(k === filter), onclick: () => ((filter = k), drawFilters(), draw()) }, l)));

  const load = async (force) => {
    if (force) AUTH.providers = null;
    try {
      if (!AUTH.providers) AUTH.providers = (await api.get('/api/auth/providers')).providers;
      draw();
    } catch (e) {
      replace(list, h('div', { class: 'empty' }, h('div', { class: 'err-text' }, e.message), btn('Try again', () => load(true), 'sm')));
    }
  };

  const row = (p) => {
    const mode = open.get(p.id);
    const busy = AUTH.login?.provider === p.id;
    const isKey = keyKinds.has(p.id);
    const toggle = (m) => {
      open.get(p.id) === m ? open.delete(p.id) : open.set(p.id, m);
      if (m === 'accounts' && open.get(p.id)) loadAccounts(p.id);
      draw();
    };
    const actions = p.authenticated
      ? [btn('Accounts', () => toggle('accounts'), 'sm' + (mode === 'accounts' ? ' on' : ''))]
      : isKey
        ? [btn('Add API key', () => toggle('key'), 'sm primary'), btn('Sign in', () => startLogin(p.id), 'sm')]
        : [btn(busy ? h('span', { class: 'row' }, spinner(12), 'Signing in…') : 'Sign in', () => startLogin(p.id), 'sm primary'), btn('API key', () => toggle('key'), 'sm' + (mode === 'key' ? ' on' : ''))];
    return h('div', { class: 'prov' + (p.authenticated ? ' ok' : '') },
      h('div', { class: 'prov-main' },
        h('span', { class: 'dot' + (p.authenticated ? ' ok' : ''), title: p.authenticated ? 'Connected' : 'Not connected' }),
        h('div', { class: 'prov-name' }, h('div', null, p.name), h('div', { class: 'muted small' }, p.id, p.authenticated ? ' · connected' : '')),
        h('div', { class: 'prov-act' }, actions)),
      mode === 'key' ? keyForm(p) : null,
      mode === 'accounts' ? accountsBox(p) : null);
  };

  const keyForm = (p) => {
    const inp = h('input', { type: 'password', placeholder: `${p.name} API key`, autocomplete: 'off', spellcheck: 'false', class: 'grow' });
    const save = async (b) => {
      b.disabled = true;
      try {
        await api.post('/api/auth/key', { provider: p.id, key: inp.value });
        toast(`${p.name}: API key saved`, 'ok');
        open.delete(p.id);
        for (const t of S.tabs.values()) t.models = null;
        await load(true);
      } catch (e) {
        toast(e.message, 'error');
        b.disabled = false;
      }
    };
    const saveBtn = btn('Save key', (e) => save(e.currentTarget), 'primary');
    inp.addEventListener('keydown', (e) => e.key === 'Enter' && save(saveBtn));
    setTimeout(() => inp.focus(), 0);
    return h('div', { class: 'prov-more' },
      h('div', { class: 'row' }, inp, saveBtn),
      h('div', { class: 'muted small' }, 'Stored by OMP, the same as ', h('code', null, 'omp login'), '. Needs a base URL or other details? ',
        h('button', { class: 'link', type: 'button', onclick: () => api.post('/api/auth/terminal', { provider: p.id }).then(() => toast('Opened a terminal running omp login', 'ok')).catch((er) => toast(er.message, 'error')) }, 'Sign in from a terminal'), '.'));
  };

  const loadAccounts = async (id) => {
    accounts.set(id, null);
    try {
      accounts.set(id, (await api.get(`/api/auth/accounts?provider=${encodeURIComponent(id)}`)).accounts);
    } catch (e) {
      accounts.set(id, { error: e.message });
    }
    draw();
  };

  const accountsBox = (p) => {
    const acc = accounts.get(p.id);
    if (acc == null) return h('div', { class: 'prov-more' }, spinner());
    if (acc.error) return h('div', { class: 'prov-more err-text small' }, acc.error);
    return h('div', { class: 'prov-more' },
      acc.length ? acc.map((a) => h('div', { class: 'acct' },
        h('span', { class: 'tag' }, a.type === 'oauth' ? 'OAuth' : a.type === 'api_key' ? 'API key' : a.type || 'Credential'),
        h('div', { class: 'grow' }, h('div', null, a.label || `#${a.credentialId}`), a.detail ? h('div', { class: 'muted small' }, a.detail) : null),
        a.active ? h('span', { class: 'tag ok' }, 'Active') : null,
        btn('Sign out', async (e) => {
          e.currentTarget.disabled = true;
          try {
            await api.post('/api/auth/logout', { provider: p.id, credentialId: a.credentialId });
            toast(`Signed out of ${p.name}`, 'ok');
            for (const t of S.tabs.values()) t.models = null;
            open.delete(p.id);
            await load(true);
          } catch (er) {
            toast(er.message, 'error');
          }
        }, 'sm danger')))
        : h('div', { class: 'muted small' }, 'Connected through an environment variable or external config; nothing to sign out here.'),
      h('div', { class: 'row' }, btn('Add another account', () => startLogin(p.id), 'sm'), btn('Replace API key', () => (open.set(p.id, 'key'), draw()), 'sm')));
  };

  const draw = () => {
    const all = AUTH.providers;
    if (!all) return;
    const f = q.value.trim().toLowerCase();
    const match = (p) => !f || `${p.name} ${p.id}`.toLowerCase().includes(f);
    const connected = all.filter((p) => p.authenticated && match(p));
    const rest = all.filter((p) => !p.authenticated && match(p));
    const featured = FEATURED.map((id) => rest.find((p) => p.id === id)).filter(Boolean);
    const others = rest.filter((p) => !featured.includes(p)).sort((a, b) => a.name.localeCompare(b.name));
    const sec = (title, arr) => (arr.length ? [h('div', { class: 'list-h' }, `${title} · ${arr.length}`), ...arr.map(row)] : []);
    replace(list,
      sec('Connected', connected),
      filter === 'all' ? [...sec(f ? 'Matches' : 'Popular', featured), ...sec(f ? 'More matches' : 'All providers', others)] : [],
      !connected.length && filter === 'connected' ? h('div', { class: 'empty' }, 'No provider connected yet.') : null,
      f && !connected.length && !rest.length ? h('div', { class: 'empty' }, `No provider matches “${q.value}”.`) : null);
  };

  const loadUsage = async () => {
    replace(usageEl, h('div', { class: 'muted small row' }, spinner(12), 'Loading plan usage…'));
    try {
      const { reports } = await api.get('/api/auth/usage');
      replace(usageEl, reports.length ? usageView(reports) : null);
    } catch {
      replace(usageEl, null);
    }
  };

  q.addEventListener('input', debounce(draw, 80));
  drawFilters();
  // Live updates while this view is on screen; listeners drop themselves once it is closed.
  const subs = [
    on('auth', () => (el.isConnected ? (AUTH.providers ? draw() : load()) : drop())),
    on('auth:needs-key', (id) => {
      if (!el.isConnected) return drop();
      open.set(id, 'key');
      toast(`${providerName(id)} uses an API key. Paste it below.`, 'info', 6000);
      load(true).then(() => el.querySelector('.prov-more input')?.scrollIntoView({ block: 'center' }));
    }),
  ];
  const drop = () => subs.splice(0).forEach((u) => u());

  replace(el,
    h('p', { class: 'set-note' }, 'Sign-ins for the OMP CLI: a subscription or an API key. OMP stores them itself and shares them with the terminal CLI.'),
    usageEl,
    h('div', { class: 'row' }, q, filters, h('button', { class: 'ibtn', type: 'button', title: 'Reload', 'aria-label': 'Reload providers', onclick: () => load(true) }, icon('refresh', 15))),
    list);
  load();
  loadUsage();
}

function usageView(reports) {
  const rows = [];
  for (const r of reports) {
    for (const l of r.limits || []) {
      const frac = l.amount?.usedFraction ?? (l.amount?.unit === 'percent' ? (l.amount.used || 0) / 100 : null);
      if (frac == null) continue;
      const pct = Math.round(frac * 100);
      const reset = l.window?.resetsAt ? `resets ${new Date(l.window.resetsAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '';
      rows.push(h('div', { class: 'usage-row', title: `${r.provider} · ${l.label}${reset ? ' · ' + reset : ''}` },
        h('span', { class: 'u-prov' }, r.provider),
        h('span', { class: 'u-lab' }, `${l.label}${l.window?.label ? ' · ' + l.window.label : ''}`),
        h('span', { class: 'meter' + (pct > 90 ? ' crit' : pct > 70 ? ' hot' : '') }, h('i', { style: { width: Math.min(100, pct) + '%' } })),
        h('span', { class: 'u-pct num' }, `${pct}%`)));
    }
  }
  if (!rows.length) return null;
  return h('details', { class: 'fold usage' }, h('summary', null, icon('chevron-right', 12, 'chev'), `Plan usage · ${reports.length} account${reports.length === 1 ? '' : 's'}`), h('div', { class: 'usage-list' }, rows));
}
