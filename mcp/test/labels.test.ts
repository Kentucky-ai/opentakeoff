// Room labels on the wire, and the seam basis they share a purpose with.
//
// Both are about the same failure: a takeoff that arrives as one undifferentiated
// pile of square feet. detect_rooms already READS the room number off the sheet
// to decide where to flood — dropping it on the floor afterwards means nobody
// downstream can say which 438 SF belongs to room 103, and no amount of later
// analysis recovers it. So the room number rides the committed shape as `label`,
// the same field the canvas groups the Report by, and edit_shape can set or
// clear it for the shapes an agent traced by hand.
//
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Session } from "../src/session.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";

/** A scaled session with the demo plan's 4 rooms committed under one tag. */
async function swept() {
  const s = new Session();
  await s.loadPlan(PLAN);
  s.setScale(KEY, { use_detected: true });
  await s.detectRooms(KEY, { condition: "CPT-1", role: "floor_area", returnVerts: false });
  return s;
}

// ── detect_rooms stamps the room it traced from ─────────────────────────────

test("detect_rooms: every committed room carries the room number it was traced from", async () => {
  const s = await swept();
  assert.equal(s.shapes.length, 4);
  assert.deepEqual(s.shapes.map((x) => x.label).sort(), ["101", "102", "103", "104"]);
});

test("detect_rooms: a preview that commits nothing stamps nothing", async () => {
  const s = new Session();
  await s.loadPlan(PLAN);
  s.setScale(KEY, { use_detected: true });
  const r = await s.detectRooms(KEY, { role: "floor_area", returnVerts: false });
  assert.equal(r.detected, 4);
  assert.equal(s.shapes.length, 0, "no condition given — nothing to label");
});

test("exportPayload carries the label — the canvas loads the sweep already sliced by room", async () => {
  const s = await swept();
  const p = s.exportPayload() as { shapes: { label?: string }[] };
  assert.deepEqual(p.shapes.map((x) => x.label).sort(), ["101", "102", "103", "104"]);
});

test("list_shapes discloses the label, and omits the key when a shape has none", async () => {
  const s = await swept();
  const rows = s.listShapes().shapes as { id: string; label?: string }[];
  assert.deepEqual(rows.map((x) => x.label).sort(), ["101", "102", "103", "104"]);
  s.editShape(rows[0].id, { label: "" });
  const after = s.listShapes().shapes as { label?: string }[];
  assert.equal(after.filter((x) => "label" in x).length, 3, "a cleared label is an ABSENT key, not an empty string");
});

// ── edit_shape ──────────────────────────────────────────────────────────────

test("edit_shape: label alone sets it, reports it in changed, and touches no quantity", async () => {
  const s = await swept();
  const before = s.shapes[0];
  const area = before.computed.area_sf;
  const r = s.editShape(before.id, { label: "BREAK 105" });
  assert.deepEqual(r.changed, ["label"]);
  assert.equal(r.label, "BREAK 105");
  assert.equal(r.area_sf, area, "renaming a room does not re-measure it");
  assert.equal(s.shapes[0].label, "BREAK 105");
  assert.equal(s.shapes[0].origin?.agent_edits, 1, "still an agent self-revision like any other");
});

test('edit_shape: "" clears the label; whitespace is not a label either', async () => {
  const s = await swept();
  const id = s.shapes[0].id;
  assert.deepEqual(s.editShape(id, { label: "" }).changed, ["label"]);
  assert.ok(!("label" in s.shapes[0]), "the key goes — an export never ships label: \"\" for no room");
  s.editShape(id, { label: "   " });
  assert.ok(!("label" in s.shapes[0]));
  s.editShape(id, { label: "  103  " });
  assert.equal(s.shapes[0].label, "103", "trimmed, the same rule the canvas reads labels by");
});

test("edit_shape: a label edit rides along with geometry, condition, and role", async () => {
  const s = await swept();
  const id = s.shapes[0].id;
  const r = s.editShape(id, { condition: "VCT-1", label: "104A" });
  assert.deepEqual(r.changed, ["condition", "label"]);
  assert.equal(s.shapes[0].label, "104A");
  assert.equal(s.conditions.find((c) => c.id === s.shapes[0].condition_id)?.finish_tag, "VCT-1");
});

