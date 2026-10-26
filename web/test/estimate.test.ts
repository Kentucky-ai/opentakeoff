import { test } from "node:test";
import assert from "node:assert/strict";
// estimate.js / totals.js are plain JS (allowJs); the tsx loader resolves them from the .ts test.
import { conditionTotals } from "../src/lib/totals.js";
import { priceEstimate, sanitizePricing, sanitizeEstimateSettings, defaultPriceUnit, priceValue } from "../src/lib/estimate.js";
import { instantiateTemplate, conditionToTemplate } from "../src/lib/canvasUtil.js";

const area = (id: string, sf: number) => ({ condition_id: id, measure_role: "floor_area", computed: { area_sf: sf } });
const lin = (id: string, lf: number) => ({ condition_id: id, measure_role: "linear", computed: { perimeter_lf: lf } });
const cnt = (id: string) => ({ condition_id: id, measure_role: "count", computed: { count: 1 } });

const price = (conditions: any[], shapes: any[], settings: any = null) =>
  priceEstimate({ rows: conditionTotals(conditions, shapes), conditions, settings });

test("material prices the waste-adjusted order quantity, labor the measured quantity", () => {
  const conds = [{ id: "lvt", finish_tag: "LVT-1", waste_pct: 10, pricing: { unit: "SF", material: 2, labor: 1 } }];
  const est = price(conds, [area("lvt", 1000)]);
  const [l] = est.lines;
  assert.equal(l.material_qty, 1100);
  assert.equal(l.labor_qty, 1000);
  assert.equal(l.material_cost, 2200);
  assert.equal(l.labor_cost, 1000);
  assert.equal(l.total, 3200);
  assert.equal(l.status, "priced");
  assert.equal(est.total, 3200);
  assert.equal(est.complete, true);
});

test("SY prices sy_net for material and measured SF ÷ 9 for labor", () => {
  const conds = [{ id: "cpt", finish_tag: "CPT-1", waste_pct: 8, pricing: { unit: "SY", material: 20, labor: 5 } }];
  const [l] = price(conds, [area("cpt", 900)]).lines;
  assert.equal(l.material_qty, 108);   // 900 × 1.08 ÷ 9
  assert.equal(l.labor_qty, 100);      // 900 ÷ 9, no waste
  assert.equal(l.material_cost, 2160);
  assert.equal(l.labor_cost, 500);
});

test("LF and EA units; EA never carries waste", () => {
  const conds = [
    { id: "b", finish_tag: "RB-1", waste_pct: 5, pricing: { unit: "LF", material: 1, labor: 1 } },
    { id: "t", finish_tag: "TH-1", waste_pct: 50, pricing: { unit: "EA", material: 10, labor: 10 } },
  ];
  const est = price(conds, [lin("b", 200), cnt("t"), cnt("t")]);
  const b: any = est.lines.find((l: any) => l.id === "b");
  const t: any = est.lines.find((l: any) => l.id === "t");
  assert.deepEqual([b.material_qty, b.labor_qty], [210, 200]);
  assert.deepEqual([t.material_qty, t.labor_qty], [2, 2]);
  assert.equal(t.total, 40);
});

test("an un-entered price is missing, never $0; an entered 0 is priced", () => {
  const conds = [
    { id: "a", finish_tag: "A", pricing: { material: 1 } },                // labor never entered
    { id: "b", finish_tag: "B" },                                          // nothing entered
    { id: "c", finish_tag: "C", pricing: { material: 0, labor: 3 } },      // owner-furnished: material $0 on purpose
  ];
  const est = price(conds, [area("a", 100), area("b", 100), area("c", 100)]);
  const by = Object.fromEntries(est.lines.map((l: any) => [l.id, l]));
  assert.equal(by.a.status, "partial");
  assert.deepEqual(by.a.missing, ["labor"]);
  assert.equal(by.b.status, "unpriced");
  assert.deepEqual(by.b.missing, ["material", "labor"]);
  assert.equal(by.c.status, "priced");
  assert.equal(by.c.total, 300);
  assert.equal(est.complete, false);
  assert.deepEqual(est.unpriced.map((u: any) => u.finish_tag), ["A", "B"]);
});

test("material rows: whole packages × price; an unpriced row with quantity is missing", () => {
  const conds = [{
    id: "ct", finish_tag: "CT-1", pricing: { material: 0, labor: 0 },
    materials: [
      { id: "m1", name: "Thinset", per: 95, basis: "area", unit: "bag", price: 10 },
      { id: "m0", name: "", per: 1 },   // unnamed: conditionTotals drops it, and the alignment must survive
      { id: "m2", name: "Grout", per: 120, basis: "area", unit: "bag" },
    ],
  }];
  const [l] = price(conds, [area("ct", 234)]).lines;
  assert.deepEqual(l.materials.map((m: any) => [m.name, m.qty, m.price, m.cost]), [["Thinset", 3, 10, 30], ["Grout", 2, null, 0]]);
  assert.equal(l.materials_cost, 30);
  assert.equal(l.total, 30);
  assert.equal(l.status, "partial");
  assert.deepEqual(l.missing, ["material row: Grout"]);
});

