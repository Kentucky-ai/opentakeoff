// Inline finish-tag editing in the Import-from-schedule dialog. Invariants:
//   - normalizeTag trims, collapses interior whitespace, and upper-cases so an
//     edited tag dedups the way the parser's own codes do (case/space blind);
//   - evaluateTags walks rows in order and returns a status per STABLE key, not
//     per tag (the dialog keys checkbox state on the key so an edit can't drop it);
//   - a tag that already exists as a condition comes back "in-use"; a tag that
//     collides with an EARLIER edited row comes back "duplicate" (first-seen wins,
//     mirroring the parent create loop) so create can never make a duplicate;
//   - an empty/whitespace edit comes back "empty" (the row is disabled, not created).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTag, evaluateTags, isCreatable } from "../src/lib/scheduleEdit.js";

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
