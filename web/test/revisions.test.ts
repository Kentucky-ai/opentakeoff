// Revision compare — the quantity-level diff. Payloads use the autosave shape
// ({ conditions, shapes }); every case runs through the same conditionTotals
// math the report uses, so these tests pin the compare to report semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffTakeoffs, diffToCsv, revSheetLabel } from "../src/lib/revisions.js";
import { round2 } from "../src/lib/totals.js";

const cond = (over: Record<string, unknown> = {}) => ({
  id: "c1", finish_tag: "CPT-1", color: "#123456", multiplier: 1, waste_pct: 0, materials: [], ...over,
});
const shape = (over: Record<string, unknown> = {}) => ({
  id: "s1", sheet_id: "plan.pdf", condition_id: "c1", measure_role: "floor_area", computed: { area_sf: 100 }, ...over,
});
const takeoff = (conditions: unknown[], shapes: unknown[]) => ({ conditions, shapes });

test("identical takeoffs diff as unchanged with zero deltas", () => {
  const a = takeoff([cond()], [shape()]);
  const d = diffTakeoffs(a, takeoff([cond()], [shape()]));
  assert.equal(d.changed, 0);
  assert.equal(d.conditions[0].status, "unchanged");
  assert.equal(d.conditions[0].deltas.total_sf, 0);
  assert.ok(d.sheets.every((s) => s.status === "unchanged"));
});

test("a waste-only edit moves the ordered quantity and nothing else", () => {
  const d = diffTakeoffs(
    takeoff([cond({ waste_pct: 0 })], [shape()]),
    takeoff([cond({ waste_pct: 10 })], [shape()]),
  );
  const c = d.conditions[0];
  assert.equal(c.status, "changed");
  assert.equal(c.deltas.total_sf, 0);          // measured did not move
  assert.equal(c.deltas.total_sf_net, 10);     // the order did
});

// ── lf_net regression: waste-only edit on a linear condition ──────────────
test("waste-only edit on a linear condition moves lf_net but not lf", () => {
  const linCond = (waste: number) => cond({ waste_pct: waste, materials: [] });
  const linShape = () => shape({ measure_role: "linear", computed: { perimeter_lf: 50, area_sf: 0 } });
  const d = diffTakeoffs(
    takeoff([linCond(0)], [linShape()]),
    takeoff([linCond(10)], [linShape()]),
  );
  const c = d.conditions[0];
  assert.equal(c.status, "changed", "waste change on linear is visible via lf_net");
  assert.equal(c.deltas.lf, 0, "lf (measured) unchanged");
  assert.equal(c.deltas.lf_net, 5, "lf_net = 50 × 10% = 5");
  assert.equal(c.deltas.total_sf, 0, "total_sf unchanged for pure linear");
  assert.equal(c.deltas.total_sf_net, 0, "total_sf_net unchanged for pure linear");
});

test("added and removed conditions report with the full quantity as the delta", () => {
  const d = diffTakeoffs(
    takeoff([cond()], [shape()]),
    takeoff([cond(), cond({ id: "c2", finish_tag: "LVT-2" })], [shape(), shape({ id: "s2", condition_id: "c2", computed: { area_sf: 55 } })]),
  );
  const added = d.conditions.find((c) => c.finish_tag === "LVT-2");
  assert.equal(added?.status, "added");
  assert.equal(added?.deltas.total_sf, 55);    // b's value, not zero-filled

  const d2 = diffTakeoffs(takeoff([cond()], [shape()]), takeoff([], []));
  assert.equal(d2.conditions[0].status, "removed");
  assert.equal(d2.conditions[0].deltas.total_sf, -100);
});

test("deleted-and-recreated condition pairs by finish_tag instead of diffing as remove+add", () => {
  const d = diffTakeoffs(
    takeoff([cond({ id: "old-uid" })], [shape({ condition_id: "old-uid" })]),
    takeoff([cond({ id: "new-uid" })], [shape({ condition_id: "new-uid", computed: { area_sf: 120 } })]),
  );
  assert.equal(d.conditions.length, 1);
  assert.equal(d.conditions[0].status, "changed");
  assert.equal(d.conditions[0].deltas.total_sf, 20);
});

