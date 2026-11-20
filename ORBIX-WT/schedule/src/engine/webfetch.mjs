// web_fetch: read one public web page as plain text. Read-only, http/https only, size and time capped.
// Private, loopback and link-local addresses are refused unless the caller allows that host; every DNS answer is
// checked at connect time (and again after each redirect), so a public name cannot rebind to a private address.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import { prepareImage } from './files.mjs';

const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 25000;
const MAX_REDIRECTS = 5;
const DEFAULT_CHARS = 40000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ORBIX/1.0 (+web_fetch; read-only)';

/** The eight 16-bit groups of an IPv6 address (no embedded IPv4 form). */
function expandV6(a) {
  const [head, tail] = a.includes('::') ? a.split('::') : [a, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const mid = tail === null ? [] : new Array(8 - h.length - t.length).fill('0');
  return [...h, ...mid, ...t].map((x) => parseInt(x || '0', 16));
}

/** True for addresses that are not on the public internet. */
export function isPrivateAddress(ip) {
  let a = String(ip || '').toLowerCase();
  if (a.startsWith('[')) a = a.slice(1, -1);
  // IPv4 inside IPv6 (::ffff:1.2.3.4, ::1.2.3.4, and the hex forms ::ffff:7f00:1 that the URL parser produces).
  const embedded = /^(?:0{0,4}:){0,5}(?::|ffff:)(?:0{0,4}:)?(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (embedded) a = embedded[1];
  else {
    const hex = /^(?:0{0,4}:){0,5}(?::|ffff:)(?:0{0,4}:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
    if (hex && net.isIPv6(a)) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
  }
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    return x === 0 || x === 10 || x === 127 || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 192 && y === 0) || (x === 198 && (y === 18 || y === 19)) || x >= 224;
  }
  if (net.isIPv6(a)) {
    const g = expandV6(a);
    // 6to4 (2002::/16) and Teredo (2001:0::/32) carry an IPv4 address: judge that one.
    if (g[0] === 0x2002) return isPrivateAddress(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`);
    if (g[0] === 0x2001 && g[1] === 0) return isPrivateAddress(`${(g[6] >> 8) ^ 255}.${(g[6] & 255) ^ 255}.${(g[7] >> 8) ^ 255}.${(g[7] & 255) ^ 255}`);
    return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a) || a.startsWith('64:ff9b:') || a.startsWith('2001:db8');
  }
  return true; // not an IP at all: treat as unsafe
}

const isLocalName = (host) => /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)$/i.test(host) || !host.includes('.');

function guardedLookup(allowPrivate) {
  return (hostname, options, cb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: options.family || 4 }];
      if (!allowPrivate) {
        const bad = list.find((x) => isPrivateAddress(x.address));
        if (bad) return cb(Object.assign(new Error(`${hostname} resolves to a private address (${bad.address})`), { code: 'EPRIVATE' }));
      }
      if (options.all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
  };
}

function requestOnce(url, { allowPrivate, signal, deadline }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'GET',
      lookup: guardedLookup(allowPrivate),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5', 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en;q=0.9,*;q=0.5' },
      timeout: Math.max(1000, deadline - Date.now()),
    });
    const onAbort = () => req.destroy(Object.assign(new Error('Stopped'), { code: 'ABORTED' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })), Math.max(1000, deadline - Date.now()));
    const done = (fn, v) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(v);
    };
    req.on('timeout', () => req.destroy(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => done(reject, e));
    req.on('response', (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return done(resolve, { redirect: res.headers.location, status: res.statusCode });
      }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let n = 0;
      let truncated = false;
      stream.on('data', (d) => {
        if (truncated) return;
        n += d.length;
        if (n > MAX_BYTES) {
          truncated = true;
          chunks.push(d.subarray(0, d.length - (n - MAX_BYTES)));
          req.destroy();
          finish();
        } else chunks.push(d);
      });
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        done(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated });
      };
      stream.on('end', finish);
      stream.on('error', (e) => (truncated ? finish() : done(reject, e)));
    });
    req.end();
  });
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·', times: '×' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

/** HTML -> readable text with light Markdown (headings, list items, links). */
export function htmlToText(html, baseUrl) {
  let s = String(html).replace(/\u0002/g, ''); // \u0002 marks set-aside code blocks below; a page must not be able to forge one
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1] || '').replace(/\s+/g, ' ').trim());
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|template|iframe|object|canvas|head)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  // Prefer the main content when the page marks it; otherwise drop navigation, footers, sidebars and dialogs.
  const main = /<main\b[\s\S]*?<\/main>/i.exec(s)?.[0] || /<article\b[\s\S]*?<\/article>/i.exec(s)?.[0] || /<(div|section)\b[^>]*\brole\s*=\s*["']?main\b[\s\S]*$/i.exec(s)?.[0];
  if (main && main.length > 500) s = main;
  s = s.replace(/<(nav|footer|aside|dialog)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<(button|select)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  // Code blocks are set aside so later whitespace collapsing and entity decoding cannot touch their text.
  const blocks = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (m, code) => {
    blocks.push(decodeEntities(code.replace(/<[^>]+>/g, '')).replace(/^\n/, '').replace(/\s+$/, ''));
    return `\n\n\u0002${blocks.length - 1}\u0002\n\n`;
  });
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (m, n, t) => `\n\n${'#'.repeat(+n)} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`);
  s = s.replace(/<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (m, _q, a, b, c, inner) => {
    const text = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    let href = decodeEntities(a ?? b ?? c ?? '');
    if (!text) return ' ';
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return text;
    try {
      href = new URL(href, baseUrl).href;
    } catch {
      return text;
    }
    return `[${text}](${href})`;
  });
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<(br|hr)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|li|ul|ol|table|tr|blockquote|header|dd|dt|figure|form)>/gi, '\n');
  s = s.replace(/<(p|div|section|ul|ol|table|tr|blockquote|header|dl|figure)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/t[dh]>/gi, ' | ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  s = s.replace(/\u0002(\d+)\u0002/g, (m, i) => `\`\`\`\n${blocks[+i]}\n\`\`\``).trim();
  return { title, text: s };
}

function decodeBody(buf, contentType) {
  const cs = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1] || /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1'))?.[1] || 'utf-8';
  try {
    return new TextDecoder(cs.toLowerCase()).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/**
 * Fetch a URL. `isAllowedHost(host)` may permit a private/local host (e.g. the user mentioned it, or approved it).
 * Returns { text, details, isError }.
 */
export async function webFetch({ url, max_chars: maxChars, offset = 0 } = {}, { signal, allowHost, vision } = {}) {
  let u;
  try {
    u = new URL(String(url || '').trim());
  } catch {
    return { text: 'A valid absolute URL is required (http:// or https://).', isError: true };
  }
  const deadline = Date.now() + TIMEOUT_MS;
  const cap = Math.min(200000, Math.max(1000, maxChars | 0 || DEFAULT_CHARS));
  const chain = [];
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { text: `Only http and https URLs can be fetched (got ${u.protocol}).`, isError: true };
    if (u.username || u.password) return { text: 'URLs with embedded credentials are not fetched.', isError: true };
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const literalPrivate = net.isIP(host) ? isPrivateAddress(host) : isLocalName(host);
    let allowPrivate = false;
    if (literalPrivate) {
      allowPrivate = !!(await allowHost?.(host, u.href));
      if (!allowPrivate) return { text: `Refused: ${host} is a local or private address. Fetch it only if the user asks for it explicitly.`, isError: true, details: { url: u.href, blocked: true } };
    }
    let r;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await requestOnce(u, { allowPrivate, signal, deadline });
        break;
      } catch (e) {
        if (e.code === 'EPRIVATE' && !allowPrivate && attempt === 0 && (await allowHost?.(host, u.href))) {
          allowPrivate = true;
          continue;
        }
        if (e.code === 'EPRIVATE') return { text: `Refused: ${e.message}. Fetch it only if the user asks for it explicitly.`, isError: true, details: { url: u.href, blocked: true } };
        if (signal?.aborted) return { text: 'Stopped.', isError: true };
        return { text: `Could not fetch ${u.href}: ${e.code === 'ETIMEDOUT' ? 'timed out' : e.code === 'ENOTFOUND' ? 'host not found' : e.message}`, isError: true };
      }
    }
    if (r.redirect) {
      chain.push(`${r.status} → ${r.redirect}`);
      try {
        u = new URL(r.redirect, u);
      } catch {
        return { text: `Bad redirect target: ${r.redirect}`, isError: true };
      }
      continue;
    }
    const ctype = String(r.headers['content-type'] || '').toLowerCase();
    if (/^image\/(png|jpeg|gif|webp)/.test(ctype) && r.status < 400 && !r.truncated) {
      const prep = prepareImage(r.body, { label: `Image from ${u.href}` });
      if (!prep.ok) return { text: prep.note, isError: true, details: { url: u.href, status: r.status, contentType: ctype } };
      if (vision === false) return { text: `${prep.note} The current model cannot view images.`, details: { url: u.href, status: r.status, contentType: ctype } };
      return { text: prep.note, images: [prep.image], details: { url: u.href, status: r.status, contentType: ctype } };
    }
    const textual = !ctype || /^text\/|json|xml|javascript|ecmascript|x-www-form|yaml|toml|csv|markdown/.test(ctype);
    if (!textual) return { text: `${u.href} returned ${ctype || 'unknown content'} (${r.body.length} bytes), which is not text, so it is not shown.`, isError: true, details: { url: u.href, status: r.status, contentType: ctype } };
    const raw = decodeBody(r.body, ctype);
    let title = '';
    let text = raw;
    if (/html|xhtml/.test(ctype) || (!ctype && /<html|<body|<!doctype html/i.test(raw.slice(0, 2000)))) ({ title, text } = htmlToText(raw, u.href));
    else if (/json/.test(ctype)) {
      try {
        text = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {}
    }
    const start = Math.max(0, offset | 0);
    const total = text.length;
    let out = text.slice(start, start + cap);
    const head = [`URL: ${u.href}`, `Status: ${r.status}`, ctype ? `Content-Type: ${ctype.split(';')[0]}` : '', title ? `Title: ${title}` : '', chain.length ? `Redirects: ${chain.join(', ')}` : ''].filter(Boolean).join('\n');
    if (start + cap < total) out += `\n\n[showing characters ${start}-${start + out.length} of ${total}; pass offset=${start + cap} to read more]`;
    if (r.truncated) out += `\n[the page was larger than ${MAX_BYTES / 1024 / 1024} MB; only the first part was read]`;
    return { text: `${head}\n\n${out || '(empty page)'}`, details: { url: u.href, status: r.status, title, contentType: ctype, chars: total }, isError: r.status >= 400 };
  }
  return { text: `Too many redirects (more than ${MAX_REDIRECTS}): ${chain.join(', ')}`, isError: true };
}

export const WEB_FETCH_DEF = {
  name: 'web_fetch',
  description: 'Fetch a URL (http/https, read-only) and return its readable content: final URL after redirects, status, title, then the page as text with Markdown headings, lists, links and code blocks. JSON is pretty-printed; PNG/JPEG/GIF/WebP images come back as images. Use it for documentation, API references, issues and articles. Local and private network addresses need the user\'s consent. Long pages are cut at max_chars: pass offset to read on.',
  input_schema: { type: 'object', properties: { url: { type: 'string', description: 'Absolute http(s) URL.' }, max_chars: { type: 'integer', description: 'Maximum characters to return (default 40000).' }, offset: { type: 'integer', description: 'Start at this character (for continuing a long page).' } }, required: ['url'] },
};
