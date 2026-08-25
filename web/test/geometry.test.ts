// Geometry core tests — the One-Click pipeline is pure (no DOM, no pdf.js), so
// it runs straight under node. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMask, floodRegion, traceRegion, snapVertices, ringArea, rdpClosed,
  extractVectorGeometry, classifyHatchSegs, classifyOffsetAnnotationSegs, classifyDimensionStringSegs, classifyFleckSegs, markPolylineArcs, SEG_CURVE, SEG_CLIP, SEG_FILLONLY, SEG_POLYARC,
  type SubPath,
  SENS_STRICT, SENS_BALANCED, SENS_AGGRESSIVE, MASK_CURVE_BIT,
  floodRegionSealed, dilateHardMask, SEAL_RADII, sealRadiiFor, DOOR_SEAL_MAX_FT, SEAL_R_MAX, doorWedgeCapPx,
  splitMergedArcs, doorLeafCells, arcClusterFit,
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

// ── leak recovery: door-gap sealing (floodRegionSealed) ────────────────────
// A room whose top wall has an OPEN gap (an undrawn doorway). At ws=1 the open
// run is (gapTo − gapFrom − 1) cells; a seal radius r closes runs ≤ 2r.
function gappedRoomSegs(gapFrom: number, gapTo: number): number[] {
  return [
    20, 20, gapFrom, 20,
    gapTo, 20, 100, 20,
    100, 20, 100, 100,
    100, 100, 20, 100,
    20, 100, 20, 20,
  ];
}

test("seal: a doorway gap leaks the plain flood but seals — smallest radius wins", () => {
  const mask = buildMask(gappedRoomSegs(55, 58), 300, 300);   // 2 open cells
  // Since upstream's gap bridging, the PLAIN flood also recovers this pinhole —
  // as a bridged rescue that says so (gapBridged), never as a clean fill.
  const plain = floodRegion(mask, 60, 60);
  assert.equal(plain.status, "ok", "the plain flood bridges the pinhole");
  assert.equal(plain.status === "ok" && plain.gapBridged, 1, "…and carries the bridge provenance");
  const f = floodRegionSealed(mask, 60, 60);
  assert.equal(f.status, "ok");
  if (f.status !== "ok") return;
  assert.equal(f.sealedPx, 1, "a 2-cell gap seals at the smallest radius");
});

test("seal: a wider doorway escalates the radius; growback restores the true room area", () => {
  const mask = buildMask(gappedRoomSegs(55, 63), 300, 300);   // 7 open cells → needs r=4
  const f = floodRegionSealed(mask, 60, 60);
  assert.equal(f.status, "ok");
  if (f.status !== "ok") return;
  assert.equal(f.sealedPx, 4);
  const ring = traceRegion(f);
  const area = ringArea(ring);
  // growback recovers the 4-px band the dilation stole along every wall: the
  // ring must land in the same band as an intact room (~6400), not (80−2r)²
  assert.ok(area > 5600 && area < 6800, `sealed+grown area ≈ intact room, got ${area}`);
  for (const [x, y] of ring) {
    assert.ok(x > 17 && x < 103 && y > 15 && y < 103, `ring stays on the room's walls, got ${x},${y}`);
  }
});

test("seal: an opening wider than the largest radius still refuses — the leak stands", () => {
  const mask = buildMask(gappedRoomSegs(55, 68), 300, 300);   // 12 open cells > 2×max(SEAL_RADII)
  assert.ok(2 * Math.max(...SEAL_RADII) < 12, "fixture must exceed the seal reach");
  assert.equal(floodRegionSealed(mask, 60, 60).status, "leak");
});

test("seal: a non-leak result passes through untouched (no sealedPx, identical fill)", () => {
  const mask = buildMask(squareSegs(20, 20, 100, 100), 300, 300);
  const plain = floodRegion(mask, 60, 60);
  const sealed = floodRegionSealed(mask, 60, 60);
  assert.equal(plain.status, "ok"); assert.equal(sealed.status, "ok");
  if (plain.status !== "ok" || sealed.status !== "ok") return;
  assert.equal(sealed.sealedPx, undefined);
  assert.equal(sealed.count, plain.count);
});

test("dilateHardMask: hard cells fatten by r (diamond), soft (hatch) cells are never dilated", () => {
  const mw = 9, mh = 9;
  const mask = new Uint8Array(mw * mh);
  mask[4 * mw + 4] = 1;                               // one hard cell, center
  mask[1 * mw + 1] = 2;                               // one soft cell, corner-ish
  const d = dilateHardMask({ mask, mw, mh, ws: 1, softCount: 1 }, 2);
  assert.equal(d.mask[4 * mw + 6] & 1, 1, "hard reaches city-block distance 2 on-axis");
  assert.equal(d.mask[3 * mw + 3] & 1, 1, "diagonal at city-block distance 2 is in the diamond");
  assert.equal(d.mask[2 * mw + 2] & 1, 0, "diagonal at city-block distance 4 stays open");
  assert.equal(d.mask[4 * mw + 7] & 1, 0, "on-axis distance 3 stays open");
  assert.equal(d.mask[1 * mw + 1], 2, "soft cell survives, un-fattened");
  assert.equal(d.mask[1 * mw + 2] & 2, 0, "soft never dilates");
  assert.equal(d.softCount, 1, "soft bookkeeping carries over");
});

test("seal: hatch semantics survive sealing — a hatched room behind a doorway still escalates", () => {
  // the hatched-room fixture from the hatch suite, but with a doorway gap in the
  // top wall: strict flood leaks; the sealed retry must still run the tiered
  // escalation (hatch transparent) and come back hatchFiltered.
  const gapped = [
    100, 100, 380, 100, 388, 100, 700, 100,           // 7-image-px gap → ~3 mask px at ws=0.5 → r=2
    700, 100, 700, 500, 700, 500, 100, 500, 100, 500, 100, 100,
  ];
  const hatch: number[] = [];
  for (let x = 104; x <= 696; x += 4) hatch.push(x, 100, x, 500);
  const all = [...border, ...gapped, ...hatch];
  const m = buildMask(all, IMG_W, IMG_H, MAXDIM, zeroMeta(all));
  assert.notEqual(floodRegion(m, 400, 300).status, "ok", "unsealed: the doorway defeats the fill");
  const f = floodRegionSealed(m, 400, 300);
  assert.equal(f.status, "ok");
  if (f.status !== "ok") return;
  assert.equal(f.hatchFiltered, true, "escalation still fires on the sealed mask");
  assert.ok(f.sealedPx! >= 1 && f.sealedPx! <= 4, `sealed at a small radius, got ${f.sealedPx}`);
  assert.ok(approx(ringArea(traceRegion(f)), 240000, 0.04), "ring ≈ room area");
});

