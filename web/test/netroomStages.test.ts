import { test } from "node:test";
import assert from "node:assert/strict";
import { endPairsStage, healSegments, lineClosuresStage, makeFinishContext, makeInkContext, makeMaterialContext } from "../src/lib/netroom.js";
import { pointInRing } from "../src/lib/polyarr.js";

// A 10 px foot keeps every threshold in whole units: 1.2 ft = 12, 7 ft = 70.
const FT = 10;

type End = { x: number; y: number; dir: [number, number]; hw: number; corners: number[][] };

function mkEnd(x: number, y: number, dir: [number, number], hw = 3, corners?: number[][]): End {
  const nx = -dir[1], ny = dir[0];
  return { x, y, dir, hw, corners: corners ?? [[x + nx * hw, y + ny * hw], [x - nx * hw, y - ny * hw]] };
}

// e0 faces +x at x=0; e1 faces -x at x=40. A 4 ft gap, widths equal.
const facing: End[] = [mkEnd(0, 0, [1, 0]), mkEnd(40, 0, [-1, 0])];

test("endPairsStage: facing collinear pair emits the synth ladder and the door quad", () => {
  const out = endPairsStage(facing, [], [], FT);
  assert.deepEqual(out.synth, [
    0, 3, 40, 3,
    0, -3, 40, -3,
    0, 3, 0, -3,
    40, 3, 40, -3,
  ]);
  assert.deepEqual(out.doorQuads, [[[0, 3], [40, 3], [40, -3], [0, -3]]]);
});

test("endPairsStage: wall material on the connector blocks the pair", () => {
  const blocked = [[[10, -1], [20, -1], [20, 1], [10, 1]]];
  const out = endPairsStage(facing, blocked, [], FT);
  assert.deepEqual(out.synth, []);
  assert.deepEqual(out.doorQuads, []);
});

test("endPairsStage: a fixture symbol at the midpoint blocks the pair", () => {
  const out = endPairsStage(facing, [], [[18, -2, 22, 2]], FT);
  assert.deepEqual(out.synth, []);
  assert.deepEqual(out.doorQuads, []);
});

test("endPairsStage: equal-distance pairs keep insertion order, not a re-sort", () => {
  const ends = [
    mkEnd(0, 0, [1, 0]),
    mkEnd(40, 0, [-1, 0]),
    mkEnd(0, 200, [1, 0]),
    mkEnd(40, 200, [-1, 0]),
  ];
  const out = endPairsStage(ends, [], [], FT);
  assert.deepEqual(out.synth, [
    // first pair: inserted first by the (i, j) loop
    0, 3, 40, 3,
    0, -3, 40, -3,
    0, 3, 0, -3,
    40, 3, 40, -3,
    // second pair: same distance, inserted second
    0, 203, 40, 203,
    0, 197, 40, 197,
    0, 203, 0, 197,
    40, 203, 40, 197,
  ]);
  assert.deepEqual(out.doorQuads, [
    [[0, 3], [40, 3], [40, -3], [0, -3]],
    [[0, 203], [40, 203], [40, 197], [0, 197]],
  ]);
});

// 3 ft, on the circle around end 0 at y=240. The two points sit 3 px either
// side of the y=240 cell boundary, so the 3x3 scan visits the HIGHER index's
// bucket first. A candidate stream sorted by j would choose the other pair.
const DX = Math.sqrt(900 - 9);
const bucketTieEnds = [
  { x: 0, y: 240, ux: 1, uy: 0 },
  { x: 10000, y: 10000, ux: 1, uy: 0 },
  { x: DX, y: 243, ux: -1, uy: 0 },  // lower j, bucket (0,0) — visited second
  { x: 10000, y: 10000, ux: 1, uy: 0 },
  { x: 10000, y: 10000, ux: 1, uy: 0 },
  { x: DX, y: 237, ux: -1, uy: 0 },  // higher j, bucket (0,-1) — visited first
];