test("duplicate finish_tags pair in order with distinct keys", () => {
  const two = (p: string) => [cond({ id: `${p}1`, finish_tag: "CT-1" }), cond({ id: `${p}2`, finish_tag: "CT-1" })];
  const d = diffTakeoffs(
    takeoff(two("a"), [shape({ condition_id: "a1" }), shape({ id: "s2", condition_id: "a2", computed: { area_sf: 30 } })]),
    takeoff(two("b"), [shape({ condition_id: "b1" }), shape({ id: "s2", condition_id: "b2", computed: { area_sf: 30 } })]),
  );
  assert.equal(d.conditions.length, 2);
  assert.notEqual(d.conditions[0].key, d.conditions[1].key);   // ordinal keeps keys unique
  assert.ok(d.conditions.every((c) => c.status === "unchanged"));
});

test("shapeless seeded conditions never fabricate an add/remove", () => {
  const d = diffTakeoffs(
    takeoff([], []),
    takeoff([cond({ id: "seed1", finish_tag: "VCT-1" })], []),     // present, zero shapes
  );
  assert.equal(d.conditions[0].status, "unchanged");
  assert.equal(d.changed, 0);
});

test("sub-display drift reports unchanged; a visible move reports changed", () => {
  const base = takeoff([cond()], [shape()]);
  const drift = diffTakeoffs(base, takeoff([cond()], [shape({ computed: { area_sf: 100.02 } })]));
  assert.equal(drift.conditions[0].status, "unchanged");
  const real = diffTakeoffs(base, takeoff([cond()], [shape({ computed: { area_sf: 100.4 } })]));
  assert.equal(real.conditions[0].status, "changed");
});

test("a shape moving between sheets shows as paired sheet deltas", () => {
  const d = diffTakeoffs(
    takeoff([cond()], [shape({ sheet_id: "plan.pdf" })]),
    takeoff([cond()], [shape({ sheet_id: "plan.pdf#2" })]),
  );
  const s1 = d.sheets.find((s) => s.sheet_id === "plan.pdf");
  const s2 = d.sheets.find((s) => s.sheet_id === "plan.pdf#2");
  assert.equal(s1?.status, "removed");
  assert.equal(s1?.deltas.floor_sf, -100);
  assert.equal(s2?.status, "added");
  assert.equal(s2?.deltas.floor_sf, 100);
  assert.equal(d.conditions[0].status, "unchanged");   // condition totals didn't move
});

test("buy-list deltas track the combined materials order", () => {
  const withMat = (per: number) => [cond({ materials: [{ name: "Adhesive", unit: "pail", per, basis: "area" }] })];
  const d = diffTakeoffs(
    takeoff(withMat(40), [shape()]),      // 100/40 -> 3 pails
    takeoff(withMat(25), [shape()]),      // 100/25 -> 4 pails
  );
  assert.equal(d.materials.length, 1);
  assert.equal(d.materials[0].a_qty, 3);
  assert.equal(d.materials[0].b_qty, 4);
  assert.equal(d.materials[0].delta, 1);
  assert.equal(d.materials[0].status, "changed");
});

test("orphan shapes (deleted condition) stay out of sheet deltas", () => {
  const d = diffTakeoffs(
    takeoff([cond()], [shape(), shape({ id: "s2", condition_id: "ghost", computed: { area_sf: 999 } })]),
    takeoff([cond()], [shape()]),
  );
  assert.ok(d.sheets.every((s) => s.status === "unchanged"));
});

test("revSheetLabel formats page keys", () => {
  assert.equal(revSheetLabel("plan.pdf"), "plan");
  assert.equal(revSheetLabel("plan.pdf#3"), "plan — p.3");
});

