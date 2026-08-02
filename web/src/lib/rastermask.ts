// Raster boundary mask — One-Click on SCANNED plans.
//
// The vector pipeline (oneclick.ts) reads the PDF's linework and is exact, but a
// scanned sheet — or a vector wrapper around a scan image — has no linework to
// read: extractVectorGeometry comes back near-empty and the flood has nothing to
// bound it. This module builds the same MaskObj shape from RENDERED PIXELS
// instead, so floodRegion / traceRegion / rdp run unchanged on scans.
//
// Design (2026-07-09):
// - Grayscale (integer Rec.601), then a POLARITY check: a negative scan
//   (blueprint, white-on-dark) inverts in place so everything downstream is
//   dark-ink-on-light-paper.
// - Bradley–Roth ADAPTIVE MEAN threshold over one Uint32 integral image — not a
//   global threshold. A gray-shaded room interior reads as paper (pixel ≈ local
//   mean) while its edge reads as ink, so shaded rooms flood to their real
//   boundary; a global cut would turn the whole fill into barrier. An ABSOLUTE
//   dark floor keeps solid ink solid: inside a thick black wall band the local
//   mean is also black, and without the floor the band would hollow out.
// - One binary CLOSING (3×3 dilate then erode, separable passes): bridges 1-px
//   scan dropouts (faded ink, JPEG blocking, downsample stipple) without net
//   line thickening — where there is no gap, closing is width-preserving, so the
//   vector path's "no dilation" accuracy story carries over.
// - Text is ACCEPTED as ink: labels become small enclosed islands, the flood
//   goes around them and traceRegion takes the OUTER contour — the same
//   semantics the vector path has for column islands. (A component-size filter
//   was considered and rejected: it would also delete dashed door arcs.)
// - Single tier: everything is bit 1 and softCount is 0, so floodRegion's
//   hatch escalation is structurally disabled (it short-circuits on
//   softCount === 0). A raster hatch analog is a v2 idea: plot mid-gray as
//   bit 2 to give the escalation something to relax.
//
// Pure and DOM-free: takes raw RGBA bytes (not the DOM ImageData type), so node
// tests feed plain typed arrays. The caller renders the sheet at mask scale and
// hands the pixels over — never read the panel canvas (dark mode bakes an
// inversion into those pixels).

import { baselineImgDims } from "./oneclick";
import type { MaskObj, OpList, OpsTable } from "./oneclick";

// ── trigger policy (consumed by the canvas; exported for tests) ─────────────
export const RASTER_MIN_IMG_FRAC = 0.10; // placed-image area ≥ this fraction of the sheet ⇒ raster-eligible
export const RASTER_MIN_SEGS = 500;      // fewer vector segs than this ⇒ the vector mask can't bound rooms

// ── binarization ────────────────────────────────────────────────────────────
export const RASTER_T = 0.15;      // Bradley: ink iff g < (1 − T) × local mean
export const RASTER_ABS_INK = 100; // absolute dark floor — solid fills stay solid
export const RASTER_WIN_MIN = 15;  // adaptive window floor (mask px)
export const RASTER_WIN_DIV = 32;  // window ≈ min(mw,mh)/32, forced odd
export const INVERT_MEAN = 128;    // global mean below this ⇒ negative scan, invert
export const RASTER_RDP_EPS = 2.5; // traceRegion eps for wobbly scan contours (vector uses 1.5)

// ── working-raster scale (audit A1, raster half) ─────────────────────────────
// The vector path's fix (buildMask's basePxPerFt) maps into the BASELINE render
// before choosing the raster, so the mask is a property of the sheet and the
// per-sheet "Hi-Res render" toggle can't move a measurement. The raster path
// used to duplicate the OLD formula inline in the canvas — ws = min(1, maxDim /
// max(imgW, imgH)) against THIS render's bitmap dims, then a pdf.js render at
// `rs * ws`. On any sheet rendering under the cap that collapses to a render at
// `rs`: the same bug, and worse, vector and raster masks of one sheet could sit
// on different grids. rasterMaskScale is the raster analogue of that fix and the
// single place the numbers are chosen, so the two paths cannot drift apart.
//
// THE DPI CEILING — the honest difference between the two paths. The vector mask
// is drawn from linework, so its resolution is free: ask for more mask px and you
// get more real detail. The raster mask is thresholded from a RENDERED BITMAP of
// a scan, and a scan has a fixed number of real pixels. Rendering the page above
// the scan's own resolution resamples pixels that don't exist — no new edge
// information, 4× the memory per doubling, and a slower threshold pass over it.
// So the raster mask is clamped at the scan's native resolution when we can
// measure it (scanNativeScale), and says so: `dpiLimited` rides onto the MaskObj
// and the canvas tells the estimator the scan — not the app — set the detail
// level. This is a real ceiling; nothing here makes the raster path
// resolution-free, it only makes it render-INDEPENDENT up to that ceiling.
export const RASTER_MIN_SCAN_DPI = 50;   // floor on the DPI clamp. A mis-measured
// scan — a title-block logo taken for the plan image, an image nested under a
// form matrix we mis-walk — must never shrink the working raster to uselessness.
// Nothing anyone runs through a plotter-scanner is under 50 DPI, so a measurement
// below this is not believable: the floor fires only on a bad measurement, and
// there it hands the decision back to maxDim.

