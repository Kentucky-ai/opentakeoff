// Per-sheet subtotals (PR-1): sheetTotals() and the additive by-sheet section
// of totalsToCsv(). The invariants under test:
//   - sheet rows carry BASE (unmultiplied) UNROUNDED quantities, so
//     round2(Σ sheets × multiplier) reconciles exactly with the conditionTotals
//     row — no compounded per-sheet rounding;
//   - sheets order by file name then page (exportMarkedSet's sort — never
//     draw order), `conditions` order within;
//   - shapeless sheets/conditions never appear; deducts can go negative;
//   - totalsToCsv without bySheet is byte-identical to the pre-change output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// totals.js is plain JS (allowJs); the tsx loader resolves it from the .ts test.
import { conditionTotals, round2, sheetTotals, sheetGroupedRows, totalsToCsv, hasMultipliers, BY_SHEET_BASE_NOTE } from "../src/lib/totals.js";
import { conditions as goldenConditions, shapes as goldenShapes, projectName as goldenName } from "./fixtures/report.fixture.ts";

const shape = (condition_id: string, sheet_id: string, measure_role: string, computed: any) =>
  ({ condition_id, sheet_id, measure_role, computed });

// ── sheetTotals ──────────────────────────────────────────────────────────────

test("per-sheet base × multiplier reconciles with the conditionTotals row (unrounded accumulation)", () => {
  // 10.004 rounds to 10 on its own; if sheetTotals pre-rounded per sheet, the
  // reconciliation below would come out 40 instead of 40.02.
  const conds = [{ id: "c", finish_tag: "LVT-2", multiplier: 2 }];
  const shapes = [
    shape("c", "s1", "floor_area", { area_sf: 10.004 }),
    shape("c", "s2", "floor_area", { area_sf: 10.004 }),
  ];
  const groups = sheetTotals(conds, shapes);
  assert.equal(groups.length, 2);
  for (const g of groups) {
    assert.equal(g.rows[0].floor_sf, 10.004);      // base: multiplier NOT applied
    assert.equal(g.rows[0].multiplier, 2);         // ...but carried for footnoting
  }
  const [condRow] = conditionTotals(conds, shapes);
  const sheetSum = groups.reduce((n, g) => n + g.rows[0].floor_sf * g.rows[0].multiplier, 0);
  assert.equal(round2(sheetSum), condRow.floor_sf); // 40.02, not 40
});

test("a deduct alone on a sheet yields a negative floor_sf — never clamped", () => {
  const conds = [{ id: "c", finish_tag: "CT-1" }];
  const shapes = [
    shape("c", "plan", "floor_area", { area_sf: 100 }),
    shape("c", "detail", "deduct", { area_sf: 25.5 }),   // pasted onto another sheet
  ];
  const groups = sheetTotals(conds, shapes);
  const detail = groups.find((g) => g.sheet_id === "detail")!;
  assert.equal(detail.rows[0].floor_sf, -25.5);
  // and the two sheets still reconcile to the condition total
  assert.equal(round2(100 - 25.5), conditionTotals(conds, shapes)[0].floor_sf);
});

test("sheets order by file then page — not draw order; shapeless sheets and conditions don't appear", () => {
  const conds = [
    { id: "a", finish_tag: "A" },
    { id: "b", finish_tag: "B" },
    { id: "empty", finish_tag: "ZZ" },   // no shapes anywhere
  ];
  const shapes = [
    shape("b", "sheet2", "floor_area", { area_sf: 1 }),  // sheet2 seen first
    shape("a", "sheet1", "floor_area", { area_sf: 2 }),
    shape("a", "sheet2", "floor_area", { area_sf: 3 }),
  ];
  const groups = sheetTotals(conds, shapes);
  // sheet2 was DRAWN first, but sheet1 sorts first: file/page order — the
  // same sort exportMarkedSet applies — so report/CSV/JSON always agree with
  // the Marked Set PDF
  assert.deepEqual(groups.map((g) => g.sheet_id), ["sheet1", "sheet2"]);
  // rows follow `conditions` order (a before b) even though b was drawn first
  assert.deepEqual(groups[0].rows.map((r: any) => r.id), ["a"]);        // no b, no empty
  assert.deepEqual(groups[1].rows.map((r: any) => r.id), ["a", "b"]);
  for (const g of groups) assert.ok(!g.rows.some((r: any) => r.id === "empty"));
});

