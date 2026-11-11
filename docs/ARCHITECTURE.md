# How ORBIX is built

ORBIX is a local Node.js server and a browser interface. The server runs one agent loop per open conversation and listens only on `127.0.0.1`.

```
Browser (web/)  ◀──────▶  AppServer (src/server.mjs)  ──────▶  AgentProc per session (src/engine/proc.mjs)
 ES modules, CSS            HTTP JSON API + SSE                   model clients, tools, MCP, hooks
                                                                    │
                                                                    └─ Backend (src/backend.mjs): WSL or Windows
```

## Start-up and shutdown

1. `npm start` runs `src/main.mjs` and opens ORBIX in the default browser.
2. The server checks `data/instance.json` and reuses a healthy existing server when possible.
3. A new server creates a random token, binds to port 47821 (or another available local port), and passes the token to the browser in a one-time URL. The server exchanges it for an `HttpOnly`, `SameSite=Strict` cookie, then redirects to `/`.
4. On first run the server detects where commands run: the first WSL distribution that starts, otherwise Windows.
5. The browser app keeps the server available when a tab closes. Stop the terminal process to shut it down. `npm run serve` runs headlessly and exits after the server has been idle; `node src/main.mjs --no-window` keeps the server running without opening a browser.

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

Each open conversation is one `AgentProc`. The interface talks to it in two ways:

- **Requests** (`POST /api/rpc` → `proc.request(cmd)`): prompt, abort, state and message retrieval, model selection, compaction, undo, regeneration, branching, shell commands, exports and session settings.
- **Events** (on the SSE stream): agent and turn lifecycle, message updates, tool execution, approvals and questions, compaction, retries, subagents and session information.

One turn combines the user's message, project rules (`context.mjs`: `AGENTS.md` / `CLAUDE.md`) and skills, then streams a model reply and runs approved tool calls until the model stops (at most 100 turns).

- **Approvals:** `write`, `edit` and `bash` ask first unless approvals are off. Reading and searching never ask.
- **Undo:** every edit records the previous file contents, so `/undo` and the Undo buttons can restore them.
- **Compaction** (`compact.mjs`): older messages are summarised when context fills. The full history stays on disk and on screen.
- **Subagents** (`subagent.mjs`): the `task` tool runs read-only helper agents side by side and returns their answers.
- **Slash commands** (`slash.mjs`, `commands.mjs`): built-in commands such as `/plan`, `/undo` and `/compact`, plus Markdown prompt files from the project.

### Tools

Built in: `read`, `write`, `edit`, `glob`, `grep`, `bash`, `todo`, `web_fetch` and `web_search` once a search service is set up. File search uses ripgrep when available, otherwise a `.gitignore`-aware walker (`search.mjs`). `web_fetch` refuses private and local network addresses unless approved.

### MCP (`src/engine/mcp.mjs`)

Servers come from `data/mcp.json` (yours) and a project's `.mcp.json`, in the common `{"mcpServers": {...}}` format, over stdio or HTTP. They start on the first message of a session, run where that session's commands run, and stop with the session. Project servers start only after you approve that exact config once.

### Hooks (`src/engine/hooks.mjs`)

Hooks run at `PreToolUse`, `PostToolUse`, `UserPromptSubmit` and `Stop`. Files: `data/hooks.json` (yours) and `<project>/.orbix/hooks.json` (needs a one-time OK). Exit code 2 blocks the action.

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
| `logs/server.log` | capped server log; keys, commands and MCP arguments are never written to it |
| `instance.json` | the running server's local port and token |

## The interface (`web/`)

Plain ES modules, no framework or build step. All text goes through `createTextNode`; outside data is never inserted with `innerHTML`.

| Module | Role |
|---|---|
| `main.js` | start-up, layout, sidebar, tabs, keyboard shortcuts, routing events to views |
| `store.js` | client state and the reducer that turns session events into UI state |
| `api.js` | HTTP calls and the SSE connection |
| `home.js` | Home: task box, next actions, recent conversations and projects |
| `session.js`, `tools.js`, `markdown.js`, `highlight.js`, `ansi.js` | conversation view and tool steps |
| `composer.js` | message box: attachments, history, `/` and `@` pop-ups |
| `panels.js` | side panel: Files, Changes (git), Todos, Agents, Console |
| `settings.js`, `engine.js`, `models.js`, `mcp.js`, `toolset.js` | Settings |
| `brands.js` | provider logo marks, drawn inline |
| `ascii.js` | orbit, decoding headline, typed examples and empty-panel art |
| `dialogs.js`, `cleanup.js`, `diagnostics.js`, `help.js`, `notify.js`, `chrome.js` | dialogs, status bar and notifications |
| `dom.js` | DOM helpers, icons and logo |

## Tests

`npm test` runs `test/*.mjs` with Node's built-in test runner. Tests need no network or API keys and use a temporary data folder.
