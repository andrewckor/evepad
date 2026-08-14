---
name: vercel-design-system
description: Vercel's official design system and brand guidelines. Use when styling, theming, building UI, choosing colors/typography/spacing, or reviewing visual design in this project — the cockpit must be indistinguishable from Vercel's own dashboard.
metadata:
  source: https://vercel.com/design.md
---

# Vercel Design System

This project's UI is held to Vercel's design system. Before styling anything
new, consult the official guidelines and this project's measured values.

## How It Works

1. Fetch the latest guidelines from the source URL below (they change).
2. Apply them together with the project-local rules in AGENTS.md (icons,
   measured table typography, Geist-dark tokens in app/globals.css).
3. When guidelines and the live dashboard disagree, the live dashboard wins —
   measure computed styles from vercel.com's DOM, don't guess.

## Guidelines Source

```
https://vercel.com/design.md
```

Fetch fresh before design work. Key principles that always hold:

- Monochrome by default; color only for state, action, or data-series meaning.
- Geist Sans for everything; Geist Mono only for code, ids, and operational
  tokens — never in data tables.
- No decoration: no gradients, glows, glass, or motion without a state change
  ("default to stillness").
- Restrained radii (this project: 6/8/12px only), hairline #1f1f1f borders on
  pure #000 ground.
- Data-viz series colors: blue (input), purple (output), gray (cached).

## Project-local ground truth

- Tokens: app/globals.css (:root — Geist-dark palette + shadcn semantic mapping)
- Icons: vercel-geist-icons ONLY (see AGENTS.md hard rule)
- Measured table/typography values: recorded in AGENTS.md and globals.css comments
