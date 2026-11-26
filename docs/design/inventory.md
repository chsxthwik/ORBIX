# ORBIX UI inventory

Built from the code only: `web/index.html`, `web/js/*`, `web/css/*`, `e2e/*.mjs`, `test/*.mjs`.

Snapshot: commit 93123f3 ("Interface redesign…") plus uncommitted CSS edits in app, composer, finish, graphite,
parallel, runs, shell, sidebar, ui and workspace `.css`. Those edits are mostly pixel values replaced by spacing tokens.
No JS under `web/` differs from HEAD.

**Legend.** **(tested)** means an e2e script (`e2e/*.mjs`) or a unit test (`test/*.mjs`) queries the hook.
**(src-test)** means a unit test regex-matches the source file instead of the DOM. **(absent-test)** means a test
asserts the hook is *not* present.

## Page skeleton (`web/index.html`)

`header#chrome.chrome` > `.chrome-row` (tested) > `#menubar.menubar` (tested) + `#topbar.toolbar` (tested); `#tabstrip.tabstrip[role=tablist]` (hidden unless `S.ui.topTabs`).
`#app.app` (tested) > `aside#sidebar` (tested), `#rs-side.resizer[role=separator]`, `main.main` > `section#welcome` (tested), `section#session` (tested), `section#runs` (tested); `#rs-panel.resizer`, `aside#panel` (tested).
Overlays: `#banner[role=status]` (connection banner, `setBanner` in main.js), `#modal-root`, `#toasts[aria-live=polite]`.
Layout classes on `#app`: `side-rail` (tested), `no-side`, `no-panel` (tested), `overlay-side`, `overlay-panel` (panel and sidebar float when the window is 1100px / 760px wide or less), `panel-max`. They are set in `applyPrefs()`, `toggleSidebar()` and `togglePanelMax()` in main.js.

---

## 1. Menu row (window chrome)
- **What:** One 40px row. On the left, the mark and menus. In the middle, the breadcrumb. On the right, the context meter, MCP/skills/rules, the panel switches and the update pill.
- **Render:** `drawMenubar(el)` and `drawToolbar(el)` in `shell.js` (called through `drawTop()` in main.js). `tickToolbar()` runs once a second.
- **Menus:** `nav.mb-row[aria-label=Menu]` > `button.mb-it[aria-haspopup=menu]` (tested). The brand button is `.mb-it.mb-brand[aria-label=ORBIX]` with `logo(18,{alive:true})`, whose halves are `.lg-h.lg-l` / `.lg-h.lg-r` (tested; src-test in logo.test). Menus are ORBIX, Workspace, View and Window. A menu opens as `.menu[role=menu]` from `popMenu`. The open trigger gets `.open`.
  - States: closed / open; hover-to-switch while one is open; Left and Right move between them. At 1000px or less, all menus fold into the ORBIX menu under section headers.
- **Toolbar lead (`.tb-lead`):** `.tb-side` sidebar toggle (tested, `.on` when shown); `.tb-nav` Back/Forward (tested, `disabled` when there is no history); `.tb-search` (opens the palette).
- **Breadcrumb (`.crumbs`):**
  - In a conversation: `button.crumb.crumb-proj[aria-haspopup=menu]` (project tile + name), `.crumb-sep`, `.crumb.cur` (tested; double-click renames), `.tb-more` (tested; conversation actions, `sessionMenu()` in session.js).
  - `.crumb-st.run|wait|dead` with a `.dot` and `[data-tick]` showing "Working 12s", "Needs your OK" or "Ended".
  - `button.crumb-br` (branch + changed-file count `b.num`) opens Changes or Review.
  - Hub: `.crumb.static` "Customize / <tab>" or "Runs". Home: project crumb + "New conversation".
- **Machine chip:** `.tb-machine` (only when the window shows ORBIX Cloud).
- **Search / command trigger:** `.tb-search` and the sidebar's `.side-search-btn` open `palette()` (dialogs.js). It is a modal with `.palette` (tested), `input[role=combobox]` (`.palette input` tested), `.pal-scopes[role=tablist]`, `.pal-list[role=listbox]` > `.list-it[role=option]`, `.pal-foot`, `.pal-busy`, and error `.pal-err`.
- **Windows caption buttons:** These are not DOM. Electron draws them natively (`bridge.setTitleBar(bg, fg, height)` in desktop.js, which follows `.chrome` bg / `--fg-2` / `--mb-h`). desktop.css reserves room with `--wco` (`env(titlebar-area-*)`). `.chrome-row` is `app-region: drag`; controls in it are `no-drag`.
- **Toolbar busy state:** `#topbar.busy` while the agent streams.

