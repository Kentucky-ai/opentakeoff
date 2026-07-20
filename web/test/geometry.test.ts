// Geometry core tests — the One-Click pipeline is pure (no DOM, no pdf.js), so
// it runs straight under node. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMask, floodRegion, traceRegion, snapVertices, ringArea, rdpClosed,
  extractVectorGeometry, classifyHatchSegs, SEG_CURVE, SEG_CLIP, SEG_FILLONLY,
  SENS_STRICT, SENS_BALANCED, SENS_AGGRESSIVE,
  type Point, type MaskObj,
} from "../src/lib/oneclick.ts";
import { cloudBezier, cloudPath, arrowheadPath, reflectVertsNorm, closedMetrics } from "../src/lib/geometry.js";

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

// ── grow-but-verify escalation (issue #32) ─────────────────────────────────
// The moderate band — a strict "ok" fill bounded ~40% by hatch — is where real
// hatch-lined rooms sit (measured max soft-bounded fraction ~0.63). The old gate
// only escalated at ≥0.70, so it never fired there. These masks are hand-built
// so softFrac and the walls-only growth are exact, pinning the DECISION gate:
// two rooms split by a SOFT (hatch) divider, differing only in the neighbor's
// size, so removing the divider grows the fill modestly vs. balloons it.
//   cell bits: 1 = hard (wall), 2 = soft (hatch); ws = 1 so seed px == mask px.
//   lw / rw are the interior widths of the left / right rooms (in cells).
function twoRoomMask(lw: number, rw: number, H: number): { mo: MaskObj; seed: [number, number] } {
  const MW = 140, MH = 90, OX = 4, OY = 4;             // block floats in a large canvas
  const mask = new Uint8Array(MW * MH);                //   so the 30% leak cap isn't what's under test
  const set = (x: number, y: number, v: number) => { mask[y * MW + x] |= v; };
  const bw = lw + rw + 2;                              // span: |wall| lw |divider| rw |wall|
  for (let x = 0; x <= bw; x++) { set(OX + x, OY, 1); set(OX + x, OY + H + 1, 1); }
  for (let y = 0; y <= H + 1; y++) { set(OX, OY + y, 1); set(OX + bw, OY + y, 1); }
  const divX = OX + 1 + lw;                            // SOFT vertical divider between the rooms
  for (let y = 1; y <= H; y++) set(divX, OY + y, 2);
  let softCount = 0; for (const c of mask) if (c & 2) softCount++;
  return { mo: { mask, mw: MW, mh: MH, ws: 1, softCount }, seed: [OX + 1 + (lw >> 1), OY + 1 + (H >> 1)] };
}

test("escalation: a moderately hatch-bounded room recovers past the divider (growth within cap)", () => {
  // strict fills the 8-wide left room (softFrac ≈ 0.43 — below the old 0.70 gate,
  // so the pre-#32 code left it short); walls-only reaches the neighbor's far wall,
  // growing the area only modestly (well under HATCH_GROWTH_MAX = 2.5×) ⇒ accepted,
  // flagged hatchFiltered.
  const { mo, seed } = twoRoomMask(8, 6, 48);
  const strict = floodRegion({ ...mo, softCount: 0 }, seed[0], seed[1]); // softCount 0 disables escalation
  assert.equal(strict.status, "ok");
  const f = floodRegion(mo, seed[0], seed[1]);
  assert.equal(f.status, "ok");
  if (f.status !== "ok" || strict.status !== "ok") return;
  assert.equal(f.hatchFiltered, true, "moderate hatch band should escalate");
  assert.ok(f.count > strict.count, `escalated fill is larger than strict (${strict.count} → ${f.count})`);
});

test("escalation: a runaway escalation (balloons past the cap) is discarded — strict stands", () => {
  // Same left room and softFrac, but the neighbor is far larger (40 wide): removing
  // the divider grows the fill several-fold, over HATCH_GROWTH_MAX, so the strict
  // fill is kept and the result is NOT flagged hatchFiltered.
  const { mo, seed } = twoRoomMask(8, 40, 48);
  const strict = floodRegion({ ...mo, softCount: 0 }, seed[0], seed[1]);
  const f = floodRegion(mo, seed[0], seed[1]);
  assert.equal(f.status, "ok"); assert.equal(strict.status, "ok"); // both must land, else the guard below would skip the real checks
  if (f.status !== "ok" || strict.status !== "ok") return;
  assert.ok(!f.hatchFiltered, "a ballooning walls-only escalation must be rejected");
  assert.equal(f.count, strict.count, "the strict fill is preserved unchanged");
});

