// Zone check: center-point classification + Report-rule rollup on the filtered set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shapesInZone, shapeCenter } from "../src/lib/zone.js";
import { conditionTotals } from "../src/lib/totals.js";
import { pointInPoly } from "../src/lib/geometry.js";

const zone = { key: "plan.pdf", pts: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]] };
const sq = (id: string, cond: string, cx: number, cy: number, sf: number, sheet = "plan.pdf") => ({
  id, sheet_id: sheet, condition_id: cond, measure_role: "floor_area",
  verts_norm: [[cx - 0.01, cy - 0.01], [cx + 0.01, cy - 0.01], [cx + 0.01, cy + 0.01], [cx - 0.01, cy + 0.01]],
  computed: { area_sf: sf },
});

test("shapesInZone counts by center, same sheet only", () => {
  const shapes = [
    sq("in1", "c1", 0.2, 0.2, 100),
    sq("in2", "c2", 0.4, 0.4, 50),
    sq("out", "c1", 0.8, 0.8, 999),
    sq("other-sheet", "c1", 0.2, 0.2, 999, "other.pdf"),
  ];
  const hit = shapesInZone(shapes, zone);
  assert.deepEqual(hit.map((s: any) => s.id).sort(), ["in1", "in2"]);
  assert.equal(shapesInZone(shapes, null).length, 0);
  assert.equal(shapeCenter({ verts_norm: [] }), null);
});

test("shapeCenter uses an area centroid, not a vertex-density-skewed average", () => {
  // Two geometrically identical 0.4 x 0.2 rectangles (x:0..0.4, y:0..0.2):
  // one plain 4-vertex rect, one with 99 extra collinear vertices marching
  // down its right edge (what a one-click trace of a straight wall produces).
  const sparse = [[0, 0], [0.4, 0], [0.4, 0.2], [0, 0.2]];
  const dense = [[0, 0], [0.4, 0]];
  for (let i = 1; i < 99; i++) dense.push([0.4, (0.2 * i) / 99]);
  dense.push([0.4, 0.2], [0, 0.2]);

  const sparseCenter = shapeCenter({ verts_norm: sparse })!;
  const denseCenter = shapeCenter({ verts_norm: dense })!;
  assert.ok(Math.abs(sparseCenter[0] - 0.2) < 1e-6);
  assert.ok(Math.abs(sparseCenter[1] - 0.1) < 1e-6);
  // The dense trace's centroid must land at the SAME true center — not
  // dragged toward the vertex-dense right edge.
  assert.ok(Math.abs(denseCenter[0] - sparseCenter[0]) < 1e-6);
  assert.ok(Math.abs(denseCenter[1] - sparseCenter[1]) < 1e-6);

  // A zone clearly enclosing the shared true center (0.2, 0.1) must classify
  // both shapes identically (a zone edge landing exactly ON the center is a
  // boundary-inclusion edge case, not what this test is targeting).
  const leftHalf = { key: "plan.pdf", pts: [[0, 0], [0.3, 0], [0.3, 0.3], [0, 0.3]] };
  const sparseShape = { id: "sparse", sheet_id: "plan.pdf", verts_norm: sparse };
  const denseShape = { id: "dense", sheet_id: "plan.pdf", verts_norm: dense };
  const hits = shapesInZone([sparseShape, denseShape], leftHalf).map((s: any) => s.id).sort();
  assert.deepEqual(hits, ["dense", "sparse"]);
});

test("shapeCenter's centroid falls inside a concave (L-shaped) room", () => {
  // Classic L: a 2x1 arm along the bottom, a 1x1 arm going up the left side.
  const L = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
  const c = shapeCenter({ verts_norm: L })!;
  assert.ok(pointInPoly(c[0], c[1], L), `centroid ${c} must be inside the L`);
  // A vertex mean of these 6 points would be (1, 0.667) — also inside here,
  // so assert the actual expected area centroid to pin the real fix.
  assert.ok(Math.abs(c[0] - 5 / 6) < 1e-6);
  assert.ok(Math.abs(c[1] - 5 / 6) < 1e-6);
});

test("zone rollup uses the Report's own rules incl. materials", () => {
  const conditions = [
    { id: "c1", finish_tag: "CT-1", multiplier: 1, waste_pct: 0,
      materials: [{ name: "Thinset", per: 50, basis: "area", unit: "bag" }] },
    { id: "c2", finish_tag: "LVT-1", multiplier: 1, waste_pct: 0, materials: [] },
  ];
  const rows = conditionTotals(conditions, shapesInZone([
    sq("in1", "c1", 0.2, 0.2, 100), sq("in2", "c2", 0.4, 0.4, 50), sq("out", "c1", 0.8, 0.8, 999),
  ], zone)).filter((r: any) => r.shape_count > 0);
  const ct = rows.find((r: any) => r.finish_tag === "CT-1");
  assert.equal(ct.total_sf, 100);            // the out-of-zone 999 SF never leaks in
  assert.equal(ct.materials[0].qty, 2);      // ceil(100 / 50)
  assert.equal(rows.find((r: any) => r.finish_tag === "LVT-1").total_sf, 50);
});
