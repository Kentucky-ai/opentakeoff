// Generates web/test/fixtures/hybrid/material-floor-base.png — the raster
// picture of the synthetic hybrid sheet (#489): a vector sheet carrying a
// pasted-in image of a schedule, whose text the text layer can't see. The
// picture is the bundled demo's own MATERIAL SCHEDULE, FLOORING and BASE
// blocks (sample-finish-plan.pdf page 2, x 1490.8–2434.8, y 199.1–448.9 pt
// from the top), rendered at 216 DPI (pdf.js + @napi-rs/canvas, the same
// machinery as make-scan-fixture.mjs). The test builder
// (web/test/fixtures/hybridPlan.ts) places it on demo page 1, so no new plan
// enters the repo.
//
// Only the tag and MATERIAL/PRODUCT columns are kept: everything right of the
// vertical ruling between MATERIAL/PRODUCT and MANUFACTURER (page 2 x =
// 1662.8 pt, 172 pt into the crop; read off the render: the one pixel column
// in that gap dark over most of the crop's height) is painted white before
// encoding, on every row, so the MANUFACTURER column and every column right
// of it (product names, colours, sizes, grout) carry no brand names into the
// fixture (CONTRIBUTING.md). The crop has no column-header row (only the
// FLOORING and BASE titles, left of the ruling), so nothing above the rows
// is spared. The table's horizontal rulings are kept, so the rows still read
// as a schedule. The image stays 944 × 249.8 pt.
//
// Byte output is stable for a given pdfjs-dist / @napi-rs/canvas set; tests
// assert geometry and text, never these pixels. Re-run only to change the
// fixture:
//   node scripts/make-hybrid-png.mjs
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist";
import { createCanvas, Path2D, DOMMatrix, ImageData } from "@napi-rs/canvas";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..", "demo", "sample-finish-plan.pdf");
const OUT = join(HERE, "..", "..", "web", "test", "fixtures", "hybrid", "material-floor-base.png");
const PAGE = 2;
const CROP = { x0: 1490.8, y0: 199.1, x1: 2434.8, y1: 448.9 }; // pt, from the page's top-left
const SCALE = 3; // 216 DPI
const RULE_X = 1662.8; // pt, page 2: the MATERIAL/PRODUCT | MANUFACTURER ruling

// pdf.js's modern build renders against DOM canvas globals bare Node lacks
globalThis.Path2D ??= Path2D;
globalThis.DOMMatrix ??= DOMMatrix;
globalThis.ImageData ??= ImageData;

const requireHere = createRequire(import.meta.url);
const PDFJS_ROOT = path.dirname(requireHere.resolve("pdfjs-dist/package.json"));

const bytes = await readFile(SRC);
const doc = await pdfjs.getDocument({
  data: new Uint8Array(bytes), // getDocument may detach the buffer it is handed
  verbosity: 0,
  standardFontDataUrl: join(PDFJS_ROOT, "standard_fonts") + path.sep,
  isEvalSupported: false,
}).promise;
const page = await doc.getPage(PAGE);
// the viewport's offsets shift the crop's top-left corner to the canvas origin,
// so only the crop is rendered, not the whole 9072 × 6480 px page
const vp = page.getViewport({ scale: SCALE, offsetX: -CROP.x0 * SCALE, offsetY: -CROP.y0 * SCALE });
const canvas = createCanvas(Math.round((CROP.x1 - CROP.x0) * SCALE), Math.round((CROP.y1 - CROP.y0) * SCALE));
const ctx = canvas.getContext("2d");
await page.render({ canvasContext: ctx, viewport: vp, background: "#ffffff" }).promise;

// white over everything right of the ruling, except the horizontal rulings
const { width: W, height: H } = canvas;
const ruleX = Math.round((RULE_X - CROP.x0) * SCALE);
const px = ctx.getImageData(0, 0, W, H).data;
const dark = (x, y) => px[(y * W + x) * 4] < 128;
let colDark = 0;
for (let y = 0; y < H; y++) if (dark(ruleX, y)) colDark++;
if (colDark < H * 0.5) throw new Error(`no vertical ruling at x = ${RULE_X} pt (px ${ruleX}): the demo sheet changed; find the MATERIAL/PRODUCT | MANUFACTURER ruling again`);
const ruling = (y) => { let n = 0; for (let x = 0; x < W; x++) if (dark(x, y)) n++; return n > W * 0.5; };
const keep = Array.from({ length: H }, (_, y) => ruling(y));
ctx.fillStyle = "#ffffff";
const from = ruleX + 2; // past the ruling's one pixel and its antialiasing
for (let y = 0; y < H; y++) if (!keep[y]) ctx.fillRect(from, y, W - from, 1);
const png = canvas.toBuffer("image/png");
await doc.destroy();

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, png);
console.log(`wrote ${OUT} (${png.length} bytes, ${canvas.width}×${canvas.height} px)`);
