# ORBIX desktop: DESIGN.md

The rules every ORBIX screen follows. Based on `main` at 813ddd0 (Graphite theme, logo-only menu row, rail sidebar, Mica on Windows 11).

## 1. References: what each one gets right

| # | Product | Layout | Type | Colour | Spacing | Take from it |
|---|---|---|---|---|---|---|
| 1 | Antigravity | Menu row, then sidebar plus a sheet set into the window | Light weight, sentence case | Three greys, no accent at rest | Very airy; empty state centred | Quiet empty state, chips on top of the composer |
| 2 | OpenCode desktop | Three nav rows, then sessions; rounded sheet inset 8px | 13px, regular | Near-black window, #1A1A1A sheet | Dense list, roomy transcript | Inset sheet, minimal composer (model plus variant) |
| 3 | Claude desktop | Sidebar, centred reading column | Readable body size, generous line height | Neutral, one warm accent | Wide margins | Reading column width, user turn as a pill |
| 4 | T3 Code | Threads per branch; diff beside the chat | Mono for files and counts | Green/red only in diffs | Compact file list | Commit & push with a generated PR, per-file +/- |
| 5 | Zed | Panels on a strict grid, status bar at the bottom | Mono-led UI | Monochrome, syntax is the colour | Tight 4px grid | Status bar, hairline grid, nothing floats |
| 6 | Warp | Blocks of command plus output | Mono, clear block headers | Dark, state colours only | Blocks separated by space, not boxes | Tool calls as compact log blocks |
| 7 | Linear | Inbox, list, detail | Medium weight titles, small meta | Grey, one purple accent | 8px grid, consistent row heights | Inbox of what needs you, keyboard-first |
| 8 | Raycast | One command field is the whole app | Large input text | Dark glass, minimal | Big targets | Ctrl K as the way to do anything |
| 9 | GitHub Desktop | Changes list, diff, commit box | Plain UI font | Neutral, green commit button | Fixed commit box at the bottom | Commit box that never moves |
| 10 | Windows 11 (Fluent) | Mica, caption buttons, snap layouts | Segoe UI Variable | System accent, high contrast | 40px title bar | Native caption buttons, Mica, high-contrast mode |

I drew these from the screenshots you sent (ORBIX, OpenCode, Antigravity) and from how these apps are known to look. I did not take fresh screenshots of them for this file.

## 2. Rules

- **Colour is state.** Blue means running, amber means it needs you, green means done, red means failed. There is one accent (Graphite ink, or Plasma #FF2E7E if chosen) and it appears only on: send/primary, focus, the current turn.
- **Three greys and hairlines:** window #0B0B0B, sheet #121212, raised #1A1A1A, lines at 7 / 11 / 19% white. No glows, no gradients, no coloured borders at rest.
- **Type:** Google Sans Flex (Segoe UI Variable fallback), Geist Mono for paths, counts and code. Body 14px, transcript 15px, meta 12–13px. Weight 400, headings 500. Sentence case.
- **Spacing:** 4px grid. Rows 30px, title bar 40px, sidebar 272px (220–360), reading column 680–760px.
- **Shape:** radius 6 (inputs, chips), 8 (rows), 12 (sheet, cards), 18 (composer). User turn is a pill.
- **Motion:** 120ms hover, 180ms panels, ease-out, no bounce. Spinners only for running work. Honour reduced motion.
- **Windows:** Mica on the sidebar (Windows 11) with a solid fallback, native caption buttons, snap layouts, taskbar progress, high contrast.

## 3. AI-look ban (fail any one, start over)

No Inter. No purple-to-blue gradients. No glowing buttons or halos. No serif headline with one italic word. No row of four stat cards. No three identical feature cards. No emoji as icons. No gradient text. No glassmorphism stacked on glassmorphism. No uppercase letter-spaced section labels in the Graphite direction.

Also banned, because they are the quieter tells:
- **Middle-dot chains** ("glm-5.3 · Low · 4.2s · 24m ago"). Show one fact; the rest goes in a tooltip.
- **Shortcut confetti.** A key hint appears in menus, tooltips and Ctrl K, not on every button.
- **Boxes inside boxes.** The sheet, tables and chips don't each get a border; use one surface step or one hairline.
- **The same state said three times** (dot, badge and card). One signal per state, where you look for it.
- **Filler subtitles** that explain the UI ("Every run works in its own git worktree").
- **Suggested next-step chips** under every answer, and invented progress ("Step 4 of 7") the engine doesn't report.
- **Controls nobody asked for in the composer.** It has attach, model, permission and send; everything else lives behind + or /.

## 4. Checks before anything is called done

Every screen at 1280×800 and 2560×1440, at 100 / 125 / 150% Windows scale, in Dark, Light and Graphite. Keyboard only. Contrast 4.5:1 for text. Minimum window width 800px (ORBIX is a desktop app; 375px phone width does not apply).
