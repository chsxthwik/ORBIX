// Web apps running on this PC, for the side panel's Browser tab: ORBIX knocks on the ports that dev servers use
// (Vite, Next, CRA, Angular, Django, Flask, Rails, Express and the like) on 127.0.0.1 and lists the ones that answer
// HTTP, with the page title when there is one. Only this computer is asked; nothing leaves it.
import http from 'node:http';

export const DEV_PORTS = [3000, 3001, 3002, 4000, 4200, 4321, 5000, 5001, 5173, 5174, 5500, 6006, 7000, 8000, 8001, 8080, 8081, 8443, 8888, 9000, 9090];

/** The title of an HTML page (the first 32 KB), or ''. */
export function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return m ? m[1].replace(/\s+/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim().slice(0, 120) : '';
}

/** GET http://127.0.0.1:port/ with a short timeout: { port, url, status, title } or null when nothing answers. */
function knock(port, timeout) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout, headers: { accept: 'text/html,*/*', 'user-agent': 'ORBIX' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        body += d;
        if (body.length > 32768) res.destroy();
      });
      const done = () => resolve({ port, url: `http://localhost:${port}/`, status: res.statusCode, title: /html/i.test(res.headers['content-type'] || '') ? pageTitle(body) : '' });
      res.on('end', done);
      res.on('close', done);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/** Every port in `ports` (except `skip`, ORBIX's own) that answers HTTP, in port order. */
export async function findDevServers({ ports = DEV_PORTS, skip = [], timeout = 700 } = {}) {
  const want = [...new Set(ports)].filter((p) => Number.isInteger(p) && p > 0 && p < 65536 && !skip.includes(p));
  return (await Promise.all(want.map((p) => knock(p, timeout)))).filter(Boolean);
}

/** Can the panel show this URL inside ORBIX? Only http pages on this computer; anything else opens in your browser. */
export function isLocalPage(raw) {
  try {
    const u = new URL(String(raw || ''));
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}
