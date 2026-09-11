import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Session } from "../../mcp/src/session.ts";
import { emptyAnnotations } from "../../web/src/lib/store.js";
import { applyShapeCommand, geomSnapshot } from "../../web/src/lib/shapeCommands.js";
import { applyApprovalCommand } from "../../web/src/lib/approvals.js";
import { normalizeAgentReview } from "../../web/src/lib/reviewState.js";
import { mergeTakeoffImport } from "../../web/src/lib/importTakeoff.js";
import { conditionTotals } from "../../web/src/lib/totals.js";
import { buildProjectArchive, parseProjectArchive } from "../../web/src/lib/projectArchive.js";
import { sanitizeStitches } from "../../web/src/lib/stitches.ts";
import { validator, assertValid, legacyId, draftId } from "./helpers.mjs";

const ajv = validator();
const plan = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const sheet = "sample-plan.pdf";
const ring = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]];
const humanShape = () => ({
  sheet_id: sheet, condition_id: "condition-1", measure_role: "floor_area",
  verts_norm: structuredClone(ring), computed: { area_sf: 100, perimeter_lf: 40 },
  origin: { method: "manual" },
});
function browserDocument() {
  return {
    ...emptyAnnotations(), project_name: "Protocol synthetic fixture",
    sheets: [{ sheet_id: sheet, units_per_px: 1 / 36, scale_source: "calibrated" }],
    conditions: [{ id: "condition-1", finish_tag: "F-1", multiplier: 1, waste_pct: 5, materials: [] }],
    shapes: applyShapeCommand([], { type: "add", shapes: [humanShape()] }).shapes,
  };
}
function checkBoth(record) {
  assert.equal(record.schema, legacyId, "the real writer still emits the legacy identifier");
  const before = JSON.stringify(record);
  const quantities = conditionTotals(record.conditions, record.shapes);
  assertValid(assert, ajv, "legacy/takeoff-canvas.v1.schema.json", record);
  // Test-only substitution checks the proposed structural shape. This is NOT
  // an adapter, a migrated output, or proof that all transports preserve fields.
  assertValid(assert, ajv, "v1/takeoff-document.schema.json", { ...structuredClone(record), schema: draftId });
  assert.equal(JSON.stringify(record), before);
  assert.deepEqual(conditionTotals(record.conditions, record.shapes), quantities);
}

test("empty browser persistence and a real browser add command conform without changing quantities", () => {
  checkBoth(emptyAnnotations());
  checkBoth(browserDocument());
});

test("MCP commits every manual measurement role with agent provenance and unconfirmed scale", async () => {
  const session = new Session();
  await session.loadPlan(plan);
  session.setScale(sheet, { use_detected: true });
  session.proposeTakeoff("Protocol sample", "Synthetic geometry for contract validation");
  session.measurePolygon(sheet, [[300, 300], [500, 300], [500, 500]], { condition: "F-1", role: "floor_area" });
  session.measurePolygon(sheet, [[310, 310], [320, 310], [320, 320]], { condition: "F-1", role: "deduct" });
  session.measureLine(sheet, [[300, 300], [500, 300]], { condition: "L-1" });
  session.measureSurface(sheet, [[300, 300], [500, 300]], { condition: "W-1", height_ft: 8 });
  session.placeCount(sheet, [[600, 600]], { condition: "C-1" });
  const record = session.exportPayload();
  checkBoth(record);
  assert.equal(record.sheets[0].scale_confirmed, false);
  assert.equal(new Set(record.shapes.map((s) => s.measure_role)).size, 5);
  for (const s of record.shapes) {
    assert.equal(s.origin.method, "manual");
    assert.equal(s.origin.actor, "agent");
    assert.equal(s.origin.reviewed, false);
    assert.ok(s.origin.proposal_id);
    const before = structuredClone([s]);
    for (const editKind of ["vertex", "edge", "move", "vertexDelete", "reassign"]) {
      const moved = s.verts_norm.map(([x, y]) => [x + 0.01, y]);
      const cmd = editKind === "reassign"
        ? { type: "reassign", ids: [s.id], condition_id: "replacement-condition" }
        : { type: "geom", id: s.id, editKind, verts_norm: moved, prev: geomSnapshot(s) };
      // The browser may already display moved geometry during a drag preview.
      const preview = editKind === "reassign" ? [s] : [{ ...s, verts_norm: moved }];
      const corrected = applyShapeCommand(preview, cmd);
      const origin = corrected.shapes[0].origin;
      assert.deepEqual(origin.proposed_verts_norm, s.verts_norm, `${s.measure_role}: ${editKind}`);
      assert.deepEqual(origin, { ...s.origin, edited: true,
        edits: { [editKind === "vertexDelete" ? "vertex" : editKind]: 1 },
        proposed_verts_norm: s.verts_norm });
      const undone = applyShapeCommand(corrected.shapes, corrected.inverse);
      assert.deepEqual(undone.shapes, before);
      const redone = applyShapeCommand(undone.shapes, undone.inverse);
      assert.deepEqual(redone.shapes, corrected.shapes);
      checkBoth({ ...record, shapes: redone.shapes });
    }
    assert.deepEqual([s], before);
  }
});

