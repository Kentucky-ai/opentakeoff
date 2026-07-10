// Geometry core tests — the One-Click pipeline is pure (no DOM, no pdf.js), so
// it runs straight under node. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMask, floodRegion, traceRegion, snapVertices, ringArea, rdpClosed,
  extractVectorGeometry, classifyHatchSegs, SEG_CURVE, SEG_CLIP, SEG_FILLONLY,
  type Point,
} from "../src/lib/oneclick.ts";

// a closed square room, as flat boundary segments in image px
function squareSegs(x0: number, y0: number, x1: number, y1: number): number[] {
  return [
    x0, y0, x1, y0,
    x1, y0, x1, y1,
    x1, y1, x0, y1,
    x0, y1, x0, y0,
  ];
}

test("ringArea: unit square via shoelace", () => {
  const sq: Point[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(ringArea(sq), 100);
});

test("flood + trace: an enclosed room is found and traced to ~its area", () => {
  const segs = squareSegs(20, 20, 100, 100);          // 80×80 interior
  const mask = buildMask(segs, 300, 300);   // room must be < 30% of the sheet, else it reads as a leak
  const res = floodRegion(mask, 60, 60);              // click in the middle
  assert.equal(res.status, "ok");
  if (res.status !== "ok") return;
  assert.ok(res.count > 30, "region should be larger than the tiny-sliver floor");
  const ring = traceRegion(res);
  assert.ok(ring.length >= 4, "a rectangular room should trace at least 4 vertices");
  const area = ringArea(ring);
  // the contour rides just inside the 1px wall, so a touch under 80×80 = 6400
  assert.ok(area > 5000 && area < 6800, `traced area ~6400, got ${area}`);
});

test("flood: clicking outside an enclosure leaks to the sheet edge", () => {
  const segs = squareSegs(20, 20, 100, 100);
  const mask = buildMask(segs, 300, 300);   // room must be < 30% of the sheet, else it reads as a leak
  const res = floodRegion(mask, 5, 5);                // outside the box
  assert.equal(res.status, "leak");
});

test("snapVertices: collapses near-duplicate corners (no snap target)", () => {
  const poly: Point[] = [[10, 10], [10.5, 10.4], [50, 10], [50, 50], [10, 50]];
  const out = snapVertices(poly, () => null);          // nearest returns nothing
  assert.equal(out.length, 4, "the ~0.6px-apart pair should merge to one corner");
});

test("snapVertices: pulls corners onto provided endpoints", () => {
  const poly: Point[] = [[9.7, 10.2], [50.3, 9.8], [50.1, 50.4], [9.6, 49.7]];
  const grid: Point[] = [[10, 10], [50, 10], [50, 50], [10, 50]];
  const nearest = (x: number, y: number, d: number): Point | null => {
    for (const g of grid) if (Math.hypot(g[0] - x, g[1] - y) <= d) return g;
    return null;
  };
  const out = snapVertices(poly, nearest, 6);
  assert.deepEqual(out, grid);
});

test("rdpClosed: a finely-sampled square simplifies toward 4 corners", () => {
  const pts: Point[] = [];
  const corners: Point[] = [[0, 0], [100, 0], [100, 100], [0, 100]];
  for (let c = 0; c < 4; c++) {
    const a = corners[c], b = corners[(c + 1) % 4];
    for (let i = 0; i < 10; i++) pts.push([a[0] + (b[0] - a[0]) * (i / 10), a[1] + (b[1] - a[1]) * (i / 10)]);
  }
  const ring = rdpClosed(pts, 1.5);
  assert.ok(ring.length >= 4 && ring.length <= 8, `expected ~4 corners, got ${ring.length}`);
});

// ── hatch-robust fill (2026-07-05) ─────────────────────────────────────────
// Shared fixture: 1000×800 sheet at mask ws=0.5, sheet border + a 600×400 room.
const IMG_W = 1000, IMG_H = 800, MAXDIM = 500;
const border = squareSegs(2, 2, 998, 798);
const room = squareSegs(100, 100, 700, 500);            // 240,000 image px²
const zeroMeta = (segs: number[]) => new Uint8Array(segs.length >> 2); // plain stroked hairlines
const approx = (a: number, b: number, tolFrac: number) => Math.abs(a - b) <= Math.abs(b) * tolFrac;

test("hatch: without meta the strict behavior is preserved (trapped between hatch lines)", () => {
  const hatch: number[] = [];
  for (let x = 100; x <= 700; x += 4) hatch.push(x, 100, x, 500);
  const m = buildMask([...border, ...room, ...hatch], IMG_W, IMG_H, MAXDIM);
  const f = floodRegion(m, 400, 300);
  assert.ok(f.status === "tiny" || f.status === "boundary", `expected tiny/boundary, got ${f.status}`);
});

test("hatch: with meta a hatched room fills to the walls, flagged hatchFiltered", () => {
  const hatch: number[] = [];
  for (let x = 100; x <= 700; x += 4) hatch.push(x, 100, x, 500);
  const all = [...border, ...room, ...hatch];
  const m = buildMask(all, IMG_W, IMG_H, MAXDIM, zeroMeta(all));
  assert.ok(m.softCount > 100, `hatch family should classify soft, got ${m.softCount}`);
  const f = floodRegion(m, 400, 300);
  assert.equal(f.status, "ok");
  if (f.status !== "ok") return;
  assert.equal(f.hatchFiltered, true);
  const area = ringArea(traceRegion(f));
  assert.ok(approx(area, 240000, 0.03), `escalated ring ≈ room area, got ${area}`);
});

test("hatch: 45° hatch and crosshatch fill to the walls", () => {
  const diag: number[] = [];
  for (let c = -560; c <= 360; c += 8) {                // y = x + c clipped to the room
    const x0 = Math.max(100, 100 - c), x1 = Math.min(700, 500 - c);
    if (x1 > x0 + 2) diag.push(x0, x0 + c, x1, x1 + c);
  }
  const diag2: number[] = [];
  for (let c = 200; c <= 1200; c += 8) {                // the other 45° family
    const x0 = Math.max(100, c - 500), x1 = Math.min(700, c - 100);
    if (x1 > x0 + 2) diag2.push(x0, c - x0, x1, c - x1);
  }
  for (const hatchSet of [diag, [...diag, ...diag2]]) {
    const all = [...border, ...room, ...hatchSet];
    const f = floodRegion(buildMask(all, IMG_W, IMG_H, MAXDIM, zeroMeta(all)), 400, 300);
    assert.equal(f.status, "ok");
    if (f.status !== "ok") return;
    assert.equal(f.hatchFiltered, true);
    assert.ok(approx(ringArea(traceRegion(f)), 240000, 0.04), "ring ≈ room");
  }
});

test("hatch: wall-to-wall tile grid — strict pass returns one tile, meta returns the room", () => {
  const grid: number[] = [];
  for (let x = 100; x <= 700; x += 24) grid.push(x, 100, x, 500);
  for (let y = 100; y <= 500; y += 24) grid.push(100, y, 700, y);
  const all = [...border, ...room, ...grid];
  const f0 = floodRegion(buildMask(all, IMG_W, IMG_H, MAXDIM), 410, 310);
  assert.ok(f0.status === "ok" && (f0.count || 0) < 1000, "no meta: one tile cell (the documented old behavior)");
  const f = floodRegion(buildMask(all, IMG_W, IMG_H, MAXDIM, zeroMeta(all)), 410, 310);
  assert.equal(f.status, "ok");
  if (f.status !== "ok") return;
  assert.equal(f.hatchFiltered, true);
  assert.ok(approx(ringArea(traceRegion(f)), 240000, 0.03), "ring ≈ room");
});

test("hatch: room-scale rhythm (parallel walls above the pitch cap) is never hatch", () => {
  const units: number[] = [];
  for (let x = 100; x <= 760; x += 60) units.push(x, 100, x, 500); // 30 mask px pitch > cap
  units.push(100, 100, 760, 100, 100, 500, 760, 500);
  const all = [...border, ...units];
  const m = buildMask(all, IMG_W, IMG_H, MAXDIM, zeroMeta(all));
  assert.equal(m.softCount, 0);
  const f = floodRegion(m, 130, 300);
  assert.equal(f.status, "ok");
  if (f.status !== "ok") return;
  assert.ok(!f.hatchFiltered, "no escalation");
  assert.ok(approx(ringArea(traceRegion(f)), 60 * 400, 0.08), "one unit only");
});

test("hatch: fill-only (poché) walls riding the tile rhythm stay hard — the room traces", () => {
  // The VA demo plan's failure mode: walls drawn as SOLID FILLED shapes whose
  // short 0°/90° outline edges sit exactly on the tile grid's pitch. If they
  // classify as hatch, the escalated fill crosses solid ink and leaks — the
  // click came back as a "dense linework" guard instead of the room.
  const grid: number[] = [];
  for (let x = 20; x <= 980; x += 8) grid.push(x, 20, x, 780);   // sheet-wide rhythm
  for (let y = 20; y <= 780; y += 8) grid.push(20, y, 980, y);   // room walls sit on multiples of 8
  const all = [...border, ...room, ...grid];
  const meta = zeroMeta(all);
  const roomStart = border.length >> 2;
  for (let k = 0; k < 4; k++) meta[roomStart + k] = SEG_FILLONLY; // the room is a filled poché band
  const m = buildMask(all, IMG_W, IMG_H, MAXDIM, meta);
  assert.ok(m.softCount > 100, `grid classifies soft, got ${m.softCount}`);
  const f = floodRegion(m, 400, 300);
  assert.equal(f.status, "ok");
  if (f.status !== "ok") return;
  assert.equal(f.hatchFiltered, true);
  assert.ok(approx(ringArea(traceRegion(f)), 240000, 0.03), `escalated ring ≈ room area, got ${ringArea(traceRegion(f))}`);
});

test("hatch: a hatched room with a real door gap still refuses (no faked region)", () => {
  const gapped = [
    100, 100, 380, 100, 420, 100, 700, 100,
    700, 100, 700, 500, 700, 500, 100, 500, 100, 500, 100, 100,
  ];
  const hatch: number[] = [];
  for (let x = 104; x <= 696; x += 4) hatch.push(x, 100, x, 500);
  const all = [...border, ...gapped, ...hatch];
  const f = floodRegion(buildMask(all, IMG_W, IMG_H, MAXDIM, zeroMeta(all)), 400, 300);
  assert.notEqual(f.status, "ok");
});

test("classifyHatchSegs: extremal rows hard, wide member hard, curve exempt, clip soft", () => {
  const segs: number[] = [];
  for (let x = 100; x <= 700; x += 4) segs.push(x, 100, x, 500);
  const n = segs.length >> 2;
  const meta = new Uint8Array(n + 3);
  segs.push(400.5, 100, 400.5, 500); meta[n] = 4 << 4;          // heavy pen vs hairline family
  segs.push(300.5, 100, 300.5, 500); meta[n + 1] = SEG_CURVE;
  segs.push(200.5, 100, 200.5, 500); meta[n + 2] = SEG_CLIP;
  const soft = classifyHatchSegs(segs, meta, 0.5);
  assert.equal(soft[0], 0, "first (wall-coincident) row stays hard");
  assert.equal(soft[n - 1], 0, "last row stays hard");
  assert.equal(soft[1], 1, "interior hatch soft");
  assert.equal(soft[n], 0, "heavy-pen member protected");
  assert.equal(soft[n + 1], 0, "curve chord exempt");
  assert.equal(soft[n + 2], 1, "clip-only soft");
});

test("extractVectorGeometry: meta emission — paint ops, line width, form XObject matrix", () => {
  const OPS: Record<string, number> = {
    save: 1, restore: 2, transform: 3, constructPath: 4, setLineWidth: 5, setGState: 6,
    moveTo: 10, lineTo: 11, curveTo: 12, curveTo2: 13, curveTo3: 14, closePath: 15, rectangle: 16,
    stroke: 20, closeStroke: 21, fill: 22, eoFill: 23, endPath: 28, clip: 29, eoClip: 30,
    paintFormXObjectBegin: 40, paintFormXObjectEnd: 41,
  };
  const line = (a: number, b: number, c: number, d: number) => [[OPS.moveTo, OPS.lineTo], [a, b, c, d]];
  const opList = {
    fnArray: [
      OPS.setLineWidth, OPS.constructPath, OPS.stroke,
      OPS.constructPath, OPS.fill,
      OPS.constructPath, OPS.clip, OPS.endPath,
      OPS.setGState, OPS.constructPath, OPS.stroke,
      OPS.constructPath,
      OPS.paintFormXObjectBegin, OPS.constructPath, OPS.stroke, OPS.paintFormXObjectEnd,
      OPS.constructPath, OPS.stroke,
    ],
    argsArray: [
      [2], line(0, 0, 5, 0), null,
      line(0, 0, 5, 1), null,
      line(0, 0, 5, 2), null, null,
      [[["LW", 3]]], line(0, 0, 5, 3), null,
      [[OPS.moveTo, OPS.curveTo], [0, 10, 2, 14, 4, 14, 6, 10]],
      [[2, 0, 0, 2, 10, 10]], line(0, 0, 5, 0), null, null,
      line(0, 0, 4, 4), null,
    ],
  };
  const { segs, meta } = extractVectorGeometry(opList, [1, 0, 0, 1, 0, 0], OPS);
  assert.equal(meta.length, segs.length >> 2, "one meta byte per segment");
  assert.equal(meta[0], 2 << 4, "stroked line carries width nibble");
  assert.equal(meta[1], SEG_FILLONLY | (2 << 4), "fill-only flagged");
  assert.equal(meta[2], SEG_CLIP | (2 << 4), "clip-only flagged");
  assert.equal(meta[3], 3 << 4, "setGState LW updates width");
  assert.equal(meta[4] & SEG_CURVE, 1, "bezier chords carry SEG_CURVE");
  const fi = 4 + 8; // 4 straight segs + 8 chords before the form's line
  assert.deepEqual(Array.from(segs.slice(fi * 4, fi * 4 + 4)), [10, 10, 20, 10], "form XObject matrix places geometry");
  assert.equal(meta[fi], 6 << 4, "device width inside the form = ceil(3×2)");
  assert.equal(segs[(fi + 1) * 4], 0, "paintFormXObjectEnd pops the matrix");
  assert.equal(meta[fi + 1], 3 << 4, "line width restored after the form");
});

test("extractVectorGeometry: imageArea sums |det CTM| at image paint ops", () => {
  const OPS: Record<string, number> = {
    save: 1, restore: 2, transform: 3, constructPath: 4, setLineWidth: 5, setGState: 6,
    moveTo: 10, lineTo: 11, curveTo: 12, curveTo2: 13, curveTo3: 14, closePath: 15, rectangle: 16,
    stroke: 20, fill: 22, eoFill: 23, endPath: 28, clip: 29, eoClip: 30,
    paintFormXObjectBegin: 40, paintFormXObjectEnd: 41,
    paintImageXObject: 85, paintInlineImageXObject: 86, paintImageMaskXObject: 87,
  };
  const identity = [1, 0, 0, 1, 0, 0];
  // image placed by a 100×50 CTM → 5000 px²; a second one inside a form XObject
  // whose matrix scales 2× each axis → 40×40 → 1600 px²; form pops cleanly after.
  const opList = {
    fnArray: [
      OPS.transform, OPS.paintImageXObject,
      OPS.paintFormXObjectBegin, OPS.paintImageMaskXObject, OPS.paintFormXObjectEnd,
      OPS.paintInlineImageXObject,
    ],
    argsArray: [
      [100, 0, 0, 50, 0, 0], null,
      [[0.004, 0, 0, 0.016, 0, 0]], null, null,   // (100·0.004)×(50·0.016) = 0.4×0.8 → |det|=0.32 px²
      null,                                        // back at the 100×50 CTM → +5000
    ],
  };
  const g = extractVectorGeometry(opList as any, identity, OPS);
  assert.ok(Math.abs(g.imageArea - (5000 + 0.32 + 5000)) < 1e-9, `imageArea ${g.imageArea}`);
  assert.equal(g.segs.length, 0, "image ops emit no segments");
});

test("extractVectorGeometry: imageArea is 0 when no image ops exist", () => {
  const OPS: Record<string, number> = {
    save: 1, restore: 2, transform: 3, constructPath: 4, setLineWidth: 5, setGState: 6,
    moveTo: 10, lineTo: 11, curveTo: 12, curveTo2: 13, curveTo3: 14, closePath: 15, rectangle: 16,
    stroke: 20, fill: 22, eoFill: 23, endPath: 28, clip: 29, eoClip: 30,
    paintFormXObjectBegin: 40, paintFormXObjectEnd: 41,
  };
  const opList = {
    fnArray: [OPS.constructPath, OPS.stroke],
    argsArray: [[[OPS.moveTo, OPS.lineTo], [0, 0, 5, 0]], null],
  };
  const g = extractVectorGeometry(opList as any, [1, 0, 0, 1, 0, 0], OPS);
  assert.equal(g.imageArea, 0);
});
