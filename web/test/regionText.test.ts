// extractRegionText — the marquee → tokens step both Import-from-schedule and
// Copy text (#471) read through. A pdf.js-shaped viewport (y flipped, scale 2)
// so the angle formula and the width → px conversion are both exercised.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRegionText } from "../src/lib/sheets";
import { assembleLines, linesToText } from "../src/lib/textlines";

const H = 1000;   // page height in points; image y = H·2 − 2·y
const VP = { width: 1200, height: H * 2, transform: [2, 0, 0, -2, 0, H * 2] } as never;
// font size 10pt, horizontal; width in points (pdf.js text item units)
const flat = (str: string, x: number, y: number, width = 50) =>
  ({ str, transform: [10, 0, 0, 10, x, y], width, height: 10 });
// the same run turned 90° (reading bottom→top, as a vertical dimension string)
const vert = (str: string, x: number, y: number) =>
  ({ str, transform: [0, 10, -10, 0, x, y], width: 50, height: 10 });

// image-px rect: x 200..400, y 200..400 (points x 100..200, y 800..900)
const RECT = { x0: 200, y0: 200, x1: 400, y1: 400 };

test("default containment: left edge and baseline point inside (unchanged)", () => {
  const tc = { items: [flat("IN", 150, 850), flat("OUT", 300, 850)] };
  const toks = extractRegionText(tc as never, VP, RECT);
  assert.deepEqual(toks.map((t) => t.str), ["IN"]);
  assert.equal(toks[0].x, 300);
  assert.equal(toks[0].y, 300);
  assert.equal(toks[0].h, 20);
});

// pdf.js PageViewport's transform for /Rotate 90, 180, 270 (rotateA..D ×
// scale 2; the offsets don't matter for angles, so the rect is the whole plane)
const VP_ROT = (a: number, b: number, c: number, d: number) => ({ width: 1, height: 1, transform: [a, b, c, d, 0, 0] }) as never;
const ALL = { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 };
const run = (str: string, m: number[]) => ({ str, transform: [...m, 150, 850], width: 50, height: 10 });
const angs = (vp: never, ...items: ReturnType<typeof run>[]) =>
  extractRegionText({ items } as never, vp, ALL).map((t) => [t.str, t.ang]);

test("ang: baseline direction in degrees [0,360), clockwise on screen", () => {
  const tc = { items: [flat("H", 150, 850), vert("UP", 160, 850), run("DOWN", [0, -10, 10, 0])] };
  const toks = extractRegionText(tc as never, VP, { x0: 0, y0: 0, x1: 1e6, y1: 1e6 });
  assert.deepEqual(toks.map((t) => [t.str, t.ang]), [["H", 0], ["UP", 270], ["DOWN", 90]]);
});

test("ang: text that reads left→right on a rotated page is 0°", () => {
  // /Rotate 90: page-up text shows horizontal; /Rotate 270: page-down text does
  assert.deepEqual(angs(VP_ROT(0, 2, 2, 0), run("R90", [0, 10, -10, 0])), [["R90", 0]]);
  assert.deepEqual(angs(VP_ROT(0, -2, -2, 0), run("R270", [0, -10, 10, 0])), [["R270", 0]]);
});

test("ang: upside down (a /Rotate 180 page, a mirrored run) is 180°", () => {
  assert.deepEqual(angs(VP_ROT(-2, 0, 0, 2), run("R180", [10, 0, 0, 10])), [["R180", 180]]);
  assert.deepEqual(angs(VP, run("MIRROR", [-10, 0, 0, 10])), [["MIRROR", 180]]);
});

test("height falls back to the item height in px when the run has no y-axis", () => {
  // a degenerate transform (zero y-scale): h comes from it.height × viewport scale
  const tc = { items: [{ str: "FLAT", transform: [10, 0, 0, 0, 150, 850], width: 50, height: 10 }] };
  assert.equal(extractRegionText(tc as never, VP, RECT)[0].h, 20);
});

