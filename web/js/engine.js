// "AI providers": add a key (or a local server) for the ORBIX agent. Each provider is checked before it is saved.
import { h, icon, toast, replace, spinner, skeleton } from './dom.js';
import { api } from './api.js';
import { loadEngine } from './store.js';
import { confirmDialog } from './dialogs.js';
import { renderModelRoles } from './models.js';

const openLink = (url) => api.post('/api/open-url', { url }).catch((e) => toast(e.message, 'error'));

let signIn = null; // {state, url, timer} while an OpenRouter sign-in is waiting for the browser
let view = null; // the open settings screen, so a sign-in that finishes later updates whatever is showing now
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
    if (root.isConnected) (draw(), view?.drawRoles?.());
  };
  view = { root, draw: () => draw(), refresh };

  function stopSignIn() {
    if (signIn?.timer) clearInterval(signIn.timer);
    signIn = null;
  }

  async function startSignIn() {
    stopSignIn();
    try {
      const r = await api.post('/api/engine/oauth/start');
      const started = Date.now();
      signIn = { state: r.state, url: r.url };
      toast('Finish signing in in your browser.', 'info', 5000);
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
            toast(`OpenRouter: signed in${Number.isFinite(s.models) ? ` (${s.models} model${s.models === 1 ? '' : 's'})` : ''}`, 'ok', 4000);
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
      if (signIn) {
        oauthRow = h('div', { class: 'pv-oauth' }, spinner(12), h('span', null, 'Finish signing in in your browser.'), h('button', { class: 'link', type: 'button', onclick: () => openLink(signIn.url) }, 'Open again'), h('button', { class: 'link', type: 'button', onclick: () => {
          api.post('/api/engine/oauth/cancel', { state: signIn?.state }).catch(() => {});
          stopSignIn();
          draw();
        } }, 'Cancel'));
      } else {
        oauthRow = h('div', { class: 'pv-oauth' }, h('button', { class: 'btn sm', type: 'button', onclick: startSignIn }, p.via === 'oauth' ? 'Sign in again' : 'Sign in with OpenRouter'), h('span', { class: 'muted small' }, 'or paste a key below'));
      }
    }

    const status = p.configured
      ? h('span', { class: 'pv-status on' }, h('span', { class: 'dot ok' }), p.models != null ? `Connected · ${p.models} model${p.models === 1 ? '' : 's'}` : 'Connected')
      : null;
    const link = p.keyUrl ? h('button', { class: 'link', type: 'button', title: p.keyUrl, onclick: () => openLink(p.keyUrl) }, local ? 'Download' : 'Get a key', icon('external', 12)) : null;

    return h('div', { class: `pv-card${p.configured ? ' on' : ''}`, dataset: { id: p.id } },
      h('div', { class: 'pv-head' }, h('strong', { class: 'pv-name' }, p.name), status),
      h('div', { class: 'pv-note' }, h('span', null, p.note || ''), link),
      oauthRow,
      h('div', { class: 'pv-form' }, url, key, save, remove));
  }

  function draw() {
    const match = (p) => !query || `${p.name} ${p.id} ${p.note}`.toLowerCase().includes(query);
    const on = engine.providers.filter((p) => p.configured && match(p));
    const off = engine.providers.filter((p) => !p.configured && match(p));
    const kids = [];
    if (on.length) kids.push(h('div', { class: 'pv-group' }, 'Connected'), on.map(card));
    if (off.length) kids.push(h('div', { class: 'pv-group' }, on.length ? 'Add another' : 'Providers'), off.map(card));
    if (!kids.length) kids.push(h('div', { class: 'empty' }, 'No provider matches.'));
    replace(list, ...kids);
  }

  const roles = h('div', { class: 'roles' });
  view.drawRoles = () => root.isConnected && renderModelRoles(roles, engine);
  replace(root,
    roles,
    h('h4', { class: 'set-sub' }, 'Providers'),
    h('p', { class: 'set-note pv-intro' }, 'Keys are checked with the provider, then stored encrypted for your Windows account and sent only to that provider.'),
    h('div', { class: 'pv-tools' }, search),
    list);
  draw();
  view.drawRoles();
}
