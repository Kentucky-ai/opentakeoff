// polyarr — the JSTS-backed arrangement under room detection. Exercised on
// hand-built linework, including the degenerate cases that broke the
// hand-rolled half-edge arrangement on real plans (duplicated collinear
// segments, near-coincident parallels below the weld grid).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPolyArrangement, faceAt, growRoom, roomOutline, pointInRing } from "../src/lib/polyarr.js";

const box = (x0: number, y0: number, x1: number, y1: number) => [
  x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0,
];

test("box with divider: two faces, adjacent, faceAt picks the right one", () => {
  const segs = [...box(0, 0, 100, 60), 50, 0, 50, 60];
  const A = buildPolyArrangement(segs, 1);
  const pos = A.faces.filter((f) => f.area > 0);
  assert.equal(pos.length, 2);
  assert.equal(Math.round(pos[0].area + pos[1].area), 6000);
  const left = faceAt(A, 25, 30);
  const right = faceAt(A, 75, 30);
  assert.notEqual(left, right);
  assert.ok(A.adj[left].has(right));
});

test("duplicated collinear segment cannot fuse faces (the fork-found leak)", () => {
  // top edge drawn twice: full span + a contained duplicate; divider lands
  // at the duplicate's endpoint
  const segs = [
    ...box(0, 0, 150, 60),
    0, 0, 150, 0,       // duplicate full top
    50, 0, 100, 0,      // contained duplicate
    50, 0, 50, 60,
  ];
  const A = buildPolyArrangement(segs, 1);
  const areas = A.faces.map((f) => Math.round(f.area)).sort((a, b) => a - b);
  assert.deepEqual(areas, [3000, 6000]);
});

test("near-coincident parallels weld onto the snap grid instead of leaking a channel", () => {
  const segs = [
    ...box(0, 0, 100, 60),
    0, 0.4, 100, 0.4,    // 0.4 px off the top edge — sub-snap drift
    50, 0.4, 50, 60,     // divider hung off the drifted line
  ];
  const A = buildPolyArrangement(segs, 1);
  const pos = A.faces.filter((f) => f.area > 5);
  assert.equal(pos.length, 2);
  assert.ok(faceAt(A, 25, 30) !== faceAt(A, 75, 30));
});

test("growRoom refuses solid faces and merges across open edges", () => {
  const segs = [...box(0, 0, 100, 60), 50, 0, 50, 60, 80, 0, 80, 60];
  const A = buildPolyArrangement(segs, 1);
  const mid = faceAt(A, 65, 30);
  // right strip is "wall material": growth from the middle must not enter it,
  // and with the left divider treated open the two left faces merge
  const rightFace = faceAt(A, 90, 30);
  const set = growRoom(A, mid, (f) => f === rightFace);
  assert.ok(set.includes(faceAt(A, 25, 30)));
  assert.ok(!set.includes(rightFace));
});

test("growRoom absorption gate: a big neighbour is refused, not blobbed", () => {
  const segs = [...box(0, 0, 100, 60), 50, 0, 50, 60];
  const A = buildPolyArrangement(segs, 1);
  const seed = faceAt(A, 25, 30);
  const set = growRoom(A, seed, () => false, 100);   // neighbour is 3000 — over the gate
  assert.deepEqual(set, [seed]);
});

test("roomOutline of a merged set is the outer ring", () => {
  const segs = [...box(0, 0, 100, 60), 50, 0, 50, 60];
  const A = buildPolyArrangement(segs, 1);
  const set = growRoom(A, faceAt(A, 25, 30), () => false);
  const out = roomOutline(A, set);
  const shoe = out.ring.reduce((a, p, i) => {
    const q = out.ring[(i + 1) % out.ring.length];
    return a + p[0] * q[1] - q[0] * p[1];
  }, 0);
  assert.equal(Math.round(Math.abs(shoe) / 2), 6000);
  assert.equal(out.holes.length, 0);
});

test("hole: a column inside a room is a separate face and excluded from area", () => {
  const segs = [...box(0, 0, 100, 100), ...box(40, 40, 60, 60)];
  const A = buildPolyArrangement(segs, 1);
  const room = faceAt(A, 10, 10);
  const col = faceAt(A, 50, 50);
  assert.notEqual(room, col);
  assert.equal(Math.round(A.faces[room].area), 100 * 100 - 20 * 20);
  assert.equal(Math.round(A.faces[col].area), 400);
  assert.ok(pointInRing(A.faces[room].ring, 10, 10));
});
