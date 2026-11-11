// "AI providers": add a key (or a local server) for the ORBIX agent. Each provider is checked before it is saved.
import { h, icon, toast, replace, spinner, skeleton } from './dom.js';
import { api } from './api.js';
import { loadEngine } from './store.js';
import { confirmDialog } from './dialogs.js';
import { brandMark } from './brands.js';

const openLink = (url) => api.post('/api/open-url', { url }).catch((e) => toast(e.message, 'error'));

let signIn = null; // {state, url, timer, provider} while a sign-in is waiting for the browser
// How each sign-in is offered, and what the user should know before choosing it.
const SIGN_IN = {
  openrouter: { name: 'OpenRouter', label: 'Sign in with OpenRouter', note: 'or paste a key below' },
  chatgpt: { name: 'ChatGPT', label: 'Sign in with ChatGPT', note: 'Uses your ChatGPT Plus or Pro plan and its usage limits; no API key or credits. Works through the Codex CLI sign-in, which OpenAI can change at any time. The sign-in renews itself.' },
  opencode: { name: 'OpenCode', label: 'Sign in with OpenCode', note: 'You confirm a short code on opencode.ai; paid models are billed to your OpenCode account. Uses the opencode CLI sign-in, which OpenCode can change at any time; an oc_sk_ key below always works. Free models are only available inside OpenCode itself.' },
  xai: { name: 'xAI', label: 'Sign in with xAI', note: 'You confirm a short code on x.ai; nothing else to install. Uses the Grok CLI sign-in, which xAI can change at any time. The sign-in renews itself.' },
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
    return replace(root, h('div', { class: 'callout bad' }, e.message));
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

  function card(p) {
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
            h('div', { class: 'pv-signin-h' }, spinner(12), h('span', null, 'Confirm this code on x.ai, then come back here.')),
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
          p.signInError ? h('span', { class: 'pv-oauth-err', title: p.signInError }, `The sign-in could not be renewed: ${p.signInError.replace(/\.$/, '')}. Sign in again.`) : h('span', { class: 'muted small pv-oauth-note' }, s.note));
      }
    }

    const status = p.configured
      ? h('span', { class: 'pv-status on' }, h('span', { class: 'dot ok' }), p.models != null ? `Connected · ${p.models} model${p.models === 1 ? '' : 's'}` : 'Connected')
      : null;
    const link = p.keyUrl ? h('button', { class: 'link', type: 'button', title: p.keyUrl, onclick: () => openLink(p.keyUrl) }, local ? 'Download' : 'Get a key', icon('external', 12)) : null;

    const open = openId === p.id;
    const toggleOpen = () => {
      openId = open ? null : p.id;
      draw();
      const again = list.querySelector(`.pv-card[data-id="${CSS.escape(p.id)}"]`);
      if (openId) again?.querySelector('.pv-oauth .btn, .pv-key, .pv-url, .pv-form .btn')?.focus({ preventScroll: true });
      else again?.querySelector('.pv-head')?.focus({ preventScroll: true });
    };
    return h('div', { class: `pv-card${p.configured ? ' on' : ''}${open ? ' open' : ''}`, dataset: { id: p.id } },
      h('button', { class: 'pv-head', type: 'button', 'aria-expanded': String(open), onclick: toggleOpen },
        h('span', { class: 'pv-ic', 'aria-hidden': 'true' }, brandMark(p.id, 20)),
        h('span', { class: 'pv-main' }, h('strong', { class: 'pv-name' }, p.name), h('span', { class: 'pv-sub ell' }, p.note || '')),
        status,
        icon(open ? 'chevron-down' : 'chevron-right', 14, 'pv-chev')),
      open ? h('div', { class: 'pv-body' },
        link ? h('div', { class: 'pv-note' }, link) : null,
        oauthRow,
        h('div', { class: 'pv-form' }, url, key, save, remove)) : null);
  }

  function draw() {
    const match = (p) => !query || `${p.name} ${p.id} ${p.note}`.toLowerCase().includes(query);
    const on = engine.providers.filter((p) => p.configured && match(p));
    const off = engine.providers.filter((p) => !p.configured && match(p));
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
