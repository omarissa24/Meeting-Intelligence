# Bundle icons

Tauri needs platform icons in this directory before `tauri build` succeeds.

These are **generated**, not hand-edited. The source of truth is the raw Marens
brand tile at `apps/web/brand-src/light-app-icon.png` (cream paper + dark
waveform + amber dot). Regenerate the whole set with:

```bash
pnpm icons          # cream tile, dark waveform (default)
pnpm icons ink      # ink tile, cream waveform
```

`scripts/make-tauri-icons.sh` resizes the brand tile to 1024×1024 and rounds the
corners at the same 16% radius as the web app-icon tiles (so the desktop icon
can't drift from the web one), writes `source.png`, then runs `tauri icon` to
produce:

- `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png`
- `icon.icns` (macOS), `icon.ico` (Windows), `icon.png`
- the Windows `Square*Logo.png` / `StoreLogo.png` tiles
- the `ios/` and `android/` asset sets

All of these **are committed** — CI (`tauri-action`) bundles the committed icons
and does not run `tauri icon` itself, so regenerated icons must be checked in.
