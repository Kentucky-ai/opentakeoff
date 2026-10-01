// Render a marqueed region of a PDF page for on-device OCR (#469).
//
// ocrRenderFactor is pure and tested. rasterizeRegion needs a DOM canvas and
// pdf.js, so it runs only in the browser; importing this file under Node is
// safe because nothing touches the DOM until it's called.
import { SCAN_MAX_DIM } from "../scheduleScan";
import { MAX_CANVAS_AREA, MAX_CANVAS_DIM } from "../canvasConstants.js";
import { renderDims, type RenderGeometry } from "./raster";

// The DPI PaddleOCR read the demo schedule best at, measured while
// prototyping (#466): 144 DPI missed rows, 288 was no better.
//
// The engine sees all of it. ppu's defaults would shrink a large raster
// (detection to at most 1920 px on the long side, recognition crops from a
// 2000 px copy); the worker sets both limits to SCAN_MAX_DIM
// (OCR_ENGINE_OPTIONS), the same cap ocrRenderFactor applies here, so
// neither step resizes what this renders. ppu only pads the detector's input
// up to a multiple of 32 px (core/base-detection.service.js
// preprocessDetection).
export const OCR_TARGET_DPI = 216;
const PDF_POINTS_PER_INCH = 72;

export interface RenderFactorOptions {
  dpi?: number;
  /** longest side of the raster: the AI reader's cap, so it can reuse it */
  maxDim?: number;
  maxCanvasDim?: number;
  maxCanvasArea?: number;
}

/** Render factor relative to `rs` for a regW × regH (rs px) region: reach
 * `dpi`, but stay within the scan side cap and the browser's canvas caps.
 * Above 1 is a real re-render at higher resolution, not a stretch. */
export function ocrRenderFactor(rs: number, regW: number, regH: number, opts: RenderFactorOptions = {}): number {
  const { dpi = OCR_TARGET_DPI, maxDim = SCAN_MAX_DIM, maxCanvasDim = MAX_CANVAS_DIM, maxCanvasArea = MAX_CANVAS_AREA } = opts;
  const w = Math.max(1, regW), h = Math.max(1, regH);
  const target = dpi / (PDF_POINTS_PER_INCH * Math.max(1e-6, rs));
  return Math.min(target, maxDim / w, maxDim / h, maxCanvasDim / w, maxCanvasDim / h, Math.sqrt(maxCanvasArea / (w * h)));
}

export interface RegionRaster {
  width: number;
  height: number;
  /** RGBA pixels; the OCR client transfers this buffer to the worker */
  rgba: Uint8ClampedArray;
  geometry: RenderGeometry;
  /** base64 PNG (no data: prefix), only when asked, for the AI reader */
  png?: string;
}

/** The pdf.js page surface this needs. */
interface PdfPageLike {
  getViewport(o: { scale: number }): unknown;
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown; transform: number[] }): { promise: Promise<unknown> };
}

/** Render `rect` (rs px, any corner order) of `page` for OCR. `png: true` also
 * encodes the same render as PNG, so a caller that falls back to the AI
 * reader doesn't render twice (recognize transfers `rgba` away). */
export async function rasterizeRegion(
  page: PdfPageLike,
  rs: number,
  rect: { x0: number; y0: number; x1: number; y1: number },
  opts: { dpi?: number; png?: boolean } = {},
): Promise<RegionRaster> {
  const x0 = Math.min(rect.x0, rect.x1), y0 = Math.min(rect.y0, rect.y1);
  const regW = Math.max(1, Math.abs(rect.x1 - rect.x0)), regH = Math.max(1, Math.abs(rect.y1 - rect.y0));
  const zoom = ocrRenderFactor(rs, regW, regH, { dpi: opts.dpi });
  const geometry: RenderGeometry = { rect: { x0, y0, x1: x0 + regW, y1: y0 + regH }, zoom };
  const { width, height } = renderDims(geometry);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d canvas context");
  await page.render({
    canvasContext: ctx,
    viewport: page.getViewport({ scale: rs * zoom }),
    transform: [1, 0, 0, 1, -x0 * zoom, -y0 * zoom],
  }).promise;
  const out: RegionRaster = { width, height, rgba: ctx.getImageData(0, 0, width, height).data, geometry };
  if (opts.png) out.png = canvas.toDataURL("image/png").split(",")[1] || "";
  return out;
}
