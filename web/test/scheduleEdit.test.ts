// Inline finish-tag editing in the Import-from-schedule dialog. Invariants:
//   - normalizeTag trims, collapses interior whitespace, and upper-cases so an
//     edited tag dedups the way the parser's own codes do (case/space blind);
//   - evaluateTags walks rows in order and returns a status per STABLE key, not
//     per tag (the dialog keys checkbox state on the key so an edit can't drop it);
//   - a tag that already exists as a condition comes back "in-use"; a tag that
//     collides with an EARLIER edited row comes back "duplicate" (first-seen wins,
//     mirroring the parent create loop) so create can never make a duplicate;
//   - an empty/whitespace edit comes back "empty" (the row is disabled, not created);
//   - setPicked (Select All / Deselect All / a group's checkbox) turns rows on or
//     off as a set, never picks a row canPick refuses (in use / duplicate /
//     empty), and leaves rows outside the given keys as they were;
//   - closeOnEscape (the dialog's document keydown listener) closes on Escape and
//     stops the event reaching the canvas's own Escape, but ignores an Escape a
//     tag edit already consumed (preventDefault) — that one only cancels the edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTag, evaluateTags, isCreatable, setPicked, previewColors, closeOnEscape } from "../src/lib/scheduleEdit.js";

test("normalizeTag trims, collapses whitespace, upper-cases", () => {
  assert.equal(normalizeTag("  cpt-1 "), "CPT-1");
  assert.equal(normalizeTag("res   w"), "RES W");
  assert.equal(normalizeTag(""), "");
  assert.equal(normalizeTag("   "), "");
  // OCR fix survives normalization (identity is the corrected value)
  assert.equal(normalizeTag("crt-1"), "CRT-1");
});

test("evaluateTags: a unique tag is creatable", () => {
  const s = evaluateTags([{ key: "a", tag: "CPT-1" }], new Set());
  assert.equal(s.get("a")?.status, "ok");
  assert.equal(s.get("a")?.tag, "CPT-1");
  assert.ok(isCreatable(s.get("a")));
});

test("evaluateTags: normalized tag already in `existing` is in-use", () => {
  // existing set holds normalized condition tags; a lowercase edit still matches
  const s = evaluateTags([{ key: "a", tag: "cpt-1" }], new Set(["CPT-1"]));
  assert.equal(s.get("a")?.status, "in-use");
  assert.ok(!isCreatable(s.get("a")));
});

test("evaluateTags: second row colliding with an earlier edited tag is duplicate", () => {
  const s = evaluateTags([
    { key: "a", tag: "LVT-1" },
    { key: "b", tag: "lvt-1" }, // edited to collide with a
  ], new Set());
  assert.equal(s.get("a")?.status, "ok"); // first-seen wins
  assert.equal(s.get("b")?.status, "duplicate");
});

test("evaluateTags: empty / whitespace edit is empty (disabled)", () => {
  const s = evaluateTags([{ key: "a", tag: "   " }], new Set());
  assert.equal(s.get("a")?.status, "empty");
  assert.equal(s.get("a")?.tag, "");
  assert.ok(!isCreatable(s.get("a")));
});

test("evaluateTags: status is keyed by stable key, not by tag", () => {
  // two rows edited to the SAME tag keep distinct entries by their keys
  const s = evaluateTags([
    { key: "r0", tag: "CT-1" },
    { key: "r1", tag: "CT-1" },
  ], new Set());
  assert.equal(s.size, 2);
  assert.equal(s.get("r0")?.status, "ok");
  assert.equal(s.get("r1")?.status, "duplicate");
});

test("evaluateTags: editing away from a duplicate frees both rows", () => {
  // fixing r1's mis-read tag makes both creatable — the whole point of the edit
  const before = evaluateTags([
    { key: "r0", tag: "CPT-1" },
    { key: "r1", tag: "CPT-1" },
  ], new Set());
  assert.equal(before.get("r1")?.status, "duplicate");
  const after = evaluateTags([
    { key: "r0", tag: "CPT-1" },
    { key: "r1", tag: "CPT-2" },
  ], new Set());
  assert.equal(after.get("r0")?.status, "ok");
  assert.equal(after.get("r1")?.status, "ok");
});

