// Column-selection library: profiles, prefs, getters, and the column-driven
// CSV. The default-CSV assertion here deliberately overlaps the golden test —
// it locks CSV_PROFILE itself (defaults + order + headers) to the same bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { conditionTotals, grandTotals, sheetTotals, totalsToCsv, round2 } from "../src/lib/totals.js";
import {
  GETTERS, CSV_PROFILE, TABLE_PROFILE, getTableProfile, customColProfile, specColProfile, specValue, SPEC_FIELDS,
  laborColProfile, LABOR_FIELDS, laborValue, rollColProfile, ROLL_FIELDS,
  partitionRowsBy, forceIncludeGroupCol,
  loadColPrefs, saveColPrefs, loadGroupBy, saveGroupBy, visibleCols, floorPerimeterLf,
  applyUnits, METRIC_LABELS, METRIC_CSV_LABELS, colGetter,
} from "../src/lib/reportColumns.js";
import { conditions, shapes, projectName, sheetLabel } from "./fixtures/report.fixture.ts";

const rows = conditionTotals(conditions, shapes).filter((r: any) => r.shape_count > 0);
const golden = readFileSync(new URL("./fixtures/report.golden.csv", import.meta.url), "utf8");

test("default-visible CSV_PROFILE columns reproduce the golden CSV byte-for-byte", () => {
  const defaults = visibleCols(CSV_PROFILE, {});
  assert.equal(defaults.length, 13);
  // cols passed explicitly (the default-visible set) — same bytes as cols=null
  const csv = totalsToCsv(rows, projectName, sheetTotals(conditions, shapes), sheetLabel, defaults);
  assert.equal(csv, golden);
  assert.equal(totalsToCsv(rows, projectName, sheetTotals(conditions, shapes), sheetLabel), golden);
});

test("visibleCols: overrides flip defaults both ways; unknown keys ignored", () => {
  const on = visibleCols(CSV_PROFILE, { waste_sf: true, sy_net: false, bogus_key: true });
  const keys = on.map((c: any) => c.key);
  assert.ok(keys.includes("waste_sf"));          // default-off flipped on
  assert.ok(!keys.includes("sy_net"));           // default-on flipped off
  assert.ok(!keys.includes("bogus_key"));        // unknown pref key: no column invented
  assert.equal(on.length, 13);                   // +1 −1 against the 13 defaults
  // no prefs → defaults exactly, in profile order
  assert.deepEqual(visibleCols(TABLE_PROFILE, {}).map((c: any) => c.key),
    TABLE_PROFILE.filter((c: any) => c.defaultVisible).map((c: any) => c.key));
});

// ── lf_net in table/CSV profiles ─────────────────────────────────────────
test("TABLE_PROFILE includes lf_net as opt-in (defaultVisible: false)", () => {
  const lfNetCol = TABLE_PROFILE.find((c: any) => c.key === "lf_net");
  assert.ok(lfNetCol, "lf_net present in TABLE_PROFILE");
  assert.equal(lfNetCol.defaultVisible, false, "lf_net is opt-in");
  assert.equal(lfNetCol.header, "LF w/Waste");
  // lf_net should appear after lf in profile order
  const lfIdx = TABLE_PROFILE.findIndex((c: any) => c.key === "lf");
  const lfNetIdx = TABLE_PROFILE.findIndex((c: any) => c.key === "lf_net");
  assert.ok(lfNetIdx > lfIdx, "lf_net appears after lf");
});

test("TABLE_PROFILE lf_net getter returns waste-adjusted LF", () => {
  const r = { lf: 50, lf_net: 55 };
  assert.equal(GETTERS.lf_net(r), 55);
});

test("CSV_PROFILE includes lf_net", () => {
  const lfNetCol = CSV_PROFILE.find((c: any) => c.key === "lf_net");
  assert.ok(lfNetCol, "lf_net present in CSV_PROFILE");
  assert.equal(lfNetCol.header, "LF w/Waste");
});

test("lf_net metric conversion uses M_PER_FT", () => {
  const lfNetCol = TABLE_PROFILE.find((c: any) => c.key === "lf_net")!;
  const metricCols = applyUnits([lfNetCol], "metric");
  assert.equal(metricCols.length, 1, "lf_net not filtered out in metric");
  const mCol = metricCols[0];
  assert.ok(mCol.header.includes("m"), `metric lf_net header has m: ${mCol.header}`);
  assert.ok(!mCol.header.includes("LF"), `metric lf_net header has no LF: ${mCol.header}`);
  // 50 LF → 50 × 0.3048 = 15.24 m
  assert.equal(mCol.get({ lf_net: 50 }), round2(50 * 0.3048), "lf_net metric conversion");
});

test("waste_sf / waste_lf getters: order minus base, rounded", () => {
  const r = { total_sf: 100.004, total_sf_net: 110.01, lf: 10, lf_net: 10.5 };
  assert.equal(GETTERS.waste_sf(r), 10.01);      // 110.01 − 100.004 = 10.006 → 10.01
  assert.equal(GETTERS.waste_lf(r), 0.5);
});

// ── blank/missing operand preservation in waste getters ──────────────────
// When either operand of waste_sf or waste_lf is blank/null/undefined the
// getter must return "" (blank) rather than 0 or NaN. Legitimate numeric zero
// must remain zero.

test("waste_sf / waste_lf: blank operands produce blank, not NaN or 0", () => {
  // both blank → blank
  assert.equal(GETTERS.waste_sf({ total_sf: "", total_sf_net: "" }), "");
  assert.equal(GETTERS.waste_lf({ lf: "", lf_net: "" }), "");
  // one blank, one numeric → blank
  assert.equal(GETTERS.waste_sf({ total_sf: 100, total_sf_net: "" }), "");
  assert.equal(GETTERS.waste_sf({ total_sf: "", total_sf_net: 100 }), "");
  assert.equal(GETTERS.waste_lf({ lf: 10, lf_net: "" }), "");
  assert.equal(GETTERS.waste_lf({ lf: "", lf_net: 10 }), "");
  // null → blank
  assert.equal(GETTERS.waste_sf({ total_sf: null, total_sf_net: 50 }), "");
  assert.equal(GETTERS.waste_lf({ lf: null, lf_net: 50 }), "");
  // undefined (missing key) → blank
  assert.equal(GETTERS.waste_sf({ total_sf_net: 50 }), "");
  assert.equal(GETTERS.waste_lf({ lf_net: 50 }), "");
  // both undefined → blank
  assert.equal(GETTERS.waste_sf({}), "");
  assert.equal(GETTERS.waste_lf({}), "");
});

test("waste_sf / waste_lf: legitimate zero stays zero (not blank)", () => {
  // equal values → zero waste
  assert.equal(GETTERS.waste_sf({ total_sf: 100, total_sf_net: 100 }), 0);
  assert.equal(GETTERS.waste_lf({ lf: 50, lf_net: 50 }), 0);
  // both zero → zero
  assert.equal(GETTERS.waste_sf({ total_sf: 0, total_sf_net: 0 }), 0);
  assert.equal(GETTERS.waste_lf({ lf: 0, lf_net: 0 }), 0);
});

test("waste_sf / waste_lf: mixed blank and zero operands — blank wins", () => {
  // 0 is numeric, "" is blank → result is blank
  assert.equal(GETTERS.waste_sf({ total_sf: 0, total_sf_net: "" }), "");
  assert.equal(GETTERS.waste_lf({ lf: 0, lf_net: "" }), "");
  // 0 and null → blank
  assert.equal(GETTERS.waste_sf({ total_sf: 0, total_sf_net: null }), "");
  assert.equal(GETTERS.waste_lf({ lf: 0, lf_net: null }), "");
});

