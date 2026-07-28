// The import merge rules (lib/importTakeoff.js): the agent-handoff seam where
// an MCP export_takeoff file lands in the canvas. The one design rule under
// test everywhere: operator state wins, and re-importing is idempotent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTakeoffImport, mergeTakeoffImport } from "../src/lib/importTakeoff.js";
import { ANN_SCHEMA } from "../src/lib/store.js";

const doc = (over: Record<string, unknown> = {}) => ({
  schema: ANN_SCHEMA,
  project_name: "Agent Run",
  sheets: [{ sheet_id: "va.pdf", units_per_px: 0.05 }],
  conditions: [{ id: "c1", finish_tag: "CPT-1", color: "#123456", fill: "solid", hatch: "", multiplier: 1, waste_pct: 10, materials: [] }],
  shapes: [{ id: "s1", sheet_id: "va.pdf", condition_id: "c1", measure_role: "floor_area", verts_norm: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]], computed: { area_sf: 100, perimeter_lf: 40 }, origin: { method: "one_click_v1", actor: "agent", reviewed: false } }],
  markups: [],
  sheet_group: [],
  last_group: [],
  sheet_tabs: ["va.pdf"],
  ...over,
});

test("parse: rejects non-JSON and wrong schemas, passes the real one", () => {
  assert.throws(() => parseTakeoffImport("{nope"), /not valid JSON/);
  assert.throws(() => parseTakeoffImport(JSON.stringify({ schema: "something.else" })), /not a takeoff export/);
  assert.throws(() => parseTakeoffImport(JSON.stringify([1, 2])), /not a takeoff export/);
  assert.equal(parseTakeoffImport(JSON.stringify(doc())).project_name, "Agent Run");
});

test("empty project: import replaces wholesale (seeded conditions are not work)", () => {
  const current = { project_name: "", conditions: [{ id: "seed1", finish_tag: "CPT-1" }], shapes: [], markups: [], sheets: [] };
  const { payload, note } = mergeTakeoffImport(current, doc());
  assert.equal(note.replaced, true);
  assert.equal(payload.project_name, "Agent Run");
  assert.equal(payload.shapes.length, 1);
  assert.equal(note.shapes_pending, 1);   // reviewed:false counts as pending
});

test("merge: same finish tag joins the operator's condition — no duplicate, shapes remapped", () => {
  const current = {
    conditions: [{ id: "mine", finish_tag: " cpt-1 " }],   // tag match is case/space-insensitive
    shapes: [{ id: "s0", sheet_id: "va.pdf", condition_id: "mine" }],
    markups: [], sheets: [{ sheet_id: "va.pdf", units_per_px: 0.07 }],
  };
  const { payload, note } = mergeTakeoffImport(current, doc());
  assert.equal(note.replaced, false);
  assert.equal(note.conditions_merged, 1);
  assert.equal(note.conditions_added, 0);
  assert.equal(payload.conditions.length, 1);
  const added = payload.shapes.find((s: { id: string }) => s.id === "s1");
  assert.equal(added.condition_id, "mine");
  // origin provenance rides through untouched — the pencil stays pencil
  assert.equal(added.origin.reviewed, false);
});

test("merge: new finish tag appends; a colliding condition id under a different tag is reminted", () => {
  const current = {
    conditions: [{ id: "c1", finish_tag: "LVT-2" }],   // same id, DIFFERENT tag
    shapes: [{ id: "s0", sheet_id: "va.pdf", condition_id: "c1" }],
    markups: [], sheets: [],
  };
  const { payload, note } = mergeTakeoffImport(current, doc());
  assert.equal(note.conditions_added, 1);
  const addedCond = payload.conditions.find((c: { finish_tag: string }) => c.finish_tag === "CPT-1");
  assert.equal(addedCond.id, "c1~2");   // deterministic escape, not a uuid
  assert.equal(payload.shapes.find((s: { id: string }) => s.id === "s1").condition_id, "c1~2");
});

test("re-import is idempotent: same-id shapes are skipped, not duplicated", () => {
  const first = mergeTakeoffImport({ shapes: [{ id: "s0", sheet_id: "va.pdf", condition_id: "x" }], markups: [], conditions: [], sheets: [] }, doc());
  const second = mergeTakeoffImport(first.payload, doc());
  assert.equal(second.note.shapes_added, 0);
  assert.equal(second.payload.shapes.length, first.payload.shapes.length);
});

test("scales: the operator's calibration wins per sheet; missing sheets adopt the import's", () => {
  const current = {
    shapes: [{ id: "s0", sheet_id: "va.pdf", condition_id: "x" }], markups: [], conditions: [],
    sheets: [{ sheet_id: "va.pdf", units_per_px: 0.07 }],
  };
  const imported = doc({ sheets: [{ sheet_id: "va.pdf", units_per_px: 0.05 }, { sheet_id: "va.pdf#2", units_per_px: 0.05 }] });
  const { payload, note } = mergeTakeoffImport(current, imported);
  assert.equal(payload.sheets.find((s: { sheet_id: string }) => s.sheet_id === "va.pdf").units_per_px, 0.07);
  assert.equal(payload.sheets.find((s: { sheet_id: string }) => s.sheet_id === "va.pdf#2").units_per_px, 0.05);
  assert.equal(note.scales_adopted, 1);
});

test("workspace fields stay the operator's on merge: name, tabs, groups", () => {
  const current = {
    project_name: "My Bid", sheet_tabs: ["va.pdf#3"], sheet_group: ["va.pdf", "va.pdf#2"],
    shapes: [{ id: "s0", sheet_id: "va.pdf", condition_id: "x" }], markups: [], conditions: [], sheets: [],
  };
  const { payload } = mergeTakeoffImport(current, doc());
  assert.equal(payload.project_name, "My Bid");
  assert.deepEqual(payload.sheet_tabs, ["va.pdf#3"]);
  assert.deepEqual(payload.sheet_group, ["va.pdf", "va.pdf#2"]);
});

test("unknown files are reported so the banner can explain an invisible import", () => {
  const current = { shapes: [{ id: "s0", sheet_id: "other.pdf", condition_id: "x" }], markups: [], conditions: [], sheets: [] };
  const { note } = mergeTakeoffImport(current, doc(), ["other.pdf"]);
  assert.deepEqual(note.unknown_files, ["va.pdf"]);
  // and silence when every referenced file is loaded
  assert.deepEqual(mergeTakeoffImport(current, doc(), ["other.pdf", "va.pdf"]).note.unknown_files, []);
});
