// Tells you when the agent finishes or needs you: a Windows notification, a taskbar flash in the app, and a short
// sound, each switchable in Settings → Notifications. By default only while ORBIX is in the background.
import { S, on, emit } from './store.js';
import { toast } from './dom.js';

const was = new Map(); // tab id -> was streaming
const started = new Map(); // tab id -> when the current turn began
let asked = false;

/** The notification settings, with their defaults. */
export const notifyPrefs = () => ({ done: true, input: true, errors: true, onlyAway: true, inApp: false, sound: true, flash: true, volume: 0.8, ...(S.ui.notify || {}) });

/** In-app notifications: a toast when another conversation (not the one you are looking at) finishes or needs you. */
function inApp(tab, text) {
  if (!notifyPrefs().inApp || away() || S.active === tab.id) return;
  toast(text, 'info', 5000);
  emit('chrome');
}

/** A soft two-note chime, made on the spot (no sound file). `volume` 0 to 1 (Settings → Notifications → Volume). */
export function chime(volume = notifyPrefs().volume) {
  const peak = 0.15 * Math.max(0, Math.min(1, Number(volume)));
  if (!(peak > 0)) return;
  try {
    const ac = new AudioContext();
    const t = ac.currentTime;
    for (const [i, f] of [660, 880].entries()) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(peak, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.35);
      o.connect(g).connect(ac.destination);
      o.start(t + i * 0.12);
      o.stop(t + i * 0.12 + 0.4);
    }
    setTimeout(() => ac.close().catch(() => {}), 900);
  } catch {}
}

/**
 * Get your attention in every way you allowed. `force` skips the "only in the background" rule (the test button).
 * `meta` ({ kind, proc, ask, secs }) lets the Windows app show its own notification instead, with Open and Approve
 * buttons that go straight to the conversation; it writes the text itself from what the engine knows.
 */
export function attention(title, body, { force = false, meta = null } = {}) {
  const p = notifyPrefs();
  if (!force && p.onlyAway && !away()) return false;
  const win = window.orbixDesktop?.windows;
  try {
    if (win && meta) win.notify(meta);
    else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body, silent: true, tag: 'orbix' });
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
      // A turn that ended on an error says so (Settings → Notifications → When something fails), not "finished".
      const last = (tab.messages || []).findLast((m) => m.role === 'assistant');
      if (!tab.dead && last?.stopReason === 'error') {
        if (notifyPrefs().errors) {
          const why = String(last.errorMessage || 'The request failed.').slice(0, 140);
          attention('The agent stopped with an error', `${tab.name}: ${why}`, { meta: { kind: 'error', proc: tab.id } });
          inApp(tab, `Failed: ${tab.name}`);
        }
      } else if (!tab.dead && notifyPrefs().done) {
        attention('Agent finished', secs >= 5 ? `${tab.name} · worked ${took(secs)}` : tab.name, { meta: { kind: 'done', proc: tab.id, secs } });
        inApp(tab, `Finished: ${tab.name}`);
      }
    }
  });
  on('tab:dialog', (tab) => {
    const d = tab.dialogs[0];
    if (d && notifyPrefs().input) attention('The agent needs your input', d.title || tab.name, { meta: { kind: 'input', proc: tab.id, ask: d.id } });
    if (tab.dialogs.length && notifyPrefs().input) inApp(tab, `Needs you: ${tab.name}`);
  });
}