// ── P1.1: reconciled deducts must not double-subtract ────────────────────
// A parent shape with computed.area_sf = 90 (already net of a 10 SF hole)
// plus a reconciled deduct shape (cuts_shape_id set) must yield floor_sf = 90,
// NOT 80 (which would happen if the deduct were subtracted again).
test("revisions: reconciled deduct does not double-subtract in perSheet", () => {
  const parentShape = { id: "p1", sheet_id: "plan.pdf", condition_id: "c1", measure_role: "floor_area", computed: { area_sf: 90 } };
  const reconciledDeduct = { id: "d1", sheet_id: "plan.pdf", condition_id: "c1", measure_role: "deduct", cuts_shape_id: "p1", computed: { area_sf: 10 } };
  const d = diffTakeoffs(
    takeoff([cond()], [parentShape, reconciledDeduct]),
    takeoff([cond()], [parentShape, reconciledDeduct]),
  );
  // Both sides identical → unchanged, floor_sf = 90 (parent's net area)
  assert.equal(d.conditions[0].status, "unchanged");
  assert.equal(d.conditions[0].deltas.floor_sf, 0);
  // Verify the condition total is 90, not 80
  assert.equal(d.conditions[0].a.floor_sf, 90, "reconciled deduct: parent's net area, not double-subtracted");
});

test("revisions: legacy independent deduct still subtracts", () => {
  const parentShape = { id: "p1", sheet_id: "plan.pdf", condition_id: "c1", measure_role: "floor_area", computed: { area_sf: 100 } };
  const legacyDeduct = { id: "d1", sheet_id: "plan.pdf", condition_id: "c1", measure_role: "deduct", computed: { area_sf: 10 } };
  const d = diffTakeoffs(
    takeoff([cond()], [parentShape, legacyDeduct]),
    takeoff([cond()], [parentShape, legacyDeduct]),
  );
  // Legacy deduct: 100 - 10 = 90
  assert.equal(d.conditions[0].a.floor_sf, 90, "legacy deduct: area subtracted");
});

test("revisions: reconciled deduct change in parent triggers changed", () => {
  const parentA = { id: "p1", sheet_id: "plan.pdf", condition_id: "c1", measure_role: "floor_area", computed: { area_sf: 90 } };
  const reconciledA = { id: "d1", sheet_id: "plan.pdf", condition_id: "c1", measure_role: "deduct", cuts_shape_id: "p1", computed: { area_sf: 10 } };
  const parentB = { id: "p1", sheet_id: "plan.pdf", condition_id: "c1", measure_role: "floor_area", computed: { area_sf: 85 } };
  const reconciledB = { id: "d1", sheet_id: "plan.pdf", condition_id: "c1", measure_role: "deduct", cuts_shape_id: "p1", computed: { area_sf: 15 } };
  const d = diffTakeoffs(
    takeoff([cond()], [parentA, reconciledA]),
    takeoff([cond()], [parentB, reconciledB]),
  );
  // Parent changed from 90 to 85 → changed
  assert.equal(d.conditions[0].status, "changed");
  assert.equal(d.conditions[0].deltas.floor_sf, -5, "parent area change reflected");
});

test("diffToCsv carries statuses, deltas, sections, and escapes commas", () => {
  const d = diffTakeoffs(
    takeoff([cond({ finish_tag: 'CPT,1 "x"' })], [shape()]),
    takeoff([cond({ finish_tag: 'CPT,1 "x"' })], [shape({ computed: { area_sf: 150 } })]),
  );
  const csv = diffToCsv(d, { aName: "Rev 1", bName: "current", projectName: "Job" });
  assert.match(csv, /revision compare/);
  assert.match(csv, /"CPT,1 ""x""",changed/);
  assert.match(csv, /TOTAL/);
  assert.match(csv, /Sheet,Status/);
  // lf_net column present in header
  assert.match(csv, /w\/Waste/);
});

test("metric CSV converts areas and lengths", () => {
  const d = diffTakeoffs(takeoff([cond()], []), takeoff([cond()], [shape()]));
  const csv = diffToCsv(d, { units: "metric" });
  assert.match(csv, /d Floor m²/);
  assert.match(csv, /9\.29/);
});

