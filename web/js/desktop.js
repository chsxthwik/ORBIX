// In the Windows app: the page draws the top of the window. It marks itself as the app (html.desktop), and keeps the
// colour of the window buttons in step with the theme. In a browser this does nothing.
const bridge = window.orbixDesktop;

if (bridge) {
  const root = document.documentElement;
  root.classList.add('desktop');
  let last = '';
  let queued = false;
  const sync = () => {
    queued = false;
    const css = getComputedStyle(root);
    const bg = css.getPropertyValue('--bg').trim();
    const fg = css.getPropertyValue('--fg-2').trim();
    if (!bg || !fg || `${bg}|${fg}` === last) return;
    last = `${bg}|${fg}`;
    bridge.setTitleBar(bg, fg);
  };
  const later = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(sync);
    }
  };
  // Themes are applied as attributes on <html>; the system light or dark setting can change them too.
  new MutationObserver(later).observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-mode', 'style', 'class'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', later);
  later();
}