test("boxIntersects: a baseline just below the box still copies when its glyphs reach in", () => {
  // baseline at image y 410 (10px below the box), cap height 20 → glyphs span 390..410
  const tc = { items: [flat("LOW", 150, 795)] };
  assert.equal(extractRegionText(tc as never, VP, RECT).length, 0);
  assert.deepEqual(extractRegionText(tc as never, VP, RECT, { boxIntersects: true }).map((t) => t.str), ["LOW"]);
});

test("boxIntersects: a run starting left of the box counts by its px width", () => {
  // left edge image x 140, width 40pt = 80px → spans 140..220, meets x0 = 200.
  // Unscaled (40) it would stop at 180 and miss — the viewport scale matters.
  const tc = { items: [flat("LEFT", 70, 850, 40)] };
  assert.equal(extractRegionText(tc as never, VP, RECT).length, 0);
  assert.deepEqual(extractRegionText(tc as never, VP, RECT, { boxIntersects: true }).map((t) => t.str), ["LEFT"]);
});

test("boxIntersects: a run wholly outside stays out", () => {
  const tc = { items: [flat("FAR", 400, 850), flat("BELOW", 150, 700)] };
  assert.equal(extractRegionText(tc as never, VP, RECT, { boxIntersects: true }).length, 0);
  assert.equal(extractRegionText(tc as never, VP, RECT).length, 0);
});

test("boxIntersects: a run above the box stays out", () => {
  // baseline at image y 190, 10px above the box; glyphs span 170..190
  const tc = { items: [flat("HIGH", 150, 905)] };
  assert.equal(extractRegionText(tc as never, VP, RECT, { boxIntersects: true }).length, 0);
});

test("boxIntersects: a vertical run's extent runs along its direction, not along x", () => {
  // reading bottom→top from image (190, 300): glyphs lean left to x 170, the
  // run goes up 100px — it never crosses x0 = 200
  const left = { items: [vert("BESIDE", 95, 850)] };
  assert.equal(extractRegionText(left as never, VP, RECT, { boxIntersects: true }).length, 0);
  // from (300, 450), 50px below the box, the run climbs to y 350 — inside
  const below = { items: [vert("CLIMBS", 150, 775)] };
  assert.deepEqual(extractRegionText(below as never, VP, RECT, { boxIntersects: true }).map((t) => t.str), ["CLIMBS"]);
});

test("w: the run's length in px", () => {
  const toks = extractRegionText({ items: [flat("IN", 150, 850, 40)] } as never, VP, RECT);
  assert.equal(toks[0].w, 80);
});

test("w is left off when the run reports no width", () => {
  const items = [{ ...flat("A", 150, 850), width: 0 }, { str: "B", transform: [10, 0, 0, 10, 170, 850], height: 10 }];
  const toks = extractRegionText({ items } as never, VP, RECT);
  assert.deepEqual(toks.map((t) => "w" in t), [false, false]);
});

test("width-less runs read as words: no spurious TAB, twins deduped", () => {
  // two w=0 runs 40px apart, and an exact twin of the first
  const items = [{ ...flat("A", 150, 850), width: 0 }, { ...flat("A", 150, 850), width: 0 }, { ...flat("B", 170, 850), width: 0 }];
  const toks = extractRegionText({ items } as never, VP, RECT);
  assert.equal(linesToText(assembleLines(toks).lines), "A B");
});

test("boxIntersects: a width-less run is estimated at 0.6·h a character", () => {
  // no width reported; starts at image x 190, 10px left of the box. 8
  // characters at h = 20 estimate to 96px, reaching x 286 — inside
  const tc = { items: [{ str: "ABCDEFGH", transform: [10, 0, 0, 10, 95, 850], height: 10 }] };
  assert.equal(extractRegionText(tc as never, VP, RECT).length, 0);
  assert.deepEqual(extractRegionText(tc as never, VP, RECT, { boxIntersects: true }).map((t) => t.str), ["ABCDEFGH"]);
});
