// Links and the built-in browser (the side panel's Browser tab). Settings → Browser chooses where links from replies
// open; the Windows app shows any web page in its own browser session (separate cookies, downloads to a folder you
// choose); a plain web browser can only show pages on this computer inside ORBIX. Visited addresses feed the address
// bar's suggestions and can be cleared.
import { S, savePrefs } from './store.js';
import { searchUrl } from './prefs-extra.js';

/** { openLinks: 'external' | 'builtin', downloads: folder or '' (= the Downloads folder) }. */
export const browserPrefs = () => ({ openLinks: 'external', downloads: '', ...(S.ui.browser || {}) });

/** The Windows app's browser session (webview, downloads, site data), or null in a web browser. */
export const desktopBrowser = () => window.orbixDesktop?.browser || null;

/** Is this an http page on this computer? */
function localPage(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/** Can the Browser tab show this page? Any http(s) page in the Windows app; only this computer's pages elsewhere. */
export function canShowInside(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return desktopBrowser() ? true : localPage(u.href);
  } catch {
    return false;
  }
}

/** What you typed in the address bar, as a URL: a port, a localhost address, a site, or a web search. */
export function addressToUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (/^\d{2,5}$/.test(v)) return `http://localhost:${v}/`;
  if (/^(localhost|127\.0\.0\.1)([:/]|$)/i.test(v)) return `http://${v}`;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(v)) return `https://${v}`;
  return searchUrl(v);
}

/** Remember a visited address (newest first, at most 100) for the address bar's suggestions. */
export function rememberVisit(url) {
  if (!/^https?:\/\//i.test(url || '') || url.length > 2000) return;
  const list = (S.ui.browserHistory || []).filter((x) => x !== url);
  savePrefs({ browserHistory: [url, ...list].slice(0, 100) });
}

export const clearBrowserHistory = () => savePrefs({ browserHistory: [] });
