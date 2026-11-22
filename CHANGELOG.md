# Changelog

## ORBIX 4

The unified open-source ADE: every coding agent and every model in one environment, on your PC or on a machine you own. 4.0.0 shipped on 2026-11-21; everything below it is in `main` and ships with the next build of ORBIX 4.

**Every agent**
- **Claude Code, Codex, OpenCode, Gemini CLI and any ACP agent** run conversations in ORBIX on the plan or key each already uses. Each appears in the model picker as its own provider.
- Their work shows as ORBIX steps in the same "Worked for…" fold. Their permission requests become ORBIX approval cards, and reopening a conversation resumes the agent's own session.
- Claude Code runs through stream-json and its control protocol, Codex through `codex app-server`, the rest through the Agent Client Protocol.
- **Settings → Agents** shows what is installed, each version and whether it is signed in, with the command to fix it when it is not. Add your own ACP agents by command.

**ORBIX Cloud**
- **The engine on a Linux machine you own** (`src/headless.mjs`), with no window. `install.sh` sets it up as a systemd user service and prints its address and token. Keys are sealed with AES-256-GCM.
- **Settings → Machines** adds a machine by address and token (stored encrypted; plain `http://` across the internet is refused) and opens it in the app.
- **Move to a machine** sends the project with its git history and uncommitted changes, and the conversation continues there.

**Control**
- **Four permission levels:** Supervised, Auto edits, Guarded (file changes and read-only commands such as `ls`, `grep`, `git status` and pipes of them) and Full access. Destructive commands ask at every level, for every agent.
- **No server in the Windows app.** The engine runs in the app's own process and talks to the window over Electron IPC. Nothing listens on a port.
- **No personal details from Windows.** Home greets you only by a name you set yourself.

**Workspace**
- **Terminal** (<kbd>Ctrl</kbd>+<kbd>`</kbd>): real shells on a pseudo-terminal, several per project, two side by side. Your login shell in WSL and Linux, PowerShell for a Windows folder.
- **Side panel tabs, like a browser's**, kept across restarts. **+** opens a page of every surface with its shortcut: Browser (or Incognito), Terminal, Files, Changes, Review, Tasks, Inspect, Device and Side question.
- **Project menu:** where the project runs, **Open in** File Explorer, VS Code, Cursor, Windsurf, Zed or Windows Terminal, project scripts that run in the Terminal, and Initialize Git.
- **Context meter** in the toolbar: tokens used, the numbers on click, and **Compact now**.
- **Model picker** over the message box: providers in a rail (Starred and Recent first), models with <kbd>Ctrl</kbd>+<kbd>1…9</kbd>, and each model's reasoning levels beside it.
- **Message box:** **+** adds images, files, commands (`/`), context (`@`) and shell commands (`!`, run in the project's Terminal). The model reads **Provider / Model**; the reasoning level is its own menu.
- **Sidebar:** New conversation, Search, Plugins, Skills, Loops, Runs and Review.
- **Loops** (scheduled prompts) run every 5 to 1440 minutes, on a calendar, or once. Create with Prompt understands "every 15 minutes", "in 2 hours" and "tomorrow at 9".
- **Plugins:** a marketplace of MCP servers and everything installed. **Skills:** add, edit or delete `SKILL.md` skills for one project or all of them.
- **Settings** fills the window, with search and four groups of pages.
- **Updates** in the top right corner: progress while downloading, then **Restart to update**.

**Identity and feel**
- **The `)(` mark:** an O whose halves swap along one orbit and become the X. It is the app icon, installer, tray, favicon and wordmark.
- **Plasma `#FF2E7E`** is the one accent, with a deeper Plasma for text on light themes. Contrast meets WCAG AA in dark and light.
- **Home hero made of light:** about 1,300 particles spiral into the mark, swap into the X and respond to the pointer. Still under reduced motion.
- **One motion rhythm** (140/220/320/460 ms on a soft ease-out) and one set of controls: 32px buttons and fields with 8px corners and a clear focus ring.
- **Google Sans Flex** for the interface, **Geist Mono** for code.

**Website**
- Rebuilt on the new identity: the agents ORBIX runs, three ways to connect a model, the four permission levels, Windows and Cloud, responsive screenshots and strict security headers.

**License**
- ORBIX is now licensed under **MIT**.

**Fixes**
- The model chip no longer reads "null" for a model without reasoning levels.
- Changing the permission level applies at once in conversations on external agents.
- Steps stay folded in their own turn; a new conversation is listed once; renaming works from the toolbar and the sidebar.
- `git log`, `git diff` and `man` no longer hang in a WSL Terminal.
- Commands in a WSL workspace opened by its Windows path run in the right distribution and folder.

## 3.x (2026-11-04 to 2026-11-20)

- **3.9:** Home with suggestions from the project, a marketplace of MCP servers, scheduled prompts from one sentence, Appearance and Application settings.
- **3.8:** chat first: the side panel starts closed, sharper replies, 👍 and 👎 counted per model.
- **3.7:** Settings rebuilt, shortcuts you can change, network access rules for web reads, a built-in browser, project pages.
- **3.6:** scheduled prompts, a Browser tab for apps running on your PC, side questions with `/btw`, rule files with triggers.
- **3.5:** Settings as a page, archived conversations, deleted conversations restorable for 30 days.
- **3.4:** the desktop shell: menu row, toolbar, back and forward; the most permissive mode asks before destructive commands.
- **3.3:** Runs: a task planned, approved and done in its own git worktree, then reviewed and applied. One Review queue and recovery after a restart.
- **3.2:** automatic updates, sign-in with xAI, accurate model facts and thinking levels, scene themes, parallel agents on their own branches.
- **3.1:** Midnight and Frost themes, real provider logos, a new Home and Settings, and an installer script.
- **3.0:** first release: a native Windows app with its own agent on 17 providers, tools, MCP, hooks, branching, web search and project memory.
