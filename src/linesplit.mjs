// Turn a stream of text chunks into lines, in time linear in the input. Each chunk is scanned once; a line that spans
// many chunks is kept as a list of parts until its newline arrives. (Appending every chunk to one buffer and searching
// the whole buffer for a newline again on each chunk made a long line quadratic: one 32 MB JSON message in 64 KB
// chunks meant ~512 scans of a growing string, seconds of CPU for a single MCP or agent message.)
//
//   const split = lineSplitter((line) => …, { maxLine, onOverflow });
//   child.stdout.on('data', (d) => split.push(d));
//   child.on('close', () => { const last = split.rest(); if (last) … });
//
// `onLine(line)` gets each line without its "\n" (a trailing "\r" is left to the caller); returning false stops the
// splitter (push returns false and ignores what follows). A line longer than `maxLine` characters is dropped up to
// its newline and reported once through `onOverflow()`, so one runaway line cannot eat memory.

export function lineSplitter(onLine, { maxLine = Infinity, onOverflow } = {}) {
  let parts = [];
  let size = 0;
  let skipping = false; // dropping the rest of an over-long line until its newline
  let stopped = false;
  return {
    push(chunk) {
      if (stopped) return false;
      chunk = String(chunk);
      let start = 0;
      if (skipping) {
        const nl = chunk.indexOf('\n');
        if (nl < 0) return true;
        skipping = false;
        start = nl + 1;
      }
      let i;
      while ((i = chunk.indexOf('\n', start)) >= 0) {
        let line = chunk.slice(start, i);
        if (parts.length) {
          parts.push(line);
          line = parts.join('');
          parts = [];
          size = 0;
        }
        start = i + 1;
        if (onLine(line) === false) {
          stopped = true;
          return false;
        }
      }
      if (start < chunk.length) {
        const rest = start ? chunk.slice(start) : chunk;
        parts.push(rest);
        size += rest.length;
        if (size > maxLine) {
          parts = [];
          size = 0;
          skipping = true;
          onOverflow?.();
        }
      }
      return true;
    },
    /** What came after the last newline (a stream that ended without one), and forget it. */
    rest() {
      const r = parts.join('');
      parts = [];
      size = 0;
      return r;
    },
  };
}
