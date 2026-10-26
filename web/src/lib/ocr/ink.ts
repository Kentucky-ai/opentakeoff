// The ink preprocessing for OCR recognition (#481). ppu 6.6.0's web build
// recognizes with its canvas-native path, and createImageTensorFromCanvas
// (core/recognition/image-tensor.js) builds the recognition tensor from the
// R byte alone, copied into G and B. Pure red (255, 0, 0) and magenta have
// R = 255, identical to paper, so recognition read them as paper: an empty
// string the worker drops. Writing the pixel's Rec. 601 luma into R, G and B
// gives ppu's R byte the ink's brightness.
//
// Recognition only. The worker runs this on a copy of the tile that only
// recognition reads; detection (core/detection/image-tensor.js reads R, G
// and B) gets the tile as rendered, and given that, it does box pure red
// and magenta text. Detection reacts to changed colored pixels: graying
// the tile it read flipped reads of nearby black text, both ways (measured
// in the browser). Split this way, the bundled demo sheet read every line
// with the same text in the same box as without the pass.
//
// The pass is gated on chroma, c = max(R, G, B) − min(R, G, B). Neutral and
// near-neutral pixels (c ≤ INK_NEUTRAL_MAX: black, gray, paper) are left
// byte-identical. Colored pixels (c ≥ INK_FULL_AT) get luma in all three
// channels. In between, each channel moves its own way toward luma by the
// same weight, rising linearly with c, so each channel is continuous in w: at
// c = 9 a channel moves under half a level (it rounds back to its own value),
// and at c = 24 the weight reaches 1, the same as full luma. A unit step in
// chroma inside the ramp can still move a channel by about two levels.
//
// What it trades, in recognition only: blue and green ink get full luma and
// read lighter than they did from R alone (still ink, with less contrast); a
// yellow highlight becomes light gray background and a saturated cyan fill
// mid-gray instead of solid ink.
//
// OCR_INK names this pass in the page cache key (engineOptions.ts, a leaf);
// change the pass, change OCR_INK.
export { OCR_INK } from "./engineOptions";

/** Chroma at or below this leaves the pixel untouched. */
export const INK_NEUTRAL_MAX = 8;
/** Chroma at or above this gets full luma. */
export const INK_FULL_AT = 24;

/** Gray the colored pixels of an RGBA tile in place for ppu's recognition.
 * Per pixel, with chroma c = max − min of R, G, B and
 * Y = 0.299R + 0.587G + 0.114B:
 * c ≤ INK_NEUTRAL_MAX leaves all four bytes as they are; otherwise each of
 * R, G and B becomes X + w·(Y − X) for its own value X, with
 * w = (c − INK_NEUTRAL_MAX) / (INK_FULL_AT − INK_NEUTRAL_MAX) capped at 1,
 * so c ≥ INK_FULL_AT gives R = G = B = Y. The clamped array rounds to the
 * nearest byte; alpha is kept. Returns true when any pixel had chroma above
 * INK_NEUTRAL_MAX (even if rounding kept its bytes), false when the tile is
 * untouched. Throws a RangeError when the length isn't a whole number of
 * pixels. */
export function inkToGray(rgba: Uint8ClampedArray): boolean {
  if (rgba.length % 4 !== 0) throw new RangeError(`RGBA length ${rgba.length} is not a multiple of 4`);
  const ramp = INK_FULL_AT - INK_NEUTRAL_MAX;
  let colored = false;
  for (let p = 0; p < rgba.length; p += 4) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    const c = Math.max(r, g, b) - Math.min(r, g, b);
    if (c <= INK_NEUTRAL_MAX) continue;
    colored = true;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const w = Math.min(1, (c - INK_NEUTRAL_MAX) / ramp);
    rgba[p] = r + w * (y - r);
    rgba[p + 1] = g + w * (y - g);
    rgba[p + 2] = b + w * (y - b);
  }
  return colored;
}
