// OCR ink preprocessing (#481): the gated luma pass the worker runs on the
// copy of each tile that ppu's recognition reads, and a pin on the ppu
// function that makes it necessary. ppu-paddle-ocr 6.6.0's canvas-native
// recognition builds its tensor from the R byte alone
// (core/recognition/image-tensor.js), so red ink read as paper. Near-neutral
// pixels are left byte-identical; detection never sees this pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { INK_FULL_AT, INK_NEUTRAL_MAX, OCR_INK, inkToGray } from "../src/lib/ocr/ink.ts";
import { OCR_INK as ENGINE_OCR_INK } from "../src/lib/ocr/engineOptions.ts";
// The package's exports map doesn't expose this subpath, so it's imported by
// path: the function every web recognition crop goes through.
import { createImageTensorFromCanvas } from "../node_modules/ppu-paddle-ocr/core/recognition/image-tensor.js";

const px = (...rgba: number[][]) => new Uint8ClampedArray(rgba.flat());
const gray = (rgb: number[]) => { const a = px([...rgb, 255]); inkToGray(a); return [...a]; };

const RED = [220, 30, 30, 255];
const BLUE = [30, 60, 200, 255];
const GREEN = [0, 128, 0, 255];
const GRAY = [150, 150, 150, 255];
const PURE_RED = [255, 0, 0, 255];
const MAGENTA = [255, 0, 255, 255];

test("the gate's thresholds: untouched through chroma 8, full luma from chroma 24", () => {
  assert.equal(INK_NEUTRAL_MAX, 8);
  assert.equal(INK_FULL_AT, 24);
});

test("inkToGray: saturated pixels get Rec. 601 luma in R, G and B, rounded, alpha kept", () => {
  const a = px(RED, BLUE, PURE_RED, MAGENTA);
  assert.equal(inkToGray(a), true);
  // 0.299·220 + 0.587·30 + 0.114·30 = 86.81
  assert.deepEqual([...a.subarray(0, 4)], [87, 87, 87, 255]);
  // 66.99: rounds to 67; the integer (77R + 150G + 29B) >> 8 gives 66
  assert.deepEqual([...a.subarray(4, 8)], [67, 67, 67, 255]);
  // 0.299·255 = 76.245
  assert.deepEqual([...a.subarray(8, 12)], [76, 76, 76, 255]);
  // 0.299·255 + 0.114·255 = 105.315
  assert.deepEqual([...a.subarray(12, 16)], [105, 105, 105, 255]);
});

test("inkToGray: near-neutral pixels (chroma ≤ 8) are byte-identical", () => {
  const a = px([250, 245, 242, 255], [100, 104, 96, 255], [255, 255, 255, 255], [0, 0, 0, 255], [8, 0, 0, 255], [0, 8, 8, 77]);
  const before = [...a];
  inkToGray(a);
  assert.deepEqual([...a], before);
});

test("inkToGray returns false for a tile with no pixel above chroma 8, true when any pixel is", () => {
  assert.equal(inkToGray(px([250, 245, 242, 255], [0, 0, 0, 255], [8, 0, 0, 255])), false);
  assert.equal(inkToGray(new Uint8ClampedArray(0)), false);
  assert.equal(inkToGray(px([255, 255, 255, 255], RED)), true);
  // chroma 9 rounds back to its own bytes but is still past the gate: the
  // caller makes a second canvas it didn't strictly need, never too few
  const a = px([255, 246, 246, 255]);
  assert.equal(inkToGray(a), true);
  assert.deepEqual([...a], [255, 246, 246, 255]);
});

test("inkToGray: a sweep of every chroma ≤ 8 pixel near sampled bases is byte-identical", () => {
  const pixels: number[] = [];
  for (let base = 0; base <= 247; base += 13)
    for (let dr = 0; dr <= 8; dr++)
      for (let dg = 0; dg <= 8; dg++)
        for (let db = 0; db <= 8; db++) pixels.push(base + dr, base + dg, base + db, (base + dr) & 255);
  const a = new Uint8ClampedArray(pixels);
  inkToGray(a);
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== pixels[i]) changed++;
  assert.equal(changed, 0);
  assert.equal(pixels.length, 20 * 9 * 9 * 9 * 4);
});

