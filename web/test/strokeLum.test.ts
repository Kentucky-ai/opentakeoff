// Per-segment stroke luminance (#260, reported by @FrankAtGHub): extraction in
// the content-stream walk, and the STATED gate that consumes it in
// symbolsweep. The case it exists for is a flattened export — no OCGs, every
// segment at one pen — where the only thing left distinguishing a fixture
// outline from the ceiling grid it sits on is that one is black and the other
// is grey, and the pipeline used to drop that before anything could see it.
//
// The invariants:
//   - stroke color is graphics state: save/restore and form XObjects restore
//     it, and it cannot change mid-path (one path, one luminance);
//   - PDF's initial stroke color is black, so an uncolored file reads 0 and
//     costs nothing;
//   - the gate is OFF unless a tolerance is stated — a sweep that states none
//     scores exactly as it did before this existed;
//   - when it is on it is disclosed: the tolerance, the seed's own luminance
//     band, and how many placements it pulled under the commit bar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVectorGeometry, strokeLuminance } from "../src/lib/oneclick.ts";
import { sweepSymbols } from "../src/lib/symbolsweep.ts";

const OPS = {
  save: 1, restore: 2, transform: 3, setLineWidth: 4, setGState: 5,
  constructPath: 10, moveTo: 11, lineTo: 12, curveTo: 13, curveTo2: 14, curveTo3: 15, closePath: 16, rectangle: 17,
  endPath: 20, clip: 21, eoClip: 22, fill: 23, eoFill: 24, stroke: 25,
  beginMarkedContent: 30, beginMarkedContentProps: 31, endMarkedContent: 32,
  paintFormXObjectBegin: 33, paintFormXObjectEnd: 34,
  setStrokeRGBColor: 40,
} as const;
const ID = [1, 0, 0, 1, 0, 0];

type Op = [number, unknown[] | null];
const opList = (ops: Op[]) => ({ fnArray: ops.map((o) => o[0]), argsArray: ops.map((o) => o[1]) });
const line = (x1: number, y1: number, x2: number, y2: number): Op =>
  [OPS.constructPath, [[OPS.moveTo, OPS.lineTo], [x1, y1, x2, y2]]];
const strokeRGB = (r: number, g: number, b: number): Op => [OPS.setStrokeRGBColor, [r, g, b]];

// Rec. 709 on the two colors the field report measured
const GREY = Math.round(0.2126 * 219 + 0.7152 * 219 + 0.0722 * 219);   // 219

test("stroke luminance rides every segment, defaults to black, and is graphics state", () => {
  const geo = extractVectorGeometry(opList([
    line(0, 0, 10, 0),                       // no color op yet → PDF's initial black
    strokeRGB(219, 219, 219),
    line(0, 1, 10, 1),                       // ceiling grid grey
    [OPS.save, null],
    strokeRGB(0, 0, 0),
    line(0, 2, 10, 2),                       // black inside the save
    [OPS.restore, null],
    line(0, 3, 10, 3),                       // restore brings the grey back
    [OPS.paintFormXObjectBegin, [ID, null]],
    strokeRGB(255, 0, 0),
    line(0, 4, 10, 4),                       // red inside the form
    [OPS.paintFormXObjectEnd, null],
    line(0, 5, 10, 5),                       // and the form's end restores grey
  ]), ID, OPS);
  assert.ok(geo.lum, "extraction always emits the channel");
  assert.equal(geo.lum!.length, geo.meta.length, "one byte per segment, the same shape as meta");
  assert.deepEqual([...geo.lum!], [0, GREY, 0, GREY, 54, GREY]);
});

test("a path's segments all carry the color the path was stroked with", () => {
  const geo = extractVectorGeometry(opList([
    strokeRGB(219, 219, 219),
    [OPS.constructPath, [[OPS.moveTo, OPS.lineTo, OPS.lineTo, OPS.closePath], [0, 0, 10, 0, 10, 10]]],
  ]), ID, OPS);
  assert.deepEqual([...geo.lum!], [GREY, GREY, GREY]);
});

test("strokeLuminance reads what pdf.js emits, and refuses what it doesn't", () => {
  assert.equal(strokeLuminance([0, 0, 0]), 0);
  assert.equal(strokeLuminance([255, 255, 255]), 255);
  assert.equal(strokeLuminance([[219, 219, 219]]), 219, "components as one array");
  assert.equal(strokeLuminance([Uint8ClampedArray.from([219, 219, 219])]), 219, "components as one typed array");
  assert.equal(strokeLuminance([1, 1, 1]), 255, "a 0–1 file scales rather than reading as black");
  assert.ok(strokeLuminance([255, 0, 0])! < strokeLuminance([0, 255, 0])!, "Rec. 709, not a mean");
  assert.equal(strokeLuminance(["#ff0000"]), null, "a shape we don't understand leaves the state alone");
  assert.equal(strokeLuminance([]), null);
});

