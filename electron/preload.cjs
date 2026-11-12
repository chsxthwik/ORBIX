// The only bridge between the page and the Windows app: tell the page it is in the app, let it set the colour of
// the title bar to match its theme, and let it scale the interface (Settings → Appearance → Interface size).
// Nothing else from Electron or Node reaches the page.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// The width of the screen the window opened on, in Windows' own (scaled) pixels, passed in by the app.
const arg = process.argv.find((a) => a.startsWith('--orbix-screen='));
const screenWidth = arg ? Number(arg.slice('--orbix-screen='.length)) || 0 : 0;

contextBridge.exposeInMainWorld('orbixDesktop', {
  platform: process.platform,
  screenWidth,
  setTitleBar: (bg, fg) => ipcRenderer.send('orbix:titlebar', { bg: String(bg), fg: String(fg) }),
  setZoom: (factor) => webFrame.setZoomFactor(Math.min(2, Math.max(0.5, Number(factor) || 1))),
});
