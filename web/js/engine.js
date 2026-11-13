// "Providers": add a key (or a local server) for the ORBIX agent. Each provider is checked before it is saved.
import { h, icon, toast, replace, spinner, skeleton, errorState } from './dom.js';
import { api } from './api.js';
import { loadEngine } from './store.js';
import { confirmDialog } from './dialogs.js';
import { brandMark } from './brands.js';

const openLink = (url) => api.post('/api/open-url', { url }).catch((e) => toast(e.message, 'error'));

let signIn = null; // {state, url, timer, provider} while a sign-in is waiting for the browser
// How each sign-in is offered, and what the user should know before choosing it.
const SIGN_IN = {
  openrouter: { name: 'OpenRouter', label: 'Sign in with OpenRouter', note: 'Or paste an API key below.' },
  chatgpt: { name: 'ChatGPT', label: 'Sign in with ChatGPT', note: 'It uses the Codex CLI sign-in, which OpenAI can change at any time. The sign-in renews itself.' },
  opencode: { name: 'OpenCode', site: 'opencode.ai', label: 'Sign in with OpenCode', note: 'You confirm a short code on opencode.ai, and paid models are billed to your OpenCode account. It uses the opencode CLI sign-in, which OpenCode can change at any time; an oc_sk_ key below always works. Free models work only inside OpenCode itself.' },
  xai: { name: 'xAI', site: 'x.ai', label: 'Sign in with xAI', note: 'You confirm a short code on x.ai, and nothing else needs to be installed. It uses the Grok CLI sign-in, which xAI can change at any time. The sign-in renews itself.' },
};
// One card per maker. Where a maker offers two ways in, both sit inside its card, each with its own sign-in or key.
const FAMILY = {
  openai: { name: 'OpenAI', note: 'GPT models on your ChatGPT plan or with an API key.', members: ['chatgpt', 'openai'] },
  opencode: { name: 'OpenCode', note: 'Pay as you go with Zen, or your OpenCode Go plan.', members: ['opencode', 'opencode-go'] },
};
const WAY = {
  chatgpt: ['ChatGPT plan', 'Uses your paid ChatGPT plan and its usage limits. No API key or credits are needed.'],
  openai: ['API key', 'Pay per token through the OpenAI Platform.'],
  opencode: ['Zen', 'Claude, GPT, Gemini and open models, paid as you go.'],
  'opencode-go': ['Go plan', 'Open models on your OpenCode Go subscription. Paste your Go API key to connect.'],
};
const familyOf = (id) => Object.keys(FAMILY).find((f) => FAMILY[f].members.includes(id)) || id;
// Connected, with the model count of the ways that work; a sign-in the provider ended asks for a new one instead.
const statusOf = (ps) => {
  const on = ps.filter((p) => p.configured && !p.signInError);
  if (!on.length && !ps.some((p) => p.configured)) return null;
  if (!on.length) return h('span', { class: 'pv-status warn' }, h('span', { class: 'dot warn' }), 'Sign in again');
  const n = on.reduce((sum, p) => sum + (p.models ?? 0), 0);
  return h('span', { class: 'pv-status on' }, h('span', { class: 'dot ok' }), on.some((p) => p.models != null) ? `Connected · ${n} model${n === 1 ? '' : 's'}` : 'Connected');
};
// "Renewing the ChatGPT sign-in: Your session has ended. Please log in again." reads "Your session has ended. Sign in again."
const signInEnded = (err) => {
  const why = err.replace(/^Renewing the .+? sign-in:\s*/i, '').replace(/\s*Please (log|sign) in again\.?$/i, '').replace(/\.$/, '');
  return / /.test(why) ? `${why}. Sign in again.` : `The sign-in could not be renewed${why ? ` (${why})` : ''}. Sign in again.`;
};
let view = null; // the open settings screen, so a sign-in that finishes later updates whatever is showing now
let openId = null; // the provider row showing its form; one at a time keeps a long list short
const redraw = () => view?.root.isConnected && view.draw();