test("lineClosuresStage: equal-distance pairs keep bucket order, not ascending j", () => {
  const out = lineClosuresStage({
    lineEnds: bucketTieEnds,
    finishDiffers: () => true,
    crossesInk: () => false,
    inXboxPt: () => false,
    ftPx: FT,
    lcmin: 0.7,
    nofinish: false,
  });
  assert.deepEqual(out.outClosures, [
    { seg: [[0, 240], [DX, 237]], door: false, finish: false },
  ]);
  assert.deepEqual(out.outLeUsed, [0, 5]);
});

test("lineClosuresStage: j <= i is skipped — the lower index considers the pair once", () => {
  const lineEnds = [
    { x: 0, y: 0, ux: 1, uy: 0 },
    { x: 30, y: 0, ux: -1, uy: 0 },
  ];
  const calls: number[][] = [];
  lineClosuresStage({
    lineEnds,
    finishDiffers: () => false,
    crossesInk: (...a: number[]) => { calls.push(a); return false; },
    inXboxPt: () => false,
    ftPx: FT,
    lcmin: 0.7,
    nofinish: false,
  });
  assert.deepEqual(calls, [[30 * 0.06, 0, 30 * 0.94, 0]]);
});

test("lineClosuresStage: lcmin floor rejects a sub-floor gap before any ink scan", () => {
  const calls: number[][] = [];
  const out = lineClosuresStage({
    lineEnds: [
      { x: 0, y: 0, ux: 1, uy: 0 },
      { x: 5, y: 0, ux: -1, uy: 0 },
    ],
    finishDiffers: () => true,
    crossesInk: (...a: number[]) => { calls.push(a); return false; },
    inXboxPt: () => false,
    ftPx: FT,
    lcmin: 0.7,
    nofinish: false,
  });
  assert.deepEqual(out.outClosures, []);
  assert.deepEqual(calls, []);
});

test("lineClosuresStage: nofinish drops the wide-gap finish closure", () => {
  const wide = [
    { x: 0, y: 0, ux: 1, uy: 0 },
    { x: 100, y: 0, ux: -1, uy: 0 },
  ];
  const kwargs = {
    lineEnds: wide,
    finishDiffers: () => true,
    crossesInk: () => false,
    inXboxPt: () => false,
    ftPx: FT,
    lcmin: 0.7,
  };
  const on = lineClosuresStage({ ...kwargs, nofinish: false });
  assert.deepEqual(on.outClosures, [
    { seg: [[0, 0], [100, 0]], door: false, finish: true },
  ]);
  const off = lineClosuresStage({ ...kwargs, nofinish: true });
  assert.deepEqual(off.outClosures, []);
});

test("lineClosuresStage: the 7 ft branch is strict — finish evidence starts above it", () => {
  for (const [d, want, asked] of [[70, false, 0], [71, true, 1]] as const) {
    let calls = 0;
    const out = lineClosuresStage({
      lineEnds: [
        { x: 0, y: 0, ux: 1, uy: 0 },
        { x: d, y: 0, ux: -1, uy: 0 },
      ],
      finishDiffers: () => { calls++; return true; },
      crossesInk: () => false,
      inXboxPt: () => false,
      ftPx: FT,
      lcmin: 0.7,
      nofinish: false,
    });
    assert.equal(out.outClosures[0].finish, want, `finish flag at ${d} px`);
    assert.equal(calls, asked, `finishDiffers calls at ${d} px`);
  }
});

const FG = 2 * FT, LG = 8 * FT;

function addHatch(map: Map<string, number[]>, pts: number[][], bkt: number) {
  for (const [x, y] of pts) {
    const k = `${Math.floor(x / FG)},${Math.floor(y / FG)}`;
    const b = map.get(k);
    if (b) b.push(x, y, bkt); else map.set(k, [x, y, bkt]);
  }
}

