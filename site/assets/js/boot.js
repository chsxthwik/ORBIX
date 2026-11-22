// Before paint: mark that scripts run, and apply the colour theme picked in the footer (System when none).
document.documentElement.classList.add('js');
try {
  const t = localStorage.getItem('orbix-site-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {}
