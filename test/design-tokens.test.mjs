// The design rules, checked in the stylesheets (web/css/tokens.css has the numbers). The rendered page is checked by
// tools/ui-audit.mjs (node tools/shots.mjs --audit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const dir = new URL('../web/css/', import.meta.url);
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const sheets = [...html.matchAll(/<link[^>]+href="\/?(?:\.\/)?css\/([^"?]+\.css)/g)].map((m) => m[1]);
const read = (f) => fs.readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// Leaf rules: [selector, declarations]. Rules inside @media or @container are leaves too.
const rules = (css) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
const decls = (body) => [...body.matchAll(/(?:^|;)\s*([a-z-]+)\s*:\s*([^;]*)/g)].map((m) => [m[1], m[2].trim()]);
const all = sheets.flatMap((f) => rules(read(f)).filter(([sel]) => !sel.startsWith('@font-face')).flatMap(([sel, body]) => decls(body).map(([p, v]) => ({ f, sel, p, v }))));
// Stylesheets that follow the 12/13/14/16/20/28 scale. A later stylesheet may restyle on purpose (final.css).
const ruled = sheets.filter((f) => f !== 'final.css');
const mine = all.filter((d) => ruled.includes(d.f));
const where = (d) => `${d.f}: ${d.sel} { ${d.p}: ${d.v} }`;

test('tokens.css loads first and defines the type scale, weights, spacing and motion', () => {
  assert.equal(sheets[0], 'tokens.css');
  const t = read('tokens.css');
  for (const n of [12, 13, 14, 16, 20, 28]) assert.match(t, new RegExp(`--fs-${n}: ${n}px`));
  assert.match(t, /--fw: 400/);
  assert.match(t, /--fw-h: 500/);
  assert.match(t, /--dur-hover: 120ms/);
  assert.match(t, /--dur-panel: 180ms/);
  assert.match(t, /--col-max: 760px/);
});

test('font sizes are on the scale: a --fs token, a pixel size from the scale, or relative to the body size', () => {
  const bad = mine.filter((d) => d.p === 'font-size' && !/^(var\(--fs(-(12|13|14|16|20|28))?\)|inherit|0|(12|13|14|16|20|28)px|calc\(var\(--fs\) [+-] \d+px\)|1em|var\(--(code|prompt)-fs\)( !important)?)$/.test(d.v));
  assert.deepEqual(bad.map(where), []);
  const shorthand = mine.filter((d) => d.p === 'font' && !/calc\(var\(--s,/.test(d.v) && /\d+(\.\d+)?px/.test(d.v.split('/')[0]) && !/^(?:var\([^)]*\)\s+)?(12|13|14|16|20|28)px/.test(d.v.replace(/^\d+\s+/, '')));
  assert.deepEqual(shorthand.map(where), []);
});

test('weights are 400, and 500 for headings: only --fw and --fw-h', () => {
  const bad = mine.filter((d) => d.p === 'font-weight' && !/^(var\(--fw(-h)?\)|inherit|normal)$/.test(d.v));
  assert.deepEqual(bad.map(where), []);
  const bold = mine.filter((d) => d.p === 'font' && /\b(600|700|bold)\b/.test(d.v));
  assert.deepEqual(bold.map(where), []);
});

test('padding, margin and gap sit on the 4px grid (1px and 2px allowed for hairlines and half steps)', () => {
  const bad = mine.filter((d) => /^(padding|margin)(-|$)|^(row-|column-)?gap$/.test(d.p)).filter((d) => [...d.v.matchAll(/(-?\d*\.?\d+)px/g)].some((m) => { const x = Math.abs(+m[1]); return !(x <= 2 || x % 4 === 0); }));
  assert.deepEqual(bad.map(where), []);
});

test('no easing overshoots and nothing is called a spring or a bounce', () => {
  const css = sheets.map(read).join('\n');
  for (const m of css.matchAll(/cubic-bezier\(([^)]*)\)/g)) {
    const [, y1, , y2] = m[1].split(',').map(Number);
    assert.ok(y1 >= 0 && y1 <= 1 && y2 >= 0 && y2 <= 1, `cubic-bezier(${m[1]}) overshoots`);
  }
  assert.doesNotMatch(css, /ease-spring|bounce|overshoot/i);
  // a keyframe that scales past 1 pops
  // (the mark's own loader, lg-r and lg-l, breathes by a few percent; it is the identity, not a bounce)
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\}\s*(?=@|[.:#a-z]|$)/gi)) {
    if (/^lg-/.test(m[1])) continue;
    for (const s of m[2].matchAll(/scale\(([\d.]+)\)/g)) assert.ok(+s[1] <= 1, `@keyframes ${m[1]} scales to ${s[1]}`);
  }
});

test('the rewritten stylesheets use colour tokens only: no hex, rgb or hsl literals', () => {
  const literal = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(\s*\d/i; // a colour written out; hsl(var(--hue) ...) is a token
  for (const f of ['tokens.css', 'sidebar.css', 'transcript.css', 'composer.css', 'home.css']) assert.doesNotMatch(read(f), literal, `${f} has a colour literal`);
  // ui.css too, except the provider tile (.btile), which draws brand colours
  const ui = rules(read('ui.css')).filter(([sel]) => !/\.btile/.test(sel)).map(([sel, body]) => `${sel}{${body}}`).join('\n');
  assert.doesNotMatch(ui, literal, 'ui.css has a colour literal');
});

test('every stylesheet that animates stops under reduced motion, here or in prefs.css', () => {
  const prefs = read('prefs.css');
  assert.match(prefs, /html\.no-motion/);
  for (const f of sheets) {
    const css = read(f);
    if (!/@keyframes|animation\s*:/.test(css)) continue;
    assert.ok(/prefers-reduced-motion/.test(css) || f === 'prefs.css', `${f} animates and has no reduced-motion rule`);
  }
});
