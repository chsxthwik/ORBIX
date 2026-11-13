// Slash commands of the ORBIX agent: /help /plan /retry /undo /compact /model /mcp /skills /cost /branch /goal /memory /hooks,
// the prompt commands /init /review /commit, skills as /skill:<name>,
// and custom Markdown commands (commands.mjs). Runs against one AgentProc (engine/proc.mjs).
import { discoverCommands, expandCommand } from './commands.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { readSkill } from './skills.mjs';
import { loadInstructions } from './context.mjs';
import { readHooksFile, listHooks, userHooksPath, projectHooksPath, hooksTrusted } from './hooks.mjs';
import { isWinPath } from '../backend.mjs';

/** Built-in commands that are just a prepared request to the agent. A project's own file of the same name wins. */
const PROMPTS = {
  init: 'Look through this project (its structure, how it is built, tested and run, its conventions) and write an AGENTS.md at the project root: the project memory that is loaded into every future session. Keep it short and factual (under about 120 lines): the commands to build, test and run; where things live; the rules a newcomer would get wrong. Only write what you checked in the project. If an AGENTS.md already exists, read it first and refresh it (keep what is still true, fix what is outdated, add what is missing) instead of replacing it.',
  review: 'Review the uncommitted changes in this project: run `git status` and `git diff` (and `git diff --cached` for staged changes). Report bugs, risky changes and missing tests, the most important first, each with the file and line. Do not change any files.',
  commit: 'Look at the staged changes with `git diff --cached`. If nothing is staged, say so and stop. Otherwise write a clear commit message (a short summary line; then, only if useful, a blank line and a few lines on why) and commit with it using `git commit`.',
};

export const HELP = [
  'ORBIX agent. What you can do here:',
  '• Describe a task. The agent reads, searches, edits files, runs commands and fetches web pages to do it.',
  '• Every file change and command asks for your approval first (change this in Settings → Behavior).',
  '• `@path` in a message attaches that file (an image is sent as an image; a folder as a listing). `/plan` switches to read-only planning and back.',
  '• `/retry` answers your last message again (the old reply is replaced).',
  '• `/init` writes an AGENTS.md for the project, `/review` reviews your uncommitted changes, `/commit` writes a message for the staged changes and commits (it asks first).',
  '• `/model fast|plan <provider/model>` sets the fast model (titles, summaries, helper agents) or the plan model for this session; defaults are in Settings → Models.',
  '• `/branch` continues the conversation in a new tab (files stay as they are); every message of yours also has a Branch button.',
  '• `/goal <text>` keeps the agent working on its own (up to 6 rounds) until it ends with GOAL_DONE or asks you something. Esc stops it.',
  '• `/memory` shows the project memory file (AGENTS.md); `/hooks` lists the commands that run before and after tool calls (Settings → Tools & MCP).',
  '• `/compact [focus]` summarizes older messages to free context (it also happens by itself near the limit).',
  '• `/undo` reverts the file changes from the last reply. Each edit card also has its own Undo button.',
  '• `/model`, `/mcp`, `/skills`, `/cost` show or change the model, MCP servers, skills and session cost.',
  '• Send a message while it works: it is added as a steer before the next step. Alt+Enter queues it for after.',
  '• Project rules: AGENTS.md (or CLAUDE.md) at the project root. Custom commands: Markdown files in `.omp/commands` or `.claude/commands` (`$ARGUMENTS` is replaced). Skills: folders with SKILL.md in `.agents/skills`, `.claude/skills` or `.omp/skills`. MCP servers: Settings → Tools & MCP, or `.mcp.json` in the project.',
].join('\n');

/**
 * Handle a `/command` typed into an agent session. true = handled here; { started: true } = handled and the agent
 * is running; { text } = send this text to the agent instead; false = not a command (e.g. a path like /etc/hosts).
 */
