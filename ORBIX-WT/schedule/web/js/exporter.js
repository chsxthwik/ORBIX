// Turns a conversation into clean Markdown (for notes, bug reports, sharing). Pure text: nothing is invented;
// every line comes from the recorded messages.
import { toolSummary } from './tools.js';
import { textOf } from './store.js';

const fence = (s) => {
  const n = Math.max(3, ...(s.match(/`+/g) || []).map((x) => x.length + 1));
  return '`'.repeat(n);
};

export function conversationToMarkdown(tab) {
  const out = [];
  const model = tab.model ? `${tab.model.provider}/${tab.model.id}` : '';
  out.push(`# ${tab.name}`, '');
  out.push(`- Project: \`${tab.workspace}\``);
  if (model) out.push(`- Model: ${model}`);
  out.push(`- Exported: ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`, '');
  for (const m of tab.messages) {
    if (m.role === 'user') {
      const t = textOf(m.content).trim();
      if (t) out.push('## You', '', t, '');
    } else if (m.role === 'assistant') {
      const parts = [];
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'text' && b.text?.trim()) parts.push(b.text.trim());
        else if (b.type === 'toolCall') {
          const res = tab.results.get(b.id);
          const sum = toolSummary(b, res ? { content: res.content, details: res.details } : null, tab.workspace);
          if (b.name === 'bash' && b.arguments?.command) parts.push(`> \`bash\`${res?.isError ? ' (failed)' : ''}\n\n${fence(b.arguments.command)}sh\n${b.arguments.command}\n${fence(b.arguments.command)}`);
          else parts.push(`> \`${b.name}\`${sum ? ' ' + sum.replace(/\s+/g, ' ').slice(0, 160) : ''}${res?.isError ? ' (failed)' : ''}`);
        }
      }
      if (m.stopReason === 'error' && m.errorMessage) parts.push(`> **Error:** ${m.errorMessage.replace(/\n/g, ' ')}`);
      else if (m.stopReason === 'aborted') parts.push('> Stopped');
      if (parts.length) out.push('## Agent', '', parts.join('\n\n'), '');
    } else if (m.role === '_out' && m.text) {
      const f = fence(m.text);
      out.push(`${f}`, m.text.replace(/^```\n?|\n?```$/g, ''), f, '');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
