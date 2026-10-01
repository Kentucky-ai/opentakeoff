// What shapes an on-device OCR read (#469, #471): the options the worker
// passes ppu-paddle-ocr's PaddleOcrService, and the read's DPI, raster cap and
// tile overlap. A leaf with NO imports, so the OCR page cache (pageCache.ts,
// which keys stored reads on these) never depends on a bundler shaking
// workerCore.ts down to one constant. The values repeat their sources
// (raster.ts OCR_DETECTION_PADDING, scheduleScan.ts SCAN_MAX_DIM,
// rasterize.ts OCR_TARGET_DPI, seams.ts planTiles' overlap default and
// SEAM_RULES_VERSION);
// test/ocrPageCache.test.ts pins each copy to its source.

/** The longest raster side the engine is given (scheduleScan SCAN_MAX_DIM). */
export const OCR_SCAN_MAX_DIM = 4096;
/** The DPI a page is read at (rasterize OCR_TARGET_DPI). */
export const OCR_READ_DPI = 216;
/** Tile overlap in PDF points (seams planTiles' default). */
export const OCR_TILE_OVERLAP_PT = 72;
/** The seam rules' version (seams SEAM_RULES_VERSION): a page read saved
 * under other seam rules is a cache miss. */
export const OCR_SEAM_RULES_VERSION = 2;
/** The most tiles one read may take. A 42 × 30 in sheet takes 6; past this
 * a malformed or enormous page would hold the engine for hours. */
export const OCR_MAX_TILES = 64;

/** What the core passes ppu's PaddleOcrService besides the model buffers. */
export interface EngineOptions {
  detection: { paddingVertical: number; paddingHorizontal: number; maxSideLength: number };
  recognition: { maxCropSourceSideLength: number; strategy: "per-box" | "per-line"; recBatchSize: number };
  session: { logSeverityLevel: number; executionProviders: readonly "cpu"[] };
}

// ppu's defaults shrink the page before reading it: detection to 1920 px on
// the long side and recognition crops from a 2000 px copy. On the demo
// schedule as an image-only page, rendered to 4096 × 2607 px (headless
// Chromium on Apple silicon, #469 PR), the defaults found 22 of 28 finish
// tags in about 6.6 s; letting both see the full raster (up to
// SCAN_MAX_DIM) found all 28, none wrong, in about 10.4 to 11.6 s.
// logSeverityLevel 3 (errors only) keeps ORT's per-start "Removing
// initializer" warnings out of the console; the words are the same.
// Execution provider: pinned to "cpu" (ORT's wasm backend) here rather than
// left to ppu's deep-merged default. It is the provider every browser run
// measured (ppu logged `Using user-provided executionProviders: ["cpu"]`);
// forcing WebGPU hung engine start in Chrome, with no speed gain measured.
// The paddings are raster.ts OCR_DETECTION_PADDING (vertical, horizontal).
// Recognition reads each detected box on its own ("per-box"), one crop at a
// time (recBatchSize 1), not ppu's defaults ("per-line", 6), #484. Per-line
// merges a row's boxes into one crop with one confidence, so a whole row is
// misread or dropped under the 0.5 floor (ppu's minimumConfidence, kept: at 0
// lone "-" and ":" come in); in batches of 6, short standalone lines come
// back garbled ("TAN I ATANT" at 0.15, "TAN" at 0.99 alone) and are dropped.
// Measured in headless Chromium on the demo plan as image-only pages, both
// sheets: words found again from the text layer 83.6% → 94.5%, distinct finish
// tags 47 → 51 of 52, room numbers 83.5% → 96.1%; Copy of the general notes
// 25 → 30 of 30 lines verbatim and of the schedule 23 → 36 of 36. Per-box
// at batch 6 alone lost notes lines (24 of 30), so it is both or neither.
// Costs: a lone symbol is held to 0.8 (ppu's SYMBOL_CONFIDENCE_OFFSET), and
// a space inside a short box can go ("2' x 2'" read as "2'x2'"). Time per
// page is about the same or less: in the app, the median of 4 reads per
// sheet went 41.7 → 40.0 s and 49.5 → 42.6 s (one earlier read ran on a
// loaded machine and is included; the diagnosis harness's single runs, on a
// loaded machine, had per-box 6–30% slower).
export const OCR_ENGINE_OPTIONS: EngineOptions = {
  detection: { paddingVertical: 0.4, paddingHorizontal: 0.6, maxSideLength: OCR_SCAN_MAX_DIM },
  recognition: { maxCropSourceSideLength: OCR_SCAN_MAX_DIM, strategy: "per-box", recBatchSize: 1 },
  session: { logSeverityLevel: 3, executionProviders: ["cpu"] },
};
