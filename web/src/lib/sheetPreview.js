export const SHEET_CARD_WIDTH = 640;
export function previewPixelWidth(cssWidth = SHEET_CARD_WIDTH, dpr = 1) {
  const width = Number.isFinite(cssWidth) ? Math.max(1, cssWidth) : SHEET_CARD_WIDTH;
  const density = Number.isFinite(dpr) ? Math.min(2, Math.max(1, dpr)) : 1;
  return Math.min(2400, Math.ceil(width * density));
}
export function previewViewport(page, width) {
  const base = page.getViewport({ scale: 1 });
  const desired = width / base.width;
  // Bound tall scans / pathological page sizes to six million pixels.
  const bounded = Math.min(desired, Math.sqrt(6000000 / (base.width * base.height)));
  return page.getViewport({ scale: bounded });
}
