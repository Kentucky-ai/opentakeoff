import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSheetNumber,
  matchSheetSets,
  carryTakeoffShapes,
  shapeTouchesRegion,
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


test("shapeTouchesRegion: counts and two-point runs are takeoff too", () => {
  const hull: Array<[number, number]> = [[96, 96], [204, 96], [204, 204], [96, 204]];
  const bounds: [number, number, number, number] = [100, 100, 200, 200];
  assert.equal(shapeTouchesRegion([[150, 150]], "count", hull, bounds), true);
  assert.equal(shapeTouchesRegion([[400, 400]], "count", hull, bounds), false);
  assert.equal(shapeTouchesRegion([[50, 150], [300, 150]], "linear", hull, bounds), true);
  assert.equal(shapeTouchesRegion([[50, 300], [300, 300]], "linear", hull, bounds), false);
});

test("shapeTouchesRegion: with the changed segments, the ink decides, not the rectangle around it", () => {
  // An L-shaped dashed line: its bounding box covers the whole room block.
  const segments: Array<[number, number, number, number]> = [[100, 100, 100, 900], [100, 900, 900, 900]];
  const bounds: [number, number, number, number] = [100, 100, 900, 900];
  const hull: Array<[number, number]> = [[96, 96], [904, 96], [904, 904], [96, 904]];
  const inside: Array<[number, number]> = [[400, 300], [600, 300], [600, 500], [400, 500]];
  assert.equal(shapeTouchesRegion(inside, "floor_area", hull, bounds), true, "rectangle test over-flags");
  assert.equal(shapeTouchesRegion(inside, "floor_area", hull, bounds, segments), false);
  const onTheLine: Array<[number, number]> = [[102, 300], [300, 300], [300, 500], [102, 500]];
  assert.equal(shapeTouchesRegion(onTheLine, "floor_area", hull, bounds, segments), true);
  assert.equal(shapeTouchesRegion([[108, 400]], "count", hull, bounds, segments), true);
  assert.equal(shapeTouchesRegion([[500, 400]], "count", hull, bounds, segments), false);
});

test("carryTakeoffShapes flags a count mark sitting on changed ink", () => {
  const regions: ChangedRegion[] = [{ id: "crg-1", type: "modified", bounds: [100, 100, 200, 200], hull: [[96, 96], [204, 96], [204, 204], [96, 204]], segmentCount: 4 }];
  const shapes: TakeoffShape[] = [
    { id: "c1", sheet_id: "a#1", condition_id: "x", measure_role: "count", verts_norm: [[0.15, 0.15]] },
    { id: "c2", sheet_id: "a#1", condition_id: "x", measure_role: "count", verts_norm: [[0.6, 0.6]] },
  ];
  const out = carryTakeoffShapes(shapes, "a#1", "b#1", 1000, 1000, regions);
  assert.equal(out.flaggedCount, 1);
  assert.equal(out.shapes.find((s) => s.id === "c1")!.origin!.flagged_for_revision, true);
});