// ── Task 2: metric visibility threshold (dimensional) ────────────────────
// Area and length have separate display precisions in metric: m² at 2 dp,
// m at 2 dp.  Each dimension type back-calculates its own SF/LF threshold
// so that the smallest visible change in the display unit is flagged "changed".

test("metric diffTakeoffs: tiny area change invisible in both systems", () => {
  const base = takeoff([cond()], [shape()]);
  // 0.04 SF ≈ 0.0037 m² — rounds to 0.00 m², below imperial threshold too
  const small = takeoff([cond()], [shape({ computed: { area_sf: 100.04 } })]);
  assert.equal(diffTakeoffs(base, small).conditions[0].status, "unchanged");
  assert.equal(diffTakeoffs(base, small, "metric").conditions[0].status, "unchanged");
});

test("metric diffTakeoffs: area change visible in imperial but below metric m² threshold", () => {
  const base = takeoff([cond()], [shape()]);
  // 0.10 SF ≈ 0.0093 m² — rounds to 0.01 m² which IS visible, so metric flags it
  const delta = takeoff([cond()], [shape({ computed: { area_sf: 100.10 } })]);
  assert.equal(diffTakeoffs(base, delta).conditions[0].status, "changed", "0.10 SF > 0.05 SF imperial");
  assert.equal(diffTakeoffs(base, delta, "metric").conditions[0].status, "changed", "0.10 SF ≈ 0.0093 m² → rounds to 0.01 m²");
});

test("metric diffTakeoffs: area change at metric 0.01 m² boundary", () => {
  const base = takeoff([cond()], [shape()]);
  // 0.0929 SF × M2_PER_SF = 0.0086 m² → rounds to 0.01 m² → visible
  const delta = takeoff([cond()], [shape({ computed: { area_sf: 100 + 0.0929 } })]);
  assert.equal(diffTakeoffs(base, delta, "metric").conditions[0].status, "changed",
    "0.0929 SF ≈ 0.01 m² boundary — visible in metric");
});

test("metric diffTakeoffs: large area change visible in both", () => {
  const base = takeoff([cond()], [shape()]);
  const delta = takeoff([cond()], [shape({ computed: { area_sf: 101 } })]);
  assert.equal(diffTakeoffs(base, delta).conditions[0].status, "changed");
  assert.equal(diffTakeoffs(base, delta, "metric").conditions[0].status, "changed");
});

// ── linear (LF) dimension — separate threshold ───────────────────────────

test("metric diffTakeoffs: tiny LF change invisible in both", () => {
  const base = takeoff([cond()], [shape({ measure_role: "linear", computed: { perimeter_lf: 50, area_sf: 0 } })]);
  // 0.01 LF ≈ 0.003 m → rounds to 0.00 m → invisible in metric
  // 0.01 LF < 0.05 LF imperial threshold → invisible in imperial
  const small = takeoff([cond()], [shape({ measure_role: "linear", computed: { perimeter_lf: 50.01, area_sf: 0 } })]);
  assert.equal(diffTakeoffs(base, small).conditions[0].status, "unchanged");
  assert.equal(diffTakeoffs(base, small, "metric").conditions[0].status, "unchanged",
    "0.01 LF ≈ 0.003 m — below display precision");
});

test("metric diffTakeoffs: LF change visible in metric when ≥ 0.01 m displayed", () => {
  const base = takeoff([cond()], [shape({ measure_role: "linear", computed: { perimeter_lf: 50, area_sf: 0 } })]);
  // 0.06 LF × M_PER_FT ≈ 0.0183 m → rounds to 0.02 m → visible
  const delta = takeoff([cond()], [shape({ measure_role: "linear", computed: { perimeter_lf: 50.06, area_sf: 0 } })]);
  // Imperial: 0.06 > 0.05 → changed
  assert.equal(diffTakeoffs(base, delta).conditions[0].status, "changed",
    "0.06 LF > 0.05 LF imperial threshold");
  // Metric: 0.06 LF × 0.3048 ≈ 0.0183 m → rounds to 0.02 m → visible
  assert.equal(diffTakeoffs(base, delta, "metric").conditions[0].status, "changed",
    "0.06 LF ≈ 0.018 m → visible in metric");
});

