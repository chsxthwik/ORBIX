// App updates, as the page sees them. The Windows app checks GitHub, downloads in the background and installs on
// close (electron/updater.mjs); this keeps its status in S.update, says once when an update is ready, and restarts
// into it on request. In a browser, or run from a clone, there are no updates and S.update stays null.
import { h, toast } from './dom.js';
import { S, emit } from './store.js';
import { confirmDialog } from './dialogs.js';

const bridge = window.orbixDesktop?.updates;
let told = '';

function take(st) {
  if (!st || typeof st !== 'object') return;
  const was = S.update;
  S.update = st;
  // Said once per version: the sidebar keeps showing it after the toast is gone.
  if (st.state === 'ready' && told !== st.version) {
    told = st.version;
    toast(`ORBIX ${st.version} is ready. Restart to update, or it installs when you close ORBIX.`, 'ok', 9000);
  }
  if (st.manual && was?.state === 'checking' && st.state === 'latest') toast(`ORBIX ${st.current} is the newest version.`, 'ok', 3200);
  if (st.manual && was?.state === 'checking' && st.state === 'error') toast(st.error, 'error', 7000);
  emit('update', st);
}

if (bridge) {
  bridge.onChange(take);
  bridge.get().then(take, () => {});
}

export const updatesSupported = () => !!bridge && !!S.update && S.update.state !== 'off';

export const checkForUpdates = () => bridge?.check().then(take, (e) => toast(e.message, 'error'));

export const setAutoUpdates = (on) => bridge?.setAuto(on).then(take, (e) => toast(e.message, 'error'));

/** Restart into the downloaded update. Sessions that are working or waiting for an OK stop first, so ask. */
export async function restartToUpdate() {
  if (S.update?.state !== 'ready') return;
  const busy = [...S.tabs.values()].filter((t) => !t.dead && (t.streaming || t.dialogs?.length)).length;
  if (busy && !(await confirmDialog(`Update to ORBIX ${S.update.version}`, `${busy === 1 ? 'A session is' : `${busy} sessions are`} still working. Restarting stops ${busy === 1 ? 'it' : 'them'} now; you can open ${busy === 1 ? 'it' : 'them'} again from the sidebar after the update.`, { ok: 'Restart and update' }))) return;
  toast('Installing the update. ORBIX opens again in a few seconds.', 'info', 20000);
  bridge.restart().catch((e) => toast(e.message, 'error'));
}

/** One line for Settings → About: where the update stands. */
export function updateLine(st = S.update) {
  if (!st) return '';
  const when = st.checkedAt ? ` Checked ${new Date(st.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : '';
  switch (st.state) {
    case 'checking': return 'Checking GitHub for a new version…';
    case 'downloading': return `Downloading ORBIX ${st.version}… ${st.percent || 0}%`;
    case 'ready': return 'Downloaded and checked. It installs when you restart or close ORBIX.';
    case 'latest': return `You have the newest version.${when}`;
    case 'error': return `${st.error}${when}`;
    default: return st.auto ? 'ORBIX checks for a new version a little after it opens and every 4 hours.' : 'Automatic checks are off.';
  }
}

/** The sidebar's button while an update is downloading or ready; nothing otherwise. */
export function sideUpdate(iconEl) {
  const st = S.update;
  if (!st || (st.state !== 'ready' && st.state !== 'downloading')) return null;
  const ready = st.state === 'ready';
  return h('button', {
    class: 'side-update' + (ready ? ' ready' : ''),
    type: 'button',
    title: ready ? `ORBIX ${st.version} is ready. Restart to install it (it also installs when you close ORBIX).` : `Downloading ORBIX ${st.version}`,
    disabled: ready ? null : true,
    onclick: ready ? () => restartToUpdate() : null,
    style: ready ? null : { '--p': `${st.percent || 0}%` },
  }, iconEl, h('span', { class: 'ell' }, ready ? `Update to ${st.version}` : `Downloading ${st.version}`), h('span', { class: 'su-k' }, ready ? 'Restart' : `${st.percent || 0}%`));
}