test("waste_sf / waste_lf: applyUnits metric conv preserves blank from blank operands", () => {
  const cols = visibleCols(CSV_PROFILE, { waste_sf: true, waste_lf: true });
  const metric = applyUnits(cols, "metric");
  const wsGet = colGetter(metric.find((c: any) => c.key === "waste_sf")!);
  const wlGet = colGetter(metric.find((c: any) => c.key === "waste_lf")!);
  // blank operands → getter returns "" → conv sees "" → stays ""
  const blankRow = { total_sf: "", total_sf_net: "", lf: "", lf_net: "" };
  assert.equal(wsGet!(blankRow), "", "metric waste_sf blank preserved");
  assert.equal(wlGet!(blankRow), "", "metric waste_lf blank preserved");
  // one blank → blank preserved through conv
  assert.equal(wsGet!({ total_sf: 100, total_sf_net: "" }), "", "metric waste_sf one-blank preserved");
  assert.equal(wlGet!({ lf: 10, lf_net: "" }), "", "metric waste_lf one-blank preserved");
  // legitimate zero → converted to 0
  assert.equal(wsGet!({ total_sf: 100, total_sf_net: 100 }), 0, "metric waste_sf zero stays 0");
  assert.equal(wlGet!({ lf: 50, lf_net: 50 }), 0, "metric waste_lf zero stays 0");
});

test("floorPerimeterLf: sums only floor_area shapes per condition, unrounded", () => {
  const m = floorPerimeterLf(shapes);
  assert.equal(m.get("ct1"), 44.4 + 90.12);      // deduct shape s3 excluded
  assert.equal(m.get("lvt2"), 61.7);
  assert.equal(m.has("rb1"), false);             // linear
  assert.equal(m.has("wt1"), false);             // surface_area
  assert.equal(m.has("cnt"), false);             // count
  // unrounded accumulation — raw float sum survives
  const raw = floorPerimeterLf([
    { condition_id: "x", measure_role: "floor_area", computed: { perimeter_lf: 0.1 } },
    { condition_id: "x", measure_role: "floor_area", computed: { perimeter_lf: 0.2 } },
  ]);
  assert.equal(raw.get("x"), 0.1 + 0.2);         // 0.30000000000000004, not 0.3
});

test("perimeter_ref getter reads the ctx map, 0 when absent", () => {
  const r = { id: "ct1" };
  assert.equal(GETTERS.perimeter_ref(r, { perimByCond: floorPerimeterLf(shapes) }), 134.52);
  assert.equal(GETTERS.perimeter_ref(r, { perimByCond: new Map() }), 0);
  assert.equal(GETTERS.perimeter_ref(r), 0);     // no ctx at all
});

test("perimeter_ref applies the condition multiplier (the verticalWallSf convention)", () => {
  const ctx = { perimByCond: new Map([["c", 40.1]]) };
  assert.equal(GETTERS.perimeter_ref({ id: "c", multiplier: 3 }, ctx), 120.3);
  assert.equal(GETTERS.perimeter_ref({ id: "c" }, ctx), 40.1);   // missing multiplier → 1
});

test("locked finish column survives a hand-corrupted pref", () => {
  const cols = visibleCols(TABLE_PROFILE, { finish: false });
  assert.equal(cols[0].key, "finish");
  const csvCols = visibleCols(CSV_PROFILE, { finish: false });
  assert.equal(csvCols[0].key, "finish");
});

test("locked columns are exactly [finish] in both profiles (the picker filters on locked)", () => {
  // ReportPanel's column picker hides `locked` columns — a new locked column
  // must be a deliberate picker change, not a silent one
  for (const profile of [TABLE_PROFILE, CSV_PROFILE]) {
    assert.deepEqual(profile.filter((c: any) => c.locked).map((c: any) => c.key), ["finish"]);
  }
});

test("CSV with a base column toggled off drops it end-to-end", () => {
  const cols = visibleCols(CSV_PROFILE, { sy_net: false });
  const csv = totalsToCsv(rows, projectName, null, null, cols);
  const header = csv.split("\n")[1];
  assert.ok(!header.includes("SY w/Waste"));
  assert.ok(header.endsWith("LF w/Waste"));   // neighbours intact, order kept
});

test("CSV with opt-ins: appended at the end, base 13 untouched, TOTAL blank under perimeter_ref", () => {
  const cols = visibleCols(CSV_PROFILE, { waste_sf: true, waste_lf: true, perimeter_ref: true });
  const ctx = { perimByCond: floorPerimeterLf(shapes) };
  const csv = totalsToCsv(rows, projectName, sheetTotals(conditions, shapes), sheetLabel, cols, ctx);
  const lines = csv.split("\n");
  const goldenHeader = golden.split("\n")[1];    // line 0 is the title comment
  // existing 13 header cells unchanged, opt-ins appended verbatim at the end
  assert.equal(lines[1],
    goldenHeader + ',Waste SF,Waste LF,"Perimeter LF (ref, incl. openings)"');
  // CT-1 row: waste_sf = 601.59 − 546.9, waste_lf = 0, perimeter = 44.4 + 90.12
  const ct1 = lines[2].split(",");
  assert.deepEqual(ct1.slice(-3).map(Number), [54.69, 0, 134.52]);
  // TOTAL row: derived waste feet present, perimeter_ref blank (reference only)
  const totalLine = lines.find((l) => l.startsWith("TOTAL"))!;
  const totalCells = totalLine.split(",");
  assert.equal(totalCells.length, 16);
  assert.equal(Number(totalCells[13]), round2(1373.76 - 1316.91));
  assert.equal(Number(totalCells[14]), round2(136.34 - 129.85));
  assert.equal(totalCells[15], "");
});

// ── custom (user-defined) condition columns (issue #34) ─────────────────────

test("customColProfile: descriptors from definitions; get reads ctx and coerces non-strings", () => {
  const cols = customColProfile([
    { id: "c9", name: "CSI Division", values: ["09 68 00"] },
    { id: "c0", name: "", values: [] },              // empty name → display fallback
  ]);
  assert.deepEqual(cols.map((c: any) => [c.key, c.header, c.defaultVisible, c.custom]), [
    ["custom:c9", "CSI Division", false, true],
    ["custom:c0", "Untitled", false, true],
  ]);
  const ctx = { attrsByCond: new Map([["ct1", { c9: "09 68 00", c0: 42 }]]) };
  assert.equal(cols[0].get({ id: "ct1" }, ctx), "09 68 00");
  assert.equal(cols[1].get({ id: "ct1" }, ctx), "");   // non-string coerced to ""
  assert.equal(cols[0].get({ id: "zz" }, ctx), "");    // unassigned condition
  assert.equal(cols[0].get({ id: "ct1" }), "");        // no ctx at all
  assert.deepEqual(customColProfile(null), []);
  assert.deepEqual(customColProfile(undefined), []);
  // truthy non-arrays from a corrupted payload must not throw
  assert.deepEqual(customColProfile({ id: "c9" } as any), []);
  assert.deepEqual(customColProfile("c9" as any), []);
});

test("CSV with custom columns: hostile headers escaped, values per row, TOTAL blank, frozen 13 untouched", () => {
  const defs = [
    { id: "div", name: "CSI Division, 2020", values: ["09 68 00", "09 65 00"] },  // comma → quoted
    { id: "inj", name: "=SUM(A1:A9)", values: [] },                               // formula → ' guard
  ];
  const cols = [...visibleCols(CSV_PROFILE, {}), ...customColProfile(defs)];
  const ctx = {
    attrsByCond: new Map([
      ["ct1", { div: "09 68 00" }],
      ["lvt2", { div: "09 65 00", inj: "=HYPERLINK" }],  // formula-shaped VALUE guarded too
    ]),
  };
  const csv = totalsToCsv(rows, projectName, sheetTotals(conditions, shapes), sheetLabel, cols, ctx);
  const lines = csv.split("\n");
  const goldenLines = golden.split("\n");
  // frozen 13 header cells byte-identical, custom headers appended escaped
  assert.equal(lines[1], goldenLines[1] + ',"CSI Division, 2020",\'=SUM(A1:A9)');
  // CT-1 body row = golden row + assigned value + blank (no inj assignment)
  assert.equal(lines[2], goldenLines[2] + ",09 68 00,");
  assert.deepEqual(lines[3].split(",").slice(-2), ["09 65 00", "'=HYPERLINK"]);
  // TOTAL row: custom keys absent from grandTotals → both cells blank
  const totalCells = lines.find((l) => l.startsWith("TOTAL"))!.split(",");
  assert.equal(totalCells.length, 15);
  assert.deepEqual(totalCells.slice(-2), ["", ""]);
});

