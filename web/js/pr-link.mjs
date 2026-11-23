// The link that opens a pull request (GitHub) or merge request (GitLab) with its title and body already filled in.
// No DOM and no network: ORBIX pushes the branch, the page opens this link. The body is cut so the address stays
// within what browsers and servers accept (about 7,000 characters).
const MAX = 6500;

/** { host, web, branch, base, title, body } -> the link, or '' when the host has no known link format. */
export function prUrl({ host, web, branch, base, title, body }) {
  if (!web || !branch) return '';
  const cut = (text, room) => (text.length > room ? `${text.slice(0, Math.max(0, room - 40)).trimEnd()}\n\n(shortened; see the commits)` : text);
  const enc = encodeURIComponent;
  if (host === 'github') {
    const head = `${web}/compare/${base ? `${enc(base)}...` : ''}${enc(branch)}`;
    const t = String(title || '');
    const rest = MAX - head.length - 40 - enc(t).length;
    return `${head}?quick_pull=1&title=${enc(t)}&body=${enc(cut(String(body || ''), Math.max(200, Math.floor(rest / 3))))}`;
  }
  if (host === 'gitlab') {
    const head = `${web}/-/merge_requests/new`;
    const t = String(title || '');
    const rest = MAX - head.length - 120 - enc(t).length;
    return `${head}?merge_request[source_branch]=${enc(branch)}${base ? `&merge_request[target_branch]=${enc(base)}` : ''}&merge_request[title]=${enc(t)}&merge_request[description]=${enc(cut(String(body || ''), Math.max(200, Math.floor(rest / 3))))}`;
  }
  return '';
}

/* A written message may carry labels ("Title:", "**Body:**"): a label counts only with a colon or dash, or in bold. */
const TITLE_LABEL = /^(?:\*\*\s*)?(?:pr |pull request |commit )?title\s*(?:\*\*\s*)?[:\-–]\s*(?:\*\*\s*)?/i;
const BODY_LABEL = /^\s*(?:\*\*\s*(?:pr |pull request )?(?:body|description)\s*:?\s*\*\*\s*:?|(?:pr |pull request )?(?:body|description)\s*[:\-–])\s*\n?/i;

/**
 * Split what a model wrote into a title and a body: the first line is the title (a "Title:" label, a Markdown heading
 * mark, quotes and a final full stop are taken off, 72 characters at most), the rest is the body.
 */
export function splitMessage(text) {
  const lines = String(text || '').replace(/^```[a-z]*\s*\n?|\n?```\s*$/gi, '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  if (!lines.length) return { title: '', body: '' };
  let title = lines.shift().trim().replace(/^#+\s*/, '').replace(TITLE_LABEL, '').replace(/\*\*/g, '').replace(/^["'`“]+|["'`”]+$/g, '').replace(/\.$/, '').trim();
  if (title.length > 72) title = `${title.slice(0, 71).trimEnd()}…`;
  const body = lines.join('\n').replace(BODY_LABEL, '').trim();
  return { title, body };
}

/** A commit message from a title and body: the title, a blank line, the body. */
export const joinMessage = (title, body) => [String(title || '').trim(), String(body || '').trim()].filter(Boolean).join('\n\n');
