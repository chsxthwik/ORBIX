// ORBIX for Windows. The local server runs inside this process and the window shows its interface over 127.0.0.1
// with the session token. Closing the window stops the server (unless another ORBIX already ran it).
import { app, BrowserWindow, Menu, nativeTheme, shell, ipcMain, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// The installed app keeps its data in the user's profile (%LOCALAPPDATA%\ORBIX), like an npm install: the install
// folder is replaced by every update. Run from a clone (npm start), it uses the repository's data folder.
if (app.isPackaged && !process.env.ORBIX_DATA) process.env.ORBIX_DATA = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'ORBIX');

app.setAppUserModelId('com.comx.orbix'); // groups the taskbar icon and notifications under ORBIX
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let orbix = null;
let quitting = false;

const DARK = { bg: '#0A0B0D', fg: '#EDEDEA' };
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
    // The page draws its own top edge; Windows keeps the real minimize, maximize and close buttons on the right.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: c.bg, symbolColor: c.fg, height: 40 },
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      // The page picks its automatic interface size from the screen width.
      additionalArguments: [`--orbix-screen=${Math.round(screen.getPrimaryDisplay().workAreaSize.width)}`],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win.once('ready-to-show', () => {
    if (place?.maximized) win.maximize();
    win.show();
  });
  win.on('close', () => keepPlace(win));

  // Links to anything but ORBIX itself open in the default browser; the window never leaves the app.
  const origin = new URL(url).origin;
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
    if (new URL(target).origin !== origin) {
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

  win.on('closed', () => (win = null));
  win.loadURL(url);
}

// The page tells the window its theme, so the window buttons match it (light, dark, midnight, frost).
ipcMain.on('orbix:titlebar', (e, { bg, fg }) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || typeof bg !== 'string' || typeof fg !== 'string') return;
  try {
    w.setTitleBarOverlay({ color: bg, symbolColor: fg });
    w.setBackgroundColor(bg);
  } catch {}
});

async function quit() {
  if (quitting) return;
  quitting = true;
  try {
    await orbix?.stop();
  } finally {
    app.exit(0);
  }
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});
app.on('window-all-closed', () => quit());
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quit();
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  // Imported only now, so ORBIX_DATA above is set before the data folder is chosen.
  const { startOrbix } = await import('../src/app.mjs');
  orbix = await startOrbix({ onQuit: () => quit() });
  createWindow(orbix.url);
});
