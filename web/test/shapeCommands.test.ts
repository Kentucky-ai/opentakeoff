// Shape-command layer (lib/shapeCommands.js) — the ONE chokepoint for shape
// provenance policy. The invariants:
//   - applyShapeCommand is pure (inputs never mutated) and every command's
//     apply → inverse round-trips to the EXACT input (deep-equal, provenance
//     fields, key presence, and array order included);
//   - the policy table: add stamps created_at once (restore never re-stamps),
//     geom stamps via stampEdit exactly once with the freeze read from the
//     TRUE pre-gesture verts, vertexDelete stamps "vertex", label and replace
//     stamp nothing, delete tallies per origin.method (noCount suppresses);
//   - undo of a first geom edit leaves NO phantom `edited` flag behind;
//   - recordCommand caps the undo stack and clears redo on a new command;
//   - an unknown command type throws (the PROVENANCE_POLICY completeness
//     contract — adding a command without deciding its policy row must fail).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyShapeCommand, geomSnapshot, vertsEqual, recordCommand,
  PROVENANCE_POLICY, UNDO_CAP,
} from "../src/lib/shapeCommands.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// A committed manual shape, as the canvas mints it. (Factories return `any` —
// the shapes deliberately grow/lose keys like updated_at/origin.edited across
// command applications, which a concrete inferred literal type would reject.)
const manualShape = (id = "shp-m1"): any => ({
  id, created_at: "2026-01-01T00:00:00.000Z", sheet_id: "a.pdf#1", condition_id: "cnd-1",
  measure_role: "floor_area",
  verts_norm: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.4]],
  computed: { area_sf: 100, perimeter_lf: 40 },
  origin: { method: "manual" },
});

// A committed one-click shape (machine origin, never edited).
const machineShape = (id = "shp-x1"): any => ({
  id, created_at: "2026-01-01T00:00:00.000Z", sheet_id: "a.pdf#1", condition_id: "cnd-1",
  measure_role: "floor_area",
  verts_norm: [[0.2, 0.2], [0.6, 0.2], [0.6, 0.5]],
  computed: { area_sf: 200, perimeter_lf: 60 },
  origin: { method: "one_click_v1", seed_norm: [0.4, 0.3], reviewed: true },
});

const clone = (v: unknown) => structuredClone(v);

// Apply cmd, then its inverse, and require the round trip to be IDENTITY —
// deep-equal including provenance fields, key presence, and array order.
// Also guards purity: the input array/objects must be byte-identical after.
function roundTrip(shapes: any[], cmd: any) {
  const before = clone(shapes);
  const fwd = applyShapeCommand(shapes, cmd);
  assert.deepEqual(shapes, before, "apply must not mutate its input");
  const back = applyShapeCommand(fwd.shapes, fwd.inverse);
  assert.deepEqual(back.shapes, before, "inverse must restore the input exactly");
  return fwd;
}

// ── policy completeness ──────────────────────────────────────────────────────

test("every applied command type has a PROVENANCE_POLICY row; unknown types throw", () => {
  for (const t of ["add", "geom", "reassign", "label", "delete", "replace"]) {
    assert.ok(t in PROVENANCE_POLICY, `policy row missing for ${t}`);
  }
  assert.throws(() => applyShapeCommand([], { type: "resize" } as any), /PROVENANCE_POLICY/);
  assert.throws(() => applyShapeCommand([], null as any), /PROVENANCE_POLICY/);
});

// ── add ──────────────────────────────────────────────────────────────────────

test("add: stamps created_at once and mints a shp- id, caller fields verbatim", () => {
  const draft = {
    sheet_id: "a.pdf#1", condition_id: "cnd-1", measure_role: "floor_area",
    verts_norm: [[0, 0], [1, 0], [1, 1]], computed: { area_sf: 5, perimeter_lf: 9 },
    origin: { method: "manual" },
  };
  const res = applyShapeCommand([manualShape()], { type: "add", shapes: [clone(draft)] });
  assert.equal(res.shapes.length, 2);
  const made = res.shapes[1];
  assert.match(made.id, /^shp-/);
  assert.match(made.created_at, ISO);
  const { id: _i, created_at: _c, ...rest } = made;
  assert.deepEqual(rest, draft);   // nothing else invented, nothing dropped
  assert.equal(res.counted, undefined);   // creation never tallies a deletion
  // inverse deletes the minted shape WITHOUT counting it
  assert.deepEqual(res.inverse, { type: "delete", ids: [made.id], noCount: true });
});

