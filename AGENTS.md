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

## Performance — top priority

Speed is this project's stated #1 goal. Never put a subprocess spawn, port
scan, or network call on a polling path. Cache immutable data (terminal runs)
aggressively. Measure before/after with real numbers; treat multi-second waits
as bugs. The `workflow` CLI costs ~0.9s per spawn — use the in-process
`@workflow/world-vercel` client instead.

## Versioning trap

`workflow` must stay pinned to the 5.x beta line that eve vendors. The 4.x
client silently returns EMPTY LISTS (not errors) against 5.x agents.
