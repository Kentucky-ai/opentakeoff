// hydrate's sheet-group normalization (lib/sheetGroups.ts). The load-bearing case
// is the SAME-INSTANCE invariant in group mode: it's what makes the lastGroup-sync
// effect a reference-equal no-op, so a hydrate can't spawn a follow-up commit that
// escapes the one-shot autosave suppression and spuriously re-saves (rev churn +
// flipped seed `touched` on the local-first sync path). This pins that invariant so
// a future refactor can't quietly reintroduce distinct instances.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLoadedGroups } from "../src/lib/sheetGroups.js";

const MAX = 4;

test("group mode: sheetGroup and lastGroup are the SAME array instance (so setLastGroup(sheetGroup) bails)", () => {
  const r = normalizeLoadedGroups({ sheet_group: ["A", "B"], last_group: ["A", "B"] }, MAX);
  assert.deepEqual(r.sheetGroup, ["A", "B"]);
  assert.equal(r.lastGroup, r.sheetGroup); // reference equality — the whole point
});

test("group mode: a differing saved last_group is collapsed to the current group (matches effect 824's own behavior)", () => {
  // While grouped, the canvas keeps lastGroup === sheetGroup, so a payload with a
  // divergent last_group would have been overwritten by the sync effect anyway;
  // doing it here (same instance) just avoids the extra commit.
  const r = normalizeLoadedGroups({ sheet_group: ["A", "B"], last_group: ["C", "D"] }, MAX);
  assert.equal(r.lastGroup, r.sheetGroup);
  assert.deepEqual(r.lastGroup, ["A", "B"]);
});

test("single-sheet load: keeps the DISTINCT remembered group for Regroup", () => {
  const r = normalizeLoadedGroups({ sheet_group: [], last_group: ["A", "B"] }, MAX);
  assert.deepEqual(r.sheetGroup, []);
  assert.deepEqual(r.lastGroup, ["A", "B"]);
  assert.notEqual(r.lastGroup, r.sheetGroup); // distinct — sheetGroup<2 so no sync-effect churn anyway
});

test("no groups: both empty", () => {
  const r = normalizeLoadedGroups({}, MAX);
  assert.deepEqual(r.sheetGroup, []);
  assert.deepEqual(r.lastGroup, []);
});

test("a remembered group of one collapses to empty (needs >= 2 to be a real group)", () => {
  const r = normalizeLoadedGroups({ sheet_group: [], last_group: ["A"] }, MAX);
  assert.deepEqual(r.lastGroup, []);
});

test("both slices are capped at maxGroup", () => {
  const r = normalizeLoadedGroups({ sheet_group: ["A", "B", "C", "D", "E", "F"] }, MAX);
  assert.deepEqual(r.sheetGroup, ["A", "B", "C", "D"]);
  assert.equal(r.lastGroup, r.sheetGroup);
});

test("malformed (non-array) group fields degrade to empty, not a throw", () => {
  const r = normalizeLoadedGroups({ sheet_group: "nope" as any, last_group: 42 as any }, MAX);
  assert.deepEqual(r.sheetGroup, []);
  assert.deepEqual(r.lastGroup, []);
});

// ── #161: soloOk — a stitch key alone is a legitimate group of one ──────────

test("soloOk: a solo stitch group keeps the SAME-INSTANCE invariant", () => {
  const r = normalizeLoadedGroups({ sheet_group: ["stitch:x"], last_group: ["stitch:x"] }, MAX, (k) => k.startsWith("stitch:"));
  assert.deepEqual(r.sheetGroup, ["stitch:x"]);
  assert.equal(r.lastGroup, r.sheetGroup); // ref-shared, exactly like a >=2 group
});

test("soloOk: a solo NON-stitch group still collapses lastGroup (no behavior change)", () => {
  const r = normalizeLoadedGroups({ sheet_group: ["plan.pdf"], last_group: [] }, MAX, (k) => k.startsWith("stitch:"));
  assert.deepEqual(r.sheetGroup, ["plan.pdf"]);
  assert.deepEqual(r.lastGroup, []);
});

test("soloOk omitted: byte-identical to the old behavior", () => {
  const r = normalizeLoadedGroups({ sheet_group: ["stitch:x"], last_group: [] }, MAX);
  assert.deepEqual(r.sheetGroup, ["stitch:x"]);
  assert.deepEqual(r.lastGroup, []);
});
