// OCR raster geometry (#469). Pure and DOM-free: the render itself happens on
// a canvas (rasterize.ts), but the math that maps the engine's crop-pixel
// boxes back to sheet coordinates lives here, tested, and the worker imports
// only this file.
//
// Two spaces:
//   • image px: the sheet rendered at its render scale `rs` (RENDER_SCALE for
//     a normal sheet). Text-layer tokens and marquee rects live here.
//   • crop px: the bitmap the engine sees. Origin at the rect's top-left; one
//     image px is `zoom` crop px.
import type { OcrWord } from "./types";

/** The region an engine was given, and at what magnification. `rect` is in
 * image px at the sheet's render scale `rs`; `zoom` is the render factor
 * RELATIVE TO `rs` (zoom 1.5 on a 144 DPI sheet is 216 DPI). The bitmap is
 * (rect width · zoom) × (rect height · zoom) px. */
export interface RenderGeometry {
  rect: { x0: number; y0: number; x1: number; y1: number };
  zoom: number;
}

/** Bitmap size for a geometry. */
export function renderDims(g: RenderGeometry): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round((g.rect.x1 - g.rect.x0) * g.zoom)),
    height: Math.max(1, Math.round((g.rect.y1 - g.rect.y0) * g.zoom)),
  };
}

/** An engine's word box in crop px: top-left and bottom-right, y down. */
export interface CropBox { x0: number; y0: number; x1: number; y1: number }

/** The padding the worker tells ppu-paddle-ocr to add around each detected
 * text region, as fractions of the region's height: `vertical` above and
 * below, `horizontal` left and right. ppu crops the padded box for the
 * recognizer (the margin helps it read the edge glyphs) and returns that
 * padded box with the text, so unpadCropBox takes it off again. These are
 * ppu 6.6.0's defaults, passed explicitly so this file is the one source.
 * Don't set them to 0: ppu reads `paddingVertical || 0.4`, so 0 means 0.4. */
export const OCR_DETECTION_PADDING = { vertical: 0.4, horizontal: 0.6 } as const;

export interface DetectionPadding { vertical: number; horizontal: number }

/** Undo ppu's padding on a box it returned, in crop px.
 *
 * ppu (web, canvas-native: ppu-ocv detectRegions) pads a region h tall by
 * round(h·vertical) above and below and round(h·horizontal) left and right,
 * in the detector's own map, then scales to crop px and clips to the crop.
 * Unclipped, the padded height is h·(1 + 2·vertical), so h and both pads
 * follow from it. A side clipped at the crop edge lost some of its pad by an
 * unknown amount; it stays on the edge, and h is solved from the other
 * sides. The detector's map is the crop itself: the worker lets ppu's
 * detector take up to SCAN_MAX_DIM px, the most the crop can be, so ppu
 * never shrinks it. ppu rounds each pad and the box to whole px, so each
 * edge is good to about 1 crop px.
 *
 * The result is the detector's text region: the ink, give or take how
 * tightly the detection model draws it. */
export function unpadCropBox(box: CropBox, crop: { width: number; height: number }, pad: DetectionPadding): CropBox {
  const top = box.y0 <= 0, bottom = box.y1 >= crop.height;
  const left = box.x0 <= 0, right = box.x1 >= crop.width;
  const open = (top ? 0 : 1) + (bottom ? 0 : 1);
  const h = (box.y1 - box.y0) / (1 + open * pad.vertical);
  const v = h * pad.vertical, s = h * pad.horizontal;
  const y0 = top ? box.y0 : box.y0 + v, y1 = bottom ? box.y1 : box.y1 - v;
  let x0 = left ? box.x0 : box.x0 + s, x1 = right ? box.x1 : box.x1 - s;
  if (x1 <= x0) { const mid = (box.x0 + box.x1) / 2; x0 = mid; x1 = mid; } // a sliver: keep its centre
  return { x0, y0, x1, y1 };
}

/** Map a crop-px box (already unpadded) to an OcrWord in image px. The box's
 * bottom becomes y, its height h, its left x. */
export function cropBoxToWord(str: string, box: CropBox, g: RenderGeometry, confidence?: number): OcrWord {
  const inv = 1 / g.zoom;
  const w: OcrWord = {
    str,
    x: g.rect.x0 + box.x0 * inv,
    y: g.rect.y0 + box.y1 * inv,
    w: (box.x1 - box.x0) * inv,
    h: (box.y1 - box.y0) * inv,
  };
  if (confidence != null) w.confidence = confidence;
  return w;
}
