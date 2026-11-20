# How ORBIX is built

ORBIX is a Windows app: a local Node.js server and its interface, shown in an Electron window. The server runs one agent loop per open conversation and listens only on `127.0.0.1`.

```
Browser (web/)  ◀──────▶  AppServer (src/server.mjs)  ──────▶  AgentProc per session (src/engine/proc.mjs)
 ES modules, CSS            HTTP JSON API + SSE                   model clients, tools, MCP, hooks
                                                                    │
                                                                    └─ Backend (src/backend.mjs): WSL or Windows
```

## Start-up and shutdown

1. The app (`electron/main.mjs`) sets the data folder (`%LOCALAPPDATA%\ORBIX` when installed) and starts the server in its own process through `src/app.mjs`.
2. The server checks `instance.json` in the data folder and reuses a healthy existing server when possible.
3. A new server creates a random token and binds to port 47821 (or another available local port). The window opens a one-time URL with the token; the server exchanges it for an `HttpOnly`, `SameSite=Strict` cookie, then redirects to `/`.
4. On first run the server detects where commands run: the first WSL distribution that starts, otherwise Windows.
5. Closing the window, or Quit ORBIX in Settings, saves, stops every session and the server, and removes the lock file.
6. Updates (`electron/updater.mjs`, installed app only): electron-updater reads the newest GitHub release's `latest.yml` 15 seconds after start and every 4 hours, downloads the installer into `%LOCALAPPDATA%\orbix-agent-updater` and checks its SHA-512. The page sees the status through the preload bridge (`orbixDesktop.updates`). The installer runs silently (`--updated /S`) as the last step of quitting, after the server has stopped, and with `--force-run` when the update was started from Restart.

## The server (`src/server.mjs`)

- **Static files:** `web/` and `assets/`, with a strict Content Security Policy (no inline scripts or styles, no remote loads).
- **Access control:** every request needs the token cookie, except `/api/ping` and the OpenRouter sign-in callback. It also checks the `Host` header (DNS rebinding), `Origin` / `Sec-Fetch-Site` (other local pages), and requires an `x-orbix: 1` header on writes.
- **Events:** one Server-Sent Events stream, `GET /api/events`. It carries `{p, e}` (an event from session `p`) and `{g}` (global: `hello`, `procs`). High-frequency updates are coalesced every 40 ms.
- **API groups** (all JSON):

