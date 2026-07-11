// Sheet levels: the hydrate() sanitizer + gallery grouping/sort pure helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSheetLevels, naturalCompare, groupSheetsByLevel, sortGalleryGroups } from "../src/lib/sheetLevels.js";

type Group = { level: string | null; keys: string[] };

test("sanitizeSheetLevels: object-shape gate", () => {
  assert.deepEqual(sanitizeSheetLevels(undefined), {});
  assert.deepEqual(sanitizeSheetLevels(null), {});
  assert.deepEqual(sanitizeSheetLevels("L1"), {});           // a bare string, not a map
  assert.deepEqual(sanitizeSheetLevels(["L1", "L2"]), {});   // an array must not pass Object.entries as if keyed
  assert.deepEqual(sanitizeSheetLevels(42), {});
});

test("sanitizeSheetLevels: string/non-empty value filter", () => {
  const raw = {
    "a.pdf": "L1",
    "b.pdf": "",            // empty string clears — must be dropped, not kept as a level
    "c.pdf": null,
    "d.pdf": 3,              // non-string — corrupted record
    "e.pdf": { level: "L1" }, // object where a string is expected
    "f.pdf": "L2",
    "g.pdf": "   ",          // whitespace-only — must be dropped like an empty string (Copilot review)
  };
  assert.deepEqual(sanitizeSheetLevels(raw), { "a.pdf": "L1", "f.pdf": "L2" });
});

test("sanitizeSheetLevels: mixed/old payloads and clear-all reversibility", () => {
  // an old payload with no sheet_levels key at all must sanitize to {} (the
  // else-clear rule: a snapshot load without levels must not inherit the
  // replaced project's levels)
  assert.deepEqual(sanitizeSheetLevels(undefined), {});
  // clearing every level (assigning "" to every key) must reversibly land
  // back at {} on the next hydrate — same as never having levels
  const cleared = { "a.pdf": "", "b.pdf": "" };
  assert.deepEqual(sanitizeSheetLevels(cleared), {});
});

test("naturalCompare: numeric-aware, L2 < L10", () => {
  const sorted = ["L10", "L2", "L1"].sort(naturalCompare);
  assert.deepEqual(sorted, ["L1", "L2", "L10"]);
});

test("groupSheetsByLevel: no levels anywhere → single ungrouped group", () => {
  const allKeys = ["a.pdf", "b.pdf"];
  const groups = groupSheetsByLevel(allKeys, {});
  assert.deepEqual(groups, [{ level: null, keys: allKeys }]);
});

test("groupSheetsByLevel: natural sort, unassigned last, empty groups dropped", () => {
  const allKeys = ["a.pdf", "b.pdf", "c.pdf", "d.pdf", "e.pdf"];
  const levels = { "a.pdf": "L10", "b.pdf": "L2", "c.pdf": "L2", "orphan.pdf": "L99" }; // orphan key not in allKeys
  const groups = groupSheetsByLevel(allKeys, levels) as Group[];
  assert.deepEqual(groups.map((g) => g.level), ["L2", "L10", ""]); // natural order, unassigned last
  assert.deepEqual(groups.find((g) => g.level === "L2")!.keys, ["b.pdf", "c.pdf"]);
  assert.deepEqual(groups.find((g) => g.level === "L10")!.keys, ["a.pdf"]);
  assert.deepEqual(groups.find((g) => g.level === "")!.keys, ["d.pdf", "e.pdf"]);
  // the orphan level ("L99") never surfaces as its own group — it has no
  // matching key in allKeys
  assert.ok(!groups.some((g) => g.level === "L99"));
});

test("groupSheetsByLevel: every sheet assigned still yields no Unassigned group", () => {
  const allKeys = ["a.pdf", "b.pdf"];
  const levels = { "a.pdf": "L1", "b.pdf": "L1" };
  const groups = groupSheetsByLevel(allKeys, levels);
  assert.deepEqual(groups.map((g) => g.level), ["L1"]); // empty Unassigned group dropped
});

test("groupSheetsByLevel: clear-all reversibility restores the pre-level shape", () => {
  const allKeys = ["a.pdf", "b.pdf"];
  const before = groupSheetsByLevel(allKeys, {});
  const afterClear = groupSheetsByLevel(allKeys, { "a.pdf": "", "b.pdf": "" }); // sanitizeSheetLevels would have already dropped these, but groupSheetsByLevel itself treats falsy the same way
  assert.deepEqual(before, afterClear);
});

test("sortGalleryGroups: sorts a group with a level, leaves Unassigned in file/page order", () => {
  const labelOf = (k: string) => ({ z1: "A-10", z2: "A-2", u1: "Z-99", u2: "A-1" } as Record<string, string>)[k] || k;
  const groups = [
    { level: "L1", keys: ["z1", "z2"] },       // out of label order (A-10 before A-2)
    { level: "", keys: ["u1", "u2"] },          // Unassigned — file/page order is u1, u2 (label order would be reversed)
  ];
  const sorted = sortGalleryGroups(groups, labelOf) as Group[];
  assert.deepEqual(sorted.find((g) => g.level === "L1")!.keys, ["z2", "z1"]); // A-2 before A-10, natural sort
  // Unassigned must NOT be reordered by title-block label — this is the
  // fix for finding 10: the sort gate is per-group (g.level truthy), not
  // "do any levels exist in the whole gallery"
  assert.deepEqual(sorted.find((g) => g.level === "")!.keys, ["u1", "u2"]);
});

test("sortGalleryGroups: the no-levels-yet group (level: null) is never sorted", () => {
  const labelOf = (k: string) => ({ b: "A-2", a: "A-1" } as Record<string, string>)[k] || k;
  const groups = [{ level: null, keys: ["b", "a"] }];
  assert.deepEqual(sortGalleryGroups(groups, labelOf), groups);
});
