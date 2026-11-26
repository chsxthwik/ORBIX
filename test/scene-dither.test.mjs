// The Dither scene: a dot-engraved landscape in the brand colour. It has to be known wherever the other scenes are
// (SCENES, its maker, a palette and a card in scenes.css), draw in --plasma only, keep the middle quiet, and redraw
// only the cells the clouds and the shimmer change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (f) => fs.readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const js = read('js/backdrop.js');
const css = read('css/scenes.css');

test('dither is a scene: in SCENES, with a maker, a palette and a card', () => {
  const list = Function(`return ${js.match(/export const SCENES = (\[[^\]]+\])/)[1]}`)();
  assert.ok(list.includes('dither'), 'dither is not in SCENES');
  assert.match(js, /dither: ditherScene/, 'dither has no maker');
  assert.match(js, /function ditherScene\(\)/);
  assert.match(css, /:root\[data-theme=dither\] \{/, 'dither has no palette');
  assert.match(css, /\.tp-dither \{/, 'dither has no card');
  assert.match(css, /\.tp-dither \.tp-sheet::before \{/, 'dither card has no picture');
});

test('the palette is dark and takes its accent from --plasma, with no pink or purple', () => {
  const block = css.match(/:root\[data-theme=dither\] \{([^}]+)\}/)[1];
  assert.match(block, /color-scheme: dark/);
  for (const t of ['--accent', '--accent-solid', '--live', '--pa']) assert.match(block, new RegExp(`${t}: var\\(--plasma\\)`), `${t} is not the brand colour`);
  assert.match(block, /--scene-veil: \.\d+/);
  const card = css.match(/\.tp-dither \{([^}]+)\}/)[1] + css.match(/\.tp-dither \.tp-sheet::before \{([^}]+)\}/)[1] + css.match(/\.tp-dither \.tp-sheet::after \{([^}]+)\}/)[1];
  assert.doesNotMatch(block + card, /#(FF4FB8|F472B6|EC4899|A78BFA|8B5CF6|9C8BFF)|magenta|purple|violet/i);
  // the card's art uses its tokens, not colour literals
  const art = css.match(/\.tp-dither \.tp-sheet::before \{([^}]+)\}/)[1] + css.match(/\.tp-dither \.tp-sheet::after \{([^}]+)\}/)[1];
  assert.doesNotMatch(art, /#[0-9a-f]{3,8}\b|\brgba?\(/i);
});

// ---- run the scene's own code (backdrop.js's helpers and ditherScene) as a module, against a fake canvas

const colours = { '--plasma': '#3DF28C', '--bg': '#070908', '--fg': '#E9F1EC' };
async function load(W, H) {
  const rngSrc = js.match(/function rng\(seed\) \{[\s\S]*?\n\}\n/)[0];
  const start = js.indexOf('/** The 8x8 Bayer matrix');
  const end = js.indexOf('const MAKERS');
  assert.ok(start > 0 && end > start, 'the dither section is not where expected');
  const src = `let W = ${W}, H = ${H};
const TAU = Math.PI * 2; const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const colours = ${JSON.stringify(colours)}; const css = (v, d) => colours[v] || d;
${rngSrc}
${js.slice(start, end)}
export default ditherScene;`;
  const { default: make } = await import(`data:text/javascript,${encodeURIComponent(src)}`);
  return make();
}

/** A 2D context that records each filled rectangle with its colour and alpha. */
function fake() {
  const rects = [];
  let path = [];
  const g = {
    fillStyle: '', globalAlpha: 1,
    fillRect(x, y, w, h) { rects.push({ x, y, w, h, c: g.fillStyle, a: g.globalAlpha }); },
    beginPath() { path = []; },
    rect(x, y, w, h) { path.push({ x, y, w, h }); },
    fill() { for (const r of path) rects.push({ ...r, c: g.fillStyle, a: g.globalAlpha }); },
  };
  return { g, rects };
}

test('the still layer is dots of --plasma on the sheet colour, on a coarse grid, quieter in the middle', async () => {
  const W = 1440, H = 900, s = await load(W, H);
  s.setup();
  const { g, rects } = fake();
  s.paint(g);
  const [ground, ...dots] = rects;
  assert.deepEqual([ground.w, ground.h, ground.c], [W, H, '#070908']);
  assert.ok(dots.length > 5000, `only ${dots.length} dots`);
  assert.ok(dots.every((r) => r.c === '#3DF28C'), 'a dot is not the brand colour');
  const cell = W * H > 1.3e6 ? 4 : 3;
  assert.ok(dots.every((r) => r.w === cell - 1 && r.x % cell === 0 && r.y % cell === 0), 'dots are off the grid');
  const inBand = (a, b) => dots.filter((r) => r.x >= W * a && r.x < W * b).length;
  const middle = inBand(0.4, 0.6), sides = (inBand(0, 0.2) + inBand(0.8, 1)) / 2;
  assert.ok(middle < sides * 0.6, `the middle (${middle} dots) is not quieter than the sides (${sides})`);
  assert.equal(s.sparks.slice(0, 2).join(), '#3DF28C,#3DF28C', 'fireworks are not in the brand colour');
});

test('a frame redraws only the cells that change, and drifts faster while an agent works', async () => {
  const W = 1440, H = 900, s = await load(W, H);
  s.setup();
  const { g, rects } = fake();
  s.frame(g, 0, false); // the still frame (reduced motion, Animate scenes off) still has its clouds
  const still = rects.length;
  assert.ok(still > 0, 'no clouds in the still frame');
  assert.ok(still < (W * H) / 9 / 4, `a frame drew ${still} cells: it should redraw only what changes`);
  assert.ok(rects.every((r) => r.c === '#3DF28C' || r.c === '#070908'), 'a frame used a colour other than --plasma and the sheet');
  // drift: busy moves the clouds further in the same time
  const shift = async (fast) => {
    const t = await load(W, H);
    t.setup();
    const a = fake(), b = fake();
    t.frame(a.g, 0, false);
    t.frame(b.g, 1, fast);
    const key = (r) => `${r.x},${r.y},${r.c}`;
    const before = new Set(a.rects.map(key));
    return b.rects.filter((r) => !before.has(key(r))).length;
  };
  assert.ok((await shift(true)) > (await shift(false)), 'clouds do not drift faster while an agent works');
  // cheap: at a large size, a frame (after warm-up) stays well inside the 33 ms of 30 fps
  const big = await load(2560, 1440);
  big.setup();
  const lean = { fillStyle: '', globalAlpha: 1, beginPath() {}, rect() {}, fill() {}, fillRect() {} };
  for (let i = 0; i < 30; i++) big.frame(lean, 1 / 30, false);
  // CPU time, not wall time: what a frame costs, whatever else the machine running the whole suite is doing.
  const c0 = process.cpuUsage();
  for (let i = 0; i < 30; i++) big.frame(lean, 1 / 30, true);
  const c = process.cpuUsage(c0);
  const per = (c.user + c.system) / 1000 / 30;
  assert.ok(per < 16, `a frame took ${per.toFixed(1)} ms of CPU`);
});
