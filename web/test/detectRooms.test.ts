// Detect Rooms core tests — pure, DOM-free, pdfjs-free. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { roomLabelSeeds, detectRegions, ROOM_LABEL_RE } from "../src/lib/detectRooms.ts";
import { buildMask } from "../src/lib/oneclick.ts";

// a closed square room, as flat boundary segments in image px
function squareSegs(x0: number, y0: number, x1: number, y1: number): number[] {
  return [
    x0, y0, x1, y0,
    x1, y0, x1, y1,
    x1, y1, x0, y1,
    x0, y1, x0, y0,
  ];
}

test("ROOM_LABEL_RE: 2-3 digits with an optional trailing letter", () => {
  for (const s of ["10", "134", "139A", "170"]) assert.ok(ROOM_LABEL_RE.test(s), s);
  for (const s of ["1", "1234", "AB12", "104-A", ""]) assert.ok(!ROOM_LABEL_RE.test(s), s);
});

test("roomLabelSeeds: keeps only room-number tokens, ANY token in a multi-word item counts", () => {
  const items = [
    { str: "OFFICE 101", x: 50, y: 60 },
    { str: "CORRIDOR 104", x: 70, y: 80 },
    { str: "FLOOR FINISH PLAN", x: 0, y: 0 },        // no digits — dropped
    { str: "SCALE: 1/4\" = 1'-0\"", x: 10, y: 10 },  // no matching token — dropped
    { str: "139A", x: 90, y: 90 },                    // bare number+letter
  ];
  const seeds = roomLabelSeeds(items);
  assert.deepEqual(seeds, [
    { str: "101", seed: [50, 60] },
    { str: "104", seed: [70, 80] },
    { str: "139A", seed: [90, 90] },
  ]);
});

test("roomLabelSeeds: empty/whitespace-only strings and items with no digits produce no seed", () => {
  assert.deepEqual(roomLabelSeeds([{ str: "", x: 0, y: 0 }, { str: "   ", x: 1, y: 1 }, { str: "LOBBY", x: 2, y: 2 }]), []);
});

test("detectRegions: a clean room floods and is kept, status-gated (leak/tiny dropped)", () => {
  const segs = squareSegs(20, 20, 100, 100); // 80x80 interior
  const mask = buildMask(segs, 300, 300);
  const seeds = [
    { str: "101", seed: [60, 60] as [number, number] },   // inside the room — clean
    { str: "999", seed: [5, 5] as [number, number] },      // outside the enclosure — leaks
  ];
  const found = detectRegions(mask, seeds);
  assert.equal(found.length, 1, "only the clean flood survives the status gate");
  assert.equal(found[0].str, "101");
  assert.equal(found[0].flood.status, "ok");
});

test("detectRegions: an empty seed list detects nothing", () => {
  const mask = buildMask(squareSegs(20, 20, 100, 100), 300, 300);
  assert.deepEqual(detectRegions(mask, []), []);
});
