import { test } from "node:test";
import assert from "node:assert/strict";
// shapesExport.js is plain JS (allowJs); the tsx loader resolves it from the .ts test.
import { shapesDetail, shapesToCsv, shapesToJson } from "../src/lib/shapesExport.js";
import { conditionTotals } from "../src/lib/totals.js";

const conds = [{ id: "ct", finish_tag: "CT-1" }];
const floor = (id: string, sf: number, lf = 0) =>
  ({ id, sheet_id: "sh1", condition_id: "ct", measure_role: "floor_area", computed: { area_sf: sf, perimeter_lf: lf } });

test("shapesDetail: every shape appears exactly once, input order preserved", () => {
  const shapes = [floor("a", 100), floor("b", 50), floor("c", 25)];
  const rows = shapesDetail(conds, shapes);
  assert.deepEqual(rows.map((r: any) => r.shape_id), ["a", "b", "c"]);
});

test("shapesDetail: signs and roles — deduct negative, count carries EA only, linear carries LF + border SF", () => {
  const shapes = [
    { id: "d", sheet_id: "sh1", condition_id: "ct", measure_role: "deduct", computed: { area_sf: 30 } },
    { id: "n", sheet_id: "sh1", condition_id: "ct", measure_role: "count", computed: { count: 4, area_sf: 999, perimeter_lf: 999 } },
    { id: "l", sheet_id: "sh1", condition_id: "ct", measure_role: "linear", computed: { perimeter_lf: 60, area_sf: 20 } },
  ];
  const [d, n, l] = shapesDetail(conds, shapes);
  assert.equal(d.area_sf, -30);
  assert.equal(n.ea, 4);
  assert.equal(n.area_sf, 0);
  assert.equal(n.lf, 0);
  assert.equal(l.lf, 60);
  assert.equal(l.area_sf, 20);
});

test("shapesDetail: shape rows reconcile with conditionTotals (multiplier 1, no waste)", () => {
  const shapes = [
    floor("a", 120.5, 44),
    floor("b", 80.25, 36),
    { id: "d", sheet_id: "sh1", condition_id: "ct", measure_role: "deduct", computed: { area_sf: 15.75 } },
    { id: "l", sheet_id: "sh1", condition_id: "ct", measure_role: "linear", computed: { perimeter_lf: 22.5 } },
  ];
  const rows = shapesDetail(conds, shapes);
  const [ct] = conditionTotals(conds, shapes);
  const floorRows = rows.filter((r: any) => r.role === "floor_area" || r.role === "deduct");
  assert.equal(floorRows.reduce((n: number, r: any) => n + r.area_sf, 0), ct.floor_sf);
  const linRows = rows.filter((r: any) => r.role === "linear");
  assert.equal(linRows.reduce((n: number, r: any) => n + r.lf, 0), ct.lf);
});

test("shapesDetail: origin column — method passthrough, missing origin is 'untracked'", () => {
  const shapes = [
    { ...floor("a", 10), origin: { method: "one_click_v1" } },
    { ...floor("b", 10), origin: { method: "manual" } },
    floor("c", 10),
  ];
  const rows = shapesDetail(conds, shapes);
  assert.deepEqual(rows.map((r: any) => r.origin), ["one_click_v1", "manual", "untracked"]);
});

test("shapesDetail: height_override only when the flag is literally true", () => {
  const shapes = [
    { id: "w1", sheet_id: "sh1", condition_id: "ct", measure_role: "surface_area", computed: { area_sf: 90 }, height_ft: 9 },
    { id: "w2", sheet_id: "sh1", condition_id: "ct", measure_role: "surface_area", computed: { area_sf: 80 }, height_ft: 8, height_override: true },
  ];
  const [w1, w2] = shapesDetail(conds, shapes);
  assert.equal(w1.height_override, false);
  assert.equal(w1.height_ft, 9);
  assert.equal(w2.height_override, true);
});

test("shapesDetail: height_ft — legacy shapes fall back to the condition height; an override wins outright, even 0", () => {
  const conds9 = [{ id: "ct", finish_tag: "CT-1", height_ft: 9 }];
  const shapes = [
    { id: "legacy", sheet_id: "sh1", condition_id: "ct", measure_role: "surface_area", computed: { area_sf: 90 } },   // predates per-shape heights
    { id: "own", sheet_id: "sh1", condition_id: "ct", measure_role: "surface_area", computed: { area_sf: 80 }, height_ft: 8 },
    { id: "zero", sheet_id: "sh1", condition_id: "ct", measure_role: "surface_area", computed: { area_sf: 0 }, height_ft: 0, height_override: true },
  ];
  const [legacy, own, zero] = shapesDetail(conds9, shapes);
  assert.equal(legacy.height_ft, 9);   // condition fallback — what its SF was computed with
  assert.equal(own.height_ft, 8);
  assert.equal(zero.height_ft, 0);     // overridden 0 stays 0, never the condition's 9
});

test("shapesDetail: surface_area carries wall SF and run LF (reference)", () => {
  const shapes = [{ id: "w", sheet_id: "sh1", condition_id: "ct", measure_role: "surface_area", computed: { area_sf: 270, perimeter_lf: 30 }, height_ft: 9 }];
  const [w] = shapesDetail(conds, shapes);
  assert.equal(w.area_sf, 270);
  assert.equal(w.lf, 30);
  assert.equal(w.ea, 0);
});

test("shapesToCsv: empty project — semantics line + header only", () => {
  const csv = shapesToCsv(shapesDetail(conds, []));
  const lines = csv.split("\n");
  assert.ok(lines[0].startsWith("# Per-shape measured quantities"));
  assert.equal(lines[1], "Shape,Sheet,Sheet ID,Finish,Role,Area SF,LF,EA,Height ft,Height override,Origin");
  assert.equal(lines[2], "");
  assert.equal(lines.length, 3);
});