test("metric diffTakeoffs: large LF change visible in both", () => {
  const base = takeoff([cond()], [shape({ measure_role: "linear", computed: { perimeter_lf: 50, area_sf: 0 } })]);
  const delta = takeoff([cond()], [shape({ measure_role: "linear", computed: { perimeter_lf: 52, area_sf: 0 } })]);
  assert.equal(diffTakeoffs(base, delta).conditions[0].status, "changed");
  assert.equal(diffTakeoffs(base, delta, "metric").conditions[0].status, "changed");
});

// ── EA (count) — threshold unchanged across unit systems ──────────────────

test("EA threshold is 0.5 in both imperial and metric", () => {
  const base = takeoff([cond()], [shape({ measure_role: "count", computed: { count: 10, area_sf: 0, perimeter_lf: 0 } })]);
  const delta = takeoff([cond()], [shape({ measure_role: "count", computed: { count: 10.4, area_sf: 0, perimeter_lf: 0 } })]);
  assert.equal(diffTakeoffs(base, delta).conditions[0].status, "unchanged", "0.4 EA < 0.5 threshold");
  assert.equal(diffTakeoffs(base, delta, "metric").conditions[0].status, "unchanged", "EA threshold unchanged in metric");
  const big = takeoff([cond()], [shape({ measure_role: "count", computed: { count: 11, area_sf: 0, perimeter_lf: 0 } })]);
  assert.equal(diffTakeoffs(base, big).conditions[0].status, "changed");
  assert.equal(diffTakeoffs(base, big, "metric").conditions[0].status, "changed");
});

test("metric diffTakeoffs: without units param defaults to imperial threshold (backward compat)", () => {
  const base = takeoff([cond()], [shape()]);
  const small = takeoff([cond()], [shape({ computed: { area_sf: 100.06 } })]);
  // No units → imperial threshold → 0.06 > 0.05 → changed
  const d = diffTakeoffs(base, small);
  assert.equal(d.conditions[0].status, "changed", "no units → imperial threshold");
});

// ── material-only change counts toward changed ───────────────────────────

test("material-only change makes revision non-identical but doesn't count as condition-moved", () => {
  const withMat = (per: number) => [cond({ materials: [{ name: "Adhesive", unit: "pail", per, basis: "area" }] })];
  const d = diffTakeoffs(
    takeoff(withMat(40), [shape()]),
    takeoff(withMat(25), [shape()]),
  );
  // condition quantities are identical — only materials differ
  assert.equal(d.conditions[0].status, "unchanged");
  assert.equal(d.materials[0].status, "changed");
  assert.equal(d.changed, 0, "condition-level changed count is 0");
  assert.equal(d.materialsChanged, true, "materialsChanged flag is set");
});

// ── P1: material delta is a count, not an area conversion ────────────────
test("material delta is raw count (not area-converted)", () => {
  const withMat = (per: number) => [cond({ materials: [{ name: "Adhesive", unit: "pail", per, basis: "area" }] })];
  const d = diffTakeoffs(
    takeoff(withMat(40), [shape()]),      // 100/40 = 2.5 → ceil = 3
    takeoff(withMat(25), [shape()]),      // 100/25 = 4
  );
  // delta should be 1 (4-3), not area-converted
  assert.equal(d.materials[0].delta, 1);
  assert.equal(d.materials[0].unit, "pail");
  // verify the material object has the right shape
  assert.equal(d.materials[0].a_qty, 3);
  assert.equal(d.materials[0].b_qty, 4);
});

// ── precision: raw vs rounded delta edge cases ───────────────────────────

