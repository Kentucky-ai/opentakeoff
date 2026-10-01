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

// ── #483: group checkbox state, duplicate ranking, the skipped-codes text ─────
// groupState / groupToggle drive each group's mixed-state checkbox: the state
// is taken over the group's PICKABLE rows only (a locked in-use row doesn't hold
// a group at "some"); clicking an "all" group clears every row in it, any other
// state picks every pickable row — NOT USED rows included.
// evaluateTags' optional rank decides which row claims a code several rows
// share: the highest rank, ties to the first row. The dialog ranks a row read
// today (2) above a row only the newer rules read (1), and both above a row the
// schedule marks NOT USED (0). An in-use code is still in use, whatever its rank.
import { groupState, groupToggle, skippedSummary, skippedBanner, skippedNote } from "../src/lib/scheduleEdit.js";

test("groupState: all / some / none over the pickable rows", () => {
  const keys = ["a", "b", "c"];
  const all = () => true;
  assert.equal(groupState(new Set(["a", "b", "c"]), keys, all), "all");
  assert.equal(groupState(new Set(["a"]), keys, all), "some");
  assert.equal(groupState(new Set(), keys, all), "none");
  // nothing pickable → none (the checkbox is disabled)
  assert.equal(groupState(new Set(["a"]), keys, () => false), "none");
  // a locked in-use row, every pickable row picked → all
  assert.equal(groupState(new Set(["a", "b"]), keys, (k) => k !== "c"), "all");
  // a stale pick on a locked row doesn't count
  assert.equal(groupState(new Set(["c"]), keys, (k) => k !== "c"), "none");
});

test("groupToggle: all → none (even with a locked row); some / none → every pickable row", () => {
  const keys = ["a", "b", "c"];
  const canPick = (k: string) => k !== "c";   // c is in use
  // all → clears every key in the group, a stale pick on the locked row too
  assert.deepEqual([...groupToggle(new Set(["a", "b", "c", "z"]), keys, canPick)].sort(), ["z"]);
  // some → all pickable, the locked row stays off, other groups untouched
  assert.deepEqual([...groupToggle(new Set(["a", "z"]), keys, canPick)].sort(), ["a", "b", "z"]);
  // none → all pickable (a NOT USED row is pickable: it's unticked, not locked)
  assert.deepEqual([...groupToggle(new Set(), keys, canPick)].sort(), ["a", "b"]);
  // returns a new set
  const s = new Set<string>();
  assert.notEqual(groupToggle(s, keys, canPick), s);
});

test("Select all (setPicked on every row) picks NOT USED rows", () => {
  // NOT USED rows are creatable — they only start unticked
  const s = setPicked(new Set(), ["real", "notUsed"], () => true, true);
  assert.deepEqual([...s].sort(), ["notUsed", "real"]);
});

test("evaluateTags with rank: the highest-ranked row claims a shared code, ties to the first", () => {
  const NOT_USED = 0, NEW_RULE = 1, TODAY = 2;
  const rk = (m: Record<string, number>) => (key: string) => m[key];
  const st = (m: Map<string, { status: string }>) => Object.fromEntries([...m].map(([k, v]) => [k, v.status]));
  // a NOT USED CPT-2 before a real CPT-2 → the real one is ok
  let r = evaluateTags([{ key: "n", tag: "CPT-2" }, { key: "t", tag: "CPT-2" }], new Set(), rk({ n: NOT_USED, t: TODAY }));
  assert.deepEqual(st(r), { n: "duplicate", t: "ok" });
  // two NOT USED CPT-2 and no real one → the first is ok
  r = evaluateTags([{ key: "n1", tag: "CPT-2" }, { key: "n2", tag: "cpt-2" }], new Set(), rk({ n1: NOT_USED, n2: NOT_USED }));
  assert.deepEqual(st(r), { n1: "ok", n2: "duplicate" });
  // a new-rule CT-1 before a today-read CT-1 → the today-read row is ok
  r = evaluateTags([{ key: "x", tag: "CT-1" }, { key: "t", tag: "CT-1" }], new Set(), rk({ x: NEW_RULE, t: TODAY }));
  assert.deepEqual(st(r), { x: "duplicate", t: "ok" });
  // new-rule before NOT USED → the new-rule row is ok
  r = evaluateTags([{ key: "x", tag: "CT-1" }, { key: "n", tag: "CT-1" }], new Set(), rk({ x: NEW_RULE, n: NOT_USED }));
  assert.deepEqual(st(r), { x: "ok", n: "duplicate" });
  // two new-rule rows sharing a key → the later is duplicate
  r = evaluateTags([{ key: "a", tag: "FTB-01" }, { key: "b", tag: "FTB-01" }], new Set(), rk({ a: NEW_RULE, b: NEW_RULE }));
  assert.deepEqual(st(r), { a: "ok", b: "duplicate" });
  // the map is in row order, tags normalized
  assert.deepEqual([...r.keys()], ["a", "b"]);
  assert.equal(r.get("b")?.tag, "FTB-01");
});