test("human correction, subsequent correction, review and undo retain existing machine originals", () => {
  const d = browserDocument();
  d.shapes[0].origin = { method: "agent_v1", actor: "agent", reviewed: false, evidence: { schedule_row_tag: "F-1", matched_text: "101" } };
  const before = structuredClone(d.shapes);
  const first = applyShapeCommand(d.shapes, { type: "geom", id: d.shapes[0].id, editKind: "vertex", verts_norm: [[0.15, 0.1], ...ring.slice(1)] });
  assert.deepEqual(first.shapes[0].origin.proposed_verts_norm, ring);
  const second = applyShapeCommand(first.shapes, { type: "geom", id: d.shapes[0].id, editKind: "vertex", verts_norm: [[0.2, 0.1], ...ring.slice(1)] });
  assert.deepEqual(second.shapes[0].origin.proposed_verts_norm, ring);
  const accepted = applyShapeCommand(second.shapes, { type: "review", ids: [d.shapes[0].id] });
  checkBoth({ ...d, shapes: accepted.shapes });
  assert.equal(accepted.shapes[0].origin.reviewed, true);
  assert.deepEqual(accepted.shapes[0].origin.proposed_verts_norm, ring);
  assert.deepEqual(applyShapeCommand(first.shapes, first.inverse).shapes, before);
});

test("agent self-revision then human correction preserves the proposal seen by the human through import and archive", async () => {
  const session = new Session();
  await session.loadPlan(plan);
  session.setScale(sheet, { use_detected: true });
  session.measurePolygon(sheet, [[300, 300], [500, 300], [500, 500]], { condition: "F-1", role: "floor_area" });
  session.editShape(session.shapes[0].id, { verts: [[310, 300], [500, 300], [500, 500]] });
  const record = session.exportPayload();
  const proposed = structuredClone(record.shapes[0].verts_norm);
  assert.equal(record.shapes[0].origin.agent_edits, 1);
  assert.equal(record.shapes[0].origin.proposed_verts_norm, undefined);
  const merged = mergeTakeoffImport(emptyAnnotations(), record).payload;
  const first = applyShapeCommand(merged.shapes, { type: "geom", id: merged.shapes[0].id,
    editKind: "vertex", verts_norm: [[0.15, 0.2], ...proposed.slice(1)] });
  const second = applyShapeCommand(first.shapes, { type: "geom", id: merged.shapes[0].id,
    editKind: "vertex", verts_norm: [[0.16, 0.2], ...proposed.slice(1)] });
  const corrected = { ...record, ...merged, shapes: second.shapes };
  assert.deepEqual(corrected.shapes[0].origin.proposed_verts_norm, proposed);
  assert.deepEqual(corrected.shapes[0].origin.edits, { vertex: 2 });
  assert.equal(corrected.shapes[0].origin.agent_edits, 1);
  assert.equal(corrected.shapes[0].origin.reviewed, false);
  checkBoth(corrected);
  const bytes = await buildProjectArchive({ takeoff: corrected, sheets: [{ name: sheet }],
    loadPdfData: async () => new Uint8Array(await readFile(plan)) });
  const reopened = await parseProjectArchive(bytes);
  assert.deepEqual(reopened.takeoff, corrected);
  checkBoth(reopened.takeoff);
});

