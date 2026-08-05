// Whole-floor polygonization — pins the arrangement against synthetic plans
// with the exact pathologies the flood path documents: T-junctions (walls
// meet mid-span), double-drawn walls (the cavity face is not a room),
// sub-tolerance pinholes (weld, don't leak), short-drawn walls (heal), and
// door openings (NOT healed — an opening merges spaces, honestly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeSegments, snapSegments, extendDangles, polygonizeFaces, detectAllRooms, hardWallSegments } from "../src/lib/polygonize.ts";
import type { VectorGeometry } from "../src/lib/oneclick.ts";

const rect = (x0: number, y0: number, x1: number, y1: number): number[] => [
  x0, y0, x1, y0,  x1, y0, x1, y1,  x1, y1, x0, y1,  x0, y1, x0, y0,
];

test("single room: one face, exact area", () => {
  const rooms = detectAllRooms(rect(0, 0, 100, 80));
  assert.equal(rooms.length, 1);
  assert.ok(Math.abs(rooms[0].areaPx - 8000) < 1);
});

test("2×2 grid drawn as outer rect + two full-span partitions (T-junctions)", () => {
  // partitions cross the outer walls only at T-junctions — nodeSegments must
  // split the outer rect there or no interior face closes
  const segs = [
    ...rect(0, 0, 200, 160),
    100, 0, 100, 160,     // vertical partition, full span
    0, 80, 200, 80,       // horizontal partition, full span
  ];
  const rooms = detectAllRooms(segs);
  assert.equal(rooms.length, 4, "four rooms from one button");
  for (const r of rooms) assert.ok(Math.abs(r.areaPx - 100 * 80) < 1);
});

test("double-drawn wall: the cavity between the two lines is filtered as a sliver", () => {
  // two rooms sharing a 6px-thick double-line wall
  const segs = [
    ...rect(0, 0, 100, 80),
    ...rect(100, 0, 106, 80),    // the wall cavity, drawn as its own rectangle
    ...rect(106, 0, 206, 80),
  ];
  const rooms = detectAllRooms(segs, { minThickPxFallback: 8 });
  assert.equal(rooms.length, 2, "cavity face dropped, two rooms stand");
});

test("sub-tolerance pinhole welds shut; door-width opening stays open", () => {
  // room with a 1px gap in one wall — drafting noise, welds shut at tol 2
  const pin = [
    0, 0, 100, 0,  100, 0, 100, 80,  100, 80, 0, 80,
    0, 80, 0, 40.5,   0, 39.5, 0, 0,       // 1px pinhole in the left wall
  ];
  assert.equal(detectAllRooms(pin, { snapPxFloor: 2, extendPxFallback: 0.5 }).length, 1, "pinhole is not a doorway");

  // two rooms with a 30px doorway between them and no door swing: they merge
  // into ONE face — the arrangement reports what is drawn, and 30px must not
  // be healed by an 8px extension cap
  const doorway = [
    0, 0, 200, 0,  200, 0, 200, 80,  200, 80, 0, 80,  0, 80, 0, 0,
    100, 0, 100, 25,   100, 55, 100, 80,   // partition with a 30px opening
  ];
  const rooms = detectAllRooms(doorway, { extendPxFallback: 8 });
  assert.equal(rooms.length, 1, "an undoored opening merges the spaces — never silently sealed");
});

test("short-drawn wall heals: dangle extends to the wall it was drawn to meet", () => {
  // partition stops 5px short of the bottom wall; extension cap 8px reaches it
  const segs = [
    ...rect(0, 0, 200, 80),
    100, 0, 100, 75,
  ];
  const healedRooms = detectAllRooms(segs, { extendPxFallback: 8 });
  assert.equal(healedRooms.length, 2, "heal closes the 5px shortfall → two rooms");
  assert.ok(healedRooms.every((r) => r.healed), "both rings carry heal provenance");
  const unhealed = detectAllRooms(segs, { extendPxFallback: 2 });
  assert.equal(unhealed.length, 1, "under-cap shortfall stays open — one merged space");
});

test("nodeSegments splits at a proper crossing", () => {
  const out = nodeSegments([0, 0, 10, 10, 0, 10, 10, 0]);
  assert.equal(out.length >> 2, 4, "an X becomes four segments");
});

test("snapSegments dedupes a double-drawn stroke", () => {
  const { segs } = snapSegments([0, 0, 10, 0, 0, 0, 10, 0], 1);
  assert.equal(segs.length >> 2, 1);
});

test("polygonizeFaces trims spurs and keeps interior orientation only", () => {
  // square with a dangling spur into the room
  const faces = polygonizeFaces([...rect(0, 0, 50, 50), 25, 25, 40, 25]);
  assert.equal(faces.length, 1);
  assert.ok(Math.abs(faces[0].areaPx - 2500) < 1);
});

test("extendDangles reports its own count", () => {
  const noded = nodeSegments([...rect(0, 0, 200, 80), 100, 0, 100, 75]);
  const w = snapSegments(noded, 2);
  const h = extendDangles(w.segs, w.ends, 8);
  assert.equal(h.count, 1);
});

test("a big open room dwarfing the rest is flagged suspectOuter, never dropped", () => {
  // warehouse floor (800×800) + two closets (200×400 each): largest > sum of
  // rest — the old guard would have deleted a REAL room here
  const segs = [
    ...rect(0, 0, 1000, 800),
    800, 0, 800, 800,        // partition splitting off the closet bay
    800, 400, 1000, 400,     // partition splitting the bay into two closets
  ];
  const rooms = detectAllRooms(segs);
  assert.equal(rooms.length, 3, "all three rooms survive");
  const flagged = rooms.filter((r) => r.suspectOuter);
  assert.equal(flagged.length, 1, "exactly the dominant face is flagged");
  assert.ok(Math.abs(flagged[0].areaPx - 800 * 800) < 1, "…and it is the warehouse floor");
});

test("snapSegments: points that collide in a packed numeric key stay distinct", () => {
  // (0.262144, 0) and (0, 1e-6) collided under round(y/tol)*262144 +
  // round(x/tol) at tol=1e-6 — the exact-weld tolerance polygonizeFaces uses
  const { verts } = snapSegments([0.262144, 0, 10, 10, 0, 0.000001, -10, 10], 1e-6);
  assert.equal(verts.length, 4, "four distinct endpoints, four vertices");
});

test("hardWallSegments honors the mask's feet-true pitch cap", () => {
  // a pitch-16 hatch field: soft under the scale-blind cap (24 px), HARD
  // under a feet-true cap of 12 px — hardWallSegments must land wherever the
  // mask lands, so the cap has to pass through
  const segs: number[] = [...rect(0, 0, 1000, 800)];
  const meta: number[] = [0, 0, 0, 0];
  let nLines = 0;
  for (let x = 100; x <= 700; x += 16) { segs.push(x, 100, x, 500); meta.push(1 << 4); nLines++; }
  const geom = { points: [], segs, meta: Uint8Array.from(meta), imageArea: 0 } as unknown as VectorGeometry;
  // default cap: the field interior reads as hatch; the classifier keeps a
  // run's two bounding strokes hard (they may be real walls edging the field)
  assert.equal(hardWallSegments(geom, 1).length >> 2, 4 + 2, "default cap: field interior is soft");
  assert.equal(hardWallSegments(geom, 1, 12).length >> 2, 4 + nLines, "tighter feet-true cap: the field is not hatch, its lines are walls");
});
