// On-device OCR geometry (#469): the crop-px ↔ image-px map every OCR word
// passes through, the render factor that reaches the measured 216 DPI inside
// the canvas and scan caps, and the shared cache key the main thread and the
// worker both use. All pure; the DOM render itself is verified in the browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDims, cropBoxToWord, unpadCropBox, OCR_DETECTION_PADDING, type CropBox, type RenderGeometry } from "../src/lib/ocr/raster.ts";
import { wordsToTokens, type OcrWord } from "../src/lib/ocr/types.ts";
import { ocrRenderFactor, OCR_TARGET_DPI } from "../src/lib/ocr/rasterize.ts";
import { SCAN_MAX_DIM } from "../src/lib/scheduleScan.ts";
import { RENDER_SCALE } from "../src/lib/takeoffConstants.ts";
import { cacheKey, cacheName } from "../src/lib/ocr/manifest.ts";

// ── crop-px ↔ image-px ───────────────────────────────────────────────────────

test("renderDims scales the rect by zoom", () => {
  const g: RenderGeometry = { rect: { x0: 100, y0: 50, x1: 1100, y1: 550 }, zoom: 2 };
  assert.deepEqual(renderDims(g), { width: 2000, height: 1000 });
  assert.deepEqual(renderDims({ ...g, zoom: 1 }), { width: 1000, height: 500 });
});

// ppu-paddle-ocr 6.6.0 pads every detected box before it crops it for
// recognition, and returns that padded box. In a browser its detector runs
// the "canvas-native" engine (web/detection.service.web.js), whose padding
// is ppu-ocv 4.0.0 canvas-regions.js detectRegions, replicated here:
//   let bboxH=y1-y0; let vPad=Math.round(bboxH*(padding.vertical??0));
//   let hPad=Math.round(bboxH*(padding.horizontal??0));
//   x0=Math.max(0,x0-hPad); y0=Math.max(0,y0-vPad);
//   x1=Math.min(width,x1+hPad); y1=Math.min(height,y1+vPad)
//   if(scale!==1){x0=Math.max(0,Math.round(x0*scale)); ... x1=Math.round(x1*scale); ...}
// then core/detection/box-geometry.js extractBoxesFromRegions clips the
// box to the crop (x+width ≤ originalWidth). `ink` is the detected region in
// detection-map px; the map is the crop resized by `ratio`, padded up to a
// multiple of 32.
function ppuPaddedBox(ink: CropBox, crop: { width: number; height: number }, ratio: number, pad = OCR_DETECTION_PADDING): CropBox {
  const mapW = Math.ceil(Math.round(crop.width * ratio) / 32) * 32;
  const mapH = Math.ceil(Math.round(crop.height * ratio) / 32) * 32;
  const bboxH = ink.y1 - ink.y0;
  const vPad = Math.round(bboxH * pad.vertical), hPad = Math.round(bboxH * pad.horizontal);
  let x0 = Math.max(0, ink.x0 - hPad), y0 = Math.max(0, ink.y0 - vPad);
  let x1 = Math.min(mapW, ink.x1 + hPad), y1 = Math.min(mapH, ink.y1 + vPad);
  const scale = 1 / ratio;
  if (scale !== 1) {
    x0 = Math.max(0, Math.round(x0 * scale)); y0 = Math.max(0, Math.round(y0 * scale));
    x1 = Math.round(x1 * scale); y1 = Math.round(y1 * scale);
  }
  return { x0, y0, x1: Math.min(crop.width, x1), y1: Math.min(crop.height, y1) };
}
const inCrop = (ink: CropBox, ratio: number): CropBox => ({ x0: ink.x0 / ratio, y0: ink.y0 / ratio, x1: ink.x1 / ratio, y1: ink.y1 / ratio });

test("ppu's padding is ours to set: 0.4 of the box height above and below, 0.6 left and right", () => {
  assert.deepEqual(OCR_DETECTION_PADDING, { vertical: 0.4, horizontal: 0.6 });
});

