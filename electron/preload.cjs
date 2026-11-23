// The only bridge between the page and the Windows app: tell the page it is in the app, let it set the colour of
// the title bar to match its theme, flash the taskbar button, let it scale the interface (Settings → Appearance → Interface size), and let
// it show and drive app updates (Settings → About → Updates), and run the built-in browser's session.
// Nothing else from Electron or Node reaches the page.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// The width of the screen the window opened on, in Windows' own (scaled) pixels, passed in by the app.
const arg = process.argv.find((a) => a.startsWith('--orbix-screen='));
const screenWidth = arg ? Number(arg.slice('--orbix-screen='.length)) || 0 : 0;

// Interface size (Settings → Appearance) times Windows' text size (Settings → Accessibility → Text size).
let uiZoom = 1;
let textScale = 1;
let bar = null; // the page's last title bar colours and its height in CSS pixels
const sendBar = () => {
  if (!bar) return;
  const height = Math.max(30, Math.min(135, Math.round(bar.css * webFrame.getZoomFactor())));
  ipcRenderer.send('orbix:titlebar', { bg: bar.bg, fg: bar.fg, height });
};
const applyZoom = () => {
  webFrame.setZoomFactor(Math.min(3, Math.max(0.5, uiZoom * textScale)));
  sendBar(); // the window buttons stay as tall as the scaled menu row
};
const listen = (ch, fn) => {
  const f = (_e, v) => fn(v);
  ipcRenderer.on(ch, f);
  return () => ipcRenderer.removeListener(ch, f);
};

contextBridge.exposeInMainWorld('orbixDesktop', {
  // The engine, in the app's own process: API calls and live events over IPC (no server, no port). The main process
  // answers only the interface at orbix://app/.
  engine: {
    call: (method, path, body, q) => ipcRenderer.invoke('orbix:api', { method: String(method), path: String(path), body, q }),
    hello: () => ipcRenderer.invoke('orbix:hello'),
    onEvent: (fn) => {
      const f = (_e, msg) => fn(msg);
      ipcRenderer.on('orbix:event', f);
      return () => ipcRenderer.removeListener('orbix:event', f);
    },
  },
  // For Settings → About and bug reports.
  versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
  screenWidth,
  setTitleBar: (bg, fg, cssHeight = 40) => {
    bar = { bg: String(bg), fg: String(fg), css: Number(cssHeight) || 40 };
    sendBar();
  },
  // Flash the taskbar button until the window is focused (Settings → Notifications).
  flash: () => ipcRenderer.send('orbix:flash'),
  setZoom: (factor) => {
    uiZoom = Math.min(2, Math.max(0.5, Number(factor) || 1));
    applyZoom();
  },
  // Settings → About: keep the PC awake while agents work, keep running in the tray, Windows' notification settings.
  system: {
    keepAwake: (kind) => ipcRenderer.send('orbix:keep-awake', kind === 'screen' || kind === 'work' ? kind : kind === true ? 'work' : ''),
    tray: (on) => ipcRenderer.send('orbix:tray', on === true),
    openNotifications: () => ipcRenderer.send('orbix:open-system', 'notifications'),
  },
  // The built-in browser (side panel → Browser): its own session, downloads and site data (Settings → Browser).
  browser: {
    configure: (cfg) => ipcRenderer.invoke('orbix:browser:configure', { downloads: typeof cfg?.downloads === 'string' ? cfg.downloads : '' }),
    clearData: () => ipcRenderer.invoke('orbix:browser:clear'),
    onDownload: (fn) => {
      const f = (_e, d) => fn(d);
      ipcRenderer.on('orbix:download', f);
      return () => ipcRenderer.removeListener('orbix:download', f);
    },
  },
  // Settings → Machines: show another ORBIX (a machine you own) in this window, and come back to this PC.
  machines: {
    open: (url) => ipcRenderer.invoke('orbix:machine:open', String(url)),
    home: () => ipcRenderer.invoke('orbix:machine:home'),
  },
  updates: {
    get: () => ipcRenderer.invoke('orbix:update:get'),
    check: () => ipcRenderer.invoke('orbix:update:check'),
    setAuto: (on) => ipcRenderer.invoke('orbix:update:auto', on === true),
    restart: () => ipcRenderer.invoke('orbix:update:restart'),
    onChange: (fn) => {
      const f = (_e, st) => fn(st);
      ipcRenderer.on('orbix:update', f);
      return () => ipcRenderer.removeListener('orbix:update', f);
    },
  },
  // Windows only: Mica, accent colour, high contrast, text size, taskbar, jump list and notifications.
  windows: process.platform === 'win32' ? {
    ready: () => ipcRenderer.invoke('orbix:win:ready'),
    onState: (fn) => listen('orbix:win:state', fn),
    onJump: (fn) => listen('orbix:win:jump', fn),
    onOpen: (fn) => listen('orbix:win:open', fn),
    // Follow Windows' text size or not (Settings → Appearance).
    textScale: (n) => {
      textScale = Math.min(2.25, Math.max(1, Number(n) || 1));
      applyZoom();
    },
    theme: (src) => ipcRenderer.send('orbix:win:theme', src === 'dark' || src === 'light' ? src : 'system'),
    progress: (working, waiting) => ipcRenderer.send('orbix:win:progress', { working: Math.trunc(Number(working)) || 0, waiting: Math.trunc(Number(waiting)) || 0 }),
    recent: (ids) => ipcRenderer.send('orbix:win:recent', Array.isArray(ids) ? ids.slice(0, 20).map(String) : []),
    notify: (n) => ipcRenderer.send('orbix:win:notify', { kind: String(n?.kind || ''), proc: String(n?.proc || ''), ask: String(n?.ask || ''), secs: Math.trunc(Number(n?.secs)) || 0 }),
  } : null,
});
