import { test } from "node:test";
import assert from "node:assert/strict";
// totals.js is plain JS (allowJs); the tsx loader resolves it from the .ts test.
import { conditionTotals, materialsSummary, verticalWallSf, sheetTotals, reportJson, grandTotals } from "../src/lib/totals.js";
import { heightInputToFeet } from "../src/lib/units.js";
import { computeShapeMetrics } from "../src/lib/shapeMetrics.js";

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
    materials: [{ id: "m", name: "Adhesive", per: 55, basis: "area", unit: "gal", round: true, note: "3/16″ V-notch" }],
  }];
  const [row] = conditionTotals(conds, [area("wd", 110)]);
  assert.equal(row.materials[0].note, "3/16″ V-notch");
  assert.equal(row.materials[0].qty, 2); // ceil(110/55)
});

test("materials: grout coverage derived from tile geometry drives whole-bag qty", () => {
  // 12×24×3/8″ tile @ 1/8″ joint, 25-lb bag → 512 SF/bag (see coverage.test.ts)
  const conds = [{
    id: "ct", finish_tag: "CT-1",
    materials: [{ id: "m", name: "Grout", kind: "grout", per: 512, basis: "area", unit: "bag", round: true, note: "12×24×3/8″ @ 1/8″ · 25 lb" }],
  }];
  const [row] = conditionTotals(conds, [area("ct", 1000)]);
  assert.equal(row.materials[0].qty, 2); // ceil(1000/512) = ceil(1.95)
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

// ── edge cases + the vertical-wall helper (2026-07-05) ──────────────────────

test("deduct larger than the floor goes negative — never clamped silently", () => {
  const conds = [{ id: "c", finish_tag: "X-1" }];
  const shapes = [area("c", 100), { condition_id: "c", measure_role: "deduct", computed: { area_sf: 150 } }];
  const [row] = conditionTotals(conds, shapes);
  assert.equal(row.floor_sf, -50);
});

test("multiplier and waste compose: measured ×N first, waste on top", () => {
  const conds = [{ id: "c", finish_tag: "X-1", multiplier: 3, waste_pct: 10 }];
  const [row] = conditionTotals(conds, [area("c", 100)]);
  assert.equal(row.floor_sf, 300);
  assert.equal(row.floor_sf_net, 330);   // (100 × 3) × 1.10
});

test("materials: linear and count bases use LF/EA, never area", () => {
  const conds = [{
    id: "c", finish_tag: "RB-1",
    materials: [
      { id: "m1", name: "Cove adhesive", per: 40, basis: "linear", unit: "tube", round: true },
      { id: "m2", name: "Corner", per: 1, basis: "count", unit: "ea", round: true },
    ],
  }];
  const shapes = [
    area("c", 5000),                                                        // must NOT drive either row
    lin("c", 120),
    { condition_id: "c", measure_role: "count", computed: { count: 7 } },
  ];
  const [row] = conditionTotals(conds, shapes);
  const byName = Object.fromEntries(row.materials.map((m: any) => [m.name, m.qty]));
  assert.equal(byName["Cove adhesive"], 3);  // ceil(120/40)
  assert.equal(byName.Corner, 7);
});

// ── report JSON schema v1 — the key set is a published contract (2026-07-07) ──

test("reportJson: v1 key set pinned — top level, sheets[], markups[], by_sheet rows", () => {
  const conds = [{ id: "ct", finish_tag: "CT-1", color: "#123456", waste_pct: 10 }];
  const shapes = [{ condition_id: "ct", sheet_id: "sh1", measure_role: "floor_area", computed: { area_sf: 100, perimeter_lf: 40 } }];
  const rows = conditionTotals(conds, shapes);
  const j = reportJson({
    projectName: "Job 42",
    rows,
    bySheet: sheetTotals(conds, shapes),
    scaleInfo: [{ sheet_id: "sh1", units_per_px: 0.02, scale_source: "calibrated" }],
    markups: [
      { type: "cloud", sheet_id: "sh1", text: "verify", rect: [[0, 0], [1, 1]] },   // legacy: no id/rfi_id
      { type: "cloud", sheet_id: "sh1", text: "", id: "mk-2", rfi_id: "rfi-1", rect: [[0, 0], [1, 1]] },
    ],
    rfis: [
      { id: "rfi-1", number: "RFI-014", subject: "Slab", status: "open", to: "GC", priority: "high", cost_impact: true, schedule_impact: false, date: "7/8", question: "q?", response: "", response_date: "", sheet_id: "sh1" },
    ],
    sheetLabel: (id: string) => `Sheet ${id}`,
  });
  assert.equal(j.schema, "opentakeoff.report.v1");
  // condition_columns appended after markups (additive-only v1, 2026-07-07);
  // shape_labels + by_label appended after it (#112, additive-only, always
  // emitted); units + display_units appended after that (metric display port —
  // quantities stay RAW feet, the export says which system the user was
  // reading); roll_goods appended last (#136, always emitted, empty without
  // roll-goods conditions)
  assert.deepEqual(Object.keys(j),
    ["schema", "project_name", "generated_with", "sheets", "conditions", "by_sheet", "totals", "materials", "markups", "rfis", "condition_columns", "shape_labels", "by_label", "units", "display_units", "roll_goods"]);
  assert.equal(j.display_units, "imperial");
  assert.deepEqual(j.roll_goods, []);   // #136 — always emitted; empty when nothing carries a roll_setup
  // rfis[] appends after markups (additive v1); linked_markups/linked_sheets derived
  assert.deepEqual(Object.keys(j.rfis[0]),
    ["id", "number", "subject", "question", "status", "to", "priority", "cost_impact", "schedule_impact",
     "date", "response", "response_date", "sheet_id", "sheet", "linked_markups", "linked_sheets"]);
  assert.equal(j.rfis[0].linked_markups, 1);          // the mk-2 cloud links to rfi-1
  assert.deepEqual(j.rfis[0].linked_sheets, ["Sheet sh1"]);
  assert.equal(j.rfis[0].sheet, "Sheet sh1");
  // sheets: provenance under scale_source (the persisted-payload key) +
  // scale_confirmed (the scale gate — absent input = true, human-era); NO
  // units_per_px — that figure is internal (RENDER_SCALE-coupled)
  assert.deepEqual(Object.keys(j.sheets[0]), ["sheet_id", "sheet", "scale_source", "scale_confirmed"]);
  assert.equal(j.sheets[0].scale_source, "calibrated");
  assert.equal(j.sheets[0].scale_confirmed, true);
  assert.equal(j.sheets[0].sheet, "Sheet sh1");
  // id + rfi_id appended after the original four (additive-only v1 schema)
  // condition_id + condition APPEND after rfi_id (additive-only v1). `condition`
  // is the RESOLVED finish_tag so a reader sees which scope an annotation is
  // about without joining two arrays; condition_id stays authoritative.
  assert.deepEqual(Object.keys(j.markups[0]), ["type", "sheet_id", "sheet", "text", "id", "rfi_id", "condition_id", "condition"]);
  assert.equal(j.markups[0].id, null);              // legacy markup: null id, empty rfi
  assert.equal(j.markups[0].rfi_id, "");
  assert.equal(j.markups[0].condition_id, "");      // legacy markup: unattached
  assert.equal(j.markups[0].condition, "");
  assert.equal(j.markups[1].id, "mk-2");            // an id-bearing cloud with empty text
  assert.equal(j.markups[1].rfi_id, "rfi-1");       // links to the RFI record by its id
  assert.equal(j.markups[1].text, "");
  assert.deepEqual(Object.keys(j.by_sheet[0]), ["sheet_id", "sheet", "rows"]);
  assert.deepEqual(Object.keys(j.by_sheet[0].rows[0]),
    ["id", "finish_tag", "color", "multiplier", "shape_count", "floor_sf", "wall_sf", "border_sf", "lf", "ea"]);
  // row `columns` appended after materials (additive-only v1, 2026-07-07)
  assert.deepEqual(Object.keys(j.conditions[0]),
    ["id", "finish_tag", "color", "fill", "hatch", "multiplier", "waste_pct", "shape_count",
     "floor_sf", "wall_sf", "border_sf", "lf", "ea", "total_sf",
     "floor_sf_net", "wall_sf_net", "border_sf_net", "lf_net", "total_sf_net", "sy_net", "materials", "columns"]);
});

test("reportJson: roll_goods rides through verbatim; a non-array coerces to [] (#136)", () => {
  const rows = [{ condition_id: "ct", finish_tag: "CPT-1", material: "carpet", roll_width_ft: 12, roll_length_ft: 0, direction: "ns", cuts: 3, order_lf: 46.5, rolls: 1, order_qty: 62, order_unit: "sy", oversize: false }];
  assert.deepEqual(reportJson({ rollGoods: rows }).roll_goods, rows);
  assert.deepEqual(reportJson({ rollGoods: "corrupt" as any }).roll_goods, []);
});

test("reportJson: by_sheet rows serialize round2-ed — incl. ea — with key order intact", () => {
  const conds = [{ id: "c", finish_tag: "FX-1" }];
  // hand-edited payloads can carry fractional counts (drawn count shapes are
  // always count: 1) — serialization rounds them like every other quantity
  const shapes = [
    { condition_id: "c", sheet_id: "s1", measure_role: "count", computed: { count: 1.333 } },
    { condition_id: "c", sheet_id: "s1", measure_role: "floor_area", computed: { area_sf: 10.004 } },
  ];
  const bySheet = sheetTotals(conds, shapes);
  assert.equal(bySheet[0].rows[0].ea, 1.333);          // sheetTotals output stays raw
  assert.equal(bySheet[0].rows[0].floor_sf, 10.004);
  const j = reportJson({ rows: conditionTotals(conds, shapes), bySheet });
  assert.equal(j.by_sheet[0].rows[0].ea, 1.33);        // rounded at serialization
  assert.equal(j.by_sheet[0].rows[0].floor_sf, 10);
  assert.deepEqual(Object.keys(j.by_sheet[0].rows[0]),
    ["id", "finish_tag", "color", "multiplier", "shape_count", "floor_sf", "wall_sf", "border_sf", "lf", "ea"]);
});

test("reportJson: unrecorded provenance exports as the literal 'unknown'", () => {
  const j = reportJson({ scaleInfo: [{ sheet_id: "s1" }] });
  assert.equal(j.sheets[0].scale_source, "unknown");
  assert.equal(j.project_name, null);
});

test("reportJson: legacy 'source' key still read as a fallback", () => {
  const j = reportJson({ scaleInfo: [{ sheet_id: "s1", source: "detected" }] });
  assert.equal(j.sheets[0].scale_source, "detected");
});

test("reportJson: scale gate — agent-set unconfirmed rides through as false, absent = true", () => {
  const j = reportJson({ scaleInfo: [
    { sheet_id: "s1", scale_source: "detected", scale_confirmed: false },
    { sheet_id: "s2", scale_source: "calibrated" },
  ] });
  assert.equal(j.sheets[0].scale_confirmed, false);
  assert.equal(j.sheets[1].scale_confirmed, true);
});

test("reportJson: custom columns — definitions emitted; row values filter orphans/non-strings/empties", () => {
  const conds = [{ id: "a", finish_tag: "A" }, { id: "b", finish_tag: "B" }, { id: "c", finish_tag: "C" }];
  const shapes = [area("a", 10), area("b", 20), area("c", 30)];
  const defs = [
    { id: "div", name: "CSI Division", values: ["09 68 00", "09 65 00"] },
    { id: "ph", name: "Phase", values: ["1", "2"] },
  ];
  const attrsByCond = new Map<string, any>([
    ["a", { div: "09 68 00", ph: "", ghost: "deleted column" }],  // "" dropped; orphaned colId dropped
    ["b", { ph: 7 }],                                             // corrupted non-string dropped
    ["c", { ph: "2", div: "09 65 00" }],                          // attrs order ≠ definition order
  ]);
  const j = reportJson({ rows: conditionTotals(conds, shapes), conditionColumns: defs, attrsByCond });
  assert.deepEqual(j.condition_columns, defs);
  assert.deepEqual(j.conditions[0].columns, [{ id: "div", name: "CSI Division", value: "09 68 00" }]);
  assert.deepEqual(j.conditions[1].columns, []);
  // definition order wins, not attrs insertion order
  assert.deepEqual(j.conditions[2].columns, [
    { id: "div", name: "CSI Division", value: "09 65 00" },
    { id: "ph", name: "Phase", value: "2" },
  ]);
});

test("reportJson: no custom columns → condition_columns: [] and row columns: [] (deterministic shape)", () => {
  const conds = [{ id: "a", finish_tag: "A" }];
  const j = reportJson({ rows: conditionTotals(conds, [area("a", 10)]) });
  assert.deepEqual(j.condition_columns, []);
  assert.deepEqual(j.conditions[0].columns, []);
});

test("reportJson: explicit null / corrupted non-array/non-Map inputs must not throw the export", () => {
  // destructuring defaults don't apply to null, and both values can trace
  // back to a corrupted payload — the export coerces instead of crashing
  const conds = [{ id: "a", finish_tag: "A" }];
  for (const [cc, ab] of [[null, null], [{ id: "x" }, {}], ["x", []]] as any[]) {
    const j = reportJson({ rows: conditionTotals(conds, [area("a", 10)]), conditionColumns: cc, attrsByCond: ab });
    assert.deepEqual(j.condition_columns, []);
    assert.deepEqual(j.conditions[0].columns, []);
  }
});

test("reportJson: malformed ITEMS inside a conditionColumns array are dropped, not thrown on", () => {
  // an array passing the top-level coercion can still carry garbage items —
  // the export must not die on `cc.id` / destructuring
  const conds = [{ id: "a", finish_tag: "A" }];
  const defs = [null, "x", { name: "no id" }, { id: 7 }, { id: "ok", name: "Div", values: "not-an-array" }] as any[];
  const j = reportJson({ rows: conditionTotals(conds, [area("a", 10)]), conditionColumns: defs, attrsByCond: new Map([["a", { ok: "v" }]]) });
  assert.deepEqual(j.condition_columns, [{ id: "ok", name: "Div", values: [] }]);   // non-array values coerced
  assert.deepEqual(j.conditions[0].columns, [{ id: "ok", name: "Div", value: "v" }]);
});

test("verticalWallSf: floor perimeters × height × multiplier; 0 without a height", () => {
  const shapes = [
    { condition_id: "c", measure_role: "floor_area", computed: { area_sf: 100, perimeter_lf: 40 } },
    { condition_id: "c", measure_role: "floor_area", computed: { area_sf: 50, perimeter_lf: 30 } },
    { condition_id: "c", measure_role: "linear", computed: { perimeter_lf: 999 } },   // never counted
    { condition_id: "other", measure_role: "floor_area", computed: { perimeter_lf: 999 } },
  ];
  assert.equal(verticalWallSf(shapes, "c", 9, 2), 1260);  // (40+30) × 9 × 2
  assert.equal(verticalWallSf(shapes, "c", 0, 2), 0);
  assert.equal(verticalWallSf(shapes, "c", undefined, 2), 0);
});

test("reportJson: a condition-linked markup resolves to its finish_tag; a dangling id degrades", () => {
  const conds = [{ id: "ct", finish_tag: "CT-1", color: "#123456", waste_pct: 0 }];
  const shapes = [{ condition_id: "ct", sheet_id: "sh1", measure_role: "floor_area", computed: { area_sf: 100, perimeter_lf: 40 } }];
  const j = reportJson({
    projectName: "Job 42",
    rows: conditionTotals(conds, shapes),
    bySheet: sheetTotals(conds, shapes),
    markups: [
      { type: "cloud", sheet_id: "sh1", text: "verify substrate", id: "mk-1", condition_id: "ct" },
      { type: "text", sheet_id: "sh1", text: "general note", id: "mk-2" },                       // unattached
      { type: "cloud", sheet_id: "sh1", text: "orphan", id: "mk-3", condition_id: "gone" },      // condition deleted
    ],
    sheetLabel: (id: string) => `Sheet ${id}`,
  });
  // linked: the id is authoritative AND the tag is resolved for the reader
  assert.equal(j.markups[0].condition_id, "ct");
  assert.equal(j.markups[0].condition, "CT-1");
  // unattached stays empty on both — an annotation about the sheet, not a scope
  assert.equal(j.markups[1].condition_id, "");
  assert.equal(j.markups[1].condition, "");
  // a dangling id keeps the id (so the link is diagnosable) but resolves to ""
  // rather than inventing a tag — the export must not claim a scope that is gone
  assert.equal(j.markups[2].condition_id, "gone");
  assert.equal(j.markups[2].condition, "");
});

// #137 — a RECONCILED deduct (cuts_shape_id set) was boolean-subtracted into
// its parent at commit time: the parent's own area_sf already nets the hole
// out, so the summer must NOT subtract the deduct's area again. A legacy
// independent deduct (no cuts_shape_id) still subtracts.
test("conditionTotals: reconciled deduct never double-subtracts; legacy deduct still does", () => {
  const conds = [{ id: "c1", finish_tag: "CPT-1" }];
  const rows = conditionTotals(conds as any, [
    { id: "p", condition_id: "c1", measure_role: "floor_area", verts_norm: [], computed: { area_sf: 90 } },   // 100 gross − 10 hole, already netted
    { id: "d1", condition_id: "c1", measure_role: "deduct", cuts_shape_id: "p", verts_norm: [], computed: { area_sf: 10 } },
    { id: "d2", condition_id: "c1", measure_role: "deduct", verts_norm: [], computed: { area_sf: 5 } },
  ] as any);
  assert.equal(rows[0].floor_sf, 85, "90 − 5 (legacy only); a double-deduct would read 75");
});

// ── Task 4: unit preference does NOT change canonical totals ─────────────────
// conditionTotals/sheetTotals/grandTotals operate purely on shape.computed —
// they never see or care about a display-unit preference.  These tests prove
// that the canonical math is unit-agnostic: the same shapes produce the same
// numbers regardless of which unit system the user selected.

const wallShape = (id: string, cid: string, sf: number, lf: number, hFt: number) =>
  ({ id, condition_id: cid, measure_role: "surface_area", height_ft: hFt, computed: { area_sf: sf, perimeter_lf: lf } } as any);

const floorShape = (id: string, cid: string, sf: number, lf: number) =>
  ({ id, condition_id: cid, measure_role: "floor_area", computed: { area_sf: sf, perimeter_lf: lf } } as any);

const linearShape = (id: string, cid: string, lf: number, borderSF: number) =>
  ({ id, condition_id: cid, measure_role: "linear", computed: { perimeter_lf: lf, area_sf: borderSF } } as any);

test("conditionTotals: canonical floor SF is identical regardless of display unit preference", () => {
  const conds = [{ id: "c1", finish_tag: "LVT-1", waste_pct: 10, multiplier: 1 }];
  const shapes = [floorShape("s1", "c1", 500, 90), floorShape("s2", "c1", 300, 70)];
  // The same shapes produce the same canonical totals — conditionTotals
  // never takes a units argument and never converts.
  const [row] = conditionTotals(conds, shapes);
  assert.equal(row.floor_sf, 800);      // 500 + 300
  assert.equal(row.floor_sf_net, 880);  // 800 × 1.10
  assert.equal(row.total_sf, 800);
  assert.equal(row.sy_net, 97.78);      // 880 / 9, round2
});

test("conditionTotals: wall SF (surface_area × height) is identical regardless of display units", () => {
  const conds = [{ id: "c2", finish_tag: "WALL-1", multiplier: 1 }];
  const shapes = [wallShape("w1", "c2", 120, 15, 8), wallShape("w2", "c2", 80, 10, 8)];
  const [row] = conditionTotals(conds, shapes);
  assert.equal(row.wall_sf, 200);  // 120 + 80 — these are ALREADY area_sf (LF × height)
  // A metric display would show areaVal(200) ≈ 18.58 m² — but the canonical
  // value stored in the row must remain 200 SF, unaffected by display preference.
  assert.equal(row.wall_sf_net, 200);  // no waste on wall SF by default
});

test("conditionTotals: border SF and LF from linear shapes are canonical, unit-agnostic", () => {
  const conds = [{ id: "c3", finish_tag: "BASE-1", multiplier: 2, waste_pct: 0 }];
  const shapes = [linearShape("l1", "c3", 50, 4.17), linearShape("l2", "c3", 30, 2.5)];
  const [row] = conditionTotals(conds, shapes);
  assert.equal(row.lf, 160);     // (50 + 30) × 2
  assert.equal(row.border_sf, 13.34); // (4.17 + 2.5) × 2
});

test("grandTotals: aggregation is pure arithmetic — no unit conversion path", () => {
  const rows = [
    { total_sf: 100, total_sf_net: 110, lf: 20, lf_net: 22, ea: 5, sy_net: 12.22 },
    { total_sf: 200, total_sf_net: 220, lf: 30, lf_net: 33, ea: 0, sy_net: 24.44 },
  ];
  const g = grandTotals(rows);
  assert.equal(g.total_sf, 300);
  assert.equal(g.total_sf_net, 330);
  assert.equal(g.lf, 50);
  assert.equal(g.lf_net, 55);
  assert.equal(g.ea, 5);
  assert.equal(g.sy_net, 36.66); // 12.22 + 24.44
});

// ── Task 3 spec gap: conditionTotals reads computed.area_sf, NOT height_ft ───
// conditionTotals is a pure aggregator over shape.computed — it never computes
// LF × height itself; that happens in shapeMetrics.js at commit time.  These
// tests prove (a) the aggregator is blind to height_ft, and (b) shapes built
// from equivalent Imperial and SI inputs converge to the same canonical totals.

test("conditionTotals: aggregator reads computed.area_sf, ignores height_ft on the shape", () => {
  const conds = [{ id: "w", finish_tag: "WALL-1", multiplier: 1 }];
  // Two shapes: both 80 SF in computed, but different height_ft values —
  // conditionTotals must produce identical wall_sf because it reads .computed.area_sf.
  const s1 = { id: "s1", condition_id: "w", measure_role: "surface_area", height_ft: 8,  computed: { area_sf: 80, perimeter_lf: 10 } };
  const s2 = { id: "s2", condition_id: "w", measure_role: "surface_area", height_ft: 10, computed: { area_sf: 80, perimeter_lf: 10 } };
  const [row] = conditionTotals(conds, [s1, s2]);
  assert.equal(row.wall_sf, 160, "conditionTotals sums computed.area_sf, not LF × height_ft");
});

test("conditionTotals: wall SF from SI input path equals Imperial input path", () => {
  // Imperial path: user enters 8 ft → height_ft = 8, traced 10 LF → computed.area_sf = 80
  const dims = { w: 1000, h: 800 };
  const upp = 0.05;
  const verts_norm = [[0.1, 0.25], [0.3, 0.25]];
  const imperialHeightFt = 8;
  const imperialComputed = computeShapeMetrics({ measure_role: "surface_area", verts_norm }, dims, upp, { height_ft: imperialHeightFt });
  const imperialShape = { id: "imp", condition_id: "c", measure_role: "surface_area", height_ft: imperialHeightFt, computed: imperialComputed };
  // SI path: user enters 2.4384 m → heightInputToFeet → height_ft ≈ 8,
  // same pixel wall → shapeMetrics produces the same canonical computed values
  const siHeightFt = heightInputToFeet(2.4384, "metric");
  const siComputed = computeShapeMetrics({ measure_role: "surface_area", verts_norm }, dims, upp, { height_ft: siHeightFt });
  const siShape = { id: "si", condition_id: "c", measure_role: "surface_area", height_ft: siHeightFt, computed: siComputed };
  assert.deepEqual(siComputed, imperialComputed, "SI and Imperial geometry paths must produce identical canonical computed values");
  const conds = [{ id: "c", finish_tag: "WALL-1", waste_pct: 10, multiplier: 1 }];
  const [rowImp] = conditionTotals(conds, [imperialShape]);
  const [rowSI] = conditionTotals(conds, [siShape]);
  // conditionTotals aggregates computed values → identical
  assert.equal(rowImp.wall_sf, rowSI.wall_sf, "wall_sf from Imperial vs SI height path");
  assert.equal(rowImp.wall_sf_net, rowSI.wall_sf_net, "wall_sf_net from Imperial vs SI height path");
  assert.equal(rowImp.total_sf, rowSI.total_sf, "total_sf from Imperial vs SI height path");
  // grandTotals over mixed shapes also converges
  const g = grandTotals([rowImp, rowSI]);
  assert.equal(g.total_sf, 160);
});

test("conditionTotals: verticalWallSf uses height_ft from the condition, not the shape", () => {
  // verticalWallSf reads the condition's height_ft; shapes carry computed area_sf
  // from whatever height they were drawn at — the condition height is the
  // "next-trace default", not the summer's input.
  const floorShapes = [
    { id: "f1", condition_id: "c", measure_role: "floor_area", computed: { area_sf: 100, perimeter_lf: 40 } },
  ];
  // verticalWallSf takes the condition height as a separate argument
  assert.equal(verticalWallSf(floorShapes, "c", 9), 360);   // 40 × 9
  assert.equal(verticalWallSf(floorShapes, "c", 9, 2), 720); // × 2 multiplier
});
