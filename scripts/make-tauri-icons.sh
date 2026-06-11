#!/usr/bin/env bash
# Generate the Tauri bundle icons from the real Marens brand mark.
#
# The source of truth is the raw brand tile apps/web/brand-src/light-app-icon.png
# (cream paper + dark waveform + amber dot). We resize it to 1024x1024 and round
# the corners at 16% — the SAME radius apps/web/brand-src/process-logos.mjs uses
# for the web app-icon tiles — so the desktop icon can never drift from the web
# one. The rounded source.png (transparent corners) is then fed to `tauri icon`,
# which overwrites every file referenced by tauri.conf.json's bundle.icon array
# plus the Windows Square*/Store logos and the iOS/Android asset sets.
#
# Variants:
#   cream (default) — cream tile, dark waveform   (matches marens-app-icon-dark.png)
#   ink             — ink tile,  cream waveform   (matches marens-app-icon.png)
#
# Re-runnable: overwrites source.png and regenerates all derived icons.
#
# Usage:
#   pnpm icons            # cream tile
#   pnpm icons ink        # ink tile
#   bash scripts/make-tauri-icons.sh [cream|ink]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICON_DIR="$REPO_ROOT/apps/desktop/src-tauri/icons"
SOURCE="$ICON_DIR/source.png"
VARIANT="${1:-cream}"

mkdir -p "$ICON_DIR"

echo "→ generating $SOURCE (1024×1024, ${VARIANT} tile) from the Marens brand mark"

# sharp is a transitive Next.js dep, kept in the pnpm virtual store and not
# hoisted to the repo root — the same loadSharp() fallback as process-logos.mjs
# locates it. No project deps are touched.
REPO_ROOT="$REPO_ROOT" SOURCE="$SOURCE" VARIANT="$VARIANT" node <<'JS'
const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = process.env.REPO_ROOT;
// Running from stdin (`node <<JS`) has no __filename, so anchor module
// resolution at the repo root (the path need not exist).
const require_ = createRequire(path.join(REPO_ROOT, "package.json"));
const OUT = process.env.SOURCE;
const VARIANT = process.env.VARIANT;
const SRC = path.join(REPO_ROOT, "apps", "web", "brand-src", "light-app-icon.png");

function loadSharp() {
  try {
    return require_("sharp");
  } catch {
    const store = path.join(REPO_ROOT, "node_modules", ".pnpm");
    const dir = fs.readdirSync(store).find((d) => d.startsWith("sharp@"));
    if (!dir) throw new Error("sharp not found — run `pnpm install` at the repo root first");
    return require_(path.join(store, dir, "node_modules", "sharp"));
  }
}
const sharp = loadSharp();

const SIZE = 1024;
const RADIUS = Math.round(SIZE * 0.16); // 164 — soft app-tile corner, matches the web tiles

// Brand tokens, sampled the same way as process-logos.mjs.
const INK = [31, 36, 48];
const CREAM = [254, 250, 242];
const INK_L = 0.299 * INK[0] + 0.587 * INK[1] + 0.114 * INK[2];
const CREAM_L = 0.299 * CREAM[0] + 0.587 * CREAM[1] + 0.114 * CREAM[2];
const isOrange = (r, g, b) => r > 140 && r - b > 50; // the amber accent dot

async function main() {
  // Normalise the raw tile to 1024². The source is already square (1254²) on a
  // flat cream field, so this is a clean downscale.
  let base = sharp(SRC).resize(SIZE, SIZE, { fit: "cover" }).ensureAlpha();

  if (VARIANT === "ink") {
    // Swap cream<->ink along the luminance ramp so the tile becomes ink and the
    // mark becomes cream, leaving the orange dot intact (process-logos.mjs:122).
    const { data } = await base.raw().toBuffer({ resolveWithObject: true });
    const n = SIZE * SIZE;
    const out = Buffer.alloc(n * 4);
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      if (isOrange(r, g, b)) {
        out[i] = r;
        out[i + 1] = g;
        out[i + 2] = b;
      } else {
        const L = 0.299 * r + 0.587 * g + 0.114 * b;
        const t = Math.min(1, Math.max(0, (CREAM_L - L) / (CREAM_L - INK_L)));
        out[i] = Math.round(INK[0] * (1 - t) + CREAM[0] * t);
        out[i + 1] = Math.round(INK[1] * (1 - t) + CREAM[1] * t);
        out[i + 2] = Math.round(INK[2] * (1 - t) + CREAM[2] * t);
      }
      out[i + 3] = 255;
    }
    base = sharp(out, { raw: { width: SIZE, height: SIZE, channels: 4 } });
  }

  // Round the corners: a rounded-rect alpha mask composited as dest-in.
  const mask = Buffer.from(
    `<svg width="${SIZE}" height="${SIZE}"><rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" ry="${RADIUS}"/></svg>`,
  );
  await base
    .composite([{ input: mask, blend: "dest-in" }])
    .png({ compressionLevel: 9 })
    .toFile(OUT);
  console.log(`  wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
JS

echo "→ running tauri icon to generate platform icons"
cd "$REPO_ROOT"
pnpm --filter @meeting-intelligence/desktop tauri icon "$SOURCE"

echo
echo "done. Icons populated under $ICON_DIR/"
ls "$ICON_DIR"
