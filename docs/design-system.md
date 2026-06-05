# Design System — Meeting Intelligence

> **Aesthetic:** "instrument-grade tool with editorial calm." Warm-paper canvas, ink-black
> type, one disciplined amber accent for liveness, motion that settles rather than performs.
> Quality bar: **editorial-calm premium** (Granola / Superhuman / Craft).

This is the single source of truth for the app's visual language. Every surface consumes these
tokens and utilities — **no hardcoded hex, no per-screen palette riffs, no bespoke type combos.**
All values live in the one Tailwind CSS file: `apps/desktop/src/styles/globals.css`.

## Color

Semantic oklch tokens with full light/dark parity. Use shadcn semantic classes
(`bg-background`, `text-muted-foreground`, `bg-primary`, `border-border`, `bg-accent`…) — never
raw values. Key app-specific tokens beyond the shadcn set:

| Token | Purpose |
| --- | --- |
| `--accent` (amber) | The one disciplined accent — liveness, focus rings, selected state. Use sparingly. |
| `--recording` / `--recording-hover` / `--recording-glow` | Live-recording indicator. Distinct from `--destructive` (errors only). |
| `--meter-good` / `--meter-warn` / `--meter-bad` | Mic-level meter traffic light. |
| `--surface-hover` / `--surface-pressed` / `--surface-selected` | **Interaction tints** — use `bg-surface-hover` for row/chip/button hover, `bg-surface-pressed` for active, `bg-surface-selected` (amber-soft) for selected/highlighted. Replaces ad-hoc `/10` `/40` washes. |
| `--overlay` | Modal scrim (Dialog/Sheet/Popover backdrops). |

## Typography

IBM Plex Mono (display) + IBM Plex Sans (body/labels), self-hosted via `@fontsource`.
Consume the ramp utilities — don't re-derive size/leading/tracking per component:

| Utility | Use | Resolves to |
| --- | --- | --- |
| `.text-display` | Hero / page titles | IBM Plex Mono, 3xl, leading 1.05, tracking-tight |
| `.text-title` | Card / section titles | IBM Plex Mono, xl, leading-snug, tracking-tight |
| `.text-numeral` | Editorial stat numbers, timers | IBM Plex Mono, tabular-nums, tracking-tight (size set at call site) |
| `.text-body` | Prose / readable copy | sans, sm, leading-relaxed |
| `.text-eyebrow` | The **one** canonical uppercase micro-label | xs, medium, uppercase, `letter-spacing: 0.14em`, muted |
| `.text-caption` | Secondary/meta text | xs, muted |

Rule: there is exactly **one** uppercase-label treatment (`.text-eyebrow`). Don't mix
`tracking-wide` / `tracking-wider` / `tracking-[0.14em]` ad-hoc anymore.

## Spacing & layout

- **Baseline rhythm:** 4 / 8 / 12 / 16 / 24 px. Use Tailwind `gap-*` (never `space-y/x-*`).
- **Section gaps:** `gap-6` between major sections, `gap-3` within a group, `gap-2` inline.
- **Panel padding:** card header `px-6 py-4`, card content `px-6 py-5`. Keep panels on this rhythm.
- Use `size-*` when width == height. No brittle negative-margin hacks for full-bleed highlights —
  use a padded wrapper or `bg-surface-selected` on the row itself.

## Elevation

Soft, low-spread depth (editorial calm = quiet). Utilities:

- `.elevation-card` — resting surfaces (cards, the record hero, audio player).
- `.elevation-overlay` — dialogs, popovers, sheets (paired with `--overlay` scrim).

Prefer these over bare `border` / `ring-1` for surfaces that should read as lifted.

## Motion

CSS + tokens only (no motion library). The settle easing `cubic-bezier(0.22,1,0.36,1)` never bounces.

| Utility | Use |
| --- | --- |
| `.transition-base` | Default interactive transition (220ms, settle easing). Use for hover/focus/state. |
| `.transition-fast` | Snappier feedback (120ms) — small toggles, presses. |
| `.animate-line-in` | A single item arriving (transcript lines). |
| `.animate-rise-in` | A panel/card/section arriving. |
| `.stagger-item` + inline `--stagger-index` | Staggered list entrances. **Cap the index at ~10** at the call site so long lists don't accrue delay. |
| `.animate-breathe` | The live-recording indicator (breathes, never strobes). |

**`prefers-reduced-motion: reduce` is globally honoured** — a media query neutralizes all
animation/transition. Never gate functionality on motion.

## Rules of engagement

1. Edit only `globals.css` for tokens — never a parallel CSS file. New token → add it semantically + expose in `@theme inline`.
2. shadcn composition: `FieldGroup`/`Field` for forms, `Empty` for empty states, `Skeleton` for loading, `Badge`/`Alert`/`Separator` over styled divs, `gap-*` not `space-*`, `size-*`, icons in buttons via `data-icon`, no manual `dark:` overrides.
3. Consistency beats novelty — the aesthetic is locked; elevate execution, don't re-roll it.
