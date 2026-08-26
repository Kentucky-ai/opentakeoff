// Pure image-markup geometry — no DOM, no deps, no Date/Math.random. Every helper
// is total (never throws) and guards non-finite / degenerate inputs, so the risky
// canvas/PDF integration math is node-testable in isolation (the winAnsiSafe /
// svgPlacedBox precedent). An `image` markup is `at` (center, normalized 0..1) +
// `w` (a fraction of sheet WIDTH) + a fixed `aspect` (= natural height / width).
//
// WIDTH-ANCHORED, on purpose: the placed box is `bw = w*sheetW`, `bh = bw*aspect`.
// This is DELIBERATELY different from svgPlacedBox (svgpath.js), which scales off
// the LONGEST viewBox extent so a symbol's longest side matches `w`. An image is
// anchored to its width alone — so a tall image (aspect > 1) grows past `w*sheetW`
// in height. The (0.25, 2, 800) → {200, 400} test pins that divergence.

type Rect = { x0: number; y0: number; x1: number; y1: number };
type Pt = { x: number; y: number };

// Width fraction bounds — an image is 2%..200% of sheet width.
const MIN_W = 0.02;
const MAX_W = 2;

// Placed box in target px. bw = clampedW*sheetW, bh = bw*aspect. Guard-fail →
// {0,0} (a caller renders nothing rather than a phantom box). `w` is clamped to
// the [MIN_W, MAX_W] rails HERE so every caller (render, hit-test, export) is
// bounded — an imported/corrupt record with an extreme `w` can't mint a giant box.
export function imagePlacedBox(
  w: number,
  aspect: number,
  sheetW: number,
): { bw: number; bh: number } {
  if (!(w > 0 && Number.isFinite(w) && aspect > 0 && Number.isFinite(aspect) && Number.isFinite(sheetW))) return { bw: 0, bh: 0 };
  const bw = clampImageWidth(w) * sheetW;
  return { bw, bh: bw * aspect };
}

// A marquee rect (image px, any corner order) → image-markup geometry.
// w = |x1-x0|/sheetW, aspect = |y1-y0|/|x1-x0|, at = box center normalized.
// Degenerate width or non-finite sheet dims → {w:0, aspect:0}; at is always
// clamped into [0,1] and finite (never NaN/Infinity).
export function captureRectToImageGeom(
  rect: Rect,
  sheetW: number,
  sheetH: number,
): { at: [number, number]; w: number; aspect: number } {
  const x0 = Number(rect?.x0);
  const y0 = Number(rect?.y0);
  const x1 = Number(rect?.x1);
  const y1 = Number(rect?.y1);
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const okSheet = sheetW > 0 && sheetH > 0 && Number.isFinite(sheetW) && Number.isFinite(sheetH);
  if (!okSheet || !(dx > 0) || !Number.isFinite(dx) || !Number.isFinite(dy)) {
    return { at: [0, 0], w: 0, aspect: 0 };
  }
  const midX = (x0 + x1) / 2;
  const midY = (y0 + y1) / 2;
  return {
    at: [clamp01(midX / sheetW), clamp01(midY / sheetH)],
    w: dx / sheetW,
    aspect: dy / dx,
  };
}

