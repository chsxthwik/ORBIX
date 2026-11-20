# Parity matrix: ORBIX and the Google Antigravity App for Windows

ORBIX is built from its own source. The benchmark is used as a functional specification only: what a user does and
what they get, as written in the public documentation. Model wording, internals and branding are out of scope.
"Parity" on a task means comparable working changes, test evidence and review documents.

## Benchmark

| | |
|---|---|
| Product | Google Antigravity App for Windows |
| Version | **v2.33.0**, released November 17, 2026. Checked on November 20, 2026: no newer app version. The only later changelog entry is a model launch (November 18) with no app version. |
| Platforms | Windows 10 (64-bit) and Windows 11, x64 and ARM64 installers. RAM, disk and CPU requirements are not published. |
| Sources | https://antigravity.google/docs/changelog · https://antigravity.google/docs/features/ · https://antigravity.google/download and the feature pages linked from the docs navigation |
| Not used | The benchmark's binaries, network traffic, prompts or any non-public material. |

## How to read the status column

| Status | Meaning |
|---|---|
| **Done** | The real user workflow was demonstrated end to end; the evidence column names the test. |
| **Existing** | Shipped before this work (ORBIX 3.2.x) and covered by its unit tests; not re-demonstrated through the desktop UI in this round. |
| **Partial** | Part of the workflow works; the gap is stated. |
| **Not started** | No implementation. |
| **Unknown** | The benchmark's behavior is not documented, so there is nothing to match yet. |

Evidence: `npm test` = `node --test` (821 tests: 820 pass, 1 skipped). `npm run e2e` runs 15 workflow steps plus Home and conversation checks against the deterministic model fixture. `node e2e/conversation.mjs --desktop` passed those Home and conversation checks in the packaged Windows Electron window. The recorded workflow report is in `docs/evidence/e2e-run-workflow.json`; pass `--shots` directly to either test script to capture local screenshots.

## 1. The first complete workflow

Open Git repository → describe a task → see the plan → authorize scoped execution → changes in an isolated worktree →
run tests → inspect diffs and artifacts → give feedback → apply or discard → restart and recover.

| # | Benchmark behavior (documented) | ORBIX | Status | Evidence |
|---|---|---|---|---|
| 1.1 | Create a project from a folder; type a prompt; choose **Local mode** or **New worktree mode** | Runs (Ctrl+2): pick the project, describe the task, **Start run**. A run always gets its own worktree and branch (`.orbix/worktrees/<slug>`, `orbix/<slug>`). A folder that is not a Git repository, or has no commit, is refused with the reason. Local mode stays available as an ordinary conversation. | Done | e2e steps 1–2; `test/runs.test.mjs` "a folder that is not a git repository is refused" |
| 1.2 | **Planning mode** (plan before executing) and **Fast mode** (execute directly) | **Plan first** and **Straight to work** on the start box | Done | e2e steps 2 and 9; `runs.test.mjs` planning and `mode: 'direct'` cases |
| 1.3 | `/plan`: explores without side effects, writes an **Implementation Plan** artifact, then always waits for approval | While planning the agent has read-only tools plus `artifact`; a write is refused. The plan is saved as a document and the run waits (`awaiting_plan`). | Done | e2e step 2 (the model was offered no `write` or `bash`); `runs.test.mjs` "planning: the agent may only read" |
| 1.4 | Approve with **Proceed**; steer with inline comments, then Proceed or send a message | **Approve plan…** opens a dialog that states the worktree path, the branch, the plan revision and exactly what is allowed; you choose "edit files" or "edit files and run commands". | Done | e2e step 5 (`docs/evidence/03-approve-scope.png`) |
| 1.5 | Comments are **pending**, attach to the next message, shown as a chip such as "2 Comments" | Comments on a plan passage or a changed file are held ("not sent yet"), counted on the send button, and go to the agent with your feedback or with the approval. | Done | e2e step 4; `runs.test.mjs` "comments are held, then sent with your feedback" |
| 1.6 | Plan revisions after feedback | Every `artifact` call saves a new revision; earlier revisions stay readable; a new revision replaces the one on screen. | Done | e2e step 4 (revision 1 reopened); `runs.test.mjs` artifact revisions |
| 1.7 | Permission prompts for commands; rules always win over presets; some actions always ask | One execution policy (`src/engine/policy.mjs`): files outside the worktree and destructive commands (recursive delete, push, publish, history rewrite, system changes, piping a download into a shell) ask every time, with no lasting choice offered, whatever was approved. | Done | e2e step 9; `runs.test.mjs` policy tests and "a destructive command asks even when commands were approved" |
| 1.8 | Agent changes shown as changed-file cards with a **Review** button; Review compares against the base branch | **Changes** tab: file list with +/− counts and a per-file diff against the commit the run started from. | Done | e2e step 7 (`05-changes.png`) |
| 1.9 | **Walkthrough** artifact when implementation finishes | The agent saves a walkthrough; ORBIX writes a **Test log** document from the project's check (command, exit code, duration, output). | Done | e2e steps 6–7 (`04-walkthrough.png`) |
| 1.10 | Merge-back flow from a conversation worktree | **Undocumented** in the benchmark. ORBIX: **Apply changes…** commits on the run's branch and merges into the branch it started from. Your uncommitted work in other files is kept; an edit of yours to a file the run changed, or a merge conflict, refuses the apply and changes nothing on either side. **Discard…** removes the worktree and branch. | Done | e2e steps 8 and 13; `runs.test.mjs` "apply keeps your own uncommitted work", "a conflict changes nothing" |
| 1.11 | Conversation states **Action required / Working / Unread** | Run states: Planning, Plan to review, Asked you a question, Working, Changes to review, Stopped, Failed, Interrupted, Applied, Branch kept, Discarded. | Done | e2e throughout |
| 1.12 | Behavior after the app restarts mid-run | **Undocumented** in the benchmark. ORBIX: every tool call, result, approval and answer is in an append-only event log. A run that was working when ORBIX stopped is marked **Interrupted** and names the actions still in flight. Resume is refused until you acknowledge an action with side effects; the agent is told to inspect the state first, and the action is not re-run by ORBIX. The approved scope still applies after the restart. | Done | e2e steps 10–12 (server killed with SIGKILL, `08-interrupted.png`, `09-resume-dialog.png`); `runs.test.mjs` "restart: an interrupted run keeps its evidence" |
| 1.13 | Cancel a running agent | **Stop** on the run; the run becomes Stopped and can continue. | Done | `runs.test.mjs` "stop cancels a working run; it can be resumed" |
| 1.14 | Windows paths | Repository path with a space and a non-ASCII letter (`shop api ñ`), data folder under `ORBIX e2e ñ-…`. | Done | e2e (all steps), `runs.test.mjs` (`my repo ñ`) |

