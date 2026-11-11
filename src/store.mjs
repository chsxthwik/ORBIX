// App settings (data/config.json). All app state (config, logs and sessions) lives in <app>/data;
// set ORBIX_DATA to use a different folder (e.g. for testing).
import path from 'node:path';
import { ROOT, readJson, writeJson, uid } from './util.mjs';
import { Backend } from './backend.mjs';

export const DATA_DIR = process.env.ORBIX_DATA || path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  version: 1,
  backend: { kind: 'wsl', distro: '' },
  workspaces: [],
  ui: { theme: 'system', density: 'comfortable', showThinking: true, autoScroll: true, rightPanel: true, rightTab: 'files', sidebarW: 292, panelW: 380, fontSize: 14 },
};

/** Keys older versions saved for an external CLI engine (since removed); dropped on load so they never come back. */
function dropRetired(saved) {
  const { launch, ...rest } = saved;
  const { ompPath, ...backend } = saved.backend || {};
  const { engine, defaultEngine, ...ui } = saved.ui || {};
  return { ...rest, backend, ui };
}

export class Store {
  constructor() {
    const saved = dropRetired(readJson(FILE, {}));
    this.data = {
      ...DEFAULTS,
      ...saved,
      backend: { ...DEFAULTS.backend, ...saved.backend },
      ui: { ...DEFAULTS.ui, ...saved.ui },
      workspaces: Array.isArray(saved.workspaces) ? saved.workspaces : [],
    };
    this._t = null;
  }

  /**
   * Until the user picks a backend: run commands in the first WSL distribution that starts (the default one first),
   * so the agent works in Linux; with no usable WSL, on Windows. Runs after the server is listening. Candidates are
   * probed on their own Backend objects; the server's `backend` only switches once, to the result, and keeps that
   * lookup cached.
   */
  async autodetect(backend) {
    if (this.data.backendChosen) return;
    const { distros, defaultDistro } = await Backend.wslInfo().catch(() => ({ distros: [], defaultDistro: '' }));
    const order = [defaultDistro, ...distros].filter((d, i, a) => d && a.indexOf(d) === i);
    const choose = (b) => {
      this.data.backend = { kind: b.kind, distro: b.distro };
      this.data.backendChosen = true;
      backend.adopt(b);
      this.save();
    };
    for (const distro of order) {
      const b = new Backend({ kind: 'wsl', distro });
      if ((await b.probe().catch(() => ({}))).home) return choose(b);
    }
    choose(new Backend({ kind: 'native', distro: '' }));
  }

  save() {
    clearTimeout(this._t);
    this._t = null;
    writeJson(FILE, this.data);
  }
  saveSoon() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.save(), 400);
  }

  addWorkspace(p, name) {
    const norm = p.trim();
    if (!norm) throw new Error('Path required');
    const existing = this.data.workspaces.find((w) => w.path.toLowerCase() === norm.toLowerCase());
    if (existing) return existing;
    const w = { id: uid('w'), path: norm, name: name || norm.split(/[\\/]/).filter(Boolean).pop() || norm, added: Date.now() };
    this.data.workspaces.push(w);
    this.save();
    return w;
  }

  removeWorkspace(id) {
    this.data.workspaces = this.data.workspaces.filter((w) => w.id !== id);
    this.save();
  }
}
