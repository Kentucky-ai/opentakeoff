import { test } from "node:test";
import assert from "node:assert/strict";
// totals.js is plain JS (allowJs); the tsx loader resolves it from the .ts test.
import { conditionTotals, materialsSummary } from "../src/lib/totals.js";

const area = (id: string, sf: number) => ({ condition_id: id, measure_role: "floor_area", computed: { area_sf: sf } });
const lin = (id: string, lf: number) => ({ condition_id: id, measure_role: "linear", computed: { perimeter_lf: lf } });

test("materials: order qty = area ÷ coverage, rounded up to whole units", () => {
  const conds = [{
    id: "ct", finish_tag: "CT-1",
    materials: [
      { id: "m1", name: "Thinset", per: 95, basis: "area", unit: "bag", round: true },
      { id: "m2", name: "Grout", per: 120, basis: "area", unit: "bag", round: true },
    ],
  }];
  const [row] = conditionTotals(conds, [area("ct", 234)]);
  const byName = Object.fromEntries(row.materials.map((m: any) => [m.name, m.qty]));
  assert.equal(byName.Thinset, 3); // ceil(234/95) = ceil(2.46)
  assert.equal(byName.Grout, 2);   // ceil(234/120) = ceil(1.95)
});

test("materials: round:false keeps the fractional quantity", () => {
  const conds = [{ id: "lvt", finish_tag: "LVT-1", materials: [{ id: "m", name: "Adhesive", per: 250, basis: "area", unit: "gal", round: false }] }];
  const [row] = conditionTotals(conds, [area("lvt", 600)]);
  assert.equal(row.materials[0].qty, 2.4); // 600/250, not rounded
});

test("materials: multiplier scales the basis before dividing", () => {
  const conds = [{ id: "ct", finish_tag: "CT-1", multiplier: 2, materials: [{ id: "m", name: "Thinset", per: 95, basis: "area", unit: "bag", round: true }] }];
  const [row] = conditionTotals(conds, [area("ct", 234)]); // 234 × 2 = 468
  assert.equal(row.materials[0].qty, 5); // ceil(468/95) = ceil(4.92)
});

test("materials: linear basis uses measured LF, not area", () => {
  const conds = [{ id: "rb", finish_tag: "RB-1", materials: [{ id: "m", name: "Cove base adhesive", per: 40, basis: "linear", unit: "tube", round: true }] }];
  const [row] = conditionTotals(conds, [lin("rb", 130)]);
  assert.equal(row.materials[0].qty, 4); // ceil(130/40) = ceil(3.25)
});

test("materials: note (trowel / coats) passes through to the row", () => {
  const conds = [{
    id: "wd", finish_tag: "WD-1",
    materials: [{ id: "m", name: "Adhesive (Berger-Seidle)", per: 55, basis: "area", unit: "gal", round: true, note: "3/16″ V-notch" }],
  }];
  const [row] = conditionTotals(conds, [area("wd", 110)]);
  assert.equal(row.materials[0].note, "3/16″ V-notch");
  assert.equal(row.materials[0].qty, 2); // ceil(110/55)
});

test("materialsSummary: same-named materials sum across conditions", () => {
  const conds = [
    { id: "a", finish_tag: "CT-1", materials: [{ id: "1", name: "Grout", per: 120, basis: "area", unit: "bag", round: true }] },
    { id: "b", finish_tag: "CT-2", materials: [{ id: "2", name: "Grout", per: 120, basis: "area", unit: "bag", round: true }] },
  ];
  const rows = conditionTotals(conds, [area("a", 234), area("b", 100)]);
  const summary = materialsSummary(rows);
  const grout = summary.find((s: any) => s.name === "Grout");
  assert.equal(grout.qty, 3); // 2 (CT-1) + 1 (CT-2)
});
