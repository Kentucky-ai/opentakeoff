// The one writer of the takeoff document. These tests pin the envelope the
// canvas autosave, the file export and the MCP server all produce.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTakeoffDocument, sheetEntry, TAKEOFF_DOCUMENT_KEYS } from "../src/lib/takeoffDocument.js";
import { TAKEOFF_SCHEMA } from "../src/lib/takeoffConstants.ts";
import { parseTakeoffImport, mergeTakeoffImport } from "../src/lib/importTakeoff.js";
import { emptyAnnotations } from "../src/lib/store.js";

const inOrder = (keys: string[]) => keys.map((k) => TAKEOFF_DOCUMENT_KEYS.indexOf(k)).every((i, n, a) => i >= 0 && (n === 0 || i > a[n - 1]));

test("empty field bag: the minimal document, schema first, keys in canonical order", () => {
  const d = buildTakeoffDocument({});
  assert.deepEqual(Object.keys(d), ["schema", "project_name", "sheets", "conditions", "shapes", "markups", "rfis", "sheet_group", "last_group", "sheet_tabs"]);
  assert.equal(d.schema, TAKEOFF_SCHEMA);
  assert.equal(d.project_name, "");
  assert.ok(inOrder(Object.keys(d)));
});

test("units is diff-only: imperial omits the key, metric writes it", () => {
  assert.equal("units" in buildTakeoffDocument({ units: "imperial" }), false);
  assert.equal("units" in buildTakeoffDocument({}), false);
  assert.equal(buildTakeoffDocument({ units: "metric" }).units, "metric");
});

test("additive keys ride only when non-empty; palette drops ids that no longer resolve", () => {
  const conditions = [{ id: "c1", finish_tag: "CPT-1" }];
  const d = buildTakeoffDocument({
    conditions, palette: ["c1", "gone"], client_info: { client: " " }, sheet_levels: {}, layer_overrides: {},
    provenance_counters: { shapes_deleted: {} }, approvals: [], rules: [], stitches: [], condition_columns: [], shape_labels: [],
  });
  assert.deepEqual(d.palette, ["c1"]);
  for (const k of ["client_info", "sheet_levels", "layer_overrides", "provenance_counters", "approvals", "rules", "stitches", "condition_columns", "shape_labels"]) assert.equal(k in d, false, k);
  const full = buildTakeoffDocument({
    conditions, palette: ["c1"], client_info: { client: "ACME" }, sheet_levels: { "a.pdf": "L1" }, layer_overrides: { "a.pdf": { x: "exclude" } },
    provenance_counters: { shapes_deleted: { s1: 1 } }, approvals: [{ id: "a" }], rules: [{ id: "r" }], stitches: [{ id: "st" }],
    condition_columns: [{ id: "k" }], shape_labels: [{ id: "l" }], proposals: [{ id: "p" }], condition_edit_proposals: [{ id: "e" }],
  });
  assert.ok(inOrder(Object.keys(full)));
  assert.equal(Object.keys(full).length, TAKEOFF_DOCUMENT_KEYS.length - 1, "everything but units");
});

test("sheetEntry: scale_source only when known, scale_confirmed only when false", () => {
  assert.deepEqual(sheetEntry({ sheet_id: "a.pdf", units_per_px: 0.5 }), { sheet_id: "a.pdf", units_per_px: 0.5 });
  assert.deepEqual(sheetEntry({ sheet_id: "a.pdf", units_per_px: 0.5, scale_source: "detected", scale_confirmed: true }), { sheet_id: "a.pdf", units_per_px: 0.5, scale_source: "detected" });
  assert.deepEqual(sheetEntry({ sheet_id: "a.pdf", units_per_px: 0.5, scale_confirmed: false }), { sheet_id: "a.pdf", units_per_px: 0.5, scale_confirmed: false });
});

test("round trip: the document the writer builds is exactly what the app's reader lands", () => {
  const conditions = [{ id: "c1", finish_tag: "CPT-1", color: "#c96442", fill: "#c96442", hatch: "diag", multiplier: 1, waste_pct: 0, materials: [] }];
  const shapes = [{ id: "s1", sheet_id: "a.pdf", condition_id: "c1", measure_role: "floor_area", verts_norm: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]], computed: { area_sf: 10 }, origin: { method: "manual", reviewed: false } }];
  const sheets = [sheetEntry({ sheet_id: "a.pdf", units_per_px: 0.05, scale_source: "detected", scale_confirmed: false })];
  const doc = buildTakeoffDocument({ project_name: "Agent run", sheets, conditions, shapes, sheet_tabs: ["a.pdf"] });
  const parsed = parseTakeoffImport(JSON.stringify(doc));
  const { payload } = mergeTakeoffImport(emptyAnnotations(), parsed, ["a.pdf"]);
  assert.deepEqual(payload.conditions, conditions);
  assert.deepEqual(payload.shapes, shapes);
  assert.deepEqual(payload.sheets, sheets);
  assert.deepEqual(payload.sheet_tabs, ["a.pdf"]);
  // and the writer is idempotent over its own output
  assert.deepEqual(buildTakeoffDocument(doc), doc);
});

test("the canvas has one writer: it calls buildTakeoffDocument and carries no envelope literal", () => {
  const src = readFileSync(new URL("../src/pages/TakeoffCanvas.jsx", import.meta.url), "utf8");
  assert.equal(src.split("buildTakeoffDocument(").length - 1, 1);
  assert.equal(/schema:\s*ANN_SCHEMA/.test(src), false, "no hand-built envelope in the canvas");
  assert.equal(/sheet_levels\s*:\s*sheetLevels\s*\}/.test(src), false, "no inline omit-when-empty spreads left");
});
