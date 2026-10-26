import { test } from "node:test";
import assert from "node:assert/strict";
import { validator, schemas, schemaBase, legacyId, draftId, assertValid } from "./helpers.mjs";

const ajv = validator();
const shape = () => ({
  id: "shape-1", sheet_id: "plan.pdf", condition_id: "finish-1",
  measure_role: "floor_area", verts_norm: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5]],
  computed: { area_sf: 100, perimeter_lf: 40 },
  origin: { method: "manual", actor: "agent", reviewed: false },
});
const document = () => ({
  schema: draftId, conditions: [{ id: "finish-1", finish_tag: "F-1" }],
  sheets: [{ sheet_id: "plan.pdf", units_per_px: 1 / 36, scale_confirmed: false }],
  shapes: [shape()],
});

test("all draft and legacy schemas compile offline with unique identifiers", () => {
  assert.equal(new Set(schemas.map(({ schema }) => schema.$id)).size, schemas.length);
  for (const { path, schema } of schemas) {
    assert.equal(ajv.validateSchema(schema), true, path);
    assert.equal(typeof ajv.getSchema(schema.$id), "function", path);
  }
  for (const name of ["measurement", "calibration", "provenance", "evidence", "review"]) {
    assert.ok(ajv.getSchema(`${schemaBase}v1/${name}.schema.json`));
  }
});

test("document identifiers are explicit; neither version is silently accepted as the other", () => {
  const draft = document();
  const legacy = { ...structuredClone(draft), schema: legacyId };
  assertValid(assert, ajv, "v1/takeoff-document.schema.json", draft);
  assertValid(assert, ajv, "legacy/takeoff-canvas.v1.schema.json", legacy);
  assert.equal(ajv.getSchema(schemaBase + "v1/takeoff-document.schema.json")(legacy), false);
  assert.equal(ajv.getSchema(schemaBase + "legacy/takeoff-canvas.v1.schema.json")(draft), false);
  assert.equal(ajv.getSchema(schemaBase + "v1/takeoff-document.schema.json")({ ...draft, schema: "opentakeoff.takeoff-document.v2" }), false);
});

test("invalid coordinates, scale, confidence and review types are rejected without coercion", () => {
  const check = ajv.getSchema(schemaBase + "v1/takeoff-document.schema.json");
  const mutations = [
    (d) => { d.shapes[0].verts_norm[0] = [0.2]; },
    (d) => { d.shapes[0].verts_norm[0] = [0.2, 0.2, 0.2]; },
    (d) => { d.shapes[0].verts_norm[0][0] = "0.2"; },
    (d) => { d.shapes[0].verts_norm[0][0] = NaN; },
    (d) => { d.shapes[0].computed.area_sf = Infinity; },
    (d) => { d.sheets[0].units_per_px = 0; },
    (d) => { d.sheets[0].units_per_px = -0.01; },
    (d) => { d.sheets[0].scale_confirmed = "true"; },
    (d) => { d.shapes[0].origin.confidence = 1.01; },
    (d) => { d.shapes[0].origin.reviewed = "approved"; },
    (d) => { d.shapes[0].created_at = "yesterday"; },
    (d) => { d.shapes[0].origin.edits = { vertex: -1 }; },
  ];
  for (const mutate of mutations) {
    const d = document(); mutate(d);
    const before = structuredClone(d);
    assert.equal(check(d), false, mutate.toString());
    assert.deepEqual(d, before);
  }
});

test("actor is independent of method; missing legacy review and author stay absent", () => {
  const d = document();
  delete d.shapes[0].origin.reviewed;
  delete d.sheets[0].scale_confirmed;
  assertValid(assert, ajv, "v1/takeoff-document.schema.json", d);
  assert.equal("author" in d.shapes[0], false);
  assert.equal("reviewed" in d.shapes[0].origin, false);
  assert.equal("scale_confirmed" in d.sheets[0], false);
});

test("unknown extensions and out-of-sheet geometry survive structural validation", () => {
  const d = document();
  d.custom_workspace = { version: 1, retained: [1, 2, 3] };
  d.shapes[0].origin.actor = "future-unclassified-actor";
  d.shapes[0].origin.custom_evidence = { source: "fixture" };
  d.shapes[0].verts_norm[0] = [-0.1, 1.1];
  assertValid(assert, ajv, "v1/takeoff-document.schema.json", d);
});

test("Review distinguishes record shapes but cannot authenticate a human claim", () => {
  const path = "v1/review.schema.json";
  assertValid(assert, ajv, path, { reviewed: false });
  assertValid(assert, ajv, path, { reviewed: true, accepted_ts: "2026-09-10T12:00:00Z" });
  for (const actor of ["agent", "estimator"]) {
    assertValid(assert, ajv, path, { id: "approval-1", actor, sheet_id: "plan.pdf", at: [0.2, 0.2] });
  }
  assert.equal(ajv.getSchema(schemaBase + path)({}), false);
  // Runtime tests, not this data schema, enforce who can mint each record.
});

test("known secondary families retain data without claiming full semantic validation", () => {
  const d = document();
  d.markups = [{ id: "capture-1", type: "image", src_sheet_id: "plan.pdf", src_rect: [[0, 0], [0.2, 0.2]] }];
  d.rfis = [{ id: "rfi-1", origin: { actor: "agent", reviewed: false }, status: "open" }];
  d.rules = [{ id: "rule-1", seed_shape_id: "shape-1" }];
  assertValid(assert, ajv, "v1/takeoff-document.schema.json", d);
  // Draft conformance does not claim relationship resolution or full markup/RFI schemas.
});