test("sealRadiiFor: doubling ladder up to the door-bridging radius, capped, fallback on junk", () => {
  // 20 mask px per foot → max radius ceil(5·20/2) = 50 → 1,2,4,…,32,50
  assert.deepEqual(sealRadiiFor(20), [1, 2, 4, 8, 16, 32, 50]);
  assert.equal(sealRadiiFor(20).at(-1), Math.ceil((DOOR_SEAL_MAX_FT * 20) / 2));
  assert.equal(sealRadiiFor(1e6).at(-1), SEAL_R_MAX, "absurd resolution hits the hard cap");
  assert.deepEqual(sealRadiiFor(0), SEAL_RADII, "unknown scale falls back");
  assert.deepEqual(sealRadiiFor(NaN), SEAL_RADII);
});

test("seal: a DOOR-scale opening seals with scale-aware radii — and growback stays out of the corridor", () => {
  // 3-ft door at ~18 px/ft: a 54-px opening in the south wall of a 216×180 room
  // floating on a 1000×800 sheet (ws=1 under the default mask cap). The old
  // fixed 1/2/4 ladder can't bridge it; sealRadiiFor(18) reaches r=45.
  const room = [
    100, 100, 316, 100,                      // top
    316, 100, 316, 280,                      // right
    316, 280, 262, 280,                      // bottom, right of the door
    208, 280, 100, 280,                      // bottom, left of the door (gap 209..261 = 53 open cells)
    100, 280, 100, 100,                      // left
  ];
  const mask = buildMask([...squareSegs(2, 2, 998, 798), ...room], 1000, 800);
  assert.equal(floodRegionSealed(mask, 200, 200).status, "leak", "the fallback ladder cannot bridge a door");
  const f = floodRegionSealed(mask, 200, 200, SENS_BALANCED, sealRadiiFor(18));
  assert.equal(f.status, "ok");
  if (f.status !== "ok") return;
  assert.ok(f.sealedPx! >= 27 && f.sealedPx! <= 45, `bridged at a door-scale radius, got ${f.sealedPx}`);
  const ring = traceRegion(f);
  const area = ringArea(ring);
  // interior ≈ 214×178 = 38,092; monotone growback must recover the wall band
  // WITHOUT annexing a lobe of the sheet beyond the doorway (naive growback
  // at r≈32 would add thousands of px² outside the south wall)
  assert.ok(approx(area, 214 * 178, 0.04), `sealed room ≈ its true area, got ${area}`);
  for (const [x, y] of ring) {
    assert.ok(x > 97 && x < 319 && y > 97, `ring stays on the room, got ${x},${y}`);
    assert.ok(y < 280 + 6, `growback must not dive through the doorway, got ${x},${y}`);
  }
});

test("seal guards: dilation must not resurrect a too-big space the leak cap rejected", () => {
  // A 260×260 enclosure on a 300×300 sheet: 75% of the mask, so the plain
  // flood correctly calls it a leak (not a room). Aggressive dilation starves
  // the interior under the cap mid-flood — but the grown-back region busts the
  // room-size gate, so sealing must decline rather than mint a giant blob.
  const mask = buildMask(squareSegs(20, 20, 280, 280), 300, 300);
  assert.equal(floodRegion(mask, 150, 150).status, "leak", "75% of the sheet is not a room");
  assert.equal(floodRegionSealed(mask, 150, 150, SENS_BALANCED, [64]).status, "leak", "sealing must not resurrect it");
});

test("seal: a room with TWO doorways seals both at once (virtual boundary stays small)", () => {
  const twoGaps = [
    20, 20, 50, 20, 57, 20, 100, 20,                   // north wall, 6-cell gap
    100, 20, 100, 100,
    100, 100, 62, 100, 55, 100, 20, 100,               // south wall, 6-cell gap
    20, 100, 20, 20,
  ];
  const mask = buildMask(twoGaps, 300, 300);
  assert.equal(floodRegion(mask, 60, 60).status, "leak");
  const f = floodRegionSealed(mask, 60, 60);
  assert.equal(f.status, "ok");
  if (f.status !== "ok") return;
  assert.equal(f.sealedPx, 4, "one radius bridges both openings");
  const area = ringArea(traceRegion(f));
  assert.ok(area > 5600 && area < 6800, `both doors sealed, room area intact, got ${area}`);
});

test("door swing: drawn leaf + swing arc bounds the room WITHOUT sealing (the common doorway)", () => {
  // Same room and 53-px opening as the door-scale fixture, but with the usual
  // door symbol drawn: leaf at the open position (perpendicular, into the
  // room) + a quarter-circle swing arc from leaf tip to the strike jamb —
  // fed as chords, exactly how extractVectorGeometry emits beziers. The plain
  // flood must bound at the arc: no sealing, area ≈ room minus the swing wedge.
  const room = [
    100, 100, 316, 100,
    316, 100, 316, 280,
    316, 280, 262, 280,
    208, 280, 100, 280,
    100, 280, 100, 100,
  ];
  const R = 54;                                        // swing radius = the opening width
  const leaf = [208, 280, 208, 280 - R];               // hinge at the left jamb, leaf into the room
  const arc: number[] = [];
  let px = 208, py = 280 - R;                          // tip → strike jamb, quarter circle about the hinge
  for (let k = 1; k <= 8; k++) {
    const a = (k / 8) * (Math.PI / 2);
    const qx = 208 + R * Math.sin(a), qy = 280 - R * Math.cos(a);
    arc.push(px, py, qx, qy); px = qx; py = qy;
  }
  // curve chords carry SEG_CURVE meta so buildMask can mark them bit-4
  const all = [...squareSegs(2, 2, 998, 798), ...room, ...leaf, ...arc];
  const meta = zeroMeta(all);
  const arcStart = (all.length - arc.length) >> 2;
  for (let k = 0; k < arc.length >> 2; k++) meta[arcStart + k] = SEG_CURVE;
  const mask = buildMask(all, 1000, 800, 3000, meta);

  // without a wedge cap: the arc bounds the fill, wedge excluded (pre-annex contract)
  const f = floodRegionSealed(mask, 200, 200, SENS_BALANCED, sealRadiiFor(18));
  assert.equal(f.status, "ok");
  if (f.status !== "ok") return;
  assert.equal(f.sealedPx, undefined, "the door linework bounds the fill — sealing must not fire");
  const bare = ringArea(traceRegion(f));
  const minusWedge = 214 * 178 - (Math.PI * R * R) / 4;
  assert.ok(approx(bare, minusWedge, 0.05), `room minus swing wedge ≈ ${Math.round(minusWedge)}, got ${bare}`);

  // with the scale-aware wedge cap: the swing pocket annexes — flooring runs
  // under the door, so the measurement reads to the wall opening
  const fw = floodRegionSealed(mask, 200, 200, SENS_BALANCED, sealRadiiFor(18), doorWedgeCapPx(18));
  assert.equal(fw.status, "ok");
  if (fw.status !== "ok") return;
  assert.equal(fw.wedges, 1, "exactly one swing wedge annexed");
  const ringFull = traceRegion(fw);
  const full = ringArea(ringFull);
  assert.ok(approx(full, 214 * 178, 0.04), `wedge included ≈ full room ${214 * 178}, got ${full}`);
  // the leaf line must be absorbed, not left as a slit — a crack would send
  // the ring up and back down the leaf, inflating perimeter by ~2 leaf lengths
  const perim = closedMetrics(ringFull).perim;
  assert.ok(approx(perim, 2 * (214 + 178), 0.03), `perimeter ≈ the walls (${2 * (214 + 178)}), got ${perim}`);
});

