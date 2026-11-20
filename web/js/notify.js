// Tells you when the agent finishes or needs you: a Windows notification, a taskbar flash in the app, and a short
// sound, each switchable in Settings → Notifications. By default only while ORBIX is in the background.
import { S, on } from './store.js';

const was = new Map(); // tab id -> was streaming
const started = new Map(); // tab id -> when the current turn began
let asked = false;

/** The notification settings, with their defaults. */
export const notifyPrefs = () => ({ done: true, input: true, onlyAway: true, sound: true, flash: true, ...(S.ui.notify || {}) });

/** A soft two-note chime, made on the spot (no sound file). */
function chime() {
  try {
    const ac = new AudioContext();
    const t = ac.currentTime;
    for (const [i, f] of [660, 880].entries()) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.35);
      o.connect(g).connect(ac.destination);
      o.start(t + i * 0.12);
      o.stop(t + i * 0.12 + 0.4);
    }
    setTimeout(() => ac.close().catch(() => {}), 900);
  } catch {}
}

/** Get your attention in every way you allowed. `force` skips the "only in the background" rule (the test button). */
export function attention(title, body, { force = false } = {}) {
  const p = notifyPrefs();
  if (!force && p.onlyAway && !away()) return false;
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body, silent: true, tag: 'orbix' });
  } catch {}
  if (p.sound) chime();
  if (p.flash) window.orbixDesktop?.flash?.();
  return true;
}

/** Whether Windows lets ORBIX show notifications: granted, denied, or not asked yet. */
export const notifyPermission = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
export const askNotifyPermission = () => (typeof Notification === 'undefined' ? Promise.resolve('unsupported') : Notification.requestPermission());

const away = () => document.hidden || !document.hasFocus();
const took = (secs) => (secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`);

export function initNotify() {
  // Ask once, on the first click (browsers only allow permission prompts after a gesture).
  addEventListener('pointerdown', () => {
    if (asked || typeof Notification === 'undefined' || Notification.permission !== 'default') return;
    asked = true;
    try {
      Notification.requestPermission();
    } catch {}
  });

  on('tab:status', (tab) => {
    const before = was.get(tab.id);
    was.set(tab.id, tab.streaming);
    if (tab.streaming && !before) started.set(tab.id, tab.turnStartedAt || Date.now());
    if (before && !tab.streaming) {
      const secs = Math.round((Date.now() - (started.get(tab.id) || Date.now())) / 1000);
      started.delete(tab.id);
      if (!tab.dead && notifyPrefs().done) attention('Agent finished', secs >= 5 ? `${tab.name} · worked ${took(secs)}` : tab.name);
    }
  });
  on('tab:dialog', (tab) => {
    if (tab.dialogs.length && notifyPrefs().input) attention('The agent needs your input', tab.dialogs[0].title || tab.name);
  });
}
