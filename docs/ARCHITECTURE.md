# How ORBIX is built

ORBIX is three pieces on one Windows PC: a small native window, a local Node.js server, and a web interface the window shows. The server runs one agent loop per open conversation. Nothing listens outside `127.0.0.1`.

```
 ORBIX.exe (host/Program.cs)          node src/main.mjs --serve            web/ (index.html, js/, css/)
 WinForms + WebView2 window  ──────▶  AppServer (src/server.mjs)  ◀──────  shown inside the window
   starts the server, reads              HTTP JSON API + one SSE stream       ES modules, no framework
   ORBIX-URL from its stdout             │
                                         ├─ AgentProc per open session (src/engine/proc.mjs)
                                         │    ├─ model clients: anthropic.mjs, openai.mjs (providers.mjs)
                                         │    ├─ tools: tools.mjs, search.mjs, webfetch.mjs, websearch.mjs, subagent.mjs
                                         │    └─ MCP servers (mcp.mjs), hooks (hooks.mjs)
                                         └─ Backend (src/backend.mjs): runs commands in WSL or on Windows
```

## Start-up and shutdown

1. `bin/ORBIX.exe` (built from `host/Program.cs` by `tools/build-host.ps1`) starts `node src/main.mjs --serve --watch-stdin`.
2. `main.mjs` checks `data/instance.json`. If a server is already running, it hands over that server's address and exits (one instance).
3. Otherwise it creates a random token, starts `AppServer` on port 47821 (or a free one) and prints two lines the host reads: `ORBIX-URL http://127.0.0.1:<port>/?t=<token>` and `ORBIX-DATA <data folder>`.
4. The window opens that URL. The server swaps the token for an `HttpOnly`, `SameSite=Strict` cookie and redirects to `/`.
5. On first run the server picks where commands run (`Store.autodetect`): the first WSL distribution that starts, otherwise Windows.
6. The server exits on its own when the window is gone and no agent is working (`main.mjs`, idle check every 5 s). `--no-window` turns that off for development.

## The server (`src/server.mjs`)

- **Static files:** `web/` and `assets/`, with a strict Content Security Policy (no inline scripts or styles, no remote loads).
- **Access control:** every request needs the token cookie, except `/api/ping` and the OpenRouter sign-in callback. It also checks the `Host` header (DNS rebinding) and `Origin` / `Sec-Fetch-Site` (other local pages), and requires an `x-orbix: 1` header on writes.
- **Events:** one Server-Sent Events stream, `GET /api/events`. It carries `{p, e}` (an event from session `p`) and `{g}` (global: `hello`, `procs`). High-frequency updates are coalesced every 40 ms.
- **API groups** (all JSON):

