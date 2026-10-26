// Shape-level three-way merge (#313) — the fixture suite the RFC's finish line
// names: all four quadrants (add/add, edit/edit, delete/edit, reimport), pure
// Node, no browser. mergeAnnotations is a pure function of (base, local,
// remote); determinism is asserted by merging both "seatings" of the same
// divergence and requiring identical content.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeAnnotations, samePayload } from "../src/lib/sync/merge.js";

const shape = (id: string, over: any = {}) => ({
  id, sheet_id: "plan.pdf#1", condition_id: "c1",
  verts_norm: [[0, 0], [0.1, 0], [0.1, 0.1]],
  created_at: "2026-08-24T00:00:00.000Z",
  ...over,
});
const payload = (over: any = {}) => ({
  schema: 1, conditions: [{ id: "c1", finish_tag: "CPT-1" }], shapes: [],
  markups: [], sheets: [], sheet_group: [], last_group: [], sheet_tabs: [],
  rules: [], approvals: [], stitches: [], ...over,
});
const ids = (arr: any[]) => arr.map((r) => r.id).sort();

// ── quadrant 1: add/add ─────────────────────────────────────────────────────

test("add/add: 50 shapes each side on different sheets union to all 100, clean", () => {
  const base = payload();
  const mine = Array.from({ length: 50 }, (_, i) => shape(`L${i}`, { sheet_id: "plan.pdf#1" }));
  const theirs = Array.from({ length: 50 }, (_, i) => shape(`R${i}`, { sheet_id: "plan.pdf#2" }));
  const local = payload({ shapes: mine });
  const remote = payload({ shapes: theirs });

  const m: any = mergeAnnotations(base, local, remote);
  assert.equal(m.merged.shapes.length, 100);
  assert.deepEqual(ids(m.merged.shapes), ids([...mine, ...theirs]));
  assert.equal(m.clean, true);
  assert.deepEqual(m.conflicts, []);
  assert.deepEqual(m.review_sheets, []);
});

test("add/add is symmetric in content: merging from either machine's seat converges", () => {
  const base = payload();
  const local = payload({ shapes: [shape("L1")] });
  const remote = payload({ shapes: [shape("R1")] });
  const a: any = mergeAnnotations(base, local, remote).merged;
  const b: any = mergeAnnotations(base, remote, local).merged;
  assert.deepEqual(ids(a.shapes), ids(b.shapes)); // same set either way
});

test("conditions added on both sides union by id — duplicate finish_tags are both kept", () => {
  const base = payload();
  const local = payload({ conditions: [...base.conditions, { id: "cL", finish_tag: "CT-1" }] });
  const remote = payload({ conditions: [...base.conditions, { id: "cR", finish_tag: "CT-1" }] });
  const m: any = mergeAnnotations(base, local, remote);
  assert.deepEqual(ids(m.merged.conditions), ["c1", "cL", "cR"]);
  assert.equal(m.clean, true);
});

// ── quadrant 2: edit/edit ───────────────────────────────────────────────────

test("edit/edit on one uid: updated_at-latest wins, loser ring preserved on the winner", () => {
  const base = payload({ shapes: [shape("s1")] });
  const local = payload({
    shapes: [shape("s1", { verts_norm: [[0, 0], [0.2, 0], [0.2, 0.2]], updated_at: "2026-08-24T02:00:00.000Z", updated_by: "Michael" })],
  });
  const remote = payload({
    shapes: [shape("s1", { verts_norm: [[0, 0], [0.3, 0], [0.3, 0.3]], updated_at: "2026-08-24T01:00:00.000Z", updated_by: "Aaron" })],
  });
  const m: any = mergeAnnotations(base, local, remote);
  assert.equal(m.merged.shapes.length, 1);
  const s = m.merged.shapes[0];
  assert.deepEqual(s.verts_norm, [[0, 0], [0.2, 0], [0.2, 0.2]]); // local is later → wins
  assert.equal(s.updated_by, "Michael");
  assert.deepEqual(s.merge_loser.verts_norm, [[0, 0], [0.3, 0], [0.3, 0.3]]); // Aaron's ring recoverable
  assert.equal(s.merge_loser.updated_by, "Aaron");
  assert.deepEqual(m.conflicts, [{ key: "shapes", id: "s1", winner: "local" }]);
  assert.equal(m.clean, false);
});

