// Every theme must be known in three places that run at different times: the boot script (before paint), the app
// (main.js) and the stylesheets. A theme missing from one of them flashes the wrong colours or falls back to Dark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (f) => fs.readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const table = (src, name) => {
  const m = src.match(new RegExp(`${name} = (\\{[^}]+\\})`));
  assert.ok(m, `${name} table not found`);
  return Function(`return ${m[1]}`)();
};

test('the boot script and the app agree on every theme and its mode', () => {
  const boot = table(read('js/theme-boot.js'), 'MODE');
  const app = table(read('js/main.js'), 'THEMES');
  assert.deepEqual(boot, app);
});

test('every scene theme has a mode, a palette, a preview and a picture', () => {
  const app = table(read('js/main.js'), 'THEMES');
  const scenes = read('js/backdrop.js').match(/export const SCENES = (\[[^\]]+\])/)[1];
  const list = Function(`return ${scenes}`)();
  const bootScenes = Function(`return ${read('js/theme-boot.js').match(/if \((\[[^\]]+\])\.includes\(name\)\)/)[1]}`)();
  assert.deepEqual(bootScenes, list);
  const css = read('css/scenes.css');
  const js = read('js/backdrop.js');
  for (const s of list) {
    assert.ok(app[s], `${s} has no mode`);
    assert.match(css, new RegExp(`:root\\[data-theme=${s}\\] \\{`), `${s} has no palette`);
    assert.match(css, new RegExp(`\\.tp-${s} \\{`), `${s} has no preview`);
    assert.match(js, new RegExp(`${s}: \\w+Scene`), `${s} has no picture`);
  }
});

test('Settings offers every theme', () => {
  const app = table(read('js/main.js'), 'THEMES');
  const settings = read('js/settings.js');
  for (const t of Object.keys(app)) assert.match(settings, new RegExp(`\\['${t}', '`), `${t} is not offered in Settings`);
});