test("unpadCropBox undoes ppu's padding at full size", () => {
  const crop = { width: 800, height: 600 };
  const ink = { x0: 100, y0: 50, x1: 160, y1: 71 };
  const padded = ppuPaddedBox(ink, crop, 1);
  assert.deepEqual(padded, { x0: 87, y0: 42, x1: 173, y1: 79 }, "ppu's own numbers");
  const back = unpadCropBox(padded, crop, OCR_DETECTION_PADDING);
  for (const k of ["x0", "y0", "x1", "y1"] as const) assert.ok(Math.abs(back[k] - ink[k]) <= 1, `${k}: ${back[k]} vs ${ink[k]}`);
});

test("unpadCropBox undoes ppu's padding when the detector downsized the crop", () => {
  // The worker's settings (SCAN_MAX_DIM, the most a crop can be) keep ppu
  // from shrinking the crop, but the math holds if it ever does: with ppu's
  // "auto" side, a 2400 px crop goes to clamp(round(0.75·2400/32)·32, 960, 1920) = 1792.
  const crop = { width: 2400, height: 1200 };
  const ratio = 1792 / 2400;
  const tol = 1 / ratio + 1; // rounding in map px, then again after scaling up
  for (const ink of [{ x0: 300, y0: 200, x1: 390, y1: 216 }, { x0: 40, y0: 700, x1: 44, y1: 709 }, { x0: 1000, y0: 30, x1: 1400, y1: 60 }]) {
    const truth = inCrop(ink, ratio);
    const back = unpadCropBox(ppuPaddedBox(ink, crop, ratio), crop, OCR_DETECTION_PADDING);
    for (const k of ["x0", "y0", "x1", "y1"] as const) assert.ok(Math.abs(back[k] - truth[k]) <= tol, `${JSON.stringify(ink)} ${k}: ${back[k]} vs ${truth[k]}`);
  }
});

test("a box ppu clipped at the crop edge stays inside the crop with a real size", () => {
  // The clipped side's padding can't be recovered; the unclipped sides still are.
  const crop = { width: 400, height: 300 };
  const cases: CropBox[] = [
    { x0: 2, y0: 3, x1: 60, y1: 23 },         // top-left corner
    { x0: 350, y0: 285, x1: 398, y1: 299 },   // bottom-right corner
  ];
  for (const ink of cases) {
    const back = unpadCropBox(ppuPaddedBox(ink, crop, 1), crop, OCR_DETECTION_PADDING);
    assert.ok(back.x0 >= 0 && back.y0 >= 0 && back.x1 <= crop.width && back.y1 <= crop.height, JSON.stringify(back));
    assert.ok(back.x1 > back.x0 && back.y1 > back.y0, JSON.stringify(back));
  }
  const tl = unpadCropBox(ppuPaddedBox(cases[0], crop, 1), crop, OCR_DETECTION_PADDING);
  assert.ok(Math.abs(tl.y1 - 23) <= 2 && Math.abs(tl.x1 - 60) <= 2, `unclipped sides: ${JSON.stringify(tl)}`);
});

test("a word read through ppu's padded box lands where the ink is on the sheet", () => {
  const g: RenderGeometry = { rect: { x0: 2300, y0: 250, x1: 3100, y1: 750 }, zoom: 1.5 };
  const crop = renderDims(g);
  const truth: OcrWord = { str: "CPT-1", x: 2600, y: 469, w: 48, h: 12 };
  const ink = {
    x0: (truth.x - g.rect.x0) * g.zoom, y0: (truth.y - truth.h - g.rect.y0) * g.zoom,
    x1: (truth.x + truth.w - g.rect.x0) * g.zoom, y1: (truth.y - g.rect.y0) * g.zoom,
  };
  const word = cropBoxToWord(truth.str, unpadCropBox(ppuPaddedBox(ink, crop, 1), crop, OCR_DETECTION_PADDING), g);
  for (const k of ["x", "y", "w", "h"] as const) assert.ok(Math.abs(word[k] - truth[k]) <= 1, `${k}: ${word[k]} vs ${truth[k]}`);
});