test("loadColPrefs returns {} without localStorage; saveColPrefs swallows too", () => {
  assert.equal(typeof globalThis.localStorage, "undefined"); // node test env
  assert.deepEqual(loadColPrefs(), {});
  assert.doesNotThrow(() => saveColPrefs({ waste_sf: true }));
});

// ── grouping the report by a custom column (issue #35) ──────────────────────
// fixture rows (shape_count > 0): ct1, lvt2, rb1, wt1, cnt

test("partitionRowsBy: vocabulary order first, ad-hoc sorted after, Unassigned last, empty groups dropped", () => {
  const col = { id: "div", name: "CSI Division", values: ["09 68 00", "09 65 00", "09 30 00"] };
  const attrs = new Map([
    ["ct1", { div: "09 65 00" }],
    ["lvt2", { div: "zz removed" }],   // not in the vocabulary → ad-hoc
    ["rb1", { div: "09 68 00" }],
    ["wt1", { div: "aa removed" }],    // ad-hoc, sorts before "zz removed"
    // cnt has no entry at all → Unassigned
  ]);
  const groups = partitionRowsBy(rows, col, attrs);
  // vocabulary order (NOT assignment order: 09 68 00 before 09 65 00), then
  // ad-hoc sorted, then null last; "09 30 00" (no rows) dropped
  assert.deepEqual(groups.map((g: any) => g.value), ["09 68 00", "09 65 00", "aa removed", "zz removed", null]);
  assert.deepEqual(groups.map((g: any) => g.label), ["09 68 00", "09 65 00", "aa removed", "zz removed", "Unassigned"]);
  assert.deepEqual(groups.map((g: any) => g.rows.map((r: any) => r.id)), [["rb1"], ["ct1"], ["wt1"], ["lvt2"], ["cnt"]]);
});

test("partitionRowsBy: '' and non-string attrs fold into the null group — never an empty-labeled ad-hoc group", () => {
  const col = { id: "d", name: "X", values: ["real"] };
  const attrs = new Map([
    ["ct1", { d: "" }],                // empty string → null group
    ["lvt2", { d: 42 }],               // non-string → null group
    ["rb1", { d: null }],              // null → null group
    ["wt1", {}],                       // key absent → null group
    // cnt: no map entry at all
  ]);
  const groups = partitionRowsBy(rows, col, attrs);
  // everything folded into one group → single-group partition is detectable
  // (ReportPanel suppresses all group chrome on length === 1)
  assert.equal(groups.length, 1);
  assert.equal(groups[0].value, null);
  assert.equal(groups[0].label, "Unassigned");
  assert.equal(groups[0].rows.length, rows.length);
  // no attrsByCond at all → same single Unassigned group
  assert.equal(partitionRowsBy(rows, col, undefined).length, 1);
});

test("partitionRowsBy: a vocabulary value literally named 'Unassigned' stays separate from the null group", () => {
  const col = { id: "d", name: "X", values: ["Unassigned"] };
  const attrs = new Map([["ct1", { d: "Unassigned" }]]);
  const groups = partitionRowsBy(rows, col, attrs);
  assert.deepEqual(groups.map((g: any) => [g.value, g.label]), [["Unassigned", "Unassigned"], [null, "Unassigned"]]);
  assert.deepEqual(groups[0].rows.map((r: any) => r.id), ["ct1"]);
  assert.equal(groups[1].rows.length, rows.length - 1);
});

test("grandTotals over partitioned groups: subtotals match hand-derived sums and reconcile to the whole", () => {
  const col = { id: "d", name: "Type", values: ["hard", "soft"] };
  const attrs = new Map([
    ["ct1", { d: "hard" }], ["rb1", { d: "hard" }],
    ["lvt2", { d: "soft" }], ["wt1", { d: "soft" }], ["cnt", { d: "soft" }],
  ]);
  const groups = partitionRowsBy(rows, col, attrs);
  assert.equal(groups.length, 2);
  const [hard, soft] = groups.map((g: any) => grandTotals(g.rows));
  // hard: ct1 546.9 × 1.10 = 601.59 + rb1 border 43.29 × 1.05 = 45.45
  assert.equal(hard.total_sf_net, 647.04);
  // soft: lvt2 210.55 × 2 = 421.1 + wt1 wall 305.62 (cnt contributes 0 SF)
  assert.equal(soft.total_sf_net, 726.72);
  // groups partition the rows, so subtotals reconcile to the grand total
  const whole = grandTotals(rows);
  assert.equal(round2(hard.total_sf_net + soft.total_sf_net), whole.total_sf_net);
  assert.equal(hard.ea + soft.ea, whole.ea);
});

test("forceIncludeGroupCol: hidden group-by column appended exactly once; visible → untouched", () => {
  const defs = [{ id: "div", name: "CSI Division", values: [] }];
  const customCols = customColProfile(defs);
  // hidden (defaultVisible: false, no pref) → appended at the very end
  const hidden = visibleCols([...CSV_PROFILE, ...customCols], {});
  const forced = forceIncludeGroupCol(hidden, customCols, "div");
  assert.equal(forced.length, hidden.length + 1);
  assert.equal(forced[forced.length - 1].key, "custom:div");
  assert.equal(forced.filter((c: any) => c.key === "custom:div").length, 1);
  // already visible via the picker → same array back, no duplicate
  const visible = visibleCols([...CSV_PROFILE, ...customCols], { "custom:div": true });
  assert.equal(forceIncludeGroupCol(visible, customCols, "div"), visible);
  assert.equal(visible.filter((c: any) => c.key === "custom:div").length, 1);
  // not grouping / not a custom column ("sheet" once #36 lands) → untouched
  assert.equal(forceIncludeGroupCol(hidden, customCols, ""), hidden);
  assert.equal(forceIncludeGroupCol(hidden, customCols, "sheet"), hidden);
});

test("loadGroupBy returns '' without localStorage; saveGroupBy swallows too", () => {
  assert.equal(typeof globalThis.localStorage, "undefined"); // node test env
  assert.equal(loadGroupBy(), "");
  assert.doesNotThrow(() => saveGroupBy("col-x"));
});

// ── read-only product-spec columns (schedule import) ────────────────────────
// condition.spec = { manufacturer, style, color, size }; ABSENT when no spec.
// fixture rows (shape_count > 0): ct1, lvt2, rb1, wt1, cnt — none carry a spec.

test("specValue: the visible-string rule — object required, non-strings/empties/whitespace are nothing", () => {
  assert.equal(specValue({ manufacturer: "Shaw" }, "manufacturer"), "Shaw");
  assert.equal(specValue({ manufacturer: "  keep spaces  " }, "manufacturer"), "  keep spaces  "); // untrimmed
  assert.equal(specValue({ style: "" }, "style"), "");
  assert.equal(specValue({ style: "   " }, "style"), "");        // whitespace-only
  assert.equal(specValue({ size: 12 } as any, "size"), "");      // non-string coerced away
  assert.equal(specValue({ manufacturer: "Shaw" }, "color"), ""); // missing field
  assert.equal(specValue(undefined, "manufacturer"), "");
  assert.equal(specValue(null, "manufacturer"), "");
  assert.equal(specValue("Shaw" as any, "manufacturer"), "");    // non-object
  assert.equal(specValue(["Shaw"] as any, "manufacturer"), "");  // arrays aren't specs
});

test("specColProfile: no spec anywhere → [] (byte-stable), so the report/CSV/XLSX are unchanged", () => {
  assert.deepEqual(specColProfile(conditions), []);              // the fixture: no specs
  assert.deepEqual(specColProfile([]), []);
  assert.deepEqual(specColProfile(null as any), []);             // corrupted payloads don't throw
  assert.deepEqual(specColProfile(undefined as any), []);
  assert.deepEqual(specColProfile([{ id: "x", spec: {} }] as any), []);            // empty spec object
  assert.deepEqual(specColProfile([{ id: "x", spec: { manufacturer: "  " } }] as any), []); // whitespace-only
});

