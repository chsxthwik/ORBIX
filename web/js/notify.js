// Tells you when the agent finishes or needs you while the window is in the background:
// a Windows notification (best effort) plus a taskbar flash (via the native host).
import { on } from './store.js';

const was = new Map(); // tab id -> was streaming
let asked = false;

function attention(title, body) {
  try {
    window.chrome?.webview?.postMessage('attention');
  } catch {}
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body, silent: false, tag: 'orbix' });
  } catch {}
}

const away = () => document.hidden || !document.hasFocus();

export function initNotify() {
  // Ask once, on the first click (browsers only allow permission prompts after a gesture).
  addEventListener('pointerdown', () => {
    if (asked || typeof Notification === 'undefined' || Notification.permission !== 'default') return;
    asked = true;
    try {
      Notification.requestPermission();
    } catch {}
  }, { once: false });

  on('tab:status', (tab) => {
    const before = was.get(tab.id);
    was.set(tab.id, tab.streaming);
    if (before && !tab.streaming && !tab.dead && away()) attention('Agent finished', tab.name);
  });
  on('tab:dialog', (tab) => {
    if (tab.dialogs.length && away()) attention('The agent needs your input', tab.dialogs[0].title || tab.name);
  });
}