## 2. Sidebar, full mode
- **What:** 260px by default (drag range 220–360). From top to bottom: New conversation, Search, the Runs and Customize links, Pinned, Projects, Running dock, This week, footer.
- **Render:** `drawSidebar()` in main.js. It is rebuilt only when `sidebarSig()` changes. Helpers: `sessionRow`, `pinnedList`, `runningList`, `weekLine`, `footStatus`, `projectMenu`, `rowMenu`.
- **Hooks:**
  - `.side-new` (`.cur` + `aria-current=page` on Home). `nav.side-nav[aria-label=Main]` (tested) > `.side-link` (tested), including `.side-search-btn`. Labels are `.side-l` (tested).
  - Shortcut hints are `.khint.num` via `keyHint()` (src-test: the only way shortcuts appear in the sidebar; no `kbd`).
  - `.side-scroll` (tested; roving tabindex with `[data-rove]` and `[tabindex]`, tested). `.side-h` section heads, `.side-h-acts` holding `.side-filter-btn` (`.on` when filtered, sorted or showing archived) and "Open a project folder".
  - `.side-search` > `input[type=search][aria-label="Filter conversations"]`.
- **States:**
  - Filter open or closed; sort by recent or name; show archived.
  - Empty: `.side-empty` says "No projects yet · Open a folder", or "No conversations match."
  - Narrow (760px or less): an overlay that closes on an outside click.
- **Resizer `#rs-side`:** `.drag` while dragging; `aria-valuenow/min/max`. Dragging snaps to the rail, then closes. Esc cancels the drag; double-click or Enter resets the width.

## 3. Sidebar, rail mode (Ctrl+B / F7)
- **What:** A 56px icon column. `toggleSidebar()` alternates full ↔ rail; a closed sidebar opens full.
- **Hooks:** `#app.side-rail` (tested, conversation.mjs and ui-stress.mjs). `S.ui.sideRail` stores it.
- **CSS (`sidebar.css` only):**
  - These are hidden: `.side-l`, `.khint`, `.side-h`, `.side-week`, `.side-dock`, `.pin-sec`, project rows, `.proj-name`, `.proj-meta`, `.row-acts` and `.foot-status .fs-t`.
  - Buttons become 40×40.
  - Status dot as an `::after` corner dot: on `.side-link:has(.side-count)` and on `.proj-btn[data-state=warn|run|unread]`. It uses `--working` for run and `--fg` for unread; forced-colors uses `Highlight`.

## 4. Running dock
- **What:** Agents at work, waiting on you, or on their own branch. It sits above the footer so the list never shifts.
- **Render:** `runningList()` in main.js. It is hidden when `S.ui.sidebarRunning === false` (`showRunningSection`, prefs-extra.js). `boardState()` comes from review.js. A 1s interval updates `.run-st` / `.run-now`.
- **Hooks:**
  - `.run-sec.side-dock` > `.side-h` "Running", then `button.run-row[data-id]` (`.cur`, `.has-branch`).
  - Start marker: `dotGrid('run-live')` while working, otherwise `.dot.warn` or `.dot.ok`.
  - `.run-m` > `.ell` name, `.run-br` branch (parallel.css), `.run-now` ("Waiting for your OK", the current step, "Ready to review", "Idle").
  - `.run-st.num` (`.you` = Needs you, `.idle`, otherwise elapsed time; "Done · 12s", "Merged", "Kept").
- **States:** absent when there are no live tabs; working; needs you; done / merged / kept.

## 5. Needs-you badge / counts
- `.side-count.num` on Customize = `reviewCount()` from runs.js, the number waiting for you (tested: `#sidebar .side-count` = 1 in run.mjs). On Runs it is `.side-count.quiet` = `workingCount()`. Both carry `aria-label` "N waiting for you" / "N working".
- Row-level: a `.dot.warn` from `stateDot()` plus `span.s-you` "Needs you" in conversation rows; `.run-st.you` in the dock; `.crumb-st.wait` in the toolbar; `.proj-btn[data-state=warn]` on the rail.
- Customize tab strip: `.cust-tab[data-view=review] .cust-n.num[aria-label="N waiting for you"]`, kept in sync by `syncBadges()` in customize-tabs.js.
- Home: `.home-alerts` > `.home-alert.wait|.run` (`.home-alert-t`, `-p`, `-s`).
- Window title: "(N) Needs your OK · ORBIX" (`syncTitle()`). Taskbar: an amber dot and a paused bar (`win.progress`, desktop.js).

## 6. Project tiles
- **What:** A colour-coded letter tile per project. The colour is deterministic (`tile.mjs`: `tileIndex`, `tileLetter`, `TILE_COUNT` = 8; src-test in sidebar-ui.test).
- **Render:** `projTile(name, size, cls)` in dom.js creates `span.ptile[aria-hidden]`. Used in the sidebar `.proj-mark`, the toolbar `.crumb-proj` and Home.
- **Project row:**
  - `.proj` > `.proj-head` (tested) > `button.proj-btn[aria-expanded][data-state]` (tested), containing `.proj-mark` (tile + `.chev`), `.proj-name`, and `.proj-meta` (`.proj-live` dot grid + count, `.proj-br` branch chip).
  - `.row-acts` (tested; New here, More) shows on hover/focus. Its buttons have `tabindex=-1`.
  - The More button and right-click open the project menu, `projectPopover()` in project.js.
- **Styles:** `ui.css` (`.ptile`, a Graphite override, forced-colors).

