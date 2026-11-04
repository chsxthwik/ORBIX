# Changelog

## Unreleased
- **New logo.** Two orbits cross to form the X of ORBIX inside an O, woven over and under, with one cyan node. Sizes up to 32 px use a heavier simplified master. Icon, favicon, social images, banner and in-app mark were redrawn; the in-app mark is static and the sidebar copy breathes while the agent works.
- **Interface redesign.** Warm-neutral surfaces with one accent colour for choices, mint for anything the agent is doing right now and amber for anything waiting on you. Borders carry the structure; the glows, gradients and the animated mark on the home screen are gone.
- **Session view.** Your messages are blocks with a "You" label, not chat bubbles. Tool calls are compact steps on a rail that open into a card; thinking folds to one line. Approvals dock above the message box with the exact file or command and the keys 1, 2 and Esc.
- **Home.** One question, the message box, then Projects and Recent side by side. The example-task chips were removed.
- **Top bar.** The active session's project is a chip: new session there, show the folder, copy its path.
- **Composer.** The model chip reads "Default model" until a turn picks one, and shows the model as soon as the first turn starts.
- **Status bar and side panel** use the mono face for data (tokens, cost, branch, paths) and the same tab style as the top bar.

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
