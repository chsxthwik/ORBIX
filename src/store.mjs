// App settings (data/config.json). All app state (config, logs, sessions, WebView2 profile) lives in <app>/data;
// set ORBIX_DATA to use a different folder (e.g. for testing).
import path from 'node:path';
import { ROOT, readJson, writeJson, uid } from './util.mjs';
import { Backend } from './backend.mjs';

export const DATA_DIR = process.env.ORBIX_DATA || path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  version: 1,
  backend: { kind: 'wsl', distro: '', ompPath: '' },
  workspaces: [],
  ui: { theme: 'system', density: 'comfortable', showThinking: true, autoScroll: true, rightPanel: true, rightTab: 'files', sidebarW: 292, panelW: 380, fontSize: 14 },
  launch: { model: '', thinking: '' },
};

export class Store {
  constructor() {
    const saved = readJson(FILE, {});
    this.data = {
      ...DEFAULTS,
      ...saved,
      backend: { ...DEFAULTS.backend, ...(saved.backend || {}) },
      ui: { ...DEFAULTS.ui, ...(saved.ui || {}) },
      launch: { ...DEFAULTS.launch, ...(saved.launch || {}) },
      workspaces: Array.isArray(saved.workspaces) ? saved.workspaces : [],
    };
    this._t = null;
  }

  /**
   * Until the user picks a backend: use the first WSL distribution that has OMP, else Windows if it has OMP.
   * With no OMP anywhere keep WSL (when installed) so the agent's commands run in Linux, else run on Windows.
   * Runs after the server is listening. Candidates are probed on their own Backend objects; the server's `backend`
   * only switches once, to the result, and keeps that lookup cached.
   */
  async autodetect(backend) {
    if (this.data.backendChosen) return;
    const native = new Backend({ kind: 'native', distro: '', ompPath: '' });
    const nativeOmp = native.resolveOmp().catch(() => null);
    const { distros, defaultDistro } = await Backend.wslInfo().catch(() => ({ distros: [], defaultDistro: '' }));
    const order = [defaultDistro, ...distros].filter((d, i, a) => d && a.indexOf(d) === i);
    const choose = (b, chosen) => {
      this.data.backend = { kind: b.kind, distro: b.distro, ompPath: '' };
      if (chosen) this.data.backendChosen = true;
      backend.adopt(b);
      this.save();
    };
    const tried = [];
    for (const distro of order) {
      const b = new Backend({ kind: 'wsl', distro, ompPath: '' });
      tried.push(b);
      if (await b.resolveOmp().catch(() => null)) return choose(b, true);
    }
    if (await nativeOmp) return choose(native, true);
    choose(tried[0] || native, false);
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
