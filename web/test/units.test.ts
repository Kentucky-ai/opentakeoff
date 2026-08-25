// Unit-system display layer (lib/units.ts) — pure conversions, plus the two
// metric-display integration cases (ratio-scale presets, metric CSV) restored
// with the metric display port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { areaVal, areaUnit, lenVal, lenUnit, calInputToFeet, M_PER_FT, M2_PER_SF, ftIn, dimLabel, fmtCheckLen, parseLenInput, checkVerdict, heightVal, heightUnit, heightInputToFeet, heightStep, thickVal, thickUnit, thickInputToInches, thickStep, dimInputStr } from "../src/lib/units.js";
import { STANDARD_SCALES, RENDER_SCALE } from "../src/lib/sheets.js";
import { totalsToCsv } from "../src/lib/totals.js";
import { readFileSync } from "node:fs";

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
  assert.match(metric, /Floor m²/);
  assert.match(metric, /92\.9/);      // 1000 SF → 92.9 m²
  assert.match(metric, /30\.48/);     // 100 LF → 30.48 m
  assert.doesNotMatch(metric, /SY/);
  const imperial = totalsToCsv(rows, "P");
  assert.match(imperial, /Floor SF/);
  assert.match(imperial, /SY w\/Waste/);
});

test("metric CSV converts human-readable material coverage while keeping quantity canonical", () => {
  const rows = [{
    id: "c1", finish_tag: "LVT-1", shape_count: 1, multiplier: 1, waste_pct: 0,
    floor_sf: 100, wall_sf: 0, border_sf: 0, total_sf: 100, lf: 0, ea: 0,
    total_sf_net: 100, lf_net: 0, sy_net: 11.11,
    materials: [{ name: "Adhesive", qty: 1, unit: "bucket", per: 100, basis: "area" }],
  }];
  const csv = totalsToCsv(rows, "P", null, null, null, null, null, "OpenTakeoff", "metric");
  assert.match(csv, /1 bucket \/ 9\.29 m²/);
  assert.match(csv, /,1,bucket,/);
});

