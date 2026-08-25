// By-label report grouping (issue #112) — labelGroupedRows is the shape-level
// analogue of sheetGroupedRows: bucket shapes by shape.label, run conditionTotals
// per bucket (so waste %/×N apply per slice), ordered vocab → ad-hoc → Unlabeled.
// The load-bearing invariant: a condition that spans labels splits across buckets
// and the per-bucket sums reconcile to the ungrouped total.
import { test } from "node:test";
import assert from "node:assert/strict";
import { labelGroupedRows, sheetLabelGroupedRows, authorGroupedRows, conditionTotals, reportJson } from "../src/lib/totals.js";

const conditions = () => [{ id: "c1", finish_tag: "CPT-1" }];
const shape = (id: string, label: string | null, area: number) => ({
  id, condition_id: "c1", sheet_id: "p.pdf", measure_role: "floor_area",
  computed: { area_sf: area, perimeter_lf: 0 }, ...(label ? { label } : {}),
});

test("a condition split across labels sums per bucket and reconciles to the ungrouped total", () => {
  const shapes = [shape("s1", "Phase 1", 100), shape("s2", "Phase 2", 50), shape("s3", null, 25)];
  const g = labelGroupedRows(conditions(), shapes, ["Phase 1", "Phase 2"]);
  assert.deepEqual(g.map((x) => x.label), ["Phase 1", "Phase 2", "Unlabeled"]);
  assert.equal(g[0].rows[0].floor_sf, 100);
  assert.equal(g[1].rows[0].floor_sf, 50);
  assert.equal(g[2].rows[0].floor_sf, 25);
  // the split is free: per-bucket floor_sf sums to the single ungrouped row
  const ungrouped = conditionTotals(conditions(), shapes)[0].floor_sf;
  assert.equal(g.reduce((n, x) => n + x.rows[0].floor_sf, 0), ungrouped);   // 175
});

test("the Unlabeled bucket carries value null (renders italic like Unassigned) and comes last", () => {
  const shapes = [shape("s1", null, 10), shape("s2", "Phase 1", 10)];
  const g = labelGroupedRows(conditions(), shapes, ["Phase 1"]);
  assert.deepEqual(g.map((x) => x.label), ["Phase 1", "Unlabeled"]);
  assert.equal(g[1].value, null);
  assert.equal(g[0].value, "Phase 1");
});

test("ordering: vocabulary order first, then ad-hoc values sorted, then Unlabeled last", () => {
  const shapes = [shape("s1", "Zeta", 1), shape("s2", "Phase 1", 1), shape("s3", "Alpha", 1), shape("s4", null, 1)];
  const g = labelGroupedRows(conditions(), shapes, ["Phase 1"]);   // only Phase 1 is in the vocab
  assert.deepEqual(g.map((x) => x.label), ["Phase 1", "Alpha", "Zeta", "Unlabeled"]);
});

test("empty buckets are dropped — a vocab label with no shapes doesn't render", () => {
  const g = labelGroupedRows(conditions(), [shape("s1", "Phase 1", 1)], ["Phase 1", "Phase 2"]);
  assert.deepEqual(g.map((x) => x.label), ["Phase 1"]);
});

test("perimByCond is per-bucket, not whole-project", () => {
  // perimeter rides along per bucket; empty vocab arg still works (all Unlabeled)
  const g = labelGroupedRows(conditions(), [shape("s1", null, 5)], []);
  assert.deepEqual(g.map((x) => x.label), ["Unlabeled"]);
  assert.ok(g[0].perimByCond instanceof Map);
});

test("reportJson emits shape_labels + by_label — additive, always present, empty when unused", () => {
  const empty = reportJson({});
  assert.deepEqual(empty.shape_labels, []);
  assert.deepEqual(empty.by_label, []);
  const shapes = [shape("s1", "Phase 1", 10), shape("s2", null, 5)];
  const j = reportJson({
    rows: conditionTotals(conditions(), shapes),
    shapeLabels: ["Phase 1"],
    byLabel: labelGroupedRows(conditions(), shapes, ["Phase 1"]),
  });
  assert.deepEqual(j.shape_labels, ["Phase 1"]);
  assert.deepEqual(j.by_label.map((g: any) => g.label), ["Phase 1", null]);   // Unlabeled → null
  assert.deepEqual(Object.keys(j.by_label[0]), ["label", "rows"]);
  assert.deepEqual(Object.keys(j.by_label[0].rows[0]),
    ["id", "finish_tag", "floor_sf", "wall_sf", "border_sf", "lf", "ea", "total_sf", "total_sf_net"]);
});