function addLongLine(map: Map<string, number[]>, i: number, segs: number[]) {
  const x1 = segs[i * 4], y1 = segs[i * 4 + 1], x2 = segs[i * 4 + 2], y2 = segs[i * 4 + 3];
  for (let gx = Math.floor(Math.min(x1, x2) / LG); gx <= Math.floor(Math.max(x1, x2) / LG); gx++)
    for (let gy = Math.floor(Math.min(y1, y2) / LG); gy <= Math.floor(Math.max(y1, y2) / LG); gy++) {
      const k = `${gx},${gy}`;
      const b = map.get(k);
      if (b) b.push(i); else map.set(k, [i]);
    }
}

// Hatch votes 4+1.2 ft either side of the connector (0,0)→(100,0), sampled at
// (50,±12). Same bucket = one field; different buckets = a finish change.
const HATCH_POS = [[44, 10], [50, 8], [56, 12], [50, 16]];
const HATCH_NEG = [[44, -10], [50, -8], [56, -12], [50, -16]];

function finishFixture(opts: { sameBucket?: boolean; transition?: boolean; xbox?: boolean }) {
  const finishGrid = new Map<string, number[]>();
  addHatch(finishGrid, HATCH_POS, 0);
  addHatch(finishGrid, HATCH_NEG, opts.sameBucket ? 0 : 1);
  const segs = [-10, 0.5, 110, 0.5];
  const longGrid = new Map<string, number[]>();
  if (opts.transition) addLongLine(longGrid, 0, segs);
  const xboxes = opts.xbox ? [[40, -5, 60, 5]] : [];
  return makeFinishContext(finishGrid, longGrid, segs, xboxes, FT).finishDiffers;
}

test("makeFinishContext: hatch fields on the same side family differ nowhere", () => {
  assert.equal(finishFixture({ sameBucket: true, transition: true })(0, 0, 100, 0), false);
});

test("makeFinishContext: differing hatch fields under a drawn transition are a finish change", () => {
  assert.equal(finishFixture({ transition: true })(0, 0, 100, 0), true);
});

test("makeFinishContext: a fixture symbol crossing the connector vetoes the transition", () => {
  assert.equal(finishFixture({ transition: true, xbox: true })(0, 0, 100, 0), false);
});

test("makeFinishContext: differing fields without a transition line are not a finish change", () => {
  assert.equal(finishFixture({ transition: false })(0, 0, 100, 0), false);
});

// Local reference: the original crossesInk body, used only to compare the
// builder's predicate on a fixture.
function crossesInkRef(wallInk: number[], ftPx: number, ax: number, ay: number, bx: number, by: number) {
  const IG = 2 * ftPx;
  const grid = new Map<string, number[]>();
  for (let i = 0; i + 3 < wallInk.length; i += 4) {
    const x0 = Math.min(wallInk[i], wallInk[i + 2]), x1 = Math.max(wallInk[i], wallInk[i + 2]);
    const y0 = Math.min(wallInk[i + 1], wallInk[i + 3]), y1 = Math.max(wallInk[i + 1], wallInk[i + 3]);
    for (let gx = Math.floor(x0 / IG); gx <= Math.floor(x1 / IG); gx++)
      for (let gy = Math.floor(y0 / IG); gy <= Math.floor(y1 / IG); gy++) {
        const k = `${gx},${gy}`;
        const b = grid.get(k);
        if (b) b.push(i); else grid.set(k, [i]);
      }
  }
  const dxc = bx - ax, dyc = by - ay;
  const gx0 = Math.floor(Math.min(ax, bx) / IG), gx1 = Math.floor(Math.max(ax, bx) / IG);
  const gy0 = Math.floor(Math.min(ay, by) / IG), gy1 = Math.floor(Math.max(ay, by) / IG);
  const seen = new Set<number>();
  for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
    const b = grid.get(`${gx},${gy}`);
    if (!b) continue;
    for (const w of b) {
      if (seen.has(w)) continue;
      seen.add(w);
      const x1 = wallInk[w], y1 = wallInk[w + 1], x2 = wallInk[w + 2], y2 = wallInk[w + 3];
      const ex = x2 - x1, ey = y2 - y1;
      const den = dxc * ey - dyc * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((x1 - ax) * ey - (y1 - ay) * ex) / den;
      const u = ((x1 - ax) * dyc - (y1 - ay) * dxc) / den;
      if (t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999) return true;
    }
  }
  return false;
}

