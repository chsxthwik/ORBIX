// Windows integration: the IPC argument checks, jump list and toast parsing, window placement per monitor, and that
// nothing Windows-only is loaded on other systems. Pure functions only; no Electron.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  titleBarArgs, isWindowsHome, projectId, jumpAction, toastAction, isToastToken, allowOnce, registryDword, progressArgs,
  notifyArgs, themeSource, recentProjects, amberDot, accentHex, supportsMica, fitBounds, restorePlace,
} from '../electron/windows-input.mjs';
import { windowPlacement } from '../electron/windows-place.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'a'.repeat(32);

describe('IPC argument checks', () => {
  test('titleBarArgs: hex colours and a sane height only', () => {
    assert.deepEqual(titleBarArgs({ bg: '#101114', fg: '#AABBCC', height: 30 }), { bg: '#101114', fg: '#AABBCC', height: 30 });
    for (const bad of [null, [], 'x', { bg: 'red', fg: '#000000', height: 30 }, { bg: '#000000', fg: '#000', height: 30 },
      { bg: '#000000', fg: '#000000', height: 29 }, { bg: '#000000', fg: '#000000', height: 136 }, { bg: '#000000', fg: '#000000', height: 30.5 },
      { bg: '#000000;x', fg: '#000000', height: 30 }]) assert.equal(titleBarArgs(bad), null, JSON.stringify(bad));
  });

  test('isWindowsHome: the main frame of the app window, on Windows only', () => {
    const contents = {};
    const ev = { sender: contents, senderFrame: { parent: null, url: 'http://127.0.0.1:1/' } };
    assert.equal(isWindowsHome(ev, contents, 'http://127.0.0.1:1/', 'win32'), true);
    assert.equal(isWindowsHome(ev, contents, 'http://127.0.0.1:1/', 'linux'), false);
    assert.equal(isWindowsHome(ev, contents, 'http://127.0.0.1:1/', 'darwin'), false);
    assert.equal(isWindowsHome(ev, {}, 'http://127.0.0.1:1/', 'win32'), false);
    assert.equal(isWindowsHome({ ...ev, senderFrame: { parent: {}, url: ev.senderFrame.url } }, contents, 'http://127.0.0.1:1/', 'win32'), false);
    assert.equal(isWindowsHome({ ...ev, senderFrame: { parent: null, url: 'https://evil.example/' } }, contents, 'http://127.0.0.1:1/', 'win32'), false);
    assert.equal(isWindowsHome({ sender: contents }, contents, 'http://127.0.0.1:1/', 'win32'), false);
  });

  test('progressArgs: two small whole counts', () => {
    assert.deepEqual(progressArgs({ working: 2, waiting: 0 }), { working: 2, waiting: 0 });
    for (const bad of [null, [1, 2], { working: -1, waiting: 0 }, { working: 1 }, { working: 1.5, waiting: 0 }, { working: '1', waiting: 0 }, { working: 1000, waiting: 0 }])
      assert.equal(progressArgs(bad), null, JSON.stringify(bad));
  });

  test('notifyArgs: kinds, ids and seconds; never any text from the page', () => {
    assert.deepEqual(notifyArgs({ kind: 'test', title: 'x' }), { kind: 'test' });
    assert.deepEqual(notifyArgs({ kind: 'done', proc: 'pabc123xyz9', secs: 12, title: 'spoof' }), { kind: 'done', proc: 'pabc123xyz9', secs: 12 });
    assert.deepEqual(notifyArgs({ kind: 'error', proc: 'pabc123xyz9', secs: -4 }), { kind: 'error', proc: 'pabc123xyz9', secs: 0 });
    assert.deepEqual(notifyArgs({ kind: 'input', proc: 'pabc123xyz9', ask: 'ask-k2-1' }), { kind: 'input', proc: 'pabc123xyz9', ask: 'ask-k2-1' });
    for (const bad of [null, [], { kind: 'other', proc: 'pabc123xyz9' }, { kind: 'done', proc: 'xabc' }, { kind: 'done', proc: 'p../../x' },
      { kind: 'input', proc: 'pabc123xyz9' }, { kind: 'input', proc: 'pabc123xyz9', ask: 'a b' }, { kind: 'input', proc: 'pabc123xyz9', ask: 'x'.repeat(81) }])
      assert.equal(notifyArgs(bad), null, JSON.stringify(bad));
  });

  test('themeSource and recentProjects', () => {
    for (const v of ['system', 'dark', 'light']) assert.equal(themeSource(v), v);
    for (const v of ['', 'Dark', 'midnight', null, 1]) assert.equal(themeSource(v), null);
    assert.deepEqual(recentProjects(['w1', 'w2', 'w1']), ['w1', 'w2']);
    assert.deepEqual(recentProjects(['a', 'b', 'c', 'd', 'e', 'f', 'g']), ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.equal(recentProjects(['ok', '../x']), null);
    assert.equal(recentProjects('w1'), null);
    assert.equal(recentProjects(Array(21).fill('w')), null);
    assert.equal(projectId('-x'), null);
    assert.equal(projectId('w' + 'x'.repeat(64)), null);
  });
});

describe('jump list and toast actions', () => {
  test('jumpAction: one well-formed --orbix-jump argument', () => {
    assert.deepEqual(jumpAction(['orbix.exe', '--orbix-jump=new']), { kind: 'new' });
    assert.deepEqual(jumpAction(['orbix.exe', 'app', '--orbix-jump=project:wk2a9']), { kind: 'project', id: 'wk2a9' });
    for (const bad of [null, [], ['--orbix-jump=new', '--orbix-jump=new'], ['--orbix-jump=project:'], ['--orbix-jump=project:a b'],
      ['--orbix-jump=project:../x'], ['--orbix-jump=delete'], ['--orbix-jump=new ']]) assert.equal(jumpAction(bad), null, JSON.stringify(bad));
  });

  test('toastAction: Open is 0, Approve is 1, the tag must be a token', () => {
    assert.deepEqual(toastAction({ type: 'action', actionIndex: 0, arguments: `type=action&action=0&tag=${TOKEN}` }), { token: TOKEN, approve: false });
    assert.deepEqual(toastAction({ type: 'action', actionIndex: 1, arguments: `type=action&action=1&tag=${TOKEN}` }), { token: TOKEN, approve: true });
    assert.equal(toastAction({ type: 'action', actionIndex: 0, arguments: `type=action&action=1&tag=${TOKEN}` }), null);
    assert.equal(toastAction({ type: 'action', actionIndex: 2, arguments: `type=action&action=2&tag=${TOKEN}` }), null);
    assert.equal(toastAction({ type: 'click', actionIndex: 1, arguments: `type=action&action=1&tag=${TOKEN}` }), null);
    assert.equal(toastAction({ type: 'action', actionIndex: 1, arguments: `type=action&action=1&tag=${TOKEN}&x=1` }), null);
    assert.equal(toastAction(null), null);
    assert.equal(isToastToken(TOKEN), true);
    assert.equal(isToastToken('A'.repeat(32)), false);
    assert.equal(isToastToken('a'.repeat(31)), false);
  });

  test('allowOnce: only a pending permission question that offers Allow once and Deny', () => {
    const ask = { method: 'select', title: 'Run npm test?', options: ['Allow once', 'Always allow', 'Deny'] };
    const proc = { openUi: new Map([['ask-1', ask]]), pendingAsk: new Map([['ask-1', {}]]) };
    assert.deepEqual(allowOnce(proc, 'ask-1'), { type: 'extension_ui_response', id: 'ask-1', value: 'Allow once' });
    assert.equal(allowOnce(proc, 'ask-2'), null);
    assert.equal(allowOnce({ ...proc, pendingAsk: new Map() }, 'ask-1'), null); // already answered
    assert.equal(allowOnce({ ...proc, openUi: new Map([['ask-1', { ...ask, options: ['Yes', 'No'] }]]) }, 'ask-1'), null);
    assert.equal(allowOnce({ ...proc, openUi: new Map([['ask-1', { ...ask, method: 'input' }]]) }, 'ask-1'), null);
    assert.equal(allowOnce(null, 'ask-1'), null);
  });
});

describe('Windows settings', () => {
  test('registryDword reads reg.exe output', () => {
    const out = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Accessibility\r\n    TextScaleFactor    REG_DWORD    0x7d\r\n\r\n';
    assert.equal(registryDword(out, 'TextScaleFactor'), 125);
    assert.equal(registryDword(out, 'Other'), null);
    assert.equal(registryDword('    EnableTransparency    REG_SZ    0x0', 'EnableTransparency'), null);
    assert.equal(registryDword('    EnableTransparency    REG_DWORD    0x0', 'EnableTransparency'), 0);
    assert.equal(registryDword('', 'X'), null);
  });

  test('supportsMica: Windows 11 22H2 and later', () => {
    assert.equal(supportsMica('10.0.22621'), true);
    assert.equal(supportsMica('10.0.26300'), true);
    assert.equal(supportsMica('10.0.22000'), false); // Windows 11 21H2
    assert.equal(supportsMica('10.0.19045'), false); // Windows 10
    assert.equal(supportsMica('6.8.0-generic'), false);
  });

  test('accentHex and amberDot', () => {
    assert.equal(accentHex('0078d4ff'), '#0078d4');
    assert.equal(accentHex('0078D4'), '#0078d4');
    assert.equal(accentHex('#0078d4'), null);
    assert.equal(accentHex(null), null);
    const dot = amberDot(16);
    assert.equal(dot.length, 16 * 16 * 4);
    assert.equal(dot[3], 0, 'corners are clear');
    const mid = (8 * 16 + 8) * 4;
    assert.equal(dot[mid + 3], 255);
    assert.ok(dot[mid + 2] > dot[mid], 'amber: more red than blue');
  });
});

describe('window placement per monitor', () => {
  const A = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const B = { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };

  test('fitBounds keeps the window inside the work area at a usable size', () => {
    assert.deepEqual(fitBounds({ x: 100, y: 50, width: 1200, height: 800 }, A.workArea), { x: 100, y: 50, width: 1200, height: 800 });
    assert.deepEqual(fitBounds({ x: 5000, y: 5000, width: 1200, height: 800 }, A.workArea), { x: 720, y: 240, width: 1200, height: 800 });
    assert.deepEqual(fitBounds({ x: 0, y: 0, width: 100, height: 100 }, A.workArea), { x: 0, y: 0, width: 760, height: 520 });
    assert.deepEqual(fitBounds(null, A.workArea), { x: 240, y: 60, width: 1440, height: 920 });
    // Moved from monitor B's coordinates onto A: same offset within the monitor.
    assert.deepEqual(fitBounds({ x: 2020, y: 100, width: 1000, height: 700 }, A.workArea, B.workArea), { x: 100, y: 100, width: 1000, height: 700 });
    assert.deepEqual(fitBounds({ x: 'x' }, A.workArea).width, 1440);
  });

  test('restorePlace: same monitor, or the main one when it is gone', () => {
    const state = { last: '2', monitors: { 2: { bounds: { x: 2000, y: 40, width: 1600, height: 1000 }, area: B.workArea, maximized: true } } };
    const there = restorePlace(state, [A, B], A, () => A);
    assert.equal(there.display, B);
    assert.deepEqual(there.bounds, { x: 2000, y: 40, width: 1600, height: 1000 });
    assert.equal(there.maximized, true);
    const gone = restorePlace(state, [A], A, () => A);
    assert.equal(gone.display, A);
    assert.deepEqual(gone.bounds, { x: 80, y: 40, width: 1600, height: 1000 });
    const fresh = restorePlace({}, [A, B], A, () => A);
    assert.equal(fresh.display, A);
    assert.equal(fresh.maximized, false);
    // The old single-record file still works.
    const legacy = restorePlace({ bounds: { x: 2100, y: 10, width: 900, height: 600 }, maximized: false }, [A, B], A, () => B);
    assert.equal(legacy.display, B);
    assert.deepEqual(legacy.bounds, { x: 2100, y: 10, width: 900, height: 600 });
  });

  test('windowPlacement remembers each monitor and moves off an unplugged one', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-place-')), 'window.json');
    const handlers = {};
    let displays = [A, B];
    const screen = {
      getAllDisplays: () => displays, getPrimaryDisplay: () => A,
      getDisplayMatching: (b) => (b.x >= 1920 ? B : A),
      on: (n, f) => (handlers[n] = f), off: () => {},
    };
    let bounds = { x: 2100, y: 100, width: 1200, height: 800 };
    const w = {
      on() {}, once() {}, isDestroyed: () => false, isMinimized: () => false, isFullScreen: () => false, isMaximized: () => false,
      getBounds: () => bounds, getNormalBounds: () => bounds, setBounds: (b) => (bounds = b), setMinimumSize() {}, maximize() {}, unmaximize() {},
    };
    const p = windowPlacement(screen, file);
    p.attach(w);
    p.remember();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.last, '2');
    assert.deepEqual(saved.monitors['2'].bounds, bounds);
    // Unplug monitor B: the window lands on A, at the same place within it.
    displays = [A];
    handlers['display-removed']({}, B);
    assert.deepEqual(bounds, { x: 180, y: 100, width: 1200, height: 800 });
    // Next launch with B back opens on B where it was.
    displays = [A, B];
    const again = windowPlacement(screen, file);
    assert.equal(again.place.display, B);
  });
});

describe('platform checks', () => {
  test('main.mjs loads the Windows module only behind the win32 check', () => {
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'main.mjs'), 'utf8');
    assert.match(src, /const WIN = process\.platform === 'win32';/);
    assert.doesNotMatch(src, /^import .*windows-shell/m, 'no static import');
    const at = src.indexOf("import('./windows-shell.mjs')");
    assert.ok(at > 0);
    const before = src.slice(Math.max(0, at - 200), at);
    assert.match(before, /if \(WIN\) \{[^}]*$/, 'the dynamic import sits inside if (WIN)');
  });

  test('the Windows module refuses to load elsewhere, and the bridge is null off Windows', () => {
    const shell = fs.readFileSync(path.join(ROOT, 'electron', 'windows-shell.mjs'), 'utf8');
    assert.match(shell, /if \(process\.platform !== 'win32'\) throw/);
    const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.cjs'), 'utf8');
    assert.match(preload, /windows: process\.platform === 'win32' \? \{/);
  });
});
