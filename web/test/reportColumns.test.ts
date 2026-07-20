// Column-selection library: profiles, prefs, getters, and the column-driven
// CSV. The default-CSV assertion here deliberately overlaps the golden test —
// it locks CSV_PROFILE itself (defaults + order + headers) to the same bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conditionTotals, grandTotals, sheetTotals, totalsToCsv, round2 } from "../src/lib/totals.js";
import {
  GETTERS, CSV_PROFILE, TABLE_PROFILE, customColProfile, specColProfile, specValue, SPEC_FIELDS,
  partitionRowsBy, forceIncludeGroupCol,
  loadColPrefs, saveColPrefs, loadGroupBy, saveGroupBy, visibleCols, floorPerimeterLf,
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

test("waste_sf / waste_lf getters: order minus base, rounded", () => {
  const r = { total_sf: 100.004, total_sf_net: 110.01, lf: 10, lf_net: 10.5 };
  assert.equal(GETTERS.waste_sf(r), 10.01);      // 110.01 − 100.004 = 10.006 → 10.01
  assert.equal(GETTERS.waste_lf(r), 0.5);
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
