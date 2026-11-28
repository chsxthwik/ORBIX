// The agent CLIs ORBIX can run a conversation with, next to its own agent: Claude Code, Codex, OpenCode, Gemini CLI
// and any Agent Client Protocol agent you add (Settings → Agents). Each shows in the model picker as a provider
// named after the agent ("agent-claude/sonnet"), so choosing one is choosing a model.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { runProc } from '../backend.mjs';
import { LineProcess, Rpc } from './lines.mjs';
import { CLAUDE_MODELS, CLAUDE_EFFORTS } from './claude.mjs';

const BUILTIN_AGENTS = [
  { id: 'agent-claude', name: 'Claude Code', cmd: 'claude', kind: 'claude', install: 'npm install -g @anthropic-ai/claude-code', login: 'claude', note: 'Anthropic’s agent, on your Claude plan or API key.' },
  { id: 'agent-codex', name: 'Codex', cmd: 'codex', kind: 'codex', install: 'npm install -g @openai/codex', login: 'codex login', note: 'OpenAI’s agent, on your ChatGPT plan or API key.' },
  { id: 'agent-opencode', name: 'OpenCode', cmd: 'opencode', kind: 'acp', args: ['acp'], env: { OPENCODE_DISABLE_AUTOUPDATE: '1' }, extra: ['.opencode/bin/opencode'], install: 'npm install -g @opencode/cli', login: 'opencode auth login', note: 'Use models from your configured OpenCode providers over ACP. Provider charges may apply.' },
  { id: 'agent-gemini', name: 'Gemini CLI', cmd: 'gemini', kind: 'acp', args: ['--experimental-acp'], install: 'npm install -g @google/gemini-cli', login: 'gemini', note: 'Google’s agent, over ACP.' },
];

export const isAgentId = (id) => typeof id === 'string' && id.startsWith('agent-');
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);

/** Your own ACP agents from engine.json → { id: 'agent-x-<slug>', name, argv }. */
export function customAgents(list = []) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    const argv = Array.isArray(a?.command) ? a.command.map(String) : String(a?.command || '').trim().split(/\s+/).filter(Boolean);
    const name = String(a?.name || '').trim().slice(0, 60);
    if (!argv.length || !name) continue;
    out.push({ id: `agent-x-${slug(a.id || name)}`, name, cmd: argv[0], args: argv.slice(1), kind: 'acp', custom: true, note: 'Your ACP agent.' });
  }
  return out;
}