test("specColProfile: a field-column appears only when some condition carries that field", () => {
  const withSpec = [
    { id: "ct1", spec: { manufacturer: "Shaw", style: "Grand", color: "Slate 5", size: '24\"x24\"' } },
    { id: "lvt2", spec: { manufacturer: "Mohawk" } },  // only manufacturer present
    { id: "rb1" },                                      // no spec at all
  ];
  const cols = specColProfile(withSpec);
  // every field is present across the set → all four columns, in schedule order
  assert.deepEqual(cols.map((c: any) => [c.key, c.header, c.defaultVisible, c.spec]), [
    ["spec:manufacturer", "Manufacturer", true, true],
    ["spec:style", "Style", true, true],
    ["spec:color", "Spec Color", true, true],   // "Spec Color", never "Color"
    ["spec:size", "Size", true, true],
  ]);
  // only manufacturer populated anywhere → exactly one column
  const one = specColProfile([{ id: "a", spec: { manufacturer: "Shaw" } }] as any);
  assert.deepEqual(one.map((c: any) => c.key), ["spec:manufacturer"]);
  // headers cover every SPEC_FIELD, and none collides with the appearance "Color".
  // "Description" is appended last so shipped spec-column order is preserved.
  assert.deepEqual(SPEC_FIELDS.map((f: any) => f.header), ["Manufacturer", "Style", "Spec Color", "Size", "Description"]);
});

test("specColProfile: description is a spec column, appended after size, only when populated", () => {
  // populated description → its own column, LAST (after the original four)
  const withDesc = specColProfile([
    { id: "wp1", spec: { manufacturer: "Shaw", description: "WOOD WALL PANEL" } },
  ] as any);
  assert.deepEqual(withDesc.map((c: any) => c.key), ["spec:manufacturer", "spec:description"]);
  assert.equal(withDesc[1].header, "Description");
  // empty/absent description → no column (empty-gate), so legacy 4-field specs
  // produce byte-identical output
  const noDesc = specColProfile([{ id: "a", spec: { manufacturer: "Shaw", size: "12x24" } }] as any);
  assert.deepEqual(noDesc.map((c: any) => c.key), ["spec:manufacturer", "spec:size"]);
});

test("spec column getter: reads ctx.specByCond by row id; blank for unspec'd / no ctx", () => {
  const cols = specColProfile([{ id: "ct1", spec: { manufacturer: "Shaw" } }] as any);
  const ctx = { specByCond: new Map([["ct1", { manufacturer: "Shaw" }]]) };
  assert.equal(cols[0].get({ id: "ct1" }, ctx), "Shaw");
  assert.equal(cols[0].get({ id: "lvt2" }, ctx), "");   // condition with no spec entry
  assert.equal(cols[0].get({ id: "ct1" }), "");         // no ctx at all
});

test("CSV with spec columns: appended after the frozen 13, values per row, unspec'd rows blank, TOTAL blank", () => {
  // ct1 fully spec'd, lvt2 formula-shaped value (guarded), others unspec'd
  const specByCond = new Map<string, any>([
    ["ct1", { manufacturer: "Shaw", style: "Grand, Deluxe", color: "Slate 5", size: '24\"x24\"' }],
    ["lvt2", { manufacturer: "=cmd", style: "", color: "Oak", size: "6x48" }],
  ]);
  const specDefs = [...specByCond.values()].map((s) => ({ spec: s }));
  const cols = [...visibleCols(CSV_PROFILE, {}), ...specColProfile(specDefs as any)];
  const csv = totalsToCsv(rows, projectName, sheetTotals(conditions, shapes), sheetLabel, cols, { specByCond });
  const lines = csv.split("\n");
  const goldenLines = golden.split("\n");
  // frozen 13 header cells byte-identical; spec headers appended, schedule order
  assert.equal(lines[1], goldenLines[1] + ",Manufacturer,Style,Spec Color,Size");
  // CT-1 body row = golden row + its four spec cells (comma value quoted)
  assert.equal(lines[2], goldenLines[2] + ',Shaw,"Grand, Deluxe",Slate 5,"24""x24"""');
  // LVT-2: formula-shaped manufacturer guarded, empty style blank
  assert.deepEqual(lines[3].split(",").slice(-4), ["'=cmd", "", "Oak", "6x48"]);
  // RB-1: no spec entry → all four cells blank
  assert.deepEqual(lines[4].split(",").slice(-4), ["", "", "", ""]);
  // TOTAL row: spec keys absent from grandTotals → all four cells blank
  const totalCells = lines.find((l) => l.startsWith("TOTAL"))!.split(",");
  assert.equal(totalCells.length, 17);   // 13 frozen + 4 spec
  assert.deepEqual(totalCells.slice(-4), ["", "", "", ""]);
});

test("CSV is byte-identical to golden when no condition has a spec (spec cols contribute nothing)", () => {
  // the whole point of the omit-when-empty rule: appending specColProfile of a
  // no-spec project adds no columns, so the export matches the frozen golden
  const cols = [...visibleCols(CSV_PROFILE, {}), ...specColProfile(conditions)];
  const csv = totalsToCsv(rows, projectName, sheetTotals(conditions, shapes), sheetLabel, cols);
  assert.equal(csv, golden);
});

// ── roll-goods columns (#136) ────────────────────────────────────────────────

test("rollColProfile: empty without figured layouts; ×N-applied getters through ctx; metric converts order LF", async () => {
  const { rollColProfile, applyUnits } = await import("../src/lib/reportColumns.js");
  assert.deepEqual(rollColProfile(null), []);
  assert.deepEqual(rollColProfile(new Map()), [], "no roll conditions → zero extra columns (golden CSV byte-safe)");
  const rollByCond = new Map([["c1", { orderFt: 29, rollCount: 2, seamLf: 30 }]]);
  const cols = rollColProfile(rollByCond);
  assert.deepEqual(cols.map((c: any) => [c.key, c.header]),
    [["roll:order_lf", "Roll Order LF"], ["roll:rolls", "Rolls"], ["roll:seam_lf", "Seam LF"]]);
  const ctx = { rollByCond };
  const row = { id: "c1", multiplier: 3 };
  assert.equal(cols[0].get(row, ctx), 87, "order LF ×N");
  assert.equal(cols[1].get(row, ctx), 6, "rolls ×N");
  assert.equal(cols[2].get(row, ctx), 90, "figured seam LF ×N — N units are N cuttings of the same layout");
  assert.equal(cols[0].get({ id: "other", multiplier: 1 }, ctx), "", "a non-roll condition's cell is blank");
  // a summary predating the seam figure reads 0, never NaN
  const legacy = new Map([["c1", { orderFt: 10, rollCount: 1 }]]);
  assert.equal(rollColProfile(legacy)[2].get(row, { rollByCond: legacy }), 0);
  // metric: the LF columns convert at the descriptor like every dimensioned column
  const [mOrder, , mSeam] = applyUnits(cols, "metric");
  assert.equal(mOrder.header, "Roll Order m");
  assert.equal(mOrder.get(row, ctx), round2(87 * 0.3048));
  assert.equal(mSeam.header, "Seam m");
  assert.equal(mSeam.get(row, ctx), round2(90 * 0.3048));
});

// ── metric unit-system conversion (Task 4) ──────────────────────────────────
// applyUnits is the single seam: it wraps getters and foot functions at the
// column descriptor so every output (table, CSV, XLSX) reads the same
// converted value. Imperial is an identity pass-through (byte-compatible).

test("applyUnits with imperial: returns cols unchanged (identity passthrough)", () => {
  const cols = visibleCols(CSV_PROFILE, {});
  const result = applyUnits(cols, "imperial");
  assert.strictEqual(result, cols, "same array reference — no wrapping");
  // every getter returns the raw value
  const r = rows[0];
  for (const c of result) {
    const get = colGetter(c);
    if (get) assert.equal(get(r), (GETTERS as any)[c.key]?.(r), `${c.key} getter unchanged`);
  }
});

test("applyUnits with metric: sy_net filtered out", () => {
  const cols = visibleCols(CSV_PROFILE, {});
  const metric = applyUnits(cols, "metric");
  assert.ok(!metric.some((c: any) => c.key === "sy_net"), "sy_net removed from metric columns");
  // TABLE_PROFILE also filters sy_net
  const tableMetric = applyUnits(visibleCols(TABLE_PROFILE, {}), "metric");
  assert.ok(!tableMetric.some((c: any) => c.key === "sy_net"));
});

