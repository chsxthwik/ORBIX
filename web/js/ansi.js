// ANSI (SGR) colours in command output → DOM spans. Other escape codes are dropped. Never uses innerHTML.
// The 16 basic colours map to theme classes (.a-f1 … .a-f15); 256-colour and RGB use CSSOM (allowed by the CSP).

const ESC = /\u001b\[([0-9;:]*)([A-Za-z])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b[=>78MDEHc]|\r(?!\n)/g;
const HAS = /\u001b|\r(?!\n)/;

function xterm256(n) {
  if (n < 16) return { cls: n };
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return { rgb: `rgb(${v},${v},${v})` };
  }
  const i = n - 16;
  const c = (x) => (x ? 55 + x * 40 : 0);
  return { rgb: `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})` };
}

/** True when the text contains escape codes worth rendering. */
export const hasAnsi = (s) => HAS.test(s);

/** Plain text with all escape codes removed. Carriage-return progress lines keep only their last state. */
export function stripAnsi(s) {
  return collapseCR(String(s)).replace(ESC, '');
}

// "50%\r75%\r100%\n" → "100%\n": a bare CR rewrites the line, like a terminal would.
function collapseCR(s) {
  if (!s.includes('\r')) return s;
  return s.replace(/\r\n/g, '\n').split('\n').map((ln) => (ln.includes('\r') ? ln.split('\r').filter(Boolean).pop() || '' : ln)).join('\n');
}

/** Render text with SGR codes as a DocumentFragment of coloured spans. */
export function ansiFragment(text) {
  const frag = document.createDocumentFragment();
  const s = collapseCR(String(text));
  let st = { fg: null, bg: null, b: false, d: false, i: false, u: false };
  let last = 0;
  const flush = (chunk) => {
    if (!chunk) return;
    if (st.fg == null && st.bg == null && !st.b && !st.d && !st.i && !st.u) return frag.append(chunk);
    const sp = document.createElement('span');
    const cls = [];
    if (st.fg?.cls != null) cls.push('a-f' + st.fg.cls);
    else if (st.fg?.rgb) sp.style.color = st.fg.rgb;
    if (st.bg?.cls != null) cls.push('a-b' + st.bg.cls);
    else if (st.bg?.rgb) sp.style.backgroundColor = st.bg.rgb;
    if (st.b) cls.push('a-bold');
    if (st.d) cls.push('a-dim');
    if (st.i) cls.push('a-it');
    if (st.u) cls.push('a-ul');
    sp.className = cls.join(' ');
    sp.textContent = chunk;
    frag.append(sp);
  };
  const re = new RegExp(ESC.source, 'g');
  let m;
  while ((m = re.exec(s))) {
    flush(s.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] !== 'm') continue;
    const p = (m[1] || '0').split(/[;:]/).map((x) => (x === '' ? 0 : +x));
    for (let k = 0; k < p.length; k++) {
      const c = p[k];
      if (c === 0) st = { fg: null, bg: null, b: false, d: false, i: false, u: false };
      else if (c === 1) st.b = true;
      else if (c === 2) st.d = true;
      else if (c === 3) st.i = true;
      else if (c === 4) st.u = true;
      else if (c === 22) st.b = st.d = false;
      else if (c === 23) st.i = false;
      else if (c === 24) st.u = false;
      else if (c >= 30 && c <= 37) st.fg = { cls: c - 30 };
      else if (c >= 90 && c <= 97) st.fg = { cls: c - 90 + 8 };
      else if (c === 39) st.fg = null;
      else if (c >= 40 && c <= 47) st.bg = { cls: c - 40 };
      else if (c >= 100 && c <= 107) st.bg = { cls: c - 100 + 8 };
      else if (c === 49) st.bg = null;
      else if (c === 38 || c === 48) {
        let col = null;
        if (p[k + 1] === 5) (col = xterm256(p[k + 2] ?? 0)), (k += 2);
        else if (p[k + 1] === 2) (col = { rgb: `rgb(${p[k + 2] ?? 0},${p[k + 3] ?? 0},${p[k + 4] ?? 0})` }), (k += 4);
        if (c === 38) st.fg = col;
        else st.bg = col;
      }
    }
  }
  flush(s.slice(last));
  return frag;
}
