// liveCounter.js — the pure half of the floating live counter: row shaping
// over conditionTotals() output, quantity formatting, and the viewport clamp
// for the persisted position. Storage helpers are try/catch wrappers around
// localStorage and are exercised live, not here (node 24 has no localStorage).
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { counterRows, fmtQty, clampPos } from "../src/lib/liveCounter.js";
import { conditionTotals } from "../src/lib/totals.js";

// Rows come from the ONE quantity computer — build them the real way rather
// than hand-rolling total rows a schema drift would silently invalidate.
const conds = [
  { id: "c1", finish_tag: "CPT-1", color: "#a33", multiplier: 1, waste_pct: 8 },
  { id: "c2", finish_tag: "RB-1", color: "#3a3", multiplier: 1 },
  { id: "c3", finish_tag: "GRD", color: "#33a", multiplier: 1 },
  { id: "c4", finish_tag: "empty", color: "#999", multiplier: 1 },
];
const shapes = [
  { id: "s1", sheet_id: "p#1", condition_id: "c1", measure_role: "floor_area", computed: { area_sf: 1200.5 } },
  { id: "s2", sheet_id: "p#1", condition_id: "c1", measure_role: "deduct", computed: { area_sf: 200.5 } },
  { id: "s3", sheet_id: "p#1", condition_id: "c2", measure_role: "linear", computed: { perimeter_lf: 84.25 } },
  { id: "s4", sheet_id: "p#1", condition_id: "c3", measure_role: "count", computed: { count: 1 } },
  { id: "s5", sheet_id: "p#1", condition_id: "c3", measure_role: "count", computed: { count: 1 } },
];
const rows = counterRows(conditionTotals(conds, shapes), "c2");

test("counterRows: only conditions carrying shapes appear", () => {
  assert.deepEqual(rows.map((r: any) => r.id), ["c1", "c2", "c3"]);
});

test("counterRows: measured quantities, not order quantities (no waste)", () => {
  const c1 = rows.find((r: any) => r.id === "c1")!;
  assert.deepEqual(c1.qtys, [{ qty: 1000, unit: "SF" }]); // 1200.5 − 200.5, waste_pct ignored
});

test("counterRows: LF and EA roles land under their units", () => {
  assert.deepEqual(rows.find((r: any) => r.id === "c2")!.qtys, [{ qty: 84.25, unit: "LF" }]);
  assert.deepEqual(rows.find((r: any) => r.id === "c3")!.qtys, [{ qty: 2, unit: "EA" }]);
});

test("counterRows: the active flag follows the id", () => {
  assert.deepEqual(rows.map((r: any) => r.active), [false, true, false]);
});

// ── fmtQty ──────────────────────────────────────────────────────────────────
test("fmtQty: thousands separators, ≤2 decimals, trailing zeros trimmed", () => {
  assert.equal(fmtQty(1234.5), "1,234.5");
  assert.equal(fmtQty(1000), "1,000");
  assert.equal(fmtQty(84.256), "84.26");
  assert.equal(fmtQty(undefined), "0");
});

// ── clampPos ────────────────────────────────────────────────────────────────
test("clampPos: an off-screen saved position comes back reachable", () => {
  const p = clampPos({ x: 5000, y: -300 }, { w: 220, h: 160 }, 1440, 900);
  assert.ok(p.x <= 1400 && p.y >= 8);
});

test("clampPos: a sane position passes through untouched", () => {
  assert.deepEqual(clampPos({ x: 300, y: 200 }, { w: 220, h: 160 }, 1440, 900), { x: 300, y: 200 });
});
