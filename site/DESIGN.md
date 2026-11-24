# ORBIX website design

How every page of orbix-agent.vercel.app looks and why. Read this before changing the site. (Not deployed:
`.vercelignore` keeps it out.)

## Direction

A calm, editorial product page: near-black ground, large confident sans-serif type, real screens of the app at the
centre of every claim, and one signal green for action and state. No pink or magenta anywhere: the site, the README
banner, the social image and the screenshots.

References, for the feel only (no layout, wording or asset is taken from them):

| Site | Taken for ORBIX |
| --- | --- |
| trae.ai | A living dot-matrix field behind the hero; one bright green |
| opencode.ai | Plain, factual copy next to real product surfaces |
| linear.app | One claim per section, proven by the product itself |
| linear.app, zed.dev | Quiet density, no illustration, fast pages |

## Rules

- **Story:** the page reads top to bottom as one argument. Hero (one sentence and the product), the agents it runs,
  four stories (Conversations, Runs, Review, Loops) that each pair one claim with the real screen that proves it,
  permissions you can try, models, the rest of the toolkit as a spec list, privacy, install, FAQ, community. Reference
  material (every release, every setting) lives in the README and the changelog, not here.
- **Type:** Google Sans Flex for everything people read: display 44–84px at weight 600 and -0.045em, section titles
  32–48px, lead 18–20px, body 17px, small 15px, labels 13–14px. Geist Mono only for code, keys and commands. ORBIX is
  always written in capitals.
- **Space:** an 8px scale (`--s1`…`--s9`), sections `--sec` apart (80–144px), a 1200px column with 16–40px gutters.
- **Colour:** tokens only (`--bg`, `--surface`, `--raised`, `--fg*`, `--line*`, `--accent*`). Green (`#3DF28C` dark,
  `#087A3F` light) for the main action, the current state and success; amber for "asks you". Light and dark come from
  the same tokens; the footer switch sets `data-theme`.
- **Shape:** pill buttons and chips; 14px frames around screenshots with one soft shadow; hairlines instead of boxes
  for lists (spec list, FAQ, ledger). No cards inside cards, no gradients except the dot field, no glows.
- **Screens:** real screens of the app in the monochrome Graphite theme (`node tools/shots.mjs --theme graphite`),
  sharp 2x captures. `tools/showcase.mjs` cuts each story's picture from them (the reply, the diff, the queue, the
  loop list), frames the README's screens, and makes the README banner and the social image.
- **Motion:** the hero's dot field (canvas, at most 30 fps, paused off screen and in hidden tabs), menu open, FAQ
  height, a 1px button press. With `prefers-reduced-motion` everything is still.
- **No fake demos:** no scripted terminals, typed-out sessions or invented output.
- **Content:** plain sentences with real names, shortcuts and numbers.
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