test("applyUnits with metric: area columns convert with M2_PER_SF and swap SF→m² in headers", () => {
  const areaKeys = ["floor_sf", "wall_sf", "border_sf", "total_sf", "total_sf_net", "waste_sf"];
  const cols = visibleCols(CSV_PROFILE, { waste_sf: true });
  const metric = applyUnits(cols, "metric");
  const M2 = 0.09290304;
  // use a simple mock row with known values to test the getter conversion
  const mockRow: any = { id: "x", floor_sf: 100, wall_sf: 200, border_sf: 50, total_sf: 350, total_sf_net: 385, waste_sf: 35 };
  for (const key of areaKeys) {
    const col = metric.find((c: any) => c.key === key);
    assert.ok(col, `area column ${key} present in metric`);
    assert.ok(col.header.includes("m²"), `${key} header contains m²: ${col.header}`);
    assert.ok(!col.header.includes("SF"), `${key} header no longer contains SF`);
    // getter converts the raw value
    const rawVal = mockRow[key];
    assert.equal(col.get(mockRow), round2(rawVal * M2), `${key} getter converts`);
  }
});

test("applyUnits with metric: length columns convert with M_PER_FT and swap LF→m in headers", () => {
  const lenKeys = ["lf", "lf_net", "waste_lf", "perimeter_ref"];
  const cols = visibleCols(CSV_PROFILE, { waste_lf: true, perimeter_ref: true });
  const metric = applyUnits(cols, "metric");
  const M = 0.3048;
  const mockRow: any = { id: "x", lf: 200, lf_net: 220, waste_lf: 20 };
  // perimeter_ref getter reads from ctx.perimByCond, not from the row directly
  const ctx = { perimByCond: new Map([["x", 150]]) };
  for (const key of lenKeys) {
    const col = metric.find((c: any) => c.key === key);
    assert.ok(col, `length column ${key} present in metric`);
    assert.ok(col.header.includes("m"), `${key} header contains m: ${col.header}`);
    assert.ok(!col.header.includes("LF"), `${key} header no longer contains LF`);
    // getter converts the raw value — perimeter_ref needs ctx
    const rawVal = key === "perimeter_ref" ? 150 : mockRow[key];
    assert.equal(col.get(mockRow, ctx), round2(rawVal * M), `${key} getter converts`);
  }
});

test("applyUnits with metric: non-dimensional columns pass through unchanged", () => {
  const nonDimKeys = ["finish", "shapes", "multiplier", "waste_pct", "ea"];
  const cols = visibleCols(CSV_PROFILE, {});
  const metric = applyUnits(cols, "metric");
  for (const key of nonDimKeys) {
    const col = metric.find((c: any) => c.key === key);
    assert.ok(col, `non-dimensional column ${key} present`);
    // header unchanged (no SF/LF replacement applies)
    const orig = cols.find((c: any) => c.key === key);
    assert.equal(col.header, orig.header, `${key} header unchanged`);
    // getter unchanged
    const r = rows[0];
    const mGet = colGetter(col);
    const oGet = colGetter(orig!);
    if (mGet && oGet) assert.equal(mGet(r), oGet(r), `${key} getter unchanged`);
  }
});

test("applyUnits with metric: foot (tfoot) functions wrap with converter", () => {
  // TABLE_PROFILE has foot functions; CSV_PROFILE does not.
  // total_sf is defaultVisible: false, so explicitly enable it in prefs.
  const tableCols = visibleCols(TABLE_PROFILE, { waste_sf: true, total_sf: true });
  const metric = applyUnits(tableCols, "metric");
  const M2 = 0.09290304;
  const g = grandTotals(rows); // raw imperial grand totals
  // total_sf has a foot function on TABLE_PROFILE
  const tsfCol = metric.find((c: any) => c.key === "total_sf");
  assert.ok(tsfCol, "total_sf present");
  assert.ok(tsfCol.foot, "total_sf has foot");
  // foot(g) should return the metric-converted grand total
  const footVal = tsfCol.foot(g);
  assert.equal(footVal, round2(g.total_sf * M2), "total_sf foot converts with M2_PER_SF");
  // total_sf_net foot
  const tsnCol = metric.find((c: any) => c.key === "total_sf_net");
  assert.ok(tsnCol?.foot, "total_sf_net has foot");
  assert.equal(tsnCol.foot(g), round2(g.total_sf_net * M2), "total_sf_net foot converts");
  // waste_sf foot
  const wsCol = metric.find((c: any) => c.key === "waste_sf");
  if (wsCol?.foot) {
    // grandTotals always has numeric values, so waste_sf is numeric here
    const wasteVal = GETTERS.waste_sf(g) as number;
    assert.equal(wsCol.foot(g), round2(wasteVal * M2), "waste_sf foot converts");
  }
});

test("applyUnits with METRIC_CSV_LABELS: uses 'm2'/'m' for CSV/XLSX (ASCII)", () => {
  const cols = visibleCols(CSV_PROFILE, {});
  const csvMetric = applyUnits(cols, "metric", METRIC_CSV_LABELS);
  const tableMetric = applyUnits(cols, "metric", METRIC_LABELS);
  const csvFloor = csvMetric.find((c: any) => c.key === "floor_sf");
  const tableFloor = tableMetric.find((c: any) => c.key === "floor_sf");
  assert.ok(csvFloor.header.includes("m2"), `CSV uses ASCII m2: ${csvFloor.header}`);
  assert.ok(tableFloor.header.includes("m²"), `table uses Unicode m²: ${tableFloor.header}`);
  // length columns
  const csvLf = csvMetric.find((c: any) => c.key === "lf");
  const tableLf = tableMetric.find((c: any) => c.key === "lf");
  // both use "m" for length (no difference)
  assert.ok(csvLf.header.includes("m"), `CSV length header has m: ${csvLf.header}`);
  assert.ok(tableLf.header.includes("m"), `table length header has m: ${tableLf.header}`);
});

test("applyUnits with metric: no double conversion — applying the wrapped getter once matches the conversion constant", () => {
  const cols = visibleCols(CSV_PROFILE, {});
  const metric = applyUnits(cols, "metric");
  const M2 = 0.09290304, M = 0.3048;
  // pick a row from the fixture
  const r = rows[0]; // ct1
  for (const c of metric) {
    if (c.key === "finish" || c.key === "shapes" || c.key === "multiplier" ||
        c.key === "waste_pct" || c.key === "ea" || c.key === "sy_net") continue;
    const get = colGetter(c);
    if (!get) continue;
    const val = get(r);
    const raw = colGetter(cols.find((x: any) => x.key === c.key)!)?.(r);
    if (raw == null || raw === "") continue;
    const expected = c.key.includes("sf") || c.key === "border_sf" || c.key === "floor_sf" ||
      c.key === "wall_sf" || c.key === "total_sf" || c.key === "total_sf_net" || c.key === "waste_sf"
      ? round2(Number(raw) * M2) : round2(Number(raw) * M);
    assert.equal(val, expected, `${c.key}: wrapped getter = one conversion (no double)`);
  }
});

