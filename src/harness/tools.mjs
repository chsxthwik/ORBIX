// Each agent CLI names its tools its own way (Claude Code "Bash", Codex "commandExecution", ACP kind "execute").
// ORBIX shows them with its own names and arguments (bash, read, edit, grep…) so a step reads the same whatever
// agent ran it: "Ran npm test", "Edited src/app.js". The original name and input stay in the step's arguments.

const pick = (o, ...keys) => {
  for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k];
  return undefined;
};

/** A Claude Code tool call → { name, arguments } in ORBIX terms. */
export function fromClaude(name, input = {}) {
  const a = input || {};
  const path = pick(a, 'file_path', 'path', 'notebook_path');
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return { name: 'bash', arguments: { command: a.command || '', ...(a.description ? { description: a.description } : {}), tool: name } };
    case 'Read':
      return { name: 'read', arguments: { path, tool: name } };
    case 'Write':
      return { name: 'write', arguments: { path, content: a.content, tool: name } };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { name: 'edit', arguments: { path, ...(a.old_string != null ? { oldText: a.old_string, newText: a.new_string } : {}), tool: name } };
    case 'Glob':
      return { name: 'glob', arguments: { pattern: a.pattern, path: a.path, tool: name } };
    case 'Grep':
      return { name: 'grep', arguments: { pattern: a.pattern, path: a.path, tool: name } };
    case 'WebFetch':
      return { name: 'web_fetch', arguments: { url: a.url, tool: name } };
    case 'WebSearch':
      return { name: 'web_search', arguments: { query: a.query, tool: name } };
    default:
      return { name: name || 'tool', arguments: { ...a, tool: name } };
  }
}

/** A Codex app-server thread item → { name, arguments } (null for items that are not tool steps). */
export function fromCodex(item = {}) {
  switch (item.type) {
    case 'commandExecution':
      return { name: 'bash', arguments: { command: Array.isArray(item.command) ? item.command.join(' ') : item.command || '', tool: 'commandExecution' } };
    case 'fileChange': {
      const files = (item.changes || []).map((c) => c.path).filter(Boolean);
      return { name: files.length === 1 ? 'edit' : 'patch', arguments: { path: files[0] || '', files, tool: 'fileChange' } };
    }
    case 'webSearch':
      return { name: 'web_search', arguments: { query: item.query || '', tool: 'webSearch' } };
    case 'mcpToolCall':
      return { name: `${item.server || 'mcp'}:${item.tool || 'tool'}`, arguments: { ...(item.arguments || {}), tool: 'mcpToolCall' } };
    case 'dynamicToolCall':
    case 'functionCall':
      return { name: item.name || item.tool || 'tool', arguments: { ...(item.arguments || {}), tool: item.type } };
    case 'imageView':
      return { name: 'read', arguments: { path: item.path || '', tool: 'imageView' } };
    default:
      return null;
  }
}

/** An ACP tool call (kind, title, rawInput, locations) → { name, arguments, intent }. */
export function fromAcp(call = {}) {
  const raw = call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {};
  const path = call.locations?.[0]?.path || pick(raw, 'filePath', 'file_path', 'path');
  const title = String(call.title || '').trim();
  switch (call.kind) {
    case 'execute':
      return { name: 'bash', arguments: { command: pick(raw, 'command', 'cmd') || title, ...(raw.description ? { description: raw.description } : {}), tool: call.kind }, intent: title };
    case 'read':
      return { name: 'read', arguments: { path: path || title, tool: call.kind }, intent: title };
    case 'edit':
    case 'delete':
    case 'move':
      return { name: 'edit', arguments: { path: path || title, tool: call.kind }, intent: title };
    case 'search':
      return { name: 'grep', arguments: { pattern: pick(raw, 'pattern', 'query') || title, path: raw.path, tool: call.kind }, intent: title };
    case 'fetch':
      return { name: 'web_fetch', arguments: { url: pick(raw, 'url') || title, tool: call.kind }, intent: title };
    default:
      return { name: call.kind && call.kind !== 'other' ? call.kind : 'tool', arguments: { ...raw, tool: call.kind || 'other' }, intent: title };
  }
}

/** Text out of a tool result in any of the shapes the CLIs use (string, content blocks, ACP content). */
export function resultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(resultText).filter(Boolean).join('\n');
  if (typeof content === 'object') {
    if (content.type === 'text') return content.text || '';
    if (content.type === 'image') return '[image]';
    if (content.type === 'content') return resultText(content.content);
    if (content.type === 'diff') return `${content.path || ''}\n${content.newText != null ? '(file changed)' : ''}`.trim();
    if (content.type === 'terminal') return '';
    if (typeof content.text === 'string') return content.text;
  }
  return '';
}