test("door wedge: a curved WALL does not annex the room behind it (cap holds)", () => {
  // same room, but the curve is a partition arc bowing across the middle —
  // the space beyond it is a half-room, far over the door-wedge cap
  const room = squareSegs(100, 100, 316, 280);
  const part: number[] = [];
  let px = 208, py = 100;
  for (let k = 1; k <= 8; k++) {                       // shallow arc from top wall to bottom wall
    const t = k / 8;
    const qx = 208 + Math.sin(t * Math.PI) * 24, qy = 100 + t * 180;
    part.push(px, py, qx, qy); px = qx; py = qy;
  }
  const all = [...squareSegs(2, 2, 998, 798), ...room, ...part];
  const meta = zeroMeta(all);
  const partStart = (all.length - part.length) >> 2;
  for (let k = 0; k < part.length >> 2; k++) meta[partStart + k] = SEG_CURVE;
  const mask = buildMask(all, 1000, 800, 3000, meta);
  const f = floodRegionSealed(mask, 150, 190, SENS_BALANCED, sealRadiiFor(18), doorWedgeCapPx(18));
  assert.equal(f.status, "ok");
  if (f.status !== "ok") return;
  assert.ok(!f.wedges, "the far half-room must NOT annex");
  const area = ringArea(traceRegion(f));
  assert.ok(area < 214 * 178 * 0.7, `one side of the partition only, got ${area}`);
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

// ── subpaths: the drawn FIGURE each segment belongs to ──────────────────────
// Built from a hand-rolled op list, because the invariant under test is that
// the ranges track exactly what landed in segs — a fixture that reused the
// extractor's own bookkeeping would be a tautology.
function opsFor(items: Array<[number, unknown[]]>, _OPSX?: Record<string, number>) {
  return { fnArray: items.map((i) => i[0]), argsArray: items.map((i) => i[1]) };
}
const OPSX = { moveTo: 1, lineTo: 2, curveTo: 3, curveTo2: 4, curveTo3: 5, closePath: 6, rectangle: 7,
  constructPath: 10, save: 11, restore: 12, transform: 13, setLineWidth: 14, setGState: 15,
  setStrokeRGBColor: 16, endPath: 17, fill: 18, eoFill: 19, clip: 20, eoClip: 21, stroke: 22,
  paintFormXObjectBegin: 30, paintFormXObjectEnd: 31, beginMarkedContent: 32, beginMarkedContentProps: 33,
  endMarkedContent: 34, paintImageXObject: 40, paintInlineImageXObject: 41, paintImageMaskXObject: 42,
  paintImageXObjectRepeat: 43, paintImageMaskXObjectRepeat: 44, paintImageMaskXObjectGroup: 45,
  paintInlineImageXObjectGroup: 46 };
const IDENT = [1, 0, 0, 1, 0, 0];

test("subpaths: one moveTo run is one figure; its range covers exactly its segments", () => {
  const ops = opsFor([
    [OPSX.constructPath, [[OPSX.moveTo, OPSX.lineTo, OPSX.lineTo], [0, 0, 10, 0, 10, 10]]],
    [OPSX.stroke, []],
  ], OPSX);
  const g = extractVectorGeometry(ops, IDENT, OPSX);
  assert.equal(g.subpaths!.length, 1);
  const s = g.subpaths![0];
  assert.deepEqual([s.i0, s.i1], [0, 2], "two segments from three points");
  assert.deepEqual([s.x0, s.y0, s.x1, s.y1], [0, 0, 10, 10], "bbox is the figure's own extent");
  assert.equal(s.closed, false);
});

test("subpaths: each moveTo starts a NEW figure — a stipple field is many, not one", () => {
  const items: Array<[number, unknown[]]> = [];
  const path: number[] = [];
  const coords: number[] = [];
  for (let k = 0; k < 5; k++) {
    path.push(OPSX.moveTo, OPSX.lineTo);
    coords.push(k * 100, 0, k * 100 + 1, 1);       // five isolated flecks, far apart
  }
  items.push([OPSX.constructPath, [path, coords]], [OPSX.stroke, []]);
  const g = extractVectorGeometry(opsFor(items, OPSX), IDENT, OPSX);
  assert.equal(g.subpaths!.length, 5, "five figures, not one compound path");
  for (const s of g.subpaths!) assert.equal(s.i1 - s.i0, 1, "one segment each");
});

test("subpaths: closePath and rectangle mark a figure closed; a rect is its own figure", () => {
  const ops = opsFor([
    [OPSX.constructPath, [[OPSX.moveTo, OPSX.lineTo, OPSX.lineTo, OPSX.closePath, OPSX.rectangle],
      [0, 0, 10, 0, 10, 10, 50, 50, 20, 20]]],
    [OPSX.fill, []],
  ], OPSX);
  const g = extractVectorGeometry(ops, IDENT, OPSX);
  assert.equal(g.subpaths!.length, 2);
  assert.equal(g.subpaths![0].closed, true, "closePath closes the run");
  assert.equal(g.subpaths![1].closed, true, "a rectangle is closed by construction");
  assert.deepEqual([g.subpaths![1].x0, g.subpaths![1].y0], [50, 50], "and carries its own bbox");
  for (const s of g.subpaths!) assert.ok(s.flags & SEG_FILLONLY, "the paint fact rides on the figure");
});

test("subpaths: every segment is covered exactly once", () => {
  const ops = opsFor([
    [OPSX.constructPath, [[OPSX.moveTo, OPSX.lineTo, OPSX.rectangle, OPSX.moveTo, OPSX.lineTo, OPSX.lineTo],
      [0, 0, 5, 5, 20, 20, 10, 10, 40, 40, 45, 45, 50, 50]]],
    [OPSX.stroke, []],
  ], OPSX);
  const g = extractVectorGeometry(ops, IDENT, OPSX);
  const n = g.segs.length >> 2;
  const seen = new Uint8Array(n);
  for (const s of g.subpaths!) for (let i = s.i0; i < s.i1; i++) seen[i]++;
  assert.ok(n > 0);
  for (let i = 0; i < n; i++) assert.equal(seen[i], 1, `segment ${i} covered exactly once`);
});

// ── finish texture (oneclick.ts section 2d) ─────────────────────────────────
// 18 px/ft throughout, matching the other fixtures here.

/** `count` flecks on a `pitch`-px grid starting at (x0, y0), each a 2 px tick. */
function fleckField(x0: number, y0: number, cols: number, rows: number, pitch: number) {
  const segs: number[] = [];
  const subpaths: SubPath[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = x0 + c * pitch, y = y0 + r * pitch;
    const i = segs.length >> 2;
    segs.push(x, y, x + 2, y + 2);
    subpaths.push({ i0: i, i1: i + 1, x0: x, y0: y, x1: x + 2, y1: y + 2, closed: false, flags: 0, fillLum: 0 });
  }
  return { segs, subpaths };
}

test("finish texture: a dense field of sub-wall flecks classifies soft", () => {
  const { segs, subpaths } = fleckField(100, 100, 8, 8, 6);
  const soft = classifyFleckSegs(segs, new Uint8Array(segs.length >> 2), subpaths, 1, 18);
  assert.equal([...soft].every((v) => v === 1), true, "the whole field is texture");
});

test("finish texture: a LONE tiny mark is a detail, not texture", () => {
  const segs = [100, 100, 102, 102];
  const subpaths: SubPath[] = [{ i0: 0, i1: 1, x0: 100, y0: 100, x1: 102, y1: 102, closed: false, flags: 0, fillLum: 0 }];
  assert.equal(classifyFleckSegs(segs, new Uint8Array(1), subpaths, 1, 18)[0], 0);
});

test("finish texture: a figure that reaches wall thickness is never texture", () => {
  // same dense population, but each figure spans a real wall's breadth
  const { segs, subpaths } = fleckField(100, 100, 8, 8, 30);
  for (const s of subpaths) { s.x1 = s.x0 + 20; s.y1 = s.y0 + 20; }   // 20 px > MIN_THICK_FT·18
  const soft = classifyFleckSegs(segs, new Uint8Array(segs.length >> 2), subpaths, 1, 18);
  assert.equal([...soft].some((v) => v === 1), false, "wall-scale figures stay hard whatever their company");
});

test("finish texture: filled and clip-only figures are exempt", () => {
  for (const bit of [SEG_FILLONLY, SEG_CLIP]) {
    const { segs, subpaths } = fleckField(100, 100, 8, 8, 6);
    for (const s of subpaths) s.flags = bit;
    const soft = classifyFleckSegs(segs, new Uint8Array(segs.length >> 2), subpaths, 1, 18);
    assert.equal([...soft].some((v) => v === 1), false, `flag ${bit} exempt`);
  }
});

test("finish texture: no subpaths and no scale are both no-ops (the optional-field contract)", () => {
  const { segs, subpaths } = fleckField(100, 100, 8, 8, 6);
  const meta = new Uint8Array(segs.length >> 2);
  assert.equal([...classifyFleckSegs(segs, meta, null, 1, 18)].some((v) => v === 1), false, "no figures ⇒ nothing");
  assert.equal([...classifyFleckSegs(segs, meta, subpaths, 1, 0)].some((v) => v === 1), false, "no scale ⇒ nothing");
  // a regular test field is ALSO periodic, so the hatch classifier already
  // softens some of it — the contract under test is that passing no figures
  // changes nothing, and passing them can only ADD to the same plane
  const noSub = buildMask(segs, 600, 400, 600, meta, 18);
  const noSubAgain = buildMask(segs, 600, 400, 600, meta, 18, 0, null, null, null);
  const withSub = buildMask(segs, 600, 400, 600, meta, 18, 0, null, null, { subpaths });
  assert.equal(noSubAgain.softCount, noSub.softCount, "an explicit null is the same as omitting it");
  assert.ok(withSub.softCount > noSub.softCount, "figures add to the soft plane, never subtract");
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

// ── offset annotation rings (oneclick.ts section 2c) ────────────────────────
// Every case is the same geometry with one fact changed, because the rule is
// exactly "heavier alongside on one side, open floor on the other" and each
// test removes one clause of it. Units: mask px at ws = 1, 18 px/ft — so the
// 2 ft offset cap is 36 px and the 2 ft minimum run length is 36 px.
const A_MAX = 2 * 18, A_MIN = 0.25 * 18, A_LEN = 2 * 18;
/** wall at y=`wy` (pen `wpen`) with a parallel run `off` px inboard (pen `rpen`),
 *  both spanning x 100..500; returns [segs, meta] with the ring at index 1. */
function offsetPair(off: number, wpen: number, rpen: number): [number[], Uint8Array] {
  const segs = [100, 100, 500, 100, 100, 100 + off, 500, 100 + off];
  const meta = new Uint8Array(2);
  meta[0] = wpen << 4; meta[1] = rpen << 4;
  return [segs, meta];
}

test("offset annotation: a hairline run inboard of a heavier wall is soft", () => {
  const [segs, meta] = offsetPair(27, 2, 1);          // 1.5 ft inboard, pen 1 vs 2
  const soft = classifyOffsetAnnotationSegs(segs, meta, 1, A_MAX, A_MIN, A_LEN);
  assert.equal(soft[1], 1, "the hairline ring classifies");
  assert.equal(soft[0], 0, "the wall does not — what it shadows is LIGHTER");
});

test("offset annotation: same pen is no evidence, so nothing is softened", () => {
  const [segs, meta] = offsetPair(27, 1, 1);
  const soft = classifyOffsetAnnotationSegs(segs, meta, 1, A_MAX, A_MIN, A_LEN);
  assert.deepEqual([...soft], [0, 0], "wall and ring drawn alike cannot be told apart");
});

test("offset annotation: past the offset cap the pair is unrelated linework", () => {
  const [segs, meta] = offsetPair(A_MAX + 4, 2, 1);
  assert.equal(classifyOffsetAnnotationSegs(segs, meta, 1, A_MAX, A_MIN, A_LEN)[1], 0);
});

test("offset annotation: a wall's own two faces are below the minimum offset", () => {
  const [segs, meta] = offsetPair(2, 2, 1);           // 2 px apart — one drawn wall
  assert.equal(classifyOffsetAnnotationSegs(segs, meta, 1, A_MAX, A_MIN, A_LEN)[1], 0);
});

test("offset annotation: a run with something alongside on BOTH sides stays hard", () => {
  // the partition-bank shape: hairline 27 px inboard of a heavy shell, but with
  // a sibling hairline 22 px further in. Only the far side being EMPTY makes a
  // ring a ring; this is what keeps repetitive real architecture measurable.
  const [segs, meta] = offsetPair(27, 3, 1);
  segs.push(100, 149, 500, 149);
  const m3 = new Uint8Array(3); m3[0] = meta[0]; m3[1] = meta[1]; m3[2] = 1 << 4;
  assert.equal(classifyOffsetAnnotationSegs(segs, m3, 1, A_MAX, A_MIN, A_LEN)[1], 0);
});

test("offset annotation: a short stroke is not a wall-spanning run", () => {
  const segs = [100, 100, 500, 100, 100, 127, 130, 127];   // 30 px < 2 ft
  const meta = new Uint8Array(2); meta[0] = 2 << 4; meta[1] = 1 << 4;
  assert.equal(classifyOffsetAnnotationSegs(segs, meta, 1, A_MAX, A_MIN, A_LEN)[1], 0);
});

test("offset annotation: a heavier neighbour that only CROSSES nearby is not alongside", () => {
  const segs = [100, 100, 500, 100, 100, 127, 500, 127];
  const meta = new Uint8Array(2); meta[0] = 2 << 4; meta[1] = 1 << 4;
  segs[0] = 100; segs[2] = 180;                      // shorten the wall to 20% overlap
  assert.equal(classifyOffsetAnnotationSegs(segs, meta, 1, A_MAX, A_MIN, A_LEN)[1], 0);
});

test("offset annotation: curve, clip and fill-only strokes are exempt", () => {
  for (const bit of [SEG_CURVE, SEG_CLIP, SEG_FILLONLY]) {
    const [segs, meta] = offsetPair(27, 2, 1);
    meta[1] |= bit;
    assert.equal(classifyOffsetAnnotationSegs(segs, meta, 1, A_MAX, A_MIN, A_LEN)[1], 0, `bit ${bit} exempt`);
  }
});

// ── dimension strings (oneclick.ts section 2d, issue #320) ──────────────────
// One synthetic comb at the same 18 px/ft convention, then each negative test
// removes the one clause that keeps a wall a wall. The comb: a 23 ft run with
// three crossing witnesses at room-scale spacing, a 45° tick at each junction.
const D_FT = 18;
function dimComb(): [number[], Uint8Array] {
  const segs = [92, 100, 508, 100];                    // the run, overshooting both end junctions
  for (const x of [100, 300, 500]) segs.push(x, 90, x, 112);       // witnesses, crossing
  for (const x of [100, 300, 500]) segs.push(x - 5, 95, x + 5, 105); // 45° ticks ON the run
  return [segs, new Uint8Array(segs.length >> 2)];
}

test("dimension string: run, witnesses and ticks all classify soft", () => {
  const [segs, meta] = dimComb();
  const soft = classifyDimensionStringSegs(segs, meta, 1, D_FT);
  assert.deepEqual([...soft], segs.map(() => 1).slice(0, segs.length >> 2), "the whole comb is annotation");
});

test("dimension string: a wall face with a parallel partner is never a run", () => {
  // the comb, plus a double-line wall drawn with the SAME comb shape riding on
  // one face — the partner face 0.44 ft away is what keeps it hard
  const [segs, meta0] = dimComb();
  const wall = [92, 300, 508, 300, 92, 308, 508, 308];             // two faces, full overlap
  const all = [...segs, ...wall];
  const meta = new Uint8Array(all.length >> 2);
  const soft = classifyDimensionStringSegs(all, meta, 1, D_FT);
  const nComb = segs.length >> 2;
  assert.equal(soft[nComb], 0, "wall face stays hard");
  assert.equal(soft[nComb + 1], 0, "partner face stays hard");
  assert.equal(soft[0], 1, "the comb still classifies beside it");
  assert.ok(meta0.length >= 0);
});

test("dimension string: a comb without ticks is casework, not a dimension", () => {
  const segs = [92, 100, 508, 100];
  for (const x of [150, 300, 450]) segs.push(x, 100, x, 136);      // dividers, no ticks
  const soft = classifyDimensionStringSegs(segs, new Uint8Array(segs.length >> 2), 1, D_FT);
  assert.deepEqual([...soft], [0, 0, 0, 0], "no junction marks ⇒ nothing softens");
});

test("dimension string: a rectangle's corners are joints where nothing continues past", () => {
  // a legend-swatch box with oblique pattern strokes inside — the Crunch
  // Fitness false positive this rejection exists for
  const segs = [
    100, 100, 500, 100,   // top edge (the would-be run)
    100, 136, 500, 136,   // bottom edge — 2 ft off, OUTSIDE the iso window
    100, 100, 100, 136,   // left side: stops AT the top edge
    500, 100, 500, 136,   // right side: stops AT the top edge
  ];
  for (let x = 140; x <= 460; x += 40) segs.push(x - 4, 98, x + 4, 106);  // pattern obliques near the edge
  const soft = classifyDimensionStringSegs(segs, new Uint8Array(segs.length >> 2), 1, D_FT);
  assert.equal(soft[0], 0, "box edge stays hard — its only junctions are corners");
});

test("dimension string: sub-foot witness rhythm is coursing, not dimensioning", () => {
  const segs = [92, 100, 508, 100];
  for (let x = 100; x <= 500; x += 9) segs.push(x, 90, x, 112);    // 0.5 ft pitch
  segs.push(95, 95, 105, 105, 295, 95, 305, 105);                  // even with plausible ticks
  const soft = classifyDimensionStringSegs(segs, new Uint8Array(segs.length >> 2), 1, D_FT);
  assert.equal(soft[0], 0, "dense comb stays hard");
});

test("dimension string: a witness glued into longer linework is evidence, never softened", () => {
  const [segs, meta] = dimComb();
  // stretch the middle witness into a 12 ft stroke — longer than the soften cap
  segs[4 * 4] = 300; segs[4 * 4 + 1] = 90; segs[4 * 4 + 2] = 300; segs[4 * 4 + 3] = 306;
  const soft = classifyDimensionStringSegs(segs, meta, 1, D_FT);
  assert.equal(soft[0], 1, "run softens");
  assert.equal(soft[4], 0, "the long witness stays hard");
});

// ── text-anchored interior strings (path B) + the region merge ──────────────

test("dim text anchors an interior line: pieces and ticks soften; without text, nothing", () => {
  // an interior dim line has no comb-clean surroundings — path A must refuse
  // it, and the TEXT is what identifies it
  const segs = [200, 90, 200, 400];                       // the line, vertical, 17 ft
  segs.push(195, 195, 205, 205, 195, 295, 205, 305);      // 45° ticks on it
  const meta = new Uint8Array(segs.length >> 2);
  const none = classifyDimensionStringSegs(segs, meta, 1, D_FT);
  assert.deepEqual([...none], [0, 0, 0], "no text ⇒ an isolated interior line stays hard");
  const withText = classifyDimensionStringSegs(segs, meta, 1, D_FT, [{ x: 203, y: 240, ang: 90, wPx: 60 }]);
  assert.deepEqual([...withText], [1, 1, 1], "text on the line ⇒ line and ticks soften");
});

test("dim text: a room label's underline is not a dimension line", () => {
  const segs = [180, 240, 250, 240];                      // 70 px underline under 60 px text
  const soft = classifyDimensionStringSegs(segs, new Uint8Array(1), 1, D_FT, [{ x: 215, y: 236, ang: 0, wPx: 60 }]);
  assert.deepEqual([...soft], [0], "the line must dwarf its text");
});

test("dim text: schedule-table rules self-protect through the wall guard", () => {
  // dim-pattern text INSIDE a table cell: the row rules above and below ride
  // 0.5 ft apart for their whole length — partnered linework, never softened
  const segs = [100, 231, 500, 231, 100, 249, 500, 249];
  const soft = classifyDimensionStringSegs(segs, new Uint8Array(2), 1, D_FT, [{ x: 300, y: 244, ang: 0, wPx: 60 }]);
  assert.deepEqual([...soft], [0, 0], "partnered rules stay hard");
});

test("a room chopped by a text-anchored dim line floods WHOLE, from either side", () => {
  // 30×15 ft room, an interior dimension line splitting it 2:1, dim text on
  // the line. Without the text the flood chops at the line; with it, the
  // region merge unions the strict pieces and both sides click to ONE answer.
  const segs = squareSegs(100, 100, 640, 370);
  segs.push(280, 100, 280, 370);                          // the chopping line
  segs.push(275, 175, 285, 185, 275, 285, 285, 295);      // its ticks
  const meta = new Uint8Array(segs.length >> 2);
  const dimText = [{ x: 283, y: 235, ang: 90, wPx: 60 }];
  const moPlain = buildMask(segs, 1000, 600, 1000, meta, D_FT);
  const moText = buildMask(segs, 1000, 600, 1000, meta, D_FT, 0, null, null, { dimTexts: dimText });
  const flood = (mo: MaskObj, x: number, y: number) => {
    const r = floodRegionSealed(mo, x, y, 0.5, sealRadiiFor(mo.mppf || D_FT), 0, 0);
    assert.equal(r.status, "ok");
    return r.status === "ok" ? r.count : 0;
  };
  const chopLeft = flood(moPlain, 190, 235);
  const wholeLeft = flood(moText, 190, 235);
  const wholeRight = flood(moText, 460, 235);
  assert.ok(chopLeft < wholeLeft * 0.5, `text heals the chop (${chopLeft} → ${wholeLeft})`);
  assert.equal(wholeLeft, wholeRight, "either side of the chop clicks to the same union");
  // and the union is the room: 540×270 px interior, ring a hair inside the walls
  assert.ok(Math.abs(wholeLeft - 540 * 270) / (540 * 270) < 0.03, `union ≈ the room (${wholeLeft})`);
});

test("dimension string: buildMask unions the plane only when the scale is known", () => {
  const [segs, meta] = dimComb();
  const noScale = buildMask(segs, 600, 400, 600, meta);
  const withScale = buildMask(segs, 600, 400, 600, meta, D_FT);
  assert.equal(noScale.softCount, 0, "scale unknown ⇒ nothing softened");
  assert.ok(withScale.softCount > 0, "scale known ⇒ the comb is soft");
});

test("offset annotation: an unscaled sheet gets no annotation plane at all", () => {
  // buildMask only runs the classifier when mppf > 0 — every threshold here is
  // a physical distance, and guessing them in raw px would soften on no evidence
  const [segs, meta] = offsetPair(27, 2, 1);
  const mo = buildMask(segs, 600, 400, 600, meta);     // no pxPerFt
  const withScale = buildMask(segs, 600, 400, 600, meta, 18);
  assert.equal(mo.softCount, 0, "scale unknown ⇒ nothing softened");
  assert.ok(withScale.softCount > 0, "scale known ⇒ the ring is soft");
});

// ── door leaves and glued arc clusters (the in-swing sector) ────────────────
// A tiny hand-built mask: MW×MH cells, arcs plotted as curve cells, leaves as
// plain hard ink, so each test states one geometric fact and nothing else.
const MW = 200, MH = 200;
function blank() { return new Uint8Array(MW * MH); }
function putArc(m: Uint8Array, cx: number, cy: number, r: number, a0: number, a1: number, step = 0.02) {
  const cells: number[] = [];
  for (let a = a0; a <= a1; a += step) {
    const x = Math.round(cx + r * Math.cos(a)), y = Math.round(cy + r * Math.sin(a));
    const i = y * MW + x;
    if (!(m[i] & MASK_CURVE_BIT)) cells.push(i);
    m[i] |= 1 | MASK_CURVE_BIT;
  }
  return cells;
}
function putLeaf(m: Uint8Array, cx: number, cy: number, r: number, a: number) {
  const ux = Math.cos(a), uy = Math.sin(a);
  for (let t = 0; t <= r; t += 0.25) {
    for (const o of [-0.5, 0, 0.5]) {
      const x = Math.round(cx + ux * t - uy * o), y = Math.round(cy + uy * t + ux * o);
      m[y * MW + x] |= 1;                       // hard, NOT curve — that is what makes it a leaf
    }
  }
}

test("splitMergedArcs: one clean arc is returned untouched", () => {
  const m = blank();
  const cl = putArc(m, 100, 100, 30, 0, Math.PI / 2);
  assert.deepEqual(splitMergedArcs(cl, MW, m, 18), [cl], "a cluster that fits one circle is never parted");
});

test("splitMergedArcs: two doors glued into one cluster are parted", () => {
  const m = blank();
  const a = putArc(m, 60, 100, 28, 0, Math.PI / 2);
  const b = putArc(m, 140, 100, 28, Math.PI / 2, Math.PI);   // a different hinge
  const glued = [...a, ...b];
  assert.equal(arcClusterFit(glued, MW, m).good, false, "one circle cannot explain two doors");
  const parts = splitMergedArcs(glued, MW, m, 18);
  assert.equal(parts.length, 2, "parted into its two arcs");
  for (const p of parts) assert.equal(arcClusterFit(p, MW, m).good, true, "and each part fits its own circle");
});

test("splitMergedArcs: a DASHED arc is put back together, not shattered", () => {
  // the reason the 3-cell bridge exists: pieces of ONE arc share a circle, so
  // they must re-merge even though the tight re-split separates them
  const m = blank();
  const cl: number[] = [];
  for (let k = 0; k < 6; k++) cl.push(...putArc(m, 100, 100, 30, k * 0.28, k * 0.28 + 0.16));
  const parts = splitMergedArcs(cl, MW, m, 18);
  assert.equal(parts.length, 1, "one dashed arc stays one cluster");
});

test("doorLeafCells: finds the straight radius at the arc's end, and only hard ink", () => {
  const m = blank();
  const cl = putArc(m, 100, 100, 30, 0, Math.PI / 2);
  putLeaf(m, 100, 100, 30, 0);                  // leaf along the 0° end of the sweep
  const fit = arcClusterFit(cl, MW, m);
  const leaf = doorLeafCells(fit, cl, MW, MH, m, 18);
  assert.ok(leaf && leaf.length > 10, "the leaf is found");
  for (const i of leaf as number[]) assert.equal(m[i] & MASK_CURVE_BIT, 0, "never returns arc cells — the arc must stay hard");
});

test("doorLeafCells: an arc with no leaf drawn returns null", () => {
  const m = blank();
  const cl = putArc(m, 100, 100, 30, 0, Math.PI / 2);
  assert.equal(doorLeafCells(arcClusterFit(cl, MW, m), cl, MW, MH, m, 18), null);
});

test("doorLeafCells: opens a CONTIGUOUS run — a dotted opening does not breach a barrier", () => {
  const m = blank();
  const cl = putArc(m, 100, 100, 30, 0, Math.PI / 2);
  putLeaf(m, 100, 100, 30, 0);
  const leaf = doorLeafCells(arcClusterFit(cl, MW, m), cl, MW, MH, m, 18) as number[];
  // walking the opened cells 8-connected must reach them all: a gap anywhere
  // leaves a hard bridge and the retry silently reports "no growth"
  const set = new Set(leaf), seen = new Set([leaf[0]]), stack = [leaf[0]];
  while (stack.length) {
    const i = stack.pop() as number, y = (i / MW) | 0, x = i - y * MW;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const j = (y + dy) * MW + (x + dx);
      if (set.has(j) && !seen.has(j)) { seen.add(j); stack.push(j); }
    }
  }
  assert.equal(seen.size, leaf.length, "the opened leaf is one connected run");
});

// ── polyline arc detection + periodicity classification (issue #184 item C) ─
// Chords of a circle: tessellated like CAD exports draw door swings (lineTo
// runs, no bezier ops). dashEvery drops every 2nd chord to fake a dash pattern.
function arcChords(cx: number, cy: number, r: number, a0: number, a1: number, steps: number, dashed = false): number[] {
  const segs: number[] = [];
  let px = cx + r * Math.cos(a0), py = cy + r * Math.sin(a0);
  for (let k = 1; k <= steps; k++) {
    const a = a0 + (a1 - a0) * (k / steps);
    const qx = cx + r * Math.cos(a), qy = cy + r * Math.sin(a);
    if (!dashed || k % 2 === 1) segs.push(px, py, qx, qy);
    px = qx; py = qy;
  }
  return segs;
}

test("markPolylineArcs: a tessellated quarter-arc polyline gets SEG_CURVE|SEG_POLYARC", () => {
  const arc = arcChords(200, 200, 54, 0, Math.PI / 2, 10);
  const meta = new Uint8Array(arc.length >> 2);
  const marked = markPolylineArcs(arc, meta);
  assert.equal(marked, 10, "every chord marked");
  for (let i = 0; i < meta.length; i++) assert.equal(meta[i], SEG_CURVE | SEG_POLYARC);
});

test("markPolylineArcs: a DASHED arc (gaps between dashes, dash-split chords) still detects", () => {
  // 9° dashes with 3° gaps around a quarter circle — gaps run shorter than
  // dashes, like real dash patterns. One dash is split into two collinear
  // halves (dash patterns cut chords mid-segment, leaving an isolated
  // near-zero turn inside the arc).
  const segs: number[] = [];
  const r = 54, deg = Math.PI / 180;
  for (let a = 0; a + 9 <= 90; a += 12) {
    const p = (t: number): [number, number] => [200 + r * Math.cos(t * deg), 200 + r * Math.sin(t * deg)];
    const [ax, ay] = p(a), [mx, my] = p(a + 4.5), [bx, by] = p(a + 9);
    if (a === 24) {  // split this dash's first chord collinearly
      const qx = (ax + mx) / 2, qy = (ay + my) / 2;
      segs.push(ax, ay, qx, qy, qx, qy, mx, my, mx, my, bx, by);
    } else {
      segs.push(ax, ay, mx, my, mx, my, bx, by);
    }
  }
  const meta = new Uint8Array(segs.length >> 2);
  const marked = markPolylineArcs(segs, meta);
  assert.ok(marked >= (segs.length >> 2) - 2, `dashed arc chords marked (got ${marked}/${segs.length >> 2})`);
  let curveBits = 0;
  for (let i = 0; i < meta.length; i++) if (meta[i] & SEG_POLYARC) curveBits++;
  assert.ok(curveBits >= (segs.length >> 2) - 2, "chords carry the polyarc provenance bit");
});

test("markPolylineArcs: a joined off-circle stub doesn't kill the arc — trimmed, arc marked, stub not (review round 8)", () => {
  // a straight stub meets the arc start at a plausible signed turn; its
  // vertex is off the circle, so an all-or-nothing fit would reject the
  // whole window. The trim-retry must recover the arc without the stub.
  const arc = arcChords(200, 200, 54, 0, Math.PI / 2, 10);
  const [ax, ay] = [arc[0], arc[1]];
  const dir = Math.atan2(arc[3] - ay, arc[2] - ax) - (30 * Math.PI) / 180;  // 30° turn into the arc
  const stub = [ax - 10 * Math.cos(dir), ay - 10 * Math.sin(dir), ax, ay];
  const segs = [...stub, ...arc];
  const meta = new Uint8Array(segs.length >> 2);
  const marked = markPolylineArcs(segs, meta);
  assert.ok(marked >= 9, `arc chords recovered despite the stub (got ${marked})`);
  assert.equal(meta[0] & SEG_POLYARC, 0, "the stub itself is not marked");
  let arcMarked = 0;
  for (let i = 1; i < meta.length; i++) if (meta[i] & SEG_POLYARC) arcMarked++;
  assert.ok(arcMarked >= 9, `arc body carries the bit (got ${arcMarked}/10)`);
});

test("markPolylineArcs: straight dashed lines, zigzags, and ellipses are NOT arcs", () => {
  const dashedLine: number[] = [];
  for (let x = 100; x < 180; x += 8) dashedLine.push(x, 50, x + 4.5, 50);
  const zigzag: number[] = [];
  for (let k = 0; k < 12; k++) zigzag.push(100 + k * 10, k % 2 ? 60 : 50, 110 + k * 10, k % 2 ? 50 : 60);
  const ellipse: number[] = [];
  { // 2:1 ellipse, 24 chords — turns are arc-like but no single circle fits
    let px = 260, py = 300;
    for (let k = 1; k <= 24; k++) {
      const a = (k / 24) * 2 * Math.PI;
      const qx = 200 + 60 * Math.cos(a), qy = 300 + 30 * Math.sin(a);
      ellipse.push(px, py, qx, qy); px = qx; py = qy;
    }
  }
  for (const [name, segs] of [["dashed line", dashedLine], ["zigzag", zigzag], ["ellipse", ellipse]] as const) {
    const meta = new Uint8Array(segs.length >> 2);
    markPolylineArcs(segs, meta);
    for (let i = 0; i < meta.length; i++) assert.equal(meta[i] & SEG_POLYARC, 0, `${name} seg ${i} must not be an arc`);
  }
});

test("markPolylineArcs → buildMask: detected arc cells carry MASK_CURVE_BIT (door-swing unification path)", () => {
  const segs = [...squareSegs(20, 20, 380, 380), ...arcChords(200, 200, 54, 0, Math.PI / 2, 10)];
  const meta = new Uint8Array(segs.length >> 2);
  markPolylineArcs(segs, meta);
  const m = buildMask(segs, 400, 400, 400, meta);
  const mid = [200 + 54 * Math.cos(Math.PI / 4), 200 + 54 * Math.sin(Math.PI / 4)];
  const cell = m.mask[Math.round(mid[1] * m.ws) * m.mw + Math.round(mid[0] * m.ws)];
  assert.equal(cell & 1, 1, "arc cell is a hard barrier");
  assert.equal(cell & MASK_CURVE_BIT, MASK_CURVE_BIT, "arc cell is recognizable as curve linework");
});

test("periodicity: resolvably-IRREGULAR pitch is not hatch (the old ±35% band said it was)", () => {
  // gaps jitter by several mask cells around a ~33 px rhythm — every one of
  // them inside the old regularity band, none of them a lattice at raster
  // precision. (Sub-cell jitter at tight pitches is a different story: the
  // raster genuinely cannot resolve it, so it may classify — honestly.)
  const segs: number[] = [];
  let x = 100;
  for (const gap of [0, 30, 36, 31, 38, 33, 30.5, 37, 32, 35.5, 30, 36.5]) {
    x += gap;
    segs.push(x, 100, x, 500);
  }
  const soft = classifyHatchSegs(segs, new Uint8Array(segs.length >> 2), 0.5);
  for (let i = 0; i < soft.length; i++) assert.equal(soft[i], 0, `irregular row ${i} stays hard`);
});

test("periodicity: a pattern edge with a FAR same-pen stroke beyond it stays hard (clipped-guard tautology, review round 8)", () => {
  // hatch patch rows at pitch 4 image px; one unrelated same-pen parallel
  // stroke 4 pitches beyond the bottom edge (open space, not a bounding
  // wall). The clipped-edge clause must test the bound on the side OPPOSITE
  // its lattice — the edge row only softens when clipped within ONE pitch.
  const segs: number[] = [];
  for (const y of [100, 104, 108, 112, 116]) segs.push(200, y, 400, y);
  segs.push(200, 84, 400, 84);                         // far stroke, 4 pitches below the y=100 edge
  const soft = classifyHatchSegs(segs, new Uint8Array(segs.length >> 2), 0.5);
  assert.equal(soft[0], 0, "the y=100 pattern edge stays hard (far stroke is not a clip bound)");
  assert.equal(soft[5], 0, "the lone far stroke stays hard");
  assert.equal(soft[2], 1, "interior rows still classify");
});

test("periodicity: door-arc chords are not a periodic family (unmarked arcs, the round-7 failure)", () => {
  // six identical door swings along a wall — WITHOUT arc marking, straight to
  // the classifier: same-angle chords repeat across doors, but their normal
  // offsets are door positions, not a fill pitch. The old run heuristic
  // soft-flagged exactly these (VA plan, round 7).
  const segs: number[] = [];
  for (let d = 0; d < 6; d++) segs.push(...arcChords(150 + d * 90, 200, 54, 0, Math.PI / 2, 10));
  const soft = classifyHatchSegs(segs, new Uint8Array(segs.length >> 2), 0.5);
  for (let i = 0; i < soft.length; i++) assert.equal(soft[i], 0, `arc chord ${i} stays hard`);
});

test("periodicity: dashed hatch rows (pieces) still classify soft", () => {
  const segs: number[] = [];
  for (let k = 0; k < 14; k++) {
    const y = 100 + k * 4;
    for (let x = 100; x < 300; x += 20) segs.push(x, y, x + 14, y);   // dashes per row
  }
  const soft = classifyHatchSegs(segs, new Uint8Array(segs.length >> 2), 0.5);
  let cnt = 0; for (let i = 0; i < soft.length; i++) cnt += soft[i];
  assert.ok(cnt > soft.length * 0.6, `interior dashed rows classify soft (got ${cnt}/${soft.length})`);
});

test("periodicity: a floating hatch patch is a finish zone — two clicks, two regions, both measured", () => {
  // 600×400 room; the left quarter carries a floor pattern whose edge row
  // (the outermost hatch line) has no lattice beyond it, so it stays hard:
  // it IS the finish boundary. A click in the open side reads up to it; a
  // click inside the pattern escalates and measures the patch wall-to-wall
  // (dense hatch, failure mode #1 — the VA toilet-room case).
  const hatch: number[] = [];
  for (let x = 104; x <= 240; x += 4) hatch.push(x, 100, x, 500);
  const all = [...border, ...room, ...hatch];
  const m = buildMask(all, IMG_W, IMG_H, MAXDIM, zeroMeta(all));
  const open = floodRegion(m, 500, 300);               // open (unhatched) side
  assert.equal(open.status, "ok");
  if (open.status !== "ok") return;
  const openArea = ringArea(traceRegion(open));
  assert.ok(approx(openArea, (700 - 240) * 400, 0.04), `open side reads to the pattern edge, got ${openArea}`);
  const patch = floodRegion(m, 170, 300);              // inside the pattern
  assert.equal(patch.status, "ok");
  if (patch.status !== "ok") return;
  assert.equal(patch.hatchFiltered, true, "the dense-hatch click escalates instead of refusing");
  assert.ok(approx(ringArea(traceRegion(patch)), (240 - 100) * 400, 0.06), `patch reads wall-to-wall, got ${ringArea(traceRegion(patch))}`);
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

// The O(N²) lattice-query fix (adversarial review, round 8) shipped with NO
// regression test — reverting the bisect + prefix-max in rowHas to the naive
// full-row scan left the whole suite AND the bench green (audit finding D7).
// This is the missing guard.
//
// The degenerate shape is the one the comment at oneclick.ts:532-536 names: a
// dense band of same-angle, same-pen, NON-overlapping pieces. Note it needs many
// pieces in FEW rows, not many rows — a first attempt at this test used 400 rows
// of 100 and passed happily against the reverted code, because the naive scan
// over 100 pieces is cheap. Measured here at 40k segments in 4 rows:
// fixed ~123 ms, naive ~5,671 ms. The 1.5 s bound sits 12× above the fixed path
// and 3.8× below the naive one.
test("classifyHatchSegs stays sub-quadratic on a dense same-angle tick swarm", () => {
  const ROWS = 4, PER_ROW = 10000;            // 40,000 segments, 4 rows
  const segs: number[] = [];
  for (let r = 0; r < ROWS; r++) {
    const y = 100 + r * 3;                    // distinct rows, inside the pitch cap
    for (let i = 0; i < PER_ROW; i++) {
      const x = 100 + i * 11;                 // staggered, non-overlapping ticks
      segs.push(x, y, x + 6, y);
    }
  }
  const meta = new Uint8Array(segs.length / 4);
  const t0 = performance.now();
  const soft = classifyHatchSegs(segs, meta, 1, 24);
  const ms = performance.now() - t0;
  assert.equal(soft.length, segs.length / 4);
  assert.ok(ms < 1500, `classifyHatchSegs took ${Math.round(ms)} ms on 40k same-angle segments in ${ROWS} rows — the row query has gone quadratic again`);
});