test("shapesDetail: dangling condition_id tolerated — empty finish", () => {
  const shapes = [{ id: "x", sheet_id: "sh1", condition_id: "gone", measure_role: "floor_area", computed: { area_sf: 10 } }];
  const [row] = shapesDetail(conds, shapes);
  assert.equal(row.finish, "");
});

test("shapesToCsv: title, semantics line, exact header, quoting, negative deduct", () => {
  const conds2 = [{ id: "ct", finish_tag: "CT-1, honed" }];
  const shapes = [
    { id: "a", sheet_id: "sh1", condition_id: "ct", measure_role: "floor_area", computed: { area_sf: 100, perimeter_lf: 40 } },
    { id: "d", sheet_id: "sh1", condition_id: "ct", measure_role: "deduct", computed: { area_sf: 12.5 } },
  ];
  const csv = shapesToCsv(shapesDetail(conds2, shapes), "Job 42");
  const lines = csv.split("\n");
  assert.equal(lines[0], "# Job 42 — OpenTakeoff shapes");
  assert.equal(lines[1], "# Per-shape measured quantities — no multiplier or waste; deducts negative; LF on floor/deduct/surface rows is trace reference only (incl. openings) — linear rows alone sum to condition LF");
  assert.equal(lines[2], "Shape,Sheet,Sheet ID,Finish,Role,Area SF,LF,EA,Height ft,Height override,Origin");
  assert.ok(lines[3].includes('"CT-1, honed"'));
  // full-line equality: the -12.5 deduct is a NUMBER cell — a type-blind
  // formula guard would emit '-12.5 and includes("-12.5") would still pass
  assert.equal(lines[4], 'd,sh1,sh1,"CT-1, honed",deduct,-12.5,0,0,0,,untracked');
  assert.ok(csv.endsWith("\n"));
});

test("shapesToCsv: no title line without a project name", () => {
  const csv = shapesToCsv(shapesDetail(conds, [floor("a", 10)]));
  assert.ok(csv.startsWith("# Per-shape measured quantities"));
});

test("shapesDetail: sheetLabel drives the display label; sheet_id stays raw; omitted falls back", () => {
  const shapes = [floor("a", 10)];
  const [labeled] = shapesDetail(conds, shapes, (id: string) => `Sheet ${id.toUpperCase()}`);
  assert.equal(labeled.sheet, "Sheet SH1");
  assert.equal(labeled.sheet_id, "sh1");
  const [plain] = shapesDetail(conds, shapes);
  assert.equal(plain.sheet, "sh1");
});

test("shapesToJson: schema envelope wraps the rows", () => {
  const rows = shapesDetail(conds, [floor("a", 10)]);
  const j = shapesToJson(rows, "Job 42");
  assert.equal(j.schema, "opentakeoff.shapes.v1");
  assert.equal(j.project_name, "Job 42");
  assert.equal(j.generated_with, "OpenTakeoff");
  assert.deepEqual(j.shapes, rows);
  assert.equal(shapesToJson(rows, "").project_name, null);
});

// ── metric unit-system (Task 4) ─────────────────────────────────────────────
// shapes CSV/JSON are raw canonical exports — data stays in internal feet.
// In metric mode, shapesToCsv converts values and headers to m²/m/m for
// human readability, matching the XLSX shapes tab convention.

test("shapesToCsv with metric: converts headers and values to m²/m/m", () => {
  const conds2 = [{ id: "ct", finish_tag: "CT-1" }];
  const shapes2 = [floor("a", 100, 40)];
  const csv = shapesToCsv(shapesDetail(conds2, shapes2), "Job 42", "OpenTakeoff", "metric");
  const lines = csv.split("\n");
  // title line is first ("# Job 42 — OpenTakeoff shapes"), comment is second
  assert.ok(lines[1].startsWith("# Per-shape measured quantities"),
    "semantics comment line present");
  // headers use metric labels
  assert.equal(lines[2], "Shape,Sheet,Sheet ID,Finish,Role,Area m²,m,EA,Height m,Height override,Origin",
    "headers use metric labels");
  // data values are converted: 100 SF → 9.29 m², 40 LF → 12.19 m
  const dataRow = lines[3];
  const cells = dataRow.split(",");
  assert.ok(cells[5].includes("9.29"), `area_sf converted: ${cells[5]}`);
  assert.ok(cells[6].includes("12.19"), `lf converted: ${cells[6]}`);
});

test("shapesToCsv with imperial (default): no conversion, byte-compatible", () => {
  const conds2 = [{ id: "ct", finish_tag: "CT-1" }];
  const shapes2 = [floor("a", 100)];
  const csvDefault = shapesToCsv(shapesDetail(conds2, shapes2), "Job 42");
  const csvExplicit = shapesToCsv(shapesDetail(conds2, shapes2), "Job 42", "OpenTakeoff", "imperial");
  assert.equal(csvDefault, csvExplicit, "default (no units) matches explicit imperial");
  assert.ok(!csvDefault.includes("m²"), "no m² in imperial headers");
  assert.ok(!csvDefault.includes("9.29"), "no metric conversion in imperial data");
});

test("shapesToJson: always raw canonical regardless of units context", () => {
  const conds2 = [{ id: "ct", finish_tag: "CT-1" }];
  const shapes2 = [floor("a", 100, 40)];
  const rows = shapesDetail(conds2, shapes2);
  const j = shapesToJson(rows, "Job 42");
  // values stay in feet
  assert.equal(j.shapes[0].area_sf, 100);
  assert.equal(j.shapes[0].lf, 40);
  // schema and structure unchanged
  assert.equal(j.schema, "opentakeoff.shapes.v1");
});
