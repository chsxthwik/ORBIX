// Settings → Agents: the coding agent CLIs ORBIX can run a conversation on (Claude Code, Codex, OpenCode, Gemini
// CLI and your own ACP agents), whether each is installed and signed in, how to fix it when it is not, and whether it
// shows in the model picker.
import { h, icon, toast, replace, copyText, onEnter } from './dom.js';
import { api } from './api.js';
import { S, emit, savePrefs } from './store.js';
import { btn, toggle } from './dialogs.js';
import { brandTile } from './brands.js';

const status = (a) => (!a.installed ? ['off', 'Not installed'] : a.signedIn === false ? ['warn', 'Not signed in'] : a.signedIn ? ['ok', 'Ready'] : ['ok', 'Installed']);

/** Start a new conversation on agent `a` from Home (its default model). */
function useAgent(a, close) {
  savePrefs({ homeModel: { provider: a.id, id: 'default', name: `${a.name} default` } });
  close?.();
  emit('home');
}

function agentRow(a, close) {
  const [cls, label] = status(a);
  const copy = (cmd, what) => btn(what, () => copyText(cmd), 'sm');
  const fix = !a.installed ? (a.install ? copy(a.install, 'Copy install command') : null) : a.signedIn === false && a.login ? copy(a.login, 'Copy sign-in command') : btn('New conversation', () => useAgent(a, close), 'sm');
  return h('div', { class: 'set-row ag-row' },
    brandTile(a.id, 32, 'ag-mark'),
    h('div', { class: 'set-l' },
      h('div', { class: 'set-t' }, a.name, a.version ? h('span', { class: 'ag-ver' }, a.version.replace(/\s*\(.*\)$/, '')) : null),
      h('div', { class: 'set-d' }, a.installed ? h('code', { class: 'ag-path ell', title: a.path }, a.path) : a.note)),
    h('span', { class: `ag-st ${cls}` }, label),
    fix,
    a.installed ? pickerSwitch(a) : null);
}

/** Whether an installed agent is offered in the model picker. Off keeps it installed and usable, just out of the list. */
function pickerSwitch(a) {
  const hidden = () => new Set(S.ui.hiddenAgents || []);
  const t = toggle(!hidden().has(a.id), (on) => {
    const next = hidden();
    if (on) next.delete(a.id);
    else next.add(a.id);
    savePrefs({ hiddenAgents: [...next] });
  }, `Show ${a.name} in the model picker`);
  t.title = 'Show in the model picker';
  return t;
}

export function tabAgents(el, show, m) {
  const list = h('div', { class: 'set-card' }, h('div', { class: 'set-row' }, h('span', { class: 'set-d' }, 'Looking for agents on this computer…')));
  const mine = h('div', { class: 'set-card' });
  const name = h('input', { type: 'text', placeholder: 'Name, e.g. Hermes', 'aria-label': 'Agent name', maxlength: 60, spellcheck: 'false' });
  const cmd = h('input', { type: 'text', placeholder: 'Command in ACP mode, e.g. hermes acp', 'aria-label': 'Command', spellcheck: 'false', autocomplete: 'off' });
  let agents = S.engine?.agents || [];
  const custom = () => (agents || []).filter((a) => a.custom);
  const save = async (next) => {
    try {
      const r = await api.post('/api/agents', { agents: next.map((a) => ({ name: a.name, command: a.command })) });
      agents = r.agents;
      S.engine = r.engine;
      emit('engine');
      draw();
      return true;
    } catch (e) {
      toast(e.message, 'error', 5000);
      return false;
    }
  };
  const add = async () => {
    if (!name.value.trim()) return name.focus();
    if (!cmd.value.trim()) return cmd.focus();
    if (await save([...custom(), { name: name.value, command: cmd.value }])) (name.value = ''), (cmd.value = '');
  };
  onEnter(cmd, add);
  function draw() {
    const builtin = (agents || []).filter((a) => !a.custom);
    replace(list, builtin.map((a) => agentRow(a, () => m?.close?.())));
    replace(mine,
      ...custom().map((a) => h('div', { class: 'set-row ag-row' }, brandTile(a.id, 32, 'ag-mark'), h('div', { class: 'set-l' }, h('div', { class: 'set-t' }, a.name), h('div', { class: 'set-d' }, h('code', null, a.command))), h('span', { class: `ag-st ${status(a)[0]}` }, status(a)[1]), btn('Remove', () => save(custom().filter((x) => x.id !== a.id)), 'sm'))),
      h('div', { class: 'set-row ag-add' }, name, cmd, btn('Add', add, 'sm')));
  }
  const refresh = async (force) => {
    try {
      agents = (await api.get(`/api/agents${force ? '?refresh=1' : ''}`)).agents;
      if (S.engine) S.engine.agents = agents;
      emit('engine');
      draw();
    } catch (e) {
      replace(list, h('div', { class: 'set-row' }, h('span', { class: 'set-d warn-text' }, e.message)));
    }
  };
  el.append(
    h('p', { class: 'set-note' }, 'Pick an agent in the model picker to run a conversation on it, with its own login. Your permission preset applies; destructive commands always ask.'),
    h('section', { class: 'set-group' }, h('div', { class: 'set-sub-row' }, h('h4', { class: 'set-sub' }, 'On this computer'), btn('Look again', () => refresh(true), 'sm')), list),
    h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, 'Your ACP agents'), h('p', { class: 'set-note' }, 'Any Agent Client Protocol agent, such as Hermes, Goose or your own: the command that starts it in ACP mode.'), mine));
  draw();
  refresh(false);
}
