import { test } from "node:test";
import assert from "node:assert/strict";
import { measurementBreakdown, wallHeightFt } from "../src/lib/measurementBreakdown.js";

const lin = (id: string, cid: string, lf: number) => ({ id, condition_id: cid, measure_role: "linear", computed: { perimeter_lf: lf } });
const wall = (id: string, cid: string, lf: number, extra: any = {}) => ({ id, condition_id: cid, measure_role: "surface_area", computed: { perimeter_lf: lf, area_sf: lf * (extra.height_ft ?? 8) }, ...extra });
const floor = (id: string, cid: string) => ({ id, condition_id: cid, measure_role: "floor_area", computed: { area_sf: 100, perimeter_lf: 40 } });
const cond = { id: "c1", height_ft: 8 };

test("breakdown lists linear + wall rows of one condition in draw order, numbered from 1", () => {
  const rows = measurementBreakdown([lin("a", "c1", 45.4), floor("f", "c1"), wall("b", "c1", 41.4), lin("z", "c2", 9)], "c1", cond);
  assert.deepEqual(rows.map((r) => [r.n, r.id, r.role]), [[1, "a", "linear"], [2, "b", "wall"]]);
  assert.equal(rows[0].lf, 45.4);
  assert.equal(rows[1].lf, 41.4);
  assert.equal(rows[1].h, 8);
  assert.equal(rows[1].sf, 41.4 * 8);
});

test("floor areas, counts and other conditions never appear", () => {
  assert.deepEqual(measurementBreakdown([floor("f", "c1"), { id: "k", condition_id: "c1", measure_role: "count", computed: { count: 3 } }], "c1", cond), []);
  assert.deepEqual(measurementBreakdown([lin("a", "c2", 5)], "c1", cond), []);
});

test("wall height: explicit override wins, then shape height, then condition height", () => {
  assert.equal(wallHeightFt({ height_override: true, height_ft: 4 }, cond), 4);
  assert.equal(wallHeightFt({ height_ft: 10 }, cond), 10);
  assert.equal(wallHeightFt({}, cond), 8);
  assert.equal(wallHeightFt({}, {}), 0);
});

test("a wall without stored area falls back to LF × H", () => {
  const w = { id: "w", condition_id: "c1", measure_role: "surface_area", computed: { perimeter_lf: 10 } };
  assert.equal(measurementBreakdown([w], "c1", cond)[0].sf, 80);
});

test("empty and null input are safe", () => {
  assert.deepEqual(measurementBreakdown([], "c1", cond), []);
  assert.deepEqual(measurementBreakdown(null as any, "c1", cond), []);
});