test("applyUnits with metric CSV: end-to-end — body rows and TOTAL row convert exactly once", () => {
  const csvCols = visibleCols(CSV_PROFILE, { waste_sf: true, waste_lf: true });
  const ctx = { perimByCond: floorPerimeterLf(shapes) };
  const csv = totalsToCsv(rows, projectName, sheetTotals(conditions, shapes), sheetLabel, csvCols, ctx, null, "OpenTakeoff", "metric");
  const lines = csv.split("\n");
  const header = lines[1];
  // header swaps SF→m², LF→m (Unicode labels from METRIC_LABELS)
  assert.ok(header.includes("m²"), `metric CSV header has m²: ${header}`);
  assert.ok(!header.includes("SF"), `metric CSV header has no SF: ${header}`);
  assert.ok(!header.includes("SY"), `metric CSV header has no SY column: ${header}`);
  // CT-1 body row: floor_sf = 546.9 → 546.9 × 0.09290304 ≈ 50.81
  // NOTE: the finish tag "CT-1, honed" contains a comma (CSV-quoted), so we
  // can't use simple split. Instead, verify the TOTAL row (which has no comma).
  const M2 = 0.09290304;
  const totalLine = lines.find((l: string) => l.startsWith("TOTAL"))!;
  assert.ok(totalLine, "TOTAL row exists");
  const totalCells = totalLine.split(",");
  // TOTAL row has: TOTAL,,,,,,<total_sf>,... — find total_sf via header position
  // header: Finish,Shapes,Multiplier,...,Total SF,...,SY w/Waste (removed),LF w/Waste,Waste SF,Waste LF
  // TOTAL has "TOTAL" at index 0, empty for shapes/multiplier, waste_pct blank
  // total_sf is the 8th column (0-indexed: 7) in the default CSV profile
  // But metric removes sy_net, shifting positions. Instead, parse header to find index.
  const headerCells = header.split(",");
  const totalSfIdx = headerCells.findIndex((h: string) => h.includes("Total"));
  assert.ok(totalSfIdx > 0, "Total SF column found in header");
  const totalSfVal = Number(totalCells[totalSfIdx]);
  const g = grandTotals(rows);
  assert.equal(totalSfVal, round2(g.total_sf * M2), "TOTAL row total_sf converted");
  // ea column: count should be unchanged
  const eaIdx = headerCells.findIndex((h: string) => h === "EA");
  assert.ok(eaIdx > 0, "EA column found in header");
  const totalEa = Number(totalCells[eaIdx]);
  assert.equal(totalEa, g.ea, "TOTAL row ea unchanged (count)");
  // lf column: should be converted
  const lfIdx = headerCells.findIndex((h: string) => h === "m");
  assert.ok(lfIdx > 0, "LF→m column found in header");
  const totalLf = Number(totalCells[lfIdx]);
  assert.equal(totalLf, round2(g.lf * 0.3048), "TOTAL row lf converted to m");
});

test("applyUnits with metric CSV: by-sheet and by-label sections use correct conversions", () => {
  const csvCols = visibleCols(CSV_PROFILE, {});
  const bySheet = sheetTotals(conditions, shapes);
  const ctx = { perimByCond: floorPerimeterLf(shapes) };
  // label rows use ct1 and lvt2
  const labelRows = [rows[0], rows[1]]; // ct1 and lvt2
  const byLabel = [{ value: "test-label", label: "Test", rows: labelRows }];
  const csv = totalsToCsv(rows, projectName, bySheet, sheetLabel, csvCols, ctx, byLabel, "OpenTakeoff", "metric");
  const lines = csv.split("\n");
  // by-sheet section header should have m2 for area columns
  const bySheetHeader = lines.find((l: string) => l.startsWith("Sheet,"));
  assert.ok(bySheetHeader, "by-sheet header exists");
    assert.ok(bySheetHeader.includes("m²"), `by-sheet header has m²: ${bySheetHeader}`);
  // by-label section header
  const byLabelHeader = lines.find((l: string) => l.startsWith("Label,"));
  assert.ok(byLabelHeader, "by-label header exists");
    assert.ok(byLabelHeader.includes("m²"), `by-label header has m²: ${byLabelHeader}`);
});

// ── blank/missing value preservation in metric conversion ─────────────────

test("applyUnits with metric: blank/null/undefined values stay blank, not converted to 0", () => {
  const cols = visibleCols(CSV_PROFILE, { waste_lf: true, perimeter_ref: true });
  const metric = applyUnits(cols, "metric");
  const ctx = { perimByCond: new Map([["x", 150]]) };
  // blank row — no perimeter data, so perimeter_ref getter returns 0 from ctx,
  // but test a column whose getter would return the row value
  const blankRow: any = { id: "x", lf: "", wall_sf: null, border_sf: undefined, waste_lf: "", perimeter_ref: "" };
  for (const c of metric) {
    const get = colGetter(c);
    if (!get) continue;
    if (c.key === "lf") {
      // lf getter reads r.lf directly — "" must stay ""
      assert.equal(get(blankRow, ctx), "", `lf blank preserved`);
    } else if (c.key === "wall_sf") {
      assert.equal(get(blankRow, ctx), "", `wall_sf null preserved`);
    } else if (c.key === "border_sf") {
      assert.equal(get(blankRow, ctx), "", `border_sf undefined preserved`);
    } else if (c.key === "waste_lf") {
      // waste_lf = lf_net - lf — both "" → NaN → round2(NaN) must not blow up
      // the conv wrapper catches "" first, but the getter itself runs on the row
    } else if (c.key === "perimeter_ref") {
      // perimeter_ref reads from ctx.perimByCond, not the row
      assert.equal(get(blankRow, ctx), round2(150 * 0.3048), `perimeter_ref converts from ctx`);
    }
  }
  // a genuinely 0 value must NOT become blank — zero is numeric, not missing
  const zeroRow: any = { id: "x", lf: 0, wall_sf: 0, border_sf: 0, waste_lf: 0 };
  for (const c of metric) {
    const get = colGetter(c);
    if (!get) continue;
    if (c.key === "lf" || c.key === "wall_sf" || c.key === "border_sf") {
      const v = get(zeroRow, ctx);
      assert.equal(typeof v, "number", `${c.key} zero stays numeric`);
      assert.ok(Number.isFinite(v), `${c.key} zero is finite`);
    }
  }
});

test("applyUnits metric conv preserves blank in foot (tfoot) function", () => {
  const tableCols = visibleCols(TABLE_PROFILE, { total_sf: true });
  const metric = applyUnits(tableCols, "metric");
  // waste_sf foot calls GETTERS.waste_sf(g) which can return 0
  const gWithZeros = { total_sf: 0, total_sf_net: 0, lf: 0, lf_net: 0, ea: 0, sy_net: 0 };
  const tsfCol = metric.find((c: any) => c.key === "total_sf");
  assert.ok(tsfCol?.foot, "total_sf has foot");
  // 0 * M2_PER_SF = 0, which is a legitimate zero, not blank
  const footVal = tsfCol.foot(gWithZeros);
  assert.equal(typeof footVal, "number", "foot returns number for zero");
  assert.equal(footVal, 0, "foot returns 0 for zero input");
});

// ── roll columns with grouped context ─────────────────────────────────────

test("roll columns read from ctx.rollByCond in grouped contexts", async () => {
  const { rollColProfile } = await import("../src/lib/reportColumns.js");
  const rollByCond = new Map([["c1", { orderFt: 29, rollCount: 2, seamLf: 30 }]]);
  const cols = rollColProfile(rollByCond);
  assert.ok(cols.length > 0, "roll columns present");
  // grouped context that includes rollByCond — simulates what ReportPanel does
  const groupedCtx = { rollByCond };
  const row = { id: "c1", multiplier: 1 };
  assert.equal(cols[0].get(row, groupedCtx), 29, "roll:order_lf reads from grouped ctx");
  assert.equal(cols[1].get(row, groupedCtx), 2, "roll:rolls reads from grouped ctx");
  assert.equal(cols[2].get(row, groupedCtx), 30, "roll:seam_lf reads from grouped ctx");
  // non-roll condition: blank
  const otherRow = { id: "other", multiplier: 1 };
  assert.equal(cols[0].get(otherRow, groupedCtx), "", "non-roll condition stays blank");
});

test("roll columns metric conversion in grouped context preserves blank for non-roll", async () => {
  const { rollColProfile, applyUnits } = await import("../src/lib/reportColumns.js");
  const rollByCond = new Map([["c1", { orderFt: 29, rollCount: 2, seamLf: 30 }]]);
  const cols = rollColProfile(rollByCond);
  const metric = applyUnits(cols, "metric");
  assert.equal(metric.length, 3, "all roll columns present in metric");
  const groupedCtx = { rollByCond };
  const row = { id: "c1", multiplier: 1 };
  // converted values
  assert.equal(metric[0].get(row, groupedCtx), round2(29 * 0.3048), "metric roll:order_lf converts");
  assert.equal(metric[2].get(row, groupedCtx), round2(30 * 0.3048), "metric roll:seam_lf converts");
  // non-roll: blank (not 0)
  const otherRow = { id: "other", multiplier: 1 };
  const blankVal = metric[0].get(otherRow, groupedCtx);
  assert.equal(blankVal, "", "non-roll stays blank in metric (not converted to 0)");
});

