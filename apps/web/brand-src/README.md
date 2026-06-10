# Brand source assets

Raw, high-resolution `marens` logo files with their original cream background.
These are **source** — they are not web-served (they live outside `public/`).

The site consumes processed, transparent/theme-aware variants in `../public`:

| Source                   | Light theme           | Dark theme                 | Used in                         |
| ------------------------ | --------------------- | -------------------------- | ------------------------------- |
| `full-logo-wordmark.png` | `marens-logo.png`     | `marens-logo-dark.png`     | brand kit (mark + wordmark)     |
| `wordmark-only.png`      | `marens-wordmark.png` | `marens-wordmark-dark.png` | header + footer wordmark        |
| `light-app-icon.png`     | `marens-app-icon.png` | `marens-app-icon-dark.png` | rounded app-icon tile in header |

The app icon is rounded (≈16% radius) and theme-aware: an **ink tile with cream
mark** on the light theme (the cream tile would vanish on the cream page) and the
original **cream tile with dark mark** on dark. The same source also produces the
favicon at `../app/icon.png` (square 512², browsers mask their own corners).

Components pick the variant per theme with a `dark:hidden` / `hidden dark:block`
pair (see `components/site-header.tsx`, `components/site-footer.tsx`).

## Regenerating the public variants

```bash
node apps/web/brand-src/process-logos.mjs
```

The script keys the flat cream background to transparent, trims the margins, and
recolours the ink (but not the orange accent dot) for the dark variant. Tweak the
`BG`, `T_LOW`, `T_HIGH`, and `DARK_FG` constants if you swap in new source art.