test("setPicked on: picks every creatable row and never an in-use / duplicate / empty one", () => {
  const st = evaluateTags([
    { key: "r0", tag: "CPT-1" },
    { key: "r1", tag: "CPT-1" }, // duplicate
    { key: "r2", tag: "VCT-1" }, // in use
    { key: "r3", tag: " " },     // empty
    { key: "r4", tag: "RB-1" },
  ], new Set(["VCT-1"]));
  const canPick = (k: string) => isCreatable(st.get(k));
  const all = setPicked(new Set(), ["r0", "r1", "r2", "r3", "r4"], canPick, true);
  assert.deepEqual([...all].sort(), ["r0", "r4"]);
});

test("setPicked off: clears the given rows; rows outside the keys are left alone", () => {
  const canPick = () => true;
  const before = new Set(["r0", "r1", "r5"]);
  const after = setPicked(before, ["r0", "r1", "r2"], canPick, false);
  assert.deepEqual([...after], ["r5"]);
  assert.deepEqual([...before].sort(), ["r0", "r1", "r5"]); // input not mutated
  // on over a subset (a group) keeps what is already picked elsewhere
  assert.deepEqual([...setPicked(new Set(["r9"]), ["r0"], canPick, true)].sort(), ["r0", "r9"]);
});

test("setPicked off drops a stale pick even when the row is no longer creatable", () => {
  // a row picked, then edited into a duplicate: Deselect All must still clear it
  const after = setPicked(new Set(["r1"]), ["r0", "r1"], () => false, false);
  assert.equal(after.size, 0);
});

// The dialog's swatch preview must be the colour each condition actually gets:
// the parent (TakeoffCanvas.createFromSchedule → rowToSeed) assigns
// palette[(startIndex + n) % len] over the rows it CREATES — picked and
// creatable, in row order. Unpicked rows get no colour (the neutral swatch).
test("previewColors: numbers only the picked rows, in row order, from startIndex", () => {
  const pal = ["#a", "#b", "#c"];
  const picked = new Set(["r1", "r3", "r4"]);
  const m = previewColors(["r0", "r1", "r2", "r3", "r4"], (k) => picked.has(k), pal, 2);
  assert.deepEqual([...m.entries()], [["r1", "#c"], ["r3", "#a"], ["r4", "#b"]]);
  assert.equal(m.has("r0"), false);
  assert.equal(m.has("r2"), false);
});

test("previewColors: nothing picked → no colours; empty palette → no colours", () => {
  assert.equal(previewColors(["r0", "r1"], () => false, ["#a"], 0).size, 0);
  assert.equal(previewColors(["r0", "r1"], () => true, [], 0).size, 0);
});

// A keydown the way the dialog's document listener receives it. Escape during a
// tag edit reaches the listener already preventDefault-ed by the input's
// onEditKey (React's handler runs before the document listener).
const keydown = (key: string, { editConsumed = false } = {}) => {
  const e = Object.assign(new Event("keydown", { cancelable: true, bubbles: true }), { key });
  if (editConsumed) e.preventDefault();
  let stopped = 0;
  const stop = e.stopPropagation.bind(e);
  e.stopPropagation = () => { stopped++; stop(); };
  return { e, stopped: () => stopped };
};

test("closeOnEscape: Escape closes the dialog and stops propagation", () => {
  let closed = 0;
  const k = keydown("Escape");
  closeOnEscape(k.e, () => { closed++; });
  assert.equal(closed, 1, "onClose called once");
  assert.equal(k.stopped(), 1, "propagation stopped so the canvas's Escape doesn't also fire");
});

test("closeOnEscape: an Escape a tag edit consumed does not close the dialog", () => {
  let closed = 0;
  const k = keydown("Escape", { editConsumed: true });
  closeOnEscape(k.e, () => { closed++; });
  assert.equal(closed, 0, "the edit's Escape only cancels the edit");
  assert.equal(k.stopped(), 0);
});

test("closeOnEscape: other keys are ignored; a missing onClose is safe", () => {
  let closed = 0;
  for (const key of ["Enter", "a", "Tab"]) {
    const k = keydown(key);
    closeOnEscape(k.e, () => { closed++; });
    assert.equal(k.stopped(), 0, key);
  }
  assert.equal(closed, 0);
  assert.doesNotThrow(() => closeOnEscape(keydown("Escape").e, undefined));
});
