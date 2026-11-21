import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSheetText, looksLikeDimension } from "../src/lib/textDiff.ts";

test("diffSheetText: same string at the same spot is unchanged, under the alignment offset", () => {
  const base = [{ str: "OFFICE", x: 100, y: 100 }, { str: "101", x: 100, y: 120 }];
  const revised = [{ str: "OFFICE", x: 90, y: 95 }, { str: "101", x: 90, y: 115 }];
  const d = diffSheetText(base, revised, { dx: 10, dy: 5 });
  assert.equal(d.unchanged, 2);
  assert.deepEqual(d.changes, []);
});

test("diffSheetText: a retyped tag is ONE change with before and after, not a remove and an add", () => {
  const d = diffSheetText(
    [{ str: "CPT-1", x: 400, y: 300 }, { str: "LOBBY", x: 400, y: 280 }],
    [{ str: "LVT-2", x: 402, y: 301 }, { str: "LOBBY", x: 400, y: 280 }],
  );
  assert.equal(d.unchanged, 1);
  assert.deepEqual(d.changes, [{ type: "changed", before: "CPT-1", after: "LVT-2", at: [400, 300] }]);
});

test("diffSheetText: far-apart leftovers stay a removal and an addition, in reading order", () => {
  const d = diffSheetText([{ str: "DRAFT", x: 900, y: 50 }], [{ str: "ADDENDUM #2", x: 100, y: 700 }]);
  assert.deepEqual(d.changes.map((c) => [c.type, c.before ?? c.after]), [["removed", "DRAFT"], ["added", "ADDENDUM #2"]]);
});

test("diffSheetText: one printed line split into different text runs is not a change", () => {
  // The same line as one run on one issue and two runs on the other, both ways round.
  const one = [{ str: "03- 32 SF", x: 200, y: 400 }, { str: "TYPE IIB", x: 600, y: 400 }, { str: "- UNSPRINKLED", x: 660, y: 400 }];
  const two = [{ str: "03-", x: 200, y: 400 }, { str: "32 SF", x: 230, y: 400 }, { str: "TYPE IIB - UNSPRINKLED", x: 600, y: 400 }];
  assert.deepEqual(diffSheetText(one, two).changes, []);
  assert.deepEqual(diffSheetText(two, one).changes, []);
  // ...but a split line whose words changed still reports.
  const edited = [{ str: "03-", x: 200, y: 400 }, { str: "48 SF", x: 230, y: 400 }];
  assert.ok(diffSheetText([{ str: "03- 32 SF", x: 200, y: 400 }], edited).changes.length > 0);
});

test("looksLikeDimension reads feet, inches and metric, and ignores tags", () => {
  for (const s of [`12'-6"`, `4"`, `3/8" = 1'-0"`, "1500 mm"]) assert.equal(looksLikeDimension(s), true, s);
  for (const s of ["CPT-1", "OFFICE 101", "A-100"]) assert.equal(looksLikeDimension(s), false, s);
});