| Group | Routes | Used for |
|---|---|---|
| App | `/api/state`, `/api/env`, `/api/backend`, `/api/prefs`, `/api/diagnostics`, `/api/quit` | settings, where commands run, health checks |
| Projects | `/api/workspaces`, `/api/workspaces/remove` | the project list |
| Conversations | `/api/sessions`, `/api/sessions/delete` | saved conversations (only ORBIX's own files can be deleted) |
| Sessions | `/api/proc/start`, `/api/proc/stop`, `/api/procs`, `/api/proc/ui`, `/api/rpc`, `/api/reply` | open, drive and close agent sessions |
| AI providers | `/api/engine*` | keys, OpenRouter sign-in, models, approvals, web search |
| Tools | `/api/mcp*`, `/api/hooks*` | MCP servers and hooks (see `mcpRoutes` in `engine/mcp.mjs`) |
| Files and git | `/api/fs/*`, `/api/git/*` | file browser, viewer, @-mentions, the Changes panel |

## An agent session (`src/engine/proc.mjs`)

Each open conversation is one `AgentProc`. The interface talks to it in two ways:

- **Requests** (`POST /api/rpc` → `proc.request(cmd)`): `prompt`, `abort`, `get_state`, `get_messages`, `get_available_models`, `set_model`, `set_thinking_level`, `compact`, `undo`, `regenerate`, `edit_message`, `branch`, `bash`, `abort_bash`, `export_html`, `set_session_name`, `get_session_stats`, `get_available_commands`, `get_subagents`.
- **Events** (on the SSE stream): `agent_start` / `agent_end`, `turn_start` / `turn_end`, `message_start` / `message_update` / `message_end`, `tool_execution_start` / `_update` / `_end`, `extension_ui_request` (approvals and questions), compaction, retry, subagent and session-info events.

One turn: the user's message → the system prompt (`prompt.mjs`) plus project rules (`context.mjs`: `AGENTS.md` / `CLAUDE.md`) and skills (`skills.mjs`) → the model client streams a reply (`anthropic.mjs` or `openai.mjs`, assembled by `assemble.mjs`) → each tool call is approved if needed, run, and its result is sent back → repeat until the model stops (at most 100 turns).

- **Approvals:** `write`, `edit` and `bash` ask first unless approvals are off. Reading and searching never ask.
- **Undo:** every edit records the previous file contents, so `/undo` and the Undo buttons can restore them.
- **Compaction** (`compact.mjs`): when the context fills up, older messages are summarised. The full history stays on disk and on screen.
- **Subagents** (`subagent.mjs`): the `task` tool runs read-only helper agents side by side and returns their answers.
- **Slash commands** (`slash.mjs`, `commands.mjs`): built-in commands such as `/plan`, `/undo` and `/compact`, plus Markdown prompt files from the project.

### Tools

Built in: `read`, `write`, `edit`, `glob`, `grep`, `bash`, `todo`, `task`, `web_fetch`, and `web_search` once a search service is set up. File search uses ripgrep when it is installed where the files are, otherwise a `.gitignore`-aware walker (`search.mjs`). `web_fetch` refuses private and local network addresses unless you approve.

### MCP (`src/engine/mcp.mjs`)

Servers come from `data/mcp.json` (yours) and a project's `.mcp.json`, in the common `{"mcpServers": {...}}` format, over stdio or HTTP. They start on the first message of a session, run where the session's commands run (WSL or Windows), and stop with the session. Their tools appear as `mcp__<server>__<tool>`. A project's servers start only after you approve that exact config once.

### Hooks (`src/engine/hooks.mjs`)

Your commands, run at `PreToolUse`, `PostToolUse`, `UserPromptSubmit` and `Stop`. Files: `data/hooks.json` (yours) and `<project>/.orbix/hooks.json` (needs a one-time OK). Exit code 2 blocks the action.

## Where commands run (`src/backend.mjs`)

`Backend` runs every command, tool, MCP server, git call and hook either in WSL (`wsl.exe -d <distro> --cd <dir> -e …`) or natively on Windows. It also translates paths between Windows (`C:\…`) and Linux (`/mnt/c/…`).

## Data (all under `data/`, or `ORBIX_DATA`)

| Path | Contents |
|---|---|
| `config.json` | app settings: theme, layout, projects, where commands run |
| `engine.json` | AI providers, approvals, model roles, web search. API keys are encrypted with Windows DPAPI (`secrets.mjs`) |
| `sessions/<project>/*.jsonl` | saved conversations, append-only |
| `mcp.json`, `hooks.json` | your MCP servers and hooks |
| `cache/` | the model catalog from models.dev, refreshed at most once a day |
| `logs/server.log` | the server log, capped at 1 MB. Keys, commands and MCP arguments are never written to it |
| `instance.json` | the running server's port and token (single instance) |

## The interface (`web/`)

Plain ES modules, no framework or build step. All text goes through `createTextNode`; nothing uses `innerHTML` with outside data.

| Module | Role |
|---|---|
| `main.js` | start-up, layout, sidebar, tabs, keyboard shortcuts, routing events to views |
| `store.js` | client state and the reducer that turns session events into UI state |
| `api.js` | HTTP calls and the SSE connection |
| `home.js` | the Home dashboard and the new-session box |
| `session.js`, `tools.js`, `markdown.js`, `highlight.js`, `ansi.js` | the conversation view and how messages and tool steps render |
| `composer.js` | the message box: attachments, history, `/` and `@` pop-ups |
| `panels.js` | the side panel: Files, Changes (git), Todos, Agents, Console |
| `settings.js`, `engine.js`, `models.js`, `mcp.js`, `toolset.js` | Settings |
| `dialogs.js`, `cleanup.js`, `diagnostics.js`, `help.js`, `notify.js`, `chrome.js` | dialogs, the status bar and notifications |
| `glyphs.js` | the ASCII planet and glyph field behind the workspace |
| `dom.js` | DOM helpers, icons and the logo |

## Tests

`npm test` runs `test/*.mjs` with Node's built-in test runner. The tests need no network and no API keys, and use a temporary data folder.
