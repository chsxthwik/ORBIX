// The only bridge between the page and the Windows app: tell the page it is in the app, let it set the colour of
// the title bar to match its theme, flash the taskbar button, let it scale the interface (Settings → Appearance → Interface size), and let
// it show and drive app updates (Settings → Application → Updates), and run the built-in browser's session.
// Nothing else from Electron or Node reaches the page.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// The width of the screen the window opened on, in Windows' own (scaled) pixels, passed in by the app.
const arg = process.argv.find((a) => a.startsWith('--orbix-screen='));
const screenWidth = arg ? Number(arg.slice('--orbix-screen='.length)) || 0 : 0;

contextBridge.exposeInMainWorld('orbixDesktop', {
  // For Settings → Application and bug reports.
  versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
  screenWidth,
  setTitleBar: (bg, fg) => ipcRenderer.send('orbix:titlebar', { bg: String(bg), fg: String(fg) }),
  // Flash the taskbar button until the window is focused (Settings → Notifications).
  flash: () => ipcRenderer.send('orbix:flash'),
  setZoom: (factor) => webFrame.setZoomFactor(Math.min(2, Math.max(0.5, Number(factor) || 1))),
  // Settings → Application: keep the PC awake while agents work, keep running in the tray, Windows' notification settings.
  system: {
    keepAwake: (on) => ipcRenderer.send('orbix:keep-awake', on === true),
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
});
