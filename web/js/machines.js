// ORBIX Cloud in the app: Settings → Machines (your other ORBIX servers), switching this window to one and back,
// and moving a conversation to one (Teleport). The server side is src/cloud.mjs.
import { h, icon, toast, replace, copyText, timeAgo, onEnter } from './dom.js';
import { api } from './api.js';
import { S, emit, closeTab, loadSessions } from './store.js';
import { btn, modal, confirmDialog } from './dialogs.js';

const bridge = () => window.orbixDesktop?.machines || null;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;

/** This window shows a machine (a self-hosted ORBIX), not the ORBIX on this PC. */
export const onMachine = () => (location.protocol === 'http:' || location.protocol === 'https:') && !LOOPBACK.test(location.hostname);

const INSTALL = 'curl -fsSL https://orbix-agent.vercel.app/install.sh | bash';

/** Open machine `id` in this window (the app), or in a new browser tab. */
async function openMachine(m) {
  try {
    const { url } = await api.post('/api/machines/open', { id: m.id });
    if (bridge()) await bridge().open(url);
    else window.open(url, '_blank', 'noopener');
  } catch (e) {
    toast(e.message, 'error', 6000);
  }
}

/** Back to the ORBIX on this PC (from a machine's page in the app window). */
export function backToThisPc() {
  bridge()?.home();
}

export function tabMachines(el) {
  let list = [];
  const box = h('div', { class: 'set-card' });
  const name = h('input', { type: 'text', placeholder: 'Name, e.g. My VPS', 'aria-label': 'Machine name', maxlength: 60 });
  const url = h('input', { type: 'url', placeholder: 'https://orbix.example.com', 'aria-label': 'Address', spellcheck: 'false', autocomplete: 'off' });
  const token = h('input', { type: 'password', placeholder: 'Token', 'aria-label': 'Token', spellcheck: 'false', autocomplete: 'off' });
  const addBtn = btn('Add machine', async () => {
    if (!url.value.trim()) return url.focus();
    if (!token.value.trim()) return token.focus();
    addBtn.disabled = true;
    try {
      list = (await api.post('/api/machines', { name: name.value, url: url.value, token: token.value })).machines;
      name.value = url.value = token.value = '';
      toast('Machine added. It answered and accepted the token.', 'ok', 3000);
      draw();
    } catch (e) {
      toast(e.message, 'error', 7000);
    } finally {
      addBtn.disabled = false;
    }
  }, 'sm primary');
  onEnter(token, () => addBtn.click());
  const here = h('div', { class: 'set-row ag-row' }, h('div', { class: 'ag-mark' }, icon('laptop', 18)), h('div', { class: 'set-l' }, h('div', { class: 'set-t' }, onMachine() ? location.host : 'This PC'), h('div', { class: 'set-d' }, onMachine() ? 'The machine this window shows.' : 'Agents here stop when this PC sleeps or ORBIX closes.')), h('span', { class: 'ag-st ok' }, 'This window'), onMachine() && bridge() ? btn('Back to this PC', backToThisPc, 'sm') : null);
  function draw() {
    replace(box, here, ...list.map((m) => h('div', { class: 'set-row ag-row' },
      h('div', { class: 'ag-mark' }, icon('server', 18)),
      h('div', { class: 'set-l' }, h('div', { class: 'set-t' }, m.name, m.version ? h('span', { class: 'ag-ver' }, m.version) : null), h('div', { class: 'set-d' }, h('code', { class: 'ag-path' }, m.url), m.lastSeen ? ` · answered ${timeAgo(m.lastSeen)}${/^\d/.test(timeAgo(m.lastSeen)) ? ' ago' : ''}` : '')),
      btn('Check', async (e) => {
        try {
          const r = await api.post('/api/machines/check', { id: m.id });
          list = r.machines;
          toast(`${m.name}: ORBIX ${r.version}, ${r.procs} conversation${r.procs === 1 ? '' : 's'} open`, 'ok', 3500);
          draw();
        } catch (er) {
          toast(er.message, 'error', 6000);
        }
      }, 'sm'),
      btn('Open', () => openMachine(m), 'sm'),
      btn('Remove', async () => {
        if (!(await confirmDialog('Remove machine', `Remove “${m.name}” from this list? The machine and its conversations stay as they are.`, { ok: 'Remove', danger: true }))) return;
        list = (await api.post('/api/machines/remove', { id: m.id })).machines;
        draw();
      }, 'sm'))));
  }
  el.append(
    h('p', { class: 'set-note' }, 'A machine is ORBIX running on a computer you own, such as a Linux VPS. Its agents keep working while this PC sleeps, and you can move a conversation there with its project (conversation menu → Move to a machine). The token is stored encrypted and sent only to that machine.'),
    h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, 'Your machines'), box),
    h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, 'Add a machine'), h('div', { class: 'set-card' }, h('div', { class: 'set-row mc-add' }, name, url, token, addBtn)),
      h('p', { class: 'set-note' }, 'On the machine (Ubuntu or Debian), install ORBIX as a service; it prints the address and the token:'),
      h('div', { class: 'mc-cmd' }, h('code', null, INSTALL), btn('Copy', () => copyText(INSTALL), 'sm')),
      h('p', { class: 'set-note' }, 'It listens on 127.0.0.1 only. Reach it over Tailscale (tailscale serve) or an SSH tunnel, or put HTTPS in front of it; ORBIX refuses plain http:// across the internet.')));
  draw();
  api.get('/api/machines').then((r) => ((list = r.machines), draw())).catch((e) => toast(e.message, 'error'));
}