// ── metric picker: sy_net hidden, dimensional headers converted ──────────
// The column picker derives descriptors from applyUnits(tableProfile, units).
// In metric mode: sy_net is filtered out, SF→m² and LF→m in headers, and
// non-dimensional columns (finish, shapes, ea, waste_pct) keep their original
// headers. Keys remain the original stable keys for colPrefs toggling.

test("applyUnits on TABLE_PROFILE for metric picker: sy_net removed, dimensional headers converted", () => {
  const pickerCols = applyUnits(TABLE_PROFILE, "metric");
  const keys = pickerCols.map((c: any) => c.key);
  // sy_net must not appear — it retires in metric
  assert.ok(!keys.includes("sy_net"), "sy_net filtered from metric picker");
  // finish stays unchanged
  const finish = pickerCols.find((c: any) => c.key === "finish");
  assert.ok(finish, "finish present");
  // dimensional columns get metric headers
  const floorSf = pickerCols.find((c: any) => c.key === "floor_sf");
  assert.ok(floorSf, "floor_sf present");
  assert.ok(floorSf.header.includes("m²"), `floor_sf header has m²: ${floorSf.header}`);
  const lfCol = pickerCols.find((c: any) => c.key === "lf");
  assert.ok(lfCol, "lf present");
  assert.ok(lfCol.header.includes("m"), `lf header has m: ${lfCol.header}`);
  assert.ok(!lfCol.header.includes("LF"), `lf header no longer has LF: ${lfCol.header}`);
  // non-dimensional columns keep original headers
  const eaCol = pickerCols.find((c: any) => c.key === "ea");
  const origEa = TABLE_PROFILE.find((c: any) => c.key === "ea");
  assert.ok(eaCol, "ea present");
  assert.ok(origEa, "orig ea present in TABLE_PROFILE");
  assert.equal(eaCol.header, origEa.header, "ea header unchanged in metric picker");
  // keys are preserved (the original stable keys, not mangled)
  assert.ok(keys.includes("floor_sf"), "key floor_sf preserved");
  assert.ok(keys.includes("lf"), "key lf preserved");
  assert.ok(keys.includes("waste_sf"), "key waste_sf preserved");
});

test("applyUnits on TABLE_PROFILE for imperial picker: all columns present, headers unchanged", () => {
  const pickerCols = applyUnits(TABLE_PROFILE, "imperial");
  // imperial is identity — same columns, same headers
  assert.equal(pickerCols.length, TABLE_PROFILE.length, "imperial has all columns");
  for (let i = 0; i < TABLE_PROFILE.length; i++) {
    assert.equal(pickerCols[i].header, TABLE_PROFILE[i].header, `${TABLE_PROFILE[i].key} header unchanged in imperial`);
    assert.equal(pickerCols[i].key, TABLE_PROFILE[i].key, `${TABLE_PROFILE[i].key} key unchanged in imperial`);
  }
});

// ── i18n regression: spec/labor/roll headers must follow the active locale ─

test("specColProfile headers resolve through i18n (English default)", () => {
  const withSpec = [
    { id: "ct1", spec: { manufacturer: "Shaw", style: "Grand", color: "Slate 5", size: '24"x24"', description: "Wood panel" } },
  ];
  const cols = specColProfile(withSpec as any);
  assert.deepEqual(cols.map((c: any) => c.header), [
    "Manufacturer", "Style", "Spec Color", "Size", "Description",
  ]);
});

test("laborColProfile headers resolve through i18n (English default)", () => {
  const withLabor = [
    { id: "ct1", laborType: "Glue-down", subfloorType: "Concrete" },
  ];
  const cols = laborColProfile(withLabor as any);
  assert.deepEqual(cols.map((c: any) => c.header), ["Labor Type", "Subfloor Type"]);
});

test("rollColProfile headers resolve through i18n (English default)", () => {
  const rollByCond = new Map([["c1", { orderFt: 29, rollCount: 2, seamLf: 30 }]]);
  const cols = rollColProfile(rollByCond);
  assert.deepEqual(cols.map((c: any) => c.header), ["Roll Order LF", "Rolls", "Seam LF"]);
});

test("spec/labor/roll headers follow locale switch to pt-BR", async () => {
  const i18n = (await import("../src/i18n/index.js")).default;
  const prev = i18n.language;
  await i18n.changeLanguage("pt-br");
  try {
    // spec
    const withSpec = [{ id: "ct1", spec: { manufacturer: "Shaw", color: "Slate 5" } }];
    const specCols = specColProfile(withSpec as any);
    assert.deepEqual(specCols.map((c: any) => c.header), ["Fabricante", "Cor (espec.)"],
      "spec headers must follow pt-BR locale");

    // labor
    const withLabor = [{ id: "ct1", laborType: "Glue-down", subfloorType: "Concrete" }];
    const laborCols = laborColProfile(withLabor as any);
    assert.deepEqual(laborCols.map((c: any) => c.header), ["Tipo de Mão de Obra", "Tipo de Contrapiso"],
      "labor headers must follow pt-BR locale");

    // roll
    const rollByCond = new Map([["c1", { orderFt: 29, rollCount: 2, seamLf: 30 }]]);
    const rollCols = rollColProfile(rollByCond);
    assert.deepEqual(rollCols.map((c: any) => c.header), ["Pedido de Rolo LF", "Rolos", "Costura LF"],
      "roll headers must follow pt-BR locale");

    // built-in table columns (already i18n-aware — regression guard)
    const tableCols = getTableProfile();
    const finishCol = tableCols.find((c: any) => c.key === "finish");
    assert.equal(finishCol?.header, "Acabamento", "table profile header must follow pt-BR locale");
  } finally {
    await i18n.changeLanguage(prev);
  }
});

test("spec/labor/roll i18n: locale parity — every i18n key exists in en and pt-br lib.json", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const en = JSON.parse(readFileSync(path.join(root, "public/locales/en/lib.json"), "utf8"));
  const pt = JSON.parse(readFileSync(path.join(root, "public/locales/pt-br/lib.json"), "utf8"));

  const requiredKeys = [
    ...SPEC_FIELDS.map((f: any) => `column.spec_${f.field}`),
    ...LABOR_FIELDS.map((f: any) => `column.${f.field.replace(/([A-Z])/g, "_$1").toLowerCase()}`),
    "column.roll_order_lf", "column.rolls", "column.seam_lf",
  ];
  const missing: string[] = [];
  for (const key of requiredKeys) {
    const segments = key.split(".");
    const enVal = segments.reduce((o: any, s: string) => o?.[s], en);
    const ptVal = segments.reduce((o: any, s: string) => o?.[s], pt);
    if (!enVal || typeof enVal !== "string") missing.push(`en: "${key}" missing`);
    if (!ptVal || typeof ptVal !== "string") missing.push(`pt-br: "${key}" missing`);
  }
  assert.deepEqual(missing, [], `spec/labor/roll i18n locale parity:\n${missing.join("\n")}`);
});

// ── Task 2: metric header/value regression ───────────────────────────────
// Ensure metric CSV/report never leaks SF/LF/ft/in and imperial stays intact.

test("metric CSV: no SF/LF/ft/in leakage in header row", () => {
  const csvCols = visibleCols(CSV_PROFILE, { waste_sf: true, waste_lf: true });
  const csv = totalsToCsv(rows, projectName, null, null, csvCols, null, null, "OpenTakeoff", "metric");
  const header = csv.split("\n")[1];  // line 0 is title, line 1 is header
  assert.ok(!header.includes(" SF "), `metric CSV header must not contain " SF ": ${header}`);
  assert.ok(!header.includes(" LF "), `metric CSV header must not contain " LF ": ${header}`);
  assert.ok(!header.includes(" SY "), `metric CSV header must not contain " SY ": ${header}`);
  assert.ok(header.includes("m²"), `metric CSV header must contain "m²": ${header}`);
  assert.ok(header.includes("m"), `metric CSV header must contain "m": ${header}`);
});