## 7. Sessions list
- **Render:** `sessionRow(s, where)` in main.js. Unsaved open tabs use a separate inline row with "new".
- **Hooks:**
  - `.s-row` (tested) with `.cur`, `.live`, `.unread` and `.archived` (tested). `button.s-btn[data-path][aria-current]` (tested) contains `.dot.warn|unread`, `.s-br` (branch icon), `.s-agent` (CLI agent mark), `.ell.grow` title, then `dotGrid('s-live')` / `.s-you` / `.s-where` / `.s-when.num`.
  - `.row-acts` holds pin (`.on`), archive and more.
  - `.pin-sec` "Pinned". `.s-more[aria-expanded]` "Show N more" (8 shown by default).
  - `.s-none` (tested): "No conversations yet · Start one" / "All pinned".
- **Hover card:** `bindHoverCards()` in shell.js shows `.hcard[role=tooltip]` (`.hc-t`, `.hc-l`, `.hc-st`, `.hc-p`) after 450ms.
- **Keys:** F2 rename, P pin, A archive, Del delete, Shift+F10 / ContextMenu opens the menu, arrows / Home / End move. Double-click renames.

## 8. Sidebar footer
- **This week:** `weekLine()` renders `button.side-week[aria-haspopup=dialog]` ("52k tokens this week"). It opens `popover(... {cls:'wk-pop'})` containing `weekChart()`: `.wk` > `.wk-h`, `ol.wk-cols` > `li.wk-col[tabindex=0]` (`.wk-track` > `i.today`, `--v`), `.wk-f`, `.wk-more`. It is absent when there is no analytics data.
- **Footer:** `.side-foot` > `button.side-link.foot-set` (Settings, opens `settingsDialog()`) and `footStatus()`, which renders `button.foot-status.ok|warn|err` > `.dot` + `.fs-t`.
- **Status states:** "Offline" (err), "Sign in again" (warn), "N providers ready" (ok), "No model connected" (warn). Clicking opens Settings → Providers.

## 9. Side panel and its tabs
- **What:** Panel tabs for the open conversation, or on Home for the chosen project. It is closed until opened.
- **Render:** `mountPanel()` and `draw()` / `drawTabs()` in panels.js. Opened with `showTab(name)` or `togglePanel()` (main.js). Tabs are moved with `stepPanelTab()`.
- **Hooks:**
  - `aside#panel[aria-label="Side panel"]` > `.ptabs[role=tablist]` > `.ptab-w(.cur)` > `.ptab[role=tab][aria-selected]` (`.ptabs .ptab` tested) with `.lbl`, `.badge.num` (Changes count, Tasks count, Review count) and `.ptab-x` close button. `.ptab-new` is the "+" button. Body is `.pbody`.
  - Inner layout: `.p-bar`, `.p-scroll`.
  - Toolbar `.tb-panel` (tested, `.on`) and `.tb-max` (`.on`; panel across the window).
- **Tab keys (`ALL_TABS`):**
  - `review` (only for worktree tabs), `changes`, `files`, `console` (Terminal), `browser`, `todos` (Tasks), `run` (Inspect), `ask` (Side question), `context`, `new` (New tab).
  - Home allows only changes, files, console, browser and new. The defaults are changes, files, console and browser.
- **Launcher ("New tab" page):** `drawNew()` renders `.nt-list[role=list][aria-label="Open a surface"]` > `.nt-group` > `.nt-h`, and `.nt-it(.off)[aria-disabled][aria-keyshortcuts][aria-description]` with `.nt-l`, `.nt-note` / `.nt-why`, `.nt-n`. `openSurface(id)` from shortcuts shows a toast when a surface is unavailable.
- **Per-tab hooks:**
  - **Files:** `drawFiles` renders `.tree` > `.tree-row[aria-expanded]`. The viewer is `drawViewer`: `.p-img`, `.p-note`, `.empty`.
  - **Terminal:** `drawTerminal()` in terminal.js.
  - **Browser:** `drawBrowser` renders `.br-bar`, `.br-url[placeholder="Search or enter a URL"]`, `.br-chip.incog`, `.br-view` / `webview` (`#panel webview` tested), `.br-load`, `.br-err`, `.br-list`.
  - **Context:** `drawContext`/`fillContext` render `.ctx-page`, `.ctx-grid` > `.ctx-cell(.wide)`, `.ctx-sys`, `.ctx-prompt`, `.ctx-acts`.
  - **Tasks:** `drawTodos` renders `.p-sec`, `.p-sec.agents`, `.p-sec-h`, plus `todoList()` and `agentRow()` from tools.js.
  - **Side question:** `drawAsk` renders `.ask-log`, `.ask-qa` > `.ask-q` / `.ask-a` / `.ask-err`, and `.pending` (all tested under `#panel`). Input is `.ask-in`.
  - **Review:** `drawReview()` in review.js renders `.rv-base`, `.rv-note(.rv-conflict)`, `.rv-actions`, `.gitem`, `.gfile`.
  - **Inspect:** `runInspector()` in run-inspector.js.
- **States:** closed / docked / overlay (1100px or less) / maximized. Each tab has loading (`skeleton`), error (`errorState`) and empty (`.empty`) states.
- **Resizer:** `#rs-panel`, 280–720px, reset to 380.