export async function renderEngineSettings(root) {
  replace(root, skeleton(5, 'pad'));
  let engine;
  try {
    engine = (await api.get('/api/engine')).engine;
  } catch (e) {
    return replace(root, errorState(e.message, { title: 'Couldn’t load the providers.', retry: () => renderEngineSettings(root) }));
  }
  let query = '';
  const list = h('div', { class: 'pv-list' });
  const search = h('input', { type: 'search', class: 'pv-search', placeholder: 'Search providers', 'aria-label': 'Search providers', spellcheck: 'false', autocomplete: 'off' });
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    draw();
  });

  const refresh = async (next) => {
    if (next) engine = next;
    await loadEngine().catch(() => {});
    if (root.isConnected) draw();
  };
  view = { root, draw: () => draw(), refresh };

  function stopSignIn() {
    if (signIn?.timer) clearInterval(signIn.timer);
    signIn = null;
  }

  async function startSignIn(provider) {
    stopSignIn();
    try {
      const r = await api.post('/api/engine/oauth/start', { provider });
      const started = Date.now();
      const name = SIGN_IN[provider]?.name || provider;
      signIn = { state: r.state, url: r.url, provider, userCode: r.userCode || '' };
      toast(r.userCode ? `Confirm the code ${r.userCode} in your browser.` : 'Complete the sign-in in your browser.', 'info', 5000);
      signIn.timer = setInterval(async () => {
        if (!signIn || Date.now() - started > 10.5 * 60 * 1000) {
          stopSignIn();
          redraw();
          return;
        }
        try {
          const s = await api.get('/api/engine/oauth/status?state=' + encodeURIComponent(r.state));
          if (s.status === 'done') {
            stopSignIn();
            toast(`${name}: signed in${Number.isFinite(s.models) ? ` (${s.models} model${s.models === 1 ? '' : 's'})` : ''}`, 'ok', 4000);
            if (view?.root.isConnected) await view.refresh(s.engine);
            else await loadEngine().catch(() => {});
          } else if (s.status === 'error' || s.status === 'expired' || s.status === 'unknown') {
            stopSignIn();
            if (s.error) toast(s.error, 'error', 8000);
            redraw();
          }
        } catch {}
      }, 1500);
      draw();
    } catch (e) {
      toast(e.message, 'error', 8000);
    }
  }

  // The sign-in, key and buttons for one provider.
  function connectForm(p) {
    const local = p.keyOptional && !p.editableUrl;
    const key = local || p.signInOnly
      ? null
      : h('input', { type: 'password', class: 'pv-key', placeholder: p.hasKey ? 'Key saved. Paste a new one to replace it.' : p.keyOptional ? 'API key (optional)' : 'Paste your API key', autocomplete: 'off', spellcheck: 'false', 'aria-label': `${p.name} API key` });
    const url = p.editableUrl ? h('input', { type: 'text', class: 'pv-url', placeholder: 'http://localhost:8000/v1', value: p.baseUrl || '', spellcheck: 'false', 'aria-label': 'Server address' }) : null;
    const save = p.signInOnly && !p.configured ? null : h('button', { class: 'btn sm', type: 'button' }, local || p.signInOnly ? (p.configured ? 'Check again' : 'Connect') : 'Check & save');
    // The button turns primary once there is something to check.
    for (const el of [key, url]) el?.addEventListener('input', () => save?.classList.toggle('primary', !!(key?.value.trim() || (url && url.value.trim() !== (p.baseUrl || '')))));
    save?.addEventListener('click', async () => {
      save.disabled = true;
      const label = save.textContent;
      save.textContent = 'Checking…';
      try {
        const r = await api.post('/api/engine/provider', { id: p.id, key: key?.value || '', baseUrl: url?.value || '' });
        toast(`${p.name}: connected (${r.models} model${r.models === 1 ? '' : 's'})`, 'ok', 3500);
        await refresh(r.engine);
      } catch (e) {
        toast(e.message, 'error', 8000);
        save.disabled = false;
        save.textContent = label;
      }
    });
    for (const el of [key, url]) el?.addEventListener('keydown', (e) => e.key === 'Enter' && save?.click());

    const remove = p.configured
      ? h('button', { class: 'btn sm', type: 'button', onclick: async () => {
          if (!(await confirmDialog('Remove provider', `Remove ${p.name}?${p.hasKey ? ' Its saved key is deleted from this PC.' : ''}`, { ok: 'Remove', danger: true }))) return;
          try {
            await refresh((await api.post('/api/engine/provider/clear', { id: p.id })).engine);
          } catch (e) {
            toast(e.message, 'error');
          }
        } }, 'Remove')
      : null;

    let oauthRow = null;
    if (p.oauth) {
      if (signIn && signIn.provider === p.id) {
        const cancel = h('button', { class: 'link', type: 'button', onclick: () => {
          api.post('/api/engine/oauth/cancel', { state: signIn?.state }).catch(() => {});
          stopSignIn();
          draw();
        } }, 'Cancel');
        const again = h('button', { class: 'link', type: 'button', onclick: () => openLink(signIn.url) }, 'Open again');
        if (signIn.userCode) {
          // Device code: the code to confirm, large enough to compare at a glance.
          const code = signIn.userCode;
          oauthRow = h('div', { class: 'pv-signin' },
            h('div', { class: 'pv-signin-h' }, spinner(12), h('span', null, `Confirm this code on ${SIGN_IN[p.id]?.site || 'the sign-in page'}, then come back here.`)),
            h('div', { class: 'pv-code-row' },
              h('code', { class: 'pv-code', 'aria-label': 'Sign-in code' }, code),
              h('button', { class: 'btn sm', type: 'button', onclick: (e) => navigator.clipboard?.writeText(code).then(() => { e.currentTarget.textContent = 'Copied'; }, () => toast('Copy failed', 'error')) }, 'Copy code')),
            h('div', { class: 'pv-signin-acts' }, again, cancel));
        } else {
          // Browser sign-in: if the browser cannot reach ORBIX, its address can be pasted here instead.
          const paste = h('input', { type: 'text', class: 'pv-paste', placeholder: 'http://localhost:1455/auth/callback?code=…', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Address from the browser' });
          const finish = h('button', { class: 'btn sm', type: 'button', onclick: async () => {
            if (!paste.value.trim()) return paste.focus();
            finish.disabled = true;
            try {
              const r = await api.post('/api/engine/oauth/paste', { state: signIn?.state, url: paste.value });
              stopSignIn();
              toast(`${SIGN_IN[p.id]?.name || p.name}: signed in${Number.isFinite(r.models) ? ` (${r.models} model${r.models === 1 ? '' : 's'})` : ''}`, 'ok', 4000);
              await refresh(r.engine);
            } catch (e) {
              toast(e.message, 'error', 8000);
              finish.disabled = false;
            }
          } }, 'Finish');
          paste.addEventListener('keydown', (e) => e.key === 'Enter' && finish.click());
          oauthRow = h('div', { class: 'pv-signin' },
            h('div', { class: 'pv-signin-h' }, spinner(12), h('span', null, 'Finish signing in in your browser.'), h('span', { class: 'grow' }), again, cancel),
            h('details', { class: 'pv-paste-d' },
              h('summary', null, 'The browser showed an error page?'),
              h('p', { class: 'muted small' }, 'Copy the full address from its address bar and paste it here.'),
              h('div', { class: 'pv-form' }, paste, finish)));
        }
      } else {
        const s = SIGN_IN[p.id] || { label: `Sign in with ${p.name}`, note: '' };
        oauthRow = h('div', { class: 'pv-oauth' },
          h('button', { class: 'btn sm', type: 'button', onclick: () => startSignIn(p.id) }, p.via === 'oauth' ? 'Sign in again' : s.label),
          p.signInError ? h('span', { class: 'pv-oauth-err', title: p.signInError }, signInEnded(p.signInError)) : h('span', { class: 'muted small pv-oauth-note' }, s.note));
      }
    }

    const link = p.keyUrl ? h('button', { class: 'link', type: 'button', title: p.keyUrl, onclick: () => openLink(p.keyUrl) }, local ? 'Download' : 'Get a key', icon('external', 12)) : null;
    return [link ? h('div', { class: 'pv-note' }, link) : null, oauthRow, h('div', { class: 'pv-form' }, url, key, save, remove)];
  }

  // One card per maker: its name and status in the head; inside, each way in with its own form.
  function card({ id, members }) {
    const fam = FAMILY[id];
    const lead = members[0];
    const configured = members.some((p) => p.configured && !p.signInError);
    const status = statusOf(members);
    const open = openId === id;
    const toggleOpen = () => {
      openId = open ? null : id;
      draw();
      const again = list.querySelector(`.pv-card[data-id="${CSS.escape(id)}"]`);
      if (openId) again?.querySelector('.pv-oauth .btn, .pv-key, .pv-url, .pv-form .btn')?.focus({ preventScroll: true });
      else again?.querySelector('.pv-head')?.focus({ preventScroll: true });
    };
    const body = () => (fam
      ? members.map((p) => h('section', { class: 'pv-way', dataset: { id: p.id }, 'aria-label': `${fam.name}: ${WAY[p.id][0]}` },
          h('div', { class: 'pv-way-h' },
            h('span', { class: 'pv-main' }, h('strong', { class: 'pv-name' }, WAY[p.id][0]), h('span', { class: 'pv-sub' }, WAY[p.id][1])),
            statusOf([p])),
          ...connectForm(p)))
      : connectForm(lead));
    return h('div', { class: `pv-card${configured ? ' on' : ''}${open ? ' open' : ''}`, dataset: { id, ids: members.map((p) => p.id).join(' ') } },
      h('button', { class: 'pv-head', type: 'button', 'aria-expanded': String(open), onclick: toggleOpen },
        h('span', { class: 'pv-ic', 'aria-hidden': 'true' }, brandMark(lead.id, 20)),
        h('span', { class: 'pv-main' }, h('strong', { class: 'pv-name' }, fam?.name || lead.name), h('span', { class: 'pv-sub ell' }, fam?.note || lead.note || '')),
        status,
        icon(open ? 'chevron-down' : 'chevron-right', 14, 'pv-chev')),
      open ? h('div', { class: 'pv-body' }, ...body()) : null);
  }

  function draw() {
    // Providers gathered by maker, in the order the first of each appears.
    const groups = new Map();
    for (const p of engine.providers) {
      const id = familyOf(p.id);
      (groups.get(id) || groups.set(id, { id, members: [] }).get(id)).members.push(p);
    }
    for (const g of groups.values()) if (FAMILY[g.id]) g.members.sort((a, b) => FAMILY[g.id].members.indexOf(a.id) - FAMILY[g.id].members.indexOf(b.id));
    const match = (g) => !query || [FAMILY[g.id]?.name, FAMILY[g.id]?.note, ...g.members.flatMap((p) => [p.name, p.id, p.note])].join(' ').toLowerCase().includes(query);
    const shown = [...groups.values()].filter(match);
    const on = shown.filter((g) => g.members.some((p) => p.configured));
    const off = shown.filter((g) => !g.members.some((p) => p.configured));
    const kids = [];
    // Group labels only when there are two groups; a single list needs no label (the page title says what it is).
    if (on.length) kids.push(h('div', { class: 'pv-group' }, 'Connected'), on.map(card));
    if (off.length) kids.push(on.length ? h('div', { class: 'pv-group' }, 'Add another') : '', off.map(card));
    if (!kids.length) kids.push(h('div', { class: 'empty' }, 'No provider matches.'));
    replace(list, ...kids);
  }

  replace(root, h('div', { class: 'pv-tools' }, search), list);
  draw();
}
