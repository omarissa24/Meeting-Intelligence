# Bundle icons

Tauri needs platform icons in this directory before `tauri build` succeeds.

Generate from a single 1024×1024 source PNG:

```bash
pnpm --filter @meeting-intelligence/desktop tauri icon path/to/source.png
```

This produces:

- `32x32.png`, `128x128.png`, `128x128@2x.png`
- `icon.icns` (macOS)
- `icon.ico` (Windows)
- platform-specific Square*.png variants

These files are intentionally not committed at scaffold time — they belong in the first frontend phase where the visual identity is decided. `tauri dev` will fail loudly if you try to run it before generating them.
