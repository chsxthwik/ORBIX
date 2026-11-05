# Changelog

## Unreleased
- **New look: two signals.** Graphite surfaces, orange for you (your messages, approvals, the action that starts work) and teal for the agent (anything it is doing right now). No gradients or glows.
- **One mark everywhere.** A ring with a tilted orbit and an orange node, the orbit passing behind the ring at the top and in front at the bottom. The app, icon, favicon, README banners, social images, demo storyboard, architecture diagram and website all use it. The sidebar mark turns while the agent works.
- **Home.** The question names the selected project, project tabs sit on the launch panel, and Model, Plan first and approval chips sit under the message box (they wrap on narrow windows). Recent shows what is working or waiting; a setup checklist hides once everything is done.
- **Sidebar.** A Running section lists sessions that are working (teal) or need you (orange). A new conversation shows under its project right away instead of "No conversations yet".
- **Session view.** Consecutive tool steps of one reply sit evenly instead of with large gaps. A reply summary lists what the agent read, searched, ran and changed. 1 and 2 answer an approval from anywhere outside a text field.
- **Fixes.** A tool's run time no longer includes the time it waited for your approval. Tabs shrink before the tab strip scrolls. "1 model" instead of "1 models". The status bar shows "WSL" instead of "WSL · ?" for the default distribution. Undo buttons share one icon.
- **Install.** `tools/install.ps1` installs ORBIX to `%LOCALAPPDATA%\Programs\ORBIX` with shortcuts and an Apps entry; `Uninstall-ORBIX.ps1` removes it and keeps your chat history. `Create-Shortcuts.cmd` is gone.

## 3.0.0
- **ORBIX - Unified ADE**: a native Windows app where an AI agent works on your project. It reads files, edits them and runs commands, and asks before it changes anything. Every file change can be undone.
- **Its own agent**: 17 providers (Anthropic, OpenAI, Google Gemini, xAI, Groq, Mistral, DeepSeek, OpenRouter, Together, Fireworks, Cerebras, Moonshot, Z.ai, Qwen, Ollama, LM Studio, any OpenAI-compatible server), Sign in with OpenRouter, live model lists, prices and context sizes, thinking levels, automatic retries, cost and context display.
- **Agent tools**: read, write, edit, bash (PowerShell on Windows), glob, grep, web fetch, helper agents, task list, MCP servers, skills, custom slash commands, `@file` mentions, images and text attachments, `/compact`, `/plan`, `/model`, `/cost`, `/undo`, retry and HTML export.
- **Model roles**: choose a fast model (chat titles, summaries, helper agents) and a plan model (`/plan`) in Settings → AI providers → Models, or per session with `/model fast|plan <model>`. Titles never use the main model.
- **Hooks**: your own commands before and after tool calls, on each message and when the agent stops (`data/hooks.json`, or `.orbix/hooks.json` in a project, which asks once before it runs). Exit code 2 blocks the action and tells the agent why. Listed in Settings → Tools & MCP and with `/hooks`.
- **Branching**: branch a conversation from any message of yours (or `/branch`). It opens in a new tab with everything before that message; your files are not changed.
- **Web search**: the `web_search` tool, off until you add Brave Search, Tavily or your own SearXNG in Settings → Tools & MCP. Needs no approval once on; the key is stored encrypted.
- **Project memory and goals**: `/init` writes or refreshes AGENTS.md, `/memory` shows where it is, and `/goal <text>` keeps the agent working by itself (up to 6 rounds, Esc stops it) until it ends with GOAL_DONE.
- **Interface**: animated home, inline approvals above the message box (1 allow once, 2 allow for the session, Esc deny), `/` and `@` pop-ups, coloured command output, diffs, tabs, side panels (files, git, plan, agents, console), command palette (Ctrl+K), light and dark themes, measured status bar.
- **Nothing to install**: the release zip includes its own Node.js (checksum verified).
- **Safe by default**: local server on `127.0.0.1` with a per-launch token, strict Content-Security-Policy, keys encrypted with Windows DPAPI, private-network protection in web fetch, MCP project servers need your approval.
- **Optional**: if the OMP CLI is installed, sessions can also run with it.
