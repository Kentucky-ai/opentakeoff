// Drawn rooms (lib/drawnrooms.ts) — the boundaries the sheet already states.
// The invariants, in the order they decide an answer:
//   - a figure must be closed, room-sized, and not most of the sheet;
//   - one room stated twice (clip + stroke) collapses to one candidate, and
//     the CLIP survives;
//   - the answer is the smallest enclosing figure, with a clip preferred only
//     when it describes the SAME region (blanket clip-preference turned a
//     36 SF room into 481 SF on a real sheet);
//   - rooms NEST (a suite holds offices), so containment proves nothing; what
//     marks a viewport is walls running through its interior, and that is
//     REFUSED — returning nothing is honest and the caller still has the flood.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  drawnRegions, roomAtPoint, pointInRing, interiorWallRuns,
  ROOM_MIN_SF, WALL_RUN_MIN_FT,
} from "../src/lib/drawnrooms.ts";
import { SEG_CLIP, SEG_FILLONLY, type SubPath } from "../src/lib/oneclick.ts";

const FT = 18;   // px per foot, the convention the other geometry fixtures use

/** A closed rectangle as segments + its subpath record. */
function rect(x: number, y: number, w: number, h: number, flags = 0, segs: number[] = [], sps: SubPath[] = []) {
  const i0 = segs.length >> 2;
  const q: Array<[number, number]> = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  for (let k = 0; k < 4; k++) { const a = q[k], b = q[(k + 1) % 4]; segs.push(a[0], a[1], b[0], b[1]); }
  sps.push({ i0, i1: segs.length >> 2, x0: x, y0: y, x1: x + w, y1: y + h, closed: true, flags, fillLum: 0 });
  return { segs, sps };
}

test("pointInRing: inside, outside, and a shared edge belongs to one side only", () => {
  const sq: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(pointInRing(sq, 5, 5), true);
  assert.equal(pointInRing(sq, 15, 5), false);
  // two rooms sharing the y=10 edge: the point belongs to exactly one
  const below: Array<[number, number]> = [[0, 10], [10, 10], [10, 20], [0, 20]];
  assert.notEqual(pointInRing(sq, 5, 10), pointInRing(below, 5, 10));
});

test("drawnRegions: a room-sized closed figure is a candidate; a tag box is not", () => {
  const { segs, sps } = rect(100, 100, 6 * FT, 5 * FT);        // 30 SF room
  rect(120, 120, 1.5 * FT, 0.7 * FT, 0, segs, sps);            // ~1 SF tag box
  const rs = drawnRegions(segs, sps, FT);
  assert.equal(rs.length, 1, "only the room clears the size floor");
  assert.ok(Math.abs(rs[0].areaSF - 30) < 0.01);
});

test("drawnRegions: an open figure is never a candidate, whatever its size", () => {
  const segs = [0, 0, 200, 0, 200, 0, 200, 200];
  const sps: SubPath[] = [{ i0: 0, i1: 2, x0: 0, y0: 0, x1: 200, y1: 200, closed: false, flags: 0, fillLum: 0 }];
  assert.deepEqual(drawnRegions(segs, sps, FT), []);
});

test("drawnRegions: a figure covering most of the sheet is the border, not a room", () => {
  const { segs, sps } = rect(0, 0, 100 * FT, 100 * FT);        // 10,000 SF
  assert.deepEqual(drawnRegions(segs, sps, FT, 12000), [], "over half the sheet ⇒ dropped");
  assert.equal(drawnRegions(segs, sps, FT, 100000).length, 1, "…but fine on a sheet it does not dominate");
});

test("drawnRegions: one room stated as clip AND stroke collapses to one, keeping the clip", () => {
  const { segs, sps } = rect(100, 100, 10 * FT, 10 * FT, SEG_CLIP);
  rect(100.5, 100.5, 10 * FT, 10 * FT, 0, segs, sps);          // the stroked twin, a hair off
  const rs = drawnRegions(segs, sps, FT);
  assert.equal(rs.length, 1, "the same room is one candidate");
  assert.equal(rs[0].source, "clip", "and the clip is the better statement of it");
});

test("roomAtPoint: returns the innermost enclosing room, never the suite around it", () => {
  const { segs, sps } = rect(0, 0, 40 * FT, 40 * FT);          // 1600 SF suite
  rect(2 * FT, 2 * FT, 10 * FT, 10 * FT, 0, segs, sps);        // 100 SF room inside it
  const rs = drawnRegions(segs, sps, FT, 100000);
  const hit = roomAtPoint(rs, 7 * FT, 7 * FT);
  assert.ok(hit);
  assert.ok(Math.abs(hit!.areaSF - 100) < 0.01, `got ${hit!.areaSF}`);
});

