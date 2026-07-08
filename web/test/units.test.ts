// Unit-system display layer + metric scale presets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { areaVal, areaUnit, lenVal, lenUnit, calInputToFeet, M_PER_FT, M2_PER_SF } from "../src/lib/units.js";
import { STANDARD_SCALES, RENDER_SCALE } from "../src/lib/sheets.js";
import { totalsToCsv } from "../src/lib/totals.js";

test("area/length convert only in metric", () => {
  assert.equal(areaVal(1000, "imperial"), 1000);
  assert.ok(Math.abs(areaVal(1000, "metric") - 92.90304) < 1e-9);
  assert.equal(lenVal(100, "imperial"), 100);
  assert.ok(Math.abs(lenVal(100, "metric") - 30.48) < 1e-9);
  assert.equal(areaUnit("imperial"), "SF");
  assert.equal(areaUnit("metric"), "m²");
  assert.equal(lenUnit("metric"), "m");
});

test("calibration input converts meters to internal feet", () => {
  assert.equal(calInputToFeet(10, "imperial"), 10);
  assert.ok(Math.abs(calInputToFeet(3.048, "metric") - 10) < 1e-9);
  assert.ok(Math.abs(M_PER_FT * M_PER_FT - M2_PER_SF) < 1e-12);
});

test("metric ratio scales produce correct feet-per-pixel", () => {
  const s100 = STANDARD_SCALES.find((s) => s.label === "1:100");
  assert.ok(s100, "1:100 preset missing");
  // at 1:100, one paper inch (72*RENDER_SCALE px) is 100 real inches = 100/12 ft
  const pxPerIn = 72 * RENDER_SCALE;
  assert.ok(Math.abs(s100!.upp * pxPerIn - 100 / 12) < 1e-9);
  // a 1 m real distance at 1:100 is 1 cm on paper; in px that's pxPerIn/2.54;
  // measured length = px × upp ≈ 3.2808 ft ≈ 1 m
  const ft = (pxPerIn / 2.54) * s100!.upp;
  assert.ok(Math.abs(ft * M_PER_FT - 1) < 1e-6);
  for (const label of ["1:20", "1:50", "1:200", "1:500"]) {
    assert.ok(STANDARD_SCALES.some((s) => s.label === label), `${label} preset missing`);
  }
});

test("metric CSV converts measured columns and drops SY", () => {
  const rows = [{
    id: "c1", finish_tag: "LVT-1", shape_count: 1, multiplier: 1, waste_pct: 0,
    floor_sf: 1000, wall_sf: 0, border_sf: 0, total_sf: 1000, lf: 100, ea: 0,
    total_sf_net: 1000, lf_net: 100, sy_net: 111.1, materials: [],
  }];
  const metric = totalsToCsv(rows, "P", "metric");
  assert.match(metric, /Floor m2/);
  assert.match(metric, /92\.9/);      // 1000 SF → 92.9 m²
  assert.match(metric, /30\.48/);     // 100 LF → 30.48 m
  assert.doesNotMatch(metric, /SY/);
  const imperial = totalsToCsv(rows, "P");
  assert.match(imperial, /Floor SF/);
  assert.match(imperial, /SY \(w\/ waste\)/);
});
