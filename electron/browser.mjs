// The built-in browser of the Windows app: the side panel's Browser tab shows pages in a <webview> with its own
// session ("persist:orbix-browser"), apart from ORBIX's window. Guests get no preload, no Node, a sandbox, and no
// permissions (camera, microphone, location, notifications); they can only show http(s) pages. Pop-ups open in the
// same view. Downloads go to the folder chosen in Settings → Browser (the Downloads folder by default).
import { app, session, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const PARTITION = 'persist:orbix-browser';
const web = (u) => /^https?:\/\//i.test(String(u || ''));
let downloads = '';

/** A free file name in `dir`: "report.pdf", then "report (1).pdf", … */
function freePath(dir, name) {
  const safe = String(name || 'download').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180) || 'download';
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const p = path.join(dir, i ? `${stem} (${i})${ext}` : safe);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

// Incognito views (the side panel's Browser → Incognito) each get an in-memory session, "orbix-incognito-<n>": no
// sign-ins shared with the default browser, and nothing written to disk.
const INCOGNITO = /^orbix-incognito-\d{1,6}$/;
const locked = new WeakSet();

/** Wire the browser sessions to the main window `win` (its page is the only one that may configure them). */
export function setupBrowser(getWin) {
  const ses = session.fromPartition(PARTITION);
  lock(ses);
  function lock(s) {
    if (locked.has(s)) return;
    locked.add(s);
    s.setPermissionRequestHandler((_wc, perm, done) => done(perm === 'fullscreen' || perm === 'clipboard-sanitized-write'));
    s.setPermissionCheckHandler((_wc, perm) => perm === 'fullscreen' || perm === 'clipboard-sanitized-write');
    s.on('will-download', (_e, item) => download(item));
  }
  function download(item) {
    let dir = downloads;
    try {
      if (!dir || !fs.statSync(dir).isDirectory()) dir = app.getPath('downloads');
    } catch {
      dir = app.getPath('downloads');
    }
    const file = freePath(dir, item.getFilename());
    item.setSavePath(file);
    item.once('done', (_ev, state) => getWin()?.webContents.send('orbix:download', { name: path.basename(file), path: file, state }));
  }

  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() === 'window') {
      // Only the page's own <webview> elements, only web pages, and always locked down.
      contents.on('will-attach-webview', (ev, prefs, params) => {
        delete prefs.preload;
        prefs.nodeIntegration = false;
        prefs.nodeIntegrationInSubFrames = false;
        prefs.contextIsolation = true;
        prefs.sandbox = true;
        prefs.webSecurity = true;
        prefs.allowRunningInsecureContent = false;
        const incog = INCOGNITO.test(String(params.partition || ''));
        params.partition = incog ? params.partition : PARTITION;
        if (incog) lock(session.fromPartition(params.partition));
        if (params.src && !web(params.src) && params.src !== 'about:blank') ev.preventDefault();
      });
    }
    if (contents.getType() === 'webview') {
      contents.setWindowOpenHandler(({ url }) => {
        if (web(url)) contents.loadURL(url);
        return { action: 'deny' };
      });
      contents.on('will-navigate', (ev, url) => !web(url) && ev.preventDefault());
      contents.on('will-redirect', (ev, url) => !web(url) && ev.preventDefault());
    }
  });

  const fromWindow = (e) => e.sender === getWin()?.webContents;
  ipcMain.handle('orbix:browser:configure', (e, cfg) => {
    if (!fromWindow(e)) return false;
    downloads = typeof cfg?.downloads === 'string' ? cfg.downloads : '';
    return true;
  });
  ipcMain.handle('orbix:browser:clear', async (e) => {
    if (!fromWindow(e)) return false;
    await ses.clearStorageData();
    await ses.clearCache();
    return true;
  });
}