/** What the mask render should be. `vs` is the pdf.js viewport scale to render
 *  at; `mw`/`mh` the mask bitmap; `ws` converts panel-image px AT THIS RENDER to
 *  mask px (what MaskObj.ws means downstream — traceRegion divides by it); `wsBase`
 *  the same for the baseline render. `dpiLimited` = the scan's own resolution,
 *  not maxDim, chose the scale. */
export interface RasterScalePlan {
  vs: number; mw: number; mh: number; ws: number; wsBase: number;
  dpiLimited: boolean; scanDpi: number;
}
export interface RasterScaleInput {
  pageW: number; pageH: number;      // page size in PDF POINTS — the render-free truth
  renderScale: number;               // this sheet's pdf render scale (renderScalesRef)
  baseScale: number;                 // sheets.RENDER_SCALE — the pin
  maxDim: number;                    // oneclick.MASK_MAX_DIM — the working-raster cap
  scanPxPerPt?: number;              // scanNativeScale's answer; 0/absent = unknown ⇒ no clamp
}

/** Choose the mask render for a scanned sheet.
 *
 *  Everything returned except `ws` is computed from the PAGE and the BASELINE
 *  render alone, so it is bit-identical at every render scale; `ws` is just
 *  vs/renderScale — mask px per point over panel px per point — the one number
 *  that has to speak this panel's pixels.
 *
 *  The input is the page in POINTS, deliberately, not the panel's bitmap dims:
 *  the bitmap is a ceil() of pageDim × renderScale, and reconstructing the
 *  baseline from it carries that rounding into the mask, leaving a ±1 px
 *  dependence on the render — the exact class of thing this function exists to
 *  remove. It also keeps `ws` consistent with the app's own px↔feet model
 *  (panelGeometry.uppFor scales strictly with renderScale, ceil ignored). */
export function rasterMaskScale(o: RasterScaleInput): RasterScalePlan {
  const bs = Number.isFinite(o.baseScale) && o.baseScale > 0 ? o.baseScale : 1;
  const rs = Number.isFinite(o.renderScale) && o.renderScale > 0 ? o.renderScale : bs;
  // the BASELINE bitmap — through the shared helper, which is also what
  // buildMask's `page` argument resolves to, so the raster and vector masks of
  // one sheet land on ONE grid rather than on two that agree by coincidence
  // (audit F3: they did not agree — 1224×1584 here vs 1225×1585 there).
  const { w: bW, h: bH } = baselineImgDims(o.pageW, o.pageH, bs);
  const cap = Math.min(1, o.maxDim / Math.max(bW, bH, 1));     // the working-raster cap
  const scanPxPerPt = Number.isFinite(o.scanPxPerPt) && (o.scanPxPerPt as number) > 0 ? (o.scanPxPerPt as number) : 0;
  let wsBase = cap, dpiLimited = false;
  // mask px per point = bs × wsBase; the render invents pixels iff that exceeds
  // the scan's own px per point. Below the believability floor, don't clamp.
  if (scanPxPerPt > 0) {
    const floor = Math.min(cap, RASTER_MIN_SCAN_DPI / 72 / bs);
    const want = Math.max(scanPxPerPt / bs, floor);
    if (want < cap) { wsBase = want; dpiLimited = true; }
  }
  const vs = bs * wsBase;
  return {
    vs,
    mw: Math.max(2, Math.ceil(bW * wsBase)),
    mh: Math.max(2, Math.ceil(bH * wsBase)),
    ws: vs / rs,                       // mask px per panel px at THIS render
    wsBase,
    dpiLimited,
    scanDpi: scanPxPerPt > 0 ? scanPxPerPt * 72 : 0,
  };
}

