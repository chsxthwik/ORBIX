// ORBIX for Windows: one desktop process, no server. The engine (src/server.mjs's AppServer, used here without HTTP)
// runs in this process; the window loads the interface from orbix://app/ (files read from the app, never over the
// network) and talks to the engine over Electron IPC. Nothing listens on a port. ORBIX Cloud (src/headless.mjs) is a
// separate program that serves the same engine over HTTPS-fronted HTTP on a machine you own.
import { app, BrowserWindow, Menu, nativeTheme, shell, ipcMain, screen, Tray, powerSaveBlocker, protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startUpdates, installOnQuit } from './updater.mjs';
import { setupBrowser } from './browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// The installed app keeps its data in the user's profile (%LOCALAPPDATA%\ORBIX), like an npm install: the install
// folder is replaced by every update. Run from a clone (npm start), it uses the repository's data folder.
if (app.isPackaged && !process.env.ORBIX_DATA) process.env.ORBIX_DATA = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'ORBIX');

// orbix://app/ is the interface: a standard, secure scheme, so 'self' in its Content-Security-Policy means it alone.
protocol.registerSchemesAsPrivileged([{ scheme: 'orbix', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }]);
const APP_URL = 'orbix://app/';
// Node gives custom schemes (and file:) the origin "null": compare orbix:// by its host, and never let "null" match.
const originOf = (u) => {
  try {
    const x = new URL(u);
    if (x.protocol === 'orbix:') return `orbix://${x.host}`;
    return x.protocol === 'http:' || x.protocol === 'https:' ? x.origin : '';
  } catch {
    return '';
  }
};

app.setAppUserModelId('com.comx.orbix'); // groups the taskbar icon and notifications under ORBIX
// One ORBIX per Windows account: a second start only brings the open window forward (it never starts an engine).
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

let win = null;
let orbix = null;
let quitting = false;

const DARK = { bg: '#151515', fg: '#E9E9E7' };
const LIGHT = { bg: '#E9E8E2', fg: '#151514' };

// The window opens where it was last closed: same size, same place, maximized or not (if that screen is still there).
const STATE = () => path.join(app.getPath('userData'), 'window.json');
function lastPlace() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE(), 'utf8'));
    const b = s.bounds;
    const seen = screen.getAllDisplays().some((d) => { const a = d.workArea; return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 8 && b.y < a.y + a.height - 80; });
    return seen && b.width >= 760 && b.height >= 520 ? s : null;
  } catch {
    return null;
  }
}
function keepPlace(w) {
  try {
    fs.writeFileSync(STATE(), JSON.stringify({ bounds: w.getNormalBounds(), maximized: w.isMaximized() }));
  } catch {}
}