## 2. Interface

| # | Benchmark behavior | ORBIX | Status | Evidence |
|---|---|---|---|---|
| 2.1 | Sidebar of conversations grouped by project, with states | Kept. Added **Runs** (every run across projects, grouped Working now / Waiting for you / Finished) and **Review**. | Done | e2e steps 1, 8, 14 |
| 2.2 | No single inbox is documented (the word does not appear); a needs-attention icon marks conversations | **Review** (Ctrl+3): one queue across projects for approvals, plans to approve, changes to review, questions, interrupted and failed runs, with the decision buttons in place and a count in the sidebar. | Done | e2e steps 8, 9, 11 (`06-review-queue.png`) |
| 2.3a | Agent steps grouped into collapsible **Worked for** rows, changed-file cards with **Review** | A finished turn's steps fold into one "Worked for 14s" row with what was done; the reply stays below it; a "N files changed" card with Review and Undo all. | Done | `e2e/conversation.mjs` (`12-conversation-folded.png`, `13-conversation-steps.png`) |
| 2.3 | Agent steps grouped in collapsible rows | Run **Timeline**: each step is one row (a call with its result, an approval with your answer) and opens what it produced: the document revision, the file's diff, the test log. | Done | e2e step 3 |
| 2.4 | Keyboard: Ctrl+K search, Ctrl+J terminal, Ctrl+D split, Ctrl+Alt+O Overview | Ctrl+1 new conversation, Ctrl+2 Runs, Ctrl+3 Review, Ctrl+K search, Ctrl+Alt+O Overview, Alt+←/→ back and forward, Ctrl+Enter sends. Ctrl+J toggles the side panel (not a terminal). Split view is not implemented. | Partial | e2e step 14 |
| 2.5 | High-DPI rendering | Tested at device scale factor 2. | Done | e2e step 14 |
| 2.6 | Accessible focus, loading/empty/error states | Rows and actions are buttons with focus rings; one `aria-current` page; skeletons, empty states and error states with Retry on every view. | Partial (no screen-reader pass yet) | e2e step 14 |
| 2.8 | Window layout: menu bar, toolbar with Back, Forward and "Search Conversations", sidebar and title bar on one background, filled toggle buttons, a top-left icon that starts a new conversation (docs: search, changelog v2.28–v2.30) | Menu row (ORBIX, Workspace, View, Window) as the title bar; toolbar with the mark (new conversation), sidebar switch, Back/Forward (Alt+←/→) across conversations and views, search, project / conversation breadcrumbs with state and branch; toggles filled while open. Menu items are ORBIX's own: the benchmark's menu contents are not documented. | Done | `e2e/conversation.mjs` (menu row, breadcrumb, Back) |
| 2.9 | Overview panel: toggle at the top right (Ctrl+Alt+O), Review / Files / Terminal rows, Subagents and Background Tasks sections, empty sections hidden, an overlay in small windows (docs: side-panel) | Overview card with Changes (or Review on a branch), Files, Terminal, Plan and Inspect, which open the side panel; Subagents and Background runs only when there are any. In a small window the button opens the side panel. No Extensions row and no per-section customization. | Partial | `e2e/conversation.mjs` (card shown with the panel closed; Files opens the panel) |
| 2.10 | Composer permission picker (Request Review / Default / Auto / Turbo), "+" Add Context, model picker with the thinking level (docs: permissions, at-mentions, models) | Permission chip with Ask first / Auto edits / Turbo (the same setting as Settings → Permissions; destructive commands always ask); "+" for files, @ mention and / commands; model and thinking level side by side. No sandbox tiers and no voice input. | Partial | manual check; unit tests for the policy |
| 2.11 | Conversation navigator: a rail at the left edge with one dot per turn, hover preview (changelog v2.28.1) | Dots on the left edge, one per message of yours and a mark per error, the turn being read lit; hover shows the message and its time; click jumps; drag scrubs; Alt+↑/↓. | Done | manual check (`timeline.js`) |
| 2.12 | Hover card on a conversation with project, state (Action required / Working / Unread) and pin on hover (changelog v2.7.1, v2.17.0, v2.28.0) | Preview card after a short rest: title, project, last update, branch, state, first line; pin and ⋯ on the row. No archive. | Done | manual check |
| 2.7 | Project context before a task | Home shows the selected Git branch and changed-file count without a model, and refresh preserves the draft. | Done | `node e2e/conversation.mjs --desktop` |

