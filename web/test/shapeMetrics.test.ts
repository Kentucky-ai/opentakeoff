// lib/shapeMetrics.js — the ONE role-aware shape-quantity computer (extracted
// from TakeoffCanvas.recomputeShape) and needsMetrics, the load-time heal's
// "is this shape missing its numbers" gate (#137). The heal exists because
// shapes can ARRIVE geometry-only (an import without computed) and every
// summer reads computed?.x || 0 — the gap must be detected and priced, never
// guessed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeShapeMetrics, needsMetrics, recalibrateShapes, linearVerticalFt } from "../src/lib/shapeMetrics.js";

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


test("sheet recalibration preserves counts and physical height/thickness, without mutating inputs", () => {
  const shapes = [
    { id: "wall", condition_id: "c", measure_role: "surface_area", height_ft: 8, verts_norm: [[0,0],[1,0]], computed: { area_sf: 80, perimeter_lf: 10 } },
    { id: "border", condition_id: "c", measure_role: "linear", verts_norm: [[0,0],[1,0]], computed: { area_sf: 5, perimeter_lf: 10 } },
    { id: "count", condition_id: "c", measure_role: "count", verts_norm: [[0,0]], computed: { count: 3.5 } },
  ];
  const before = structuredClone(shapes);
  const next = recalibrateShapes(shapes, { w: 100, h: 100 }, 0.2, [{ id: "c", height_ft: 12, thickness_in: 6 }]);
  assert.deepEqual(next.map((s: any) => s.computed), [
    { area_sf: 160, perimeter_lf: 20 }, { area_sf: 10, perimeter_lf: 20 }, { count: 3.5 },
  ]);
  assert.deepEqual(shapes, before);
});

// #441 — Drop and Rise: a run's LF is its plan length plus its vertical legs.
test("linear rise/drop: condition defaults add to LF; plan_lf/vertical_lf ride beside the total", () => {
  const s = { measure_role: "linear", verts_norm: [[0.1, 0.1], [0.3, 0.1]] };   // 200 px = 10 LF plan
  const m = computeShapeMetrics(s, DIMS, UPP, { rise_ft: 2, drop_ft: 8 });
  assert.equal(m.perimeter_lf, 20);
  assert.equal(m.plan_lf, 10);
  assert.equal(m.vertical_lf, 10);
  // border SF rides the TOTAL — the material travels the legs too
  assert.equal(computeShapeMetrics(s, DIMS, UPP, { rise_ft: 2, drop_ft: 8, thickness_in: 6 }).area_sf, 10);
});

test("linear rise/drop: a flat run's record is unchanged (no plan_lf/vertical_lf keys)", () => {
  const s = { measure_role: "linear", verts_norm: [[0.1, 0.1], [0.3, 0.1]] };
  const m = computeShapeMetrics(s, DIMS, UPP, { rise_ft: 0 });
  assert.deepEqual(m, { perimeter_lf: 10, area_sf: 0 });
  assert.deepEqual(computeShapeMetrics(s, DIMS, UPP, undefined), { perimeter_lf: 10, area_sf: 0 });
});

test("linear rise/drop: a run's own value overrides that field outright, 0 included; the other field keeps the default", () => {
  const cond = { rise_ft: 2, drop_ft: 8 };
  const s = { measure_role: "linear", verts_norm: [[0.1, 0.1], [0.3, 0.1]] };
  assert.equal(computeShapeMetrics({ ...s, drop_ft: 0 }, DIMS, UPP, cond).perimeter_lf, 12);       // 10 + 2 + 0
  assert.equal(computeShapeMetrics({ ...s, drop_ft: 12 }, DIMS, UPP, cond).perimeter_lf, 24);      // 10 + 2 + 12
  assert.equal(computeShapeMetrics({ ...s, rise_ft: 0, drop_ft: 0 }, DIMS, UPP, cond).perimeter_lf, 10);
  assert.deepEqual(linearVerticalFt({ rise_ft: 0 }, cond), { rise: 0, drop: 8 });
  assert.deepEqual(linearVerticalFt({}, cond), { rise: 2, drop: 8 });
  assert.deepEqual(linearVerticalFt({ rise_ft: -3, drop_ft: "x" }, cond), { rise: 0, drop: 0 });  // garbage reads as 0, never as the default
});

test("linear rise/drop: a derived run (base, transition) never takes a leg", () => {
  const s = { measure_role: "linear", verts_norm: [[0.1, 0.1], [0.3, 0.1]], origin: { method: "derived", derived: { from_shape_id: "f", gross_lf: 10, openings_lf: 0 } } };
  assert.deepEqual(computeShapeMetrics(s, DIMS, UPP, { rise_ft: 2, drop_ft: 8 }), { perimeter_lf: 10, area_sf: 0 });
});

test("linear rise/drop: recalibrateShapes re-prices with the condition's legs", () => {
  const conds = [{ id: "c", rise_ft: 1, drop_ft: 1 }];
  const [r] = recalibrateShapes([{ id: "s", condition_id: "c", measure_role: "linear", verts_norm: [[0.1, 0.1], [0.3, 0.1]], computed: { perimeter_lf: 10 } }], DIMS, UPP, conds);
  assert.equal(r.computed.perimeter_lf, 12);
  assert.equal(r.computed.vertical_lf, 2);
});
