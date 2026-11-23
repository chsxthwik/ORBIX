# How ORBIX is built

ORBIX is a Windows desktop app with no server: one Electron process runs the engine (`AppServer` in `src/server.mjs`, used in-process) and shows the interface. The window loads the interface from `orbix://app/` (files read from the app itself) and calls the engine over Electron IPC. Nothing listens on a port. The engine runs one agent per open conversation (its own loop, or another agent CLI). The same engine runs without a window on Linux as ORBIX Cloud, where it is served over HTTP (`src/headless.mjs`).

```
Window (web/, at orbix://app/)  ◀── IPC: orbix:api, orbix:event ──▶  AppServer (in the app process)  ──▶  AgentProc / HarnessProc
 ES modules, CSS                    (electron/preload.cjs)              routes, events                      model clients or agent CLIs
                                                                                                             └─ Backend: WSL or Windows
```

## Start-up and shutdown

1. The app (`electron/main.mjs`) sets the data folder (`%LOCALAPPDATA%\ORBIX` when installed) and takes Windows' single-instance lock: a second start only brings the open window forward and never starts an engine.
2. `startDesktopEngine()` (`src/app.mjs`) creates the engine without listening anywhere. `protocol.handle('orbix')` serves the interface's files with the Content-Security-Policy; `ipcMain.handle('orbix:api')` runs one API route in-process (`AppServer.call`) and answers only the page at `orbix://app/`; engine events go to the window as `orbix:event` (`AppServer.listeners`).
3. `web/js/api.js` uses that IPC bridge when the page is at `orbix://app/`, and plain HTTP (`fetch`, `EventSource`) in a browser or on an ORBIX Cloud machine. Same routes, same JSON.
4. On first run the engine detects where commands run: the first WSL distribution that starts, otherwise Windows.
5. Closing the window, or Quit ORBIX in Settings, saves and stops every session.
6. Updates (`electron/updater.mjs`, installed app only): electron-updater reads the newest GitHub release's `latest.yml` 15 seconds after start and every 4 hours, downloads the installer into `%LOCALAPPDATA%\orbix-agent-updater` and checks its SHA-512. The page sees the status through the preload bridge (`orbixDesktop.updates`). The installer runs silently (`--updated /S`) as the last step of quitting, after every session has stopped, and with `--force-run` when the update was started from Restart.

## Renderer and performance checks

- `/api/state` includes the public provider status so the initial view needs only one bootstrap request. `/api/engine` is still used for settings changes.
- Streaming Markdown uses an append-only cursor in `web/js/markdown-stream.mjs`. The preview limits the work for long unfinished blocks; the final reply always uses the complete Markdown renderer.
- ASCII canvases are owned by their views. Only visible canvases request frames, and the owner disconnects observers when the view is removed. Reduced motion paints on demand.
- Run `node e2e/viewport.mjs` for narrow and wide Windows layout checks at 2× DPI.

## The engine's API (`src/server.mjs`)

One set of routes serves both ways in: in-process over IPC in the Windows app, and over HTTP on an ORBIX Cloud machine or in a browser (`node src/app.mjs`, used by the end-to-end tests). The HTTP-only rules below (token cookie, Host and Origin checks) apply to that HTTP server; OpenRouter's sign-in, which must return to a local address, opens a callback listener on 127.0.0.1 only for the sign-in (`callbackPort`).

- **Static files:** `web/` and `assets/`, with a strict Content Security Policy (no inline scripts or styles, no remote loads, no workers, and the interface itself cannot be framed). Frames depend on who asks: a web browser may frame only `localhost` and `127.0.0.1` (the Browser tab previews the web apps running on this computer); the Windows app's window (an `Electron/` user agent) may show any `http:` or `https:` page, because its Browser tab is a `<webview>` locked down in `electron/browser.mjs` (its own session, no preload or Node, sandboxed, no permissions beyond full screen and clipboard writes).
- **Access control:** every request needs the token cookie, except `/api/ping` and the OpenRouter sign-in callback. It also checks the `Host` header (DNS rebinding), `Origin` / `Sec-Fetch-Site` (other local pages), and requires an `x-orbix: 1` header on writes.
- **Events:** one Server-Sent Events stream, `GET /api/events`. It carries `{p, e}` (an event from session `p`) and `{g}` (global: `hello`, `procs`). High-frequency updates are coalesced every 40 ms.
- **API groups** (all JSON):

