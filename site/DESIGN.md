# ORBIX website design

How every page of orbix-agent.vercel.app looks and why. Read this before changing the site. (Not deployed:
`.vercelignore` keeps it out.)

## Direction

A terminal-grade page: near-black ground, hairline grids, monospace for everything a machine says, and one signal
green for action and state. No pink or magenta anywhere: the site, the README banner, the social image and the
screenshots (taken in the app's monochrome Graphite theme with `node tools/shots.mjs --theme graphite`).

References, for the feel only (no layout, wording or asset is taken from them):

| Site | Taken for ORBIX |
| --- | --- |
| trae.ai | A living dot-matrix field behind the hero; one bright green |
| opencode.ai | Monospace headings and labels; hairline grid cells; plain, factual copy |
| ethiack.com | Console panels and logs as the visual language |
| linear.app, zed.dev | Quiet density, no illustration, fast pages |

## Rules

- **Type:** Geist Mono for headings of the hero and install block, labels, numbers, code, tabs and buttons. Google Sans
  Flex for reading (section titles, body, FAQ). Hero 38–76px, section title 28–44px, body 15–17px, labels 12–13px.
  ORBIX is always written in capitals.
- **Colour:** tokens only (`--bg`, `--surface`, `--raised`, `--fg`, `--fg-2`, `--fg-3`, `--line*`, `--accent*`).
  Green (`#3DF28C` dark, `#087A3F` light) is for the primary action, the current state and success; amber for "asks
  you"; red for deletions. Light and dark come from the same tokens; the footer switch sets `data-theme`.
- **Shape:** one container, the hairline grid (`.cells`): 1px lines between cells, a 10px outer radius, a green corner
  tick on hover. Buttons and chips 4–6px. No drop shadows on cards, no gradients except the hero's fade, no glows.
- **Sections:** numbered `01`–`12` in mono with a hairline rule (`.idx`). Long lists sit beside a sticky side title
  (`.sec-grid`).
- **Motion:** the hero's dot field (canvas, at most 30 fps, paused off screen and in hidden tabs), the kicker's
  blinking cursor, tab fade, menu open, FAQ height. With `prefers-reduced-motion` everything is still: one static
  field frame.
- **No fake demos:** no scripted terminals, typed-out sessions or invented output. Every picture is a real screen of
  the app (`node tools/shots.mjs --theme graphite`), framed by `tools/showcase.mjs` for the README, which also makes
  the README banner and the social image.
- **Content:** say what it does in plain sentences, with real names, shortcuts and numbers.
- **Community links:** the COM-X community first (Discord, Telegram, X, GitHub issues), then the founder (QUANTUM,
  founder and CEO: X and Linktree). Nothing else.

## Banned

Pink, magenta or purple; slogans made of period fragments ("Every agent. Every model."); chains of "·" separators in copy (write a sentence, use commas, or use separate rows); gradient washes; glowing buttons; serif headlines; badge pills above the headline beyond the
one kicker; orbit or blob decorations; icon-per-card bento; cursor spotlights; scroll progress bars; staggered
fade-ins; "not X, but Y" lines; emoji; made-up numbers or logos.

## Before shipping

1. At 375px: no horizontal scroll (tab rows and the agent strip scroll inside themselves), 16px gutters, buttons at
   least 40px tall, nothing clipped.
2. Hover and keyboard focus visible on every link and button; tabs work with the arrow keys.
3. Light and dark both readable (WCAG AA).
4. No inline styles or scripts (the CSP allows only `/assets`), no third-party requests, no personal data.
5. Bump `?v=` on any changed CSS, JS or image, then deploy from `site/`.
