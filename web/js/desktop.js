// In the Windows app: the page draws the top of the window (the menu row). It marks itself as the app (html.desktop),
// and keeps the window buttons in the menu row's colour as the theme changes. In a browser this does nothing.
// On Windows it also follows the system: Mica behind the sidebar, the accent colour (optional), high contrast, text
// size and light/dark, and drives the taskbar (progress, the amber "needs you" dot, the jump list) and notifications.
import { S, on, emit } from './store.js';
import { H } from './shell.js';

const bridge = window.orbixDesktop;
const win = bridge?.windows || null;
let winState = null;

/** Windows' state as the app last heard it (null outside the Windows app). */
export const windowsState = () => winState;

/** Any CSS colour as #rrggbb (computed colours come back as rgb(), color(srgb …) or color-mix results). */
const probe = document.createElement('canvas');
probe.width = probe.height = 1;
const pctx = probe.getContext('2d', { willReadFrequently: true });
function toHex(css) {
  pctx.clearRect(0, 0, 1, 1);
  pctx.fillStyle = '#000';
  pctx.fillStyle = css;
  pctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = pctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

if (bridge) {
  const root = document.documentElement;
  root.classList.add('desktop');
  let last = '';
  let queued = false;
  const sync = () => {
    queued = false;
    const css = getComputedStyle(root);
    const bg = getComputedStyle(document.getElementById('menubar') || root).backgroundColor || css.getPropertyValue('--bg').trim();
    const fg = css.getPropertyValue('--fg-2').trim();
    if (!bg || !fg) return;
    const [hb, hf] = [toHex(bg), toHex(fg)];
    const height = parseFloat(css.getPropertyValue('--mb-h')) || 30;
    if (`${hb}|${hf}|${height}` === last) return;
    last = `${hb}|${hf}|${height}`;
    bridge.setTitleBar(hb, hf, height);
  };
  const later = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(sync);
    }
  };
  // Themes are applied as attributes on <html>; the system light or dark setting can change them too.
  new MutationObserver(later).observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-mode', 'style', 'class'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', later);
  later();
}

if (win) {
  const root = document.documentElement;
  // A constructed stylesheet: the app's content security policy blocks <style> elements written by script.
  const accentSheet = new CSSStyleSheet();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, accentSheet];

  const onColor = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#0B0B0E' : '#FFFFFF';
  };
  // Apply what Windows says, filtered by Settings → Appearance → Windows.
  const apply = () => {
    const st = winState;
    if (!st) return;
    const u = S.ui || {};
    // Mica shows through the window's own surfaces only: not under a scene theme, which paints its own picture.
    root.classList.toggle('win-mica', !!st.mica && u.winMica !== false && !root.dataset.scene);
    root.classList.toggle('win-hc', !!st.highContrast);
    const accent = u.winAccent === true && !st.highContrast && /^#[\da-f]{6}$/i.test(st.accent || '') ? st.accent : '';
    root.classList.toggle('win-accent', !!accent);
    // :not(#_) outranks the themes' own accent; your own colours (inline on <html>) still win.
    accentSheet.replaceSync(accent ? `html:not(#_).win-accent{--accent:${accent};--accent-solid:${accent};--accent-soft:color-mix(in srgb,${accent} 13%,transparent);--accent-line:color-mix(in srgb,${accent} 45%,transparent);--on-accent:${onColor(accent)}}` : '');
    win.textScale(u.winTextSize === false ? 1 : st.textScale);
    // Mica, the window buttons and menus follow the theme's light or dark, or Windows itself under the System theme.
    const theme = u.theme || 'system';
    win.theme(theme === 'system' ? 'system' : root.dataset.mode === 'light' ? 'light' : 'dark');
  };
  win.onState((st) => {
    winState = st;
    apply();
    emit('windows');
  });
  on('prefs', apply);
  new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['data-mode', 'data-scene'] });

  // Taskbar: an indeterminate bar while agents work, the amber dot and a paused bar while one waits for you.
  let bar = '';
  const progress = () => {
    const live = [...S.tabs.values()].filter((t) => !t.dead);
    const waiting = live.filter((t) => t.dialogs?.length).length;
    const working = live.filter((t) => t.streaming).length;
    if (`${working}|${waiting}` === bar) return;
    bar = `${working}|${waiting}`;
    win.progress(working, waiting);
  };
  for (const ev of ['tabs', 'tab:status', 'tab:dialog', 'tab:state']) on(ev, progress);

  // Jump list: projects in the order of their newest conversation.
  let recentSig = '';
  const recent = () => {
    const key = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
    const byPath = new Map((S.workspaces || []).map((w) => [key(w.path), w.id]));
    const ids = [];
    for (const s of [...(S.sessions || [])].sort((a, b) => b.mtime - a.mtime)) {
      const id = byPath.get(key(s.cwdDisplay || s.cwd));
      if (id && !ids.includes(id)) ids.push(id);
      if (ids.length === 6) break;
    }
    const sig = ids.join();
    if (sig !== recentSig) win.recent((recentSig = sig, ids));
  };
  on('sessions', recent);
  on('engine', recent);

  const jump = (j) => {
    if (!j) return;
    if (j.kind === 'new') return H.newSession?.();
    const w = (S.workspaces || []).find((x) => x.id === j.id);
    if (w) H.newSession?.(w.path);
  };
  win.onJump(jump);
  // A notification's Open: the exact conversation it was about.
  win.onOpen(({ proc } = {}) => proc && emit('open-tab', proc));

  // The page may still be booting: run the launch jump once the shell is ready.
  win.ready().then((r) => {
    if (!r) return;
    winState = r.state;
    apply();
    emit('windows');
    if (r.jump) {
      const go = () => (H.newSession ? jump(r.jump) : setTimeout(go, 100));
      go();
    }
  });
}
