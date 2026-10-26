import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeSplitView, normalizeSplitView, clampRatio, MIN_RATIO, MAX_RATIO, wouldExceedSheetCap, canSplit } from "../src/lib/splitView.ts";

test("serialize→normalize round-trips a valid split with an explicit refSet", () => {
  const sv = { orientation: "v" as const, ratio: 0.5, refKey: "A101#2", refSet: ["A101#2", "A102"] };
  assert.deepEqual(normalizeSplitView(serializeSplitView(sv)), sv);
});

test("no split serializes to null (so the persisted key is omitted)", () => {
  assert.equal(serializeSplitView(null), null);
});

test("normalize rejects malformed input", () => {
  assert.equal(normalizeSplitView(undefined), null);
  assert.equal(normalizeSplitView({}), null);
  assert.equal(normalizeSplitView({ orientation: "x", ratio: 0.5, refKey: "A" }), null);
  assert.equal(normalizeSplitView({ orientation: "v", ratio: 0.5 }), null); // missing refKey
});

test("normalize clamps an out-of-range ratio instead of dropping the split", () => {
  const sv = normalizeSplitView({ orientation: "h", ratio: 0.99, refKey: "A" });
  assert.equal(sv?.ratio, MAX_RATIO);
});

test("normalize backfills refSet to [refKey] on a pre-Task-7 saved split (no refSet field)", () => {
  const sv = normalizeSplitView({ orientation: "v", ratio: 0.5, refKey: "A101#2" });
  assert.deepEqual(sv?.refSet, ["A101#2"]);
});

test("serialize backfills refSet to [refKey] when the in-memory split hasn't set one", () => {
  const sv = { orientation: "v" as const, ratio: 0.5, refKey: "A101#2" };
  assert.deepEqual(serializeSplitView(sv), { orientation: "v", ratio: 0.5, refKey: "A101#2", refSet: ["A101#2"] });
});

test("normalize discards a malformed refSet (non-string entries) and falls back to [refKey]", () => {
  const sv = normalizeSplitView({ orientation: "v", ratio: 0.5, refKey: "A101#2", refSet: ["A101#2", 5] });
  assert.deepEqual(sv?.refSet, ["A101#2"]);
});

test("normalize dedupes refSet and always includes refKey as a member", () => {
  const dup = normalizeSplitView({ orientation: "v", ratio: 0.5, refKey: "A", refSet: ["A", "B", "A", "B"] });
  assert.deepEqual(dup?.refSet, ["A", "B"]);
  const missing = normalizeSplitView({ orientation: "v", ratio: 0.5, refKey: "A", refSet: ["B", "C"] });
  assert.deepEqual(missing?.refSet, ["A", "B", "C"]);
});

test("clampRatio holds bounds", () => {
  assert.equal(clampRatio(0.01), MIN_RATIO);
  assert.equal(clampRatio(0.95), MAX_RATIO);
  assert.equal(clampRatio(0.5), 0.5);
});

// Asserted against the literal budget (6), not the brief's own arithmetic
// restated (`4 + 2 > SPLIT_MAX_TOTAL_SHEETS`) — a self-referential assertion
// can't fail if the constant ever moves, which defeats the point of a test.
test("sheet cap trips when primary + reference exceed the budget", () => {
  assert.equal(wouldExceedSheetCap(4, 2), false); // 6, at the budget — allowed
  assert.equal(wouldExceedSheetCap(4, 3), true);  // 7, over — refused
  assert.equal(wouldExceedSheetCap(1, 1), false);
});

test("canSplit disables on narrow viewport or low-memory device, either alone", () => {
  assert.equal(canSplit({ narrow: false, lowMemory: false }), true);
  assert.equal(canSplit({ narrow: true, lowMemory: false }), false);
  assert.equal(canSplit({ narrow: false, lowMemory: true }), false);
  assert.equal(canSplit({ narrow: true, lowMemory: true }), false);
});
