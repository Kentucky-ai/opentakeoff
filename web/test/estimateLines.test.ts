// One estimate line per quantity kind a condition carries, plus its assembly
// items (lib/estimate.js, lib/totals.js). The bug this pins: a condition with a
// rectangle (SF), a line (LF) and two counts (EA) showed all three in the
// Report, but the Estimate priced only the SF.
import { test } from "node:test";
import assert from "node:assert/strict";
import { conditionTotals, coverageLabel } from "../src/lib/totals.js";
import { priceEstimate, sanitizePricing, lineUnits, lineLabel } from "../src/lib/estimate.js";
import { estimateWorkbook } from "../src/lib/estimateExport.js";
import { buildBidProposal } from "../src/lib/bidProposal.js";
import { conditionToTemplate, instantiateTemplate } from "../src/lib/canvasUtil.js";

const area = (id: string, sf: number) => ({ condition_id: id, measure_role: "floor_area", computed: { area_sf: sf } });
const lin = (id: string, lf: number, sf = 0) => ({ condition_id: id, measure_role: "linear", computed: { perimeter_lf: lf, ...(sf ? { area_sf: sf } : {}) } });
const cnt = (id: string) => ({ condition_id: id, measure_role: "count", computed: { count: 1 } });
const price = (conditions: any[], shapes: any[], settings: any = null) =>
  priceEstimate({ rows: conditionTotals(conditions, shapes), conditions, settings });

// CPT-1: a 900 SF room, a 120 LF border run and two floor boxes, all under one condition
const cpt = (pricing: any, materials: any[] = []) => [{ id: "cpt", finish_tag: "CPT-1", waste_pct: 5, pricing, materials }];
const cptShapes = [area("cpt", 900), lin("cpt", 120), cnt("cpt"), cnt("cpt")];

test("SF + LF + EA under one condition: three lines, each priced on its own quantity", () => {
  const est = price(cpt(
    { unit: "SY", material: 30, labor: 6, by_unit: { LF: { material: 2, labor: 1.5 }, EA: { material: 40, labor: 25 } } },
    [{ id: "m1", name: "Adhesive", per: 250, basis: "area", unit: "gal", price: 18 }],
  ), cptShapes);
  assert.deepEqual(est.lines.map((l: any) => [l.unit, l.main, l.material_qty, l.labor_qty, l.material_cost, l.labor_cost, l.total]), [
    ["SY", true, 105, 100, 3150, 600, 3822],   // 900 × 1.05 ÷ 9 ordered, 900 ÷ 9 installed; + 4 gal adhesive × $18
    ["LF", false, 126, 120, 252, 180, 432],    // waste on material only
    ["EA", false, 2, 2, 80, 50, 130],          // EA never carries waste
  ]);
  // the assembly prices once, on the main line
  assert.deepEqual(est.lines.map((l: any) => l.materials.length), [1, 0, 0]);
  assert.equal(est.lines[0].materials_cost, 72);
  assert.deepEqual(est.lines.map((l: any) => l.key), ["cpt:SY", "cpt:LF", "cpt:EA"]);
  assert.equal(est.material, 3554);   // 3150 + 72 + 252 + 80
  assert.equal(est.labor, 830);       // 600 + 180 + 50
  assert.equal(est.total, 4384);
  assert.equal(est.complete, true);
});

test("the reported bug: LF and EA reach the estimate, and unentered rates are missing, never $0", () => {
  const est = price(cpt({ material: 2, labor: 1 }), cptShapes);
  assert.deepEqual(est.lines.map((l: any) => [l.unit, l.status, l.missing]), [
    ["SF", "priced", []],
    ["LF", "unpriced", ["material", "labor"]],
    ["EA", "unpriced", ["material", "labor"]],
  ]);
  assert.deepEqual(est.lines.slice(1).map((l: any) => [l.material_rate, l.labor_rate, l.total]), [[null, null, 0], [null, null, 0]]);
  assert.equal(est.complete, false);
  assert.equal(est.total, 2790);   // priced so far: 945 SF × $2 + 900 SF × $1
  assert.deepEqual(est.unpriced.map((u: any) => [u.finish_tag, u.unit, u.status]), [["CPT-1", "LF", "unpriced"], ["CPT-1", "EA", "unpriced"]]);
  assert.deepEqual(est.unpriced.map((u: any) => lineLabel(est, u)), ["CPT-1 LF", "CPT-1 EA"]);
  assert.equal(lineLabel(est, est.lines[0]), "CPT-1 SF");
  // an entered 0 prices the line (e.g. the border is in the carpet price)
  const zero = price(cpt({ material: 2, labor: 1, by_unit: { LF: { material: 0, labor: 0 }, EA: { material: 0, labor: 0 } } }), cptShapes);
  assert.equal(zero.complete, true);
  assert.equal(zero.total, 2790);
});