test("escalation: Strict sensitivity empties the moderate band — the room that Balanced recovers stays strict", () => {
  // The recover fixture (softFrac ≈ 0.43) escalates at Balanced; at SENS_STRICT the
  // moderate band collapses (escalateFrac == HATCH_BOUND_FRAC) so it must NOT.
  const { mo, seed } = twoRoomMask(8, 6, 48);
  const balanced = floodRegion(mo, seed[0], seed[1], SENS_BALANCED);
  const strict = floodRegion(mo, seed[0], seed[1], SENS_STRICT);
  assert.equal(balanced.status, "ok"); assert.equal(strict.status, "ok");
  if (balanced.status !== "ok" || strict.status !== "ok") return;
  assert.equal(balanced.hatchFiltered, true, "Balanced escalates the moderate-band room");
  assert.ok(!strict.hatchFiltered, "Strict leaves it as the strict fill");
  assert.ok(strict.count < balanced.count, "Strict is the smaller (pre-escalation) region");
});

test("escalation: Aggressive sensitivity accepts a larger growth that Balanced rejects", () => {
  // Growth ≈ 2.8× — over the Balanced cap (2.5), under the Aggressive cap (4.0).
  const { mo, seed } = twoRoomMask(6, 10, 48);
  const balanced = floodRegion(mo, seed[0], seed[1], SENS_BALANCED);
  const aggressive = floodRegion(mo, seed[0], seed[1], SENS_AGGRESSIVE);
  assert.equal(balanced.status, "ok"); assert.equal(aggressive.status, "ok");
  if (balanced.status !== "ok" || aggressive.status !== "ok") return;
  assert.ok(!balanced.hatchFiltered, "Balanced rejects the ~2.8× growth");
  assert.equal(aggressive.hatchFiltered, true, "Aggressive accepts it");
  assert.ok(aggressive.count > balanced.count, "Aggressive recovers the larger region");
});

// ── revision-cloud beziers (marked-set PDF scallops) ────────────────────────
test("cloudBezier: closed loop of cubic segments, more segments for a longer perimeter", () => {
  const small = cloudBezier(0, 0, 100, 60);
  const big = cloudBezier(0, 0, 400, 300);
  // each segment is [c1, c2, end], each a point
  for (const seg of small.segments) {
    assert.equal(seg.length, 3, "a segment is c1, c2, end");
    for (const p of seg) assert.equal(p.length, 2, "each control/end is an [x,y] point");
  }
  // closed: the last endpoint returns to the start corner (within fp tolerance)
  const last = small.segments[small.segments.length - 1][2];
  assert.ok(Math.hypot(last[0] - small.start[0], last[1] - small.start[1]) < 1e-6, "path closes");
  // a corner-only degenerate box still yields the four base scallops
  assert.ok(small.segments.length >= 4, `>=4 scallops, got ${small.segments.length}`);
  assert.ok(big.segments.length > small.segments.length, "longer perimeter → more scallops");
});

test("cloudBezier: control points stay within the scallop-padded bbox", () => {
  const { start, segments } = cloudBezier(50, 50, 250, 170);   // r = clamp((200+120)/22)=14.5
  const PAD = 32;   // scallops bulge outward by ~r; padding must contain them
  const pts: number[][] = [start];
  for (const [c1, c2, end] of segments) { pts.push(c1, c2, end); }
  for (const [x, y] of pts) {
    assert.ok(x >= 50 - PAD && x <= 250 + PAD, `x ${x} within padded bbox`);
    assert.ok(y >= 50 - PAD && y <= 170 + PAD, `y ${y} within padded bbox`);
  }
});

test("cloudBezier: normalizes corner order (x1<x0, y1<y0 gives the same outline)", () => {
  const a = cloudBezier(0, 0, 120, 80);
  const b = cloudBezier(120, 80, 0, 0);
  assert.deepEqual(a.start, b.start, "start pinned to min corner regardless of input order");
  assert.equal(a.segments.length, b.segments.length, "same scallop count either way");
});

