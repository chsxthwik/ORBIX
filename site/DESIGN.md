# ORBIX website design

How every page of orbix-agent.vercel.app looks and why. Read this before changing the site. (Not deployed:
`.vercelignore` keeps it out.)

## References

Ten developer-tool sites that look good, and the one thing each does that ORBIX borrows. These are notes, not copies:
no layout, wording or asset is taken from them.

| Site | What works | Taken for ORBIX |
| --- | --- | --- |
| linear.app | Dense, quiet type and one accent. The product screenshot is the hero, with no illustration. | Screenshot as the hero; one accent |
| zed.dev | Plain statements and fast pages with almost no motion. Docs-like honesty. | No entrance animation; factual headings |
| ghostty.org | A short page that says what the thing is, then how to get it. | Install cards near the top |
| warp.dev | Real terminal output as the visual, in monospace. | Commands in Geist Mono with a copy button |
| raycast.com | Keyboard shortcuts shown as keys, everywhere. | `<kbd>` keys in cards and steps |
| tailscale.com | Security explained in plain words, what goes where. | "Stays here / leaves your PC" |
| vercel.com | Hairline borders and grids instead of shadows. | Flat cards, 1px lines, no glows |
| supabase.com | Real code and real product names; no stock imagery. | Provider list and agent commands as data |
| cline.bot | Product cards per surface, each with its own install path. | Windows / Cloud / Source cards |
| stripe.com/docs | A clear type scale and generous measure for reading. | 64ch measure; one type scale |

## Rules

- **Type:** Google Sans Flex (UI and reading), Geist Mono (anything a terminal prints). Hero 38–72px, section
  heading 28–40px, lead 16–18px, body 15–16px, labels 13px. Weights 400–600. ORBIX is always written in capitals.
- **Colour:** tokens only (`--bg`, `--surface`, `--raised`, `--fg`, `--fg-2`, `--fg-3`, `--line*`, `--accent`).
  Plasma `--accent` is for the primary action and state, nothing decorative. Light and dark from the same tokens;
  the footer switch sets `data-theme`.
- **Space:** a 4px grid. Section rhythm `--sec` (72–120px), gutters 16–40px, text measure 62–78ch.
- **Surfaces:** flat. 1px hairlines, 8–16px corners, no drop shadows on cards, no gradients, no glows.
- **Motion:** feedback only: tab fade, menu open, the FAQ's height. No scroll reveals, no entrance animation, no
  parallax. Everything stops for `prefers-reduced-motion`.
- **Content:** say what it does, with real names, shortcuts and numbers. Screens come from the real app
  (`node tools/shots.mjs`).

## Banned (the AI look)

Inter, purple or pink gradient washes, glowing or shining buttons, serif headlines with one italic word, four stat
cards in a row, badge pills above the headline, orbit or blob decorations, icon-per-card bento grids, cursor
spotlights, scroll progress bars, staggered fade-ins, giant faded wordmarks, three-fragment slogans ("X. Y. Z."),
"not X, but Y" lines, emoji, made-up numbers or logos. If a section looks like every other AI site, redo it.

## Before shipping

1. At 375px: no horizontal scroll (tab rows scroll inside themselves), 16px gutters, buttons at least 40px tall,
   nothing clipped.
2. Hover and keyboard focus visible on every link and button; tabs work with the arrow keys.
3. Light and dark both readable (WCAG AA).
4. No inline styles or scripts (the CSP allows only `/assets`), no third-party requests, no personal data.
5. Bump `?v=` on any changed CSS, JS or image, then deploy from `site/`.
