import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Session } from "../../mcp/src/session.ts";
import { applyShapeCommand } from "../../web/src/lib/shapeCommands.js";
import { preflightTakeoff, PROFILE } from "../src/preflight.mjs";
import { legacyId, draftId, validator, assertValid } from "./helpers.mjs";

const sheet = "sample-plan.pdf";
const plan = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const fixture = () => ({
  schema: legacyId, sheets: [{ sheet_id: sheet, units_per_px: 0.1 }],
  conditions: [{ id: "floor", finish_tag: "F-1" }],
  shapes: [{ id: "room", sheet_id: sheet, condition_id: "floor", measure_role: "floor_area",
    verts_norm: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2]],
    computed: { area_sf: 100, perimeter_lf: 40 }, origin: { method: "manual", actor: "agent", reviewed: false } }],
});
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function inspect(record, status) {
  const before = structuredClone(record), bytes = JSON.stringify(record);
  const report = preflightTakeoff(freeze(record));
  assert.equal(report.status, status, JSON.stringify(report));
  assert.equal(report.profile, PROFILE);
  assert.deepEqual(record, before);
  assert.equal(JSON.stringify(record), bytes);
  return report;
}
const hasIssue = (report, code, path, severity) => assert.ok(report.issues.some(i =>
  i.code === code && i.path === path && (!severity || i.severity === severity)), JSON.stringify(report));

test("preflight accepts real MCP manual roles and derived base without recomputation or authority changes", async () => {
  const session = new Session();
  await session.loadPlan(plan);
  session.setScale(sheet, { upp: 0.1 });
  session.proposeTakeoff("Preflight sample", "Public sample; synthetic measurements");
  const room = session.measurePolygon(sheet, [[100, 100], [200, 100], [200, 200], [100, 200]], { condition: "F-1", role: "floor_area" });
  session.measurePolygon(sheet, [[110, 110], [130, 110], [130, 130], [110, 130]], { condition: "F-1", role: "deduct" });
  session.measureLine(sheet, [[100, 300], [200, 300]], { condition: "L-1" });
  session.measureSurface(sheet, [[100, 400], [200, 400]], { condition: "W-1", height_ft: 3 });
  session.placeCount(sheet, [[300, 300], [400, 300]], { condition: "C-1" });
  session.deriveBase({ source_condition: "F-1", condition: "B-1", openings: [{ shape_id: room.shape_id, lf: 3 }] });
  const record = session.exportPayload();
  assert.deepEqual(record.shapes.map(s => s.computed[s.measure_role === "count" ? "count" : s.measure_role === "linear" ? "perimeter_lf" : "area_sf"]), [100, 4, 10, 30, 1, 1, 37]);
  inspect(record, "eligible");
  inspect({ ...structuredClone(record), schema: draftId }, "eligible");
  assert.equal(record.sheets[0].scale_confirmed, false);
  assert.ok(record.shapes.every(s => s.origin.actor === "agent" && s.origin.reviewed === false));
  assert.equal(Object.hasOwn(record, "approvals"), false, "the writer's absent approvals stay absent");
});

test("browser correction retains first machine ring, evidence and existing human review without authenticating it", () => {
  const record = fixture(), original = structuredClone(record.shapes[0].verts_norm);
  record.shapes[0].origin.evidence = { schedule_row_tag: "F-1", matched_text: "101" };
  for (const x of [0.11, 0.12]) record.shapes = applyShapeCommand(record.shapes, {
    type: "geom", id: "room", editKind: "vertex", verts_norm: [[x, 0.1], ...original.slice(1)],
  }).shapes;
  record.shapes = applyShapeCommand(record.shapes, { type: "review", ids: ["room"] }).shapes;
  record.approvals = [{ id: "seal", actor: "estimator", sheet_id: sheet, at: [0.1, 0.1], shape_id: "room" }];
  const report = inspect(record, "eligible");
  assert.deepEqual(record.shapes[0].origin.proposed_verts_norm, original);
  assert.equal(record.shapes[0].origin.reviewed, true);
  hasIssue(report, "authority_not_authenticated", "/approvals", "warning");
  assert.ok(report.notVerified.includes("approval_authenticity"));
});

test("legacy omissions, extensions and out-of-frame coordinates stay absent or exact", () => {
  const record = fixture();
  delete record.shapes[0].origin;
  record.shapes[0].verts_norm[0] = [-0.1, 1.2];
  record.custom = { schema: "vendor.v7", nested: [null, false, 2] };
  record.shapes[0].custom = { lineage: "opaque" };
  record.layer_overrides = { unknown: true };
  inspect(record, "eligible");
  assert.equal(Object.hasOwn(record.shapes[0], "origin"), false);
  assert.equal(Object.hasOwn(record.sheets[0], "scale_confirmed"), false);
});