/** The dominant placed image's NATIVE resolution, in scan px per PDF point.
 *
 *  Walks the same op list extractVectorGeometry walks, but tracks only image
 *  paints and keeps the one with the largest placed area — on a scan wrapper
 *  that is the plan scan itself, not the logo in the title block. `transform`
 *  must be the SCALE-1 viewport transform, so placed sizes come out in points
 *  and the answer is render-independent. pdf.js carries the intrinsic pixel dims
 *  in the op args: paintImageXObject → [objId, w, h]; the inline and image-mask
 *  ops → [imgData] with .width/.height.
 *
 *  Only the SINGULAR paint ops are measured. The *Repeat / *Group folded ops are
 *  runs of small tiles (stipple, glyph-like masks) — never a plan scan — and
 *  giving them a resolution would risk clamping a real scan to a tile's DPI.
 *  Unmeasurable ⇒ { pxPerPt: 0 } ⇒ rasterMaskScale does not clamp at all. */
export interface ScanNative { pxPerPt: number; areaFrac: number; }
export function scanNativeScale(opList: OpList, transform: number[], OPS: OpsTable, pageW: number, pageH: number): ScanNative {
  let m = transform.slice();
  const stack: number[][] = [];
  const mul = (a: number[], b: number[]): number[] => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  const fns = opList.fnArray, A = opList.argsArray;
  let bestArea = 0, bestPxPerPt = 0;
  const consider = (w: number, h: number) => {
    if (!(w > 0) || !(h > 0)) return;
    // the image's unit square maps through m: (m0,m1) is its width edge in
    // points, (m2,m3) its height edge — rotation and mirroring included.
    const pw = Math.hypot(m[0], m[1]), ph = Math.hypot(m[2], m[3]);
    if (pw < 1 || ph < 1) return;                 // sub-point placement — a stamp, not a plan
    const area = Math.abs(m[0] * m[3] - m[1] * m[2]);
    if (area <= bestArea) return;
    bestArea = area;
    // max, not min: the conservative call. Over-reporting the scan's resolution
    // clamps LESS, and an unclamped mask is only wasteful, never wrong.
    bestPxPerPt = Math.max(w / pw, h / ph);
  };
  for (let i = 0; i < fns.length; i++) {
    const fn = fns[i], args = A[i];
    if (fn === OPS.save) stack.push(m.slice());
    else if (fn === OPS.restore) { const p = stack.pop(); if (p) m = p; }
    else if (fn === OPS.transform) m = mul(m, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(m.slice()); if (args && args[0]) m = mul(m, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) { const p = stack.pop(); if (p) m = p; }
    else if (fn === OPS.paintImageXObject) { if (args) consider(args[1], args[2]); }
    else if (fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      const d = args && args[0];
      if (d) consider(d.width, d.height);
    }
  }
  const pageArea = pageW * pageH;
  return { pxPerPt: bestPxPerPt, areaFrac: pageArea > 0 ? Math.min(1, bestArea / pageArea) : 0 };
}

/** `dpiLimited`/`scanDpi` are provenance, not inputs: the canvas passes the
 *  rasterMaskScale verdict through so a trace made at the scan's own ceiling can
 *  SAY so instead of silently measuring a blurrier drawing. */
export interface RasterMaskOpts { t?: number; absInk?: number; bridge?: boolean; dpiLimited?: boolean; scanDpi?: number; }
export interface RasterMaskObj extends MaskObj { dpiLimited?: boolean; scanDpi?: number; }

/** RGBA → 8-bit gray (integer Rec.601) + the global mean (for polarity). */
export function toGray(rgba: Uint8Array | Uint8ClampedArray, n: number): { gray: Uint8Array; mean: number } {
  const gray = new Uint8Array(n);
  let sum = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const g = (77 * rgba[j] + 151 * rgba[j + 1] + 28 * rgba[j + 2]) >> 8;
    gray[i] = g;
    sum += g;
  }
  return { gray, mean: n ? sum / n : 255 };
}

/** Mean gray over the sheet INTERIOR only (excludes a marginFrac border on each
 *  side). A positive (dark-ink-on-light-paper) scan with dark flatbed-bed
 *  margins or scan-software clip padding around the actual page content can
 *  measure "dark on average" under the full-bleed mean and invert wrongly —
 *  paper becomes ink, and every One-Click on that sheet fails. Sampling only
 *  the interior — where the plan content actually lives — is immune to a dark
 *  BORDER; it doesn't fix a genuinely dark interior (a heavy solid-poché
 *  sheet), which remains the documented Area-trace fallback case. Falls back
 *  to the full-frame mean on a sheet too small to have a meaningful interior. */