## 10. Changes panel and commit box (exists)
- **Render:** `drawChanges(t)` in panels.js.
- **Hooks:**
  - `.list-h.gh` with Stage all / Unstage all.
  - `.gitem(.open)` > `.gfile[aria-expanded]` with a `.gs.<letter>` status letter, `.gstat.num` (`.add`, `.del`), `.gact`, and the diff in `.gdiff`.
  - `.commit-box` > `textarea.commit-msg[aria-label="Commit message"]`, `.commit-row` (Commit, `btn.primary.sm` "Commit & push"), `.commit-hint`.
  - After shipping: `.ship[role=status]` > `.ship-line`, `.ship-link` (PR link), `.ship-err` + "Push again".
- **States:**
  - "Not a Git repository" + Initialize Git.
  - "Git is not installed…".
  - "Couldn't read the changes." (error).
  - "No changes yet." (`.empty` + `.empty-ic`).
  - Committing (busy).
  - Committed / pushed / push failed.

## 11. Toolbar right group and context popover
- **Group:** `.tb-end` holds the context meter, `.tb-cx`, `.tb-max` and `.tb-panel`, followed by the `updatePill`. It exists only with a conversation, or on Home with a project.
- **Context meter:** `button.tb-ctx[aria-haspopup=dialog][aria-expanded]` (tested) contains an SVG ring (`.ring-track`, `.ring-arc` with stroke-dasharray) and a `.num` label ("38k · 19%" or "Context").
  - Classes: `.hot` at 80% or more, `.crit` at 95% or more (both tested; `contextLevel()` in context-popover.js).
  - Hidden with no tab, or when the tab is dead.
- **Context popover:** `openContextBudget()` in context-popover.js renders `popover` with `.menu.pop-panel.ctx-popover` (tested). Inside: `.ctx-pop-title`, `.ctx-pop-total`, `.ctx-bar.hot|crit[role=meter]` (`--p`), `.ctx-pop-list` (tested), `.ctx-pop-cost` (tested), `.ctx-pop-outcome[role=status]` (tested), `.ctx-pop-actions` ("Compact now", tested via button text). Loading uses `skeleton`; errors use `errorState`.
- **MCP / skills / rules menu:** `.tb-cx` opens `contextMenu()` in context.js, which uses `cascade()` with cls `ctx-pop`. It has submenus for Context (runtime), MCP, Skills and Rules.
  - Hooks: `.xm-rows[role=menu]` > `.xm-it[role=menuitem][aria-haspopup][aria-expanded]`, plus `.xm-sub`, `.xm-n.num`, `.xm-dot.<state>`, `.xm-spin`, `.xm-wait`, `.xm-head` and `.left` (flip). There is no separate MCP/skills/rules button group.

## 12. Conversation timeline (turn map)
- **What:** One dot per user turn, 24px outside the reading column's left edge.
- **Render:** `class Timeline` in timeline.js, plus helpers in `timeline-text.mjs` (`MIN_WINDOW` = 1100, `TIP_CHARS` = 60, `firstLine`, `dotLabel`; unit-tested).
- **Hooks:** `.turn-map` (tested; at most 250px tall) > `.tm-track` > `button.turn-mark[aria-label][aria-current]` (tested), with `.seen` on screen (tested). `.tm-tip.on` (tested). The jump target flashes `.msg.user.tl-flash` (tested).
  - Old hooks `.tl-track` and `.session-inner > .tl` are absent-test.
  - src-test checks: IntersectionObserver, no scroll listener, aria-label, and prefers-reduced-motion.
- **States:** hidden under 1100px or on coarse pointers; current / seen / idle; hover or focus grows the dot; tip on/off. Motion is still under `.sr`, `prefers-reduced-motion`, or `data-motion=off`.

## 13. Messages (transcript)
- **Render:** `class TabView` in session.js. `build()`, `renderMessage`, `renderUser`, `renderAssistant`, `renderBlock`, `thinkBlock`, `toolCard`, `foldTurn` / `liveFold`, `refreshSummary`, `updateApproval`, `updatePending`, `updateEmpty`. Markdown comes from markdown.js; tool rows from tools.js `renderToolCard`.
- **Container:**
  - `#session .session-inner` (tested), prefixed by the `SessionBar` from workbench.js: `.sbar-wrap`, find row `.sfind` > `.sfind-q[placeholder="Find in conversation"]` + `.sfind-n`.
  - `.transcript[role=log][aria-label=Conversation]` > `.tin` (tested). `button.jump` "Latest" (hidden until you scroll up). `.drop-hint`; drag-over sets `.drop` on the root.
