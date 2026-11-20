// Runs before the page paints: applies the last theme so the window never flashes the wrong colours.
// Keep the theme -> mode table in step with THEMES in js/main.js.
try {
  const MODE = { dark: 'dark', light: 'light', midnight: 'dark', frost: 'light', orbix: 'dark', sunset: 'dark', koi: 'light', aurora: 'dark', dusk: 'dark' };
  const t = JSON.parse(localStorage.getItem('orbix.look') || localStorage.getItem('omph.look') || 'null');
  const name = t && MODE[t.theme] ? t.theme : t ? 'dark' : '';
  if (name) {
    document.documentElement.dataset.theme = name;
    document.documentElement.dataset.mode = MODE[name];
    if (['orbix', 'sunset', 'koi', 'aurora', 'dusk'].includes(name)) document.documentElement.dataset.scene = name;
  }
} catch {}