test("a one-kind condition is still one line, priced exactly as before", () => {
  const est = price([{ id: "l", finish_tag: "LVT-1", waste_pct: 10, pricing: { unit: "SF", material: 2, labor: 1 } }], [area("l", 1000)]);
  assert.equal(est.lines.length, 1);
  assert.equal(est.lines[0].main, true);
  assert.equal(est.lines[0].total, 3200);
  assert.equal(lineLabel(est, est.lines[0]), "LVT-1");
});

test("the main line follows the picked unit; another kind's area line prices in SF from by_unit", () => {
  const conds = [{ id: "b", finish_tag: "BRD-1", pricing: { unit: "LF", material: 1, labor: 1, by_unit: { SF: { material: 3, labor: 2 } } } }];
  const est = price(conds, [area("b", 100), lin("b", 50)]);
  assert.deepEqual(est.lines.map((l: any) => [l.unit, l.material_qty, l.labor_qty, l.total]), [["LF", 50, 50, 100], ["SF", 100, 100, 500]]);
  assert.deepEqual(lineUnits({ total_sf: 5, lf: 2, ea: 1 }, undefined), ["SF", "LF", "EA"]);
  assert.deepEqual(lineUnits({ total_sf: 5, lf: 2, ea: 0 }, "SY"), ["SY", "LF"]);
  assert.deepEqual(lineUnits({ total_sf: 0, lf: 0, ea: 3 }, undefined), ["EA"]);
  // a bordered linear run carries LF and border SF: both are lines
  assert.deepEqual(price([{ id: "x", finish_tag: "BR-1" }], [lin("x", 40, 40)]).lines.map((l: any) => l.unit), ["SF", "LF"]);
});

test("sanitizePricing keeps by_unit rates per known unit and drops the rest", () => {
  assert.deepEqual(sanitizePricing({ material: 1, by_unit: { LF: { material: "2", labor: -1 }, M2: { material: 1 }, EA: {} } }), { material: 1, by_unit: { LF: { material: 2 } } });
  assert.equal(sanitizePricing({ by_unit: [] }), undefined);
  assert.equal(sanitizePricing({ by_unit: { LF: { material: "" } } }), undefined);
});

// An assembly on a 1000 SF + 3 EA condition with 10% condition waste (which items never use)
const asm = [{
  id: "a", finish_tag: "LVT-2", waste_pct: 10, pricing: { material: 3, labor: 2 },
  materials: [
    { id: "i1", name: "Primer", per: 150, basis: "area", unit: "gal", waste_pct: 10, price: 25 },              // 1 gal per 150 SF + 10%
    { id: "i2", name: "Floor box plate", rule: "each", per: 1, basis: "count", unit: "ea", price: 4, labor_price: 10 },  // 1 per piece
    { id: "i3", name: "Anchors", rule: "each", per: 2, basis: "count", unit: "ea" },                            // 2 per EA, never priced
    { id: "i4", name: "Underlayment", rule: "each", per: 1, basis: "area", unit: "SF", waste_pct: 5, round: false, price: 0.5, labor_price: 0.25 },
  ],
}];
const asmShapes = [area("a", 1000), cnt("a"), cnt("a"), cnt("a")];

test("assembly item quantities: rule, item waste and round-up; the condition's waste is not the item's", () => {
  const [row] = conditionTotals(asm, asmShapes);
  assert.deepEqual(row.materials.map((m: any) => [m.name, m.qty]), [
    ["Primer", 8],            // 1000 ÷ 150 = 6.67 × 1.10 = 7.33 → 8 whole gal
    ["Floor box plate", 3],   // 1 × 3 EA
    ["Anchors", 6],           // 2 × 3 EA
    ["Underlayment", 1050],   // 1 × 1000 SF × 1.05, not rounded
  ]);
  assert.equal(row.materials[0].waste_pct, 10);
  assert.equal("rule" in row.materials[0], false);
  assert.equal(row.materials[1].rule, "each");
  // a row written before rules and item waste reports byte-for-byte as before
  const [old] = conditionTotals([{ id: "o", finish_tag: "O", materials: [{ id: "m", name: "Adhesive", per: 250, basis: "area", unit: "gal" }] }], [area("o", 900)]);
  assert.deepEqual(old.materials[0], { name: "Adhesive", unit: "gal", per: 250, basis: "area", round: true, note: "", basis_qty: 900, qty: 4 });
  assert.deepEqual(row.materials.map(coverageLabel), ["1 gal / 150 SF + 10% waste", "1 ea / 1 EA", "2 ea / 1 EA", "1 SF / 1 SF + 5% waste"]);
  assert.equal(coverageLabel(old.materials[0]), "1 gal / 250 SF");
});

