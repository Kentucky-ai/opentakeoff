import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSheetNumber,
  matchSheetSets,
  carryTakeoffShapes,
  type SheetEntry,
  type TakeoffShape,
} from "../src/lib/slipsheet.ts";
import type { ChangedRegion } from "../src/lib/revisionDiff.ts";

test("normalizeSheetNumber trims, uppercases, and strips whitespace", () => {
  assert.equal(normalizeSheetNumber(" a101 "), "A101");
  assert.equal(normalizeSheetNumber("A- 102"), "A-102");
  assert.equal(normalizeSheetNumber(null), "");
});

test("matchSheetSets: 1-to-1 matching, never guessing on unread or ambiguous sheets", () => {
  const base: SheetEntry[] = [
    { key: "p1.pdf#1", file: "p1.pdf", page: 1, sheetNumber: "A101" },
    { key: "p1.pdf#2", file: "p1.pdf", page: 2, sheetNumber: "A102" },
    { key: "p1.pdf#3", file: "p1.pdf", page: 3, sheetNumber: "A103" }, // deleted in rev 2
    { key: "p1.pdf#4", file: "p1.pdf", page: 4, sheetNumber: null },   // unread
  ];

  const incoming: SheetEntry[] = [
    { key: "p2.pdf#1", file: "p2.pdf", page: 1, sheetNumber: "A101" },
    { key: "p2.pdf#2", file: "p2.pdf", page: 2, sheetNumber: "A102" },
    { key: "p2.pdf#3", file: "p2.pdf", page: 3, sheetNumber: "A104" }, // brand new sheet
  ];

  const res = matchSheetSets(base, incoming);
  assert.equal(res.matched.length, 2);
  assert.equal(res.matched[0].sheetNumber, "A101");
  assert.equal(res.matched[1].sheetNumber, "A102");

  // Unmatched base: A103 and unread page 4
  assert.equal(res.unmatchedBase.length, 2);
  assert.ok(res.unmatchedBase.some((s) => s.sheetNumber === "A103"));
  assert.ok(res.unmatchedBase.some((s) => s.sheetNumber === null));

  // Unmatched incoming: A104
  assert.equal(res.unmatchedIncoming.length, 1);
  assert.equal(res.unmatchedIncoming[0].sheetNumber, "A104");
});

test("matchSheetSets: ambiguous duplicate sheet numbers are segregated, not guessed", () => {
  const base: SheetEntry[] = [
    { key: "p1.pdf#1", file: "p1.pdf", page: 1, sheetNumber: "A101" },
    { key: "p1.pdf#2", file: "p1.pdf", page: 2, sheetNumber: "A101" }, // duplicate A101 in base
  ];
  const incoming: SheetEntry[] = [
    { key: "p2.pdf#1", file: "p2.pdf", page: 1, sheetNumber: "A101" },
  ];

  const res = matchSheetSets(base, incoming);
  assert.equal(res.matched.length, 0); // No guessing!
  assert.equal(res.ambiguous.length, 1);
  assert.equal(res.ambiguous[0].sheetNumber, "A101");
});

test("carryTakeoffShapes: shapes crossing changed ink flagged for review; untouched shapes stay intact", () => {
  const W = 1000, H = 1000;

  // Shape 1: Room at (100, 100) to (300, 300) -> normalized (0.1, 0.1) to (0.3, 0.3)
  const shape1: TakeoffShape = {
    id: "shp-room-1",
    sheet_id: "base.pdf#1",
    condition_id: "c-cpt",
    verts_norm: [
      [0.1, 0.1],
      [0.3, 0.1],
      [0.3, 0.3],
      [0.1, 0.3],
    ],
    origin: { method: "manual", reviewed: true },
  };

  // Shape 2: Room at (600, 600) to (800, 800) -> normalized (0.6, 0.6) to (0.8, 0.8)
  const shape2: TakeoffShape = {
    id: "shp-room-2",
    sheet_id: "base.pdf#1",
    condition_id: "c-tile",
    verts_norm: [
      [0.6, 0.6],
      [0.8, 0.6],
      [0.8, 0.8],
      [0.6, 0.8],
    ],
    origin: { method: "manual", reviewed: true },
  };

  // Changed region: at (250, 250) to (350, 350) -> intersects Shape 1 only
  const changedRegions: ChangedRegion[] = [
    {
      id: "crg-1",
      type: "modified",
      bounds: [250, 250, 350, 350],
      hull: [
        [250, 250],
        [350, 250],
        [350, 350],
        [250, 350],
      ],
      segmentCount: 5,
    },
  ];

  const result = carryTakeoffShapes(
    [shape1, shape2],
    "base.pdf#1",
    "rev2.pdf#1",
    W,
    H,
    changedRegions
  );

  assert.equal(result.shapes.length, 2);
  assert.equal(result.flaggedCount, 1);
  assert.equal(result.unmodifiedCount, 1);

  const carried1 = result.shapes.find((s) => s.id === "shp-room-1")!;
  assert.equal(carried1.sheet_id, "rev2.pdf#1");
  assert.equal(carried1.origin?.reviewed, false); // Flagged!
  assert.equal(carried1.origin?.flagged_for_revision, true);
  assert.equal(carried1.origin?.review_reason, "Check after revision");
  assert.deepEqual(carried1.origin?.intersected_change_regions, ["crg-1"]);

  const carried2 = result.shapes.find((s) => s.id === "shp-room-2")!;
  assert.equal(carried2.sheet_id, "rev2.pdf#1");
  assert.equal(carried2.origin?.reviewed, true); // Stays reviewed!
  assert.equal(carried2.origin?.flagged_for_revision, undefined);
});