test("roomAtPoint: a clip only wins when it describes the SAME region", () => {
  // the failure this rule exists for: a large clip enclosing the click turned
  // a 36 SF room into 481 SF when clips were preferred unconditionally
  const { segs, sps } = rect(0, 0, 30 * FT, 30 * FT, SEG_CLIP);   // 900 SF clip
  rect(FT, FT, 6 * FT, 6 * FT, 0, segs, sps);                     // 36 SF stroked room
  const rs = drawnRegions(segs, sps, FT, 100000);
  const hit = roomAtPoint(rs, 3 * FT, 3 * FT);
  assert.ok(Math.abs(hit!.areaSF - 36) < 0.01, `the room, not the clip around it (got ${hit!.areaSF})`);
});

test("roomAtPoint: rooms NEST — a suite holding a closet is still a room", () => {
  // containment proves nothing about either figure; the innermost enclosure
  // is the right answer inside the closet, and the suite is the right answer
  // outside it
  const { segs, sps } = rect(0, 0, 40 * FT, 40 * FT, SEG_CLIP);   // the suite
  rect(2 * FT, 2 * FT, 10 * FT, 10 * FT, 0, segs, sps);           // a closet within
  const rs = drawnRegions(segs, sps, FT, 100000);
  assert.ok(Math.abs(roomAtPoint(rs, 7 * FT, 7 * FT)!.areaSF - 100) < 0.01, "inside the closet ⇒ the closet");
  assert.ok(Math.abs(roomAtPoint(rs, 30 * FT, 30 * FT)!.areaSF - 1600) < 0.01, "outside it ⇒ the suite");
});

test("interiorWallRuns: walls crossing a figure disqualify it; furniture does not", () => {
  const { segs, sps } = rect(0, 0, 40 * FT, 40 * FT, SEG_CLIP);
  const room = drawnRegions(segs, sps, FT, 100000)[0];
  assert.equal(interiorWallRuns(room, segs, null, FT), 0, "its own edges never count against it");
  // a short casework run inside is not a wall
  const withDesk = segs.concat([10 * FT, 20 * FT, 13 * FT, 20 * FT]);
  assert.equal(interiorWallRuns(room, withDesk, null, FT), 0, `${WALL_RUN_MIN_FT} ft is the bar`);
  // three long partitions crossing it are a floor plan, not a room
  const withWalls = segs.concat([
    5 * FT, 10 * FT, 35 * FT, 10 * FT,
    5 * FT, 20 * FT, 35 * FT, 20 * FT,
    5 * FT, 30 * FT, 35 * FT, 30 * FT,
  ]);
  assert.ok(interiorWallRuns(room, withWalls, null, FT) > 2);
});

test("roomAtPoint: a viewport with walls through it is refused, so the caller falls back", () => {
  const { segs, sps } = rect(0, 0, 40 * FT, 40 * FT, SEG_CLIP);
  const withWalls = segs.concat([
    5 * FT, 10 * FT, 35 * FT, 10 * FT,
    5 * FT, 20 * FT, 35 * FT, 20 * FT,
    5 * FT, 30 * FT, 35 * FT, 30 * FT,
  ]);
  const rs = drawnRegions(withWalls, sps, FT, 100000);
  assert.equal(roomAtPoint(rs, 20 * FT, 5 * FT, { segs: withWalls, meta: null, ftPx: FT }), null);
  assert.ok(roomAtPoint(rs, 20 * FT, 5 * FT), "…and without the ink it cannot know, so it still answers");
});

test("drawnRegions: no figures, or no scale, is a clean no-op", () => {
  const { segs, sps } = rect(100, 100, 10 * FT, 10 * FT);
  assert.deepEqual(drawnRegions(segs, null, FT), []);
  assert.deepEqual(drawnRegions(segs, sps, 0), []);
  assert.equal(ROOM_MIN_SF > 0, true);
});

test("drawnRegions: a filled figure is a candidate and reports its source", () => {
  const { segs, sps } = rect(100, 100, 8 * FT, 8 * FT, SEG_FILLONLY);
  const rs = drawnRegions(segs, sps, FT);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].source, "fill");
});