test("precision: conditionTotals round2 on sub-display values preserves diff accuracy", () => {
  // Two shapes that individually round but whose sum differs:
  // shape A: 50.004 SF → round2 → 50.00
  // shape B: 50.006 SF → round2 → 50.01
  // Sum: 100.01 (rounded individually) vs 100.01 (sum of rounded) — same
  const base = takeoff([cond()], [
    shape({ id: "a", computed: { area_sf: 50.004 } }),
    shape({ id: "b", computed: { area_sf: 50.006 } }),
  ]);
  const modified = takeoff([cond()], [
    shape({ id: "a", computed: { area_sf: 50.004 } }),
    shape({ id: "b", computed: { area_sf: 50.106 } }),
  ]);
  const d = diffTakeoffs(base, modified);
  // 50.106 - 50.006 = 0.10 raw delta → visible in imperial (> 0.05)
  assert.equal(d.conditions[0].status, "changed",
    "0.10 SF raw delta visible despite per-shape rounding");
  assert.equal(d.conditions[0].deltas.floor_sf, 0.1,
    "display delta matches raw difference");
});

test("precision: tiny sub-rounding delta stays unchanged", () => {
  // 0.001 SF difference — rounds to 0.00 on both sides
  const base = takeoff([cond()], [shape({ computed: { area_sf: 100 } })]);
  const tiny = takeoff([cond()], [shape({ computed: { area_sf: 100.001 } })]);
  assert.equal(diffTakeoffs(base, tiny).conditions[0].status, "unchanged");
  assert.equal(diffTakeoffs(base, tiny, "metric").conditions[0].status, "unchanged");
});

test("precision: material qty rounding — ceil(3.000001) vs ceil(3.49) both show as 4 pails", () => {
  // per=25 → 100/25 = 4 exactly; per=26 → ceil(100/26) = ceil(3.846) = 4
  // Both round to 4 — no material delta
  const withMat = (per: number) => [cond({ materials: [{ name: "Adhesive", unit: "pail", per, basis: "area" }] })];
  const d = diffTakeoffs(
    takeoff(withMat(25), [shape()]),
    takeoff(withMat(26), [shape()]),
  );
  assert.equal(d.materials[0].a_qty, 4);
  assert.equal(d.materials[0].b_qty, 4);
  assert.equal(d.materials[0].status, "unchanged",
    "both ceil to 4 — no visible material change");
});

// ── raw accumulator precision edge case ──────────────────────────────────
test("precision: raw accumulator avoids false changed from rounding", () => {
  // Two conditions where rounding pushes values to the same number:
  // A: floor = 99.996 → round2 = 100.00
  // B: floor = 100.004 → round2 = 100.00
  // Rounded delta = 0, but raw delta = 0.008 → below threshold → unchanged
  const a = takeoff([cond()], [shape({ computed: { area_sf: 99.996 } })]);
  const b = takeoff([cond()], [shape({ computed: { area_sf: 100.004 } })]);
  const d = diffTakeoffs(a, b);
  assert.equal(d.conditions[0].status, "unchanged",
    "0.008 SF raw delta below threshold");
  // round2 adds Number.EPSILON before rounding, which can push 0.008 → 0.01
  // The key invariant: the status is "unchanged" (raw delta below threshold)
  assert.ok(Math.abs(d.conditions[0].deltas.floor_sf) <= 0.01,
    "rounded delta is tiny (≤0.01)");
});

// ── raw delta preservation: metric conversion uses raw, not rounded ──────
test("raw deltas preserved alongside rounded for metric conversion", () => {
  // 0.054 SF: raw delta → 0.054 × M2_PER_SF ≈ 0.00502 → rounds to 0.01 m²
  // rounded delta = 0.05 → 0.05 × M2_PER_SF ≈ 0.00465 → rounds to 0.00 m²
  const a = takeoff([cond()], [shape({ computed: { area_sf: 100 } })]);
  const b = takeoff([cond()], [shape({ computed: { area_sf: 100.054 } })]);
  const d = diffTakeoffs(a, b, "metric");
  // rounded delta should be 0.05
  assert.equal(d.conditions[0].deltas.floor_sf, 0.05, "rounded delta is 0.05");
  // raw delta should be 0.054
  assert.ok(d.conditions[0]._rawDeltas, "_rawDeltas present");
  assert.ok(Math.abs(d.conditions[0]._rawDeltas.floor_sf - 0.054) < 1e-10,
    "raw delta preserved (~0.054)");
  // status should be changed (0.054 SF > imperial threshold)
  assert.equal(d.conditions[0].status, "changed");
});

