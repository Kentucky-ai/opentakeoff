// The raster side of "Import from schedule". Nothing reads a raster schedule
// yet, and nothing in the app imports this cap. It's held for an on-device
// raster of a schedule; #469 is the planned user.

// Longest side (px) an on-device schedule raster may be. A memory limit: a
// near-full-sheet marquee at render resolution would otherwise allocate a
// canvas (and the pixel buffers read from it) far larger than reading the
// table needs.
export const SCAN_MAX_DIM = 4096;
