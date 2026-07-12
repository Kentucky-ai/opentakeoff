// Revision compare — the quantity-level diff. Payloads use the autosave shape
// ({ conditions, shapes }); every case runs through the same conditionTotals
// math the report uses, so these tests pin the compare to report semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffTakeoffs, diffToCsv, revSheetLabel } from "../src/lib/revisions.js";

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
});

test("metric CSV converts areas and lengths", () => {
  const d = diffTakeoffs(takeoff([cond()], []), takeoff([cond()], [shape()]));
  const csv = diffToCsv(d, { units: "metric" });
  assert.match(csv, /d Floor m2/);
  assert.match(csv, /9\.29/);
});
