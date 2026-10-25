import { test } from "node:test";
import assert from "node:assert/strict";
import { conditionTotals } from "../src/lib/totals.js";
import { priceEstimate } from "../src/lib/estimate.js";
import { estimateWorkbook, estimateFileName } from "../src/lib/estimateExport.js";
import { OT_WATERMARK } from "../src/lib/branding.js";

const area = (id: string, sf: number) => ({ condition_id: id, measure_role: "floor_area", computed: { area_sf: sf } });
const est = (conditions: any[], shapes: any[], settings: any = null) =>
  priceEstimate({ rows: conditionTotals(conditions, shapes), conditions, settings });
const find = (rows: any[][], label: string) => rows.find((r) => r[0] === label);

test("Estimate tab: one row per priced line, summary matches the engine, watermark last", () => {
  const conds = [{ id: "a", finish_tag: "LVT-1", waste_pct: 10, pricing: { unit: "SF", material: 2, labor: 1 } }];
  const e = est(conds, [area("a", 100)], { tax_pct: 5, overhead_pct: 10, profit_pct: 20 });
  const [sheet] = estimateWorkbook({ est: e, projectName: "Demo", companyName: "Sample Co", clientName: "GC", date: "Oct 24" });
  assert.equal(sheet.name, "Estimate");
  assert.deepEqual(sheet.rows[0], ["Estimate", "Demo"]);
  assert.deepEqual(find(sheet.rows, "Prepared by"), ["Prepared by", "Sample Co"]);
  assert.deepEqual(find(sheet.rows, "LVT-1"), ["LVT-1", "priced", "SF", 110, 2, 220, 100, 1, 100, 0, 320]);
  assert.deepEqual(find(sheet.rows, "Base bid"), ["Base bid", e.total]);
  assert.deepEqual(find(sheet.rows, "Material"), ["Material", 220]);
  assert.deepEqual(sheet.rows[sheet.rows.length - 1], [OT_WATERMARK]);
});

test("an un-entered rate is an empty cell, never 0, and an Unpriced tab lists what is missing", () => {
  const conds = [{ id: "a", finish_tag: "CPT-1", pricing: { material: 3 } }];
  const sheets = estimateWorkbook({ est: est(conds, [area("a", 90)]) });
  const line = find(sheets[0].rows, "CPT-1")!;
  assert.equal(line[1], "partly priced");
  assert.equal(line[7], "");        // labor $/unit
  assert.equal(line[8], 0);         // labor $ counts as 0 in the total
  assert.ok(sheets[0].rows.some((r) => typeof r[0] === "string" && r[0].startsWith("Not fully priced: 1 condition")));
  assert.deepEqual(sheets.map((s) => s.name), ["Estimate", "Materials", "Unpriced"]);
  assert.deepEqual(find(sheets[2].rows, "CPT-1"), ["CPT-1", "partly priced", "labor"]);
});

test("fully priced: no Unpriced tab; material rows carry qty, price and cost", () => {
  const conds = [{
    id: "a", finish_tag: "CT-1", pricing: { material: 0, labor: 0 },
    materials: [{ id: "m", name: "Thinset", per: 95, basis: "area", unit: "bag", price: 10 }],
  }];
  const sheets = estimateWorkbook({ est: est(conds, [area("a", 234)]) });
  assert.deepEqual(sheets.map((s) => s.name), ["Estimate", "Materials"]);
  assert.deepEqual(find(sheets[1].rows, "CT-1"), ["CT-1", "Thinset", 3, "bag", 10, 30, "priced"]);
});

test("margin and an impossible margin are labeled; the warning rides the summary", () => {
  const conds = [{ id: "a", finish_tag: "A", pricing: { material: 1, labor: 1 } }];
  const rows = estimateWorkbook({ est: est(conds, [area("a", 10)], { profit_pct: 100, profit_mode: "margin" }) })[0].rows;
  assert.ok(rows.some((r) => r[0] === "Profit (100% margin of price)"));
  assert.ok(rows.some((r) => typeof r[0] === "string" && r[0].includes("must be under 100%")));
});

test("file name: project name, unsafe characters dropped, OpenTakeoff fallback", () => {
  assert.equal(estimateFileName("Clinic: Phase 2"), "Clinic Phase 2 - estimate.xlsx");
  assert.equal(estimateFileName(""), "OpenTakeoff - estimate.xlsx");
});
