<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/img/logo-light.svg">
  <img alt="ORBIX" src="docs/img/logo-light.svg" width="279" height="60">
</picture>

### The unified open-source ADE.

Every coding agent. Every model. One environment that asks before it acts.

[![Release](https://img.shields.io/github/v/release/chsxthwik/ORBIX?style=flat-square&label=release&color=4D6B00&labelColor=151514)](https://github.com/chsxthwik/ORBIX/releases/latest)
[![Tests](https://img.shields.io/github/actions/workflow/status/chsxthwik/ORBIX/test.yml?branch=main&style=flat-square&label=tests&labelColor=151514)](https://github.com/chsxthwik/ORBIX/actions/workflows/test.yml)
[![Windows 10 and 11](https://img.shields.io/badge/Windows-10%20%7C%2011-4D6B00?style=flat-square&labelColor=151514)](#install)
[![License: MIT](https://img.shields.io/badge/license-MIT-4D6B00?style=flat-square&labelColor=151514)](LICENSE)

**[Download for Windows](https://github.com/chsxthwik/ORBIX/releases/latest)** · [Website](https://orbix-agent.vercel.app) · [Changelog](CHANGELOG.md) · [Architecture](docs/ARCHITECTURE.md) · [Security](SECURITY.md)

</div>

<br>

<img src="docs/img/shots/done.png" alt="ORBIX: the sidebar of projects and conversations, a finished reply whose steps fold into one Worked for line, and the changed file with Review and Undo all.">

<sub>Every screenshot is the real app on a sample project; every tool in it really ran.</sub>

## ORBIX 4

ORBIX is an agentic development environment (ADE): one place where AI agents plan, write, run and review code, and where a human decides what ships. Run the ORBIX agent on any of 17 providers or a model on your own machine, or drive Claude Code, Codex, OpenCode and any ACP agent on the plans you already pay for. One permission model, one review queue and one undo cover them all.

- **Human in command.** Reading is free. Edits and commands follow the permission chip: **Supervised**, **Auto edits**, **Guarded** or **Full access**. Destructive commands (recursive delete, push, publish, history rewrite) ask every time, at every level.
- **Nothing is final until you say so.** Every file edit can be undone, one at a time or a whole reply at once. Runs work in their own git worktree and reach your branch only when you apply them.
- **Every model, every agent.** 17 providers and any OpenAI-compatible server, including a ChatGPT plan without an API key, or a model on your own PC. External agents keep their own login and plan; ORBIX shows their steps and answers their permission requests with the same approval cards.
- **Your PC or your machine.** **ORBIX Cloud** is the same engine on a Linux machine you own. Move a conversation there with its project, git history and uncommitted changes, and it keeps working with your PC off.
- **Open by design.** MIT licensed, no account, no telemetry, no hosted middleman. Your keys go only to their own provider.

## Install

Download `ORBIX-Setup` from the [latest release](https://github.com/chsxthwik/ORBIX/releases/latest) and run it. It installs for your Windows account, adds Start menu and desktop shortcuts, and needs no administrator rights and no Node.js. The installer is not code-signed yet, so SmartScreen asks the first time: choose **More info**, then **Run anyway**.

1. Press <kbd>Ctrl</kbd>+<kbd>,</kbd> and open **Providers**. Sign in (ChatGPT, xAI, OpenCode, OpenRouter), paste an API key and press **Check & save**, or connect a local model.
2. Choose a project folder, describe a task and press <kbd>Enter</kbd>.

ORBIX updates itself from GitHub releases: it downloads in the background and installs when you close it, or at once with **Restart to update** at the top right (Settings → About → Updates turns this off). Settings and conversations live in `%LOCALAPPDATA%\ORBIX` and stay through every update. There is no account and no subscription; you pay your provider directly, or nothing with a local model.

## Agents

Settings → **Agents** lists the agent CLIs ORBIX found on this computer, with their version and whether they are signed in. Each appears in the model picker as a provider named after the agent.

| Agent | How ORBIX runs it | Approvals |
| --- | --- | --- |
| Claude Code | `claude -p` with stream-json and the control protocol | its `can_use_tool` questions become ORBIX approval cards |
| Codex | `codex app-server` (JSON-RPC), sandbox on | command and file-change approvals ask in ORBIX |
| OpenCode | `opencode acp` (Agent Client Protocol) | `session/request_permission` asks in ORBIX |
| Gemini CLI and any ACP agent | the command you give it in ACP mode | as above |

Supervised, Auto edits, Guarded and Full access apply to every agent; a destructive command asks in every mode. The agent keeps its own history, and reopening the conversation resumes its native session.

## ORBIX Cloud

```sh
curl -fsSL https://orbix-agent.vercel.app/install.sh | bash   # Ubuntu or Debian, as your user
```

It installs ORBIX into `~/.orbix-app`, runs `node src/headless.mjs` as a systemd user service on `127.0.0.1:47821`, and prints the address and token. Reach it with Tailscale (`tailscale serve`), an SSH tunnel or HTTPS in front of it, then add it in **Settings → Machines**. From a conversation's menu, **Move to a machine** sends the project (a gzip tarball without `node_modules`, build and cache folders) and the conversation, and reopens it there. Run the server by hand with `ORBIX_LISTEN=127.0.0.1:47821 node src/headless.mjs` (also `ORBIX_DATA`, `ORBIX_HOSTS`, `ORBIX_TOKEN`).

## How you work in it

**Conversations** are for questions and everyday changes. The agent reads freely and asks before edits and commands (<kbd>1</kbd> allow once, <kbd>2</kbd> for the conversation, <kbd>Esc</kbd> deny). When a reply ends, its steps fold into one line ("Worked for 14s · Read 2 files · Ran 1 command") above the answer, with a card of the changed files and **Review** and **Undo all**.

**Runs** (<kbd>Ctrl</kbd>+<kbd>2</kbd>) take one larger task from description to reviewed changes:

1. **Plan.** The agent reads the code and writes an implementation plan, changing nothing. Comment on any passage and it writes a new revision.
2. **Approve a scope.** You allow file edits, or edits and commands, inside the run's own worktree and branch.
3. **Review.** Every step in the timeline opens what it produced: the diff, the test log, the walkthrough.
4. **Apply or discard.** Apply merges into the branch the run started from and keeps your own uncommitted work; a conflict changes nothing on either side.

**Review** (<kbd>Ctrl</kbd>+<kbd>3</kbd>) is one queue across projects for everything that waits for you: approvals, plans, finished changes, interrupted runs. If ORBIX closes mid-run, the run says what was in flight and continues only when you say so.

<table>
<tr>
<td width="50%"><img src="docs/img/shots/run.png" alt="A run waiting for review: the timeline of every step, the walkthrough, and Apply changes and Discard"></td>
<td width="50%"><img src="docs/img/shots/review-queue.png" alt="The Review queue with an approval from a conversation and a finished run"></td>
</tr>
<tr>
<td><b>Runs.</b> Planned, approved and done in their own worktree.</td>
<td><b>Review.</b> Every decision that waits for you, buttons in place.</td>
</tr>
<tr>
<td><img src="docs/img/shots/run-changes.png" alt="A run's Changes tab with the changed files and the diff of one file"></td>
<td><img src="docs/img/shots/home.png" alt="Home: the ORBIX mark and a greeting, three suggestions for the project, and the message box with the project and branch strip"></td>
</tr>
<tr>
<td><b>Changes.</b> What a run changed, file by file.</td>
<td><b>Home.</b> A greeting, suggestions for the project, and the message box.</td>
</tr>
<tr>
<td><img src="docs/img/shots/automations.png" alt="The Loops page: a weekday test report at 09:00 and a weekly dependency check that is off, each with Run now, Edit and Delete"></td>
<td><img src="docs/img/shots/customizations.png" alt="The Plugins page: a featured Playwright card and MCP servers by category, each with an add button"></td>
</tr>
<tr>
<td><b>Loops.</b> Prompts that run on a schedule or once, each as a new conversation.</td>
<td><b>Plugins.</b> MCP servers in one click, and what is installed.</td>
</tr>
<tr>
<td><img src="docs/img/shots/settings.png" alt="Settings, on the Providers page"></td>
<td></td>
</tr>
<tr>
<td><b>Settings.</b> One page: General, Appearance, Shortcuts, Providers and more.</td>
<td></td>
</tr>
</table>

## The window

| Part | What it does |
| --- | --- |
| **Sidebar** | New conversation, Search (<kbd>Ctrl</kbd>+<kbd>K</kbd>), Plugins, Skills, Loops, Runs and Review; what is running; pinned conversations; your projects. A conversation shows a state only when it has one: working, needs you, unread. |
| **Side panel** | <kbd>Ctrl</kbd>+<kbd>J</kbd>. Tabs like a browser's, with a **New tab** page that lists every surface and its shortcut: Review, Browser, Terminal, Files, Changes, Tasks, Inspect, Device and Side question. **Changes** stages, unstages, discards and commits. **Browser** is a real browser with its own session in the Windows app. **Side question** answers about the conversation while the agent keeps working. |
| **Terminal** | <kbd>Ctrl</kbd>+<kbd>`</kbd>: real shells on a pseudo-terminal, several per project and two side by side. Your login shell in WSL and Linux (prompt, colours, vim, htop); PowerShell for a Windows folder. |
| **Project menu** | Where the project runs (Windows, or the WSL distribution and user), **Open in** File Explorer, VS Code, Cursor, Windsurf, Zed or Windows Terminal, **project scripts** that run in the Terminal, and **Initialize Git**. |
| **Loops** | Prompts that start by themselves every few minutes, hourly, daily, on weekdays, weekly or once, each as a new conversation. **Create with Prompt** turns one sentence ("every weekday at 9am, run the tests") into the schedule and the task. In Supervised a loop waits for your OK in Review. |
| **Plugins and Skills** | A marketplace of MCP servers added in one click (Playwright, Chrome DevTools, Context7, GitHub, Supabase, Figma, Notion, Stripe and more), and every installed server, skill and project rule. Skills are `SKILL.md` files you add, edit or delete from the page. |
| **Message box** | <kbd>+</kbd> adds images and files, a command (<kbd>/</kbd>), context (<kbd>@</kbd>) or a shell command (<kbd>!</kbd>); the model and its reasoning level; Plan; the permission chip. |
| **Conversation** | A centred column; a turn's steps fold into one "Worked for…" line. Markdown with code and tables; copy, 👍, 👎 and retry under each reply. Find (<kbd>Ctrl</kbd>+<kbd>F</kbd>), jump between your messages (<kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd>), focus mode (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>). |
| **Settings** | <kbd>Ctrl</kbd>+<kbd>,</kbd>, searchable. Preferences, Appearance, Notifications, Shortcuts; Providers, Models, Agents, Tools & MCP, Instructions, Checks; Projects, Worktrees, Conversations, Machines, Browser; About. |

## Models

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/providers-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/img/providers-light.png">
  <img src="docs/img/providers-light.png" alt="Anthropic, OpenAI (ChatGPT plan or API key), Google Gemini, xAI, Groq, Mistral, DeepSeek, OpenCode (Zen or Go plan), OpenRouter, Together AI, Fireworks AI, Cerebras, Moonshot (Kimi), Z.ai (GLM), Qwen, Ollama, LM Studio, and a custom server for any OpenAI-compatible endpoint" width="100%">
</picture>

**ChatGPT** uses the models on your ChatGPT Plus or Pro plan: sign in, no API key. It goes through the same sign-in and endpoint as the OpenAI Codex CLI, which is unofficial and can change. **xAI**, **OpenCode** and **OpenRouter** also offer a sign-in; sign-ins renew themselves.

Model lists come live from each provider and offer chat models only. Context sizes, prices and thinking support come from the [models.dev](https://models.dev) catalog (refreshed at most once a day) unless the provider reports them itself, and each model offers only the thinking levels its API accepts. Separate fast and plan models can be set in Settings → Models. The custom server works with vLLM, llama.cpp, a company gateway or anything that speaks the OpenAI chat API.

## Security and privacy

Approvals are a checkpoint, not a sandbox: the agent runs with your Windows user's permissions, so read what you approve.

| Action | Supervised (default) | Auto edits | Guarded | Full access |
| --- | --- | --- | --- | --- |
| Reading and searching | Runs | Runs | Runs | Runs |
| `write`, `edit` | Asks | Runs (undoable) | Runs (undoable) | Runs (undoable) |
| `bash` | Asks, unless the command is trusted | Asks, unless trusted | Read-only commands run (`ls`, `cat`, `grep`, `find`, `git status`/`diff`/`log`, pipes of them); others ask, unless trusted | Runs |
| Destructive commands (recursive delete, push, publish, history rewrite, system changes) | Asks | Asks | Asks | **Asks** |
| Files outside the project folder | Asks | Asks | Asks | Runs |
| MCP tools | Ask, unless the server marks them read-only | Ask, unless read-only | Ask, unless read-only | Run |
| `web_fetch` | Runs; denied sites never, and with an allowed list other sites ask | Same | Same | Same |
| Project MCP servers and hooks | Do not start until you approve them | Same | Same | Same |

- **No open port:** the Windows app runs the engine in its own process and talks to it over Electron IPC; the interface is loaded from the app's own files with a strict Content Security Policy. Only ORBIX Cloud, on a machine you own, serves it over HTTP, behind a token.
- **API keys:** encrypted for your Windows account with DPAPI, sent only to their own provider, never written to the log.
- **What reaches your provider:** your messages, tool definitions, project rules and tool results, including the contents of files the agent reads.
- **Other network use:** the models.dev model catalog, update checks on GitHub (unless turned off), the sign-ins you use, `web_fetch` / `web_search` when the agent calls them, the MCP servers you add, and the pages you open in the built-in browser. **No telemetry.**
- **On disk:** conversations are plain text in `%LOCALAPPDATA%\ORBIX` (or `data/` in a clone) and can contain anything that appeared in a chat; treat that folder as sensitive. A deleted conversation stays in its `trash` folder for 30 days (Settings → Conversations → Recently deleted), then it is removed for good.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Extending ORBIX

| Feature | Where it lives |
| --- | --- |
| **Project rules** | `AGENTS.md`, `CLAUDE.md` or `.omp/AGENTS.md` in the project. `/init` writes a first version. |
| **Rule files** | `.agents/rules/*.md` in the project. Front matter `trigger:` `always_on` (default, in every prompt), `model_decision` (with a `description`: the agent reads it when it applies), `glob` (with `globs`: for matching files) or `manual` (only when you @mention it). |
| **Your instructions** | Settings → Instructions: followed in every project. |
| **MCP servers** | Plugins (Settings → Tools & MCP), or `.mcp.json` in the project. Stdio and HTTP. |
| **Skills** | A folder with a `SKILL.md` in `.agents/skills`, `.claude/skills` or `.omp/skills`. |
| **Slash commands** | Markdown files in `.omp/commands` or `.claude/commands`. `$ARGUMENTS` and `$1` to `$9` are filled in. |
| **Hooks** | `hooks.json` in the data folder, or `.orbix/hooks.json` in a project. Events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`. Exit code 2 blocks the step and tells the model why. |
| **Web search** | Settings → Tools & MCP: Brave Search, Tavily or your own SearXNG. |
| **Network access rules** | Settings → Preferences: sites `web_fetch` may read without asking, and sites it may never read (also after a redirect). With an allowed list, every other site asks first. |

<details>
<summary><b>Keyboard shortcuts</b></summary>
<br>

The defaults. Settings → Shortcuts changes any of them: <kbd>+</kbd> records new keys, the bin removes them.

| Keys | Action |
| --- | --- |
| <kbd>Ctrl</kbd>+<kbd>K</kbd> / <kbd>Ctrl</kbd>+<kbd>P</kbd> | Search everything (settings too) / find a file |
| <kbd>Ctrl</kbd>+<kbd>N</kbd> | New conversation |
| <kbd>Ctrl</kbd>+<kbd>2</kbd> / <kbd>Ctrl</kbd>+<kbd>3</kbd> / <kbd>Ctrl</kbd>+<kbd>U</kbd> | Runs / Review / Loops |
| <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>Alt</kbd>+<kbd>→</kbd> (or <kbd>Ctrl</kbd>+<kbd>[</kbd> / <kbd>Ctrl</kbd>+<kbd>]</kbd>) | Back / forward |
| <kbd>Ctrl</kbd>+<kbd>B</kbd> / <kbd>Ctrl</kbd>+<kbd>J</kbd> | Sidebar / side panel |
| <kbd>Ctrl</kbd>+<kbd>,</kbd> / <kbd>Ctrl</kbd>+<kbd>/</kbd> | Settings / keyboard shortcuts |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>,</kbd> | Next / previous side panel tab |
| <kbd>Ctrl</kbd>+<kbd>L</kbd> | Focus the message box |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd> | Find in the conversation / jump to one of your messages |
| <kbd>Alt</kbd>+<kbd>1</kbd> to <kbd>9</kbd>, <kbd>Ctrl</kbd>+<kbd>Tab</kbd> | Switch between open conversations |
| <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>Alt</kbd>+<kbd>↓</kbd> | Previous / next message of yours |
| <kbd>Enter</kbd> / <kbd>Alt</kbd>+<kbd>Enter</kbd> | While the agent works: steer / queue (Settings → Preferences can swap them) |
| <kbd>1</kbd> <kbd>2</kbd> <kbd>Esc</kbd> | Allow once / allow for the conversation / deny; <kbd>Esc</kbd> also stops the agent |

</details>

<details>
<summary><b>Slash commands</b></summary>
<br>

| Command | Action |
| --- | --- |
| `/plan` | Toggle plan mode: the agent only reads and plans |
| `/undo` | Undo the file changes from the last reply |
| `/retry` | Answer the last message again |
| `/compact [focus]` | Summarize older messages to free up context |
| `/model [fast\|plan] [provider/model]` | Show or switch a model |
| `/cost` | Tokens and cost of this conversation |
| `/init [focus]` | Write an `AGENTS.md` with the project's rules |
| `/review [focus]` | Review uncommitted changes for bugs and risks |
| `/commit [notes]` | Write a message for the staged changes and commit |
| `/branch` | Continue in a new conversation from here; files are not reverted |
| `/btw <question>` | Ask about the conversation in the side panel while the agent keeps working; nothing is added to it |
| `/goal <text>` | Keep working on a goal by itself, for up to 6 rounds |
| `/memory`, `/hooks`, `/mcp`, `/skills`, `/help` | The project memory file, hooks, MCP servers, skills and help |

</details>

## Themes

Settings → Appearance: System, Dark, Light, Midnight and Frost, plus five scene themes with a moving picture behind the conversation (ORBIX, Synthwave, Koi pond, Aurora, Halftone dusk). Scenes speed up while the agent works and send up fireworks when a task finishes; **Animate scenes** or the Windows reduce-motion setting keeps everything still.

<table>
<tr>
<td width="50%"><img src="docs/img/shots/theme-light.png" alt="ORBIX in the Light theme"></td>
<td width="50%"><img src="docs/img/shots/theme-orbix.png" alt="The ORBIX scene theme: a planet with a Plasma ring behind the conversation"></td>
</tr>
<tr>
<td><b>Light</b></td>
<td><b>ORBIX</b> scene</td>
</tr>
</table>

## Architecture

```mermaid
flowchart LR
  subgraph PC["Your Windows PC"]
    UI["Interface<br/>web/ at orbix://app/"] <-->|"Electron IPC"| S["Engine<br/>src/server.mjs, in the app process"]
    W["Electron window<br/>electron/"] --- UI
    S <--> A["Agent loop<br/>src/engine/, one per conversation"]
    S <--> R["Runs<br/>src/runs.mjs, worktrees and event log"]
    A -->|"tool calls, after your approval"| T["Tools, MCP, hooks<br/>in WSL or Windows"]
    S <--> D[("Data folder<br/>conversations, settings,<br/>DPAPI-encrypted keys")]
  end
  A <-->|"messages, tools, results"| M["Model provider<br/>cloud or local"]
```

ORBIX is an Electron app: the engine runs in the app's process and the interface, in plain ES modules, talks to it over IPC (no server, no port). The same engine runs on Linux as ORBIX Cloud. There is no framework and no build step; the only npm package the app ships is electron-updater. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers start-up, the API, the agent loop, tools, runs and storage.

## Development

Node.js 22 or newer.

```bash
npm install        # Electron and the installer builder
npm start          # run the app from source (data stays in ./data)
npm test           # about 890 tests: no network, no API keys
npm run e2e        # a run and a conversation driven through the real interface (needs Edge, Chrome or Brave)
node e2e/cloud.mjs # ORBIX Cloud: two headless servers, a conversation moved between them (Linux or WSL)
npm run dist       # build the installer into dist/
```

```text
electron/   the Windows app: window, title bar, updates
src/        the engine: its API (IPC in the app, HTTP for ORBIX Cloud), events, runs, agents, WSL and Windows backend
src/engine/ the agent: loop, model clients, tools, MCP, hooks, policy, conversations
web/        the interface: plain ES modules and CSS
test/       regression tests on Node's built-in runner
e2e/        end-to-end tests in headless Chromium against a scripted model
tools/      shots.mjs: the README and website screenshots, taken from a real ORBIX
site/       the website
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[MIT](LICENSE). Third-party notices are in [NOTICE.md](NOTICE.md). Provider logos are trademarks of their owners and only identify each provider.

<div align="center"><sub>Created by QUANTUM · Developed by COM-X Innovations, Inc.</sub></div>