test("makeInkContext: one grid, crossesInk matches the reference on a fixture", () => {
  const wallInk = [10, -8, 30, 8, 0, 10, 40, 10, 60, -4, 60, 4, 100, 100, 110, 110];
  const ctx = makeInkContext(wallInk, FT);
  assert.equal(ctx.IG, 2 * FT);
  assert.ok(ctx.inkGrid instanceof Map && ctx.inkGrid.size > 0);
  const cases = [
    [0, 0, 40, 0],
    [0, 20, 40, 20],
    [50, 0, 70, 0],
    [0, 0, 50, 50],
    [200, 200, 210, 210],
    [3, 3, 4, 4],
  ];
  for (const [ax, ay, bx, by] of cases)
    assert.equal(ctx.crossesInk(ax, ay, bx, by), crossesInkRef(wallInk, FT, ax, ay, bx, by),
      `crossesInk(${ax},${ay},${bx},${by})`);
});

// ── healSegments grid ───────────────────────────────────────────────────────
// Local reference: the original all-pairs heal loop. The grid must reproduce
// it exactly, including the in-place mutation order earlier iterations see.
function healNaive(segs: number[], ftPx: number) {
  const HEAL = 0.75 * ftPx;
  const m = segs.length >> 2;
  const hit = (px: number, py: number, dx: number, dy: number, self: number) => {
    let best = Infinity;
    for (let j = 0; j < m; j++) {
      if (j === self) continue;
      const x1 = segs[j * 4], y1 = segs[j * 4 + 1], x2 = segs[j * 4 + 2], y2 = segs[j * 4 + 3];
      const ex = x2 - x1, ey = y2 - y1;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((x1 - px) * ey - (y1 - py) * ex) / den;
      const u = ((x1 - px) * dy - (y1 - py) * dx) / den;
      if (t > 1e-6 && t <= HEAL && u >= -0.001 && u <= 1.001 && t < best) best = t;
    }
    return best;
  };
  for (let i = 0; i < m; i++) {
    const x1 = segs[i * 4], y1 = segs[i * 4 + 1], x2 = segs[i * 4 + 2], y2 = segs[i * 4 + 3];
    const d = Math.hypot(x2 - x1, y2 - y1) || 1;
    const ux = (x2 - x1) / d, uy = (y2 - y1) / d;
    const t2 = hit(x2, y2, ux, uy, i);
    if (t2 < Infinity) { segs[i * 4 + 2] = x2 + ux * (t2 + 0.3); segs[i * 4 + 3] = y2 + uy * (t2 + 0.3); }
    const t1 = hit(x1, y1, -ux, -uy, i);
    if (t1 < Infinity) { segs[i * 4] = x1 - ux * (t1 + 0.3); segs[i * 4 + 1] = y1 - uy * (t1 + 0.3); }
  }
  return segs;
}

// Segment 0 is moved by an earlier iteration (its far end hits segment 1, 0.3
// beyond HEAL+0.3 into the next cell). Segment 2 later hits that moved end at
// a cell the *uninflated* bbox of segment 0 never inserted.
const healMovedIntoNewCell = [0, 30, 0, 22.5, -5, 15, 5, 15, 15, 14.7, 5, 14.7];

test("healSegments: a hit on an earlier-moved end lands in a cell the uninflated bbox never inserted", () => {
  const want = healNaive(Array.from(healMovedIntoNewCell), FT);
  const got = healSegments(Array.from(healMovedIntoNewCell), FT);
  assert.deepEqual(got, want);
  // segment 2's near end was extended across the gap to segment 0's moved end
  assert.ok(Math.abs(got[10] - -0.3) < 1e-9);
  assert.deepEqual(want.slice(8, 10), [15, 14.7]);
});

