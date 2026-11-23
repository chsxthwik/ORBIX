import { readJson, writeJson } from '../src/util.mjs';
import { fitBounds, restorePlace } from './windows-input.mjs';

export function windowPlacement(screen, file) {
  const saved = readJson(file, {});
  const state = { last: saved?.last, monitors: { ...saved?.monitors } };
  const place = restorePlace({ ...saved, ...state }, screen.getAllDisplays(), screen.getPrimaryDisplay(),
    (bounds) => screen.getDisplayMatching(bounds));
  let current = place.display;
  let window;
  let timer;
  let relocating = false;
  const remember = () => {
    if (!window || window.isDestroyed() || window.isMinimized() || window.isFullScreen() || relocating) return;
    const d = screen.getDisplayMatching(window.getBounds());
    current = d;
    state.last = String(d.id);
    state.monitors[state.last] = { bounds: fitBounds(window.getNormalBounds(), d.workArea), area: d.workArea, maximized: window.isMaximized() };
    try { writeJson(file, state); } catch {}
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(remember, 220);
  };
  const fit = (display) => {
    if (!window || window.isDestroyed() || window.isFullScreen()) return;
    const maximize = window.isMaximized() || state.monitors[String(current.id)]?.maximized === true && window.isMinimized();
    const record = state.monitors[String(display.id)];
    const bounds = fitBounds(record?.bounds || window.getNormalBounds(), display.workArea, record?.area || current.workArea);
    const minimum = [Math.min(760, display.workArea.width), Math.min(520, display.workArea.height)];
    relocating = true;
    window.setMinimumSize(...minimum);
    if (window.isMinimized()) {
      // Windows moves minimized windows itself. Correct the normal rectangle when it is restored.
      relocating = false;
      window.once('restore', () => fit(display));
      return;
    }
    if (window.isMaximized()) window.unmaximize();
    window.setBounds(bounds);
    if (maximize) window.maximize();
    current = display;
    relocating = false;
    later();
  };
  const removed = (_event, display) => {
    if (display.id === current.id) fit(screen.getPrimaryDisplay());
  };
  const metrics = (_event, display, changed) => {
    if (display.id !== current.id || !changed.includes('workArea') && !changed.includes('bounds')) return;
    const old = window.getNormalBounds();
    const b = fitBounds(old, display.workArea);
    if (Object.keys(b).some((k) => b[k] !== old[k])) fit(display);
    else current = display;
  };
  return {
    place,
    remember,
    attach(w) {
      window = w;
      for (const name of ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'show']) w.on(name, later);
      w.on('close', remember);
      screen.on('display-removed', removed);
      screen.on('display-metrics-changed', metrics);
      w.once('closed', () => {
        clearTimeout(timer);
        screen.off('display-removed', removed);
        screen.off('display-metrics-changed', metrics);
      });
    },
  };
}