test("assembly items price material on the order qty and labor on the measured qty; item labor is optional", () => {
  const est = price(asm, asmShapes);
  const [main, ea] = est.lines;
  assert.deepEqual(main.materials.map((m: any) => [m.name, m.qty, m.price, m.cost, m.labor_qty, m.labor_rate, m.labor_cost, m.priced]), [
    ["Primer", 8, 25, 200, 6.67, null, 0, true],               // no labor of its own: not missing
    ["Floor box plate", 3, 4, 12, 3, 10, 30, true],
    ["Anchors", 6, null, 0, 6, null, 0, false],                  // material never entered: missing
    ["Underlayment", 1050, 0.5, 525, 1000, 0.25, 250, true],    // labor on the 1000 measured, not the 1050 ordered
  ]);
  assert.equal(main.materials_cost, 737);
  assert.equal(main.materials_labor_cost, 280);
  assert.equal(main.total, 6317);      // 1100 × $3 + 1000 × $2 + 737 + 280
  assert.equal(main.status, "partial");
  assert.deepEqual(main.missing, ["material row: Anchors"]);
  assert.deepEqual([ea.unit, ea.status], ["EA", "unpriced"]);
  assert.equal(est.material, 4037);    // condition material + item material
  assert.equal(est.labor, 2280);       // condition labor + item labor
  assert.equal(est.complete, false);
});

test("Excel: a row per line, the Unpriced tab names the line; the proposal scope follows", () => {
  const est = price(cpt({ material: 2, labor: 1 }), cptShapes);
  const sheets = estimateWorkbook({ est });
  const cptRows = sheets[0].rows.filter((r: any[]) => r[0] === "CPT-1");
  assert.deepEqual(cptRows.map((r: any[]) => [r[1], r[2], r[3], r[4], r[6]]), [["priced", "SF", 945, 2, 900], ["unpriced", "LF", 126, "", 120], ["unpriced", "EA", 2, "", 2]]);
  assert.ok(sheets[0].rows.some((r: any[]) => r[0] === "Base bid (priced so far)" && r[1] === 2790));
  assert.deepEqual(sheets[2].rows.filter((r: any[]) => String(r[0]).startsWith("CPT-1")), [["CPT-1 LF", "unpriced", "material; labor"], ["CPT-1 EA", "unpriced", "material; labor"]]);

  const full = price(cpt({ unit: "SY", material: 30, labor: 6, by_unit: { LF: { material: 2, labor: 1.5 }, EA: { material: 40, labor: 25 } } }), cptShapes);
  const m = buildBidProposal({ est: full, conditions: cpt({}), proposal: { itemized: true }, today: new Date(2026, 10, 3) });
  assert.deepEqual(m.scope.map((s: any) => [s.tag, s.unit, s.qty]), [["CPT-1", "SY", 100], ["CPT-1", "LF", 120], ["CPT-1", "EA", 2]]);
  assert.equal(Math.round(m.scope.reduce((n: number, s: any) => n + s.price, 0) * 100), Math.round(m.base_bid * 100));
});

test("templates never carry an item's material or labor price", () => {
  const t: any = conditionToTemplate({ id: "c", finish_tag: "X-1", materials: [{ id: "m", name: "Plate", rule: "each", per: 1, basis: "count", unit: "ea", price: 4, labor_price: 10, waste_pct: 2 }] });
  assert.deepEqual(t.materials, [{ name: "Plate", rule: "each", per: 1, basis: "count", unit: "ea", waste_pct: 2 }]);
  const c = instantiateTemplate({ finish_tag: "X-1", materials: [{ name: "Plate", per: 1, price: 4, labor_price: 10 }] });
  assert.equal("price" in c.materials[0] || "labor_price" in c.materials[0], false);
});

// A bordered linear condition (thickness → border SF derived from the LF). Before
// multi-line estimates it priced as ONE line; its derived second line is optional,
// so an old project priced on its SF still reads fully priced, to the cent.
// BR-1: 120 LF of 4" border = 40 SF, 10% waste
const brd = (pricing: any) => [{ id: "br", finish_tag: "BR-1", thickness_in: 4, waste_pct: 10, ...(pricing ? { pricing } : {}) }];
const brdShapes = [lin("br", 80, 26.67), lin("br", 40, 13.33)];