## 3. Extended parity (not part of the first workflow)

| # | Benchmark behavior | ORBIX | Status | Notes |
|---|---|---|---|---|
| 3.1 | Projects with several folders | One folder per project | Not started | |
| 3.2 | Concurrent conversations | Several runs work at once, each in its own worktree | Done | `runs.test.mjs` "two runs work at the same time" |
| 3.3 | Message queueing while the agent works | Feedback sent to a working run is queued and read at its next step | Existing | `test/agent.test.mjs` |
| 3.4 | Subagents (`research`, `browser`, `self`; custom agents; states Running/Idle/Killed; depth 10) | `task` tool: read-only helper agents in parallel, listed in the Agents panel. No custom agents, no write-capable subagents, no parent-child run records. | Partial | |
| 3.5 | Background tasks with **Cancel Task** | Not implemented as a separate queue | Not started | |
| 3.6 | Task list / task groups | **Unknown** for the App (documented for the IDE only). ORBIX has a `tasks` artifact kind and the existing to-do list. | Unknown | |
| 3.7 | Screenshots, browser recordings as artifacts | Not implemented | Not started | Needs 3.9 |
| 3.8 | Inline comments on diff lines with line numbers | Comments attach to a whole changed file | Partial | |
| 3.9 | Built-in browser, browser agent, site/upload/download approval prompts | Not implemented | Not started | Isolated profile and the documented prompts are specified in the research notes |
| 3.10 | Partial acceptance of changes | Whole-run apply or discard only | Not started | **Undocumented** in the benchmark beyond stage/unstage/discard in Review |
| 3.11 | Review: stage, unstage, discard, commit, amend, push | Changes panel of a conversation: stage, unstage, discard, commit | Existing (no amend/push) | `test/gitwrite.test.mjs` |
| 3.12 | Checkpoints and **Confirm Undo** with the list of files | Every edit records the previous content; `/undo` and Undo buttons | Existing | `test/engine.test.mjs`; benchmark behavior is changelog-only |
| 3.13 | Rules (`AGENTS.md`, `.agents/rules/*.md` with `trigger` frontmatter) | `AGENTS.md` / `CLAUDE.md` up the folder tree | Partial (no rule triggers) | |
| 3.14 | Skills (`SKILL.md`, progressive disclosure, `/<skill>`) | Skills and Markdown command files | Existing | `test/slashprompts.test.mjs` |
| 3.15 | MCP (stdio and HTTP, per-server controls, OAuth, lazy tools) | stdio and HTTP servers, project servers need a one-time OK | Existing (no OAuth, no lazy loading) | `test/engine.test.mjs` |
| 3.16 | Hooks (`SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`; decisions) | `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`; exit code 2 blocks | Partial | `test/features.test.mjs` |
| 3.17 | Automations and `/schedule` | **Scheduled** in Runs (Ctrl+2) and `/schedule daily 09:00 <task>` in a conversation: project, task, when (once at a time, every N minutes or hours, daily or weekdays at HH:MM), on/off, Run now, Delete, next time and last result. A due schedule starts an ordinary run in its own worktree. It is **unattended**: the plan is approved with the scope picked when the schedule was made (file edits, optionally commands), and anything that would ask (a command outside that scope, a destructive command, a file outside the worktree, a hook or MCP prompt) is denied and written to the run's log; the global approval mode does not widen it. Changes wait in Review; nothing is applied for you. Runs only while ORBIX is open: a time missed while it was closed runs once at start-up, then the schedule continues; a time that comes while the last run still works is skipped. | Done | `test/schedule.test.mjs`: recurrence math (day, month, year rollover, weekends), persistence round-trip, "no overlapping runs", "catch-up after a restart", and two unattended runs against a scripted model and real git ("a command is denied without asking, logged", "a destructive command is still denied"). The Runs view (create, Run now, open the run, turn off) was checked in a headless window; it is not a step of `npm run e2e` yet. No start-up task in Windows: nothing runs while ORBIX is closed. |
| 3.18 | Permission presets (Request Review, Default, Auto, Turbo) and the `action(target)` rule engine | Three approval modes plus trusted commands and the run scope | Partial | |
| 3.19 | Terminal sandbox | Not implemented | Not started | The benchmark's Windows mechanism is **undocumented**; it needs Windows 11 24H2 |
| 3.20 | SSH hosts (v2.33.0) | Not implemented | Not started | Needs a Linux host to verify |
| 3.21 | WSL | Commands, tools, git, MCP servers and hooks can run in a WSL distribution | Existing | `test/core.test.mjs`; benchmark behavior is changelog-only |
| 3.22 | GitHub pull request status pills | Not implemented | Not started | Needs a GitHub token to verify |
| 3.23 | Models: one vendor's list plus a few others | Any provider: Anthropic, OpenAI, ChatGPT plan, Gemini, xAI, Groq, Mistral, DeepSeek, OpenCode, OpenRouter, Together, Fireworks, Cerebras, Moonshot, Z.ai, Qwen, Ollama, LM Studio and any OpenAI-compatible server. Keys are encrypted with Windows DPAPI. | Existing, beyond the benchmark | `test/providers.test.mjs` |
| 3.24 | `/goal`, `/compact`, search | Present | Existing | `test/engine.test.mjs`, `test/features.test.mjs` |
| 3.25 | Multi-agent orchestrators (`/boost`, `/swarm`, `/teamwork`, `/run-workflow`), Remote Control, Remote Agents, Marketplace, voice | Not implemented | Not started | Several depend on the vendor's cloud |
| 3.26 | Windows 10 and ARM64 builds | x64 installer only | Not started | Tracked separately; no ARM64 or Windows 10 machine to verify on |

