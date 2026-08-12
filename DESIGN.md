# Design

The visual system as it is actually implemented in `app/style.css`. If a value
is not on one of these scales, the scale is wrong, not the value.

## Theme

**A working instrument, not a landing page.** The physical scene: an auditor at
a desk under office fluorescents, mid-afternoon, with a partner about to look
over their shoulder. That forces light-first, low-chroma, and density over
drama. Dark mode exists because the same person closes the month at 9pm.

Colour strategy is **Restrained**: tinted neutrals plus one accent held to
primary actions, current selection, and state. Colour never carries meaning on
its own; every severity also carries a rule code and a written label.

Theme follows the system by default. A three-way switch (light / system / dark)
in the top bar writes `data-theme` and persists to `localStorage`.
`app/theme-boot.js` replays the choice before first paint.

## Colour

Tokens live on `:root`, with the dark palette written out a second time under
`:root[data-theme="dark"]`. That duplication is deliberate: `light-dark()` would
say it once but needs Chrome 123+, and this tool is aimed at the corporate
laptop that is three years behind.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#fbfaf8` | `#14161a` | Page ground |
| `--surface` | `#ffffff` | `#1b1e23` | Cards, top bar, drawer |
| `--surface-2` | `#f4f2ee` | `#22262c` | Table head, inputs, wells |
| `--line` | `#ddd8d0` | `#343a42` | Borders |
| `--line-soft` | `#ebe7e0` | `#2a2f36` | Row separators |
| `--ink` | `#1c1a17` | `#eceef1` | Primary text |
| `--ink-2` | `#55504a` | `#b3b9c2` | Secondary text |
| `--ink-3` | `#6f6a64` | `#8a919c` | Muted text |
| `--accent` | `#1f5f4f` | `#4fb99a` | Primary action, selection, focus |
| `--hard` / `--hard-bg` | `#9d2f24` / `#fbeeec` | `#ef8377` / `#2e1d1b` | Exception |
| `--soft` / `--soft-bg` | `#8a5d10` / `#fdf4e3` | `#d8ab54` / `#2c2416` | Needs review |
| `--clean` / `--clean-bg` | `#24614a` / `#eaf4ef` | `#6dc9a6` / `#16261f` | Clean, privacy |

**Contrast rule.** Every ink rung is set against the *darkest* surface it
actually sits on, not against the page background. `--ink-3` is the one that
bites: it appears on `--surface-2`, so it is tuned to 4.8:1 there rather than
the 3.5:1 it had when tuned against `--bg` by eye.
`tools/a11y-check.mjs` measures this on the rendered page in both themes and
fails the build on any text node under AA.

## Typography

One family. `--sans` is the system UI stack; `--mono` carries every figure,
identifier, date, and rule code, because tabular data wants a fixed advance.

Sizes are **fixed rem, never fluid**. Product UI is read at a steady DPI, and a
heading that shrinks with the viewport reads as unfinished.

| Token | px | Use |
| --- | --- | --- |
| `--t-xs` | 12 | Rule codes, pills, table head |
| `--t-sm` | 13 | Microcopy, hints, footer |
| `--t-md` | 14 | Table body, buttons, labels |
| `--t-base` | 16 | Body |
| `--t-lg` | 18 | Lede, mobile h2 |
| `--t-xl` | 20 | Section h2 |
| `--t-2xl` | 28 | Tile figures, mobile h1 |
| `--t-3xl` | 36 | h1 |

`font-variant-numeric: tabular-nums` on every figure so columns of money line
up. `text-wrap: balance` on headings, `pretty` on prose. Prose caps at 72ch;
tables are allowed to run dense.

## Spacing and shape

4px base: `--s-1` 4 through `--s-8` 48. Radius: `--r-sm` 6, `--r-md` 8,
`--r-lg` 12, `--r-full` 999.

Stacking is named, never arbitrary: `--z-sticky` 10 (table head),
`--z-topbar` 20, `--z-panel` 40.

## Components

Every interactive element ships default, hover, focus, active, and disabled.
Async actions also ship a busy state (`aria-busy`, disabled, changed label).

- **Buttons.** One shape. `.primary` is the accent fill, `.quiet` is an
  underlined text action. 40px min height, 44px under `pointer: coarse`.
- **Focus.** One system: 2px accent outline at 2px offset. The accent-filled
  button and the active chip switch to an ink outline, because an accent ring
  on an accent fill is invisible.
- **Drop zones.** Dashed until filled, solid accent once loaded. The file input
  is `.sr-only`, never `[hidden]`, so it stays in the tab order, and the zone
  shows the ring via `:focus-within`.
- **Table.** `.tablewrap` is capped at `min(70vh, 680px)` so it is a real
  scrollport and the sticky head has something to stick to. Head borders use
  `box-shadow: inset`, because with `border-collapse` a border belongs to the
  table and does not travel with a sticky cell. Every column but Findings
  sorts, cycling ascending, descending, then back to report order.
- **Row handle.** The transaction id is a real `<button>`. Clicking anywhere on
  the row works for the mouse; the button is what Tab and Enter reach, so
  keyboard and pointer share one code path.
- **Evidence drawer.** A drawer, not a modal: it is read *against* the row
  behind it, so the page stays live. Focus moves in on open and returns to the
  triggering row on Escape or the close button. Clicking away dismisses without
  yanking focus back.
- **Findings.** Full border in the severity colour plus a written label. No
  side stripes anywhere in this system.
- **Tiles.** Counts and flagged value. Currency runs through `Intl.NumberFormat`
  so 350-row totals get their separators.

## Motion

`--dur` 180ms, `--ease` `cubic-bezier(.22, 1, .36, 1)` (ease-out quint). It
decelerates and never overshoots; no bounce, no elastic.

Motion only ever conveys state: hover, focus, fill level, theme cross-fade.
There is no entrance choreography, because the user arrives mid-task.

`prefers-reduced-motion: reduce` collapses every transition to 0.01ms, and the
jump to results switches from smooth to instant in JS.

## Accessibility

WCAG 2.2 AA, verified rather than asserted. See PRODUCT.md for the commitments
and `tools/a11y-check.mjs` for the 17 assertions that enforce them: keyboard
reach to both file pickers, focus move and return on the drawer, sticky head,
sort order including blanks-last, theme persistence, written severity labels,
`aria-valuenow` on progress, rendered contrast in both themes, and no
horizontal scroll at 375px.

Progress is announced at 25% milestones through a `role="status"` region rather
than on every row, so a 350-row run does not queue 350 utterances.
