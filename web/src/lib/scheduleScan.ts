// The raster cap for on-device OCR. The OCR rasterizer and worker
// (lib/ocr/, #469) use it. Import from schedule doesn't read a raster
// schedule yet (#470 plans it).

// Longest side (px) an on-device schedule raster may be. A memory limit: a
// near-full-sheet marquee at render resolution would otherwise allocate a
// canvas (and the pixel buffers read from it) far larger than reading the
// table needs.
export const SCAN_MAX_DIM = 4096;
