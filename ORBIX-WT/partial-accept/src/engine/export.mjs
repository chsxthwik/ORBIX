// export_html: one self-contained HTML file of a conversation. Everything from the conversation is escaped;
// the page has no scripts and loads nothing from outside.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../store.mjs';
import { escapeHtml as esc, textOf as joinText } from '../util.mjs';

const textOf = (content) => joinText(content ?? '', '\n');
const clipText = (s, n) => (s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more characters]` : s);

/** Very small, safe Markdown: fenced code, inline code, bold, headings, paragraphs. Input is escaped first. */
function md(src) {
  const out = [];
  const parts = String(src).split(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/m);
  parts.forEach((p, i) => {
    if (i % 2) return out.push(`<pre><code>${esc(p.replace(/\n$/, ''))}</code></pre>`);
    for (const block of p.split(/\n{2,}/)) {
      if (!block.trim()) continue;
      let b = esc(block.trim());
      b = b.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      const hm = /^(#{1,6}) (.*)$/.exec(b);
      if (hm && !b.includes('\n')) out.push(`<h${Math.min(6, hm[1].length + 2)}>${hm[2]}</h${Math.min(6, hm[1].length + 2)}>`);
      else out.push(`<p>${b.replace(/\n/g, '<br>')}</p>`);
    }
  });
  return out.join('\n');
}

export function conversationHtml({ title, workspace, model, messages }) {
  const results = new Map(messages.filter((m) => m.role === 'toolResult').map((m) => [m.toolCallId, m]));
  const body = [];
  for (const m of messages) {
    if (m.role === 'user') {
      body.push(`<section class="u"><div class="who">You${m.attribution === 'steer' ? ' (steer)' : ''}</div>${md(textOf(m.content))}${(m.attachments || []).map((a) => `<div class="att">attached ${esc(a.path)}</div>`).join('')}${(m.content || []).some?.((c) => c.type === 'image') ? '<div class="att">[image attached]</div>' : ''}</section>`);
    } else if (m.role === 'assistant') {
      const parts = [];
      for (const c of m.content || []) {
        if (c.type === 'text' && c.text.trim()) parts.push(md(c.text));
        else if (c.type === 'thinking' && c.thinking?.trim()) parts.push(`<details class="th"><summary>Thinking</summary>${md(c.thinking)}</details>`);
        else if (c.type === 'toolCall') {
          const r = results.get(c.id);
          const res = r ? clipText(textOf(r.content), 20000) : '(no result)';
          parts.push(`<details class="tool${r?.isError ? ' err' : ''}"><summary><b>${esc(c.name)}</b> ${esc(clipText(JSON.stringify(c.arguments || {}), 160))}</summary><pre>${esc(JSON.stringify(c.arguments || {}, null, 2))}</pre><pre>${esc(res)}</pre></details>`);
        }
      }
      if (m.stopReason === 'error' && m.errorMessage) parts.push(`<div class="errbox">${esc(m.errorMessage)}</div>`);
      if (parts.length) body.push(`<section class="a"><div class="who">Agent${m.model ? ` <span>${esc(m.model)}</span>` : ''}</div>${parts.join('\n')}</section>`);
    } else if (m.role === 'compactionSummary') {
      body.push(`<details class="sum"><summary>Earlier context was compacted</summary>${md(m.summary)}</details>`);
    }
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${esc(title)}</title>
<style>
:root{--bg:#fff;--fg:#1d2230;--mut:#667085;--line:#e4e7ec;--u:#eef2ff;--code:#f5f6f8;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e6e8ee;--mut:#98a2b3;--line:#262a33;--u:#1c2240;--code:#171a21;--err:#f97066}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}.meta{color:var(--mut);font-size:13px;margin-bottom:24px}
section{margin:14px 0;padding:10px 14px;border-radius:12px}section.u{background:var(--u)}section.a{border:1px solid var(--line)}
.who{font-size:12px;font-weight:600;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}.who span{text-transform:none;font-weight:400}
pre{background:var(--code);padding:10px;border-radius:8px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:12.5px/1.5 ui-monospace,Consolas,monospace}
code{font-family:ui-monospace,Consolas,monospace;font-size:.92em}p code{background:var(--code);padding:1px 4px;border-radius:4px}
details{margin:6px 0;border:1px solid var(--line);border-radius:8px;padding:4px 10px}summary{cursor:pointer;color:var(--mut);font-size:13px}summary b{color:var(--fg)}
details.err summary b{color:var(--err)}.errbox{color:var(--err);white-space:pre-wrap}.att{font-size:12px;color:var(--mut)}
</style></head><body><main>
<h1>${esc(title)}</h1>
<div class="meta">${esc(workspace)}${model ? ' · ' + esc(model) : ''} · exported ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC</div>
${body.join('\n')}
</main></body></html>
`;
}

export function writeExport(conv) {
  const dir = path.join(DATA_DIR, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(conv.title || 'conversation').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'conversation';
  const file = path.join(dir, `${safe}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.html`);
  fs.writeFileSync(file, conversationHtml(conv), 'utf8');
  return file;
}