// Resize by dragging the bottom-right corner while the top-left corner (fixedTL)
// stays put. bw = pointerX - fixedTL.x; clamp `w` FIRST, THEN derive bh and the
// new center from the clamped box — so the top-left is invariant even at the
// clamp rails. Cross-axis normalization is explicit: bw over sheetW, bh over
// sheetH (a non-square sheet would expose a width/height swap otherwise).
export function resizeImageFromCorner(
  fixedTL: Pt,
  pointer: Pt,
  aspect: number,
  sheetW: number,
  sheetH: number,
): { w: number; at: [number, number] } {
  // total-function contract: bail to a safe, finite result on degenerate sheet
  // dims or aspect rather than dividing by zero / a non-finite (the call sites
  // always pass a real panel, but the helper guards so it can never mint NaN).
  const tlx = Number(fixedTL?.x), tly = Number(fixedTL?.y);
  if (!(sheetW > 0 && Number.isFinite(sheetW) && sheetH > 0 && Number.isFinite(sheetH) && aspect > 0 && Number.isFinite(aspect))) {
    return { w: clampImageWidth(NaN), at: [0, 0] };
  }
  const w = clampImageWidth((Number(pointer?.x) - tlx) / sheetW);
  const bw = w * sheetW;
  const bh = bw * aspect;
  // NOT clamped to [0,1]: the center may sit past the edge at the clamp rails,
  // which is what keeps the fixed top-left corner invariant during a resize.
  return { w, at: [(tlx + bw / 2) / sheetW, (tly + bh / 2) / sheetH] };
}

// Clamp a width fraction into [MIN_W, MAX_W]; NaN / non-finite → MIN_W.
export function clampImageWidth(w: number): number {
  if (!Number.isFinite(w)) return MIN_W;
  return Math.min(MAX_W, Math.max(MIN_W, w));
}

// aspect = height / width; w<=0 or non-finite → fallback 1 (square).
export function aspectFromDims(w: number, h: number): number {
  if (!(w > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return 1;
  return h / w;
}

// Sniff the embeddable format from a data URL. Only PNG and JPEG round-trip
// (the store re-encodes to one of these); everything else → null (a clean skip,
// never an exception) for the export path and the store-time assertion.
export function pickEmbedFormat(src: string): "jpg" | "png" | null {
  if (typeof src !== "string") return null;
  // EXACT media type, terminated by a `;` param or the `,` before the payload —
  // this is a security gate (render / hit-test / export accept only what it
  // returns), so `data:image/jpeg2000,…` must NOT read as jpeg.
  if (/^data:image\/jpeg[;,]/.test(src)) return "jpg";
  if (/^data:image\/png[;,]/.test(src)) return "png";
  return null;
}

// pdf-lib drawImage parameters that place an image markup's box so its four
// corners land exactly at `toPage(box corner)` — CORRECT ON ROTATED PAGES too.
//
// `toPage` (image px → PDF page points) is a similarity transform: on a plain
// page it is a y-flip + uniform scale; on a rotated source page it also carries
// the page's rotation; on the dark-raster and stitch paths it is a plain y-flip
// (rotation already baked into the frame). drawImage takes a bottom-left ANCHOR
// plus a rotation, so we reconstruct the (possibly rotated) rectangle from three
// mapped corners: anchor at the image's bottom-left, the width axis' angle from
// bottom-left→bottom-right, and the two side lengths measured in page points.
// Because toPage preserves right angles and (being orientation-reversing) sends
// the image's up-direction to +90° of its right-direction — exactly drawImage's
// own height convention — the image never mirrors, at any page rotation.
//
// `toPage(x, y) => [px, py]`; the box is image px: top-left (x0, y0), size bw×bh.
export function imageDrawParams(
  toPage: (x: number, y: number) => [number, number] | number[],
  x0: number,
  y0: number,
  bw: number,
  bh: number,
): { x: number; y: number; width: number; height: number; rotateDeg: number } {
  const bl = toPage(x0, y0 + bh);          // image bottom-left  (PNG's bottom-left pixel)
  const br = toPage(x0 + bw, y0 + bh);      // image bottom-right (the width axis' far end)
  const tl = toPage(x0, y0);               // image top-left     (the height axis' far end)
  const width = Math.hypot(br[0] - bl[0], br[1] - bl[1]);
  const height = Math.hypot(tl[0] - bl[0], tl[1] - bl[1]);
  const rotateDeg = (Math.atan2(br[1] - bl[1], br[0] - bl[0]) * 180) / Math.PI;
  return { x: bl[0], y: bl[1], width, height, rotateDeg };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
