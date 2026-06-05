# Design & Polish Phase (Phase 4.5) — Progress

A cross-cutting UI/UX polish phase inserted before Phase 5. Goal: elevate execution of the
**existing** design identity ("editorial-calm instrument") to an industry-standard premium bar,
by turning the implicit design system into an explicit, documented contract (see
[`design-system.md`](./design-system.md)) and sweeping every surface to consume it.

> This phase is a scope addition not present in the original phases doc. It is tracked here
> rather than in `TODO.md` (which mirrors the phases docx). Locked direction: **elevate existing
> identity**, **editorial-calm-premium** bar, **CSS + tokens** motion (no new deps).

Each wave ends at a green gate: `typecheck` clean · `vitest` 220 green · `lint` exit 0 · manual
visual pass in **both light and dark** + an OS Reduce-Motion pass. Tick items in the wave's commit.

## Wave 0 — Design contract (`globals.css` + docs)
- [x] Interaction-tint tokens (`--surface-hover/pressed/selected`) + `@theme inline` exposure
- [x] Elevation tokens + `.elevation-card` / `.elevation-overlay`
- [x] Wire motion tokens: `.transition-base` / `.transition-fast`, `.animate-rise-in`, `.stagger-item`
- [x] `prefers-reduced-motion: reduce` global guard
- [x] Type ramp utilities (`.text-display/title/numeral/body/eyebrow/caption`)
- [x] `--recording-hover` baked (kills the `color-mix` hack); light-mode scrim raised to 0.3
- [x] `docs/design-system.md` contract + this checklist
- [x] Gate: `pnpm build` compiles Tailwind clean

## Wave 1 — Primitive refinement (`components/ui/*`)
- [x] Card → soft `.elevation-card` lift (keeps the hairline ring)
- [x] Button + Badge → `transition-fast` (settle easing, replaces flat `transition-all`)
- [x] Input → `transition-base` on focus
- [x] Dialog + Sheet surfaces → `.elevation-overlay` (proper depth under the raised scrim)
- [x] ScrollArea thumb → visible-but-quiet `bg-foreground/15` + hover
- [x] Gate green (build emits all utilities; 220 tests; lint clean)

## Wave 2 — App chrome & atmosphere
- [x] `app-shell.tsx`: replaced the "Foundation" placeholder with an amber brand-dot wordmark
- [x] View entrance: keyed `animate-rise-in` on the main region (recording/history/detail swap) — reliable CSS, reduced-motion-safe (chosen over the View Transitions API)
- [x] Restrained background atmosphere: `.app-atmosphere` faint warm top halo (5% accent)
- [x] Gate green (build, 220 tests, lint)

## Wave 3 — Recording surface
- [x] `record-control.tsx`: hero now has a soft breathing live halo, tactile hover-grow/press, baked `--recording-hover` (killed the color-mix hack), type-ramp eyebrow + numeral timer
- [x] `transcript-panel.tsx`: `.text-title` titles, cleaner system-note tint
- [x] `reconnect-banner.tsx`: fixed dark-mode contrast (accent-foreground → foreground on tinted strips) + rise-in entrance
- [x] `permission-prompt.tsx`: editorial `.text-title` heading
- [x] `connection-status.tsx` / `mic-level-meter.tsx`: already purpose-tuned — left as-is
- [x] (foundation fix) moved the type-ramp to `@layer utilities` so `.text-title` overrides primitive base type (verified via cascade offset)
- [x] Gate green (build, 220 tests, lint)

## Wave 4 — Session-ended + summary
- [x] `session-ended-view.tsx`: flat editorial stat tiles (`.text-eyebrow` + `.text-numeral`), `.text-title` heading, cleaner transcript-review (muted→foreground hover, no ad-hoc `/80`)
- [x] `meeting-summary.tsx`: `.text-title` card header + `.text-eyebrow` section labels, removed every ad-hoc `text-foreground/90`, `.elevation-card` surface, nested action-item tiles on `bg-muted/30`
- [x] Gate green (meeting-summary tests 9/9; 220 total; typecheck + lint clean)

## Wave 5 — History + search
- [ ] `history-view.tsx` (rows, hover lift, distinct empty/filtered/error states, stagger-in), `search-input.tsx`, `search-results.tsx`, `history-filters.tsx`
- [ ] Gate green

## Wave 6 — Detail surface
- [ ] `meeting-detail-view.tsx` (edit affordances, remove `-mx-3` hack), `meeting-audio-player.tsx`, `participants-section.tsx` (Avatar via shadcn CLI)
- [ ] Gate green

## Wave 7 — Auth, settings, dialogs
- [ ] `login-view.tsx` (first impression), `settings-sheet.tsx` (FieldGroup/Field), `keyboard-shortcuts-dialog.tsx`
- [ ] Gate green

## Wave 8 — Cross-cutting QA
- [ ] `prefers-reduced-motion` honoured on every animated surface
- [ ] focus-visible coverage + `aria-label`s on all icon buttons
- [ ] dark-mode parity sweep (incl. raised scrim)
- [ ] final consistency pass against the contract in both themes