test("add: round-trip via the noCount inverse delete is identity", () => {
  const shapes = [manualShape()];
  const fwd = roundTrip(shapes, {
    type: "add",
    shapes: [{ sheet_id: "a.pdf#1", condition_id: "cnd-1", measure_role: "count", verts_norm: [[0.5, 0.5]], computed: { count: 1 }, origin: { method: "manual" } }],
  });
  // and the inverse must not produce a tally when applied
  const undone = applyShapeCommand(fwd.shapes, fwd.inverse);
  assert.equal(undone.counted, undefined, "undoing an add must not tally a deletion");
});

test("add: restore:true re-inserts VERBATIM (no created_at re-stamp, no id re-mint) at the recorded indices", () => {
  const a = manualShape("shp-a"), b = machineShape("shp-b"), c = manualShape("shp-c");
  const res = applyShapeCommand([a, c], { type: "add", shapes: [clone(b)], restore: true, at: [1] });
  assert.deepEqual(res.shapes, [a, b, c]);          // spliced back into the middle — z-order restored
  assert.equal(res.shapes[1].created_at, b.created_at);   // resurrection is not creation
  assert.equal(res.shapes[1].id, b.id);
});

// ── geom ─────────────────────────────────────────────────────────────────────

test("geom: stamps once via stampEdit and freezes proposed_verts_norm from the TRUE pre-drag verts (prev), not the previewed array state", () => {
  const m = machineShape();
  const preVerts = clone(m.verts_norm);
  const finalVerts = [[0.25, 0.2], [0.6, 0.2], [0.6, 0.5]];
  // simulate the live preview having ALREADY written the final geometry
  const previewed = [{ ...m, verts_norm: clone(finalVerts), computed: { area_sf: 190, perimeter_lf: 58 } }];
  const res = applyShapeCommand(previewed, {
    type: "geom", id: m.id, editKind: "vertex",
    verts_norm: clone(finalVerts), computed: { area_sf: 190, perimeter_lf: 58 },
    prev: geomSnapshot(m),
  });
  const out = res.shapes[0];
  assert.deepEqual(out.verts_norm, finalVerts);
  assert.deepEqual(out.computed, { area_sf: 190, perimeter_lf: 58 });
  assert.equal(out.origin.edited, true);
  assert.deepEqual(out.origin.edits, { vertex: 1 });         // exactly ONE stamp per gesture
  assert.deepEqual(out.origin.proposed_verts_norm, preVerts); // frozen from prev, not the preview
  assert.match(out.updated_at, ISO);
});

test("geom: undo removes the edited flag/edits/freeze it added and the updated_at key itself — no phantom edit left behind", () => {
  const m = machineShape();
  assert.ok(!("updated_at" in m) && !m.origin.edited);
  const res = applyShapeCommand([m], {
    type: "geom", id: m.id, editKind: "move",
    verts_norm: m.verts_norm.map(([x, y]: number[]) => [x + 0.1, y + 0.1]),
    prev: geomSnapshot(m),
  });
  assert.equal(res.shapes[0].origin.edited, true);
  const undone = applyShapeCommand(res.shapes, res.inverse).shapes[0];
  assert.deepEqual(undone, m);                       // byte-exact: no edited, no edits, no freeze
  assert.ok(!("updated_at" in undone), "undo must remove the updated_at key, not blank it");
});

test("geom: round-trip identity for manual and machine shapes, first and second edits", () => {
  const m1 = manualShape(), x1 = machineShape();
  const shapes = [m1, x1];
  const cmd = (id: string) => ({
    type: "geom", id, editKind: "vertex",
    verts_norm: [[0.11, 0.1], [0.5, 0.1], [0.5, 0.4]],
    computed: { area_sf: 101, perimeter_lf: 41 },
    prev: geomSnapshot(shapes.find((s) => s.id === id)!),
  });
  roundTrip(shapes, cmd(m1.id));
  const after = applyShapeCommand(shapes, cmd(x1.id));   // first machine edit…
  const second = {
    type: "geom", id: x1.id, editKind: "edge",
    verts_norm: [[0.3, 0.2], [0.6, 0.2], [0.6, 0.5]],
    computed: { area_sf: 195, perimeter_lf: 59 },
    prev: geomSnapshot(after.shapes[1]),
  };
  roundTrip(after.shapes, second);                       // …then a second-edit round trip
});

