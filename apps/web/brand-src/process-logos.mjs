// Derive the theme-aware, transparent logo assets in ../public from the raw
// cream-background source PNGs in this folder.
//
//   node apps/web/brand-src/process-logos.mjs
//
// Source files have a flat cream background and dark ink. For each we emit:
//   <name>.png       transparent bg, original dark ink   -> light theme
//   <name>-dark.png  transparent bg, warm near-white ink -> dark theme
// keying the cream to transparent, trimming the margins, and (for the dark
// variant) recolouring the ink while leaving the orange accent dot intact.
//
// sharp is a transitive dep of Next.js, not a direct one — pnpm keeps it in the
// virtual store and does not hoist it here, so fall back to locating it there.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", ".."); // apps/web/brand-src -> repo root
const PUB = path.join(HERE, "..", "public");

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

const BG = [254, 250, 242]; // sampled cream background
const T_LOW = 16; // <= max-channel distance from cream -> fully transparent
const T_HIGH = 70; // >= -> fully opaque; linear alpha ramp between
const DARK_FG = [237, 233, 225]; // dark-mode ink ~ oklch(0.93 0.015 80)

const maxDist = (r, g, b) =>
  Math.max(Math.abs(r - BG[0]), Math.abs(g - BG[1]), Math.abs(b - BG[2]));
const isOrange = (r, g, b) => r > 140 && r - b > 50; // the accent dot

async function process(srcName, outBase) {
  const { data, info } = await sharp(path.join(HERE, srcName))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const n = width * height;

  const light = Buffer.alloc(n * 4);
  const dark = Buffer.alloc(n * 4);

  for (let p = 0; p < n; p++) {
    const i = p * channels;
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    const d = maxDist(r, g, b);
    const alpha =
      d <= T_LOW ? 0 : d >= T_HIGH ? 255 : Math.round(((d - T_LOW) / (T_HIGH - T_LOW)) * 255);

    const o = p * 4;
    light[o] = r;
    light[o + 1] = g;
    light[o + 2] = b;
    light[o + 3] = alpha;

    if (alpha > 0 && !isOrange(r, g, b)) {
      dark[o] = DARK_FG[0];
      dark[o + 1] = DARK_FG[1];
      dark[o + 2] = DARK_FG[2];
    } else {
      dark[o] = r;
      dark[o + 1] = g;
      dark[o + 2] = b;
    }
    dark[o + 3] = alpha;
  }

  const toPng = (buf, out) =>
    sharp(buf, { raw: { width, height, channels: 4 } })
      .trim({ threshold: 8 })
      .png({ compressionLevel: 9 })
      .toFile(path.join(PUB, out))
      .then((r) => console.log(`  ${out}: ${r.width}x${r.height}, ${r.size} bytes`));

  console.log(srcName, "->");
  await toPng(light, `${outBase}.png`);
  await toPng(dark, `${outBase}-dark.png`);
}

await process("full-logo-wordmark.png", "marens-logo");
await process("wordmark-only.png", "marens-wordmark");

// ---------------------------------------------------------------------------
// App icon. The source is a cream tile with the dark waveform mark — that reads
// on the dark theme but vanishes on the cream light bg, so we emit two rounded,
// theme-aware tiles (each contrasts with its page) plus a square favicon.
//
//   marens-app-icon.png       ink tile, cream mark    -> light theme header
//   marens-app-icon-dark.png  cream tile, dark mark   -> dark theme header
//   ../app/icon.png           square cream tile        -> favicon (Next file convention)
const INK = [31, 36, 48]; // brand ink (sampled from the mark)
const CREAM = [254, 250, 242]; // brand cream (the tile)
const RADIUS_PCT = 0.16; // "a bit" of rounding — a soft app-tile corner
const CREAM_L = 0.299 * CREAM[0] + 0.587 * CREAM[1] + 0.114 * CREAM[2];
const INK_L = 0.299 * INK[0] + 0.587 * INK[1] + 0.114 * INK[2];

async function processAppIcon(srcName) {
  const { data, info } = await sharp(path.join(HERE, srcName))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const n = width * height;

  // Light-theme variant: swap cream<->ink along the luminance ramp so the tile
  // becomes ink and the mark becomes cream, leaving the orange dot untouched.
  const lightVariant = Buffer.alloc(n * 4);
  for (let p = 0; p < n; p++) {
    const i = p * channels;
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    const o = p * 4;
    if (isOrange(r, g, b)) {
      lightVariant[o] = r;
      lightVariant[o + 1] = g;
      lightVariant[o + 2] = b;
    } else {
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      const t = Math.min(1, Math.max(0, (CREAM_L - L) / (CREAM_L - INK_L)));
      lightVariant[o] = Math.round(INK[0] * (1 - t) + CREAM[0] * t);
      lightVariant[o + 1] = Math.round(INK[1] * (1 - t) + CREAM[1] * t);
      lightVariant[o + 2] = Math.round(INK[2] * (1 - t) + CREAM[2] * t);
    }
    lightVariant[o + 3] = 255;
  }

  const r = Math.round(width * RADIUS_PCT);
  const mask = Buffer.from(
    `<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${r}" ry="${r}"/></svg>`,
  );
  const round = (img) =>
    img.composite([{ input: mask, blend: "dest-in" }]).png({ compressionLevel: 9 });

  await round(sharp(lightVariant, { raw: { width, height, channels: 4 } }))
    .toFile(path.join(PUB, "marens-app-icon.png"))
    .then((x) => console.log(`  marens-app-icon.png: ${x.width}x${x.height}`));
  await round(sharp(path.join(HERE, srcName)).ensureAlpha())
    .toFile(path.join(PUB, "marens-app-icon-dark.png"))
    .then((x) => console.log(`  marens-app-icon-dark.png: ${x.width}x${x.height}`));

  // Favicon — square (browsers mask their own corners), downscaled for size.
  await sharp(path.join(HERE, srcName))
    .resize(512, 512)
    .png({ compressionLevel: 9 })
    .toFile(path.join(HERE, "..", "app", "icon.png"))
    .then((x) => console.log(`  ../app/icon.png: ${x.width}x${x.height}`));
}

console.log("light-app-icon.png ->");
await processAppIcon("light-app-icon.png");
console.log("done");
