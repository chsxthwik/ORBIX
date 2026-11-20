// Tells you when the agent finishes or needs you while the window is in the background:
// a Windows notification (best effort) plus a taskbar flash (via the native host).
import { on } from './store.js';

const was = new Map(); // tab id -> was streaming
const started = new Map(); // tab id -> when the current turn began
let asked = false;

function attention(title, body) {
  try {
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
    if (tab.streaming && !before) started.set(tab.id, tab.turnStartedAt || Date.now());
    if (before && !tab.streaming) {
      const secs = Math.round((Date.now() - (started.get(tab.id) || Date.now())) / 1000);
      started.delete(tab.id);
      if (!tab.dead && away()) attention('Agent finished', secs >= 5 ? `${tab.name} · worked ${secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`}` : tab.name);
    }
  });
  on('tab:dialog', (tab) => {
    if (tab.dialogs.length && away()) attention('The agent needs your input', tab.dialogs[0].title || tab.name);
  });
}