/** Check one custom agent entry; returns a clean copy or throws with what is wrong. */
export function cleanCustomAgent(a = {}) {
  const name = String(a.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const command = String(a.command || '').trim().slice(0, 400);
  if (!name) throw Object.assign(new Error('Give the agent a name'), { status: 400 });
  if (!command) throw Object.assign(new Error('Enter the command that starts it in ACP mode, for example: hermes acp'), { status: 400 });
  return { id: slug(a.id || name), name, command };
}

const firstLine = (buf) => String(buf || '').trim().split(/\r?\n/)[0]?.trim() || '';

export class AgentRegistry {
  constructor({ backend, config }) {
    this.backend = backend;
    this.config = config; // EngineConfig: data.agents is your list of ACP agents
    this.found = null;
    this.foundAt = 0;
    this.finding = null;
    this.modelCache = new Map();
  }

  all() {
    return [...BUILTIN_AGENTS, ...customAgents(this.config?.data?.agents)];
  }

  get(id) {
    return this.all().find((a) => a.id === id) || null;
  }

  /** Where each CLI is and its version: { [id]: { path, version } }. Cached for a minute. */
  async detect(force = false) {
    if (!force && this.found && Date.now() - this.foundAt < 60000) return this.found;
    if (!this.finding) {
      this.finding = this._detect().then((r) => {
        this.found = r;
        this.foundAt = Date.now();
        return r;
      }).finally(() => (this.finding = null));
    }
    return this.finding;
  }

  async _detect() {
    const agents = this.all();
    const out = {};
    if (this.backend.isWsl) {
      const names = [...new Set(agents.map((a) => a.cmd))].filter((c) => /^[\w.-]+$/.test(c));
      const script = names.map((c) => `printf '%s\\t%s\\n' ${c} "$(command -v ${c} 2>/dev/null || { [ -x "$HOME/.${c}/bin/${c}" ] && echo "$HOME/.${c}/bin/${c}"; })"`).join('; ');
      const r = await this.backend.exec(['bash', '-lc', script], { timeout: 20000 }).catch(() => null);
      const where = new Map(String(r?.stdout || '').split('\n').map((l) => l.split('\t')).filter((x) => x[1]?.trim()).map(([c, p]) => [c, p.trim()]));
      for (const a of agents) if (where.get(a.cmd)) out[a.id] = { path: where.get(a.cmd) };
      for (const a of agents) if (a.cmd.startsWith('/') ) out[a.id] = { path: a.cmd };
    } else if (process.platform === 'win32') {
      const home = os.homedir();
      await Promise.all(agents.map(async (a) => {
        if (path.isAbsolute(a.cmd)) {
          if (fs.existsSync(a.cmd)) out[a.id] = { path: a.cmd };
          return;
        }
        for (const rel of a.extra || []) {
          for (const ext of ['.exe', '.cmd', '']) {
            const p = path.join(home, rel + ext);
            if (fs.existsSync(p)) return (out[a.id] = { path: p });
          }
        }
        const r = await runProc('where.exe', [a.cmd], { timeout: 8000 });
        const hits = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const best = hits.find((h) => /\.exe$/i.test(h)) || hits.find((h) => /\.cmd$/i.test(h)) || null;
        if (best) out[a.id] = { path: best };
      }));
    } else {
      await Promise.all(agents.map(async (a) => {
        for (const candidate of [a.cmd, ...(a.extra || []).map((p) => path.join(os.homedir(), p))]) {
          const candidates = candidate.includes('/') ? [candidate] : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, candidate));
          for (const bin of candidates) {
            const executable = await fs.promises.access(bin, fs.constants.X_OK).then(() => fs.promises.stat(bin)).catch(() => null);
            if (executable?.isFile()) {
              out[a.id] = { path: bin };
              return;
            }
          }
        }
      }));
    }
    await Promise.all(Object.entries(out).map(async ([id, f]) => {
      const r = await this.backend.exec([f.path, '--version'], { timeout: 15000 }).catch(() => null);
      f.version = firstLine(r?.stdout).replace(/^(?:opencode\s+)?v(?=\d)/i, '').slice(0, 60);
      f.signedIn = await this._signedIn(agents.find((a) => a.id === id), f.path).catch(() => null);
    }));
    return out;
  }

  /** Whether the CLI has a login: true, false, or null when ORBIX cannot tell. */
  async _signedIn(a, bin) {
    if (a.kind === 'claude') {
      const r = await this.backend.exec([bin, 'auth', 'status', '--json'], { timeout: 15000 });
      return /"loggedIn"\s*:\s*true/.test(String(r.stdout)) ? true : /"loggedIn"\s*:\s*false/.test(String(r.stdout)) ? false : null;
    }
    if (a.kind === 'codex') {
      const r = await this.backend.exec([bin, 'login', 'status'], { timeout: 15000 });
      const t = `${r.stdout}${r.stderr}`;
      return /logged in/i.test(t) && !/not logged in/i.test(t) ? true : /not logged in/i.test(t) ? false : null;
    }
    if (a.id === 'agent-opencode') {
      const r = await this.backend.exec([bin, 'auth', 'list'], { timeout: 15000 });
      return /stored|environment|oauth/i.test(String(r.stdout)) ? true : null;
    }
    return null;
  }

  /** What Settings and the model picker show about each agent. */
  async view(force = false) {
    const found = await this.detect(force);
    return this.all().map((a) => ({ id: a.id, name: a.name, kind: a.kind, custom: !!a.custom, note: a.note, install: a.install || '', login: a.login || '', command: [a.cmd, ...(a.args || [])].join(' '), installed: !!found[a.id], path: found[a.id]?.path || '', version: found[a.id]?.version || '', signedIn: found[a.id]?.signedIn ?? null }));
  }

  /** The argv that starts agent `a` in its protocol mode. */
  async argv(a) {
    const found = await this.detect();
    const bin = found[a.id]?.path;
    if (!bin) throw Object.assign(new Error(`${a.name} is not installed${a.install ? `. Install it with: ${a.install}` : ''}`), { status: 400 });
    return [bin, ...(a.args || [])];
  }

  /** Models for agent `id`, as the model picker lists them. Cached for ten minutes. */
  async models(id) {
    const a = this.get(id);
    if (!a) return [];
    const hit = this.modelCache.get(id);
    if (hit && Date.now() - hit.at < 600000) return hit.list;
    let list = [];
    if (a.kind === 'claude') list = CLAUDE_MODELS.map((m) => ({ ...m, thinking: { efforts: CLAUDE_EFFORTS, mode: 'effort', canOff: false } }));
    else if (a.kind === 'codex') list = await this._codexModels(a).catch(() => []);
    else if (a.id === 'agent-opencode') list = await this._opencodeModels(a).catch(() => []);
    list = [{ id: 'default', name: `${a.name} default`, agentDefault: true }, ...list];
    this.modelCache.set(id, { at: Date.now(), list });
    return list;
  }

  async _codexModels(a) {
    const [bin] = await this.argv(a);
    const lp = new LineProcess(this.backend.spawn([bin, 'app-server'], { quiet: true }));
    const rpc = new Rpc(lp, { jsonrpc: false });
    try {
      await rpc.call('initialize', { clientInfo: { name: 'orbix', title: 'ORBIX', version: '1' }, capabilities: { experimentalApi: true } }, { timeout: 30000 });
      rpc.notify('initialized');
      const r = await rpc.call('model/list', { limit: 100 }, { timeout: 30000 });
      return (r.data || []).filter((m) => !m.hidden).map((m) => ({ id: m.model || m.id, name: m.displayName || m.model, reasoning: !!m.supportedReasoningEfforts?.length, thinking: m.supportedReasoningEfforts?.length ? { efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort), mode: 'effort', canOff: false, default: m.defaultReasoningEffort } : undefined }));
    } finally {
      lp.close(500);
    }
  }

  async _opencodeModels(a) {
    const [bin] = await this.argv(a);
    const r = await this.backend.exec([bin, 'models'], { timeout: 30000 });
    return String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[\w.-]+\/\S+$/.test(s)).slice(0, 400).map((id) => ({ id, name: id }));
  }
}