test("unscaled counts preserve the existing absent-count default; missing sheets collection refuses", () => {
  const record = fixture();
  record.shapes[0].measure_role = "count"; record.shapes[0].verts_norm = [[0.1, 0.1]];
  record.shapes[0].computed = {}; record.sheets = [];
  hasIssue(inspect(record, "eligible"), "legacy_count_default", "/shapes/0/computed", "warning");
  const missing = structuredClone(record); delete missing.sheets;
  hasIssue(inspect(missing, "unsupported"), "missing_sheets_collection", "/sheets");
});

test("surface condition height is supported; missing calibration does not infer PDF availability", () => {
  const record = fixture(); record.shapes[0].measure_role = "surface_area";
  record.conditions[0].height_ft = 3;
  const report = inspect(record, "eligible");
  assert.ok(report.notVerified.includes("source_availability"));
  const unscaled = structuredClone(record); unscaled.sheets = [];
  hasIssue(inspect(unscaled, "unsupported"), "missing_calibration", "/shapes/0/sheet_id");
  const noHeight = structuredClone(record); delete noHeight.conditions[0].height_ft;
  hasIssue(inspect(noHeight, "unsupported"), "missing_surface_height", "/shapes/0/height_ft");
});

test("historical references and already missing originals are warnings, never fabricated history", () => {
  const record = fixture();
  Object.assign(record.shapes[0].origin, { edited: true, derived: { from_shape_id: "deleted", between_shape_ids: ["room", "deleted"] } });
  const report = inspect(record, "eligible");
  hasIssue(report, "historical_reference_unavailable", "/shapes/0/origin", "warning");
  hasIssue(report, "original_geometry_unavailable", "/shapes/0/origin", "warning");
  assert.equal(Object.hasOwn(record.shapes[0].origin, "proposed_verts_norm"), false);
});

test("preflight detects schema-valid active-reference and role defects", () => {
  const ajv = validator();
  const cases = [
    [d => d.shapes.push(structuredClone(d.shapes[0])), "duplicate_id", "/shapes/1/id"],
    [d => d.conditions.push(structuredClone(d.conditions[0])), "duplicate_id", "/conditions/1/id"],
    [d => d.sheets.push(structuredClone(d.sheets[0])), "duplicate_id", "/sheets/1/sheet_id"],
    [d => { d.shapes[0].condition_id = "missing"; }, "missing_condition", "/shapes/0/condition_id"],
    [d => { d.shapes[0].origin.proposal_id = "missing"; }, "missing_proposal", "/shapes/0/origin/proposal_id"],
    [d => { d.condition_edit_proposals = [{ id: "edit", condition_id: "missing", proposed: {} }]; }, "missing_condition", "/condition_edit_proposals/0/condition_id"],
    [d => { d.shapes[0].verts_norm = [[1, 1], [1, 1], [2, 2]]; }, "insufficient_vertices", "/shapes/0/verts_norm"],
    [d => { d.shapes[0].computed = {}; }, "invalid_role_quantity", "/shapes/0/computed/area_sf"],
    [d => { d.shapes[0].computed.perimeter_lf = -1; }, "negative_quantity", "/shapes/0/computed/perimeter_lf"],
    [d => { d.shapes[0].measure_role = "count"; d.shapes[0].computed.count = 1.5; }, "invalid_role_quantity", "/shapes/0/computed/count"],
  ];
  for (const [mutate, code, path] of cases) {
    const record = fixture(); mutate(record);
    assertValid(assert, ajv, "legacy/takeoff-canvas.v1.schema.json", record);
    hasIssue(inspect(record, "invalid"), code, path, "error");
  }
});

