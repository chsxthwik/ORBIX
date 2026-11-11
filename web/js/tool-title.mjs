// Plain titles for tool steps ("Ran npm test", "Edited src/auth.js"). No DOM here, so tests can import it.

const resultText = (res) => (res?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');

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
      return { verb: pick(['Ran', 'Running', 'Run', 'Ran']), subject: String(a.command || '').split('\n')[0] };
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
      return { verb: pick(['Updated the plan', 'Updating the plan', 'Update the plan']), subject: summary };
    case 'task':
      return { verb: pick([agents('Ran'), agents('Running'), agents('Run')]), subject: summary };
    default:
      return { verb: pick(['Used', 'Using', 'Use']), subject: call.intent || call.name };
  }
}
