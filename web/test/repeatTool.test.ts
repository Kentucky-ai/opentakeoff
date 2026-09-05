// T repeats a selected shape — the pure read of a committed shape into the
// tool + condition + curve switch to arm (src/lib/repeatTool.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAxisAlignedQuad, toolForShape, repeatPlan } from "../src/lib/repeatTool.js";

const rect = [[0.1, 0.1], [0.4, 0.1], [0.4, 0.3], [0.1, 0.3]];
const rectCCW = [[0.1, 0.1], [0.1, 0.3], [0.4, 0.3], [0.4, 0.1]];
const tri = [[0.1, 0.1], [0.4, 0.1], [0.25, 0.3]];
const skew = [[0.1, 0.1], [0.4, 0.12], [0.4, 0.3], [0.1, 0.3]];
const ell = [[0, 0], [0.2, 0], [0.2, 0.1], [0.1, 0.1], [0.1, 0.2], [0, 0.2]];

test("isAxisAlignedQuad: exactly the ring Rectangle draws, either winding", () => {
  assert.equal(isAxisAlignedQuad(rect), true);
  assert.equal(isAxisAlignedQuad(rectCCW), true);
  assert.equal(isAxisAlignedQuad(tri), false, "three corners");
  assert.equal(isAxisAlignedQuad(skew), false, "one edge off-axis");
  assert.equal(isAxisAlignedQuad(ell), false, "six corners, all axis-aligned, still not a rectangle");
  assert.equal(isAxisAlignedQuad([[0, 0], [0, 0], [1, 0], [1, 1]]), false, "zero-length edge");
  assert.equal(isAxisAlignedQuad(undefined), false);
  assert.equal(isAxisAlignedQuad([[0, 0], [1, 0], [1, 1], null]), false);
});

test("toolForShape: measure_role → tool, rectangles get the faster tool", () => {
  assert.equal(toolForShape({ measure_role: "floor_area", verts_norm: rect }), "rect");
  assert.equal(toolForShape({ measure_role: "floor_area", verts_norm: tri }), "area");
  assert.equal(toolForShape({ measure_role: "floor_area", verts_norm: ell }), "area");
  assert.equal(toolForShape({ measure_role: "deduct", verts_norm: rect }), "deduct-rect");
  assert.equal(toolForShape({ measure_role: "deduct", verts_norm: skew }), "deduct");
  assert.equal(toolForShape({ measure_role: "linear", verts_norm: [[0, 0], [1, 0]] }), "linear");
  assert.equal(toolForShape({ measure_role: "surface_area", verts_norm: [[0, 0], [1, 0], [1, 1]], height_ft: 4 }), "surface");
  assert.equal(toolForShape({ measure_role: "count", verts_norm: [[0.5, 0.5]] }), "count");
});

test("toolForShape: a curved four-point ring is an Area, never a Rectangle", () => {
  assert.equal(toolForShape({ measure_role: "floor_area", verts_norm: rect, curved: true }), "area");
  assert.equal(toolForShape({ measure_role: "deduct", verts_norm: rect, curved: true }), "deduct");
});

test("toolForShape: nothing repeatable → null (unknown role, no record)", () => {
  assert.equal(toolForShape({ measure_role: "zone", verts_norm: rect }), null);
  assert.equal(toolForShape({ verts_norm: rect }), null);
  assert.equal(toolForShape(null), null);
  assert.equal(toolForShape("CPT-1"), null);
});

test("repeatPlan: condition + tool + curve switch, curve only on bendable tools", () => {
  assert.deepEqual(repeatPlan({ condition_id: "c1", measure_role: "floor_area", verts_norm: tri, curved: true }), { conditionId: "c1", tool: "area", curve: true });
  assert.deepEqual(repeatPlan({ condition_id: "c1", measure_role: "floor_area", verts_norm: rect }), { conditionId: "c1", tool: "rect", curve: false });
  assert.deepEqual(repeatPlan({ condition_id: "c2", measure_role: "linear", verts_norm: [[0, 0], [1, 1]], curved: true }), { conditionId: "c2", tool: "linear", curve: true });
  assert.deepEqual(repeatPlan({ condition_id: "c3", measure_role: "count", verts_norm: [[0.5, 0.5]], curved: true }), { conditionId: "c3", tool: "count", curve: false });
  assert.deepEqual(repeatPlan({ measure_role: "surface_area", verts_norm: [[0, 0], [1, 0]] }), { conditionId: null, tool: "surface", curve: false });
  assert.equal(repeatPlan({ measure_role: "zone", verts_norm: rect }), null);
});
