# ORBIX website — DESIGN.md

The site looks like the product. It uses the near-black frame, quiet hairlines and the app's one accent, Plasma, with the `)(` mark from logo kit v2 as the brand idea: an O split and turned inside out, which becomes the X. Tokens live as CSS variables at the top of `assets/css/site.css`. Pages use the names, never raw values.

**Principles:**
- product UI shown directly rather than illustration
- a strip of the supported agents
- "bring your own subscription" cards that name the login
- an install command with a copy button
- short, declarative headings

What we avoid: gradient text, purple-to-blue washes, glass everywhere, identical three-up cards, invented numbers or testimonials.

## Colour
| Token | Dark | Light | Role |
|---|---|---|---|
| `--bg` | `#0B0B0B` | `#FAFAF9` | Page ground |
| `--surface` | `#111111` | `#FFFFFF` | Cards, windows |
| `--raised` | `#1A1A1A` | `#F2F2F0` | Hover, chips, kbd |
| `--line` / `--line-2` / `--line-3` | white 7.5% / 11% / 18% | black 8% / 12% / 20% | Hairlines, borders, strong borders |
| `--fg` | `#EDEDEA` (16.8:1) | `#151514` (17.5:1) | Headings, body |
| `--fg-2` | `#A8A8A4` (8.3:1) | `#4F4F4B` (7.9:1) | Secondary text, leads |
| `--fg-3` | `#8A8A86` (5.7:1) | `#67675F` (5.5:1) | Captions, meta (the lowest text contrast allowed) |
| `--accent` | `#FF2E7E` | `#FF2E7E` | Primary button fill and the i-dot (exact Plasma) |
| `--accent-ink` | `#FF4D8F` (6.3:1) | `#C8115A` (5.5:1) | Accent as text or icon on the page ground |
| `--on-accent` | `#0A0A0B` (5.6:1 on Plasma) | same | Text on the primary button (white is only 3.5:1) |
| `--add` / `--warn` | `#8FD866` / `#E9B949` | `#2F7D16` / `#9A6A00` | "Runs" and "Asks you" states only |

There is one accent, Plasma. Small text never uses raw Plasma on light grounds; there the accent ink is the deeper `#C8115A`, as in the app's light themes.

## Typography
- **Google Sans Flex** (variable, self-hosted, OFL) for everything people read, and **Geist Mono** for anything the app or a terminal would print: commands, keys, file names, labels.
- **Scale:**

  | Size | Use |
  |---|---|
  | 92 / 1.0 | Display (H1, 44px on phones) |
  | 54 / 1.04 | H2 |
  | 22 / 1.3 | H3 large |
  | 18 / 1.35 | H3 |
  | 19 / 1.55 | Lead |
  | 16 / 1.6 | Body |
  | 14 / 1.5 | Small |
  | 15 / 1.4 | Section label, sentence case, accent ink |
  | 13 / 1.4 | Small label, sentence case |

- **Weights:** 400 for body, 560 for headings, 600 for labels. Headings tighten tracking to -0.035em at display size.
- **Reading width:** 60–68 characters.

## Spacing
- **Scale:** an 8px base: 4, 8, 12, 16, 24, 32, 48, 64, 96, 128.
- **Sections:** `clamp(88px, 11vw, 144px)` vertical padding.
- **Content width:** 1200px, with a gutter of `clamp(16px, 5vw, 40px)`.

## Shape and depth
- **Radius:** 8 (chips, kbd), 12 (buttons, cards), 16 (large cards), 20 (app windows).
- **Shadows:** two only: `--shadow` for cards (a hairline highlight and a soft drop) and `--shadow-win` for screenshots in a window frame.

## Components
- **Buttons:**
  - *Primary:* Plasma fill with `--on-accent` text.
  - *Secondary:* surface fill with a `--line-2` border.
  - *Quiet:* text with an underline on hover.
  - *All:* 48px (large) or 40px tall; hover lifts the colour; `:active` presses 1px; focus is a 2px `--accent-ink` outline with a 3px offset. There's no disabled state on the site.
- **Links:** inherit colour, underlined with `--line-3`, and the underline turns `currentColor` on hover.
- **Cards:** surface fill, a `--line` border and radius 16. Bento rows are always full (a wide card and a single, or three singles), so no cell is left empty; `grid-auto-flow: dense` fills the two-column layout.
- **Navigation:** fixed top bar that blurs once scrolled. Section links sit in a pill row on wide screens and in a `<details>` menu on narrow ones (Esc closes it).
- **Tabs:** WAI-ARIA tabs with arrow keys, Home and End. Used for permissions and screens.
- **Code:** a mono line on `--raised` with a copy button that announces "Copied".
- **Footer:** brand, link columns, and a giant faint wordmark.

## Imagery and icons
- **Screenshots:** only real ones from the app (`tools/shots.mjs`), as WebP in a Windows window frame with the min/max/close controls, with explicit width and height. Below the fold they lazy-load.
- **Icons:** one hand-drawn 24px stroke set at 1.6px with round caps, in `currentColor`. No emoji.
- **Brand mark:** `)(`, an O split and turned inside out (logo kit v2). Marks use only Obsidian, Bone, Plasma or `currentColor`. Next to words the mark sits in its Obsidian tile, never bare (bare it reads as "x" + the word). No outlines, glows or gradients on the mark or wordmark; the footer wordmark is a faint solid fill with a Plasma dot.

## Motion
Every motion comes from the orbit idea, uses only transform and opacity where possible, and is off under `prefers-reduced-motion`.
- **The swap:** the wordmark's x turns from O into `)(` once on load and again on hover; the install card's mark does it once when it scrolls in.
- **Hero:** the construction circles draw in once; two small satellites travel the dashed orbit and pause when the hero is off screen.
- **Scroll-driven (CSS `animation-timeline`, no script):** the agents orbit turns as you scroll, the hero screenshot settles flat as it enters, and a Plasma line runs across the run steps. Browsers without support show the still version.
- **Pointer:** a soft light follows the mouse across cards. Mouse only.
- **No tracked uppercase mono labels and no 01/02/03 numbering:** labels are sentence case, steps use plain counters and the app's own terms.

## Rules
- The CSP allows only same-origin files, so there are no inline styles, no inline scripts and no third-party requests (JSON-LD data blocks are the one exception: they never execute).
- The page is complete without JavaScript: tabs show their first panel and details elements work natively.