test("a later-drawn earlier-file sheet sorts first; pages compare numerically", () => {
  const conds = [{ id: "c", finish_tag: "CT-1" }];
  const shapes = [
    shape("c", "b-plans.pdf#2", "floor_area", { area_sf: 1 }),   // drawn first
    shape("c", "a-plans.pdf", "floor_area", { area_sf: 2 }),     // earlier file, drawn later
    shape("c", "b-plans.pdf#10", "floor_area", { area_sf: 3 }),  // page 10 AFTER 2 (numeric, not lexicographic)
  ];
  const groups = sheetTotals(conds, shapes);
  assert.deepEqual(groups.map((g) => g.sheet_id), ["a-plans.pdf", "b-plans.pdf#2", "b-plans.pdf#10"]);
  // delete-and-redraw (a fresh draw order) yields the identical ordering
  const redrawn = sheetTotals(conds, [...shapes].reverse());
  assert.deepEqual(redrawn.map((g) => g.sheet_id), groups.map((g) => g.sheet_id));
});

test("linear shapes contribute LF and border SF to the sheet row", () => {
  const conds = [{ id: "rb", finish_tag: "RB-1", thickness_in: 4 }];
  const shapes = [shape("rb", "plan", "linear", { perimeter_lf: 88.25, area_sf: 29.42 })];
  const [{ rows: [row] }] = sheetTotals(conds, shapes);
  assert.equal(row.lf, 88.25);
  assert.equal(row.border_sf, 29.42);
  assert.equal(row.floor_sf, 0);
  assert.equal(row.shape_count, 1);
});

// ── sheetGroupedRows: ORDERED quantities per sheet (report group-by-sheet) ──
// The counterpart invariants to sheetTotals: full conditionTotals math per
// sheet's shapes (waste + ×N applied per slice), same canonical sheet order,
// per-group perimByCond, orphan/shapeless sheets dropped.

test("sheetGroupedRows: sheets order by file then numeric page — not draw order", () => {
  const conds = [{ id: "c", finish_tag: "CT-1" }];
  const shapes = [
    shape("c", "b-plans.pdf#2", "floor_area", { area_sf: 1 }),   // drawn first
    shape("c", "a-plans.pdf", "floor_area", { area_sf: 2 }),     // earlier file, drawn later
    shape("c", "b-plans.pdf#10", "floor_area", { area_sf: 3 }),  // page 10 AFTER 2 (numeric)
  ];
  const groups = sheetGroupedRows(conds, shapes);
  assert.deepEqual(groups.map((g) => g.sheet_id), ["a-plans.pdf", "b-plans.pdf#2", "b-plans.pdf#10"]);
});

test("sheetGroupedRows: slices carry ORDERED quantities — waste % and ×N applied per sheet", () => {
  const conds = [{ id: "c", finish_tag: "LVT-2", multiplier: 2, waste_pct: 10 }];
  const shapes = [
    shape("c", "s1", "floor_area", { area_sf: 10 }),
    shape("c", "s2", "floor_area", { area_sf: 20 }),
  ];
  const [g1, g2] = sheetGroupedRows(conds, shapes);
  assert.equal(g1.rows[0].floor_sf, 20);           // 10 × 2 — multiplier applied, unlike sheetTotals
  assert.equal(g1.rows[0].total_sf_net, 22);       // × 1.1 waste on top
  assert.equal(g2.rows[0].floor_sf, 40);
  assert.equal(g2.rows[0].total_sf_net, 44);
});

test("sheetGroupedRows: slices sum to the conditionTotals row within display-rounding drift", () => {
  // 10.004 → per-slice round2 can drift the visible sum by cents from the
  // condition row (each slice rounds independently) — the accepted by-sheet
  // behavior; the underlying math is linear, so pre-rounding they're equal
  const conds = [{ id: "c", finish_tag: "LVT-2", multiplier: 3, waste_pct: 7 }];
  const shapes = [
    shape("c", "s1", "floor_area", { area_sf: 10.004 }),
    shape("c", "s2", "floor_area", { area_sf: 5.503 }),
    shape("c", "s3", "linear", { perimeter_lf: 12.007, area_sf: 4.002 }),
  ];
  const groups = sheetGroupedRows(conds, shapes);
  const [condRow] = conditionTotals(conds, shapes);
  for (const key of ["total_sf", "total_sf_net", "lf", "lf_net", "sy_net"] as const) {
    const sliceSum = groups.reduce((n, g) => n + g.rows[0][key], 0);
    assert.ok(Math.abs(sliceSum - condRow[key]) < 0.02, `${key}: ${sliceSum} vs ${condRow[key]}`);
  }
});

test("sheetGroupedRows: a condition traced on two sheets appears in both groups", () => {
  const conds = [{ id: "c", finish_tag: "CT-1" }, { id: "d", finish_tag: "RB-1" }];
  const shapes = [
    shape("c", "s1", "floor_area", { area_sf: 1 }),
    shape("c", "s2", "floor_area", { area_sf: 2 }),
    shape("d", "s2", "floor_area", { area_sf: 3 }),
  ];
  const groups = sheetGroupedRows(conds, shapes);
  assert.deepEqual(groups.map((g) => g.rows.map((r: any) => r.id)), [["c"], ["c", "d"]]);
});