test("markups: tax on material, overhead on cost, profit as markup", () => {
  const conds = [{ id: "a", finish_tag: "A", pricing: { material: 6, labor: 4 } }];
  const est = price(conds, [area("a", 100)], { tax_pct: 6, overhead_pct: 10, profit_pct: 20 });
  assert.equal(est.material, 600);
  assert.equal(est.labor, 400);
  assert.equal(est.tax, 36);
  assert.equal(est.cost, 1036);
  assert.equal(est.overhead, 103.6);
  assert.equal(est.profit, 227.92);   // (1036 + 103.6) × 0.20
  assert.equal(est.total, 1367.52);
});

test("profit as margin: 33.33…% margin is ×1.5", () => {
  const conds = [{ id: "a", finish_tag: "A", pricing: { material: 0, labor: 10 } }];
  const est = price(conds, [area("a", 100)], { profit_pct: 100 / 3, profit_mode: "margin" });
  assert.equal(est.total, 1500);
  assert.equal(est.profit, 500);
});

test("a margin of 100% or more is refused with a warning, not a division by zero", () => {
  const conds = [{ id: "a", finish_tag: "A", pricing: { material: 1, labor: 1 } }];
  const est = price(conds, [area("a", 100)], { profit_pct: 100, profit_mode: "margin" });
  assert.equal(est.profit, 0);
  assert.equal(est.total, 200);
  assert.equal(est.warnings.length, 1);
});

test("conditions with no shapes are not estimate lines", () => {
  const conds = [{ id: "a", finish_tag: "A", pricing: { material: 1, labor: 1 } }, { id: "z", finish_tag: "Z" }];
  const est = price(conds, [area("a", 10)]);
  assert.deepEqual(est.lines.map((l: any) => l.id), ["a"]);
  assert.equal(est.complete, true);
});

test("multiplier flows through to priced quantities", () => {
  const conds = [{ id: "a", finish_tag: "A", multiplier: 3, pricing: { material: 1, labor: 1 } }];
  const [l] = price(conds, [area("a", 100)]).lines;
  assert.deepEqual([l.material_qty, l.labor_qty, l.total], [300, 300, 600]);
});

test("default unit follows what was measured", () => {
  assert.equal(defaultPriceUnit({ total_sf: 5, lf: 9, ea: 1 }), "SF");
  assert.equal(defaultPriceUnit({ total_sf: 0, lf: 9 }), "LF");
  assert.equal(defaultPriceUnit({ ea: 2 }), "EA");
  assert.equal(defaultPriceUnit({}), "SF");
});

test("sanitizers: bad prices and settings are dropped, never coerced to a price", () => {
  assert.equal(priceValue(""), null);
  assert.equal(priceValue(null), null);
  assert.equal(priceValue(-1), null);
  assert.equal(priceValue("abc"), null);
  assert.equal(priceValue(true), null);
  assert.equal(priceValue("2.5"), 2.5);
  assert.equal(priceValue(0), 0);
  assert.deepEqual(sanitizePricing({ unit: "M2", material: "x", labor: 2, extra: 1 }), { labor: 2 });
  assert.equal(sanitizePricing({ unit: "bad" }), undefined);
  assert.equal(sanitizePricing([1]), undefined);
  assert.deepEqual(sanitizeEstimateSettings({ tax_pct: -5, overhead_pct: "12", profit_pct: NaN, profit_mode: "x" }),
    { tax_pct: 0, overhead_pct: 12, profit_pct: 0, profit_mode: "markup" });
});

test("a template never carries a material price into a new project", () => {
  const c = instantiateTemplate({ finish_tag: "CT-1", materials: [{ name: "Thinset", per: 95, unit: "bag", price: 10 }] });
  assert.equal(c.materials.length, 1);
  assert.equal("price" in c.materials[0], false);
  assert.equal(c.materials[0].name, "Thinset");
});

test("saving a condition as a template drops its pricing and every material price", () => {
  const t: any = conditionToTemplate({
    id: "c1", finish_tag: "CT-1", color: "#123456", waste_pct: 10, pricing: { unit: "SF", material: 4, labor: 3 },
    materials: [{ id: "m1", name: "Thinset", per: 95, unit: "bag", price: 10, grout: { w: 1 } }],
  });
  assert.equal("pricing" in t, false);
  assert.deepEqual(t.materials, [{ name: "Thinset", per: 95, unit: "bag", grout: { w: 1 } }]);
  assert.equal(t.waste_pct, 10);
});