test("metric CSV: TOTAL row values are converted against M2_PER_SF/M_PER_FT", () => {
  const M2 = 0.09290304, M = 0.3048;
  const csvCols = visibleCols(CSV_PROFILE, {});
  const csv = totalsToCsv(rows, projectName, null, null, csvCols, null, null, "OpenTakeoff", "metric");
  const headerLine = csv.split("\n")[1];
  const totalLine = csv.split("\n").find((l: string) => l.startsWith("TOTAL"));
  assert.ok(totalLine, "TOTAL row exists");
  const totalCells = totalLine.split(",");
  const headerCells = headerLine.split(",");
  const g = grandTotals(rows);
  // Total SF column: converted with M2_PER_SF
  const totalSfIdx = headerCells.findIndex((h: string) => h.includes("Total"));
  assert.ok(totalSfIdx > 0, "Total m2 column found");
  assert.equal(Number(totalCells[totalSfIdx]), round2(g.total_sf * M2), "TOTAL total_sf converted with M2_PER_SF");
  // LF column: converted with M_PER_FT
  const lfIdx = headerCells.findIndex((h: string) => h === "m");
  assert.ok(lfIdx > 0, "m column found for LF");
  assert.equal(Number(totalCells[lfIdx]), round2(g.lf * M), "TOTAL lf converted with M_PER_FT");
  // EA column: unchanged (count)
  const eaIdx = headerCells.findIndex((h: string) => h === "EA");
  assert.ok(eaIdx > 0, "EA column found");
  assert.equal(Number(totalCells[eaIdx]), g.ea, "TOTAL ea unchanged (count)");
  // TOTAL row must not contain bare unit strings
  for (const cell of totalCells) {
    assert.ok(!/^\s*SF\s*$/.test(cell), `TOTAL cell must not be bare "SF": "${cell}"`);
    assert.ok(!/^\s*LF\s*$/.test(cell), `TOTAL cell must not be bare "LF": "${cell}"`);
  }
});

test("imperial CSV: SF/LF headers preserved, byte-compatible with golden", () => {
  const csv = totalsToCsv(rows, projectName, sheetTotals(conditions, shapes), sheetLabel);
  const header = csv.split("\n")[1];
  assert.ok(header.includes("SF"), `imperial CSV header must contain "SF": ${header}`);
  assert.ok(header.includes("LF"), `imperial CSV header must contain "LF": ${header}`);
  assert.equal(csv, golden, "imperial CSV byte-identical to golden");
});

test("roll column metric headers swap LF→m", async () => {
  const { rollColProfile, applyUnits } = await import("../src/lib/reportColumns.js");
  const rollByCond = new Map([["c1", { orderFt: 29, rollCount: 2, seamLf: 30 }]]);
  const cols = rollColProfile(rollByCond);
  const imperialHeaders = cols.map((c: any) => c.header);
  assert.deepEqual(imperialHeaders, ["Roll Order LF", "Rolls", "Seam LF"]);
  // metric: LF → m
  const metricCols = applyUnits(cols, "metric");
  const metricHeaders = metricCols.map((c: any) => c.header);
  assert.ok(metricHeaders[0].includes("m"), `metric roll:order_lf header must contain "m": ${metricHeaders[0]}`);
  assert.ok(!metricHeaders[0].includes("LF"), `metric roll:order_lf header must not contain "LF": ${metricHeaders[0]}`);
  assert.equal(metricHeaders[1], "Rolls", "Rolls is non-dimensional, unchanged");
  assert.ok(metricHeaders[2].includes("m"), `metric roll:seam_lf header must contain "m": ${metricHeaders[2]}`);
  assert.ok(!metricHeaders[2].includes("LF"), `metric roll:seam_lf header must not contain "LF": ${metricHeaders[2]}`);
});

test("metric applyUnits: all dimensional headers use m² or m, never SF/LF", () => {
  const csvCols = visibleCols(CSV_PROFILE, { waste_sf: true, waste_lf: true, perimeter_ref: true });
  const metric = applyUnits(csvCols, "metric");
  for (const c of metric) {
    if (c.key === "finish" || c.key === "shapes" || c.key === "multiplier" ||
        c.key === "waste_pct" || c.key === "ea") continue;
    const h = c.header;
    assert.ok(!h.includes("SF"), `metric header for ${c.key} must not contain "SF": ${h}`);
    assert.ok(!h.includes("LF"), `metric header for ${c.key} must not contain "LF": ${h}`);
  }
});

test("metric CSV: body values don't contain imperial abbreviations", () => {
  const csvCols = visibleCols(CSV_PROFILE, {});
  const csv = totalsToCsv(rows, projectName, null, null, csvCols, null, null, "OpenTakeoff", "metric");
  const lines = csv.split("\n");
  const bodyLines = lines.slice(2).filter((l: string) => l && !l.startsWith("TOTAL"));
  for (const line of bodyLines) {
    assert.ok(!/ SF /.test(line), `metric body line must not contain " SF ": ${line}`);
    assert.ok(!/ LF /.test(line), `metric body line must not contain " LF ": ${line}`);
  }
});

// ── grout display note: grout geometry reaches exports ───────────────────
test("conditionTotals material rows carry grout/kind for display", () => {
  const groutGeo = { tileL: 12, tileW: 12, tileT: 0.375, joint: 0.125, bagLbs: 50 };
  const conds = [{
    id: "c1", finish_tag: "CT-1", materials: [
      { name: "Thinset", unit: "bag", per: 95, basis: "area" },
      { name: "Grout", unit: "bag", per: 100, basis: "area", grout: groutGeo, kind: "grout" },
    ],
  }];
  const shapes = [{ id: "s1", condition_id: "c1", measure_role: "floor_area", computed: { area_sf: 100 } }];
  const [row] = conditionTotals(conds, shapes);
  const thinset = row.materials.find((m: any) => m.name === "Thinset");
  const grout = row.materials.find((m: any) => m.name === "Grout");
  assert.ok(thinset, "Thinset found");
  assert.ok(grout, "Grout found");
  // grout geometry passed through
  assert.deepEqual(grout.grout, groutGeo, "grout geometry passed through");
  assert.equal(grout.kind, "grout", "kind passed through");
  // thinset has no grout/kind (not set)
  assert.equal(thinset.grout, undefined, "thinset has no grout");
  assert.equal(thinset.kind, undefined, "thinset has no kind");
});

test("groutDisplayNote formats grout geometry in metric", async () => {
  const { groutDisplayNote } = await import("../src/lib/coverage.js");
  const m = { grout: { tileL: 12, tileW: 12, tileT: 0.375, joint: 0.125, bagLbs: 50 } };
  const note = groutDisplayNote(m, "metric");
  // metric: tiles converted to mm, joint in mm
  assert.ok(note.includes("305×305×10 mm"), `metric note has tile dimensions: ${note}`);
  assert.ok(note.includes("3.2 mm"), `metric note has joint in mm: ${note}`);
  assert.ok(note.includes("50 lb"), `metric note has bag weight: ${note}`);
  assert.ok(!note.includes("″"), `metric note must not contain inch marks: ${note}`);
});

test("groutDisplayNote formats grout geometry in imperial", async () => {
  const { groutDisplayNote } = await import("../src/lib/coverage.js");
  const m = { grout: { tileL: 12, tileW: 12, tileT: 0.375, joint: 0.125, bagLbs: 50 } };
  const note = groutDisplayNote(m, "imperial");
  // imperial: tiles in inches, joint as fraction
  assert.ok(note.includes("12×12"), `imperial note has tile dimensions: ${note}`);
  assert.ok(note.includes("″"), `imperial note has inch marks: ${note}`);
  assert.ok(note.includes("50 lb"), `imperial note has bag weight: ${note}`);
});

test("groutDisplayNote falls back to m.note when no grout geometry", async () => {
  const { groutDisplayNote } = await import("../src/lib/coverage.js");
  const m = { note: "Custom note" };
  assert.equal(groutDisplayNote(m, "metric"), "Custom note");
  assert.equal(groutDisplayNote(m, "imperial"), "Custom note");
  assert.equal(groutDisplayNote({}, "metric"), "");
});