test("cropBoxToWord at zoom 1.5: x is the left edge, y the box bottom, h its height", () => {
  // Convention only. How far the ink box's bottom sits from the text layer's
  // baseline is measured in the browser, not asserted here.
  const g: RenderGeometry = { rect: { x0: 100, y0: 200, x1: 400, y1: 500 }, zoom: 1.5 };
  const w = cropBoxToWord("VCT", { x0: 30, y0: 60, x1: 90, y1: 81 }, g);
  assert.equal(w.x, 100 + 30 / 1.5);
  assert.equal(w.y, 200 + 81 / 1.5);
  assert.equal(w.w, 60 / 1.5);
  assert.equal(w.h, 21 / 1.5);
});

test("cropBoxToWord carries confidence only when given", () => {
  const g: RenderGeometry = { rect: { x0: 0, y0: 0, x1: 100, y1: 100 }, zoom: 1 };
  assert.equal(cropBoxToWord("X", { x0: 0, y0: 0, x1: 10, y1: 10 }, g, 0.9).confidence, 0.9);
  assert.equal("confidence" in cropBoxToWord("X", { x0: 0, y0: 0, x1: 10, y1: 10 }, g), false);
});

test("wordsToTokens keeps the parser's {str,x,y,h} and drops w and confidence", () => {
  assert.deepEqual(wordsToTokens([{ str: "A", x: 1, y: 2, w: 3, h: 4, confidence: 0.5 }]), [{ str: "A", x: 1, y: 2, h: 4 }]);
});

// ── render factor ────────────────────────────────────────────────────────────

test("the OCR render reaches 216 DPI from the canvas's 144 DPI render scale", () => {
  assert.equal(OCR_TARGET_DPI, 216);
  // RENDER_SCALE 2 = 144 DPI, so 216 DPI is a factor of 1.5 over the rs-px region
  assert.equal(ocrRenderFactor(RENDER_SCALE, 1000, 800), 1.5);
  // a lower page render scale needs a bigger factor for the same DPI
  assert.equal(ocrRenderFactor(1, 500, 500), 3);
  assert.equal(ocrRenderFactor(RENDER_SCALE, 1000, 800, { dpi: 288 }), 2);
});

test("the render factor respects the scan side cap, so the AI fallback can reuse the raster", () => {
  const f = ocrRenderFactor(RENDER_SCALE, 2750, 1750);
  assert.ok(Math.round(2750 * f) <= SCAN_MAX_DIM);
  assert.ok(f > 1.45 && f < 1.5);
  // a whole-sheet box shrinks below 1
  assert.ok(Math.round(6048 * ocrRenderFactor(RENDER_SCALE, 6048, 4320)) <= SCAN_MAX_DIM);
  assert.equal(ocrRenderFactor(RENDER_SCALE, 1000, 800, { maxDim: 1000 }), 1);
});

test("the render factor respects the canvas side and area caps", () => {
  assert.equal(ocrRenderFactor(RENDER_SCALE, 1000, 800, { maxDim: 1e9, maxCanvasDim: 1200 }), 1.2);
  const f = ocrRenderFactor(RENDER_SCALE, 1000, 1000, { maxDim: 1e9, maxCanvasArea: 1e6 });
  assert.ok(Math.abs(f - 1) < 1e-12);
});

test("a degenerate region still gets a finite factor", () => {
  assert.ok(Number.isFinite(ocrRenderFactor(RENDER_SCALE, 0, 0)));
});

// ── cache keys ───────────────────────────────────────────────────────────────

test("cache keys are synthetic, content-addressed and independent of the fetch url", () => {
  const sha = "a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d";
  assert.equal(cacheKey({ name: "det", url: "/models/ocr/det.onnx", bytes: 1, sha256: sha }), "/models/ocr/det-a431985659dc.onnx");
  assert.equal(cacheKey({ name: "det", url: "/elsewhere/x", bytes: 1, sha256: sha }), "/models/ocr/det-a431985659dc.onnx");
  assert.equal(cacheKey({ name: "ort-wasm", bytes: 1, sha256: sha }), "/models/ocr/ort-wasm-a431985659dc.wasm");
  assert.equal(cacheKey({ name: "dict", url: "/models/ocr/dict.txt", bytes: 1, sha256: sha }), "/models/ocr/dict-a431985659dc.txt");
  assert.equal(cacheName("ppocrv5-mobile-en-1+ort-1.26.0"), "opentakeoff-ocr-ppocrv5-mobile-en-1+ort-1.26.0");
});
