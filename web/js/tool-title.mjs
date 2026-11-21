// Plain titles for tool steps ("Ran npm test", "Edited src/auth.js"). No DOM here, so tests can import it.

/**
 * The command a step runs, for its one-line title: the shell wrapper around it taken off
 * (`powershell -NoProfile -Command "Get-ChildItem x"` → `Get-ChildItem x`, also pwsh, cmd /c, bash -lc, sh -c, wsl -e),
 * the first line only, spaces collapsed. The full command still shows in the step's body and in every approval.
 */
export function shellCommand(raw) {
  let c = String(raw ?? '').trim();
  for (let i = 0; i < 3; i++) {
    const m =
      /^(?:powershell|pwsh)(?:\.exe)?\s+(?:-(?:NoProfile|NoLogo|NonInteractive|Sta|Mta)\s+|-ExecutionPolicy\s+\S+\s+|-WindowStyle\s+\S+\s+)*-(?:Command|c)\s+([\s\S]+)$/i.exec(c) ||
      /^cmd(?:\.exe)?\s+(?:\/[sdq]\s+)*\/[ck]\s+([\s\S]+)$/i.exec(c) ||
      /^(?:ba|z)?sh\s+-(?:l?c|cl)\s+([\s\S]+)$/i.exec(c) ||
      /^wsl(?:\.exe)?\s+(?:(?:-d|--distribution|-u|--user)\s+\S+\s+)*(?:-e|--exec|--)\s+([\s\S]+)$/i.exec(c);
    if (!m) break;
    c = m[1].trim();
    const q = c[0];
    if ((q === '"' || q === "'") && c.endsWith(q) && c.length > 1) c = c.slice(1, -1).replace(q === '"' ? /\\"/g : /'\\''/g, q);
  }
  return c.split('\n')[0].replace(/\s+/g, ' ').trim();
}

export const resultText = (res) => (res?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');

/**
 * What a tool step did, in words: { verb, subject }. The verb follows the step: "Running" while it runs, "Run"
 * while it waits for approval or after it was denied, "Could not edit" when it failed (a failed command still ran:
 * its exit code says how it went). `rel` shortens a path for display; `summary` is the step's one-line summary.
 */
export function toolTitle(call, res, status, { rel = (p) => p || '', summary = '' } = {}) {
  const a = call.arguments || {};
  const live = status === 'running' || status === 'pending';
  const asked = status === 'waiting' || status === 'denied';
  const failed = status === 'error';
  // [done, running, asking, failed]
  const pick = ([done, now, ask, fail = `Could not ${ask[0].toLowerCase()}${ask.slice(1)}`]) => (live ? now : asked ? ask : failed ? fail : done);
  const where = a.path ? `  in ${rel(a.path)}` : '';
  const n = Array.isArray(a.tasks) ? a.tasks.length : 0;
  const agents = (verb) => `${verb} ${n === 1 ? 'a helper agent' : `${n || ''} helper agents`.trim()}`;
  switch (call.name) {
    case 'bash':
      // The model's few words ("check free disk space") read better than the command; the command is in the body.
      return typeof a.description === 'string' && a.description.trim() ? { verb: pick(['Ran', 'Running', 'Run', 'Ran']), subject: a.description.replace(/\s+/g, ' ').trim().slice(0, 120), plain: true } : { verb: pick(['Ran', 'Running', 'Run', 'Ran']), subject: shellCommand(a.command) };
    case 'read':
      return { verb: pick(['Read', 'Reading', 'Read']), subject: rel(a.path) };
    case 'write':
      return { verb: pick([/^Created /.test(resultText(res)) ? 'Created' : 'Wrote', 'Writing', 'Write']), subject: rel(res?.details?.path || a.path) };
    case 'edit':
      return { verb: pick(['Edited', 'Editing', 'Edit']), subject: rel(res?.details?.path || a.path) };
    case 'grep':
      return { verb: pick(['Searched for', 'Searching for', 'Search for']), subject: `${a.pattern || ''}${where}` };
    case 'glob':
      return { verb: pick(['Found files matching', 'Finding files matching', 'Find files matching']), subject: `${a.pattern || ''}${where}` };
    case 'web_search':
      return { verb: pick(['Searched the web for', 'Searching the web for', 'Search the web for']), subject: a.query || '' };
    case 'web_fetch':
      return { verb: pick(['Fetched', 'Fetching', 'Fetch']), subject: a.url || '' };
    case 'todo':
      return { verb: pick(['Updated the task list', 'Updating the task list', 'Update the task list']), subject: summary };
    case 'task':
      return { verb: pick([agents('Ran'), agents('Running'), agents('Run')]), subject: summary };
    default:
      return { verb: pick(['Used', 'Using', 'Use']), subject: call.intent || call.name };
  }
}