function createWindow(url) {
  const c = nativeTheme.shouldUseDarkColors ? DARK : LIGHT;
  const place = lastPlace();
  win = new BrowserWindow({
    ...(place ? place.bounds : { width: 1440, height: 920 }),
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'ORBIX',
    icon: path.join(ROOT, 'assets', 'icon.ico'),
    backgroundColor: c.bg,
    // The page draws its own menu row as the title bar; Windows keeps the real minimize, maximize and close buttons
    // over its right end, at the same height.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: c.bg, symbolColor: c.fg, height: 30 },
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      // The page picks its automatic interface size from the screen width.
      additionalArguments: [`--orbix-screen=${Math.round(screen.getPrimaryDisplay().workAreaSize.width)}`],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      // The side panel's Browser tab (see browser.mjs: each <webview> is locked down when it attaches).
      webviewTag: true,
    },
  });
  win.once('ready-to-show', () => {
    if (place?.maximized) win.maximize();
    win.show();
  });
  win.on('close', () => keepPlace(win));

  // Links to anything but ORBIX itself (this PC's, or a machine you opened from Settings → Machines) open in the
  // default browser; the window never leaves the app.
  const origin = originOf(url);
  homeUrl = url;
  allowed.add(origin);
  const external = (target) => {
    try {
      const u = new URL(target);
      if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') shell.openExternal(u.href);
    } catch {}
  };
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    external(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!allowed.has(originOf(target))) {
      e.preventDefault();
      external(target);
    }
  });

  // Cut, copy, paste and spelling fixes on right-click, as in any Windows text field.
  win.webContents.on('context-menu', (_e, p) => {
    const items = [];
    for (const word of p.dictionarySuggestions.slice(0, 4)) items.push({ label: word, click: () => win.webContents.replaceMisspelling(word) });
    if (p.misspelledWord) items.push({ label: 'Add to dictionary', click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' });
    if (p.isEditable) items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' });
    else if (p.selectionText.trim()) items.push({ role: 'copy' });
    if (p.linkURL && !p.linkURL.startsWith(origin)) items.push({ type: 'separator' }, { label: 'Open link in browser', click: () => external(p.linkURL) });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  // Settings → About → Keep running in the tray: closing the window hides it; the tray icon brings it back.
  win.on('close', (e) => {
    if (tray && !quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => (win = null));
  win.loadURL(url);
}

// Settings → Machines → Open: only this PC's ORBIX may send the window to a machine (an http(s) address it gave);
// a machine's page may only send it back home.
let homeUrl = '';
const allowed = new Set();
const fromHome = (e) => !!homeUrl && originOf(e.senderFrame?.url || '') === originOf(homeUrl);
ipcMain.handle('orbix:machine:open', (e, target) => {
  if (!win || !fromHome(e)) return false;
  let u;
  try {
    u = new URL(String(target));
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  allowed.add(originOf(u.href));
  win.loadURL(u.href);
  return true;
});
ipcMain.handle('orbix:machine:home', () => {
  if (win && homeUrl) win.loadURL(homeUrl);
  return true;
});

// The page tells the window its theme, so the window buttons match it (light, dark, midnight, frost).
ipcMain.on('orbix:titlebar', (e, { bg, fg }) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || typeof bg !== 'string' || typeof fg !== 'string') return;
  try {
    w.setTitleBarOverlay({ color: bg, symbolColor: fg });
    w.setBackgroundColor(bg);
  } catch {}
});

// The page asks for attention (an agent finished or needs you): flash the taskbar button until the window is focused.
ipcMain.on('orbix:flash', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isFocused()) return;
  try {
    w.flashFrame(true);
    w.once('focus', () => w.flashFrame(false));
  } catch {}
});

// ---- Settings → About: keep the PC awake while agents work, and keep running in the tray ----
let tray = null;
let awake = null;
const showWin = () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
};
const fromWin = (e) => e.sender === win?.webContents;
ipcMain.on('orbix:keep-awake', (e, on) => {
  if (!fromWin(e)) return;
  if (on && awake == null) awake = powerSaveBlocker.start('prevent-app-suspension');
  else if (!on && awake != null) (powerSaveBlocker.stop(awake), (awake = null));
});
ipcMain.on('orbix:tray', (e, on) => {
  if (!fromWin(e)) return;
  if (on && !tray) {
    tray = new Tray(path.join(ROOT, 'assets', 'icon.ico'));
    tray.setToolTip('ORBIX');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open ORBIX', click: showWin }, { type: 'separator' }, { label: 'Quit ORBIX', click: () => quit() }]));
    tray.on('click', showWin);
  } else if (!on && tray) {
    tray.destroy();
    tray = null;
  }
});
// Windows' own notification settings for ORBIX (Settings → About → Notifications).
ipcMain.on('orbix:open-system', (e, what) => {
  if (fromWin(e) && what === 'notifications') shell.openExternal('ms-settings:notifications');
});

async function quit() {
  if (quitting) return;
  quitting = true;
  try {
    await orbix?.stop();
  } finally {
    installOnQuit(); // a downloaded update installs now, after the server has stopped
    app.exit(0);
  }
}

app.on('second-instance', () => showWin());
app.on('window-all-closed', () => quit());
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quit();
});

// The window's own requests: only the interface at orbix://app/ (not a machine's page shown in the window) may call
// the engine.
const fromApp = (e) => e.sender === win?.webContents && String(e.senderFrame?.url || '').startsWith(APP_URL);

app.whenReady().then(async () => {
  if (!primary) return;
  Menu.setApplicationMenu(null);
  startUpdates({ restart: () => quit() }); // registers its IPC handlers at once; the updater itself loads after
  setupBrowser(() => win);
  // Imported only now, so ORBIX_DATA above is set before the data folder is chosen.
  const { startDesktopEngine } = await import('../src/app.mjs');
  const { DESKTOP_CSP } = await import('../src/server.mjs');
  orbix = await startDesktopEngine({ onQuit: () => quit() });
  const engine = orbix.server;
  protocol.handle('orbix', (req) => {
    const u = new URL(req.url);
    const f = u.host === 'app' ? engine.staticFile(u.pathname) : { status: 404 };
    if (f.status !== 200) return new Response('Not found', { status: f.status, headers: { 'content-type': 'text/plain' } });
    return new Response(f.body, { status: 200, headers: { 'content-type': f.type, 'cache-control': 'no-cache', 'content-security-policy': DESKTOP_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
  });
  ipcMain.handle('orbix:api', (e, req) => {
    if (!fromApp(e)) return { ok: false, error: 'Not allowed', status: 403 };
    const { method, path: p, body, q } = req || {};
    if ((method !== 'GET' && method !== 'POST') || typeof p !== 'string' || !p.startsWith('/api/')) return { ok: false, error: 'Bad request', status: 400 };
    return engine.call(method, p, body, q);
  });
  // Events go to the window as they happen (the engine already coalesces the fast ones).
  engine.listeners.add((msg) => {
    if (win && !win.isDestroyed()) win.webContents.send('orbix:event', msg);
  });
  ipcMain.handle('orbix:hello', (e) => (fromApp(e) ? { g: 'hello', procs: engine.procList(), t: Date.now() } : null));
  createWindow(APP_URL);
});
