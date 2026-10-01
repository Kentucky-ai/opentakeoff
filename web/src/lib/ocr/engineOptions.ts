// What shapes an on-device OCR read (#469, #471, #481): the options the
// worker passes ppu-paddle-ocr's PaddleOcrService, the read's DPI, raster cap
// and tile overlap, and the ink preprocessing (ink.ts) of the copy of each
// tile that ppu's recognition reads. A leaf with NO imports, so the OCR page
// cache (pageCache.ts, which keys stored reads on these) never depends on a
// bundler shaking workerCore.ts down to one constant. The values repeat
// their sources (raster.ts OCR_DETECTION_PADDING, scheduleScan.ts
// SCAN_MAX_DIM, rasterize.ts OCR_TARGET_DPI, seams.ts planTiles' overlap
// default and SEAM_RULES_VERSION); test/ocrPageCache.test.ts pins each copy
// to its source.

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
/** The ink preprocessing of a read: split, detection on the tile as
 * rendered and recognition on a copy grayed by ink.ts inkToGray (Rec. 601
 * luma into R, G and B for pixels with chroma ≥ 24, each channel ramped
 * toward it from chroma 8, near-neutral pixels untouched). A page read saved
 * under other preprocessing is a cache miss: reads from before #481 lack red
 * ink. */
export const OCR_INK = "split-luma601-c8-24";

/** What the core passes ppu's PaddleOcrService besides the model buffers. */
export interface EngineOptions {
  detection: { paddingVertical: number; paddingHorizontal: number; maxSideLength: number };
  recognition: { maxCropSourceSideLength: number };
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
export const OCR_ENGINE_OPTIONS: EngineOptions = {
  detection: { paddingVertical: 0.4, paddingHorizontal: 0.6, maxSideLength: OCR_SCAN_MAX_DIM },
  recognition: { maxCropSourceSideLength: OCR_SCAN_MAX_DIM },
  session: { logSeverityLevel: 3, executionProviders: ["cpu"] },
};
