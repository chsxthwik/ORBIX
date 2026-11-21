// Finds completed preview blocks in an append-only stream. A caller that replaces earlier text resets the cursor.
export class MarkdownBoundary {
  constructor() { this.reset(); }

  reset() {
    this.scanned = 0;
    this.lineStart = 0;
    this.cut = 0;
    this.blank = 0;
    this.fence = null;
  }

  advance(text) {
    let at = this.scanned;
    for (let end; (end = text.indexOf('\n', at)) !== -1; at = end + 1) {
      const line = text.slice(this.lineStart, end);
      const empty = !line.trim();
      if (this.blank && (empty || /^\S/.test(line))) this.cut = this.blank;
      this.blank = 0;
      const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (!this.fence) this.fence = f || null;
      else if (f?.[0] === this.fence[0] && f.length >= this.fence.length && !line.trim().slice(f.length).trim()) this.fence = null;
      this.lineStart = end + 1;
      if (!this.fence && empty) this.blank = this.lineStart;
    }
    // Only commit a blank line once there's enough of the next line to rule out an indented continuation.
    if (this.blank && this.lineStart < text.length && /^\S/.test(text[this.lineStart])) this.cut = this.blank;
    this.scanned = text.length;
    return this.cut;
  }
}

export const LIVE_MARKDOWN_LIMIT = 8192;

/** Bound work for an unfinished paragraph or fence. The full text is rendered when the message finishes. */
export function liveExcerpt(text) {
  if (text.length <= LIVE_MARKDOWN_LIMIT) return text;
  let start = text.length - LIVE_MARKDOWN_LIMIT;
  if (/[\uDC00-\uDFFF]/.test(text[start])) start++;
  return `…\n${text.slice(start)}`;
}
