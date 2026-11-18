import test from "node:test";
import assert from "node:assert/strict";
import { workSelection, workSelectionBounds, workSelectionPaths } from "../src/lib/workSelection.js";
import { filterWork } from "../src/lib/workReview.js";
import { applyShapeCommand } from "../src/lib/shapeCommands.js";

const shape = (id: string, reviewed?: boolean) => ({ id, condition_id: "tree", sheet_id: "plan", measure_role: "count", verts_norm: [[.2, .3]], computed: { count: 1 }, origin: { actor: "agent", ...(reviewed === undefined ? {} : { reviewed }) } });

test("selection ignores stale and duplicate IDs and keeps existing records untouched", () => {
  const rows = [shape("one", false), shape("two", false), shape("kept", true), shape("legacy")];
  const before = structuredClone(rows);
  const result = workSelection(rows, ["one", "one", "kept", "legacy", "missing"]);
  assert.deepEqual(result.rows.map((s: any) => s.id), ["one", "kept", "legacy"]);
  assert.deepEqual(result.pendingIds, ["one"]);
  assert.deepEqual(result.sheetIds, ["plan"]);
  assert.deepEqual(rows, before);
  assert.deepEqual(workSelection(rows, []).pendingIds, []);
});

test("native review and one undo change only selected pending decisions, never quantities or geometry", () => {
  const rows = [shape("one", false), { ...shape("line", false), measure_role: "linear", computed: { perimeter_lf: 12 } }, { ...shape("area", false), measure_role: "floor_area", computed: { area_sf: 40 } }, shape("kept", true), shape("unselected", false)];
  const before = structuredClone(rows);
  const selection = workSelection(rows, ["one", "line", "area", "kept"]);
  const reviewed = applyShapeCommand(rows, { type: "review", ids: selection.pendingIds });
  assert.deepEqual(reviewed.shapes.map((s: any) => s.origin.reviewed), [true, true, true, true, false]);
  assert.deepEqual(reviewed.shapes.map((s: any) => [s.id, s.verts_norm, s.computed]), rows.map(s => [s.id, s.verts_norm, s.computed]));
  assert.deepEqual(reviewed.shapes.slice(3), rows.slice(3));
  const undone = applyShapeCommand(reviewed.shapes, reviewed.inverse);
  assert.deepEqual(undone.shapes, before);
  assert.deepEqual(applyShapeCommand(undone.shapes, undone.inverse).shapes, reviewed.shapes);
  assert.deepEqual(rows, before);
});

test("filtered selection includes matching rows beyond the 50-row display page", () => {
  const rows = [...Array.from({ length: 75 }, (_, i) => shape(`tree-${i}`, false)), { ...shape("other", false), condition_id: "shrub" }];
  const filtered = filterWork(rows, { query: "tree", conditionLabel: ((id: string) => id) as any });
  const selection = workSelection(rows, filtered.map((s: any) => s.id));
  assert.equal(selection.pendingIds.length, 75);
  assert.equal(selection.pendingIds.includes("other"), false);
  const result = applyShapeCommand(rows, { type: "review", ids: selection.pendingIds });
  assert.equal(result.shapes.filter((s: any) => s.origin.reviewed).length, 75);
  assert.equal(result.shapes.at(-1).origin.reviewed, false);
});

test("missing or malformed locations remain selected but cannot be located or bulk reviewed", () => {
  for (const patch of [{ sheet_id: "" }, { verts_norm: [] }, { verts_norm: [[NaN, .2]] }, { verts_norm: [[.1]] }]) {
    const result = workSelection([{ ...shape("bad", false), ...patch }], ["bad"]);
    assert.equal(result.rows.length, 1);
    assert.equal(result.locatable.length, 0);
    assert.equal(result.pendingIds.length, 0);
  }
});

test("selection framing uses each sheet's dimensions and side-by-side offset", () => {
  const rows = [{ ...shape("a"), verts_norm: [[.1, .1]] }, { ...shape("b"), sheet_id: "other", measure_role: "linear", verts_norm: [[.2, .3], [.4, .5]] }];
  const panels = [{ key: "plan", img: { w: 100, h: 100 }, xOffset: 0 }, { key: "other", img: { w: 100, h: 200 }, xOffset: 200 }];
  assert.deepEqual(workSelectionBounds(rows, panels), { x0: 10, y0: 10, x1: 240, y1: 100 });
  assert.equal(workSelectionBounds(rows, panels.slice(0, 1)), null);
  assert.equal(workSelectionBounds([], panels), null);
  assert.deepEqual(workSelectionPaths({ ...rows[0], verts_norm_holes: [[[.2, .2], [.3, .3]]] }, panels[0]), [[[10, 10]], [[20, 20], [30, 30]]]);
});

test("curved paths use the renderer's flattened geometry without changing stored vertices", () => {
  const row = { ...shape("curve"), measure_role: "linear", curved: true, verts_norm: [[0, 0], [.5, .8], [1, 0]] };
  const before = structuredClone(row);
  const panel = { key: "plan", img: { w: 100, h: 100 }, xOffset: 0 };
  const [path] = workSelectionPaths(row, panel);
  assert(path.length > row.verts_norm.length);
  assert.deepEqual(path[0], [0, 0]);
  assert.deepEqual(path.at(-1), [100, 0]);
  const bounds = workSelectionBounds([row], [panel]);
  assert(bounds);
  assert(bounds.y1 >= 80);
  assert.deepEqual(row, before);
});

test("large selections frame without spreading a large vertex list into function arguments", () => {
  const row = { ...shape("many"), measure_role: "linear", verts_norm: Array.from({ length: 150000 }, (_, i) => [i / 149999, .5]) };
  assert.deepEqual(workSelectionBounds([row], [{ key: "plan", img: { w: 100, h: 100 }, xOffset: 0 }]), { x0: 0, y0: 50, x1: 100, y1: 50 });
});
