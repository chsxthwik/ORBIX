// Client for the ORBIX engine. In the Windows app the engine runs in the app's own process and is reached over IPC
// (window.orbixDesktop.engine; no server, no port). In a browser, or on an ORBIX Cloud machine, it is the HTTP API.
const desktop = location.protocol === 'orbix:' ? window.orbixDesktop?.engine || null : null;

async function callDesktop(method, url, body) {
  const u = new URL(url, 'orbix://app');
  const j = await desktop.call(method, u.pathname, body, Object.fromEntries(u.searchParams));
  if (!j?.ok) throw Object.assign(new Error(typeof j?.error === 'string' ? j.error : 'Request failed'), { code: j?.code, status: j?.status });
  return j;
}

/** The paths of the last API calls, newest last (for the end-to-end tests, whatever the transport). */
export const recentCalls = [];

async function call(method, url, body) {
  recentCalls.push(String(url).split('?')[0]);
  if (recentCalls.length > 300) recentCalls.shift();
  if (desktop) return callDesktop(method, url, body);
  let r;
  try {
    r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-orbix': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw Object.assign(new Error('Lost connection to the ORBIX server'), { offline: true });
  }
  if (r.status === 401) throw Object.assign(new Error('Session expired. Open ORBIX again from the link it printed when it started.'), { unauthorized: true });
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!r.ok || !j?.ok) throw Object.assign(new Error(typeof j?.error === 'string' ? j.error : `Request failed (HTTP ${r.status})`), { code: j?.code, status: r.status });
  return j;
}

export const api = {
  get: (url) => call('GET', url),
  post: (url, body) => call('POST', url, body ?? {}),
};

/** Send an RPC command to one agent session and return its `response` frame. */
export const rpc = (proc, cmd, timeout) => api.post('/api/rpc', { proc, cmd, timeout }).then((j) => j.response);

export function connectEvents({ onEvent, onGlobal, onOpen, onClose }) {
  if (desktop) {
    const take = (d) => {
      if (!d) return;
      if (d.p) onEvent(d.p, d.e);
      else if (d.g) onGlobal(d);
    };
    const off = desktop.onEvent(take);
    desktop.hello().then((hello) => {
      take(hello);
      onOpen?.();
    });
    return off;
  }
  let es;
  let closed = false;
  let retryTimer;
  const open = () => {
    if (closed) return;
    clearTimeout(retryTimer);
    es?.close();
    es = new EventSource('/api/events');
    es.onopen = () => onOpen?.();
    es.onmessage = (m) => {
      let d;
      try {
        d = JSON.parse(m.data);
      } catch {
        return;
      }
      if (d.p) onEvent(d.p, d.e);
      else if (d.g) onGlobal(d);
    };
    es.onerror = () => {
      onClose?.();
      // EventSource auto-reconnects; if the server answered 401 it stays CLOSED.
      if (es.readyState === 2 && !closed) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(open, 2000);
      }
    };
  };
  open();
  return () => {
    closed = true;
    clearTimeout(retryTimer);
    es?.close();
  };
}
