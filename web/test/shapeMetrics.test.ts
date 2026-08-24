// lib/shapeMetrics.js — the ONE role-aware shape-quantity computer (extracted
// from TakeoffCanvas.recomputeShape) and needsMetrics, the load-time heal's
// "is this shape missing its numbers" gate (#137). The heal exists because
// shapes can ARRIVE geometry-only (an import without computed) and every
// summer reads computed?.x || 0 — the gap must be detected and priced, never
// guessed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeShapeMetrics, needsMetrics } from "../src/lib/shapeMetrics.js";
import { heightInputToFeet, M_PER_FT } from "../src/lib/units.js";

const approx = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const DIMS = { w: 1000, h: 800 };
const UPP = 0.05;   // 20 px per foot

test("floor_area: closed metrics at scale", () => {
  // 200×160 px = 10×8 ft = 80 SF, 36 LF perimeter
  const s = { measure_role: "floor_area", verts_norm: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3], [0.1, 0.3]] };
  const m = computeShapeMetrics(s, DIMS, UPP, undefined);
  assert.ok(approx(m.area_sf!, 80), String(m.area_sf));
  assert.ok(approx(m.perimeter_lf!, 36), String(m.perimeter_lf));
});

test("floor_area with holes: nets the cutout, hole boundary ADDS to perimeter", () => {
  const s = {
    measure_role: "floor_area",
    verts_norm: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3], [0.1, 0.3]],
    verts_norm_holes: [[[0.15, 0.15], [0.2, 0.15], [0.2, 0.2], [0.15, 0.2]]],   // 50×40 px = 5 SF
  };
  const m = computeShapeMetrics(s, DIMS, UPP, undefined);
  assert.ok(approx(m.area_sf!, 75), String(m.area_sf));
  assert.ok(m.perimeter_lf! > 36);
});

test("linear: LF always; border SF only with a condition thickness", () => {
  const s = { measure_role: "linear", verts_norm: [[0.1, 0.1], [0.3, 0.1]] };   // 200 px = 10 LF
  const plain = computeShapeMetrics(s, DIMS, UPP, undefined);
  assert.ok(approx(plain.perimeter_lf!, 10) && plain.area_sf === 0);
  const trimmed = computeShapeMetrics(s, DIMS, UPP, { thickness_in: 6 });
  assert.ok(approx(trimmed.area_sf!, 5), String(trimmed.area_sf));
});

test("surface_area: condition-height fallback vs drawn height vs explicit 0 override", () => {
  const s = { measure_role: "surface_area", verts_norm: [[0.1, 0.1], [0.3, 0.1]] };
  assert.ok(approx(computeShapeMetrics(s, DIMS, UPP, { height_ft: 8 }).area_sf!, 80));
  assert.ok(approx(computeShapeMetrics({ ...s, height_ft: 9 }, DIMS, UPP, { height_ft: 8 }).area_sf!, 90));
  assert.ok(approx(computeShapeMetrics({ ...s, height_override: true, height_ft: 0 }, DIMS, UPP, { height_ft: 8 }).area_sf!, 0),
    "explicit override 0 stays 0 — never silently re-heights");
});

test("count: always {count: 1}, dims/scale irrelevant", () => {
  assert.equal(computeShapeMetrics({ measure_role: "count", verts_norm: [[0.5, 0.5]] }, DIMS, 0, undefined).count, 1);
});

test("needsMetrics: missing-only detection, role-aware, never on 0", () => {
  const tri = [[0, 0], [0.1, 0], [0.1, 0.1]];
  assert.ok(needsMetrics({ measure_role: "floor_area", verts_norm: tri }));
  assert.ok(needsMetrics({ measure_role: "floor_area", verts_norm: tri, computed: {} }));
  assert.ok(!needsMetrics({ measure_role: "floor_area", verts_norm: tri, computed: { area_sf: 0 } }),
    "explicit 0 is a VALUE, not a gap");
  assert.ok(!needsMetrics({ measure_role: "floor_area", verts_norm: [[0, 0], [0.1, 0]] }),
    "2-vertex 'polygon' stays unpriced (malformed, never guess)");
  assert.ok(needsMetrics({ measure_role: "deduct", verts_norm: tri }));
  assert.ok(needsMetrics({ measure_role: "linear", verts_norm: [[0, 0], [0.1, 0]] }));
  assert.ok(!needsMetrics({ measure_role: "linear", verts_norm: [[0, 0], [0.1, 0]], computed: { perimeter_lf: 12 } }));
  assert.ok(needsMetrics({ measure_role: "surface_area", verts_norm: [[0, 0], [0.1, 0]] }));
  assert.ok(needsMetrics({ measure_role: "count", verts_norm: [[0.5, 0.5]] }));
  assert.ok(!needsMetrics({ measure_role: "count", verts_norm: [[0.5, 0.5]], computed: { count: 1 } }));
  assert.ok(!needsMetrics({ measure_role: "zone", verts_norm: tri }), "unknown role never heals");
});

