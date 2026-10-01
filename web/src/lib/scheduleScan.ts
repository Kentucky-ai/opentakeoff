// The raster side of "Import from schedule". Nothing here reads a schedule
// yet; it holds the size cap a schedule raster is rendered to.

// Longest side (px) a schedule raster may be. A memory limit: a near-full-sheet
// marquee at render resolution would otherwise allocate a canvas (and the
// pixel buffers read from it) far larger than reading the table needs, so the
// rasterizer downscales to fit and never upscales.
export const SCAN_MAX_DIM = 4096;
