// Word-level diff of two lines: which words changed between a removed line and the added line that replaced it.
// Pure (no DOM), so it runs under node --test.

const TOK = /[\p{L}\p{N}_$]+|\s+|[^\p{L}\p{N}_$\s]/gu;

/**
 * Character ranges [start, end) of the words that differ, as [rangesInA, rangesInB], or null when there is nothing
 * worth marking: identical lines, very long lines, or lines that share so little that the whole line is the change.
 */
export function wordDiff(a, b) {
  if (a === b || a.length > 1200 || b.length > 1200) return null;
  const x = a.match(TOK) || [];
  const y = b.match(TOK) || [];
  const n = x.length;
  const m = y.length;
  if (!n || !m || n * m > 120000) return null;
  // Longest common subsequence of tokens.
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ka = new Uint8Array(n);
  const kb = new Uint8Array(m);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (x[i] === y[j]) {
      ka[i++] = 1;
      kb[j++] = 1;
    } else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  compact(x, ka);
  compact(y, kb);
  let same = 0;
  x.forEach((t, i) => {
    if (ka[i]) same += t.replace(/\s/g, '').length;
  });
  const total = Math.max(a.replace(/\s/g, '').length, b.replace(/\s/g, '').length);
  if (!total || same / total < 0.4) return null;
  const ra = changed(x, ka);
  const rb = changed(y, kb);
  return ra.length || rb.length ? [ra, rb] : null;
}

/**
 * The alignment can split one change in two around a repeated token: "trim().toLowerCase())" against "trim())" may
 * keep the wrong ")" and mark ".toLowerCase(" and ")" apart. A changed run whose last token equals the kept token
 * before it can shift left by one without changing what matches; shift it when that joins it to the run before.
 */
function compact(toks, kept) {
  for (let e = toks.length; e > 0; ) {
    if (kept[e - 1]) {
      e--;
      continue;
    }
    let s = e - 1;
    while (s > 0 && !kept[s - 1]) s--;
    let a = s;
    let b = e;
    while (a > 0 && kept[a - 1] && toks[a - 1] === toks[b - 1]) {
      a--;
      b--;
    }
    if (a < s && a > 0 && !kept[a - 1]) {
      for (let i = a; i < s; i++) kept[i] = 0;
      for (let i = b; i < e; i++) kept[i] = 1;
    }
    e = a < s && a > 0 && !kept[a - 1] ? a : s;
  }
}

/** Ranges of the tokens not kept. Ranges with only spaces between them join; a change of spaces alone is not marked. */
function changed(toks, kept) {
  const out = [];
  let pos = 0;
  let gap = ''; // kept text since the last range
  toks.forEach((t, i) => {
    const s = pos;
    pos += t.length;
    if (kept[i]) {
      gap += t;
      return;
    }
    const last = out[out.length - 1];
    if (last && !gap.trim()) last[1] = pos;
    else if (t.trim()) out.push([s, pos]);
    else return;
    gap = '';
  });
  return out;
}
