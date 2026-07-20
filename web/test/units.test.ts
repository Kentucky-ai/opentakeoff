// Unit-system display layer (lib/units.ts) — pure conversions, plus the two
// metric-display integration cases (ratio-scale presets, metric CSV) restored
// with the metric display port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { areaVal, areaUnit, lenVal, lenUnit, calInputToFeet, M_PER_FT, M2_PER_SF, ftIn, fmtCheckLen, parseLenInput, checkVerdict } from "../src/lib/units.js";
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
  const metric = totalsToCsv(rows, "P", null, null, null, null, null, "OpenTakeoff", "metric");
  assert.match(metric, /Floor m2/);
  assert.match(metric, /92\.9/);      // 1000 SF → 92.9 m²
  assert.match(metric, /30\.48/);     // 100 LF → 30.48 m
  assert.doesNotMatch(metric, /SY/);
  const imperial = totalsToCsv(rows, "P");
  assert.match(imperial, /Floor SF/);
  assert.match(imperial, /SY w\/Waste/);
});

// ── Check-a-dimension helpers (ftIn / fmtCheckLen / parseLenInput) ──────────

test("ftIn renders drawing-style feet-and-inches", () => {
  assert.equal(ftIn(12.5), "12′ 6″");
  assert.equal(ftIn(11.999), "12′ 0″");   // 12″ rolls up
  assert.equal(ftIn(0.49), "0′ 6″");      // rounds to nearest inch
  assert.equal(ftIn(0), "0′ 0″");
  assert.equal(ftIn(-3.25), "-3′ 3″");
  assert.equal(ftIn(NaN), "");
});

test("fmtCheckLen: ft-in imperial, meters metric", () => {
  assert.equal(fmtCheckLen(12.5, "imperial"), "12′ 6″");
  assert.equal(fmtCheckLen(10, "metric"), "3.05 m");
});

test("parseLenInput reads decimal feet, feet-inches forms, and meters", () => {
  assert.equal(parseLenInput("12.5", "imperial"), 12.5);
  assert.equal(parseLenInput("12'6", "imperial"), 12.5);
  assert.equal(parseLenInput(`12' 6"`, "imperial"), 12.5);
  assert.equal(parseLenInput("12-6", "imperial"), 12.5);
  assert.equal(parseLenInput("12′ 6″", "imperial"), 12.5);
  assert.equal(parseLenInput("12ft 6in", "imperial"), 12.5);
  assert.equal(parseLenInput(".5", "imperial"), 0.5);
  assert.equal(parseLenInput("0'6", "imperial"), 0.5);
  assert.ok(Math.abs(parseLenInput("3.81", "metric") - 3.81 / M_PER_FT) < 1e-9);
  assert.ok(Math.abs(parseLenInput("3.81 m", "metric") - 3.81 / M_PER_FT) < 1e-9);
  assert.ok(Number.isNaN(parseLenInput("", "imperial")));
  assert.ok(Number.isNaN(parseLenInput("banana", "imperial")));
  assert.ok(Number.isNaN(parseLenInput("12'14", "imperial")));  // 14 inches is not a dimension
});

test("parseLenInput reads inches-only forms (a sub-foot check dimension)", () => {
  assert.equal(parseLenInput(`6"`, "imperial"), 0.5);
  assert.equal(parseLenInput("6″", "imperial"), 0.5);
  assert.equal(parseLenInput("6in", "imperial"), 0.5);
  assert.equal(parseLenInput(`4.5"`, "imperial"), 0.375);
  assert.equal(parseLenInput(`18"`, "imperial"), 1.5);  // ≥12″ is legit inches-only
});

test("parseLenInput rejects scientific notation and negatives", () => {
  assert.ok(Number.isNaN(parseLenInput("1e3", "imperial")));
  assert.ok(Number.isNaN(parseLenInput("-5", "imperial")));
  assert.ok(Number.isNaN(parseLenInput("-5.5", "imperial")));
  assert.ok(Number.isNaN(parseLenInput("1e3", "metric")));
  assert.ok(Number.isNaN(parseLenInput("-5", "metric")));
  assert.ok(Number.isNaN(parseLenInput("Infinity", "imperial")));
});

// ── Check-tool verdict: grade must agree with the displayed rounded % ───────

test("checkVerdict grades the rounded value the chip displays", () => {
  // green ≤ 1.0 as displayed
  assert.deepEqual(checkVerdict(0.95), { shown: 0.9, grade: "match" }); // 0.95 is 0.9499… in IEEE — displays 0.9
  assert.deepEqual(checkVerdict(1.0), { shown: 1, grade: "match" });
  assert.deepEqual(checkVerdict(1.04), { shown: 1, grade: "match" });   // displays "+1.0%" → must be green
  assert.equal(checkVerdict(1.06).grade, "close");                      // displays "+1.1%" → amber
  // amber ≤ 5.0 as displayed
  assert.deepEqual(checkVerdict(4.95), { shown: 5, grade: "close" });   // 4.95 rounds up — displays 5.0
  assert.deepEqual(checkVerdict(5.0), { shown: 5, grade: "close" });
  assert.deepEqual(checkVerdict(5.04), { shown: 5, grade: "close" });   // displays "+5.0%" → must be amber
  assert.equal(checkVerdict(5.06).grade, "wrong");                      // displays "+5.1%" → red
  // sign-symmetric
  assert.deepEqual(checkVerdict(-1.04), { shown: -1, grade: "match" });
  assert.equal(checkVerdict(-5.06).grade, "wrong");
});

test("checkVerdict normalizes -0: an exact recalibrate reads +0.0%", () => {
  const v = checkVerdict(-1e-14);  // 1-ulp FP residue after recalibrate → re-check
  assert.ok(Object.is(v.shown, 0), `expected +0, got ${Object.is(v.shown, -0) ? "-0" : v.shown}`);
  assert.equal(v.grade, "match");
  assert.equal(`${v.shown >= 0 ? "+" : ""}${v.shown.toFixed(1)}%`, "+0.0%");
});

test("parseLenInput accepts smart punctuation (macOS/iOS substitution, spec-doc pastes)", () => {
  assert.equal(parseLenInput("12’6”", "imperial"), 12.5);
  assert.equal(parseLenInput("6’", "imperial"), 6);
  assert.equal(parseLenInput("18”", "imperial"), 1.5);
});

test("checkVerdict refuses to grade a non-answer green", () => {
  assert.equal(checkVerdict(NaN).grade, "wrong");
  assert.equal(checkVerdict(Infinity).grade, "wrong");
  assert.equal(checkVerdict(-Infinity).grade, "wrong");
});