- **User bubble:** `.msg.user` (tested) > `.bubble(.clamp)` > `.b-text`, `.b-files`, `.imgs`, and `.b-more[aria-expanded]` ("Show all" on long messages).
- **Assistant text:** `.msg.asst(.cont)(.live.typing.enter)` (tested) > `.md` (tested). Thinking is `details.think(.live)[data-key]` > `.think-l` ("Thinking" / "Thought"), `.think-p`, `.think-b`. Images are `.tool-img`.
- **Tool rows:** `.tool.<status>(.open)[data-id][data-tool]` (tested) > `.tool-head[aria-expanded]` (`.static` = not foldable) with `.tool-ico`, `.tool-name`, `.tool-sum(.plain)`, `.tool-dur`, `.tool-exit`. Body is `.tool-body`; `.undo-row`. Shell runs reuse `.tool.done.open`.
- **"Worked for" folds:**
  - Live: `details.work.live[data-key]` (tested) > `summary.work-h` > `.chev`, `.work-l` "Working", `.work-t`.
  - Done: `details.work[data-key]` (tested) with `.work-l` "Worked for 14s" (tested) and `.work-facts` (tested) > `.ts-fact(.bad)`. Body is `.work-b`.
  - The fold is open by default only under Verbose steps or screen-reader mode.
- **Turn summary:** `.turn-sum` (tested) > `.ts-head` (count, `.ts-stat`, Review, "Undo all"), `.ts-files` > `button.ts-file`, `.ts-more`.
- **Pending line:** `.pending[role=status]` > ASCII spinner (`canvas.ascii-orbit`, tested), `.pending-l`, `.pending-o`, `.pending-t`.
- **Approval card:** `.approval[role=alertdialog]` (tested) > `.ap-h` (`.ap-ico`, `.ap-q`), `pre.ap-d`, `.ap-acts` > `.btn.sm.primary|ghost` with `kbd` (`.approval .btn.primary` tested). Keys 1–9 pick; Esc denies.
- **Code blocks:** `codeBlock()` in markdown.js renders `.codeblock` > `.code-head` (`.code-lang`, `.code-n`, `.code-acts` > `.code-btn`) + `.code`. Inline code is `.ic`.
- **Tables:** `.table-wrap > table` (transcript.css: hairlines, no fill).
- **Other rows:** `.note(.goal|.warn|.error)`, `.cmd-echo`, `.cmd-out`, `details.fold` (compaction or branch summary), check cards (`checkCard()`), and the error box `errorState()`: `.errbox[role=alert]` > `.err-main`, `.err-title`, `.err-msg`, `.err-hint`, `.err-acts` > `.err-retry.retry`.
- **Message actions:** `.msg-acts`. User messages get `.msg-act.copy`, `time.msg-time[data-ts]`, Edit and Branch. Assistant messages get `.msg-act.copy`, `.msg-act.rate[aria-label="Good reply"|"Bad reply"][aria-pressed]` (tested), `.msg-act.retry` (only on the latest reply while idle), `time.msg-time` and `.msg-model.num`.
  - **Hover-only:** everything except `.copy` is `opacity: 0` until `.msg:hover` / `:focus-within` (transcript.css).
- **Empty conversation:** `.chat-empty` > `.empty-mark` (logo 48), `h2.ce-name` "Where should we pick up?", `.ce-tasks-slot` (`sessionTasks()` from workspace.js).

## 14. Composer and chips
- **Render:** `class Composer` in composer.js (shared). The session row is assembled in `TabView.build()`. Chips come from controls.js: `addContext`, `modelLabel`, `effortChip` and `permissionChip`.
- **Box:** `.composer(.busy)(.shell)(.has-att)(.drop)` > `.popup[role=listbox]` (`/` and `@`; `.pop-it.sel`, `.pop-h`, `.pop-empty`, `.pop-skel`), `.attach[aria-label=Attachments]` > `.att.thumb|.att.file` (`.att-x`), `.c-mode` ("Shell command" when the text starts with `!`), `textarea.c-ta[aria-autocomplete=list][aria-expanded]` (`#session textarea` tested).
- **Row:** `.c-row`, left to right:
  - `.c-add` (+, `aria-haspopup=menu`): Images and files, Commands `/`, Context `@`, Shell command `!`.
  - Model chip `.cbtn[aria-haspopup=dialog]` with `modelLabel()`: `.pv-mark`, `.c-pv`, `.c-sl`, `.c-mn`, `.cbtn-chev`.
  - Effort chip: see below.
  - Plan `.cbtn.plan(.on)[aria-pressed]` ("Plan" / "Plan mode"; hidden if the agent has no `planMode`).
  - `.grow` spacer.
  - Permission chip: see below.
  - `button.send[data-mode=send|stop](.stop)` (`.send` tested in viewport.mjs). It is disabled when there is nothing to send or the tab is dead. Its `aria-label` is Send / Steer / Queue message / Stop the agent.
- **Effort chip (`effortChip` in controls.js):** `button.cbtn.c-effort[aria-haspopup=dialog][aria-label="Reasoning: X"]`.
  - It shows the level name, or `span.c-bars > i(.on)` bars when `S.ui.effortDisplay === 'bars'` (prefs.css).
  - Hidden when the model has no levels.
  - Popover `.rs-pop`: `.rs-head` (`.rs-dots`, `.rs-name`), `.rs-model`, `.rs-track[role=slider][aria-valuenow/text]` (`.drag`) containing `canvas.rs-field` (dot field, a still frame under reduced motion or `.no-motion`) and `.rs-thumb`, `.rs-ticks` > `.rs-tick(.on)`, `.rs-note`.
  - Not queried by any e2e or test.