## 4. Verification that is still open

| What | Why it is open | Command to run |
|---|---|---|
| The same three benchmark tasks on the Antigravity App | No Antigravity account or install on the test machine | Run the three tasks in `e2e/lib.mjs` (`SCENARIOS`) by hand on both products and record them here |
| A real model provider through a run | The end-to-end tests use the deterministic fixture. A ChatGPT-plan model was reachable from this machine, but a full run with it was not recorded. | Start ORBIX, connect a provider, start a run on a fixture repository |
| Install, complete the workflow, uninstall on a clean Windows 11 | No clean Windows environment; the developer machine already has ORBIX installed | `npm run dist`, then run `dist\ORBIX-Setup-<version>.exe` on a clean machine, `npm run e2e`, uninstall from Settings > Apps |
| Full Runs workflow in the packaged Electron window | Automated Home and conversation checks pass in the packaged app; the restart and apply suite still runs in a standalone Chromium window. | `node e2e/conversation.mjs --desktop` for packaged Home/conversation; `node e2e/run.mjs` for the Runs suite |

## 5. Commands

```
npm test          # unit and integration tests (node --test)
npm run e2e       # the workflow through the interface, using a standalone Chromium window
npm run dist      # Windows installer: dist\ORBIX-Setup-<version>.exe
node e2e/conversation.mjs --desktop  # Home and conversation in dist\win-unpacked\ORBIX.exe
```
