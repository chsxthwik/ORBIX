// Turns a conversation into clean Markdown (for notes, bug reports, sharing). Pure text: nothing is invented;
// every line comes from the recorded messages.
import { toolSummary } from './tools.js';
import { textOf } from './store.js';
import { h, toast } from './dom.js';
import { btn, modal } from './dialogs.js';
import { api } from './api.js';
import { portableTranscript, TRANSCRIPT_FORMAT, TRANSCRIPT_MAX_BYTES } from './portable-transcript.mjs';

export function exportPortableTranscript(tab) {
  try {
    const messages = tab.messages.filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, text: textOf(m.content) })).filter((m) => m.text.trim());
    const transcript = portableTranscript({ format: TRANSCRIPT_FORMAT, version: 1, title: tab.name, messages });
    const file = new Blob([JSON.stringify(transcript)], { type: 'application/json' });
    if (file.size > TRANSCRIPT_MAX_BYTES) throw new Error('This portable transcript exceeds 16 MB.');
    const url = URL.createObjectURL(file);
    const link = h('a', { href: url, download: 'conversation.orbix.json' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    toast(error.message, 'error');
  }
}

export function importPortableTranscript(projects, onImport) {
  if (!projects.length) return toast('Open a project before importing a transcript.', 'info');
  const project = h('select', null, projects.map((p) => h('option', { value: p.id }, p.name || p.path)));
  const file = h('input', { type: 'file', accept: '.json,application/json' });
  const error = h('p', { class: 'warn-text', role: 'alert' });
  const dialog = modal({
    title: 'Import portable transcript', initialFocus: file,
    body: h('div', null, h('p', null, 'Import user and assistant text into a new ORBIX conversation. Tool history and attachments are not imported.'),
      h('label', { class: 'field' }, 'Project', project), h('label', { class: 'field' }, 'Transcript', file), error),
    actions: [btn('Cancel', () => dialog.close()), btn('Import', async () => {
      error.textContent = '';
      try {
        const chosen = file.files[0];
        if (!chosen) throw new Error('Choose a portable transcript file.');
        if (chosen.size > TRANSCRIPT_MAX_BYTES) throw new Error('This portable transcript exceeds 16 MB.');
        let value;
        try {
          value = JSON.parse((await chosen.text()).replace(/^\uFEFF/, ''));
        } catch {
          throw new Error('That file does not contain valid JSON.');
        }
        const transcript = portableTranscript(value);
        const { session } = await api.post('/api/sessions/import', { projectId: project.value, transcript });
        dialog.close();
        onImport(session);
      } catch (err) {
        error.textContent = err.message;
      }
    }, 'primary')],
  });
}

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