test("geom: move omits computed (translation never re-prices) and still round-trips", () => {
  const m = manualShape();
  const res = roundTrip([m], {
    type: "geom", id: m.id, editKind: "move",
    verts_norm: m.verts_norm.map(([x, y]: number[]) => [x + 0.05, y]),
    prev: geomSnapshot(m),
  });
  assert.deepEqual(res.shapes[0].computed, m.computed);   // untouched by the move
});

test("geom: vertexDelete stamps \"vertex\"", () => {
  const x = { ...machineShape(), verts_norm: [[0.2, 0.2], [0.6, 0.2], [0.6, 0.5], [0.2, 0.5]] };
  const res = applyShapeCommand([x], {
    type: "geom", id: x.id, editKind: "vertexDelete",
    verts_norm: x.verts_norm.filter((_: number[], i: number) => i !== 3),
    computed: { area_sf: 150, perimeter_lf: 50 },
    prev: geomSnapshot(x),
  });
  assert.deepEqual(res.shapes[0].origin.edits, { vertex: 1 });
  assert.equal(res.shapes[0].verts_norm.length, 3);
});

test("geomSnapshot: presence-aware and deep-copies the ring", () => {
  const m = machineShape();
  const snap = geomSnapshot(m);
  assert.ok(!("updated_at" in snap), "never-edited shape → no updated_at key in the snapshot");
  m.verts_norm[0][0] = 0.99;   // mutating the live ring must not reach the snapshot
  assert.equal(snap.verts_norm[0][0], 0.2);
});

// ── reassign ─────────────────────────────────────────────────────────────────

test("reassign: manual gets bare updated_at, machine gets the full stamp; inverse restores condition_id AND provenance exactly", () => {
  const m = manualShape(), x = machineShape();
  const shapes = [m, x];
  const fwd = roundTrip(shapes, { type: "reassign", ids: [m.id, x.id], condition_id: "cnd-2" });
  const [om, ox] = fwd.shapes;
  assert.equal(om.condition_id, "cnd-2");
  assert.match(om.updated_at, ISO);
  assert.equal(om.origin.edited, undefined);              // manual: updated_at and nothing else
  assert.equal(ox.condition_id, "cnd-2");
  assert.deepEqual(ox.origin.edits, { reassign: 1 });     // machine: the full stamp
  assert.deepEqual(ox.origin.proposed_verts_norm, x.verts_norm);
});

// ── label ────────────────────────────────────────────────────────────────────

test("label: assigns/clears with assignShapeLabel semantics and NO provenance stamp; round-trips both directions", () => {
  const bare = manualShape("shp-l1");                       // no label key
  const tagged = { ...manualShape("shp-l2"), label: "Phase 1" };
  const shapes = [bare, tagged];
  // set on an unlabeled shape
  const set = roundTrip(shapes, { type: "label", ids: [bare.id], value: "Phase 2" });
  assert.equal(set.shapes[0].label, "Phase 2");
  assert.ok(!("updated_at" in set.shapes[0]), "labeling is a documented non-edit — nothing stamps");
  assert.deepEqual(set.shapes[0].origin, { method: "manual" });
  // clear an existing label (empty value removes the key, never leaves \"\")
  const cleared = roundTrip(shapes, { type: "label", ids: [tagged.id], value: "" });
  assert.ok(!("label" in cleared.shapes[1]));
});

// ── delete ───────────────────────────────────────────────────────────────────