// Cells below a foot: HEAL = 0.09375 px, so the absolute 0.3 extension is
// more than three cells. The hit cell (y = 0.1375, cell 1) is outside the
// +0.3-omitted inflated bbox (lowest cell 4). Segment 0's far end hits the
// barrier at y = 0.4375 first (t = 0.0625).
const healNo03Term = [0, 1.0, 0, 0.5, -0.2, 0.4375, 0.2, 0.4375, 0.05, 0.1375, 0.2, 0.1375];

test("healSegments: the +0.3 extension term covers the moved end across a cell boundary", () => {
  const want = healNaive(Array.from(healNo03Term), 0.125);
  const got = healSegments(Array.from(healNo03Term), 0.125);
  assert.deepEqual(got, want);
  assert.ok(Math.abs(got[8] - -0.3) < 1e-9);
});

// 0.001*L: a 40,000 px segment accepts a ray 32 px past its end (u = 1.0008,
// within the 1.001 slack). Only the 0.001*L inflation reaches that cell; the
// term-omitted bbox starts one cell below and the padded query never visits it.
const healNoLTerm = [0, 40000, 0, 0, 15, -32, 5, -32];

test("healSegments: the 0.001*L term covers the endpoint u-slack across a cell boundary", () => {
  const want = healNaive(Array.from(healNoLTerm), FT);
  const got = healSegments(Array.from(healNoLTerm), FT);
  assert.deepEqual(got, want);
  assert.ok(Math.abs(got[6] - -0.3) < 1e-9);
});

// ── endPairs grid ───────────────────────────────────────────────────────────
test("endPairsStage: exactly GAP_MAX is accepted, just past it is not", () => {
  // -1 and 69 are 70 px (7 ft) apart and straddle the 75 px cell boundary.
  const at = endPairsStage([mkEnd(-1, 0, [1, 0]), mkEnd(69, 0, [-1, 0])], [], [], FT);
  assert.deepEqual(at.doorQuads, [[[-1, 3], [69, 3], [69, -3], [-1, -3]]]);
  const past = endPairsStage([mkEnd(-1, 0, [1, 0]), mkEnd(69.0001, 0, [-1, 0])], [], [], FT);
  assert.deepEqual(past.doorQuads, []);
});

test("endPairsStage: equal distances keep (i, j) insertion order, not a global j sort", () => {
  const ends = [
    mkEnd(0, 0, [1, 0]),        // 0
    mkEnd(0, 200, [1, 0]),      // 1
    mkEnd(40, 200, [-1, 0]),    // 2
    mkEnd(10000, 10000, [1, 0]),// 3, isolated filler
    mkEnd(10000, 10000, [1, 0]),// 4, isolated filler
    mkEnd(40, 0, [-1, 0]),      // 5
  ];
  const out = endPairsStage(ends, [], [], FT);
  assert.deepEqual(out.doorQuads, [
    // (0, 5) is inserted first at i=0 even though j=5 > the second pair's j=2
    [[0, 3], [40, 3], [40, -3], [0, -3]],
    [[0, 203], [40, 203], [40, 197], [0, 197]],
  ]);
});

test("endPairsStage: a non-finite end falls back to the all-pairs loop", () => {
  // A NaN coordinate is only visited by the all-pairs loop: the grid cannot
  // place it in a cell. The shipped path therefore emits a NaN door quad;
  // removing the fallback would emit nothing.
  const nanEnd: End = { x: NaN, y: 0, dir: [-1, 0], hw: 3, corners: [[NaN, 3], [NaN, -3]] };
  const out = endPairsStage([mkEnd(0, 0, [1, 0]), nanEnd], [], [], FT);
  assert.deepEqual(out.doorQuads, [[[0, 3], [NaN, -3], [NaN, 3], [0, -3]]]);
});