test("evaluateTags with rank: an in-use code stays in use; empty never claims; an edit away frees the code", () => {
  const rank = (key: string) => ({ n: 0, t: 2 } as Record<string, number>)[key];
  // in use wins over rank
  let r = evaluateTags([{ key: "n", tag: "CPT-2" }, { key: "t", tag: "CPT-2" }], new Set(["CPT-2"]), rank);
  assert.equal(r.get("n")?.status, "in-use");
  assert.equal(r.get("t")?.status, "in-use");
  // the real row's tag edited away → the NOT USED row is then ok
  r = evaluateTags([{ key: "n", tag: "CPT-2" }, { key: "t", tag: "CPT-9" }], new Set(), rank);
  assert.equal(r.get("n")?.status, "ok");
  assert.equal(r.get("t")?.status, "ok");
  // edited to blank → empty, and doesn't take the code
  r = evaluateTags([{ key: "n", tag: "CPT-2" }, { key: "t", tag: "  " }], new Set(), rank);
  assert.equal(r.get("n")?.status, "ok");
  assert.equal(r.get("t")?.status, "empty");
});

test("evaluateTags without rank → first-seen, as before", () => {
  const r = evaluateTags([{ key: "n", tag: "CPT-2" }, { key: "t", tag: "CPT-2" }], new Set());
  assert.equal(r.get("n")?.status, "ok");
  assert.equal(r.get("t")?.status, "duplicate");
});

const TAIL = "A four- or five-letter code with no number is read only when the header or a read row is above it, it fills two or more other columns, and a row with a numbered code, like CPT-1, comes after it — ";

test("skippedSummary: distinct codes in first-seen order, repeats counted by line, more than 8 summarized", () => {
  assert.deepEqual(skippedSummary(["EPOX"]), { count: 1, list: "EPOX", lines: 1 });
  assert.deepEqual(skippedSummary(["EPOX", "SEAL"]), { count: 2, list: "EPOX, SEAL", lines: 2 });
  assert.deepEqual(skippedSummary(["EPOX", "EPOX"]), { count: 1, list: "EPOX (2 lines)", lines: 2 });
  assert.deepEqual(skippedSummary(["SEAL", "EPOX", "SEAL"]), { count: 2, list: "SEAL (2 lines), EPOX", lines: 3 });
  const ten = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF", "GGGG", "HHHH", "IIII", "JJJJ"];
  assert.deepEqual(skippedSummary(ten), { count: 10, list: "AAAA, BBBB, CCCC, DDDD, EEEE, FFFF, GGGG, HHHH, and 2 more", lines: 10 });
  assert.deepEqual(skippedSummary([]), { count: 0, list: "", lines: 0 });
});

test("skippedBanner: the dialog's exact text, one and several", () => {
  assert.equal(skippedBanner(["EPOX"]),
    "1 code wasn't read: EPOX. A four- or five-letter code with no number is read only when the header or a read row is above it, it fills two or more other columns, and a row with a numbered code, like CPT-1, comes after it — if it's a finish, add it as a condition yourself.");
  assert.equal(skippedBanner(["EPOX", "SEAL"]),
    "2 codes weren't read: EPOX, SEAL. A four- or five-letter code with no number is read only when the header or a read row is above it, it fills two or more other columns, and a row with a numbered code, like CPT-1, comes after it — if they're finishes, add them as conditions yourself.");
  assert.equal(skippedBanner(["EPOX", "EPOX"]), `1 code wasn't read: EPOX (2 lines). ${TAIL}if it's a finish, add it as a condition yourself.`);
  assert.equal(skippedBanner(["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF", "GGGG", "HHHH", "IIII"]),
    `9 codes weren't read: AAAA, BBBB, CCCC, DDDD, EEEE, FFFF, GGGG, HHHH, and 1 more. ${TAIL}if they're finishes, add them as conditions yourself.`);
});

test("skippedNote: the agent's exact note, one, several, one code on two lines", () => {
  assert.equal(skippedNote(["EPOX"]),
    "No rows read. A four- or five-letter code with no number wasn't read: EPOX. Find its line with read_sheet_text, check it with view_region, then create it with create_condition if it's a finish.");
  assert.equal(skippedNote(["EPOX", "SEAL"]),
    "No rows read. Four- or five-letter codes with no number weren't read: EPOX, SEAL. Find their lines with read_sheet_text, check them with view_region, then create them with create_condition if they're finishes.");
  assert.equal(skippedNote(["EPOX", "EPOX"]),
    "No rows read. A four- or five-letter code with no number wasn't read: EPOX (2 lines). Find its lines with read_sheet_text, check it with view_region, then create it with create_condition if it's a finish.");
});