- **Permission chip:** `button.cbtn.c-perm(.risky)[aria-haspopup=dialog]` shows the mode icon and name: Supervised, Auto edits, Guarded or Full access. Full access adds an alert icon and asks for confirmation.
  - Popover `.perm-pop`: `.perm-h`, `.perm-seg[role=radiogroup]` > `.perm-opt(.risky)[role=radio][data-k][aria-checked]`, `.perm-info` (`.perm-t`, `.perm-d`).
- **Below the box:** queue chips `.queue > .q-chip` (Steer / Next) and the status line `.c-status[aria-live=polite]` (Compacting…, Retrying…, tok/s).
- **Workspace / folder chip:** not in the session composer; the folder is the toolbar crumb. On Home it is `.home-box-h` chips (see 16).
- **States:** idle / busy (placeholder "Add guidance…" or "Queue a follow-up…") / dead (disabled, "This conversation has ended") / shell mode / attachments / drop target / popup open.

## 15. Model picker
- **Render:** `modelPicker({...anchor})` in dialogs.js, a modal with cls `model-picker(.anchored)` (tested). Opened by `TabView.pickModel()` and Home's `.home-model-pick` (tested).
- **Hooks:**
  - `.mp-layout` > `.mp-rail` > `.mp-pv` (tested; `.mp-default`, `.mp-add`, `.mp-rail-sep`).
  - `.mp-main` > `.mp-search` (`input[role=combobox]`, tested via `.model-picker input[role=combobox]`).
  - `.mp-results` > `.list.mp-list[role=listbox]` (tested) > `.list-it.mp-it[role=option]` (tested) with `.mp-name`, `.mp-ctx`, `.mp-star`, `.mp-key`.
  - `.mp-side` (`.mp-side-h`, `.mp-side-none`; adds `.with-side` to the picker), `.mp-levels[role=group]` > `.mp-lvl[aria-pressed]`, `.mp-footer` (tested), `.mp-empty`.
- **States:** loading (`aria-busy`), empty, flipped upward (`.up`), anchored vs centred.

## 16. Home screen
- **Render:** `drawHome(root, H)` in home.js, plus `shell()`, `deck()`, `drawHead`, `drawSuggestions`, `drawProjectStatus`, `drawRecent` and `updateStart`. The composer stays mounted across redraws.
- **Hero:** `.home` (`.first` = setup-only first run) > `section.home-hero` > `.home-mark` (logo 48) + `header.home-head` > `h1.home-title` ("Where should we pick up?" / "Open a project folder" / "Connect a model") + `.home-sub`.
- **Dock:** `section.home-dock[aria-label="New task"]`, containing:
  - `.home-alerts` (needs you / working).
  - `.home-steps-slot` > `.home-steps` > `.home-step` (`-n`, `-b`): first-run setup.
  - `.home-under` > suggestions `.ws-recipes[role=group]` (`taskButtons()` in workspace.js).
  - `.home-deck` > `.home-box` > `.home-box-h` chips: `.hb-btn.proj-pick` (project) and `.cbtn.branch-pick` (worktree toggle from `branchToggle()` in review.js; tested).
  - `.composer.home-composer` (tested) with its `.c-row`: `.c-add`, `.cbtn.home-model-pick` (tested), effort chip, `.cbtn.plan-pick[aria-pressed]`, permission chip, `button.send.start(.text)` (label Start / Open folder / Connect a model / Starting…).
  - `.home-status-slot` > `.home-status[role=status]` (tested: `#welcome .home-status`, "Refresh working tree") with `-summary` and `-details`.
  - `.home-recent-slot` > `.home-recent` > `.hr-group` > `.hr-h`, `.hr-row`, `.hr-when`.
  - Connect: `.home-connect`, `.cx-list` > `.cx-row`, `.connect-acts`, `.connect-foot`, `.setup-note`. Empty: `.home-none`.
- **States:** first run / no model / no project / ready / starting (busy) / alerts present.

## 17. Runs and Review (hub, `#runs`)
- **Render:** `openHub(view,id)`, `closeHub`, `draw()`, `drawRuns()`, `drawReview()` and the run page in runs.js.
- **Runs:**
  - `.hub` > `.hub-head`, `.cz-search` > `.cz-q`.
  - `.run-new` (tested) with textarea (tested), "Plan first" / "Straight to work" and "Start run" (tested).
  - `.run-list` (tested) > `.run-group` (tested) > `.run-proj`, `.rrow` (tested) / `.rrow-main`, `.run-pill.you|live|err`.
  - Empty: `.empty` (tested).