test("edit_shape: an edit that changes nothing still refuses, and names label among the options", async () => {
  const s = await swept();
  assert.throws(() => s.editShape(s.shapes[0].id, {}), /at least one of verts, condition, role, label/);
});

test("undo_last restores a label exactly — set and cleared alike", async () => {
  const s = await swept();
  const id = s.shapes[0].id;
  s.editShape(id, { label: "OFFICE 101" });
  s.undoLast(1);
  assert.equal(s.shapes.find((x) => x.id === id)?.label, "101", "the edit op snapshots the whole shape");
  s.editShape(id, { label: "" });
  assert.ok(!("label" in s.shapes.find((x) => x.id === id)!));
  s.undoLast(1);
  assert.equal(s.shapes.find((x) => x.id === id)?.label, "101", "a cleared label comes back too");
});

test("edit_shape: reviewed work is still ink — a label is not a loophole", async () => {
  const s = await swept();
  s.shapes[0].origin = { ...s.shapes[0].origin, reviewed: true } as any;
  assert.throws(() => s.editShape(s.shapes[0].id, { label: "x" }), /affirmed by a human/);
});

// ── the seam basis ──────────────────────────────────────────────────────────
// Same session, because the point of both is per-room truth: a weld rod's
// quantity comes off the layout of the rooms this sweep just traced.

test("edit_materials accepts basis seam_lf, and the report reads 0 until a roll setup exists", async () => {
  const s = await swept();
  s.editMaterials("CPT-1", { add: [{ name: "Seam tape", per: 1, basis: "seam_lf", unit: "lf" }] });
  const rep = s.exportReport() as any;
  const line = rep.conditions[0].materials.find((m: any) => m.name === "Seam tape");
  assert.equal(line.basis, "seam_lf", "the basis is disclosed to a pricing consumer");
  assert.ok(line.basis_qty === 0, "nothing has decided how this gets cut — 0, not a guess off the area");
  assert.ok(line.qty === 0);
  assert.deepEqual(rep.roll_goods, []);
});

test("a roll setup turns the same row into a real quantity, figured off the cut layout", async () => {
  const s = await swept();
  s.editMaterials("CPT-1", { add: [{ name: "Seam tape", per: 1, basis: "seam_lf", unit: "lf" }] });
  const ec = s.editCondition("CPT-1", { roll_setup: { material: "carpet", roll_width_ft: 12 } }) as any;
  assert.ok(ec.roll.seam_lf > 0, "the demo rooms are wider than a 12-ft roll, so they seam");

  const rep = s.exportReport() as any;
  const line = rep.conditions[0].materials.find((m: any) => m.name === "Seam tape");
  assert.equal(line.basis_qty, rep.roll_goods[0].seam_lf, "the row divides the SAME figure the roll block reports");
  assert.ok(line.qty > 0);

  // and it is the layout that decides, not the area: a roll wide enough to
  // cover each room in one strip has nothing to weld, at identical SF
  s.editCondition("CPT-1", { roll_setup: { material: "carpet", roll_width_ft: 40 } });
  const wide = s.exportReport() as any;
  assert.equal(wide.conditions[0].total_sf, rep.conditions[0].total_sf, "same square footage");
  assert.equal(wide.roll_goods[0].seam_lf, 0);
  assert.ok(wide.conditions[0].materials.find((m: any) => m.name === "Seam tape").qty === 0);
});

test("takeoff_summary runs the seam basis too — the compact reply cannot disagree with the report", async () => {
  const s = await swept();
  s.editMaterials("CPT-1", { add: [{ name: "Seam tape", per: 1, basis: "seam_lf", unit: "lf" }] });
  s.editCondition("CPT-1", { roll_setup: { material: "carpet", roll_width_ft: 12 } });
  const sum = s.summary() as any;
  const rep = s.exportReport() as any;
  // summary strips materials for compactness, so compare what it does carry
  assert.equal(sum.conditions[0].total_sf, rep.conditions[0].total_sf);
  assert.ok(!("materials" in sum.conditions[0]));
});