export function interiorMean(gray: Uint8Array, mw: number, mh: number, marginFrac = 0.12): number {
  const mx = Math.floor(mw * marginFrac), my = Math.floor(mh * marginFrac);
  const x0 = mx, x1 = mw - mx, y0 = my, y1 = mh - my;
  if (x1 <= x0 || y1 <= y0) {
    let sum = 0;
    for (let i = 0; i < gray.length; i++) sum += gray[i];
    return gray.length ? sum / gray.length : 255;
  }
  let sum = 0, count = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * mw;
    for (let x = x0; x < x1; x++) { sum += gray[row + x]; count++; }
  }
  return count ? sum / count : 255;
}

/** Bradley–Roth adaptive mean threshold + absolute dark floor → 1 = ink. */
export function adaptiveThreshold(gray: Uint8Array, mw: number, mh: number, t = RASTER_T, absInk = RASTER_ABS_INK): Uint8Array {
  // integral image, (mw+1)×(mh+1); max sum 3000·3000·255 ≈ 2.3e9 < 2^32
  const iw = mw + 1;
  const integral = new Uint32Array(iw * (mh + 1));
  for (let y = 0; y < mh; y++) {
    let rowSum = 0;
    for (let x = 0; x < mw; x++) {
      rowSum += gray[y * mw + x];
      integral[(y + 1) * iw + (x + 1)] = integral[y * iw + (x + 1)] + rowSum;
    }
  }
  const win = Math.max(RASTER_WIN_MIN, Math.round(Math.min(mw, mh) / RASTER_WIN_DIV)) | 1;
  const half = win >> 1;
  const out = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(mh - 1, y + half);
    for (let x = 0; x < mw; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(mw - 1, x + half);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = integral[(y1 + 1) * iw + (x1 + 1)] - integral[y0 * iw + (x1 + 1)]
        - integral[(y1 + 1) * iw + x0] + integral[y0 * iw + x0];
      const g = gray[y * mw + x];
      if (g < absInk || g * area < sum * (1 - t)) out[y * mw + x] = 1;
    }
  }
  return out;
}

/** One 3×3 binary closing (dilate then erode), each pass separable H then V.
 *  Bridges 1-px gaps; width-preserving where there is no gap. */
export function closeMask(mask: Uint8Array, mw: number, mh: number): Uint8Array {
  const pass = (src: Uint8Array, horizontal: boolean, dilate: boolean): Uint8Array => {
    const dst = new Uint8Array(mw * mh);
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        const i = y * mw + x;
        let a: number, b: number, c: number;
        if (horizontal) {
          a = x > 0 ? src[i - 1] : src[i]; b = src[i]; c = x < mw - 1 ? src[i + 1] : src[i];
        } else {
          a = y > 0 ? src[i - mw] : src[i]; b = src[i]; c = y < mh - 1 ? src[i + mw] : src[i];
        }
        dst[i] = dilate ? (a | b | c) : (a & b & c);
      }
    }
    return dst;
  };
  let m = pass(mask, true, true);   // dilate H
  m = pass(m, false, true);         // dilate V
  m = pass(m, true, false);         // erode H
  m = pass(m, false, false);        // erode V
  return m;
}

/** RGBA pixels already AT mask scale (mw×mh) → single-tier MaskObj (softCount 0).
 *  Drop-in mask source for floodRegion/traceRegion. */
export function buildRasterMask(
  rgba: Uint8Array | Uint8ClampedArray, mw: number, mh: number, ws = 1,
  opts: RasterMaskOpts = {},
): RasterMaskObj {
  const n = mw * mh;
  const { gray } = toGray(rgba, n);
  // interior-only mean for the polarity call (see interiorMean) — a full-bleed
  // mean would wrongly invert a positive scan with dark scan-bed margins
  const polarityMean = interiorMean(gray, mw, mh);
  if (polarityMean < INVERT_MEAN) for (let i = 0; i < n; i++) gray[i] = 255 - gray[i]; // negative scan
  let mask = adaptiveThreshold(gray, mw, mh, opts.t, opts.absInk);
  if (opts.bridge !== false) mask = closeMask(mask, mw, mh);
  return {
    mask, mw, mh, ws, softCount: 0,
    ...(opts.dpiLimited ? { dpiLimited: true } : {}),
    ...(opts.scanDpi ? { scanDpi: opts.scanDpi } : {}),
  };
}