| Group | Routes | Used for |
|---|---|---|
| App | `/api/state`, `/api/env`, `/api/backend`, `/api/prefs`, `/api/diagnostics`, `/api/quit` | settings, where commands run, health checks |
| Desktop | `/api/open-url`, `/api/reveal-data` | open a checked link in the default browser; show the data folder in Explorer (takes no path) |
| Projects | `/api/workspaces`, `/api/workspaces/remove`, `/api/project/rules` | the project list; a project's instruction and rule files, for its page in Settings |
| Instructions and skills | `/api/instructions`, `/api/skills` | your instructions for every project (`data/AGENTS.md`); the skills the agent can use; `/api/skills/file`, `/api/skills/save`, `/api/skills/delete` for the Skills page |
| Conversations | `/api/sessions`, `/api/sessions/rename`, `/api/sessions/delete`, `/api/sessions/trash`, `/api/sessions/restore`, `/api/sessions/trash/empty` | saved conversations (only ORBIX's own files can be deleted; deleted ones stay in the trash for 30 days, Settings → Conversations → Recently deleted) |
| Branch sessions | `/api/branch`, `/api/branch/diff`, `/api/branch/merge`, `/api/branch/keep`, `/api/branch/discard` | a conversation on its own branch: what it changed, then merge, keep or discard (merge and discard need `confirm: true`) |
| Loops | `/api/automations`, `/api/automations/delete`, `/api/automations/run` | prompts on a schedule or once (`src/automations.mjs`) |
| Agents | `/api/agents` | agent CLIs found and your own ACP agents (`src/harness/registry.mjs`) |
| Machines and Teleport | `/api/machines`, `/api/machines/remove`, `/api/machines/check`, `/api/machines/open`, `/api/teleport`, `/api/teleport/files`, `/api/teleport/open` | ORBIX Cloud (`src/cloud.mjs`) |
| Terminal | `/api/pty/list`, `/api/pty/open`, `/api/pty/input`, `/api/pty/resize`, `/api/pty/interrupt`, `/api/pty/close` | real shells on a pseudo-terminal (a Python helper inside Linux/WSL; PowerShell in line mode for Windows folders), several per project; output as `{ g: "pty" }` events (`src/pty.mjs`) |
| Browser | `/api/devservers` | web apps running on this computer, for the side panel's Browser tab (`src/devservers.mjs`) |
| Sessions | `/api/proc/start`, `/api/proc/stop`, `/api/procs`, `/api/proc/ui`, `/api/rpc`, `/api/reply` | open, drive and close agent sessions |
| AI providers | `/api/engine*` | keys, OpenRouter sign-in, models, approvals, web search |
| Tools | `/api/mcp*`, `/api/hooks*` | MCP servers and hooks |
| Files and git | `/api/fs/*`, `/api/git/*` | file browser, viewer, @-mentions, the Changes panel (status, `numstat` for +/- per file, `patch` for the message's source, stage, discard, commit, `push`) |

## Other agents (`src/harness/`)

A conversation can run on another agent CLI instead of ORBIX's own loop. `HarnessProc` (`harness/proc.mjs`) speaks to the server and the UI exactly like `AgentProc` (the same requests, the same events), so the work row, steps, approvals, sidebar, search and export work unchanged. A driver per protocol turns the CLI's stream into ORBIX events:

| Driver | CLI | Protocol |
| --- | --- | --- |
| `claude.mjs` | Claude Code | `claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`; control requests `initialize`, `set_model`, `apply_flag_settings`, `interrupt`; `can_use_tool` answered from ORBIX approvals |
| `codex.mjs` | Codex | `codex app-server`: `thread/start` or `thread/resume`, `turn/start`, `turn/interrupt`; `item/*` notifications; command and file-change approval requests |
| `acp.mjs` | OpenCode, Gemini CLI, any ACP agent | JSON-RPC 2.0: `initialize`, `session/new` or `session/load`, `session/prompt`, `session/cancel`; `session/update`; `session/request_permission` |

`registry.mjs` finds the CLIs (`where.exe`, or `command -v` in WSL and on Linux), their versions and sign-in state, and lists each in the model picker as a provider named `agent-<name>`. `tools.mjs` maps each CLI's tool names to ORBIX's (`Bash` → `bash`, `commandExecution` → `bash`, ACP kind `edit` → `edit`). The saved conversation records the engine in its header and the agent's own session id (`{type: 'native'}`), so reopening resumes the native session.

## ORBIX Cloud (`src/headless.mjs`, `src/cloud.mjs`)

`headless.mjs` runs the same `AppServer` with no window on Linux or macOS (`Backend` is `native` there: commands run in `bash -lc`, process groups are killed as a whole, API keys are sealed with AES-256-GCM under `data/secret.key` instead of DPAPI). It listens on `ORBIX_LISTEN` (127.0.0.1:47821), answers to `ORBIX_HOSTS`, and accepts the token as the cookie or as `Authorization: Bearer`.

`cloud.mjs` holds Machines (other ORBIX servers, their tokens encrypted in `data/machines.json`) and Teleport: the project is packed with `tar` (without dependency and build folders) and streamed to `POST /api/teleport/files`, then `POST /api/teleport/open` unpacks it into `~/orbix-projects/<name>`, imports the conversation (`importSession`) and reopens it. Claude Code's own session file travels with it; for other agents the first new message carries what happened so far. The desktop window switches to a machine through the preload bridge (`orbixDesktop.machines`), which only the local ORBIX may call to leave home.

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
- **Compaction** (`compact.mjs`): older messages are summarised when context fills. Manual compaction keeps the six latest user-led turns intact and refuses to run during an approval or question. The full history stays on disk and on screen.
- **Context and cost** (`context-budget.mjs`, `context-popover.js`): the toolbar shows the model window, with warnings at 80% and 95%. The provider's last input and output totals are shown separately. Per-part counts allocate those totals using estimates of the actual request parts; amounts after a context change or compaction are estimates until another provider report. Session spend includes paid summary calls and uses reported charges when available, then model pricing. Agent CLIs do not expose the input needed for this breakdown or guarantee six-turn retention.
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

## Loops (`src/automations.mjs`)

A prompt that ORBIX sends by itself, in a project, as a new conversation: every 5 to 1440 minutes, every hour (at a minute), every day,
on weekdays or every week (at a time), or once at a date and time (it turns itself off after it runs). `data/automations.json` holds them. A timer checks every 30 seconds; each due
one starts through the server (`startAutomation`: open a session, send the prompt, name it), and moves to its next
time. Times missed while ORBIX was closed are skipped, not caught up, and a run still working is not started twice.
Approvals work as in any conversation: in Supervised a run waits in Review. The page is `web/js/automations.js`
(sidebar → Loops, in the `#runs` section).

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
| `shell.js`, `controls.js` | the window chrome, one 40px row (logo, menus, sidebar toggle, back/forward and search on the left; the breadcrumb in the middle; the context meter and panel toggles on the right; the caption buttons of the Windows app after it) and the message box's "+", model button, reasoning menu and permission chip (Full access is a neutral chip with a warning icon) |
| `context.js` | the toolbar's Context menu: where the project runs, MCP servers, skills and rule files, each in a submenu (`cascade()` in dialogs.js) |
| `backdrop.js` | the scene themes' moving pictures and the fireworks when a task finishes |
| `web/css/themes.css` | the editor palettes (Tokyo Night, Catppuccin Mocha and Latte, Rosé Pine and Dawn, Nord, Dracula, Gruvbox): surfaces, ink, status and syntax colours, and their Settings previews |
| `web/css/tokens.css` | loaded first: the type scale (12/13/14/16/20/28 px), weights (400; 500 for headings), the 4px spacing grid (`--sp-*`), row and bar heights, motion (120ms hovers, 180ms panels, ease-out) and the 760px reading column. Every later stylesheet asks for these (`test/design-tokens.test.mjs`, and `node tools/shots.mjs --audit` on the rendered page) |
| `web/css/sidebar.css`, `ui.css`, `transcript.css`, `composer.css`, `home.css`, `side-icons.js` | the stylesheets of the redesign: the 260px sidebar (resizable 220-360px, rows of 28px, a 2px bar on the current row) and the tokens-this-week line; project tiles, the Customize tabs, the week chart, provider tiles, the Connect dialog and the Changes panel; the transcript (pill messages, the one-row work summary, hairline tables, the timeline); the flat message box; Home and the empty conversation |
| `updates.js` | update status: the pill at the top right of the menu row, and Settings → About |
| `store.js` | client state and the reducer that turns session events into UI state |
| `api.js` | HTTP calls and the SSE connection |
| `home.js` | Home: the muted ORBIX mark, "Where should we pick up?", three suggestions from the project as rows, and the message box with the project and branch chips on top of it |
| `session.js`, `tools.js`, `markdown.js`, `highlight.js`, `ansi.js` | conversation view and tool steps |
| `composer.js` | message box: attachments, history, `/` and `@` pop-ups |
| `panels.js` | side panel (on Home and in conversations), as browser-like tabs of the surfaces you opened (prefs `panelTabs`) and a New tab page listing them all with their Ctrl+Alt shortcuts: Changes (git: changed files with +/- counts, an inline diff on click, and Commit & push with Ctrl+Enter, which writes the title and body with a side question and links the pull request; `pr-link.mjs` builds the GitHub compare or GitLab merge request address), Files, Terminal (terminal.js), Browser (Default, Incognito, Device), Tasks (todos and helper agents), Inspect, Side question, Review (a session on its own branch only) |
| `terminal.js` | the side panel's Terminal tab: xterm.js (`web/vendor/xterm`, loaded on first use) over `/api/pty/*`; several terminals per project, split; xterm's style tags are mirrored into a constructed stylesheet so the CSP needs no inline styles |
| `project.js` | the project popover: environment, Open in (`/api/project/open`), project scripts (run in the Terminal), Initialize Git (`/api/git/init`) |
| `settings.js`, `engine.js`, `models.js`, `mcp.js`, `toolset.js` | Settings (the whole window under the menu row; `settingsSearchItems` feeds Ctrl+K) |
| `settings-controls.js`, `prefs-extra.js` | shared Settings controls (`group`, `pick`, `seg`); the extra preferences (fonts, wrap, diff colours, confirmations, keep awake, agent options), applied in `applyExtraPrefs` |
| `analytics.js` | Settings → Analytics: tokens per day by kind, agent time, models and the weekday × hour grid, from `GET /api/analytics` (`src/analytics.mjs`, cached per session file) |
| `keys.mjs` | the shortcuts you can change: actions, default keys, `comboOf(event)`, your changes in `prefs.keys` |
| `browser.js` | where links open, the Browser tab's addresses and history; `electron/browser.mjs` is the Windows app's browser session |
| `brands.js` | provider logo marks, drawn inline |
| `connect.js` | Connect (Ctrl+Shift+M): Providers and Agents in one dialog, reusing the Settings pages; `brandTile()` in `brands.js` draws each provider as an app icon |
| `ascii.js` | the COM-X mark in About (characters on a canvas) and the working loader (the ORBIX mark swapping O ↔ X); one still frame under reduced motion or screen reader mode |
| `dialogs.js`, `cleanup.js`, `diagnostics.js`, `help.js`, `notify.js` | dialogs and notifications |
| `dom.js` | DOM helpers, icons and logo |
| `workbench.js`, `timeline.js`, `quote.js` | find in a conversation; the timeline (one dot per message of yours, 24px left of the column, the first 60 characters on hover, the current turn filled, hidden under 1100px; `timeline-text.mjs`); the wide column and focus mode; jumping to a message and Alt+↑/↓ between yours; and asking about selected text |
| `review.js` | sessions on their own branch: the sidebar board and the Review view (merge, keep or discard) |
| `run-inspector.js`, `run-summary.mjs` | the side panel's Inspect tab: the session's tool activity |
| `customize.js`, `customize-tabs.js`, `catalog.mjs` | the Customize page (Plugins, Skills, Loops and Review as tabs, `customize-tabs.js`) and its Plugins tab (Marketplace and Installed); the marketplace's MCP servers and the exact config each one saves |
| `skills.js` | the Skills page: the project's skills and yours; add, edit, delete (to the trash) |
| `hub-nav.js`, `hub-projects.js` | the page links shared by the sidebar, View menu and command palette; the projects list those pages use |
| `automations.js`, `schedule.mjs` | the Loops page; Create with Prompt, which turns one sentence into a schedule and a task with plain rules (no model) |
| `ratings.js` | your 👍 and 👎 per model, counted on this PC only (`localStorage`), listed in Settings → Models → Your ratings |
| `workspace.js`, `exporter.js` | task suggestions, and a conversation as Markdown |
| `theme-boot.js`, `desktop.js`, `interface.js` | the theme before first paint, the Windows title bar colours, tooltips |
| `word-diff.mjs`, `tool-title.mjs`, `coalesce.mjs` | helpers without DOM (word-level diff, tool step titles, batched redraws), so tests can import them |

## Tests

`npm test` runs `test/*.mjs` with Node's built-in test runner. Tests need no network or API keys and use a temporary data folder.

`npm run e2e` (`e2e/run.mjs`) drives the real interface in a headless Chromium window over the DevTools protocol, against ORBIX on a temporary data folder, a fixture repository and a deterministic model (`e2e/lib.mjs`: an OpenAI-compatible server that replays scripted steps). It covers a run from task to applied changes, a denied destructive command, a restart in the middle of a run and a merge conflict.