test("edit/edit with LYING CLOCKS (identical stamps) still resolves deterministically — remote wins", () => {
  const t = "2026-08-24T01:00:00.000Z";
  const base = payload({ shapes: [shape("s1")] });
  const local = payload({ shapes: [shape("s1", { updated_at: t, condition_id: "cL" })] });
  const remote = payload({ shapes: [shape("s1", { updated_at: t, condition_id: "cR" })] });
  const m1: any = mergeAnnotations(base, local, remote);
  assert.equal(m1.merged.shapes[0].condition_id, "cR"); // the side holding the rev
  assert.equal(m1.merged.shapes[0].merge_loser.condition_id, "cL");
  // and re-merging the torn aftermath (winner+loser vs bare winner) is NOT a new fight
  const m2: any = mergeAnnotations(remote, m1.merged, remote);
  assert.equal(m2.clean, true);
  assert.equal(m2.merged.shapes[0].condition_id, "cR");
  assert.deepEqual(m2.merged.shapes[0].merge_loser.condition_id, "cL"); // preserved, not dropped
});

test("edit/edit converging to the SAME geometry is not a conflict", () => {
  const base = payload({ shapes: [shape("s1")] });
  const edit = shape("s1", { verts_norm: [[0, 0], [0.5, 0], [0.5, 0.5]], updated_at: "2026-08-24T03:00:00.000Z" });
  const m: any = mergeAnnotations(base, payload({ shapes: [edit] }), payload({ shapes: [edit] }));
  assert.equal(m.clean, true);
  assert.equal(m.merged.shapes.length, 1);
});

test("one-sided edit takes the edit, no conflict", () => {
  const base = payload({ shapes: [shape("s1")] });
  const edited = shape("s1", { updated_at: "2026-08-24T04:00:00.000Z", condition_id: "c9" });
  const m: any = mergeAnnotations(base, payload({ shapes: [edited] }), base);
  assert.equal(m.merged.shapes[0].condition_id, "c9");
  assert.equal(m.clean, true);
});

// ── quadrant 3: delete vs edit / delete vs untouched ───────────────────────

test("deleted on one side, untouched on the other → deleted", () => {
  const base = payload({ shapes: [shape("s1"), shape("s2")] });
  const local = payload({ shapes: [shape("s2")] });      // deleted s1
  const remote = payload({ shapes: base.shapes });        // untouched
  const m: any = mergeAnnotations(base, local, remote);
  assert.deepEqual(ids(m.merged.shapes), ["s2"]);
  assert.equal(m.clean, true);
});

test("deleted on one side, EDITED on the other → the edit survives", () => {
  const base = payload({ shapes: [shape("s1")] });
  const local = payload({ shapes: [] });                  // deleted it
  const remote = payload({ shapes: [shape("s1", { updated_at: "2026-08-24T05:00:00.000Z", condition_id: "c7" })] });
  const m: any = mergeAnnotations(base, local, remote);
  assert.equal(m.merged.shapes.length, 1);
  assert.equal(m.merged.shapes[0].condition_id, "c7");    // the correction was not thrown away
  assert.equal(m.clean, true);
});

test("deleted on both sides stays deleted", () => {
  const base = payload({ shapes: [shape("s1")] });
  const m: any = mergeAnnotations(base, payload(), payload());
  assert.deepEqual(m.merged.shapes, []);
  assert.equal(m.clean, true);
});

test("a condition deleted on one side with its shapes, untouched on the other → both go", () => {
  const base = payload({ conditions: [{ id: "c1", finish_tag: "CPT-1" }, { id: "c2", finish_tag: "LVT-1" }], shapes: [shape("s1", { condition_id: "c2" })] });
  const local = payload({ conditions: [{ id: "c1", finish_tag: "CPT-1" }], shapes: [] }); // deleted c2 + its shape
  const m: any = mergeAnnotations(base, local, base);
  assert.deepEqual(ids(m.merged.conditions), ["c1"]);
  assert.deepEqual(m.merged.shapes, []);
});

// ── quadrant 4: re-import (re-minted uids) ─────────────────────────────────

test("same-sheet re-import on both sides degrades to union-plus-review, never silent", () => {
  const base = payload({ shapes: [shape("old1"), shape("old2")] });
  // both sides re-imported plan.pdf#1: base uids gone, fresh uids minted
  const local = payload({ shapes: [shape("newL1"), shape("newL2")] });
  const remote = payload({ shapes: [shape("newR1"), shape("newR2")] });
  const m: any = mergeAnnotations(base, local, remote);
  assert.deepEqual(ids(m.merged.shapes), ["newL1", "newL2", "newR1", "newR2"]); // union — nothing lost
  assert.deepEqual(m.review_sheets, ["plan.pdf#1"]); // ...but flagged for human review
  assert.equal(m.clean, false);
});