// ── sheet × label: the floor × room cross-section (the workbook's fifth tab) ──
// sheetGroupedRows collapses the room axis and labelGroupedRows collapses the
// floor axis; this keeps both, which is the breakdown an estimator actually
// hands over. Its load-bearing invariant is reconciliation: every shape a
// floor carries lands under one of that floor's rooms or under its Unlabeled
// roll-up, so a reader adding rooms up gets the floor.

const sheetShape = (id: string, sheet: string, label: string | null, area: number) => ({
  id, condition_id: "c1", sheet_id: sheet, measure_role: "floor_area",
  computed: { area_sf: area, perimeter_lf: 0 }, ...(label ? { label } : {}),
});

test("sheetLabelGroupedRows: floors in canonical order, rooms in label order within each", () => {
  const shapes = [
    sheetShape("s3", "p.pdf#2", "102", 30),
    sheetShape("s1", "p.pdf#1", "101", 100),
    sheetShape("s2", "p.pdf#1", "102", 50),
  ];
  const g = sheetLabelGroupedRows(conditions(), shapes, ["101", "102"]);
  assert.deepEqual(g.map((x: any) => x.sheet_id), ["p.pdf#1", "p.pdf#2"], "file then numeric page — never draw order");
  assert.deepEqual(g[0].groups.map((x: any) => x.label), ["101", "102"]);
  assert.deepEqual(g[1].groups.map((x: any) => x.label), ["102"]);
  assert.equal(g[0].groups[0].rows[0].floor_sf, 100);
});

test("sheetLabelGroupedRows: an unlabeled floor still rolls up, so floors reconcile", () => {
  const shapes = [
    sheetShape("s1", "p.pdf#1", "101", 100),
    sheetShape("s2", "p.pdf#2", null, 40),      // a floor nobody labeled
    sheetShape("s3", "p.pdf#2", null, 10),
  ];
  const g = sheetLabelGroupedRows(conditions(), shapes, ["101"]);
  assert.deepEqual(g.map((x: any) => x.groups.map((y: any) => y.label)), [["101"], ["Unlabeled"]]);
  assert.equal(g[1].groups[0].rows[0].floor_sf, 50, "the whole floor, in one row — nothing dropped for want of a label");
  // every cell of every floor adds back to the ungrouped condition row
  const cells = g.flatMap((x: any) => x.groups.flatMap((y: any) => y.rows.map((r: any) => r.floor_sf)));
  assert.equal(cells.reduce((a: number, b: number) => a + b, 0), conditionTotals(conditions(), shapes)[0].floor_sf);
});

test("sheetLabelGroupedRows: a room traced on two floors appears under each, sliced", () => {
  const shapes = [sheetShape("s1", "p.pdf#1", "101", 100), sheetShape("s2", "p.pdf#2", "101", 60)];
  const g = sheetLabelGroupedRows(conditions(), shapes, ["101"]);
  assert.deepEqual(g.map((x: any) => x.groups[0].rows[0].floor_sf), [100, 60]);
});

test("sheetLabelGroupedRows: no shapes, and orphan-only floors, drop rather than emit empties", () => {
  assert.deepEqual(sheetLabelGroupedRows(conditions(), [], []), []);
  const orphan = [{ id: "x", condition_id: "gone", sheet_id: "p.pdf#1", measure_role: "floor_area", computed: { area_sf: 9 } }];
  assert.deepEqual(sheetLabelGroupedRows(conditions(), orphan as any, []), []);
});

// ── authorGroupedRows (#314) — labelGroupedRows' twin, keyed on shape.author ─

const authored = (id: string, author: string | null, area: number) => ({
  id, condition_id: "c1", sheet_id: "p.pdf", measure_role: "floor_area",
  computed: { area_sf: area, perimeter_lf: 0 }, ...(author ? { author } : {}),
});

test("author buckets reconcile to the ungrouped total; named sorted, Unattributed last with value null", () => {
  const shapes = [authored("s1", "Michael", 100), authored("s2", "Aaron", 50), authored("s3", null, 25)];
  const g = authorGroupedRows(conditions(), shapes);
  assert.deepEqual(g.map((x) => x.label), ["Aaron", "Michael", "Unattributed"]);
  assert.equal(g[2].value, null);
  assert.deepEqual(g.map((x) => x.rows[0].floor_sf), [50, 100, 25]);
  const ungrouped = conditionTotals(conditions(), shapes)[0].floor_sf;
  assert.equal(g.reduce((n, x) => n + x.rows[0].floor_sf, 0), ungrouped);
});

test("a whitespace-only author is Unattributed, and an all-unattributed project still groups", () => {
  const g = authorGroupedRows(conditions(), [authored("s1", "   ", 10), authored("s2", null, 5)]);
  assert.deepEqual(g.map((x) => x.label), ["Unattributed"]);
  assert.equal(g[0].rows[0].floor_sf, 15);
});
