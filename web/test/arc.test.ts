// Three-point arc geometry — pins the contract the estimator leans on: the arc
// passes through the point clicked ON the bow, it goes the way that point says
// (including the long way round, past 180°), a flat bow degrades to a straight
// segment instead of a giant circle, and a ring that mixes straight walls with
// an arc closes with the right AREA — the number that reaches the takeoff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { circleThrough, flattenArc, arcLength, arcPathD, flattenArcRing } from "../src/lib/arc.js";

type Pt = [number, number];

const ringArea = (pts: Pt[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const q = pts[(i + 1) % pts.length];
    a += pts[i][0] * q[1] - q[0] * pts[i][1];
  }
  return Math.abs(a) / 2;
};
const near = (got: number, want: number, tol: number, what: string) =>
  assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} ±${tol}`);

const QA: Pt = [100, 0], QM: Pt = [70.7106781, 70.7106781], QB: Pt = [0, 100];

test("the circle is the circumcircle, and every flattened point lands on it", () => {
  const c = circleThrough(QA, QM, QB)!;
  near(c.cx, 0, 1e-6, "center x");
  near(c.cy, 0, 1e-6, "center y");
  near(c.r, 100, 1e-6, "radius");
  const pts = flattenArc(QA, QM, QB);
  assert.ok(pts.length >= 8, "a quarter circle is worth more than a couple of chords");
  for (const p of pts) near(Math.hypot(p[0], p[1]), 100, 1e-6, "point on circle");
  near(arcLength(QA, QM, QB), Math.PI * 50, 1e-4, "quarter-arc length");
});

test("flattenArc returns the interior only — the caller owns its corners", () => {
  const pts = flattenArc(QA, QM, QB);
  const same = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9;
  assert.ok(!pts.some((p) => same(p as Pt, QA)), "start is not re-emitted");
  assert.ok(!pts.some((p) => same(p as Pt, QB)), "end is not re-emitted");
});

test("the bow point picks the direction, including the long way round", () => {
  near(arcLength([100, 0], [-100, 0], [0, -100]), Math.PI * 150, 1e-4, "reflex arc, one way");
  near(arcLength([100, 0], [-100, 0], [0, 100]), Math.PI * 150, 1e-4, "reflex arc, other way");
  assert.match(arcPathD([100, 0], [-100, 0], [0, -100]), /A 100 100 0 1 1 /, "large-arc, positive sweep");
  assert.match(arcPathD([100, 0], [-100, 0], [0, 100]), /A 100 100 0 1 0 /, "large-arc, negative sweep");
  assert.ok(flattenArc([100, 0], [-100, 0], [0, -100]).some((p) => p[1] > 90), "passes the bow point's side");
});

test("a flat bow is a straight line, not a circle the size of the county", () => {
  assert.equal(circleThrough([0, 0], [50, 0], [100, 0]), null, "collinear has no circle");
  assert.deepEqual(flattenArc([0, 0], [50, 0], [100, 0]), [], "…so it contributes no interior points");
  near(arcLength([0, 0], [50, 0], [100, 0]), 100, 1e-9, "length falls back to the chord");
  assert.equal(arcPathD([0, 0], [50, 0], [100, 0]), "M 0 0 L 100 0", "…and the path to a line");
  const c = circleThrough([0, 0], [50, 0.5], [100, 0]);
  assert.ok(c && Number.isFinite(c.r), "a near-flat bow still solves");
  near(arcLength([0, 0], [50, 0.5], [100, 0]), 100, 0.05, "…and measures barely over the chord");
});

test("a square with one semicircular bay closes with the right area", () => {
  // 100×100 room, top wall bowed out through (50,150): the bow's circle is
  // centred (50,100) r=50, so the ring is 10,000 + a half disc of 3,926.99.
  const ring: Pt[] = [[0, 0], [100, 0], [100, 100], [50, 150], [0, 100]];
  const flat = flattenArcRing(ring, [3], true) as Pt[];
  const want = 10000 + (Math.PI * 50 * 50) / 2;
  const got = ringArea(flat);
  assert.ok(got < want, "a chorded arc is inscribed — it can only under-measure");
  near(got, want, want * 0.005, "bowed-bay area");
  for (const corner of [[0, 0], [100, 0], [100, 100], [0, 100]])
    assert.ok(flat.some((p) => Math.hypot(p[0] - corner[0], p[1] - corner[1]) < 1e-9), `corner ${corner} survives`);
  assert.ok(flat.some((p) => Math.hypot(p[0] - 50, p[1] - 150) < 1e-6), "the clicked bow point is ON the drawn boundary");
});

test("an arc closing the ring wraps the same as any other", () => {
  const ring: Pt[] = [[0, 100], [0, 0], [100, 0], [100, 100], [50, 150]];   // the marked point is LAST
  near(ringArea(flattenArcRing(ring, [4], true) as Pt[]), 10000 + (Math.PI * 50 * 50) / 2, 70, "wrapping arc area");
});

test("half-placed and ambiguous marks degrade to corners rather than guessing", () => {
  const open: Pt[] = [[0, 0], [100, 0], [150, 50]];
  assert.deepEqual(flattenArcRing(open, [2], false), open, "a trailing bow is still just a point");
  assert.deepEqual(flattenArcRing(open, [0], false), open, "…so is a leading one");
  const two: Pt[] = [[0, 0], [50, 30], [60, 40], [100, 0]];
  assert.deepEqual(flattenArcRing(two, [1, 2], false), two, "adjacent bows both demote");
  assert.ok(flattenArcRing(open, [0], true).length > open.length, "closing the ring makes a leading bow real");
});

test("no marks is the identity, and the input is never mutated", () => {
  const sq: Pt[] = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const snapshot = JSON.stringify(sq);
  assert.deepEqual(flattenArcRing(sq, []), sq);
  assert.deepEqual(flattenArcRing(sq, undefined), sq);
  assert.ok(flattenArcRing(sq, new Set([2])).length > 4, "a Set works the same as an array");
  flattenArcRing(sq, [2], true);
  flattenArc(sq[0], sq[1], sq[2]);
  assert.equal(JSON.stringify(sq), snapshot, "input untouched");
});

test("the vertex budget holds — a sweeping arc can't mint a thousand-point shape", () => {
  assert.ok(flattenArc([0, 0], [5000, 3000], [10000, 0]).length <= 96, "big arc capped");
  assert.ok(flattenArc([0, 0], [2, 1], [4, 0]).length >= 8, "small arc still smooth");
  const ring: Pt[] = [[0, 0], [400, 0], [400, 400], [200, 900], [0, 400]];
  assert.ok(flattenArcRing(ring, [3], true).length <= 100, "a ring with an arc stays lean");
});

test("degenerate input doesn't throw", () => {
  assert.deepEqual(flattenArcRing([], [0]), []);
  assert.deepEqual(flattenArcRing([[1, 2]], [0]), [[1, 2]]);
  assert.equal(circleThrough([5, 5], [5, 5], [5, 5]), null, "coincident points have no circle");
  assert.deepEqual(flattenArc([5, 5], [5, 5], [9, 9]), [], "a bow on the start point is flat");
});
