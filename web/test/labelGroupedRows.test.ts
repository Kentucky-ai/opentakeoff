// By-label report grouping (issue #112) — labelGroupedRows is the shape-level
// analogue of sheetGroupedRows: bucket shapes by shape.label, run conditionTotals
// per bucket (so waste %/×N apply per slice), ordered vocab → ad-hoc → Unlabeled.
// The load-bearing invariant: a condition that spans labels splits across buckets
// and the per-bucket sums reconcile to the ungrouped total.
import { test } from "node:test";
import assert from "node:assert/strict";
import { labelGroupedRows, conditionTotals, reportJson } from "../src/lib/totals.js";

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
