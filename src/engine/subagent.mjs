// Subagents: the `task` tool runs one or more nested agent loops with read-only tools, side by side, and returns
// each one's final answer.
import { collectTurn } from './assemble.mjs';

export { collectTurn };

export const TASK_DEF = {
  name: 'task',
  description: 'Delegate self-contained, read-only research to subagents that run in parallel (at most 6 per call). Each subagent sees only its assignment, not this conversation; it can read files, search (glob, grep) and fetch web pages, but cannot change anything or run commands. Each returns one final written answer. Use it to investigate several areas at once or to keep large search output out of your own context. Write complete, specific assignments: what to find, where to look, what to report (paths with line numbers).',
  input_schema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: 'One entry per subagent (at most 6). They run at the same time.',
        items: { type: 'object', properties: { name: { type: 'string', description: 'Short label, e.g. "auth-flow".' }, task: { type: 'string', description: 'The full assignment.' } }, required: ['task'] },
      },
    },
    required: ['tasks'],
  },
};

export const SUBAGENT_TOOLS = new Set(['read', 'glob', 'grep', 'web_fetch', 'web_search']);
const MAX_TASKS = 6;
const MAX_TURNS = 30;

const textOfMsg = (m) => (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();

/**
 * Run the tasks of one `task` tool call. `ctx` supplies the model connection and callbacks:
 * { stream(args) -> async iterator, system, toolDefs, runTool(call, signal), signal, thinking, costOf(usage), onUpdate(agent), parentToolCallId, idPrefix, model }
 */
export async function runTasks(input, ctx) {
  const tasks = (Array.isArray(input?.tasks) ? input.tasks : input?.task ? [{ task: input.task, name: input.name }] : []).filter((t) => t && typeof t.task === 'string' && t.task.trim());
  if (!tasks.length) return { text: '`tasks` must list at least one assignment ({ task }).', isError: true };
  if (tasks.length > MAX_TASKS) return { text: `At most ${MAX_TASKS} tasks per call.`, isError: true };
  const agents = tasks.map((t, i) => ({
    id: `${ctx.idPrefix}-${i + 1}`,
    agent: t.name ? String(t.name).slice(0, 40) : 'task',
    assignment: t.task.trim(),
    parentToolCallId: ctx.parentToolCallId,
    status: 'running',
    toolCount: 0,
    tokens: 0,
    cost: 0,
    startedAt: Date.now(),
    durationMs: 0,
    resolvedModel: ctx.model,
    recentOutput: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
  const results = await Promise.all(agents.map((a) => runOne(a, ctx)));
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const a of agents) {
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) usage[k] += a.usage[k];
    if (a.costKnown) usage.cost = (usage.cost || 0) + a.cost;
  }
  const text = agents.map((a, i) => `## ${a.agent === 'task' ? `Task ${i + 1}` : a.agent} (${a.status})\n\n${results[i] || '(no answer)'}`).join('\n\n');
  const progress = agents.map(publicView);
  return { text, details: { progress, usage }, isError: agents.every((a) => a.status !== 'completed') };
}

const publicView = (a) => ({ id: a.id, agent: a.agent, assignment: a.assignment, parentToolCallId: a.parentToolCallId, status: a.status, toolCount: a.toolCount, tokens: a.tokens, cost: a.costKnown ? a.cost : undefined, durationMs: a.durationMs, resolvedModel: a.resolvedModel, recentOutput: a.recentOutput.slice(-3) });

async function runOne(a, ctx) {
  const ctl = new AbortController();
  const onParentAbort = () => ctl.abort();
  ctx.signal?.addEventListener('abort', onParentAbort, { once: true });
  const push = (line) => {
    a.recentOutput.push(String(line).replace(/\s+/g, ' ').slice(0, 160));
    if (a.recentOutput.length > 6) a.recentOutput.shift();
  };
  const tick = () => {
    a.durationMs = Date.now() - a.startedAt;
    ctx.onUpdate?.(publicView(a));
  };
  tick();
  const messages = [{ role: 'user', content: [{ type: 'text', text: a.assignment }], timestamp: Date.now() }];
  let answer = '';
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const last = turn === MAX_TURNS - 1;
      if (last) messages.push({ role: 'user', content: [{ type: 'text', text: 'You have used all your steps. Do not call any more tools. Write your final answer now from what you found.' }], timestamp: Date.now() });
      let lastText = 0;
      const msg = await collectTurn(ctx.stream({ system: ctx.system, messages, tools: ctx.toolDefs, signal: ctl.signal, thinking: ctx.thinking }), {
        text: () => {
          if (Date.now() - lastText > 1000) {
            lastText = Date.now();
            tick();
          }
        },
        retry: (ev) => {
          push(`retrying: ${ev.reason || 'provider error'}`);
          tick();
        },
      });
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) a.usage[k] += msg.usage[k] || 0;
      a.tokens = a.usage.input + a.usage.output + a.usage.cacheRead + a.usage.cacheWrite;
      const c = ctx.costOf?.(msg.usage);
      if (Number.isFinite(c)) {
        a.cost += c;
        a.costKnown = true;
      }
      messages.push({ ...msg, timestamp: Date.now() });
      const calls = msg.content.filter((c) => c.type === 'toolCall');
      const said = textOfMsg(msg);
      if (said) push(said.split('\n').filter(Boolean).pop() || '');
      if (!calls.length || last) {
        answer = said;
        break;
      }
      const outs = await Promise.all(
        calls.map(async (c) => {
          a.toolCount++;
          push(`${c.name} ${c.arguments?.path || c.arguments?.pattern || c.arguments?.url || ''}`.trim());
          tick();
          const r = c.invalidArguments ? { text: msg.stopReason === 'length' ? 'This tool call was cut off by the output token limit. Make smaller calls.' : 'The tool arguments were not valid JSON. Send them again as one JSON object.', isError: true } : !ctx.toolDefs.some((d) => d.name === c.name) ? { text: `Tool "${c.name}" is not available to subagents (read-only: ${[...SUBAGENT_TOOLS].join(', ')}).`, isError: true } : await ctx.runTool(c, ctl.signal);
          return { role: 'toolResult', toolCallId: c.id, toolName: c.name, content: [{ type: 'text', text: String(r.text ?? '').slice(0, 40000) }, ...(r.images || [])], isError: !!r.isError, timestamp: Date.now() };
        }),
      );
      messages.push(...outs);
      if (ctl.signal.aborted) break;
    }
    a.status = ctl.signal.aborted ? 'aborted' : answer ? 'completed' : 'failed';
    if (!answer && a.status === 'failed') answer = 'The subagent ended without an answer.';
  } catch (e) {
    a.status = ctl.signal.aborted ? 'aborted' : 'failed';
    answer = ctl.signal.aborted ? 'Stopped.' : `The subagent failed: ${e?.message || e}`;
    push(answer);
  } finally {
    ctx.signal?.removeEventListener('abort', onParentAbort);
  }
  tick();
  return answer;
}