test("delete: counts by origin method, inverse restores shapes verbatim at their indices", () => {
  const a = manualShape("shp-a"), b = machineShape("shp-b"), c = manualShape("shp-c"), d = machineShape("shp-d");
  const shapes = [a, b, c, d];
  const fwd = roundTrip(shapes, { type: "delete", ids: [b.id, c.id, d.id], reason: "test" });
  assert.deepEqual(fwd.shapes, [a]);
  assert.deepEqual(fwd.counted, { one_click_v1: 2, manual: 1 });   // per-origin-method tally
  assert.deepEqual(fwd.inverse.at, [1, 2, 3]);                     // ascending original indices
  assert.equal(fwd.inverse.restore, true);
});

test("delete: origin-less shapes count as manual; noCount suppresses the tally; missing ids are a safe no-op", () => {
  const bare = { id: "shp-bare", created_at: "2026-01-01T00:00:00.000Z", sheet_id: "a.pdf#1", condition_id: "cnd-1", measure_role: "count", verts_norm: [[0.5, 0.5]], computed: { count: 1 } };
  const res = applyShapeCommand([bare], { type: "delete", ids: [bare.id] });
  assert.deepEqual(res.counted, { manual: 1 });
  const quiet = applyShapeCommand([bare], { type: "delete", ids: [bare.id], noCount: true });
  assert.equal(quiet.counted, undefined);
  const miss = applyShapeCommand([bare], { type: "delete", ids: ["shp-ghost"] });
  assert.deepEqual(miss.shapes, [bare]);
  assert.equal(miss.counted, undefined);   // nothing died, nothing tallies
});

test("delete → undo → redo-of-undo tallies exactly once (the redo command is the undo's inverse and rides noCount)", () => {
  const a = manualShape("shp-a"), b = machineShape("shp-b");
  const del = applyShapeCommand([a, b], { type: "delete", ids: [b.id] });
  assert.deepEqual(del.counted, { one_click_v1: 1 });     // tallied at first dispatch…
  const undo = applyShapeCommand(del.shapes, del.inverse);
  assert.equal(undo.counted, undefined);                  // …not on undo (restore-add)…
  const redo = applyShapeCommand(undo.shapes, undo.inverse);
  assert.equal(redo.counted, undefined);                  // …and not on redo (noCount delete)
  assert.deepEqual(redo.shapes, del.shapes);              // redo lands exactly where the delete did
});

// ── replace ──────────────────────────────────────────────────────────────────

test("replace: no stamps, no counted, no inverse — the whole-array escape hatch", () => {
  const next = [manualShape("shp-r1")];
  const res = applyShapeCommand([machineShape()], { type: "replace", shapes: next });
  assert.equal(res.shapes, next);          // taken as-is (hydrate already sanitized)
  assert.equal(res.inverse, null);         // never lands on the undo stack
  assert.equal(res.counted, undefined);
  assert.deepEqual(applyShapeCommand([], { type: "replace", shapes: "corrupt" as any }).shapes, []);   // defensive: non-array → []
});

// ── undo-stack bookkeeping ───────────────────────────────────────────────────

test("recordCommand: caps the undo stack at UNDO_CAP (oldest falls off) and clears redo on every new command", () => {
  let undo: any[] = [];
  for (let i = 0; i < UNDO_CAP + 25; i++) {
    ({ undo } = recordCommand(undo, { cmd: { type: "add", n: i }, inverse: null }));
  }
  assert.equal(undo.length, UNDO_CAP);
  assert.equal((undo[0].cmd as any).n, 25);                       // the 25 oldest fell off
  assert.equal((undo[undo.length - 1].cmd as any).n, UNDO_CAP + 24);
  const st = recordCommand(undo, { cmd: { type: "add", n: -1 }, inverse: null });
  assert.deepEqual(st.redo, []);                                  // new command discards the redone future
});

// ── vertsEqual (the structural zero-motion guard) ────────────────────────────

test("vertsEqual: exact structural comparison — the zero-motion / snapped-back guard", () => {
  assert.ok(vertsEqual([[0.1, 0.2], [0.3, 0.4]], [[0.1, 0.2], [0.3, 0.4]]));
  assert.ok(!vertsEqual([[0.1, 0.2]], [[0.1, 0.2], [0.3, 0.4]]));   // vertex count differs (insert/delete)
  assert.ok(!vertsEqual([[0.1, 0.2]], [[0.1, 0.20000001]]));
  assert.ok(!vertsEqual(undefined as any, [[0, 0]]));
});