// ── the gate ───────────────────────────────────────────────────────────────
// A synthetic reproduction of the reported case, not the reported sheet: the
// same glyph drawn twice on one sheet, once in black (the device) and once in
// grey (the background structure it is drawn over). Geometrically identical —
// nothing in `segs` separates them — so an ungated sweep counts them all.
const GLYPH: [number, number, number, number][] = [
  [0, 0, 50, 0], [50, 0, 50, 25], [50, 25, 0, 25], [0, 25, 0, 0],   // 50 × 25 outline
  [0, 0, 50, 25],                                                    // one diagonal, so it isn't a bare rect
];
function sheet(blackAt: [number, number][], greyAt: [number, number][]) {
  const segs: number[] = [];
  const lum: number[] = [];
  const place = (ox: number, oy: number, L: number) => {
    for (const [ax, ay, bx, by] of GLYPH) { segs.push(ax + ox, ay + oy, bx + ox, by + oy); lum.push(L); }
  };
  for (const [x, y] of blackAt) place(x, y, 0);
  for (const [x, y] of greyAt) place(x, y, GREY);
  return { segs, lum: Uint8Array.from(lum) };
}
const black: [number, number][] = [[0, 0], [200, 0], [400, 0], [0, 200], [200, 200]];
const grey: [number, number][] = [[0, 400], [200, 400], [400, 400], [600, 400], [0, 600], [200, 600], [400, 600], [600, 600]];

test("a stated luminance tolerance separates the black instances from their grey twins", () => {
  const { segs, lum } = sheet(black, grey);
  const seed: [[number, number], [number, number]] = [[-5, -5], [55, 30]];   // the black glyph at the origin

  const plain = sweepSymbols(segs, seed);
  assert.equal(plain.matches.length + 1, black.length + grey.length,
    `ungated: every twin counts (${plain.matches.length} + the seed)`);
  assert.equal(plain.lum_gate, undefined, "no channel, no tolerance, no gate, nothing to disclose");

  // the channel alone changes NOTHING — carrying it is not consuming it
  const carried = sweepSymbols(segs, seed, { lum });
  assert.deepEqual(carried.matches, plain.matches);
  assert.equal(carried.lum_gate, undefined);

  const gated = sweepSymbols(segs, seed, { lum, lumTol: 32 });
  assert.equal(gated.matches.length, black.length - 1, "only the other black instances survive");
  assert.equal(gated.withheld.length, 0, "and the grey ones are gone, not parked in the near-miss band");
  assert.ok(gated.lum_gate, "a gate that removed matches has to say so");
  assert.equal(gated.lum_gate!.tol, 32);
  assert.deepEqual(gated.lum_gate!.seed_lum, [0], "the seed's own luminance band");
  assert.equal(gated.lum_gate!.rejected, grey.length, "and what it cost, placement by placement");
  assert.equal(gated.lum_gate!.at.length, grey.length, "each one named, so the caller can look");
  for (const [gx, gy] of grey) {
    assert.ok(gated.lum_gate!.at.some(([x, y]) => Math.abs(x - (gx + 25)) < 3 && Math.abs(y - (gy + 12.5)) < 3),
      `the grey twin at ${gx},${gy} is named in the rejection list`);
  }
});

test("the gate is a tolerance, not a color match: a pen that drifted still counts", () => {
  const { segs, lum } = sheet(black, grey);
  // redraw one "black" instance at luminance 20 — a different pen, same intent
  for (let i = 0; i < lum.length; i++) if (lum[i] === 0 && i >= GLYPH.length && i < GLYPH.length * 2) lum[i] = 20;
  const gated = sweepSymbols(segs, [[-5, -5], [55, 30]], { lum, lumTol: 32 });
  assert.equal(gated.matches.length, black.length - 1, "20 is inside a stated 32, so nothing real is lost");
  const tight = sweepSymbols(segs, [[-5, -5], [55, 30]], { lum, lumTol: 8 });
  assert.equal(tight.matches.length, black.length - 2, "and a tighter STATED tolerance drops it, visibly");
  assert.equal(tight.lum_gate!.rejected, grey.length + 1);
});

test("a stated tolerance with no channel gates nothing (the flattened-export fallback is opt-in both ways)", () => {
  const { segs } = sheet(black, grey);
  const seed: [[number, number], [number, number]] = [[-5, -5], [55, 30]];
  assert.deepEqual(sweepSymbols(segs, seed, { lumTol: 32 }).matches, sweepSymbols(segs, seed).matches);
});
