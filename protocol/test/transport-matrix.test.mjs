import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "../../mcp/src/session.ts";
import { importTakeoff } from "../../mcp/src/importing.ts";
import { emptyAnnotations } from "../../web/src/lib/store.js";
import { mergeTakeoffImport, parseTakeoffImport } from "../../web/src/lib/importTakeoff.js";
import { applyShapeCommand } from "../../web/src/lib/shapeCommands.js";
import { applyApprovalCommand } from "../../web/src/lib/approvals.js";
import { buildProjectArchive, parseProjectArchive } from "../../web/src/lib/projectArchive.js";
import { conditionTotals } from "../../web/src/lib/totals.js";
import { flattenArc } from "../../web/src/lib/arc.js";
import { flattenCurve } from "../../web/src/lib/curve.js";
import { sanitizeStitches } from "../../web/src/lib/stitches.ts";
import { openLen } from "../../web/src/lib/geometry.js";
import { validator, assertValid, draftId } from "./helpers.mjs";

const matrix = JSON.parse(await readFile(new URL("transport-matrix.json", import.meta.url), "utf8"));
const ajv = validator();
const plan = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const sheet = "sample-plan.pdf";
const square = [[100, 100], [200, 100], [200, 200], [100, 200]];
const hole = [[120, 120], [140, 120], [140, 140], [120, 140]];
const clone = structuredClone;
async function session(scaled = true) {
  const s = new Session(); await s.loadPlan(plan);
  if (scaled) s.setScale(sheet, { upp: 0.1 });
  return s;
}
function structural(record) {
  assertValid(assert, ajv, "legacy/takeoff-canvas.v1.schema.json", record);
  assertValid(assert, ajv, "v1/takeoff-document.schema.json", { ...clone(record), schema: draftId });
}
// Fixture assertions, not a universal validator or import gate. Historical
// evidence may reference removed shapes; these cases check active joins only.
function activeRelations(record) {
  const ids = (rows, key = "id") => {
    const values = (rows ?? []).map(r => r[key]);
    assert.equal(new Set(values).size, values.length, `duplicate ${key}`);
    return new Set(values);
  };
  const shapes = ids(record.shapes), conditions = ids(record.conditions);
  const sheets = ids(record.sheets, "sheet_id"), proposals = ids(record.proposals);
  for (const s of record.shapes) {
    assert.ok(conditions.has(s.condition_id), "missing condition");
    assert.ok(sheets.has(s.sheet_id), "missing calibrated frame");
    if (s.cuts_shape_id) assert.ok(shapes.has(s.cuts_shape_id), "missing cutout parent");
    if (s.origin?.proposal_id) assert.ok(proposals.has(s.origin.proposal_id), "missing proposal");
  }
}
const totals = r => conditionTotals(r.conditions, r.shapes);
const quantity = (r, tag, field) => totals(r).find(c => c.finish_tag === tag)[field];
async function archive(record) {
  const before = clone(record);
  const bytes = await buildProjectArchive({ takeoff: record, sheets: [...new Set([sheet, ...(record.stitches ?? []).flatMap(s => s.members.map(m => m.key))])].map(name => ({ name })),
    loadPdfData: async () => new Uint8Array(await readFile(plan)) });
  const reopened = (await parseProjectArchive(bytes)).takeoff;
  assert.deepEqual(record, before); assert.deepEqual(reopened, before);
  structural(reopened); return reopened;
}
async function roundtrip(record, t) {
  const before = clone(record);
  const browser = mergeTakeoffImport(emptyAnnotations(), parseTakeoffImport(JSON.stringify(record))).payload;
  structural(browser);
  const next = await session(false), path = join(t.dir, "takeoff.json");
  for (const extra of t.extraPlans ?? []) await next.loadPlan(extra, { merge: true });
  await writeFile(path, JSON.stringify(browser)); await importTakeoff(next, path);
  const exported = clone(next.exportPayload()); structural(exported);
  assert.deepEqual(record, before, "source unchanged");
  return { next, exported, path };
}
function sameMeasurements(a, b) {
  for (const key of ["shapes", "conditions", "sheets", "proposals", "approvals"])
    assert.deepEqual(b[key], a[key], `${key} preserved`);
  assert.deepEqual(totals(b), totals(a)); activeRelations(b);
}
const cases = {
  async "manual-roundtrip"(t) {
    const s = await session(); s.proposeTakeoff("Synthetic manual roles", "Protocol fixture");
    s.measurePolygon(sheet, square, { condition: "F-1", role: "floor_area" });
    s.measurePolygon(sheet, hole, { condition: "F-1", role: "deduct" });
    s.measureLine(sheet, [[100, 300], [200, 300]], { condition: "B-1" });
    s.measureSurface(sheet, [[100, 400], [200, 400]], { condition: "W-1", height_ft: 3 });
    s.placeCount(sheet, [[300, 300], [400, 400]], { condition: "C-1" });
    const source = clone(s.exportPayload()); structural(source);
    assert.equal(source.shapes.find(x => x.measure_role === "floor_area").computed.area_sf, 100);
    assert.equal(source.shapes.find(x => x.measure_role === "deduct").computed.area_sf, 4);
    for (const [tag, field, value] of [["F-1", "floor_sf", 96], ["B-1", "lf", 10], ["W-1", "wall_sf", 30], ["C-1", "ea", 2]])
      assert.equal(quantity(source, tag, field), value);
    const { next, exported, path } = await roundtrip(source, t); sameMeasurements(source, exported);
    for (const shape of exported.shapes) {
      assert.equal(shape.origin.actor, "agent"); assert.equal(shape.origin.reviewed, false);
    }
    assert.equal(exported.sheets[0].scale_confirmed, false);
    await importTakeoff(next, path); assert.deepEqual(next.exportPayload(), exported);
  },
  async "cutout-roundtrip"(t) {
    const s = await session(); s.proposeTakeoff("Synthetic hole", "Protocol fixture");
    const room = s.measurePolygon(sheet, square, { condition: "F-1", role: "floor_area" });
    const before = clone(s.exportPayload());
    const cut = s.cutOut({ parent_shape_id: room.shape_id, verts: hole });
    const source = clone(s.exportPayload());
    assert.equal(quantity(source, "F-1", "floor_sf"), 96);
    assert.equal(source.shapes[0].verts_norm_holes.length, 1);
    assert.deepEqual(source.shapes[1].origin.parent_prev.computed, before.shapes[0].computed);
    const { next, exported } = await roundtrip(await archive(source), t); sameMeasurements(source, exported);
    next.deleteShape(cut.deduct_shape_id);
    assert.deepEqual(next.exportPayload(), before, "imported cutout restores exact parent snapshot");
  },
  async "derived-base-roundtrip"(t) {
    const s = await session();
    const room = s.measurePolygon(sheet, square, { condition: "F-1", role: "floor_area" });
    s.deriveBase({ source_condition: "F-1", condition: "B-1", openings: [{ shape_id: room.shape_id, lf: 3 }] });
    const source = clone(s.exportPayload()), run = source.shapes.find(x => x.measure_role === "linear");
    assert.deepEqual(run.origin.derived, { from_shape_id: room.shape_id, gross_lf: 40, openings_lf: 3 });
    assert.equal(quantity(source, "B-1", "lf"), 37);
    sameMeasurements(source, (await roundtrip(source, t)).exported);
  },
  async "curves-roundtrip"(t) {
    const s = await session(), control = [[100, 300], [150, 350], [200, 300]];
    s.conditions = [{ id: "curve-condition", finish_tag: "C-1", multiplier: 1, waste_pct: 0, materials: [] }];
    const baked = [control[0], ...flattenArc(...control), control[2]], frame = s.sheetList()[0];
    for (const [kind, points] of [["legacy", control], ["baked", baked]]) {
      const length = openLen(kind === "legacy" ? flattenCurve(control) : baked) * 0.1;
      s.shapes = applyShapeCommand(s.shapes, { type: "add", shapes: [{
        sheet_id: sheet, condition_id: s.conditions[0].id, measure_role: "linear",
        verts_norm: points.map(([x, y]) => [x / frame.widthPx, y / frame.heightPx]),
        computed: { area_sf: 0, perimeter_lf: Math.round(length * 100) / 100 },
        ...(kind === "legacy" ? { curved: true } : {}),
        origin: { method: "manual", curved: true, evidence: { fixture: kind } },
      }] }).shapes;
    }
    const source = clone(s.exportPayload());
    assert.equal(source.shapes[0].verts_norm.length, 3); assert.ok(source.shapes[1].verts_norm.length > 3);
    assert.notEqual(source.shapes[0].computed.perimeter_lf, source.shapes[1].computed.perimeter_lf);
    sameMeasurements(source, (await roundtrip(await archive(source), t)).exported);
  },
  async "review-transport"(t) {
    const s = await session(); s.measurePolygon(sheet, square, { condition: "F-1", role: "floor_area" });
    s.shapes[0].origin.evidence = { schedule_row_tag: "F-1", source_region: [0.1, 0.1, 0.2, 0.2] };
    const original = clone(s.shapes[0]);
    s.shapes = applyShapeCommand(s.shapes, { type: "geom", id: original.id, editKind: "vertex",
      verts_norm: original.verts_norm.map(([x, y]) => [x + 0.01, y]), computed: original.computed }).shapes;
    s.shapes = applyShapeCommand(s.shapes, { type: "review", ids: [original.id] }).shapes;
    s.approvals = applyApprovalCommand([], { type: "add", approvals: [{ actor: "estimator", sheet_id: sheet,
      at: [0.1, 0.1], shape_id: original.id }] }).approvals;
    const source = clone(s.exportPayload()), { next, exported } = await roundtrip(await archive(source), t);
    sameMeasurements(source, exported);
    assert.deepEqual(exported.shapes[0].origin.proposed_verts_norm, original.verts_norm);
    assert.deepEqual(exported.shapes[0].origin.evidence, original.origin.evidence);
    assert.throws(() => next.editShape(original.id, { label: "agent change" }), /affirmed by a human/);
    next.markVerdict({ sheet, at: [300, 300], actor: "estimator" });
    assert.deepEqual(next.approvals.map(a => a.actor), ["estimator", "agent"]);
    assert.deepEqual(next.shapes, exported.shapes);
  },
  async "scale-conflict"(t) {
    const source = await session(); source.measurePolygon(sheet, square, { condition: "F-1", role: "floor_area" });
    const record = clone(source.exportPayload()), next = await session(); next.setScale(sheet, { upp: 0.2 });
    const before = clone(next.exportPayload()), path = join(t.dir, "conflict.json");
    await writeFile(path, JSON.stringify(record)); await assert.rejects(importTakeoff(next, path), /scale conflict/);
    assert.deepEqual(next.exportPayload(), before); assert.deepEqual(source.exportPayload(), record);
  },
  async "draft-import"(t) {
    const s = await session(), record = { ...clone(s.exportPayload()), schema: draftId };
    assertValid(assert, ajv, "v1/takeoff-document.schema.json", record);
    assert.throws(() => parseTakeoffImport(JSON.stringify(record)), /expected schema/);
    const before = clone(s.exportPayload()), path = join(t.dir, "draft.json");
    await writeFile(path, JSON.stringify(record)); await assert.rejects(importTakeoff(s, path), /expected schema/);
    assert.deepEqual(s.exportPayload(), before);
  },
  async "stitch-mcp"(t) {
    const s = await session(); s.measurePolygon(sheet, square, { condition: "F-1", role: "floor_area" });
    const record = clone(s.exportPayload());
    record.stitches = sanitizeStitches([{ id: "stitch:fixture", name: "Synthetic composite", members: [
      { key: sheet, dx: 0, dy: 0 }, { key: "right.pdf", dx: 2000, dy: 0 }] }], 4);
    assert.equal(record.stitches.length, 1, "browser hydrate accepts the composite");
    const right = join(t.dir, "right.pdf");
    await writeFile(right, await readFile(plan));
    t.extraPlans = [right];
    record.shapes[0].sheet_id = "stitch:fixture";
    record.sheets.push({ sheet_id: "stitch:fixture", units_per_px: 0.1, scale_confirmed: false });
    const { exported } = await roundtrip(await archive(record), t);
    assert.deepEqual(exported.shapes, record.shapes); assert.equal(exported.stitches, undefined);
    assert.equal(exported.sheets.some(x => x.sheet_id === "stitch:fixture"), false);
    assert.throws(() => activeRelations(exported), /missing calibrated frame/);
  },
  async "extensions-mcp"(t) {
    const s = await session(); s.measurePolygon(sheet, square, { condition: "F-1", role: "floor_area" });
    const record = clone(s.exportPayload()); record.project_name = "Synthetic compatibility project";
    record.units = "metric"; record.custom_extension = { keep: true }; record.shapes[0].custom_extension = { keep: "shape" };
    record.rules = [{ id: "rule:fixture", seed_condition_id: record.conditions.find(c => c.finish_tag === "F-1").id,
      predicate: { kind: "enclosed_subpolygon_deduct", max_area_sf: 2 }, applied_to: [] }];
    const { next, exported } = await roundtrip(await archive(record), t);
    assert.deepEqual(next.rules, record.rules); assert.deepEqual(exported.shapes, record.shapes);
    assert.deepEqual(totals(exported), totals(record));
    assert.equal(exported.project_name, ""); assert.equal(exported.units, "imperial");
    assert.equal(exported.custom_extension, undefined); assert.equal(exported.rules, undefined);
  },
  async "missing-source"(t) {
    const s = await session(); s.measurePolygon(sheet, square, { condition: "F-1", role: "floor_area" });
    const record = clone(s.exportPayload()); record.shapes[0].sheet_id = "unloaded.pdf";
    record.sheets = [{ ...record.sheets[0], sheet_id: "unloaded.pdf" }]; structural(record);
    const { exported } = await roundtrip(record, t);
    assert.deepEqual(exported.shapes, record.shapes); assert.deepEqual(exported.sheets, []);
    assert.throws(() => activeRelations(exported), /missing calibrated frame/);
  },
};
test("compatibility catalog is unique, classified and has one executable case per row", () => {
  assert.deepEqual(matrix.map(c => c.id).sort(), Object.keys(cases).sort());
  for (const row of matrix) {
    assert.ok(["conforms", "needs-adapter", "unsupported"].includes(row.status)); assert.ok(row.scope && row.assertion);
  }
});
for (const row of matrix) test(`${row.id} [${row.status}]: ${row.scope}`, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ot-protocol-transport-"));
  t.after(() => rm(dir, { recursive: true, force: true })); await cases[row.id]({ dir });
});
test("schema conformance does not establish active references or verified quantities", async () => {
  const s = await session(); s.proposeTakeoff("Synthetic reference checks", "Protocol fixture");
  s.measurePolygon(sheet, square, { condition: "F-1", role: "floor_area" });
  const record = clone(s.exportPayload()); activeRelations(record);
  for (const change of [d => { d.shapes[0].condition_id = "absent"; }, d => { d.shapes[0].sheet_id = "absent"; },
    d => { d.shapes[0].origin.proposal_id = "absent"; }, d => { d.shapes.push(clone(d.shapes[0])); }]) {
    const bad = clone(record); change(bad); structural(bad); assert.throws(() => activeRelations(bad));
  }
  const bad = clone(record); bad.shapes[0].computed.area_sf = 999; structural(bad);
  assert.notDeepEqual(totals(bad), totals(record), "valid numeric field is not a verified quantity");
});
