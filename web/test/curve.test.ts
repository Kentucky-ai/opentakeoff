// Curved-line geometry — pins flattenCurve's contract: interpolation through
// every control point, straight-line passthrough under 3 points, near-collinear
// stability, the vertex cap, and input immutability.
import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenCurve, flattenRing } from "../src/lib/curve.js";

type Pt = [number, number];
const len = (pts: Pt[]) => pts.slice(1).reduce((L, p, i) => L + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
const hasPt = (pts: Pt[], [x, y]: Pt, eps = 1e-6) => pts.some((p) => Math.abs(p[0] - x) < eps && Math.abs(p[1] - y) < eps);

test("under 3 points → verbatim copy (a straight line is already flat)", () => {
  const two: Pt[] = [[0, 0], [10, 5]];
  const out = flattenCurve(two);
  assert.deepEqual(out, two);
  assert.notEqual(out, two, "must be a copy, not the same array");
});

test("interpolation: the curve passes through EVERY clicked control point", () => {
  const ctrl: Pt[] = [[0, 0], [40, 60], [90, 10], [140, 70]];
  const out = flattenCurve(ctrl);
  for (const c of ctrl) assert.ok(hasPt(out, c), `control point ${c} on the curve`);
  assert.deepEqual(out[0], ctrl[0]);
  assert.deepEqual(out[out.length - 1], ctrl[ctrl.length - 1]);
});

test("arc through (0,0)-(50,50)-(100,0): length between the straight diagonal pair and the elbow", () => {
  const out = flattenCurve([[0, 0], [50, 50], [100, 0]]);
  const L = len(out);
  assert.ok(L > 141.4 && L < 175, `arc length ${L.toFixed(1)} in (141.4, 175)`);
});

test("near-collinear clicks stay near-straight (no phantom bulge → no phantom LF)", () => {
  const out = flattenCurve([[0, 0], [50, 0.5], [100, 0], [150, 0.5]]);
  const L = len(out);
  assert.ok(L < 151.5, `collinear-ish length ${L.toFixed(2)} stays ~150`);
  assert.ok(out.every((p: Pt) => p[1] > -3 && p[1] < 4), "no vertical excursion");
});

test("vertex cap holds on a long many-point curve (render-invariance budget)", () => {
  const many: Pt[] = Array.from({ length: 40 }, (_, i) => [i * 300, (i % 2) * 200]);
  const out = flattenCurve(many);
  assert.ok(out.length <= 220 + many.length, `capped: ${out.length}`);
  for (const c of many) assert.ok(hasPt(out, c, 1e-4), "still interpolates every control point");
});

test("input never mutated", () => {
  const ctrl: Pt[] = [[0, 0], [40, 60], [90, 10]];
  const snapshot = JSON.stringify(ctrl);
  flattenCurve(ctrl);
  assert.equal(JSON.stringify(ctrl), snapshot);
});

// ── flattenRing: a boundary that is straight in places and curved in others ──
// (#284). The contract that matters downstream: ONE closed polyline out, the
// straight work untouched, every clicked point still on the boundary.
const ringArea = (pts: Pt[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const q = pts[(i + 1) % pts.length];
    a += pts[i][0] * q[1] - q[0] * pts[i][1];
  }
  return Math.abs(a) / 2;
};

test("flattenRing with no curve points is the identity (a straight trace is untouched)", () => {
  const sq: Pt[] = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const out = flattenRing(sq, []);
  assert.deepEqual(out, sq);
  assert.notEqual(out, sq, "must be a copy, not the same array");
  assert.deepEqual(flattenRing(sq, undefined), sq);
});

test("a bowed wall: the straight corners survive, the marked points shape the arc", () => {
  // a room with three straight walls and a bowed one — the estimator clicks
  // three points along the bow and ⌥s them
  const room: Pt[] = [[0, 0], [100, 0], [100, 100], [70, 120], [30, 120], [0, 100]];
  const out = flattenRing(room, [3, 4]);
  for (const c of [[0, 0], [100, 0], [100, 100], [0, 100]] as Pt[]) assert.ok(hasPt(out, c), `straight corner ${c} kept verbatim`);
  for (const c of [[70, 120], [30, 120]] as Pt[]) assert.ok(hasPt(out, c), `the curve passes through clicked point ${c}`);
  assert.ok(out.length > room.length, "the bow is sampled, the straight walls are not");
  // the boundary bends through the clicked points instead of turning corners
  // at them, so the bowed end holds a little MORE than the chord polygon
  assert.ok(ringArea(out) > ringArea(room), "a bow adds area over the straight-chord reading");
  assert.ok(ringArea(out) < ringArea(room) * 1.1, "and it is a bend, not an excursion");
});

test("every vertex curved closes as a periodic spline — no seam, no lost area", () => {
  const oct: Pt[] = Array.from({ length: 8 }, (_, i) => [50 + 50 * Math.cos((i * Math.PI) / 4), 50 + 50 * Math.sin((i * Math.PI) / 4)] as Pt);
  const out = flattenRing(oct, [0, 1, 2, 3, 4, 5, 6, 7]);
  const circle = Math.PI * 2500;
  assert.ok(ringArea(oct) < ringArea(out), "the spline holds more area than the straight octagon");
  assert.ok(ringArea(out) < circle * 1.02, "and does not overshoot the circle it was clicked on");
  // a periodic spline has no privileged start: the seam is as smooth as the
  // rest, so no two consecutive samples are wildly longer than their neighbors
  const steps: number[] = out.map((p: Pt, i: number) => Math.hypot(p[0] - out[(i + 1) % out.length][0], p[1] - out[(i + 1) % out.length][1]));
  assert.ok(Math.max(...steps) < 4 * (steps.reduce((n: number, v: number) => n + v, 0) / steps.length), "no seam kink");
});

test("open mode (the in-progress trace) anchors a run on itself at either end", () => {
  const pts: Pt[] = [[0, 0], [50, 30], [100, 0]];
  const out = flattenRing(pts, [1], false);
  assert.deepEqual(out[0], [0, 0]);
  assert.deepEqual(out[out.length - 1], [100, 0]);
  assert.ok(out.length > 3, "the middle point curves");
  // a run touching the END of the trace still terminates on the clicked point
  const tail = flattenRing([[0, 0], [50, 30], [100, 0]] as Pt[], [2], false);
  assert.deepEqual(tail[tail.length - 1], [100, 0]);
});

test("the vertex budget holds on a ring curved end to end (render-invariance)", () => {
  const many: Pt[] = Array.from({ length: 40 }, (_, i) => [200 + 200 * Math.cos((i * Math.PI) / 20), 200 + 200 * Math.sin((i * Math.PI) / 20)] as Pt);
  assert.ok(flattenRing(many, many.map((_, i) => i)).length <= 260, "closed spline stays inside the cap");
  assert.ok(flattenRing(many, [5, 6, 7, 20, 21]).length <= 260, "so does a ring with several runs");
});
