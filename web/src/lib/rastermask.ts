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

import type { MaskObj } from "./oneclick";

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

export interface RasterMaskOpts { t?: number; absInk?: number; bridge?: boolean; }

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
): MaskObj {
  const n = mw * mh;
  const { gray, mean } = toGray(rgba, n);
  if (mean < INVERT_MEAN) for (let i = 0; i < n; i++) gray[i] = 255 - gray[i]; // negative scan
  let mask = adaptiveThreshold(gray, mw, mh, opts.t, opts.absInk);
  if (opts.bridge !== false) mask = closeMask(mask, mw, mh);
  return { mask, mw, mh, ws, softCount: 0 };
}