- **Review queue:** `.rq` > `.rq-head` (tested), `.rq-item.ask|<status>` (tested) > `.rq-what`, `.run-title`, `.run-meta`, `.rq-acts`, `.rq-err`. Approval cards are `.ask-card` (tested).
- **Run page:** `.run-page` (tested) > `.run-back`, `.run-head` (`h1`, tested), `.run-tabs` > `.run-tab(.cur)` (tested) with `-n` / `-rev`, `.run-cols` > `.run-main` / `.run-side`, `.rsteps` (tested) > `.rstep-btn` (tested), `.run-body` (tested).
  - Artifacts: `.art-bar` (tested), `.art-doc` (tested), `.art-old` (tested), `.art-rev` (tested), `.cmt` (tested).
  - Changes: `.chg-file` / `.chg-diff` (tested). `.card-h` (tested).
  - Decision: `.run-decision` (tested) with `-row` / `-text`. Feedback: `.run-feedback` (tested) with `-row`. Segments: `.rseg` / `.rseg-btn`.
- **Modals:** approve plan, conflicts, "Some actions may not have finished", comment (all `modal` with `size:'md'`).

## 18. Customize: Plugins, Skills, Loops, Review
- **Tab strip:** `customizeTabs(current)` in customize-tabs.js renders `.cust-tabs[role=tablist]` (tested) > `.cust-tab[role=tab][data-view][aria-selected]` + `.cust-n`. The four views are plugins, skills, automations (Loops) and review.
- **Plugins:** `drawCustomizations()` in customize.js renders `.hub.cz` > `.cz-head`, `.cz-tabs` > `button[data-t][aria-pressed]` (tested: `data-t=installed`), `.cz-search`, `.cz-sec`, `.cz-grid` > `.cz-item` (tested) with `.cz-tile`, `.cz-item-t`, `.cz-added`; `.cz-none` (tested); `.cz-form`. `.cz-hero` is absent-test. MCP output is `.mcp-out` (tested; mcp.js).
- **Skills:** `drawSkills()` in skills.js renders `.au-list.sk-list` > `.au-item.sk-item` (tested), `.sk-group`, `.sk-proj`, `.sk-search`/`.sk-q`, `.au-form.sk-form`, `.au-new`.
- **Loops:** `drawAutomations()` in automations.js renders `.hub-head.au-head`, `.au-new` (tested), `.au-list` > `.au-item` (tested) > `.au-main`, `.au-title`, `.au-meta`, `.au-acts`, `.run-pill.live|err`; `.au-form` (textarea tested), `.au-ask`, `.au-note`. Empty: `.empty`.
- **States:** loading, empty, error (`errorState`), form open.

## 19. Settings
- **Render:** `openSettings(initial, focus)` in settings.js, a full-window modal with cls `settings settings-card` (tested). In the desktop app it starts below the title bar.
- **Hooks:** `.set-wrap`, `.set-nav[role=tablist][aria-orientation]` (tested; "Back to app") > `.set-nav-g` > `button#set-<key>.set-tab(.cur)[role=tab]` (tested: `#set-general`, `#set-keys`, `.set-tab.cur`).
  - `.set-search` / `.set-search-in`; `.set-main` > `.set-head` (`.set-back`, `.set-crumb`, `h.set-title`, tested); `.set-pages[role=tabpanel]`.
  - Key recorder: `.kc-rec` (tested).
- **Pages:** general, look, notify, keys / engine, models, agents, tools, rules, checks / projects, worktrees, conversations, machines, browser / usage, feedback, application. Sub-pages: behavior and network ("Network access rules", tested via the palette).

## 20. Dialogs and modals (dialogs.js)
- **Base:** `modal({title, size, cls})` renders `.scrim` > `.modal(.sm|.md|.lg)(.<cls>)[role=dialog][aria-modal]` (tested) > `.modal-h`, `.modal-b`, `.modal-f`. Closing adds `.closing`.
- **Other dialog types:**
  - `confirmDialog` (`.prewrap`) and `promptDialog` (`.field`, `.field-err[role=alert]`, tested; `aria-invalid`).
  - `folderPicker` ("Choose a project folder"; `.fp-list`).
  - `syncExtDialogs` (extension select).
  - `.modal .scope` and `.modal .pending-calls` (tested; run approvals).
- **Menus and popovers:**
  - `popMenu` renders `.menu[role=menu]` (tested; `.menu:not(.leaving)`) > `.menu-it` / `.menu-h` / `.menu-sep` / `.menu-check[aria-checked]` / `.menu-hint` / `.menu-d`.
  - `popover` renders `.menu.pop-panel.<cls>[role=dialog]` (`.up` / `.down`).
  - `cascade` renders `.xm-*`.
- **Named modals:**
  - Connect (`connect-dlg`), Diagnostics (lg), Manage conversations (lg, cleanup.js), How ORBIX works (help.js).
  - Move to a machine, Add project script, Create with Prompt, Add <plugin>.
  - Feedback (`openFeedback`).

## 21. Toasts, banner, update pill
- **Toast:** `toast(msg, kind)` in dom.js renders `#toasts > .toast.info|ok|error|warn` (`role=alert` for errors, otherwise `status`). A repeated message adds `.bump` instead of stacking. It leaves via `leave()` (`.leaving`).
- **Banner:** `#banner[role=status]`, `setBanner()` in main.js (hidden when there is no message).
- **Update pill:** `updatePill` in updates.js renders `button.update-pill(.ready)` with `--p` progress. States: hidden / "Updating N%" (disabled) / "Restart to update" (`.ready`). Not tested.

