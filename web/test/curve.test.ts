// Curved-line geometry — pins flattenCurve's contract: interpolation through
// every control point, straight-line passthrough under 3 points, near-collinear
// stability, the vertex cap, and input immutability.
import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenCurve } from "../src/lib/curve.js";

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