test("raw deltas: convertDelta with raw value gives correct metric result", async () => {
  const { convertDelta } = await import("../src/lib/revisions.js");
  // raw 0.06 → 0.06 × M2 = 0.00557 → toFixed(2) = "0.01"
  assert.equal(convertDelta(0.06, "metric", "floor_sf"), 0.01,
    "raw 0.06 SF → 0.01 m²");
  // raw 0.053 → 0.053 × M2 = 0.00492 → toFixed(2) = "0.00"
  assert.equal(convertDelta(0.053, "metric", "floor_sf"), 0,
    "raw 0.053 SF → 0.00 m²");
  // imperial: raw passes through
  assert.equal(convertDelta(0.06, "imperial", "floor_sf"), 0.06,
    "imperial raw passes through");
});

// ── raw delta consistency: condition, totals, and sheet agree ────────────
test("raw deltas: condition, totals, and sheet show same visible delta", () => {
  // 100.006 → 100.060 SF: raw delta = 0.054
  const a = takeoff([cond()], [shape({ computed: { area_sf: 100.006 } })]);
  const b = takeoff([cond()], [shape({ computed: { area_sf: 100.060 } })]);
  const d = diffTakeoffs(a, b, "metric");
  // condition raw delta
  const condRaw = d.conditions[0]._rawDeltas.floor_sf;
  assert.ok(Math.abs(condRaw - 0.054) < 1e-10, `condition raw delta ~0.054, got ${condRaw}`);
  // totals raw delta (single condition → same as condition delta)
  const totRaw = d.totals._rawDeltas.total_sf;
  assert.ok(Math.abs(totRaw - condRaw) < 1e-10,
    `totals raw delta matches condition: ${totRaw} vs ${condRaw}`);
  // sheet raw delta (single shape → same as condition delta)
  const sheetRaw = d.sheets[0]._rawDeltas.floor_sf;
  assert.ok(Math.abs(sheetRaw - condRaw) < 1e-10,
    `sheet raw delta matches condition: ${sheetRaw} vs ${condRaw}`);
  // all status "changed"
  assert.equal(d.conditions[0].status, "changed");
  assert.equal(d.sheets[0].status, "changed");
});

test("raw deltas: multi-condition totals sum raw deltas from conditions", () => {
  // Two conditions with different raw deltas
  const a = takeoff(
    [cond({ id: "c1" }), cond({ id: "c2" })],
    [
      shape({ id: "s1", condition_id: "c1", computed: { area_sf: 50.003 } }),
      shape({ id: "s2", condition_id: "c2", computed: { area_sf: 80.007 } }),
    ],
  );
  const b = takeoff(
    [cond({ id: "c1" }), cond({ id: "c2" })],
    [
      shape({ id: "s1", condition_id: "c1", computed: { area_sf: 50.060 } }),
      shape({ id: "s2", condition_id: "c2", computed: { area_sf: 80.007 } }),
    ],
  );
  const d = diffTakeoffs(a, b, "metric");
  // c1 raw delta ≈ 0.057, c2 raw delta = 0
  const c1Raw = d.conditions[0]._rawDeltas.floor_sf;
  const c2Raw = d.conditions[1]._rawDeltas.floor_sf;
  assert.ok(Math.abs(c1Raw - 0.057) < 1e-10, `c1 raw ~0.057, got ${c1Raw}`);
  assert.equal(c2Raw, 0, "c2 raw = 0");
  // totals raw = sum of condition raw deltas
  const totRaw = d.totals._rawDeltas.total_sf;
  assert.ok(Math.abs(totRaw - c1Raw) < 1e-10,
    `totals raw = sum of conditions: ${totRaw} vs ${c1Raw}`);
  // totals rounded = round2(sum of raw)
  assert.equal(d.totals.deltas.total_sf, round2(c1Raw),
    "totals rounded matches round2 of sum");
});
