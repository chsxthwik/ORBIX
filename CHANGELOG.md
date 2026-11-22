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
- **Context** in the toolbar: a ring with the tokens in use opens the **Context** tab (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd>): session, provider, model, context limit and fill, tokens by kind (input, output, cache read and write), your messages and replies, tool calls, cost, when it started and was last active, **Compact now**, and the system prompt the next turn sends. Beside it, the **Context menu**: where the project runs, then its MCP servers, skills and rule files, each opening to the side.
- **Replies say how they were made:** "Claude Opus 5.5 Medium · 5s · 103.5 tok/s" (the model and its reasoning, the turn's time, the writing speed; the first-token latency in the tooltip). Each turn's fold shows what ran ("Read 2 files · Ran 1 command") without pointing at it.
- **A working session** shows a small dot grid in its sidebar row, light running round it like an orbit.
- **Command Guard** (Settings → Agents, on by default): commands that wreck a computer or an account are never run, approved or not: deleting a whole home folder, drive or the root, wiping or formatting a disk, a fork bomb, deleting a hosted repository. It covers ORBIX's agent and the commands Claude Code, Codex and ACP agents ask to run.
- **Claude Code subagents** can be turned off (its Task tool is hidden), and **Longest automatic wait** sets how long a busy or rate-limited provider may make ORBIX wait before it retries by itself (it was fixed at 1 minute).
- **Instructions for some models** (Settings → Instructions): extra instructions added when the model id contains a given text.
- **Hold Ctrl** for a moment: every control with a shortcut shows its keys beside it.
- **Conversations as tabs** (Settings → Appearance → Layout): the open conversations in a row of tabs under the toolbar.
- **Home** lists the chosen project's latest conversations by day (Today, Yesterday, Earlier).
- **Reasoning slider:** the reasoning level opens a slider over a live dot field (brighter and busier the higher the level), from Off to the model's highest, with its default marked and what each level costs in a line below. Arrow keys, Home and End work on it.
- **Analytics** (Settings): tokens per day by kind (all, written, read, from cache) over 7, 30 or 90 days, your messages, agent time, streak and busiest day, the models used, and when in the week you prompt, with a tooltip on every mark and every day as a table. Read from the conversations saved on this PC.
- **Keep awake** has three modes: off, while agents work (and 10 minutes after), or always with the screen on.
- **Conversation names:** how a new conversation is named can be rewritten in Settings → Instructions; empty restores the built-in naming.
- **When something fails:** a notification when a turn ends on an error, instead of "finished".
- Settings shows Esc beside Back and / beside Search, and / jumps to the search.
- **More settings:** in-app notifications (a note when another conversation finishes or needs you), the sidebar's Running section on or off, skills in the slash menu, message box and terminal font size, font smoothing, the reasoning level as a name or bars, confirmations for archiving, unpinning and killing a terminal, **Ignore whitespace** in diffs, and **No AI credit in commits** (no Co-authored-by or "generated with" lines, for ORBIX's agent and Claude Code).
- **Room to read:** a 14px interface and 15px conversation, 32–36px rows, larger icons and Settings pages, section heads in small capitals, a Plasma rail on the current item, and slower, weightier motion.
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
- **Graphite:** a quiet monochrome dark theme. Ink instead of Plasma for the accent, the mark and the current item; colour only for state (amber waits on you, blue marks the agent at work, red stops); your message as a pill and a softer message box.
- **Editor palettes:** Tokyo Night, Catppuccin Mocha and Latte, Rosé Pine and Dawn, Nord, Dracula and Gruvbox, from each project's published colours, for surfaces, text, status and code.
- **Nebula scene:** slow clouds of colour and twinkling stars in deep space. It replaces Koi pond and Halftone dusk; those settings move to Catppuccin Latte and Nebula.

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
