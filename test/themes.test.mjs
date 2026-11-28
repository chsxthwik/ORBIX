// ORBIX has one theme, Dark. The page is dark from its first byte (index.html), nothing switches it, and no other
// theme, palette, scene or light mode is left in the stylesheets or the scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const WEB = new URL('../web/', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, WEB), 'utf8');
const list = (dir, re) => fs.readdirSync(new URL(dir, WEB)).filter((f) => re.test(f)).map((f) => [`${dir}${f}`, read(`${dir}${f}`)]);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

test('the page boots dark, with no theme script before it paints', () => {
  const html = read('index.html');
  assert.match(html, /<html lang="en" data-theme="dark" data-mode="dark">/);
  assert.match(html, /<meta name="color-scheme" content="dark">/);
  assert.doesNotMatch(html, /<script(?![^>]*type="module")/, 'no classic script runs before paint');
  for (const gone of ['js/theme-boot.js', 'js/backdrop.js', 'css/themes.css', 'css/scenes.css', 'css/graphite.css']) {
    assert.ok(!fs.existsSync(new URL(gone, WEB)), `${gone} is gone`);
    assert.ok(!html.includes(`/${gone}`), `index.html does not load ${gone}`);
  }
});

test('the Dark tokens apply on :root, with the green accent', () => {
  const app = strip(read('css/app.css'));
  const root = /:root \{([^}]*--accent:[^}]*)\}/.exec(app)?.[1];
  assert.ok(root, 'app.css sets the colour tokens on :root');
  assert.match(root, /color-scheme: dark;/);
  assert.match(root, /--accent: #3DF28C;/);
  assert.match(strip(read('css/shell.css')), /:root \{\s*--chrome: #0A0A0B;/, 'shell.css sets the Dark palette on :root');
});

test('no stylesheet selects a theme, a mode, a scene or the system colour scheme', () => {
  for (const [f, src] of list('css/', /\.css$/)) {
    const css = strip(src);
    assert.doesNotMatch(css, /\[data-(theme|scene|palette)\b/, `${f} selects a theme`);
    assert.doesNotMatch(css, /\[data-mode=["']?(light|dark)/, `${f} selects a light or dark mode`);
    assert.doesNotMatch(css, /prefers-color-scheme/, `${f} follows the system colour scheme`);
    assert.doesNotMatch(css, /\.tp-|\.theme-[cnop]\b|canvas\.(backdrop|fireworks)/, `${f} styles a theme picker or a scene`);
  }
});

test('no script switches the theme', () => {
  for (const [f, src] of list('js/', /\.m?js$/)) {
    assert.doesNotMatch(src, /(documentElement|root)\.dataset\.(theme|mode|scene)\s*=|toggleTheme|prefers-color-scheme|savePrefs\(\{\s*theme\b/, `${f} switches the theme`);
    assert.doesNotMatch(src, /\b(frost|graphite|rosepine|dracula|gruvbox|nebula|aurora|sunset)\b|\bmidnight\s*:|['"](light|tokyo|mocha|nord|latte|dawn|dither|koi|dusk)['"]|backdrop\.js|sceneMotion/, `${f} names a removed theme`);
  }
});

test('Settings and the menus offer no theme choice', () => {
  const settings = read('js/settings.js');
  assert.doesNotMatch(settings, /'Scene theme'|'Editor palette'|'Presets'|themePreview|'Animate scenes'|'Preview the finish'/);
  assert.doesNotMatch(read('js/shell.js') + read('js/main.js'), /'(Light|Dark) theme'/);
});