// ── makeMaterialContext ─────────────────────────────────────────────────────
test("makeMaterialContext: the bbox grid matches the full point scan", () => {
  const material: [number, number][][] = [
    [[0, 0], [10, 0], [10, 10], [0, 10]],           // square, straddles cells
    [[-20, -5], [-8, 3], [-11, 9]],                 // triangle
    [[100, 100], [140, 100], [140, 140], [100, 140]], // far ring
  ];
  const ctx = makeMaterialContext(material, FT);
  const ref = (x: number, y: number) => material.some((r) => pointInRing(r, x, y));
  for (let x = -30; x <= 150; x++)
    for (let y = -15; y <= 150; y++)
      assert.equal(ctx.inMaterial(x, y), ref(x, y), `point ${x},${y}`);
});

test("makeMaterialContext: a non-positive ftPx falls back to the full scan", () => {
  const material: [number, number][][] = [[[0, 0], [10, 0], [10, 10], [0, 10]]];
  const ctx = makeMaterialContext(material, 0);
  const ref = (x: number, y: number) => material.some((r) => pointInRing(r, x, y));
  for (const [x, y] of [[5, 5], [-1, 5], [10, 10], [11, 5]]) assert.equal(ctx.inMaterial(x, y), ref(x, y));
});

test("endPairsStage: same-i candidates across cells keep ascending j (tie)", () => {
  // e1 (y=3) is in cell 0; e2 (y=-3) is in cell -1. The 3x3 scan visits
  // dgy=-1 first, so the unsorted candidate stream is [2, 1]; the tie between
  // the two equal distances must resolve to the lower j.
  const ends = [mkEnd(0, 0, [1, 0]), mkEnd(40, 3, [-1, 0]), mkEnd(40, -3, [-1, 0])];
  const out = endPairsStage(ends, [], [], FT);
  assert.deepEqual(out.doorQuads, [[[0, 3], [40, 0], [40, 6], [0, -3]]]);
  assert.equal(out.synth.length, 16);
});

test("makeMaterialContext: a NaN-vertex ring is always a candidate and matches the scan", () => {
  const material: [number, number][][] = [
    [[0, 0], [NaN, 5], [10, 0], [10, 10], [0, 10]],
    [[30, 0], [40, 0], [40, 10], [30, 10]],
  ];
  const ctx = makeMaterialContext(material, FT);
  const ref = (x: number, y: number) => material.some((r) => pointInRing(r, x, y));
  for (let x = -5; x <= 45; x++)
    for (let y = -5; y <= 15; y++)
      assert.equal(ctx.inMaterial(x, y), ref(x, y), `point ${x},${y}`);
});

test("makeMaterialContext: a context rebuilt after in-place truncation follows the live array", () => {
  const material: [number, number][][] = [
    [[0, 0], [10, 0], [10, 10], [0, 10]],
    [[30, 0], [40, 0], [40, 10], [30, 10]],
  ];
  // build()'s materialValidation truncates the same array in place; the
  // predicate used afterwards is the one rebuilt from it.
  material.length = 0; material.push([[30, 0], [40, 0], [40, 10], [30, 10]]);
  const live = makeMaterialContext(material, FT).inMaterial;
  const ref = (x: number, y: number) => material.some((r) => pointInRing(r, x, y));
  for (let x = -5; x <= 45; x++)
    for (let y = -5; y <= 15; y++)
      assert.equal(live(x, y), ref(x, y), `point ${x},${y}`);
});

test("endPairsStage: greedy picks the shortest gap when pairs compete", () => {
  // 0 faces +x; 1 faces -x at 6 ft; 2 faces -x at 3 ft. (0,1) is inserted
  // first but (0,2) is shorter, so the distance sort must claim (0,2).
  const ends = [
    mkEnd(0, 0, [1, 0]),
    mkEnd(60, 0, [-1, 0]),
    mkEnd(30, 0, [-1, 0]),
  ];
  const out = endPairsStage(ends, [], [], FT);
  assert.deepEqual(out.synth, [
    0, 3, 30, 3,
    0, -3, 30, -3,
    0, 3, 0, -3,
    30, 3, 30, -3,
  ]);
  assert.deepEqual(out.doorQuads, [[[0, 3], [30, 3], [30, -3], [0, -3]]]);
});
