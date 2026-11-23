// Pure parsing and geometry for the Windows shell. No Electron APIs here so the trust boundaries are testable.
const HEX = /^#[\da-f]{6}$/i;
const ID = /^[a-z\d][a-z\d-]{0,63}$/i;
const TOKEN = /^[a-f\d]{32}$/;

export function titleBarArgs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { bg, fg, height } = value;
  return typeof bg === 'string' && HEX.test(bg) && typeof fg === 'string' && HEX.test(fg) &&
    Number.isInteger(height) && height >= 30 && height <= 135 ? { bg, fg, height } : null;
}

export function isWindowsHome(event, contents, url, platform = process.platform) {
  const frame = event.senderFrame;
  return platform === 'win32' && !!contents && event.sender === contents &&
    !!frame && frame.parent === null && frame.url === url;
}

export const projectId = (value) => typeof value === 'string' && ID.test(value) ? value : null;

export function jumpAction(argv) {
  if (!Array.isArray(argv)) return null;
  const args = argv.filter((x) => typeof x === 'string' && x.startsWith('--orbix-jump='));
  if (args.length !== 1) return null;
  if (args[0] === '--orbix-jump=new') return { kind: 'new' };
  const id = projectId(/^--orbix-jump=project:([a-z\d-]+)$/i.exec(args[0])?.[1]);
  return id ? { kind: 'project', id } : null;
}

export function toastAction(details) {
  if (!details || typeof details.arguments !== 'string' || details.arguments.length > 64) return null;
  const m = /^type=action&action=([01])&tag=([a-f\d]{32})$/.exec(details.arguments);
  return m && details.type === 'action' && details.actionIndex === Number(m[1]) ? { token: m[2], approve: m[1] === '1' } : null;
}

export const isToastToken = (value) => typeof value === 'string' && TOKEN.test(value);

// Never turn a question, persistent permission or a stale toast into a grant.
export function allowOnce(proc, id) {
  const request = proc?.openUi?.get(id);
  return proc?.pendingAsk?.has(id) && request?.method === 'select' &&
    Array.isArray(request.options) && request.options.includes('Allow once') && request.options.includes('Deny')
    ? { type: 'extension_ui_response', id, value: 'Allow once' } : null;
}

export function registryDword(output, name) {
  const row = String(output).split(/\r?\n/).map((line) => line.trim().split(/\s+/))
    .find(([key, type, value, ...rest]) => key === name && type === 'REG_DWORD' && /^0x[\da-f]{1,8}$/i.test(value) && !rest.length);
  return row ? Number(row[2]) : null;
}

const count = (n) => (Number.isInteger(n) && n >= 0 && n <= 999 ? n : null);

/** Taskbar state from the page: how many conversations work, how many wait for you. */
export function progressArgs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const working = count(value.working);
  const waiting = count(value.waiting);
  return working === null || waiting === null ? null : { working, waiting };
}

const PROC = /^p[a-z\d]{4,40}$/;
const ASK = /^[\w:.-]{1,80}$/;
/** A notification request from the page. Text is never taken from it: the main process writes it from the engine. */
export function notifyArgs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { kind, proc, ask, secs } = value;
  if (kind === 'test') return { kind };
  if (!['done', 'error', 'input'].includes(kind) || typeof proc !== 'string' || !PROC.test(proc)) return null;
  if (kind === 'input') return typeof ask === 'string' && ASK.test(ask) ? { kind, proc, ask } : null;
  return { kind, proc, secs: Number.isInteger(secs) && secs >= 0 && secs < 1e7 ? secs : 0 };
}

/** Which colour scheme the window (Mica, the title bar buttons, menus) follows. */
export const themeSource = (value) => (value === 'system' || value === 'dark' || value === 'light' ? value : null);

/** The page's most recent projects, by id only (names and paths come from the engine's own list). */
export function recentProjects(value) {
  if (!Array.isArray(value) || value.length > 20) return null;
  const ids = value.map(projectId);
  return ids.every(Boolean) ? [...new Set(ids)].slice(0, 6) : null;
}

/** A 32-bit BGRA bitmap of an amber dot with a soft edge, for the taskbar overlay icon. */
export function amberDot(size = 16) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const a = Math.max(0, Math.min(1, r + 0.5 - d));
      const ring = d > r - 1.6; // a dark rim so the dot reads on a light taskbar too
      const i = (y * size + x) * 4;
      // Premultiplied, as Windows expects for 32-bit icons.
      const [R, G, B] = ring ? [0x8a, 0x55, 0x00] : [0xf5, 0xa5, 0x24];
      buf[i] = Math.round(B * a);
      buf[i + 1] = Math.round(G * a);
      buf[i + 2] = Math.round(R * a);
      buf[i + 3] = Math.round(255 * a);
    }
  }
  return buf;
}

/** '#rrggbb' from Electron's 'rrggbbaa' accent colour, or null. */
export const accentHex = (v) => (typeof v === 'string' && /^[\da-f]{6}([\da-f]{2})?$/i.test(v) ? `#${v.slice(0, 6).toLowerCase()}` : null);

export const supportsMica = (release) => Number(/^10\.0\.(\d+)/.exec(release)?.[1]) >= 22621;

const rect = (b) => !!b && ['x', 'y', 'width', 'height'].every((k) => Number.isSafeInteger(b[k]) && Math.abs(b[k]) <= 100_000) &&
  b.width > 0 && b.height > 0;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export function fitBounds(bounds, area, oldArea = area) {
  const a = area;
  const b = rect(bounds) ? bounds : null;
  const old = rect(oldArea) ? oldArea : a;
  const width = Math.min(a.width, Math.max(760, b?.width ?? 1440));
  const height = Math.min(a.height, Math.max(520, b?.height ?? 920));
  const x = b ? a.x + b.x - old.x : a.x + (a.width - width) / 2;
  const y = b ? a.y + b.y - old.y : a.y + (a.height - height) / 2;
  return { x: Math.round(clamp(x, a.x, a.x + a.width - width)), y: Math.round(clamp(y, a.y, a.y + a.height - height)), width, height };
}

export function restorePlace(state, displays, primary, matchLegacy) {
  const last = state?.last;
  const display = displays.find((d) => String(d.id) === last);
  const legacy = !last && rect(state?.bounds) ? matchLegacy(state.bounds) : null;
  const target = display || legacy || primary;
  const record = state?.monitors?.[String(target.id)] || state?.monitors?.[last] || (legacy && state);
  return { display: target, bounds: fitBounds(record?.bounds, target.workArea, record?.area), maximized: record?.maximized === true };
}
