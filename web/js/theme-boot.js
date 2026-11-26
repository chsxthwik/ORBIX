// Runs before the page paints: applies the last theme so the window never flashes the wrong colours.
// Keep the theme -> mode table in step with THEMES in js/main.js.
try {
  const MODE = { dark: 'dark', light: 'light', midnight: 'dark', frost: 'light', graphite: 'dark', tokyo: 'dark', mocha: 'dark', rosepine: 'dark', nord: 'dark', dracula: 'dark', gruvbox: 'dark', latte: 'light', dawn: 'light', orbix: 'dark', sunset: 'dark', nebula: 'dark', aurora: 'dark', dither: 'dark' };
  const ALIAS = { koi: 'latte', dusk: 'nebula' };
  const t = JSON.parse(localStorage.getItem('orbix.look') || localStorage.getItem('omph.look') || 'null');
  const want = t && (ALIAS[t.theme] || t.theme);
  const name = t && MODE[want] ? want : t ? 'dark' : '';
  if (name) {
    document.documentElement.dataset.theme = name;
    document.documentElement.dataset.mode = MODE[name];
    if (['orbix', 'sunset', 'nebula', 'aurora', 'dither'].includes(name)) document.documentElement.dataset.scene = name;
  }
} catch {}
