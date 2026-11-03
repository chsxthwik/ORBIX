// Runs before the page paints: applies the last theme so the window never flashes the wrong colours.
try {
  const t = JSON.parse(localStorage.getItem('orbix.look') || localStorage.getItem('omph.look') || 'null');
  if (t) document.documentElement.dataset.theme = t.theme === 'light' ? 'light' : 'dark';
} catch {}