// the ONE property that makes it a revision cloud: scallops bulge OUTWARD, not
// inward. Endpoints chain by construction (so the closure/bbox tests can't catch
// a flipped sweep), so pin the sweep direction explicitly on a control point.
test("cloudBezier: scallops bulge outward (sweep direction pinned)", () => {
  const { segments } = cloudBezier(0, 0, 200, 200);
  // a top-edge scallop (both x-coords strictly inside 0..200, y near the top edge)
  // must have a control point ABOVE the top edge (y < 0); a bottom-edge scallop
  // must have one BELOW (y > 200). Inward/flat scallops would fail both.
  const anyAbove = segments.some(([c1, c2]) => (c1[1] < -1 || c2[1] < -1) && c1[0] > 1 && c1[0] < 199);
  const anyBelow = segments.some(([c1, c2]) => (c1[1] > 201 || c2[1] > 201) && c1[0] > 1 && c1[0] < 199);
  assert.ok(anyAbove, "top-edge scallops bulge above the box");
  assert.ok(anyBelow, "bottom-edge scallops bulge below the box");
});

// guard against canvas↔PDF drift: cloudBezier (PDF) must have exactly one cubic
// per SVG `A` arc emitted by cloudPath (canvas) for the same box.
test("cloudBezier segment count matches cloudPath arc count (no canvas/PDF drift)", () => {
  for (const box of [[0, 0, 100, 60], [50, 50, 250, 170], [0, 0, 400, 90]] as const) {
    const arcs = (cloudPath(...box).match(/A/g) || []).length;
    assert.equal(cloudBezier(...box).segments.length, arcs, `segment count == arc count for ${box}`);
  }
});

// a zero-size cloud must not produce NaN control points (the closure test compares
// endpoints, which are exact by construction, so it can't catch NaN).
test("arrowheadPath: a zero-length leader (from==tip) yields a valid non-degenerate triangle", () => {
  const d = arrowheadPath(100, 100, 100, 100, 6);   // from == tip
  const pts = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
  // 3 points × 2 coords = 6 numbers; they must not all coincide (a zero-area triangle)
  assert.equal(pts.length, 6, "M x y L x y L x y Z → six numbers");
  const allSame = pts[0] === pts[2] && pts[2] === pts[4] && pts[1] === pts[3] && pts[3] === pts[5];
  assert.ok(!allSame, "degenerate leader still produces a real (up-pointing) arrowhead, not a zero-area triangle");
});

test("cloudBezier: degenerate zero-size box yields finite points", () => {
  const { start, segments } = cloudBezier(50, 50, 50, 50);
  assert.ok(Number.isFinite(start[0]) && Number.isFinite(start[1]), "start finite");
  for (const seg of segments) for (const [x, y] of seg) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y), "control/end finite");
  }
});

// ── Flip Horizontal/Vertical (reflectVertsNorm) ─────────────────────────────
const L_SHAPE: Point[] = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.3], [0.3, 0.3], [0.3, 0.5], [0.1, 0.5]];

test("reflectVertsNorm: horizontal flip mirrors X about the ring's own bbox center, area/perimeter unchanged", () => {
  const flipped = reflectVertsNorm(L_SHAPE, "h");
  const before = closedMetrics(L_SHAPE), after = closedMetrics(flipped);
  assert.ok(Math.abs(before.area - after.area) < 1e-9, "area invariant under flip");
  assert.ok(Math.abs(before.perim - after.perim) < 1e-9, "perimeter invariant under flip");
  const xs = L_SHAPE.map((p) => p[0]), lo = Math.min(...xs), hi = Math.max(...xs), s = lo + hi;
  for (let i = 0; i < L_SHAPE.length; i++) {
    assert.ok(Math.abs(flipped[i][0] - (s - L_SHAPE[i][0])) < 1e-9, "X mirrors about bbox center");
    assert.equal(flipped[i][1], L_SHAPE[i][1], "Y untouched by a horizontal flip");
  }
});

test("reflectVertsNorm: vertical flip mirrors Y, area/perimeter unchanged, X untouched", () => {
  const flipped = reflectVertsNorm(L_SHAPE, "v");
  const before = closedMetrics(L_SHAPE), after = closedMetrics(flipped);
  assert.ok(Math.abs(before.area - after.area) < 1e-9);
  assert.ok(Math.abs(before.perim - after.perim) < 1e-9);
  for (let i = 0; i < L_SHAPE.length; i++) {
    assert.equal(flipped[i][0], L_SHAPE[i][0], "X untouched by a vertical flip");
  }
});

test("reflectVertsNorm: a single-vertex ring (count marker) is a safe no-op", () => {
  const pt: Point[] = [[0.4, 0.6]];
  assert.deepEqual(reflectVertsNorm(pt, "h"), pt);
  assert.deepEqual(reflectVertsNorm(pt, "v"), pt);
});