/** Conversation menu → Move to a machine: pick one, confirm, move. */
export async function moveToMachine(t) {
  let list = [];
  try {
    list = (await api.get('/api/machines')).machines;
  } catch (e) {
    return toast(e.message, 'error');
  }
  if (!list.length) {
    toast('Add a machine first: Settings → Machines.', 'info', 4000);
    return emit('settings', 'machines');
  }
  if (t.streaming) return toast('The agent is still working. Stop it or wait, then move the conversation.', 'error', 5000);
  let pickId = list[0].id;
  const choices = h('div', { class: 'mc-pick', role: 'radiogroup', 'aria-label': 'Machine' }, ...list.map((m) => h('label', { class: 'scope-opt' }, h('input', { type: 'radio', name: 'mc', checked: m.id === pickId ? true : null, onchange: () => (pickId = m.id) }), h('span', null, h('b', null, m.name), h('span', { class: 'muted small' }, m.url)))));
  const go = async () => {
    dlg.close();
    const m = list.find((x) => x.id === pickId);
    const note = toast(`Moving “${t.name}” to ${m.name}… packing the project`, 'info', 60000);
    try {
      const r = await api.post('/api/teleport', { proc: t.id, machine: m.id });
      note?.remove?.();
      t.dead = true; // the server already closed it
      closeTab(t.id);
      loadSessions();
      toast(`Moved to ${m.name} (${Math.max(1, Math.round(r.bytes / 1024))} KB). It continues there in ${r.workspace}.`, 'ok', 8000);
      if (await confirmDialog(`Open ${m.name}?`, `The conversation is open on ${m.name}. Switch this window to it now? You can come back from the machine with “Back to this PC”.`, { ok: `Open ${m.name}` })) openMachine(m);
    } catch (e) {
      note?.remove?.();
      toast(e.message, 'error', 9000);
    }
  };
  const dlg = modal({
    title: 'Move to a machine',
    size: 'sm',
    body: h('div', { class: 'scope' }, h('p', null, 'The conversation continues on the machine, with a copy of this project (git history and uncommitted changes included; node_modules, build and cache folders left out). It closes here.'), choices),
    actions: [btn('Cancel', () => dlg.close()), btn('Move', go, 'primary')],
  });
}