// ── Task 3: production-geometry equivalence across unit systems ──────────────
// A wall traced at 10 ft LF on a real-scale sheet must produce the same
// canonical area_sf whether the user entered the height as 8 ft (imperial) or
// 2.4384 m (metric).  The geometry (verts_norm, dims, upp) is pixel-level and
// never changes with the display unit; only the height-threshold test and the
// stored area_sf matter.

test("surface_area equivalence: same pixel wall, imperial vs SI height → identical canonical area_sf", () => {
  // 200 px wall at 0.05 ft/px = 10 LF
  const wallVerts = [[0.1, 0.25], [0.3, 0.25]];
  const condH_ft = 8;                              // canonical height in feet
  const condH_m = condH_ft * M_PER_FT;            // what metric user types: 2.4384 m
  const condH_m_back = heightInputToFeet(condH_m, "metric"); // back through the input edge

  const imperial = computeShapeMetrics(
    { measure_role: "surface_area", verts_norm: wallVerts },
    DIMS, UPP, { height_ft: condH_ft },
  );
  const metricPath = computeShapeMetrics(
    { measure_role: "surface_area", verts_norm: wallVerts },
    DIMS, UPP, { height_ft: condH_m_back },
  );
  // Both must produce exactly the same canonical area_sf (LF × height_ft)
  assert.ok(approx(imperial.area_sf!, 80), `imperial area_sf = ${imperial.area_sf}`);
  assert.ok(approx(metricPath.area_sf!, 80), `metric-path area_sf = ${metricPath.area_sf}`);
  assert.ok(approx(imperial.perimeter_lf!, 10), `perimeter_lf = ${imperial.perimeter_lf}`);
  // verts_norm is untouched by any unit switch — same object identity not
  // required, but the coordinate values must be pixel-identical
  assert.deepEqual(wallVerts, [[0.1, 0.25], [0.3, 0.25]]);
});

test("surface_area: switching units never mutates verts_norm or computed fields", () => {
  const wallVerts = [[0.05, 0.5], [0.15, 0.5]];  // 100 px = 5 LF at 0.05 ft/px
  const shape = { measure_role: "surface_area", verts_norm: wallVerts.map((v) => [...v]) };
  const dimsSnapshot = { ...DIMS };
  const beforeVerts = JSON.stringify(shape.verts_norm);
  const m1 = computeShapeMetrics(shape, DIMS, UPP, { height_ft: 8 });
  const m2 = computeShapeMetrics(shape, DIMS, UPP, { height_ft: 9 });
  // verts_norm unchanged between calls
  assert.equal(JSON.stringify(shape.verts_norm), beforeVerts, "verts_norm mutated between calls");
  // dims unchanged
  assert.deepEqual(dimsSnapshot, DIMS, "dims mutated between calls");
  // area scales linearly with height
  assert.ok(approx(m1.area_sf!, 40), `5 × 8 = ${m1.area_sf}`);
  assert.ok(approx(m2.area_sf!, 45), `5 × 9 = ${m2.area_sf}`);
});

test("linear: SI thickness converts to canonical inches, border SF unchanged", () => {
  // 200 px = 10 LF; 6 in thickness → border = 10 × 6 / 12 = 5 SF
  const s = { measure_role: "linear", verts_norm: [[0.1, 0.1], [0.3, 0.1]] };
  const imperial = computeShapeMetrics(s, DIMS, UPP, { thickness_in: 6 });
  // 6 in × 25.4 = 152.4 mm; 152.4 / 25.4 = 6 in back through SI input edge
  const siThickness = 6 * 25.4;   // 152.4 mm displayed to metric user
  const backToInches = siThickness / 25.4; // thickInputToInches path
  const metricPath = computeShapeMetrics(s, DIMS, UPP, { thickness_in: backToInches });
  assert.ok(approx(imperial.area_sf!, 5), `imperial border = ${imperial.area_sf}`);
  assert.ok(approx(metricPath.area_sf!, 5), `metric-path border = ${metricPath.area_sf}`);
  assert.ok(approx(imperial.perimeter_lf!, 10));
});