export async function runSlash(agent, text) {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
  if (!m) return false;
  const name = m[1];
  const args = m[2].trim();
  const cmd = name.toLowerCase();
  const busy = () => {
    agent._out(`Wait for the agent to finish (or stop it), then run /${cmd}.`);
    return true;
  };
  switch (cmd) {
    case 'help':
      agent._out(typeof agent._searchOn !== 'function' ? HELP : `${HELP}\n• ${agent._searchOn() ? '`web_search` is on: the agent can search the web.' : '`web_search` is off. Turn it on in Settings → Tools & MCP → Web search by adding a Brave Search key, a Tavily key or your own SearXNG address.'}`);
      return true;
    case 'retry':
      if (agent.streaming) return busy();
      try {
        await agent._regenerate({});
        return { started: true };
      } catch (e) {
        agent._out(e.message);
        return true;
      }
    case 'undo':
      if (agent.streaming) return busy();
      agent._out((await agent._undoLastTurn()).text);
      return true;
    case 'compact':
      if (agent.streaming) return busy();
      agent._exclusive(() => agent._compactCmd(args)).catch((e) => agent.emit('stderr', String(e?.stack || e)));
      return true;
    case 'plan':
      agent.planMode = !agent.planMode;
      if (agent.session) agent._persistRaw({ type: 'plan', on: agent.planMode });
      agent._planStatus();
      agent._out(agent.planMode ? 'Plan mode is **on**: the agent only reads and searches, then proposes a plan. Nothing is changed. Type /plan again to let it make changes.' : 'Plan mode is **off**: the agent can edit files and run commands again (with your approval).');
      return true;
    case 'model': {
      const role = /^(fast|plan)(?:\s+([\s\S]*))?$/i.exec(args);
      if (role) {
        try {
          agent._out(await agent._setRole(role[1].toLowerCase(), role[2] || ''));
        } catch (e) {
          agent._out(`Could not set the ${role[1].toLowerCase()} model: ${e.message}`);
        }
        return true;
      }
      if (!args) {
        const fast = agent._roleSpec?.('fast');
        const plan = agent._roleSpec?.('plan');
        agent._out(`Current model: **${agent.model ? `${agent.provider ? agent.provider + '/' : ''}${agent.model}` : 'not chosen yet'}**${agent.thinkingLevel !== 'off' ? ` (thinking: ${agent.thinkingLevel})` : ''}. Switch with \`/model provider/model-id\` or the model button in the header.\nFast model (titles, summaries, helper agents): ${fast ? `**${fast}**` : 'the current model'}. Plan model (/plan): ${plan ? `**${plan}**` : 'the current model'}. Change with \`/model fast <provider/model>\` or \`/model plan <provider/model>\`.`);
        return true;
      }
      try {
        const spec = agent._parseSpec(args);
        const models = await agent._models().catch(() => []);
        const hit = models.find((x) => x.id === spec.model && (!spec.provider || x.provider === spec.provider));
        if (models.length && !hit) throw new Error(`No model "${args}". Open the model picker to see what is available.`);
        await agent._setModel(spec.provider || hit?.provider, spec.model);
        agent._out(`Model switched to **${agent.provider}/${agent.model}**.`);
      } catch (e) {
        agent._out(`Could not switch model: ${e.message}`);
      }
      return true;
    }
    case 'branch':
      try {
        const r = agent._branch({});
        agent._out(`Branch created: **${r.title}**. It opens in a new tab with the conversation so far. Your files were not changed.`);
      } catch (e) {
        agent._out(`Could not branch: ${e.message}`);
      }
      return true;
    case 'goal': {
      if (/^(stop|off|cancel|clear)$/i.test(args)) {
        if (agent.goal) agent._endGoal('Goal stopped.');
        else agent._out('No goal is running.');
        return true;
      }
      if (!args) {
        agent._out(agent.goal ? `Goal round ${agent.goal.round} of ${agent.goal.max}: ${agent.goal.text}\nPress Esc or type /goal stop to end it.` : 'Usage: `/goal <what to achieve>`. The agent keeps working on it by itself (up to 6 rounds) until it ends a reply with GOAL_DONE or asks you a question. Esc stops it.');
        return true;
      }
      if (agent.streaming) return busy();
      if (agent.goal) agent._endGoal();
      return { text: agent._startGoal(args), attribution: 'goal' };
    }
    case 'memory': {
      const host = agent.backend.hostPath(agent.workspace);
      const join = (root, rel) => (isWinPath(root) ? path.win32.join(root, rel) : path.posix.join(root, rel));
      const file = join(agent.workspace, 'AGENTS.md');
      let size = null;
      try {
        size = fs.statSync(path.join(host, 'AGENTS.md')).size;
      } catch {}
      const loaded = await loadInstructions(agent.backend, agent.workspace).catch(() => []);
      const lines = [size == null ? `Project memory file: \`${file}\` does not exist yet. Type /init and the agent writes it.` : `Project memory file: \`${file}\` (${size} bytes). It is loaded into every session. Edit it by hand, or type /init to have the agent refresh it.`];
      const others = loaded.filter((r) => path.resolve(r.path) !== path.resolve(path.join(host, 'AGENTS.md')));
      if (others.length) lines.push('Other instruction files in use:', ...others.map((r) => `- \`${r.path}\``));
      agent._out(lines.join('\n'));
      return true;
    }
    case 'hooks': {
      const host = agent.backend.hostPath(agent.workspace);
      const user = readHooksFile(userHooksPath());
      const proj = readHooksFile(projectHooksPath(host));
      const fmt = (r) => listHooks(r).map((x) => `- **${x.event}**${x.matcher ? ` [${x.matcher}]` : ''}: \`${x.command}\``);
      const out = [`Your hooks (\`${user.file}\`): ${user.exists ? (user.count ? '' : 'none') : 'file not created'}`, ...fmt(user), ...user.errors.map((e) => `  problem: ${e}`)];
      out.push(`This project's hooks (\`${proj.file}\`): ${proj.exists ? (proj.count ? (hooksTrusted(agent.backend.keyPath(agent.workspace), proj.hooks) ? 'allowed' : 'ask before the first run') : 'none') : 'file not found'}`, ...fmt(proj), ...proj.errors.map((e) => `  problem: ${e}`));
      out.push('A hook runs a command with JSON on stdin. Exit code 2 blocks the action and tells the agent why.');
      agent._out(out.join('\n'));
      return true;
    }
    case 'mcp': {
      if (!agent.streaming) await agent.mcp.ensureStarted().catch(() => {});
      const st = agent.mcp.status();
      agent._out(st.length ? st.map((s) => `- **${s.name}** (${s.scope}): ${s.status}${s.error ? ': ' + s.error : ''}${s.tools.length ? `\n  tools: ${s.tools.join(', ')}` : ''}`).join('\n') : 'No MCP servers are configured. Add one in Settings → Tools & MCP, or put a `.mcp.json` in the project.');
      return true;
    }
    case 'skills': {
      const sk = await agent._skills();
      agent._out(sk.length ? sk.map((s) => `- **${s.name}**: ${s.description || '(no description)'}  \n  \`${s.path}\``).join('\n') : 'No skills found. Put a folder with a SKILL.md in `.agents/skills`, `.claude/skills` or `.omp/skills` of the project.');
      return true;
    }
    case 'cost': {
      const s = agent._stats();
      const cu = s.contextUsage;
      agent._out(`Tokens: ${s.tokens.input} in, ${s.tokens.output} out, ${s.tokens.cacheRead} cache read, ${s.tokens.cacheWrite} cache write.\nCost: ${s.cost !== undefined ? '$' + s.cost.toFixed(4) : 'unknown for this model'}.${cu ? `\nContext: ${cu.tokens} of ${cu.contextWindow} tokens (${cu.percent.toFixed(0)}%).` : ''}`);
      return true;
    }
    default:
      break;
  }
  if (cmd.startsWith('skill:')) {
    const want = name.slice(6).toLowerCase();
    const sk = (await agent._skills()).find((s) => s.name.toLowerCase() === want);
    if (!sk) {
      agent._out(`No skill named "${name.slice(6)}". Type /skills to see them.`);
      return true;
    }
    const body = await readSkill(sk).catch(() => '');
    return { text: `Use the "${sk.name}" skill for this request. Its instructions (from ${sk.path}):\n\n<skill name="${sk.name}">\n${body}\n</skill>${args ? `\n\nRequest: ${args}` : ''}` };
  }
  const custom = (await discoverCommands(agent.backend.hostPath(agent.workspace)).catch(() => [])).find((c) => c.name.toLowerCase() === cmd);
  if (custom) {
    try {
      return { text: await expandCommand(custom, args) };
    } catch (e) {
      agent._out(`Could not read /${custom.name}: ${e.message}`);
      return true;
    }
  }
  if (PROMPTS[cmd]) return { text: args ? `${PROMPTS[cmd]}\n\nFocus: ${args}` : PROMPTS[cmd] };
  // Something like /etc/hosts is a path, not a command: let it through to the agent.
  if (name.includes('/') || name.includes('\\')) return false;
  agent._out(`Unknown command /${name}. Type /help to see what is available.`);
  return true;
}
