// "AI providers": add a key (or a local server) for the ORBIX agent. Each provider is checked before it is saved.
import { h, icon, toast, replace, spinner, skeleton } from './dom.js';
import { api } from './api.js';
import { loadEngine } from './store.js';
import { confirmDialog } from './dialogs.js';
import { brandMark } from './brands.js';

const openLink = (url) => api.post('/api/open-url', { url }).catch((e) => toast(e.message, 'error'));

let signIn = null; // {state, url, timer, provider} while a sign-in is waiting for the browser
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
      const name = provider === 'xai' ? 'xAI' : 'OpenRouter';
      signIn = { state: r.state, url: r.url, provider };
      toast('Complete the sign-in in your browser.', 'info', 5000);
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
    const key = local
      ? null
      : h('input', { type: 'password', class: 'pv-key', placeholder: p.hasKey ? 'Key saved. Paste a new one to replace it.' : p.keyOptional ? 'API key (optional)' : 'Paste your API key', autocomplete: 'off', spellcheck: 'false', 'aria-label': `${p.name} API key` });
    const url = p.editableUrl ? h('input', { type: 'text', class: 'pv-url', placeholder: 'http://localhost:8000/v1', value: p.baseUrl || '', spellcheck: 'false', 'aria-label': 'Server address' }) : null;
    const save = h('button', { class: 'btn sm', type: 'button' }, local ? (p.configured ? 'Check again' : 'Connect') : 'Check & save');
    // The button turns primary once there is something to check.
    for (const el of [key, url]) el?.addEventListener('input', () => save.classList.toggle('primary', !!(key?.value.trim() || (url && url.value.trim() !== (p.baseUrl || '')))));
    save.addEventListener('click', async () => {
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
    for (const el of [key, url]) el?.addEventListener('keydown', (e) => e.key === 'Enter' && save.click());

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
        oauthRow = h('div', { class: 'pv-oauth' }, spinner(12), h('span', null, 'Complete the sign-in in your browser.'), h('button', { class: 'link', type: 'button', onclick: () => openLink(signIn.url) }, 'Open again'), h('button', { class: 'link', type: 'button', onclick: () => {
          api.post('/api/engine/oauth/cancel', { state: signIn?.state }).catch(() => {});
          stopSignIn();
          draw();
        } }, 'Cancel'));
      } else {
        const label = p.via === 'oauth' ? 'Sign in again' : `Sign in with ${p.name}`;
        oauthRow = h('div', { class: 'pv-oauth' }, h('button', { class: 'btn sm', type: 'button', onclick: () => startSignIn(p.id) }, label), h('span', { class: 'muted small' }, 'or paste a key below'));
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