test("reflectVertsNorm: applying the same flip twice returns the original ring", () => {
  const twice = reflectVertsNorm(reflectVertsNorm(L_SHAPE, "h"), "h");
  for (let i = 0; i < L_SHAPE.length; i++) {
    assert.ok(Math.abs(twice[i][0] - L_SHAPE[i][0]) < 1e-9);
    assert.ok(Math.abs(twice[i][1] - L_SHAPE[i][1]) < 1e-9);
  }
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
  // whose OWN matrix scales the unit square down to 0.4×0.8 (100×0.004 by
  // 50×0.016) → |det| = 0.32 px²; form pops cleanly after, back to +5000.
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

test("extractVectorGeometry: imageArea for the repeat/group image ops reads placement from the op's own args (Finding 7)", () => {
  // pdf.js FOLDS a run of identical/near-identical image placements into ONE
  // op — paintImageXObjectRepeat, paintImageMaskXObjectRepeat,
  // paintImageMaskXObjectGroup, paintInlineImageXObjectGroup — and does NOT
  // emit a per-instance `transform` op ahead of it, so the ambient CTM at
  // that point is just the viewport transform. Placement instead lives in
  // the op's own args (scaleX/scaleY/positions, or a transform per element).
  const OPS: Record<string, number> = {
    save: 1, restore: 2, transform: 3, constructPath: 4, setLineWidth: 5, setGState: 6,
    moveTo: 10, lineTo: 11, curveTo: 12, curveTo2: 13, curveTo3: 14, closePath: 15, rectangle: 16,
    stroke: 20, fill: 22, eoFill: 23, endPath: 28, clip: 29, eoClip: 30,
    paintFormXObjectBegin: 40, paintFormXObjectEnd: 41,
    paintImageXObject: 85, paintInlineImageXObject: 86, paintImageMaskXObject: 87,
    paintImageXObjectRepeat: 88, paintImageMaskXObjectRepeat: 89,
    paintImageMaskXObjectGroup: 90, paintInlineImageXObjectGroup: 91,
  };
  const identity = [1, 0, 0, 1, 0, 0];
  const opList = {
    fnArray: [
      OPS.paintImageXObjectRepeat,
      OPS.paintImageMaskXObjectRepeat,
      OPS.paintImageMaskXObjectGroup,
      OPS.paintInlineImageXObjectGroup,
    ],
    argsArray: [
      ["img1", 10, 5, new Float32Array([0, 0, 10, 0])],                            // 2 instances × |10×5| = 100
      ["mask1", 4, 0, 0, 3, new Float32Array([0, 0, 5, 5, 10, 10])],                // 3 instances × |4×3| = 36
      [[{ transform: [2, 0, 0, 2, 0, 0] }, { transform: [1, 0, 0, 1, 5, 5] }]],     // 4 + 1 = 5
      ["img2", [{ transform: [3, 0, 0, 1, 0, 0] }, { transform: [1, 0, 0, 4, 2, 2] }]], // 3 + 4 = 7
    ],
  };
  const g = extractVectorGeometry(opList as any, identity, OPS);
  assert.ok(Math.abs(g.imageArea - (100 + 36 + 5 + 7)) < 1e-9, `imageArea ${g.imageArea}`);
  assert.equal(g.segs.length, 0, "image ops emit no segments");
});

test("extractVectorGeometry: a folded *Repeat op's area still scales with the ambient CTM", () => {
  const OPS: Record<string, number> = {
    save: 1, restore: 2, transform: 3, constructPath: 4, setLineWidth: 5, setGState: 6,
    moveTo: 10, lineTo: 11, curveTo: 12, curveTo2: 13, curveTo3: 14, closePath: 15, rectangle: 16,
    stroke: 20, fill: 22, eoFill: 23, endPath: 28, clip: 29, eoClip: 30,
    paintFormXObjectBegin: 40, paintFormXObjectEnd: 41,
    paintImageXObjectRepeat: 88,
  };
  // ambient viewport CTM scales 2× each axis (|det| = 4). Pre-fix, the code
  // used |det m| ALONE and ignored the op's own scaleX/scaleY/positions —
  // i.e. it would have read 4 px² here regardless of instance count/size,
  // instead of the real 4 × |6×2| × 2 = 96.
  const opList = {
    fnArray: [OPS.transform, OPS.paintImageXObjectRepeat],
    argsArray: [
      [2, 0, 0, 2, 0, 0],
      ["img", 6, 2, new Float32Array([0, 0, 20, 0])],
    ],
  };
  const g = extractVectorGeometry(opList as any, [1, 0, 0, 1, 0, 0], OPS);
  assert.ok(Math.abs(g.imageArea - 96) < 1e-9, `imageArea ${g.imageArea}`);
});