test("sheetGroupedRows: orphan-only sheets dropped; shapeless sheets never appear", () => {
  const conds = [{ id: "c", finish_tag: "CT-1" }];
  const shapes = [
    shape("c", "plan", "floor_area", { area_sf: 10 }),
    shape("ghost", "detail", "floor_area", { area_sf: 5 }),   // dead condition_id → all-orphan sheet
  ];
  const groups = sheetGroupedRows(conds, shapes);
  assert.deepEqual(groups.map((g) => g.sheet_id), ["plan"]);
  assert.deepEqual(sheetGroupedRows(conds, []), []);
});

test("sheetGroupedRows: perimByCond is per-sheet — a floor trace on one sheet never leaks into another's map", () => {
  const conds = [{ id: "c", finish_tag: "CT-1" }, { id: "d", finish_tag: "LVT-2" }];
  const shapes = [
    shape("c", "s1", "floor_area", { area_sf: 100, perimeter_lf: 40 }),
    shape("c", "s2", "floor_area", { area_sf: 25, perimeter_lf: 10 }),
    shape("d", "s2", "floor_area", { area_sf: 9, perimeter_lf: 12 }),
  ];
  const [g1, g2] = sheetGroupedRows(conds, shapes);
  assert.equal(g1.perimByCond.get("c"), 40);
  assert.equal(g1.perimByCond.has("d"), false);   // d has no shapes on s1
  assert.equal(g2.perimByCond.get("c"), 10);      // s2's slice only, not 50
  assert.equal(g2.perimByCond.get("d"), 12);
});

// ── totalsToCsv: additive extension ─────────────────────────────────────────

test("bySheet null/empty keeps totalsToCsv byte-identical to the pre-change output", () => {
  const rows = conditionTotals(goldenConditions, goldenShapes).filter((r: any) => r.shape_count > 0);
  const base = totalsToCsv(rows, goldenName);
  assert.equal(totalsToCsv(rows, goldenName, null), base);
  assert.equal(totalsToCsv(rows, goldenName, []), base);
  assert.ok(!base.includes("Sheet,Sheet ID"));                       // no by-sheet header
  assert.equal(base.split("\n").length, 21);                         // 20 lines + trailing \n
  // and the (now-extended) golden file starts with exactly this output — the
  // by-sheet section was a pure append.
  const golden = readFileSync(new URL("./fixtures/report.golden.csv", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.ok(golden.startsWith(base));
});

test("by-sheet CSV: label fallback to raw id, ×N finish mark, and the x-multiplier footnote", () => {
  const conds = [{ id: "c", finish_tag: "LVT-2", multiplier: 3 }];
  const shapes = [shape("c", "plan.pdf", "floor_area", { area_sf: 10.005 })];
  const rows = conditionTotals(conds, shapes);
  const csv = totalsToCsv(rows, "", sheetTotals(conds, shapes), null);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines.at(-3), "Sheet,Sheet ID,Finish,Floor SF,Wall SF,Border SF,LF,EA");
  assert.equal(lines.at(-2), "plan.pdf,plan.pdf,LVT-2 ×3,10.01,0,0,0,0");  // raw-id label, round2 at serialization
  assert.equal(lines.at(-1), "# By-sheet rows show measured (base) quantities; xN multipliers apply at condition level");
});

test("BY_SHEET_BASE_NOTE is the golden literal; hasMultipliers gates it", () => {
  // the CSV golden embeds "# " + this exact sentence — constant and golden
  // must never drift apart
  assert.equal(BY_SHEET_BASE_NOTE,
    "By-sheet rows show measured (base) quantities; xN multipliers apply at condition level");
  const conds = [{ id: "c", finish_tag: "LVT-2", multiplier: 3 }, { id: "d", finish_tag: "CT-1" }];
  const shapes = [
    shape("c", "plan.pdf", "floor_area", { area_sf: 10 }),
    shape("d", "plan.pdf", "floor_area", { area_sf: 5 }),
  ];
  assert.equal(hasMultipliers(sheetTotals(conds, shapes)), true);
  assert.equal(hasMultipliers(sheetTotals([conds[1]], [shapes[1]])), false);
  assert.equal(hasMultipliers([]), false);
  assert.equal(hasMultipliers(null), false);
});

test("by-sheet CSV: no footnote when every emitted row is ×1", () => {
  const conds = [{ id: "c", finish_tag: "CT-1" }];
  const shapes = [shape("c", "plan.pdf", "floor_area", { area_sf: 10 })];
  const rows = conditionTotals(conds, shapes);
  const csv = totalsToCsv(rows, "", sheetTotals(conds, shapes), (id: string) => "A101");
  assert.ok(csv.includes("\nA101,plan.pdf,CT-1,10,0,0,0,0\n"));
  assert.ok(!csv.includes("# By-sheet"));
});