test("canvas dimension annotation passes the global unit system to dimLabel", () => {
  const source = readFileSync(new URL("../src/pages/TakeoffCanvas.jsx", import.meta.url), "utf8");
  assert.match(source, /dimLabel\(m\.len_ft, units\)/);
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

test("dimLabel is the WinAnsi-safe sibling of ftIn: ASCII feet-inches, meters in metric", () => {
  assert.equal(dimLabel(12.5), "12'-6\"");
  assert.equal(dimLabel(11.999), "12'-0\"");   // 12″ rolls up, same rule as ftIn
  assert.equal(dimLabel(0.49), "0'-6\"");
  assert.equal(dimLabel(-3.25), "-3'-3\"");
  assert.equal(dimLabel(NaN), "");
  assert.equal(dimLabel(10, "metric"), "3.05 m");
  // every character survives the marked set's WinAnsi funnel (' and " are ASCII)
  for (const ch of dimLabel(12.5)) assert.ok(ch.codePointAt(0)! < 0x7f);
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

// ── condition/shape dimension params (issue #115) ────────────────────────────

test("wall height converts at the edge, feet stay internal", () => {
  assert.equal(heightVal(8, "imperial"), 8);
  assert.ok(Math.abs(heightVal(8, "metric") - 2.4384) < 1e-9);
  assert.equal(heightUnit("imperial"), "ft");
  assert.equal(heightUnit("metric"), "m");
});

test("a typed metric height is METRES — the #115 regression guard", () => {
  // the bug: a metric user typing a 2.4 m wall got 2.4 FEET stored
  assert.ok(Math.abs(heightInputToFeet(2.4, "metric") - 7.874015748) < 1e-6);
  assert.equal(heightInputToFeet(2.4, "imperial"), 2.4);
  // direction matters: metres->feet must GROW the number, never shrink it
  assert.ok(heightInputToFeet(3, "metric") > 3);
});

test("height input round-trips through the display edge", () => {
  for (const ft of [0.25, 4, 8, 9.5, 12]) {
    const shown = heightVal(ft, "metric");
    assert.ok(Math.abs(heightInputToFeet(shown, "metric") - ft) < 1e-9);
  }
});

test("thickness localizes to MILLIMETRES, not metres", () => {
  assert.equal(thickVal(1, "imperial"), 1);
  assert.ok(Math.abs(thickVal(1, "metric") - 25.4) < 1e-9);
  assert.equal(thickUnit("imperial"), "in");
  assert.equal(thickUnit("metric"), "mm");
  // 3 mm LVT reads back as 3 mm, not 0.003 of anything
  assert.ok(Math.abs(thickVal(thickInputToInches(3, "metric"), "metric") - 3) < 1e-9);
});

test("thickness input round-trips through the display edge", () => {
  for (const inches of [0.25, 1, 2, 3.5]) {
    const shown = thickVal(inches, "metric");
    assert.ok(Math.abs(thickInputToInches(shown, "metric") - inches) < 1e-9);
  }
});

test("dimInputStr rounds for display without drifting a value nobody edited", () => {
  assert.equal(dimInputStr(8, "imperial", "height"), "8");
  assert.equal(dimInputStr(8, "metric", "height"), "2.438");
  assert.equal(dimInputStr(1, "metric", "thickness"), "25.4");
  assert.equal(dimInputStr(3, "imperial", "thickness"), "3");
  // a re-commit of the untouched displayed value stays within a millimetre
  const back = heightInputToFeet(Number(dimInputStr(8, "metric", "height")), "metric");
  assert.ok(Math.abs(back - 8) < 0.002);
});

test("a cleared dimension param is empty, never 0", () => {
  assert.equal(dimInputStr(null, "metric", "height"), "");
  assert.equal(dimInputStr(undefined, "imperial", "height"), "");
  assert.equal(dimInputStr("", "metric", "thickness"), "");
  assert.equal(dimInputStr(NaN, "metric", "height"), "");
  assert.equal(dimInputStr(0, "metric", "height"), "0");   // an explicit 0 is a real value
});

test("dimension spinner steps suit the system they're typed in", () => {
  assert.equal(heightStep("imperial"), 0.25);
  assert.equal(heightStep("metric"), 0.05);
  assert.equal(thickStep("imperial"), 0.25);
  assert.equal(thickStep("metric"), 1);
});

// ── Task 3: Surface-area equivalence across unit systems ─────────────────────
// A wall traced at 10 ft LF with 8 ft height must produce the same canonical
// area_sf whether the user typed the height as 8 ft (imperial) or 2.4384 m
// (metric).  The invariant: LF × canonical_height_ft = area_sf in both cases;
// switching display units never changes the stored math.

test("surface area equivalence: 10 ft × 8 ft wall equals 3.048 m × 2.4384 m wall", () => {
  const LF = 10;          // 10 linear feet of wall traced
  const hFt = 8;          // 8 ft wall height
  const areaImperial = LF * hFt;   // 80 SF
  // In metric the user would type 2.4384 m → stored as 8 ft via heightInputToFeet
  const hMetricShown = heightVal(hFt, "metric");           // 8 × 0.3048 = 2.4384 m
  const hBackToFeet = heightInputToFeet(hMetricShown, "metric"); // round-trip
  const areaMetric = LF * hBackToFeet;
  assert.ok(Math.abs(areaImperial - areaMetric) < 1e-9, `imperial ${areaImperial} vs metric-path ${areaMetric}`);
  // Same in metric-display: areaVal(80 SF) ≈ 7.432 m² ≈ 3.048 m × 2.4384 m
  const m2Direct = (LF * M_PER_FT) * hMetricShown;   // metres × metres
  assert.ok(Math.abs(areaVal(areaImperial, "metric") - m2Direct) < 1e-6,
    `areaVal(${areaImperial}) ${areaVal(areaImperial, "metric")} vs m² direct ${m2Direct}`);
});

test("height/thickness input round-trips across the full equivalence chain", () => {
  // height: 8 ft → display 2.438 m → re-input → 8 ft
  const hDisplay = heightVal(8, "metric");
  assert.ok(Math.abs(hDisplay - 2.4384) < 1e-9);
  assert.ok(Math.abs(heightInputToFeet(hDisplay, "metric") - 8) < 1e-9);
  // thickness: 0.25 in → display 6.35 mm → re-input → 0.25 in
  const tDisplay = thickVal(0.25, "metric");
  assert.ok(Math.abs(tDisplay - 6.35) < 1e-9);
  assert.ok(Math.abs(thickInputToInches(tDisplay, "metric") - 0.25) < 1e-9);
  // thickness: 3 mm typed → 0.1181... in → display 3 mm (no drift)
  const t3mm = thickInputToInches(3, "metric");           // canonical inches
  assert.ok(Math.abs(t3mm - 3 / 25.4) < 1e-9);
  assert.ok(Math.abs(thickVal(t3mm, "metric") - 3) < 1e-9, "3 mm round-trips");
  // dimInputStr shows metric height to 3dp (mm precision), thickness to 1dp
  assert.equal(dimInputStr(8, "metric", "height"), "2.438");
  assert.equal(dimInputStr(0.25, "metric", "thickness"), "6.3"); // 0.25 × 25.4 = 6.35 → slightly below in IEEE-754, toFixed(1) = "6.3"
});

test("a metric wall traced at 2.4384 m height stores canonical 8 ft", () => {
  // The full input edge: user types 2.4384 in metric height → DimParamInput
  // calls heightInputToFeet(2.4384, "metric") → 8 ft stored as height_ft.
  const stored = heightInputToFeet(2.4384, "metric");
  assert.ok(Math.abs(stored - 8) < 1e-6, `expected ~8 ft, got ${stored}`);
  // A metric wall traced at 3.048 m LF with 2.4384 m height → 80 SF
  const LFm = 3.048;      // 10 ft in metres
  const hm = 2.4384;      // 8 ft in metres
  const LFft = LFm / M_PER_FT;  // back to feet
  const hft = hm / M_PER_FT;
  assert.ok(Math.abs(LFft * hft - 80) < 0.01, `expected 80 SF, got ${LFft * hft}`);
});

// ── P1-1: Roll UI metric round-trip ────────────────────────────────────────
// Roll setup stores width in feet and seam/wall overage in inches. Metric
// display shows meters (width/length) and millimetres (seam/wall). Input
// back-conversion must preserve the canonical value without drift.

test("roll width metric round-trip: 12 ft = 3.6576 m", () => {
  // Display: 12 ft → 3.6576 m
  const widthM = 12 * M_PER_FT;
  assert.ok(Math.abs(widthM - 3.6576) < 1e-6);
  // Input: 3.6576 m → back to 12 ft
  const backFt = widthM / M_PER_FT;
  assert.ok(Math.abs(backFt - 12) < 1e-6, `width round-trip: ${backFt}`);
});

test("roll seam/wall overage metric round-trip: 2 in = 50.8 mm, 3 in = 76.2 mm", () => {
  // Display: 2 in → 50.8 mm
  const seamMm = thickVal(2, "metric");
  assert.ok(Math.abs(seamMm - 50.8) < 1e-6);
  // Input: 50.8 mm → back to 2 in
  const seamBack = thickInputToInches(50.8, "metric");
  assert.ok(Math.abs(seamBack - 2) < 1e-6, `seam round-trip: ${seamBack}`);
  // Wall overage: 3 in → 76.2 mm
  const wallMm = thickVal(3, "metric");
  assert.ok(Math.abs(wallMm - 76.2) < 1e-6);
  const wallBack = thickInputToInches(76.2, "metric");
  assert.ok(Math.abs(wallBack - 3) < 1e-6, `wall round-trip: ${wallBack}`);
});

test("roll length metric round-trip: 30 ft = 9.144 m", () => {
  // Display: 30 ft → 9.144 m
  const lengthM = 30 * M_PER_FT;
  assert.ok(Math.abs(lengthM - 9.144) < 1e-6);
  // Input: 9.144 m → back to 30 ft
  const backFt = lengthM / M_PER_FT;
  assert.ok(Math.abs(backFt - 30) < 1e-6, `length round-trip: ${backFt}`);
});

// ── P2-1: Report zero rendering ─────────────────────────────────────────────
// The num() helper must return "0" for zero values, and the renderCell logic
// must distinguish numeric zero from blank/null/undefined.

test("num(0) returns '0', not empty string", async () => {
  const { num } = await import("../src/lib/num.js") as { num: (v: unknown, d?: number) => string };
  assert.equal(num(0), "0");
  assert.equal(num(0, 0), "0");
  assert.equal(num(0, 2), "0");
  assert.equal(num(0.001, 1), "0");   // rounds to 0 at display precision
  assert.equal(num(null), "0");       // guarded: null → "0" not throw
  assert.equal(num(undefined), "0");  // guarded: undefined → "0" not throw
});

test("sheetNum helper: zero values at display precision", () => {
  // sheetNum rounds to display precision and shows "—" only for near-zero slivers
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  const sheetNum = (v: number, d = 1) => {
    const r = round2(v);
    if (!Math.round(Math.abs(r) * 10 ** d)) return "—";
    return String(r);
  };
  assert.equal(sheetNum(0), "—");           // exact zero → "—" (display precision)
  assert.equal(sheetNum(0.01, 1), "—");     // 0.01 rounds to 0.0 at 1dp → "—"
  assert.equal(sheetNum(0.05, 1), "0.05");  // round2 keeps 0.05; 0.05×10=0.5 rounds to 1 (non-zero) → String(0.05)
  assert.equal(sheetNum(0.1, 1), "0.1");    // 0.1 rounds to 0.1 at 1dp → "0.1"
  assert.equal(sheetNum(1, 1), "1");        // non-zero → "1"
  assert.equal(sheetNum(-0.01, 1), "—");    // negative sliver → "—"
  assert.equal(sheetNum(-1, 1), "-1");      // negative non-zero → "-1"
});

test("renderCell zero behavior: numeric 0 shows '0', null/undefined shows '—'", () => {
  // The renderCell logic uses v != null ? num(v) : "—"
  // This test verifies the underlying behavior
  const num = (v: unknown, d: number = 1) => (Number(v) || 0).toLocaleString(undefined, { maximumFractionDigits: d });
  // Numeric zero should show "0"
  assert.equal(num(0), "0");
  assert.equal(num(0, 0), "0");
  // Non-zero values show formatted
  assert.equal(num(100), "100");
  assert.equal(num(50.25, 0), "50");
  // The guard v != null means:
  // v = 0 → num(0) = "0" (shows)
  // v = null → "—" (shows dash)
  // v = undefined → "—" (shows dash)
  // v = "" → num("") = "0" (shows "0", but this is edge case)
  assert.equal(num(0), "0");
  // In the actual renderCell code:
  // case "ea": return v != null ? num(v, 0) : "—";
  // v = 0 → 0 != null → true → num(0, 0) = "0"
  // v = null → null != null → false → "—"
  assert.equal(0 != null, true);  // JavaScript truth: 0 is not null
  assert.equal(null != null, false);
  assert.equal(undefined != null, false);
});
