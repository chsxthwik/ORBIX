// App settings (config.json in the data folder), where all app state lives: config, logs and sessions. The installed
// app sets ORBIX_DATA to %LOCALAPPDATA%\ORBIX; run from a clone it is <repo>/data. Tests set their own folder.
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

  /**
   * Add an extra folder to a project. A project is its primary folder (`path`, where conversations start, git runs
   * and runs make their worktree) plus `folders`: other folders the agent may read and edit with the same approval
   * rules. Projects saved before this have no `folders` and load unchanged (read with projectFolders).
   */
  addFolder(id, p, keyOf = defaultKey) {
    const w = this.data.workspaces.find((x) => x.id === id);
    if (!w) throw new Error('No such project');
    const norm = String(p || '').trim();
    if (!norm) throw new Error('Path required');
    const k = keyOf(norm);
    if (k === keyOf(w.path)) throw new Error('That is already the project\'s main folder.');
    const list = projectFolders(w);
    if (!list.some((f) => keyOf(f) === k)) w.folders = [...list, norm];
    this.save();
    return w;
  }

  removeFolder(id, p, keyOf = defaultKey) {
    const w = this.data.workspaces.find((x) => x.id === id);
    if (!w) throw new Error('No such project');
    const k = keyOf(String(p || '').trim());
    w.folders = projectFolders(w).filter((f) => keyOf(f) !== k);
    this.save();
    return w;
  }

  /** The saved project `p` belongs to (see projectOf), or null. */
  projectFor(p, keyOf = defaultKey) {
    return projectOf(this.data.workspaces, p, keyOf);
  }

  removeWorkspace(id) {
    this.data.workspaces = this.data.workspaces.filter((w) => w.id !== id);
    this.save();
  }
}

/** Paths compared the way Windows does: separators unified, no trailing separator, any case. */
const defaultKey = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/** A project's extra folders (beyond its main folder); [] for projects saved by older versions. */
export const projectFolders = (w) => (Array.isArray(w?.folders) ? w.folders.filter((f) => typeof f === 'string' && f.trim()) : []);

/**
 * The saved project whose main folder is `p`, or that `p` is a worktree of: a run or branch session works in
 * <repo>/.orbix/worktrees/<slug>[/<subfolder>], which belongs to the project at <repo>[/<subfolder>].
 */
export function projectOf(workspaces, p, keyOf = defaultKey) {
  const k = keyOf(p);
  if (!k) return null;
  const main = k.replace(/[\\/]\.orbix[\\/]worktrees[\\/][^\\/]+(?=[\\/]|$)/i, '');
  return (workspaces || []).find((w) => keyOf(w.path) === k) || (main !== k && (workspaces || []).find((w) => keyOf(w.path) === main)) || null;
}