| Group | Routes | Used for |
|---|---|---|
| App | `/api/state`, `/api/env`, `/api/backend`, `/api/prefs`, `/api/diagnostics`, `/api/quit` | settings, where commands run, health checks |
| Projects | `/api/workspaces`, `/api/workspaces/remove` | the project list |
| Conversations | `/api/sessions`, `/api/sessions/delete` | saved conversations (only ORBIX's own files can be deleted) |
| Sessions | `/api/proc/start`, `/api/proc/stop`, `/api/procs`, `/api/proc/ui`, `/api/rpc`, `/api/reply` | open, drive and close agent sessions |
| AI providers | `/api/engine*` | keys, OpenRouter sign-in, models, approvals, web search |
| Tools | `/api/mcp*`, `/api/hooks*` | MCP servers and hooks |
| Files and git | `/api/fs/*`, `/api/git/*` | file browser, viewer, @-mentions, the Changes panel |

## An agent session (`src/engine/proc.mjs`)

Each open conversation is one `AgentProc`. Its code is split by job and joined into one class by `mixin.mjs` (a method defined twice is an error):

| File | Job |
|---|---|
| `proc.mjs` | lifecycle, requests and the turn loop: streaming, retries, compaction, undo, branching, goals, subagents |
| `proc-models.mjs` | the model and its facts (context window, thinking levels, prices), the thinking level, fast and plan models, connections and sign-in renewal |
| `proc-tools.mjs` | running tool calls: approvals, trusted commands, hooks, paths outside the project, local network addresses |
| `proc-checks.mjs` | after a run that changed files: the project's check command and a review of the diff |
| `proc-usage.mjs` | tokens, cost and how full the context is |

The interface talks to an `AgentProc` in two ways:

- **Requests** (`POST /api/rpc` → `proc.request(cmd)`): prompt, abort, state and message retrieval, model selection, compaction, undo, regeneration, branching, shell commands, exports and session settings.
- **Events** (on the SSE stream): agent and turn lifecycle, message updates, tool execution, approvals and questions, compaction, retries, subagents and session information.

One turn combines the user's message, project rules (`context.mjs`: `AGENTS.md` / `CLAUDE.md`) and skills, then streams a model reply and runs approved tool calls until the model stops (at most 100 turns).

- **Approvals:** `write`, `edit` and `bash` ask first unless approvals are off. Reading and searching never ask.
- **Undo:** every edit records the previous file contents, so `/undo` and the Undo buttons can restore them.
- **Compaction** (`compact.mjs`): older messages are summarised when context fills. The full history stays on disk and on screen.
- **Subagents** (`subagent.mjs`): the `task` tool runs read-only helper agents side by side and returns their answers.
- **Slash commands** (`slash.mjs`, `commands.mjs`): built-in commands such as `/plan`, `/undo` and `/compact`, plus Markdown prompt files from the project.

### Models and thinking levels (`providers.mjs`, `catalog.mjs`)

A model's facts come from three sources, each overriding the one before: the models.dev catalog; what the provider's model list reports (the ChatGPT plan gives each model's context window, levels and default level); and the levels the provider's API actually accepted, learned from its answers and kept for a week in `cache/effort-levels.json`. The ChatGPT client asks for an unsupported level once per model when it lists models: the API refuses it before doing any work and names the accepted ones. If a turn's level is still refused, the turn runs again at the nearest accepted level. A session starts at the model's own default level; Off is offered only when the model can stop thinking. Model lists are cached for a minute and dropped when a provider changes, and each request has a 20-second limit.

### Tools

Built in: `read`, `write`, `edit`, `glob`, `grep`, `bash`, `todo`, `web_fetch` and `web_search` once a search service is set up. File search uses ripgrep when available, otherwise a `.gitignore`-aware walker (`search.mjs`). `web_fetch` refuses private and local network addresses unless approved.

### MCP (`src/engine/mcp.mjs`)

Servers come from `data/mcp.json` (yours) and a project's `.mcp.json`, in the common `{"mcpServers": {...}}` format, over stdio or HTTP. They start on the first message of a session, run where that session's commands run, and stop with the session. Project servers start only after you approve that exact config once.

### Hooks (`src/engine/hooks.mjs`)

Hooks run at `PreToolUse`, `PostToolUse`, `UserPromptSubmit` and `Stop`. Files: `data/hooks.json` (yours) and `<project>/.orbix/hooks.json` (needs a one-time OK). Exit code 2 blocks the action.

## Runs (`src/runs.mjs`, `src/runctl.mjs`)

A run takes one task from its description to reviewed changes. It is an agent session with a controller around it:

| Part | Job |
|---|---|
| `runs.mjs` (`RunStore`) | Persistence only. `data/runs/<id>/run.json` (state), `events.jsonl` (append-only log, numbered) and `artifacts/<kind>/r<n>.md` (every revision of the plan, tasks, walkthrough, test log and notes). Comments, and `reconcile()`, which marks runs that were working at the last shutdown as interrupted and lists the calls with no result. |
| `runctl.mjs` (`RunController`) | Starts the session in its own worktree, listens to its events and writes the log, moves the run between states, and owns the decisions: approve the plan with a scope, send feedback with the pending comments, apply (merge), keep, discard, stop, resume. Its routes are `/api/runs*` and `/api/run/*`. |
| `engine/artifact.mjs` | The `artifact` tool and the run section of the system prompt (planning phase, execution phase). |
| `engine/policy.mjs` | The execution policy shared by every agent: commands that are destructive or reach outside the machine ask every time. |

States: `planning` → `awaiting_plan` (or `question`) → `executing` → `review` → `applied` / `kept` / `discarded`, with
`stopped`, `failed` and `interrupted` on the side. While planning the session is in plan mode (read-only tools plus
`artifact`). Approving the plan records the scope (file edits, optionally commands, always inside the worktree) and
applies it to the session; it is applied again when the session is restarted, so a restart does not widen or lose it.
A session opened from its saved file is connected to its run again (`adopt`).

The interface (`web/js/runs.js`, `web/css/runs.css`) has three views in the `#runs` section: Runs, Review (one queue
of everything that waits for you) and the page of one run (timeline, documents, changes, feedback, decision bar). The
server sends `{g: 'run', run}` on every change.

## Where commands run (`src/backend.mjs`)

`Backend` runs every command, tool, MCP server, git call and hook either in WSL (`wsl.exe -d <distro> --cd <dir> -e …`) or natively on Windows. It also translates paths between Windows (`C:\…`) and Linux (`/mnt/c/…`).

## Data (all under `data/`, or `ORBIX_DATA`)

| Path | Contents |
|---|---|
| `config.json` | app settings: theme, layout, projects, where commands run |
| `engine.json` | AI providers, approvals, model roles, web search. API keys are encrypted with Windows DPAPI (`secrets.mjs`) |
| `sessions/<project>/*.jsonl` | saved conversations, append-only |
| `mcp.json`, `hooks.json` | your MCP servers and hooks |
| `cache/` | the model catalog from models.dev (refreshed at most once a day), and the thinking levels learned from providers |
| `logs/server.log` | capped server log; keys, commands and MCP arguments are never written to it |
| `instance.json` | the running server's local port and token |

## The interface (`web/`)

Plain ES modules, no framework or build step. All text goes through `createTextNode`; outside data is never inserted with `innerHTML`.

| Module | Role |
|---|---|
| `main.js` | start-up, layout, sidebar, keyboard shortcuts, routing events to views |
| `shell.js`, `controls.js` | the window chrome (menu row, toolbar with back/forward and breadcrumbs, the Overview card, the sidebar's preview card) and the message box's "+" and permission chip |
| `backdrop.js` | the scene themes' moving pictures and the fireworks when a task finishes |
| `updates.js` | update status in the sidebar and Settings → About |
| `store.js` | client state and the reducer that turns session events into UI state |
| `api.js` | HTTP calls and the SSE connection |
| `home.js` | Home: task box, next actions, recent conversations and projects |
| `session.js`, `tools.js`, `markdown.js`, `highlight.js`, `ansi.js` | conversation view and tool steps |
| `composer.js` | message box: attachments, history, `/` and `@` pop-ups |
| `panels.js` | side panel: Run, Review (a session on its own branch), Files, Changes (git), Plan (todos), Agents, Console |
| `settings.js`, `engine.js`, `models.js`, `mcp.js`, `toolset.js` | Settings |
| `brands.js` | provider logo marks, drawn inline |
| `ascii.js` | orbit, decoding headline, typed examples and empty-panel art |
| `dialogs.js`, `cleanup.js`, `diagnostics.js`, `help.js`, `notify.js` | dialogs and notifications |
| `dom.js` | DOM helpers, icons and logo |
| `workbench.js`, `timeline.js`, `quote.js` | find in a conversation, the outline of your messages, the wide column and focus mode; the navigator of dots on the conversation's left edge; and asking about selected text |
| `review.js` | sessions on their own branch: the sidebar board and the Review view (merge, keep or discard) |
| `run-inspector.js`, `run-summary.mjs` | the Run view of the side panel: the session's tool activity |
| `session-library.js`, `session-library.mjs` | saved conversations on Home: search, filter, sort and pins |
| `workspace.js`, `exporter.js` | task suggestions, and a conversation as Markdown |
| `theme-boot.js`, `desktop.js`, `interface.js` | the theme before first paint, the Windows title bar colours, tooltips |
| `word-diff.mjs`, `tool-title.mjs`, `coalesce.mjs` | helpers without DOM (word-level diff, tool step titles, batched redraws), so tests can import them |

## Tests

`npm test` runs `test/*.mjs` with Node's built-in test runner. Tests need no network or API keys and use a temporary data folder.

`npm run e2e` (`e2e/run.mjs`) drives the real interface in a headless Chromium window over the DevTools protocol, against ORBIX on a temporary data folder, a fixture repository and a deterministic model (`e2e/lib.mjs`: an OpenAI-compatible server that replays scripted steps). It covers a run from task to applied changes, a denied destructive command, a restart in the middle of a run and a merge conflict. `docs/parity.md` lists what each step proves.