## 22. Shared empty, loading and error states (dom.js)
- `loadingState()` renders `.loading-state[role=status]`. `skeleton()` renders `.skel > .skel-l`. `spinner()` renders `.spin`.
- `errorState()` renders `.errbox[role=alert]` (§13).
- `dotGrid()` renders `.dgrid[role=img]` > `i` (the working indicator; tested for animation off under reduced motion).
- Status dots: `.dot.ok|warn|run|unread|dead|err|idle` (ui.css).
- Per-surface empty states: `.side-empty`, `.s-none`, `.chat-empty`, `.home-none`, `#runs .empty`, `.cz-none`, the panel `.empty`, `.mp-empty`.
- Stale e2e hook: `#sidebar .sw-bars i` (ui-stress.mjs) matches nothing in the current JS or CSS. The check passes vacuously.

---

## CSS files, in the order `web/index.html` loads them
`theme-boot.js` runs first (sets `data-theme`, `data-mode` and `data-scene` from `localStorage['orbix.look']`).

1. `tokens.css`: type, spacing and motion tokens
2. `app.css`: base layer: controls, layout, views, theme previews `.tp-*`
3. `workspace.css`: workspace surfaces, focus rings
4. `home.css`: Home stack
5. `parallel.css`: Running dock and branch board
6. `desktop.css`: `html.desktop` (Windows app), title bar region, Mica
7. `finish.css`: flat "calm" finish layer
8. `scenes.css`: scene themes (orbix, sunset, nebula, aurora) and `.tp-<scene>`
9. `runs.css`: Runs, Review, run page
10. `shell.css`: menu row, toolbar, Dark/Light shell palettes (the comment says "loaded last", but it is 10th)
11. `themes.css`: Tokyo Night, Catppuccin, Rosé Pine, Nord, Dracula, Gruvbox
12. `sidebar.css`: sidebar and rail
13. `ui.css`: state colours, `.ptile`, `.btile`, Connect, Customize tabs, week chart
14. `transcript.css`: messages, hover actions, tables, empty chat, turn map
15. `composer.css`: message box
16. `graphite.css`: Graphite theme (a test requires it after shell.css and themes.css)
17. `prefs.css`: classes set by prefs-extra.js

## Where each theme or mode is defined

| Mode | Hook (set by) | CSS |
|---|---|---|
| Graphite theme | `html[data-theme=graphite]` (`applyPrefs` in main.js, theme-boot.js) | **graphite.css** (palette and overrides, plus `prefers-contrast: more`); `ui.css` (`--working`, `.ptile`, `.btile` grayscale); `app.css` `.tp-graphite` preview (src-test in themes.test) |
| Rail mode | `#app.side-rail` (`applyPrefs`, resizer; `S.ui.sideRail`) | **sidebar.css** only |
| High contrast | `prefers-contrast: more` | `app.css:88`, `graphite.css:74`, `workspace.css:96` (`not all and`) |
| | `forced-colors: active` | app (×5), desktop, finish, home, scenes, shell (×2), sidebar, ui (×2) |
| | `html.contrast-strong` (`applyLook`, `u.contrast==='strong'`) | **shell.css** (lines 407–408, dark and light) |
| | `html.win-hc` (desktop.js, Windows high contrast) | desktop.css |
| Text size | `--fs` (inline on `<html>` from `u.fontSize`, 12–18; `textSize()` in main.js) | default `--fs: 14px` in **shell.css:20**; used everywhere. Whole-UI zoom is `orbixDesktop.setZoom(u.uiScale)` (Electron, no CSS). Windows text scale goes through `win.textScale` |
| Wide reading column | `html.wide` / `html.col-narrow` / `html.col-fill` (`setColWidth`, `toggleWide` in workbench.js) | `app.css:1060` (`html.wide .session-inner --col:1140px`); **shell.css:409–410** (`col-narrow` 640px, `col-fill`); `transcript.css:39` (`html.wide .turn-map`) |
| Focus mode (zen) | `html.zen` (`toggleZen` in workbench.js) | `app.css:1063–1065`, `shell.css:118–119`, `desktop.css:28` |
| Reduced motion | `html.no-motion` (prefs-extra.js `applyExtraPrefs`, `u.motion==='off'`) | **prefs.css:32–33** |
| | `:root[data-motion=off]` | `shell.css:554`, `workspace.css:145`. **No JS ever sets `data-motion`**, so these rules are dead (only read in ascii.js and timeline.js) |
| | `prefers-reduced-motion: reduce` | app (×8), shell (×8), workspace (×3), transcript (×2), home, runs, ui |
| | `html.sr` (screen reader mode, `applyLook`) | shell.css (also stills the logo) |
| Mica | `html.win-mica` (desktop.js, when Windows reports Mica, `u.winMica!==false`, and no scene theme) | **desktop.css:22–28** |
| Other | `html.desktop`, `.win-accent` (adopted stylesheet), `.compact` / `[data-density]`, `.no-smooth`, `.wrap-code` | desktop.css; app / shell / sidebar / workspace; prefs.css |