test("legacy missing originals stay absent under validation; agent review stays pending", () => {
  const d = browserDocument();
  d.shapes[0].origin = { method: "manual", actor: "agent", reviewed: false };
  checkBoth(d);
  assert.equal(d.shapes[0].origin.proposed_verts_norm, undefined);
  const normalized = normalizeAgentReview({ ...d.shapes[0], origin: { method: "manual", actor: "agent" } });
  assert.equal(normalized.origin.reviewed, false);
});

test("legacy spline and browser-only provenance are represented without changing interpretation", () => {
  const d = browserDocument();
  d.shapes[0].curved = true;
  d.shapes[0].origin = { method: "manual", curved: true };
  checkBoth(d);
  d.shapes[0].origin = { method: "derived", actor: "canvas", reviewed: false, derived: { between_shape_ids: ["source-a", "source-b"], between: ["F-1", "F-2"], case: "butt", gap_in: 0 } };
  checkBoth(d);
  d.shapes[0].origin = { method: "net_v1", seed_norm: [0.2, 0.2], net_faces: 2, net_starved: false, net_mode: "room", reviewed: true };
  checkBoth(d);
});

test("browser stitch, unknown extensions and original trace survive the existing project archive", async () => {
  const d = browserDocument();
  d.stitches = sanitizeStitches([{ id: "stitch:protocol", name: "Split floor", members: [{ key: sheet, dx: 0, dy: 0 }, { key: "right.pdf", dx: 2000, dy: 0 }] }], 4);
  d.shapes[0].sheet_id = d.stitches[0].id;
  d.shapes[0].origin = { method: "agent_v1", actor: "agent", reviewed: true, proposed_verts_norm: structuredClone(ring) };
  d.sheets.push({ sheet_id: d.stitches[0].id, units_per_px: 1 / 36 });
  d.custom_extension = { kept: true };
  checkBoth(d);
  const sourceBytes = new TextEncoder().encode("%PDF-1.4 synthetic protocol fixture");
  const bytes = await buildProjectArchive({ takeoff: d, sheets: [{ name: sheet }, { name: "right.pdf" }], loadPdfData: async () => sourceBytes });
  const reopened = await parseProjectArchive(bytes);
  assert.deepEqual(reopened.takeoff, d);
  checkBoth(reopened.takeoff);
});

test("browser approvals transport as records while MCP verdict creation remains agent-only", async () => {
  const session = new Session();
  await session.loadPlan(plan);
  session.setScale(sheet, { use_detected: true });
  session.measurePolygon(sheet, [[300, 300], [500, 300], [500, 500]], { condition: "F-1", role: "floor_area" });
  // An extra actor field cannot change the existing method's hardcoded actor.
  session.markVerdict({ shape_id: session.shapes[0].id, actor: "estimator" });
  const record = session.exportPayload();
  assert.deepEqual(record.approvals.map((a) => a.actor), ["agent"]);
  assert.equal(record.shapes[0].origin.reviewed, false);
  checkBoth(record);
  const d = browserDocument();
  d.approvals = applyApprovalCommand([], { type: "add", approvals: [{ actor: "estimator", sheet_id: sheet, at: [0.2, 0.2], shape_id: d.shapes[0].id }] }).approvals;
  checkBoth(d);
  const imported = mergeTakeoffImport(emptyAnnotations(), d).payload;
  assert.deepEqual(imported.approvals, d.approvals, "transport retains existing seals; it does not mint them");
  const reviewed = applyShapeCommand(session.shapes, { type: "review", ids: [session.shapes[0].id] });
  session.shapes = reviewed.shapes;
  assert.throws(() => session.editShape(session.shapes[0].id, { label: "changed" }), /affirmed by a human/);
});
