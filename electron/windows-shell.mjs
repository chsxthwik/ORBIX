// Windows 11 / 10 integration: Mica, taskbar progress and overlay, jump list, toast notifications with actions,
// accent colour, high contrast, text size and light/dark. Imported by main.mjs only when process.platform is win32.
import { app, BrowserWindow, Notification, nativeImage, nativeTheme, systemPreferences, ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  isWindowsHome, progressArgs, notifyArgs, themeSource, recentProjects, jumpAction, toastAction, isToastToken,
  allowOnce, registryDword, supportsMica, amberDot, accentHex,
} from './windows-input.mjs';

if (process.platform !== 'win32') throw new Error('windows-shell.mjs is for Windows only');

const WM_SETTINGCHANGE = 0x001a;
const PERSONALIZE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';
const ACCESSIBILITY = 'HKCU\\Software\\Microsoft\\Accessibility';
const MICA = supportsMica(os.release()); // Windows 11 22H2 (build 22621) and later

function dword(key, name) {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', key, '/v', name], { windowsHide: true, timeout: 4000 }, (err, out) => resolve(err ? null : registryDword(out, name)));
  });
}

/** What the page needs to know about Windows' own settings. */
async function readState() {
  const [transparency, textScale] = await Promise.all([dword(PERSONALIZE, 'EnableTransparency'), dword(ACCESSIBILITY, 'TextScaleFactor')]);
  const highContrast = nativeTheme.shouldUseHighContrastColors;
  const transparent = transparency !== 0; // missing means on
  return {
    mica: MICA && transparent && !highContrast,
    transparency: transparent,
    highContrast,
    dark: nativeTheme.shouldUseDarkColors,
    accent: accentHex(systemPreferences.getAccentColor()),
    textScale: textScale >= 100 && textScale <= 225 ? textScale / 100 : 1,
    hcColors: highContrast ? { bg: hex(systemPreferences.getColor('window')), fg: hex(systemPreferences.getColor('window-text')) } : null,
  };
}
const hex = (c) => (typeof c === 'string' && /^#[\da-f]{6}/i.test(c) ? c.slice(0, 7) : null);

/** BrowserWindow options decided before the window exists. */
export async function windowOptions() {
  const st = await readState();
  return st.mica ? { backgroundMaterial: 'mica', backgroundColor: '#00000000' } : {};
}

/**
 * @param {object} o
 * @param {() => BrowserWindow|null} o.getWin
 * @param {string} o.appUrl
 * @param {() => any} o.engine  the AppServer (null until it has started)
 * @param {() => void} o.show   bring the window forward
 */
export function setupWindowsShell({ getWin, appUrl, engine, show, icon, mica = false }) {
  let state = null;
  let pendingJump = jumpAction(process.argv);
  let titleBar = null; // the page's last colours
  let micaOn = mica; // what the window was created with (windowOptions)
  const fromHome = (e) => {
    const u = String(e.senderFrame?.url || '');
    return u.startsWith(appUrl) && isWindowsHome(e, getWin()?.webContents, u);
  };
  const send = (ch, msg) => {
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send(ch, msg);
  };

  // ---- Mica and the title bar buttons ----
  function paintTitleBar() {
    const w = getWin();
    if (!w || w.isDestroyed() || !titleBar) return;
    try {
      const hc = state?.hcColors;
      const color = hc?.bg || (micaOn ? '#00000000' : titleBar.bg);
      w.setTitleBarOverlay({ color, symbolColor: hc?.fg || titleBar.fg, height: titleBar.height });
      w.setBackgroundColor(micaOn ? '#00000000' : hc?.bg || titleBar.bg);
    } catch {}
  }
  function applyMaterial() {
    const w = getWin();
    if (!w || w.isDestroyed()) return;
    const want = !!state?.mica;
    if (want === micaOn) return;
    micaOn = want;
    try {
      w.setBackgroundMaterial(want ? 'mica' : 'none');
    } catch {}
    paintTitleBar();
  }
  async function refresh() {
    const next = await readState();
    const changed = JSON.stringify(next) !== JSON.stringify(state);
    state = next;
    applyMaterial();
    if (changed) {
      paintTitleBar();
      send('orbix:win:state', state);
    }
  }
  let refreshTimer = null;
  const refreshSoon = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh().catch(() => {}), 250);
  };
  nativeTheme.on('updated', refreshSoon);
  systemPreferences.on('accent-color-changed', refreshSoon);

  ipcMain.handle('orbix:win:ready', async (e) => {
    if (!fromHome(e)) return null;
    if (!state) await refresh();
    const jump = pendingJump;
    pendingJump = null;
    return { state, jump };
  });
  ipcMain.on('orbix:win:theme', (e, v) => {
    const src = themeSource(v);
    if (fromHome(e) && src && nativeTheme.themeSource !== src) nativeTheme.themeSource = src;
  });

  // ---- Taskbar: progress while agents work, an amber dot when one needs you ----
  const amber = nativeImage.createFromBitmap(amberDot(16), { width: 16, height: 16 });
  let lastBar = '';
  ipcMain.on('orbix:win:progress', (e, v) => {
    const p = progressArgs(v);
    const w = getWin();
    if (!p || !fromHome(e) || !w) return;
    const key = `${p.working > 0}|${p.waiting > 0}`;
    if (key === lastBar) return;
    lastBar = key;
    try {
      if (p.waiting) w.setProgressBar(1, { mode: 'paused' }); // amber bar: stopped, waiting for you
      else if (p.working) w.setProgressBar(2, { mode: 'indeterminate' });
      else w.setProgressBar(-1);
      w.setOverlayIcon(p.waiting ? amber : null, p.waiting ? `${p.waiting} waiting for you` : '');
    } catch {}
  });

  // ---- Jump list: New conversation, and recent projects ----
  const launch = (arg) => (process.defaultApp ? { program: process.execPath, args: `"${path.resolve(process.argv[1] || '.')}" ${arg}` } : { program: process.execPath, args: arg });
  let lastJump = '';
  function setJumpList(ids) {
    const all = engine()?.store?.data?.workspaces || [];
    const projects = ids.map((id) => all.find((w) => w.id === id)).filter(Boolean);
    const removed = new Set((app.getJumpListSettings().removedItems || []).map((i) => i.args));
    const items = projects
      .map((w) => ({ type: 'task', title: String(w.name || w.path).slice(0, 60), description: String(w.path).slice(0, 260), ...launch(`--orbix-jump=project:${w.id}`), iconPath: process.execPath, iconIndex: 0 }))
      .filter((i) => !removed.has(i.args));
    const sig = JSON.stringify(items.map((i) => [i.title, i.args]));
    if (sig === lastJump) return;
    lastJump = sig;
    const lists = [{ type: 'tasks', items: [{ type: 'task', title: 'New conversation', description: 'Start a new conversation in ORBIX', ...launch('--orbix-jump=new'), iconPath: process.execPath, iconIndex: 0 }] }];
    if (items.length) lists.unshift({ type: 'custom', name: 'Recent projects', items });
    try {
      if (app.setJumpList(lists) !== 'ok') app.setJumpList(lists.filter((l) => l.type === 'tasks'));
    } catch {}
  }
  setJumpList([]);
  ipcMain.on('orbix:win:recent', (e, v) => {
    const ids = recentProjects(v);
    if (ids && fromHome(e)) setJumpList(ids);
  });
  function jump(argv) {
    const j = jumpAction(argv);
    if (!j) return false;
    show();
    send('orbix:win:jump', j);
    return true;
  }

  // ---- Notifications: Open (and Approve for a one-time permission) focus the exact conversation ----
  const toasts = new Map(); // token -> { proc, ask, n }
  function act(token, approve) {
    const t = toasts.get(token);
    if (!t) return show(); // a toast from an earlier run of ORBIX: just bring the window forward
    toasts.delete(token);
    try {
      t.n.close();
    } catch {}
    const eng = engine();
    const proc = eng?.procs?.get(t.proc);
    if (approve && t.ask) {
      const msg = allowOnce(proc, t.ask);
      if (msg) return void Promise.resolve().then(() => eng.call('POST', '/api/reply', { proc: t.proc, msg })).catch(() => {});
    }
    show();
    if (proc) send('orbix:win:open', { proc: t.proc });
  }
  if (typeof Notification.handleActivation === 'function') {
    Notification.handleActivation((d) => {
      const a = toastAction(d);
      if (a) act(a.token, a.approve);
    });
  }
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const took = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);
  ipcMain.on('orbix:win:notify', (e, v) => {
    const r = notifyArgs(v);
    const w = getWin();
    if (!r || !fromHome(e) || !w || !Notification.isSupported()) return;
    // When to notify (only while ORBIX is in the background, by default) is the page's call: Settings → Notifications.
    const proc = r.kind === 'test' ? null : engine()?.procs?.get(r.proc);
    if (r.kind !== 'test' && !proc) return;
    const name = clip(String(proc?.title || 'Conversation').replace(/\s+/g, ' ').trim() || 'Conversation', 80);
    let title, body;
    let approve = false;
    if (r.kind === 'test') (title = 'ORBIX'), (body = 'This is how ORBIX gets your attention.');
    else if (r.kind === 'done') (title = 'Agent finished'), (body = r.secs >= 5 ? `${name} · worked ${took(r.secs)}` : name);
    else if (r.kind === 'error') (title = 'The agent stopped with an error'), (body = name);
    else {
      const req = proc.openUi?.get(r.ask);
      if (!req) return;
      approve = !!allowOnce(proc, r.ask);
      title = approve ? 'Approval needed' : 'The agent needs your input';
      body = `${name}\n${clip(String(req.title || '').replace(/\s+/g, ' ').trim(), 180)}`;
    }
    const token = crypto.randomBytes(16).toString('hex');
    if (!isToastToken(token)) return;
    const actions = r.kind === 'test' ? [] : [{ type: 'button', text: 'Open' }, ...(approve ? [{ type: 'button', text: 'Approve once' }] : [])];
    const n = new Notification({ id: token, title, body, silent: true, icon, actions, groupId: 'orbix' });
    if (r.kind !== 'test') toasts.set(token, { proc: r.proc, ask: r.kind === 'input' ? r.ask : '', n });
    n.on('click', () => (r.kind === 'test' ? show() : act(token, false)));
    n.on('action', (ev, index) => act(token, (typeof ev?.actionIndex === 'number' ? ev.actionIndex : index) === 1));
    n.show();
    // Never more than 50 live toasts.
    while (toasts.size > 50) toasts.delete(toasts.keys().next().value);
  });

  // ---- Settings changes Windows broadcasts (transparency effects, text size) ----
  function attach(w) {
    try {
      w.hookWindowMessage(WM_SETTINGCHANGE, refreshSoon);
    } catch {}
    w.on('focus', refreshSoon); // a missed broadcast (sleep, RDP) is caught the next time you come back
  }
  function setTitleBar(w, args) {
    titleBar = args;
    paintTitleBar();
  }
  return { attach, jump, setTitleBar };
}
