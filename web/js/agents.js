// Settings → Agents: the coding agent CLIs ORBIX can run a conversation on (Claude Code, Codex, OpenCode, Gemini
// CLI and your own ACP agents), whether each is installed and signed in, and how to fix it when it is not.
import { h, icon, toast, replace, copyText, onEnter } from './dom.js';
import { api } from './api.js';
import { S, emit, savePrefs } from './store.js';
import { btn } from './dialogs.js';
import { brandMark } from './brands.js';

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
    h('div', { class: 'ag-mark' }, brandMark(a.id, 20)),
    h('div', { class: 'set-l' },
      h('div', { class: 'set-t' }, a.name, a.version ? h('span', { class: 'ag-ver' }, a.version.replace(/\s*\(.*\)$/, '')) : null),
      h('div', { class: 'set-d' }, a.installed ? h('code', { class: 'ag-path ell', title: a.path }, a.path) : a.note)),
    h('span', { class: `ag-st ${cls}` }, label),
    fix);
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
      ...custom().map((a) => h('div', { class: 'set-row ag-row' }, h('div', { class: 'ag-mark' }, icon('cpu', 18)), h('div', { class: 'set-l' }, h('div', { class: 'set-t' }, a.name), h('div', { class: 'set-d' }, h('code', null, a.command))), h('span', { class: `ag-st ${status(a)[0]}` }, status(a)[1]), btn('Remove', () => save(custom().filter((x) => x.id !== a.id)), 'sm'))),
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
    h('p', { class: 'set-note' }, 'Run a conversation on another coding agent with the plan or key it already uses. Pick it in the model picker, as a provider named after the agent. ORBIX shows its work as steps and asks before it runs a command or changes a file, as your permission preset says; a destructive command always asks. The agent keeps its own login and history, and a saved conversation resumes the agent’s own session.'),
    h('section', { class: 'set-group' }, h('div', { class: 'set-sub-row' }, h('h4', { class: 'set-sub' }, 'On this computer'), btn('Look again', () => refresh(true), 'sm')), list),
    h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, 'Your ACP agents'), h('p', { class: 'set-note' }, 'Any agent that speaks the Agent Client Protocol on stdio: Hermes, Kimi, Droid, fx, Goose, your own. Enter the command that starts it in ACP mode.'), mine));
  draw();
  refresh(false);
}
