# Changelog

## Unreleased
- **Session bar.** Every conversation has a bar on top with its state (Ready, Working with a timer, Needs your OK), its name (click to rename), and how many messages and steps it has.
- **Find in conversation.** Ctrl+F highlights every match and steps through them with Enter and Shift+Enter.
- **Your messages.** Ctrl+Shift+O lists the messages you sent and jumps to the one you pick.
- **Focus mode.** Ctrl+Shift+F hides the sidebar, tabs, side panel and status bar so only the conversation is left.
- **Wide reading column.** A button in the session bar widens the conversation for long diffs and tables.
- **Home.** A card to resume the last conversation, a 26-week activity map and ready-made task buttons under the task box.
- **New first screen.** Before a model is connected, Home is one screen: the providers as a short list on the left, each marked API key, Sign in or No key, and an example session on the right. The six-item feature list is gone.
- **Cleaner mark.** The ring is one continuous line around the planet with an even gap, and the orbit and node are lighter at large sizes.
- **Sharper ASCII orbit.** The planet has a soft edge, dithered shading and a highlight, the ring is drawn as one line that passes in front of the planet, and the picture resolves out of noise when it appears.
- **Sign in with xAI.** Open the xAI provider in Settings and sign in with your Grok account. Uses the Grok CLI's public client registration (unofficial; xAI can revoke it).

## 3.1.0
- **New themes and controls.** Midnight (cool dark) and Frost (cool light) join Dark and Light, with support for Windows high-contrast mode and the system's more-contrast setting. Buttons have clearer hover, pressed and disabled states, and the focus ring now follows each control's shape.
- **Steadier ASCII orbit.** Even frame pacing, no squashing in narrow windows, and it stops cleanly when removed.
- **README rewritten** with new logos, current screenshots of every theme, a provider grid and an architecture diagram.
- **New Home.** One question and the task box first, with project, model, Plan first and approvals in its bottom row. Sessions that need you or are working show above it. Recent conversations, projects and this week follow, and the screen fits without scrolling on a normal window. The planet stage, big numbers and activity grid are gone.
- **New mark and ASCII touches.** A cleaner solid logo that stays sharp at small sizes, and a new app icon. The node on the sidebar mark travels its orbit while the agent works. An ASCII orbit greets you on Home and reacts to your pointer and to what the agent is doing. The headline decodes into place, the task box types example tasks, spinners and the working indicator are ASCII, and empty panels have small art.
- **Real provider logos.** Providers now show their own marks on Home, in Settings, in the model picker and on the model button.
- **Calmer workspace.** Sidebar has Home and Search rows. Side panel tabs show words. One tab style, sentence-case labels, and no animated background behind conversations.
- **New Settings.** A larger sheet with a search box that jumps to any setting. Overview shows your setup at a glance; Providers is a short list where one row opens at a time; Models has its own page; Permissions uses clear choices, and Allow everything now asks you to confirm; Appearance shows theme previews.
- **OMP CLI support removed.** ORBIX now runs only its own agent. Gone: OMP detection, the engine switch on Home, the OMP CLI settings tab and sign-in, Fast mode, `/handoff`, and listing or deleting OMP's own conversations (they stay in `~/.omp`, untouched). Old `ompPath`, `launch` and `defaultEngine` settings are dropped on load. Project folders `.omp/AGENTS.md`, `.omp/skills` and `.omp/commands` are still read. On first run ORBIX now picks the first WSL distribution that starts, else Windows.
- **New look.** Graphite surfaces with a lime accent in Dark and Light.
- **Sidebar.** A Running section lists sessions that are working or need you. A new conversation shows under its project right away instead of "No conversations yet".
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
