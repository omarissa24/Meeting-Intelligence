// Generate the macOS DMG installer background for the Marens desktop app.
//
//   pnpm dmg-bg          (→ node scripts/make-dmg-background.mjs)
//
// The DMG window is 660×420 logical points (see bundle.macOS.dmg in
// apps/desktop/src-tauri/tauri.conf.json). Tauri's bundler copies the
// background file as-is with NO @2x/retina handling, so we author it at 2×
// (1320×840) and let macOS downsample — crisp on retina, fine on non-retina.
//
// The app icon tile is the CREAM brand tile, so the background is brand INK
// (#1F2430) to give it contrast, carrying the LIGHT wordmark
// (apps/web/public/marens-wordmark-dark.png — light ink on transparent) and a
// subtle cream arrow pointing from the app to the Applications folder. To flip
// to a cream background + ink wordmark, swap BG and the wordmark source below.
//
// Depends only on committed assets (brand-src / public are tracked). sharp is a
// transitive Next.js dep located via the same fallback as process-logos.mjs.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, ".."); // scripts/ -> repo root
const OUT_DIR = path.join(REPO_ROOT, "apps", "desktop", "src-tauri", "dmg");
const OUT = path.join(OUT_DIR, "background.png");
const WORDMARK = path.join(REPO_ROOT, "apps", "web", "public", "marens-wordmark-dark.png");

function loadSharp() {
  try {
    return require("sharp");
  } catch {
    const store = path.join(REPO_ROOT, "node_modules", ".pnpm");
    const dir = fs.readdirSync(store).find((d) => d.startsWith("sharp@"));
    if (!dir) throw new Error("sharp not found — run `pnpm install` at the repo root first");
    return require(path.join(store, dir, "node_modules", "sharp"));
  }
}
const sharp = loadSharp();

// 2× canvas. Logical layout (÷2): window 660×420; app icon centred at (180,220),
// Applications folder at (480,220). The arrow lives in the gap between them.
const W = 1320;
const H = 840;
const INK = { r: 31, g: 36, b: 48, alpha: 1 };
const CREAM = "#FEFAF2";

// Arrow drawn full-canvas so no compositing offsets are needed. It sits on the
// icon row (y = 220 logical → 440 @2x), centred in the gap between the app
// (x 180 → 360 @2x) and Applications (x 480 → 960 @2x) icons.
const arrow = Buffer.from(
  `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
     <g fill="none" stroke="${CREAM}" stroke-opacity="0.4"
        stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
       <line x1="556" y1="440" x2="764" y2="440" />
       <polyline points="726,412 768,440 726,468" />
     </g>
   </svg>`,
);

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Light wordmark, sized for a header band. ~480px @2x wide (≈240 logical).
  const wordmark = await sharp(WORDMARK).resize({ width: 480 }).png().toBuffer();
  const wm = await sharp(wordmark).metadata();
  const wmTop = 96;
  const wmLeft = Math.round((W - wm.width) / 2);

  await sharp({
    create: { width: W, height: H, channels: 4, background: INK },
  })
    .composite([
      { input: arrow, top: 0, left: 0 },
      { input: wordmark, top: wmTop, left: wmLeft },
    ])
    .png({ compressionLevel: 9 })
    .toFile(OUT);

  console.log(`wrote ${OUT} (${W}×${H}, ink background + light wordmark + arrow)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
