# eve-cockpit — agent guidelines

A local Next.js dashboard for eve agent runs (local + Vercel production/preview),
styled to be indistinguishable from Vercel's own Agent Runs dashboard.

## Icons — hard rule

**Always use Geist icons from `vercel-geist-icons`. Never invent, hand-draw, or
approximate an icon that doesn't exist in that set.**

- Import components (`ChevronDownSmall`, `ClockDashed`, `Wrench`, `Coins`, …)
  from `vercel-geist-icons` — 461 icons, the same artwork Vercel's dashboard uses.
- They render at `1em` and `currentColor`: size them with `font-size`/CSS on the
  surrounding context, color them with `color`. Do not pass width/height props
  or wrap them in custom `<svg>`.
- If a concept has no Geist icon, pick the nearest existing one or ship no icon.
  A lookalike SVG is worse than none — it breaks visual parity with Vercel.
- Detail worth knowing: Vercel uses *two different clocks* — `ClockDashed` in
  the runs table trigger cell, plain `Clock` in turn stat bars. Match their
  usage, not just their set.

## Design

- The full design-system reference lives in `.agents/skills/vercel-design-system/`
  (sources https://vercel.com/design.md — fetch fresh before design work).
- Match Vercel's dashboard, measured not guessed: when styling something new,
  open the real page (vercel.com dashboard) and read computed styles from the
  DOM before writing CSS.
- Geist Sans/Geist Mono only (via the `geist` package). Tables, measured on
  the real Agent Runs page: 14px GeistSans throughout, no monospace; headers
  `#a1a1a1` at weight 500 (42px tall); body rows 43px with ONLY the Run title
  `#ededed` — every other cell is `#a1a1a1`; tbody sits on `#0a0a0a`; hover
  paints the CELLS `#1a1a1a` while the `tr` stays transparent.
- Monochrome by default; color only for state (green live, red failed, amber
  running) and chart series (blue input, purple output, gray cached).
- Pure `#000` ground, hairline `#1f1f1f` borders, radii 6/8/12 only.

## Theming — both modes, always

The app has light and dark themes, resolved to an explicit
`data-theme="light|dark"` on `<html>` before first paint (boot script in
`app/layout.jsx`; preference in `localStorage["eve-cockpit:theme"]`).

- **Never write a colour literal in a component or in globals.css rules.**
  Use the tokens (`--bg --panel --panel2 --hover --inset --line/--line2/--line3
  --fg --dim --dim2 --chip --btn/--btn-fg --on-accent --ring --ring-soft` and
  the state colours). If no token fits, add one to BOTH `:root` blocks.
- Token names must not collide with shadcn's. `--ring` is THEIRS (the focus
  ring); ours is `--hairline`/`--hairline-soft`. A collision inside the same
  `:root` is silent — the later definition just wins.
- Shadows are tokens too (`--shadow-menu/-lift/-dock/-panel/-panel-up`) —
  dark-mode shadows read as ink smears on white, so light swaps the set.
- Literals are only correct where the colour is genuinely theme-independent:
  mask gradients (where #000 means opaque), text on a coloured fill, the
  modal scrim.
- Canvas/prop-driven surfaces can't read CSS variables and must be told the
  theme: React Flow takes `colorMode` (see agent-graph.jsx), xterm takes a
  theme object rebuilt on `data-theme` changes (see terminal-panel.jsx).
- When adding any new component, check it in BOTH modes before calling it
  done — the switcher is in the account menu.

## CSS layers — where a rule goes

`globals.css` declares the order explicitly:

    @layer theme, base, components, utilities, app;

- `@layer base` — the reset (`*`, `html/body`, `a`, `button`). Element rules
  only. It must NOT be unlayered: unlayered element rules beat class rules in
  any layer, which is how `button{font:inherit}` silently won over
  `.oc-session-trigger{font-size:13px}`.
- `@layer app` — everything of ours. Wins over Tailwind/shadcn utilities by
  ORDER, so `!important` is never needed to restyle a shadcn component. There
  is exactly one `!important` left in the file and it fights React Flow's
  UNLAYERED stylesheet (imported in agent-graph.jsx) — unlayered beats every
  layer, so its overrides live unlayered next to it.
- Consequence: a Tailwind class in JSX cannot override a rule in `globals.css`.
  Restyle through the stylesheet, or pass the class to a shadcn component
  whose `cn()` merges it.

## Reusable pieces — don't grow a second one

Menus: `app/components/menu.jsx` is the primitive set — `MenuList` (add
`scroll` for a hidden bar with faded edges), `MenuRow`, `MenuLabel`,
`MenuSeparator`. Every popover in the app is built from these, so they share
one rhythm: `--menu-pad` (7px) is the ring of space around the list and
`--menu-row-h` (34px) the row height, both in globals.css — change them and
every menu moves. Rows sit FLUSH: their hover fill is the separation, so a gap
would double it. `app/components/dropdown.jsx` is the trigger+panel wrapper
built on those primitives. One tooltip: `components/ui/tooltip.jsx` (Base UI: trigger takes
`render`, not asChild). One modal look: the Geist-measured `.set-dialog`
chrome. One loader family: `loading-state.jsx` (pixel grid) and the 12px
`.th-spin` ring for inline rows. Before styling a new menu, row, or panel,
reuse these — two implementations of the same control is how the app drifted
last time.

## Performance — top priority

Speed is this project's stated #1 goal. Never put a subprocess spawn, port
scan, or network call on a polling path. Cache immutable data (terminal runs)
aggressively. Measure before/after with real numbers; treat multi-second waits
as bugs. The `workflow` CLI costs ~0.9s per spawn — use the in-process
`@workflow/world-vercel` client instead.

## Versioning trap

`workflow` must stay pinned to the 5.x beta line that eve vendors. The 4.x
client silently returns EMPTY LISTS (not errors) against 5.x agents.