test("inkToGray: every neutral gray maps to itself", () => {
  const a = new Uint8ClampedArray(256 * 4);
  for (let v = 0; v < 256; v++) a.set([v, v, v, 255], v * 4);
  inkToGray(a);
  const wrong: number[] = [];
  for (let v = 0; v < 256; v++) if (a[v * 4] !== v || a[v * 4 + 1] !== v || a[v * 4 + 2] !== v) wrong.push(v);
  assert.deepEqual(wrong, []);
});

test("inkToGray: chroma 16 moves each channel halfway to luma", () => {
  // (200, 192, 184): c = 16, w = 0.5; Y = 59.8 + 112.704 + 20.976 = 193.48
  // R: 200 + 0.5·(193.48 − 200) = 196.74 → 197
  // G: 192 + 0.5·(193.48 − 192) = 192.74 → 193
  // B: 184 + 0.5·(193.48 − 184) = 188.74 → 189
  assert.deepEqual(gray([200, 192, 184]), [197, 193, 189, 255]);
});

test("inkToGray: chroma 9 moves each channel 1/16 of the way to luma", () => {
  // (255, 246, 246): Y = 76.245 + 0.701·246 = 248.691, w = 1/16
  // R: 255 − 6.309/16 = 254.61 → 255; G, B: 246 + 2.691/16 = 246.17 → 246.
  // The pixel stays as rendered (G and B are not lifted to R).
  assert.deepEqual(gray([255, 246, 246]), [255, 246, 246, 255]);
  // (0, 9, 9): Y = 6.309; R: 0.39 → 0; G, B: 9 − 2.691/16 = 8.83 → 9
  assert.deepEqual(gray([0, 9, 9]), [0, 9, 9, 255]);
  // (9, 0, 0): Y = 2.691; R: 9 − 6.309/16 = 8.61 → 9; G, B: 0.17 → 0
  assert.deepEqual(gray([9, 0, 0]), [9, 0, 0, 255]);
});

test("inkToGray: chroma 23 moves each channel 15/16 of the way to luma", () => {
  // (23, 0, 0): Y = 6.877, w = 15/16
  // R: 23 − 16.123·15/16 = 7.88 → 8; G, B: 6.877·15/16 = 6.45 → 6
  assert.deepEqual(gray([23, 0, 0]), [8, 6, 6, 255]);
  // (0, 23, 23): Y = 16.123; R: 16.123·15/16 = 15.12 → 15;
  // G, B: 23 − 6.877·15/16 = 16.55 → 17
  assert.deepEqual(gray([0, 23, 23]), [15, 17, 17, 255]);
});

// p(c) = base + c·d: a gray base and a 0/±1 direction, so p(c) has chroma c.
const DIRS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1]].flatMap((d) => [d, d.map((x) => -x)]);
function along(base: number[], d: number[], c: number): number[] | null {
  const p = base.map((v, i) => v + c * d[i]);
  return p.every((v) => v >= 0 && v <= 255) ? p : null;
}
function stepOK(base: number[], d: number[], from: number, to: number): string | null {
  const a = along(base, d, from), b = along(base, d, to);
  if (!a || !b) return null;
  const ga = gray(a), gb = gray(b);
  for (let i = 0; i < 3; i++) if (Math.abs(ga[i] - gb[i]) > 1) return `${a} → ${ga} vs ${b} → ${gb}`;
  return null;
}

test("inkToGray: stepping chroma 8 → 9 changes no channel by more than 1, in every direction", () => {
  // At c = 9 each channel moves under half a level (|Y − X| ≤ 0.886·9, w =
  // 1/16), so the ramp starts where the untouched band ends.
  const bad: string[] = [];
  let checked = 0;
  for (let v = 0; v <= 255; v++)
    for (const d of DIRS) {
      if (!along([v, v, v], d, 9)) continue;
      checked++;
      const e = stepOK([v, v, v], d, 8, 9);
      if (e) bad.push(e);
    }
  assert.deepEqual(bad.slice(0, 5), []);
  assert.equal(checked, DIRS.length * (256 - 9));
});

test("inkToGray: stepping chroma 23 → 24 along the red axis changes no channel by more than 1", () => {
  // The ramp ends on full luma (w = 1 at c = 24, the same formula). A unit
  // chroma step anywhere in the ramp can move a channel by about 2 in most
  // directions (both w and |Y − X| grow with c), so the check runs where
  // that step is under one level: chroma made by R alone, as with red ink or
  // its anti-aliased edge over gray, (g + c, g, g), and its reverse.
  const bad: string[] = [];
  let checked = 0;
  for (let g = 0; g <= 255; g++)
    for (const d of [[1, 0, 0], [-1, 0, 0]]) {
      const base = [g, g, g];
      if (!along(base, d, 24)) continue;
      checked++;
      const e = stepOK(base, d, 23, 24);
      if (e) bad.push(e);
    }
  assert.deepEqual(bad.slice(0, 5), []);
  assert.equal(checked, 2 * (256 - 24));
});

