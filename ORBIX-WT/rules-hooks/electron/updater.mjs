// Updates for the installed app. ORBIX looks for a new release on GitHub a little after it opens and every few
// hours, downloads it in the background, and installs it when you close ORBIX or press Restart. The download is
// checked against the SHA-512 in the release's latest.yml before it can run. Run from a clone (npm start), there
// are no updates: git pull is the update.
import { app, ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const FIRST_CHECK = 15_000;
const EVERY = 4 * 60 * 60_000;
const PREFS = () => path.join(app.getPath('userData'), 'update.json');
const LOG = () => path.join(app.getPath('userData'), 'update.log');

let updater = null;
let timer = null;
let relaunch = false;
let restartApp = () => {};
let auto = readAuto();

/** What the page shows. state: off | idle | checking | latest | downloading | ready | error. */
let st = { state: 'off', current: app.getVersion(), version: null, percent: 0, error: null, checkedAt: 0, auto, manual: false };

function readAuto() {
  try {
    return JSON.parse(fs.readFileSync(PREFS(), 'utf8')).auto !== false;
  } catch {
    return true;
  }
}

// A short log next to the window settings, so a failed update can be explained later. Kept under 256 KB.
function log(level, msg) {
  try {
    const f = LOG();
    if (fs.existsSync(f) && fs.statSync(f).size > 256 * 1024) fs.renameSync(f, f + '.old');
    fs.appendFileSync(f, `${new Date().toISOString()} ${level} ${String(msg).split('\n')[0].slice(0, 400)}\n`);
  } catch {}
}
const logger = { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m), debug: () => {} };

function set(patch) {
  st = { ...st, ...patch };
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('orbix:update', st);
}

/** Error text a person can act on, instead of a stack trace from the HTTP client. */
function plain(e) {
  const m = String(e?.message || e || '');
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NETWORK|ERR_NAME_NOT_RESOLVED|net::/i.test(m)) return 'Could not reach GitHub. Check your internet connection and try again.';
  if (/latest\.yml|status ?code:? ?404|HttpError: 404/i.test(m)) return 'The newest release on GitHub has no Windows update yet. Try again later.';
  if (/403|rate limit/i.test(m)) return 'GitHub is limiting requests right now. Try again in an hour.';
  if (/sha512 checksum mismatch/i.test(m)) return 'The download was damaged, so it was thrown away. Check again to retry.';
  if (/ENOSPC/i.test(m)) return 'There is not enough free disk space to download the update.';
  return m.split('\n')[0].slice(0, 200) || 'The update check failed.';
}

async function check(manual = false) {
  if (!updater || ['checking', 'downloading', 'ready'].includes(st.state)) return st;
  set({ state: 'checking', error: null, manual });
  try {
    const r = await updater.checkForUpdates();
    // A newer version starts downloading from the update-available event; nothing newer ends here.
    if (!r?.isUpdateAvailable && st.state === 'checking') set({ state: 'latest', checkedAt: Date.now() });
  } catch (e) {
    log('error', e?.stack || e);
    set({ state: 'error', error: plain(e), checkedAt: Date.now() });
  }
  return st;
}

function schedule() {
  clearInterval(timer);
  timer = null;
  if (auto && updater) timer = setInterval(() => check(false), EVERY);
}

/**
 * Starts the updater in the installed app. `restart` quits ORBIX the normal way (sessions stopped, server closed);
 * installOnQuit() then starts the installer as the last step.
 */
export async function startUpdates({ restart }) {
  restartApp = restart;
  ipcMain.handle('orbix:update:get', () => st);
  ipcMain.handle('orbix:update:check', () => check(true));
  ipcMain.handle('orbix:update:auto', (_e, on) => {
    auto = on !== false;
    try {
      fs.writeFileSync(PREFS(), JSON.stringify({ auto }));
    } catch {}
    set({ auto });
    schedule();
    return st;
  });
  ipcMain.handle('orbix:update:restart', () => {
    if (st.state !== 'ready') return false;
    relaunch = true;
    setImmediate(() => restartApp());
    return true;
  });

  if (!app.isPackaged || process.env.ORBIX_NO_UPDATES === '1') return;
  try {
    const { NsisUpdater } = (await import('electron-updater')).default;
    updater = new NsisUpdater();
  } catch (e) {
    log('error', `updater unavailable: ${e?.message || e}`);
    return;
  }
  updater.logger = logger;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false; // ORBIX installs from its own quit (installOnQuit), after its server stops
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  updater.on('update-available', (i) => set({ state: 'downloading', version: i.version, percent: 0, error: null }));
  updater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.max(0, Math.min(100, Math.round(p.percent || 0))) }));
  updater.on('update-downloaded', (i) => set({ state: 'ready', version: i.version, percent: 100, error: null, checkedAt: Date.now() }));
  updater.on('error', (e) => {
    log('error', e?.stack || e);
    if (st.state !== 'ready') set({ state: 'error', error: plain(e), checkedAt: Date.now() });
  });
  set({ state: 'idle' });
  if (auto) setTimeout(() => check(false), FIRST_CHECK).unref?.();
  schedule();
}

/** The last step of quitting: a downloaded update installs now, silently, and reopens ORBIX if Restart asked for it. */
export function installOnQuit() {
  if (!updater || st.state !== 'ready') return;
  try {
    log('info', `installing ${st.version}${relaunch ? ' and reopening' : ''}`);
    updater.install(true, relaunch);
  } catch (e) {
    log('error', e?.stack || e);
  }
}
