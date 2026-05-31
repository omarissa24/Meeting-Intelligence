#!/usr/bin/env bash
# Generate a 1024x1024 placeholder source PNG that matches the locked design
# system (warm paper + ink ring + amber recording dot), then run `tauri icon`
# to populate the five files referenced by tauri.conf.json.
#
# Re-runnable: overwrites source.png and regenerates all derived icons.
#
# Usage:
#   pnpm icons

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICON_DIR="$REPO_ROOT/apps/desktop/src-tauri/icons"
SOURCE="$ICON_DIR/source.png"

mkdir -p "$ICON_DIR"

if ! command -v uvx >/dev/null 2>&1; then
  echo "error: uvx not found. Install uv: https://github.com/astral-sh/uv" >&2
  exit 1
fi

echo "→ generating $SOURCE (1024×1024)"

# Inline Pillow script — installs Pillow ephemerally via uvx, no project deps touched.
uvx --quiet --from pillow python - "$SOURCE" <<'PY'
import sys
from PIL import Image, ImageDraw

out = sys.argv[1]
size = 1024

# Design system tokens (light mode):
#   --background ≈ oklch(0.985 0.012 80) → warm paper
#   --foreground ≈ oklch(0.22 0.015 260) → near-black ink
#   --recording  ≈ oklch(0.62 0.20 25)  → live amber-red
PAPER = (250, 245, 234)
INK   = (40, 38, 47)
AMBER = (217, 95, 60)

img = Image.new("RGB", (size, size), PAPER)
draw = ImageDraw.Draw(img)

# Ink "instrument" ring — drawn via filled outer circle + paper inner circle so
# anti-aliasing stays clean at small sizes. Stroke width effectively 48px.
draw.ellipse([112, 112, 912, 912], fill=INK)
draw.ellipse([176, 176, 848, 848], fill=PAPER)

# Amber live indicator — solid disk in the centre.
center = size // 2
r = 180
draw.ellipse([center - r, center - r, center + r, center + r], fill=AMBER)

img.save(out, "PNG", optimize=True)
print(f"wrote {out}")
PY

echo "→ running tauri icon to generate platform icons"
cd "$REPO_ROOT"
pnpm --filter @meeting-intelligence/desktop tauri icon "$SOURCE"

echo
echo "done. Icons populated under $ICON_DIR/"
ls "$ICON_DIR"