test("inkToGray: from chroma 24 every channel is luma; up to 8 every byte is kept", () => {
  for (const d of DIRS) {
    const v = d.some((x) => x < 0) ? 200 : 20;
    const base = [v, v, v];
    for (let c = 0; c <= 60; c++) {
      const p = along(base, d, c)!;
      const out = gray(p);
      if (c <= 8) assert.deepEqual(out, [...p, 255], `c=${c} ${p}`);
      if (c >= 24) {
        const y = Uint8ClampedArray.of(0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2])[0];
        assert.deepEqual(out, [y, y, y, 255], `c=${c} ${p}`);
      }
    }
  }
});

test("inkToGray: alpha is untouched and the same array is changed in place", () => {
  const a = px([220, 30, 30, 0], [220, 30, 30, 128], [220, 30, 30, 255]);
  const same = a;
  inkToGray(a);
  assert.equal(a, same);
  assert.deepEqual([...a], [87, 87, 87, 0, 87, 87, 87, 128, 87, 87, 87, 255]);
});

test("inkToGray: a length that isn't whole pixels throws", () => {
  assert.throws(() => inkToGray(new Uint8ClampedArray(7)), RangeError);
  assert.doesNotThrow(() => inkToGray(new Uint8ClampedArray(0)));
});

test("OCR_INK is engineOptions' value, the one the page cache keys on", () => {
  assert.equal(OCR_INK, ENGINE_OCR_INK);
});

test("OCR_INK names the pass's thresholds: change one and the cache key must change with it", () => {
  assert.equal(OCR_INK, `split-luma601-c${INK_NEUTRAL_MAX}-${INK_FULL_AT}`);
});

// A one-pixel canvas that hands ppu `rgba` back from getImageData.
function canvasOf(rgba: Uint8ClampedArray) {
  const canvas = { width: 1, height: 1, getContext: () => ({ getImageData: () => ({ data: rgba }) }) };
  return canvas as unknown as Parameters<typeof createImageTensorFromCanvas>[0];
}
/** ppu's recognition tensor value for one pixel (all three channels equal). */
function tensorOf(rgba: number[]): number {
  const t = createImageTensorFromCanvas(canvasOf(new Uint8ClampedArray(rgba)), 1, 1);
  assert.equal(t[0], t[1]);
  assert.equal(t[0], t[2]);
  return t[0];
}
function tensorAfterInkToGray(rgba: number[]): number {
  const a = new Uint8ClampedArray(rgba);
  inkToGray(a);
  return tensorOf([...a]);
}

test("ppu pin: its recognition tensor reads red ink as near paper (the bug)", () => {
  // If this fails, ppu reads more than R now: rethink whether inkToGray is
  // still needed, and what it does to colored ink.
  assert.ok(tensorOf(RED) > 0.5, String(tensorOf(RED)));
});

test("ppu pin: pure red (255, 0, 0) is exactly paper to ppu, and ink after inkToGray", () => {
  assert.equal(tensorOf(PURE_RED), tensorOf([255, 255, 255, 255]));
  assert.equal(tensorOf(PURE_RED), 1);
  assert.ok(tensorAfterInkToGray(PURE_RED) < 0, String(tensorAfterInkToGray(PURE_RED)));
  assert.ok(tensorAfterInkToGray(MAGENTA) < 0, String(tensorAfterInkToGray(MAGENTA)));
});

test("ppu pin: after inkToGray red is ink, gray is unchanged, blue and green stay ink", () => {
  assert.ok(tensorAfterInkToGray(RED) < 0, String(tensorAfterInkToGray(RED)));
  assert.equal(tensorAfterInkToGray(GRAY), tensorOf(GRAY));
  // lighter than before (the trade), still well on the ink side
  assert.ok(tensorAfterInkToGray(BLUE) < -0.3, String(tensorAfterInkToGray(BLUE)));
  assert.ok(tensorAfterInkToGray(GREEN) < -0.3, String(tensorAfterInkToGray(GREEN)));
});