test("an old saved bordered linear condition priced on its SF reads fully priced exactly as before", () => {
  const est = price(brd({ material: 5, labor: 3 }), brdShapes);
  assert.deepEqual(est.lines.map((l: any) => [l.unit, l.main, l.optional, l.status, l.missing, l.total]), [
    ["SF", true, false, "priced", [], 340],      // 44 SF ordered × $5 + 40 SF installed × $3 — the pre-#597 single line
    ["LF", false, true, "optional", [], 0],      // shown, priceable, never missing
  ]);
  assert.equal(est.complete, true);
  assert.deepEqual(est.unpriced, []);
  assert.equal(est.total, 340);
  // Excel: no Unpriced tab, the LF row says what it is
  const sheets = estimateWorkbook({ est });
  assert.deepEqual(sheets.map((s: any) => s.name), ["Estimate", "Materials"]);
  assert.deepEqual(sheets[0].rows.filter((r: any[]) => r[0] === "BR-1").map((r: any[]) => [r[1], r[2], r[4], r[7]]), [["priced", "SF", 5, 3], ["optional (in main line)", "LF", "", ""]]);
  assert.ok(sheets[0].rows.some((r: any[]) => r[0] === "Base bid" && r[1] === 340));
  // proposal: base bid unchanged, nothing unpriced, the LF scope row is "Included", not $0.00
  const p = buildBidProposal({ est, conditions: brd(null), proposal: { itemized: true }, today: new Date(2026, 10, 4) });
  assert.equal(p.complete, true);
  assert.deepEqual(p.unpriced, []);
  assert.deepEqual(p.scope.map((s: any) => [s.unit, s.qty, s.price, s.included ?? false]), [["SF", 40, 340, false], ["LF", 120, 0, true]]);
});

test("the optional LF line still prices when the estimator prices it; one rate alone is not partial", () => {
  const est = price(brd({ material: 5, labor: 3, by_unit: { LF: { labor: 0.5 } } }), brdShapes);
  assert.deepEqual(est.lines.map((l: any) => [l.unit, l.status, l.missing, l.labor_cost, l.total]), [["SF", "priced", [], 120, 340], ["LF", "priced", [], 60, 60]]);
  assert.equal(est.complete, true);
  assert.equal(est.total, 400);
  const p = buildBidProposal({ est, conditions: brd(null), proposal: { itemized: true } });
  assert.equal(p.scope[1].included, undefined);
});

test("the SF (border) line stays required; the LF main line of a bordered run makes the SF line the optional one", () => {
  // nothing priced: the SF line is missing, the LF line is not
  const none = price(brd(null), brdShapes);
  assert.deepEqual(none.unpriced.map((u: any) => [u.unit, u.status, u.missing]), [["SF", "unpriced", ["material", "labor"]]]);
  assert.equal(none.complete, false);
  // priced by the LF (the other unit the old single line could be bought in)
  const byLf = price(brd({ unit: "LF", material: 2, labor: 1 }), brdShapes);
  assert.deepEqual(byLf.lines.map((l: any) => [l.unit, l.main, l.status, l.total]), [["LF", true, "priced", 384], ["SF", false, "optional", 0]]);   // 132 × $2 + 120 × $1
  assert.equal(byLf.complete, true);
});

test("only a derived line is optional: room SF or plain runs on the row keep every line required", () => {
  // a room + a bordered run: the LF is all border (optional), the SF carries the room (required)
  const mixed = price([{ id: "m", finish_tag: "CPT-2", thickness_in: 6, pricing: { unit: "LF", material: 1, labor: 1 } }], [area("m", 500), lin("m", 100, 50)]);
  assert.deepEqual(mixed.lines.map((l: any) => [l.unit, l.optional, l.status]), [["LF", false, "priced"], ["SF", false, "unpriced"]]);
  const mixedSf = price([{ id: "m", finish_tag: "CPT-2", thickness_in: 6, pricing: { material: 1, labor: 1 } }], [area("m", 500), lin("m", 100, 50)]);
  assert.deepEqual(mixedSf.lines.map((l: any) => [l.unit, l.optional, l.status]), [["SF", false, "priced"], ["LF", true, "optional"]]);
  assert.equal(mixedSf.complete, true);
  // no thickness: a plain run's LF is its own scope, required (the CPT-1 case above)
  const plain = price(cpt({ material: 2, labor: 1 }), cptShapes);
  assert.deepEqual(plain.lines.map((l: any) => [l.unit, l.optional]), [["SF", false], ["LF", false], ["EA", false]]);
  // EA is never derived
  const withBox = price(brd({ material: 5, labor: 3 }), [...brdShapes, cnt("br")]);
  assert.deepEqual(withBox.lines.map((l: any) => [l.unit, l.status]), [["SF", "priced"], ["LF", "optional"], ["EA", "unpriced"]]);
});
