// lib/shapeMetrics.js — the ONE role-aware shape-quantity computer (extracted
// from TakeoffCanvas.recomputeShape) and needsMetrics, the load-time heal's
// "is this shape missing its numbers" gate (#137). The heal exists because
// shapes can ARRIVE geometry-only (an import without computed) and every
// summer reads computed?.x || 0 — the gap must be detected and priced, never
// guessed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeShapeMetrics, needsMetrics } from "../src/lib/shapeMetrics.js";

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
