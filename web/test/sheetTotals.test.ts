// Per-sheet subtotals (PR-1): sheetTotals() and the additive by-sheet section
// of totalsToCsv(). The invariants under test:
//   - sheet rows carry BASE (unmultiplied) UNROUNDED quantities, so
//     round2(Σ sheets × multiplier) reconciles exactly with the conditionTotals
//     row — no compounded per-sheet rounding;
//   - ordering is first-appearance for sheets, `conditions` order within;
//   - shapeless sheets/conditions never appear; deducts can go negative;
//   - totalsToCsv without bySheet is byte-identical to the pre-change output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// totals.js is plain JS (allowJs); the tsx loader resolves it from the .ts test.
import { conditionTotals, round2, sheetTotals, totalsToCsv } from "../src/lib/totals.js";
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

test("sheets order by first appearance; shapeless sheets and conditions don't appear", () => {
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
  assert.deepEqual(groups.map((g) => g.sheet_id), ["sheet2", "sheet1"]);
  // rows follow `conditions` order (a before b) even though b was drawn first
  assert.deepEqual(groups[0].rows.map((r: any) => r.id), ["a", "b"]);
  assert.deepEqual(groups[1].rows.map((r: any) => r.id), ["a"]);   // no b, no empty
  for (const g of groups) assert.ok(!g.rows.some((r: any) => r.id === "empty"));
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
  const golden = readFileSync(new URL("./fixtures/report.golden.csv", import.meta.url), "utf8");
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

test("by-sheet CSV: no footnote when every emitted row is ×1", () => {
  const conds = [{ id: "c", finish_tag: "CT-1" }];
  const shapes = [shape("c", "plan.pdf", "floor_area", { area_sf: 10 })];
  const rows = conditionTotals(conds, shapes);
  const csv = totalsToCsv(rows, "", sheetTotals(conds, shapes), (id: string) => "A101");
  assert.ok(csv.includes("\nA101,plan.pdf,CT-1,10,0,0,0,0\n"));
  assert.ok(!csv.includes("# By-sheet"));
});
