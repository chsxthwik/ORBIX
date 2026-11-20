// Shared by the inspector and tests. A successful command is not a verified build.
export function summarizeRun(tab) {
  const calls = new Map();
  for (const m of tab.messages || []) if (m.role === 'assistant' && Array.isArray(m.content)) {
    for (const c of m.content) if (c.type === 'toolCall' && c.id) calls.set(c.id, { id: c.id, name: c.name, args: c.arguments || {} });
  }
  for (const [id, run] of tab.tools || []) calls.set(id, { ...calls.get(id), id, name: run.name || calls.get(id)?.name, args: run.args || calls.get(id)?.args || {} });
  const rows = [...calls.values()].map(call => {
    const run = tab.tools?.get(call.id);
    const result = tab.results?.get(call.id) || run?.result;
    const exit = result?.details?.exitCode;
    const failed = !!result?.isError || run?.status === 'error' || (typeof exit === 'number' && exit !== 0);
    const status = failed ? 'error' : result ? 'done' : tab.waitingTool === call.id ? 'waiting' : run?.status === 'running' && !tab.dead ? 'running' : 'interrupted';
    const duration = run?.endedAt && run?.startedAt ? Math.max(0, run.endedAt-run.startedAt) : result?.details?.wallTimeMs;
    const path = result?.details?.path || call.args?.path || '';
    const detail = call.args?.command || path || call.args?.pattern || call.args?.query || call.name;
    return { ...call, status, detail: String(detail || ''), path, duration: Number.isFinite(duration) ? duration : null, exit, undone: !!result?.details?.undone };
  });
  const edited = [...new Set(rows.filter(r => /^(write|edit)$/.test(r.name) && r.status === 'done' && !r.undone && r.path).map(r=>r.path))];
  const tasks = (tab.todos || []).flatMap(p=>p.tasks || []);
  return { rows, edited, errors: rows.filter(r=>r.status==='error').length, running: rows.filter(r=>r.status==='running').length, done: rows.filter(r=>r.status==='done').length, tasks: { total: tasks.length, done: tasks.filter(t=>t.status==='completed').length } };
}

export function filterRunRows(rows, filter='all', query='') {
  const words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(r=>(filter==='all'||r.status===filter)&&words.every(w=>`${r.name} ${r.detail} ${r.path||''}`.toLocaleLowerCase().includes(w))).slice().reverse();
}