test("re-import on ONE side only is not flagged (normal delete+add)", () => {
  const base = payload({ shapes: [shape("old1")] });
  const local = payload({ shapes: [shape("newL1")] });
  const m: any = mergeAnnotations(base, local, base);
  assert.deepEqual(ids(m.merged.shapes), ["newL1"]);
  assert.deepEqual(m.review_sheets, []);
});

// ── non-keyed keys + payload equality ──────────────────────────────────────

test("un-id'd arrays and scalars: changed side wins; both changed → remote", () => {
  const base = payload({ sheet_tabs: ["a"], schema: 1 });
  const local = payload({ sheet_tabs: ["a", "b"], schema: 1 });
  const remote = payload({ sheet_tabs: ["a"], schema: 2 });
  const m: any = mergeAnnotations(base, local, remote);
  assert.deepEqual(m.merged.sheet_tabs, ["a", "b"]); // only local touched it
  assert.equal(m.merged.schema, 2);                  // only remote touched it
  const both: any = mergeAnnotations(base, payload({ sheet_tabs: ["x"] }), payload({ sheet_tabs: ["y"] }));
  assert.deepEqual(both.merged.sheet_tabs, ["y"]);   // both → remote, deterministic
});

test("totals are never merged: no computed/total keys are invented by the merge", () => {
  const base = payload({ shapes: [shape("s1", { computed: { area_sf: 100 } })] });
  const m: any = mergeAnnotations(base, base, base);
  assert.deepEqual(m.merged.shapes[0].computed, { area_sf: 100 }); // carried, not recomputed
});

test("samePayload ignores rev and key order", () => {
  assert.equal(samePayload({ a: 1, rev: 4 }, { rev: 9, a: 1 }), true);
  assert.equal(samePayload({ a: 1 }, { a: 2 }), false);
});

test("independent sheet calibrations merge by sheet_id", () => {
  const base = { sheets: [{ sheet_id: "a", units_per_px: 1 }, { sheet_id: "b", units_per_px: 1 }] };
  const local = { sheets: [{ sheet_id: "a", units_per_px: 2 }, base.sheets[1]] };
  const remote = { sheets: [base.sheets[0], { sheet_id: "b", units_per_px: 3 }] };
  const m: any = mergeAnnotations(base, local, remote);
  assert.deepEqual(m.merged.sheets, [local.sheets[0], remote.sheets[1]]);
  assert.equal(m.clean, true);
});

test("competing calibrations name the sheet and preserve the losing record", () => {
  const base = { sheets: [{ sheet_id: "a", units_per_px: 1 }] };
  const local = { sheets: [{ sheet_id: "a", units_per_px: 2 }] };
  const remote = { sheets: [{ sheet_id: "a", units_per_px: 3 }] };
  const m: any = mergeAnnotations(base, local, remote);
  assert.equal(m.clean, false); assert.deepEqual(m.review_sheets, ["a"]);
  assert.deepEqual(m.merged.sheets[0].merge_loser, local.sheets[0]);
});

test("concurrent geometry and scale on one sheet stay together; other sheets still merge", () => {
  const floor = { id: "s", sheet_id: "a", measure_role: "floor_area", computed: { area_sf: 100 } };
  const base = { sheets: [{ sheet_id: "a", units_per_px: 1 }], shapes: [floor] };
  const local = { sheets: [{ sheet_id: "a", units_per_px: 2 }], shapes: [{ ...floor, computed: { area_sf: 400 } }, { ...floor, id: "b", sheet_id: "b" }] };
  const remote = { ...base, shapes: [floor, { ...floor, id: "new" }] };
  const m: any = mergeAnnotations(base, local, remote);
  assert.equal(m.clean, false, "sync must snapshot local before adopting");
  assert.equal(m.merged.sheets[0].units_per_px, 1);
  assert.deepEqual(m.merged.shapes.filter((s: any) => s.sheet_id === "a"), remote.shapes);
  assert.equal(m.merged.shapes.find((s: any) => s.id === "b").sheet_id, "b");
  assert.deepEqual(m.review_sheets, ["a"]);
});
