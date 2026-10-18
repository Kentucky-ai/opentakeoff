import { test } from "node:test";
import assert from "node:assert/strict";
import { endPairsStage, lineClosuresStage, makeFinishContext, makeInkContext } from "../src/lib/netroom.js";

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