test("known unsupported semantics refuse even when structural schema accepts them", () => {
  const ajv = validator();
  const cases = [
    [d => { d.stitches = [{ id: "stitch:join", name: "Joined", members: [{ key: sheet, dx: 0, dy: 0 }, { key: "other.pdf", dx: 100, dy: 0 }] }]; }, "unsupported_family", "/stitches"],
    ...["rules", "markups", "rfis"].map(key => [d => { d[key] = [{}]; }, "unsupported_family", `/${key}`]),
    [d => { d.shapes[0].sheet_id = "stitch:join"; }, "composite_frame", "/shapes/0/sheet_id"],
    [d => { d.shapes[0].curved = true; }, "legacy_curve", "/shapes/0/curved"],
    [d => { d.shapes[0].verts_norm_holes = [[[0.12, 0.12], [0.15, 0.12], [0.15, 0.15]]]; }, "hole_geometry", "/shapes/0/verts_norm_holes"],
    [d => { d.shapes[0].cuts_shape_id = "parent"; }, "reconciled_cutout", "/shapes/0"],
    [d => { d.shapes[0].origin.cuts_shape_id = "parent"; }, "reconciled_cutout", "/shapes/0"],
  ];
  for (const [mutate, code, path] of cases) {
    const record = fixture(); mutate(record);
    assertValid(assert, ajv, "legacy/takeoff-canvas.v1.schema.json", record);
    hasIssue(inspect(record, "unsupported"), code, path, "unsupported");
  }
  const baked = fixture(); baked.shapes[0].origin.curved = true;
  inspect(baked, "eligible");
});

test("eligibility explicitly does not verify topology, cached quantity correctness or MCP preservation", () => {
  const record = fixture(); record.shapes[0].verts_norm = [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]];
  record.shapes[0].computed.area_sf = 12345;
  const report = inspect(record, "eligible");
  for (const limit of ["polygon_topology", "geometry_accuracy", "quantity_recomputation", "history_completeness", "mcp_transport_preservation"])
    assert.ok(report.notVerified.includes(limit));
});

test("unsafe JSON values and getters refuse before schema validation, without invoking getters", () => {
  const extraArrayProperty = []; extraArrayProperty["4294967295"] = "JSON would discard this";
  class CustomArray extends Array { toJSON() { throw Error("must not run"); } }
  for (const value of [NaN, Infinity, -0, undefined, 1n, () => {}, new Date(), new Map(), [1, , 2], extraArrayProperty, new CustomArray()]) {
    const record = fixture(); record.extension = value;
    assert.equal(preflightTakeoff(record).status, "invalid");
    assert.equal(record.extension, value);
  }
  const circular = fixture(); circular.extension = circular;
  assert.equal(preflightTakeoff(circular).status, "invalid");
  let calls = 0;
  const accessor = fixture(); Object.defineProperty(accessor, "extension", { enumerable: true, get() { calls++; throw Error("must not run"); } });
  hasIssue(preflightTakeoff(accessor), "non_json_property", "/extension", "error");
  assert.equal(calls, 0);
  const escaped = fixture(); escaped["private/path~key"] = undefined;
  hasIssue(preflightTakeoff(escaped), "non_json_value", "/private~1path~0key");
  const deep = fixture(); let nested = deep;
  for (let n = 0; n < 101; n++) nested = nested.extra = {};
  assert.equal(preflightTakeoff(deep).status, "unsupported");
});

test("unknown identifiers and malformed known fields report invalid before semantic checks", () => {
  for (const value of [null, [], "hello", { schema: "future.v2" }])
    hasIssue(preflightTakeoff(value), "unknown_schema", "/schema", "error");
  const malformed = fixture(); malformed.shapes[0].origin.derived = { between_shape_ids: {} };
  hasIssue(inspect(malformed, "invalid"), "schema_invalid", "/shapes/0/origin/derived/between_shape_ids", "error");
});

test("CLI returns parseable reports and exit codes, keeps source bytes, and never emits source records", () => {
  const dir = mkdtempSync(join(tmpdir(), "ot-preflight-")), input = join(dir, "takeoff.json");
  const cli = fileURLToPath(new URL("../scripts/preflight.mjs", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  try {
    for (const [status, mutate] of [
      ["eligible", () => {}], ["unsupported", d => { d.rules = [{}]; }],
      ["invalid", d => { d.shapes[0].condition_id = "private-missing-condition"; }],
    ]) {
      const record = fixture(); record.project_name = "PRIVATE_SOURCE_VALUE"; mutate(record);
      const bytes = JSON.stringify(record, null, 4) + "\n"; writeFileSync(input, bytes);
      const result = run(input);
      assert.equal(result.status, status === "eligible" ? 0 : 1, result.stderr);
      assert.equal(JSON.parse(result.stdout).status, status);
      assert.doesNotMatch(result.stdout, /PRIVATE_SOURCE_VALUE|private-missing-condition/);
      assert.equal(readFileSync(input, "utf8"), bytes);
    }
    writeFileSync(input, "{ broken");
    assert.equal(run(input).status, 2);
    assert.equal(readFileSync(input, "utf8"), "{ broken");
    assert.equal(run(join(dir, "missing.json")).status, 2);
    assert.equal(run().status, 2);
    assert.equal(run(input, input).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
