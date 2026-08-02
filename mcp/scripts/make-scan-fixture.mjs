// Generates test/fixtures/scanned-plan.pdf — the image-only fixture for #154
// (both bundled demo plans are pure vector, so the scanned case ships its own).
// The demo plan's one page is RASTERIZED (pdf.js + @napi-rs/canvas — the same
// machinery view_sheet renders with) and re-wrapped as a PDF whose ONLY
// content is that image: zero vector linework, zero text layer — exactly what
// a flatbed scan of the same sheet exports as. The page keeps the source's
// MediaBox (1224×792 pt), so image-px coordinates carry over 1:1 and the
// vector e2e's room seeds land in the same rooms on the scan.
//
// Byte output is stable for a given pdfjs-dist / @napi-rs/canvas / pdf-lib
// set (pdf-lib metadata stamping is disabled — the CO-1 determinism rule).
// Re-run only to change the fixture:
//   node scripts/make-scan-fixture.mjs
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist";
import { createCanvas, Path2D, DOMMatrix, ImageData } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..", "demo", "sample-plan.pdf");
const OUT = join(HERE, "..", "test", "fixtures", "scanned-plan.pdf");
const SCALE = 2; // render at image-px resolution (pt × 2) — a ~144 DPI scan

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
const page = await doc.getPage(1);
const vp1 = page.getViewport({ scale: 1 });
const vp = page.getViewport({ scale: SCALE });
const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, background: "#ffffff" }).promise;
const png = canvas.toBuffer("image/png");
await doc.destroy();

const out = await PDFDocument.create({ updateMetadata: false }); // no wall-clock stamps — same input, same bytes
const img = await out.embedPng(png);
const sheet = out.addPage([vp1.width, vp1.height]);
sheet.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
const saved = await out.save();

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, saved);
console.log(`wrote ${OUT} (${saved.length} bytes, image ${canvas.width}×${canvas.height})`);
