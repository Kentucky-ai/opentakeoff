// Whole-floor polygonization — pins the arrangement against synthetic plans
// with the exact pathologies the flood path documents: T-junctions (walls
// meet mid-span), double-drawn walls (the cavity face is not a room),
// sub-tolerance pinholes (weld, don't leak), short-drawn walls (heal), and
// door openings (NOT healed — an opening merges spaces, honestly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeSegments, snapSegments, extendDangles, polygonizeFaces, detectAllRooms, detectAllRoomsDetailed, hardWallSegments } from "../src/lib/polygonize.ts";
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

test("door-line seal: a doorway splits the rooms at the threshold when scale is known", () => {
  // same doorway geometry that merges when scale-blind (30px opening, blind
  // bridge cap 24): at 10 px/ft the opening is a 3ft door and the 6ft bridge
  // seals it — two rooms, both carrying seal provenance
  const doorway = [
    0, 0, 200, 0,  200, 0, 200, 80,  200, 80, 0, 80,  0, 80, 0, 0,
    100, 0, 100, 25,   100, 55, 100, 80,
  ];
  const rooms = detectAllRooms(doorway, { pxPerFt: 10 });
  assert.equal(rooms.length, 2, "the doorway is a threshold, not a merger");
  assert.ok(rooms.every((r) => r.sealed), "both rings record the door-line seal");
  for (const r of rooms) assert.ok(Math.abs(r.areaPx - 100 * 80) < 1);
});

test("door-line seal is blocked when solid linework crosses the gap", () => {
  const doorway = [
    0, 0, 200, 0,  200, 0, 200, 80,  200, 80, 0, 80,  0, 80, 0, 0,
    100, 0, 100, 25,   100, 55, 100, 80,
    80, 40, 120, 40,   // a stroke crossing the opening — jambs must not bridge through it
  ];
  const rooms = detectAllRooms(doorway, { pxPerFt: 10 });
  assert.ok(rooms.every((r) => !r.sealed), "no bridge through solid ink");
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

/** a regular polygon approximating a circle, as segment quads */
const circle = (cx: number, cy: number, r: number, sides = 16): number[] => {
  const out: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a0 = (2 * Math.PI * i) / sides, a1 = (2 * Math.PI * (i + 1)) / sides;
    out.push(cx + r * Math.cos(a0), cy + r * Math.sin(a0), cx + r * Math.cos(a1), cy + r * Math.sin(a1));
  }
  return out;
};

test("room-number bubble: a small near-circle is culled as a tag, the room stands", () => {
  const { rooms, culled } = detectAllRoomsDetailed([...rect(0, 0, 300, 200), ...circle(150, 100, 12)]);
  assert.equal(rooms.length, 1, "the room survives");
  assert.ok(Math.abs(rooms[0].areaPx - 300 * 200) < 1, "room ring is the rect");
  assert.equal(culled.tags, 1, "the bubble is counted, not silently dropped");
});

test("islands: schedule grid, casework and detail boxes die whole; the island room survives", () => {
  const segs = [
    ...rect(0, 0, 1000, 800),        // the plate
    ...rect(100, 100, 400, 400),     // an island room inside the plate (11% of it — over the 5% bar)
    ...rect(150, 150, 200, 190),     // casework drawn inside that room (its own tiny island)
    ...rect(1100, 100, 1180, 160),   // a closed box outside the plate (detail border)
    // a detached finish schedule: border + 8 uniform cells, all tiny islands
    ...rect(1100, 300, 1344, 380),
    ...Array.from({ length: 8 }, (_, i) => rect(1104 + i * 30, 304, 1104 + i * 30 + 26, 320)).flat(),
  ];
  const { rooms, culled } = detectAllRoomsDetailed(segs);
  assert.equal(rooms.length, 3, "plate + island room (+ the in-room box: known residue, the area floor's job)");
  const plate = rooms.find((r) => r.suspectOuter);
  assert.ok(plate && Math.abs(plate.areaPx - 1000 * 800) < 1, "the plate is kept but flagged (dominant)");
  assert.ok(rooms.some((r) => !r.suspectOuter && Math.abs(r.areaPx - 300 * 300) < 1), "the island room is a room");
  assert.equal(culled.floaters, 10, "detail box + schedule border + 8 cells, all counted");
});

test("small island rooms inside a sparse plate are never culled (chain rule)", () => {
  // 8 uniform island rooms of 150 SF inside a wing — each island is under the
  // 5% component bar on its own, but the containment chain reaches the wing
  const wing: number[] = [...rect(0, 0, 1300, 300)];
  for (let i = 0; i < 8; i++) wing.push(...rect(10 + i * 160, 10, 10 + i * 160 + 150, 110));
  const w = detectAllRoomsDetailed(wing, { pxPerFt: 10 });
  assert.equal(w.rooms.length, 9, "wing face + 8 rooms all stand");
  assert.equal(w.culled.floaters, 0, "nothing culled");
  assert.equal(w.rooms.filter((r) => r.suspectOuter).length, 1, "the wing ring is flagged (dominant) — committing it would double-count");
});

const geomOf = (segs: number[], metaFlags: number[], dashed?: number[]) =>
  ({ points: [], segs, meta: Uint8Array.from(metaFlags), imageArea: 0, ...(dashed ? { dashed: Uint8Array.from(dashed) } : {}) } as unknown as VectorGeometry);

test("unpaired dashed ink is never a wall; a dashed PAIR is an existing wall", () => {
  // a lone dashed stroke far from anything (a match line) is dropped
  const lone = geomOf([0, 0, 100, 0, 0, 30, 100, 30], [0, 0], [0, 1]);
  assert.equal(hardWallSegments(lone, 1).length >> 2, 1, "the unpaired dashed stroke is dropped");
  // dashed twins at wall thickness = an existing wall on a renovation plan
  // (a solid pair rides along so the sheet has enough proven linework to
  // engage walls mode — coverage is judged on solid ink only)
  const pair = geomOf(
    [0, 0, 100, 0, 0, 5, 100, 5, 0, 50, 100, 50, 0, 55, 100, 55],
    [0, 0, 0, 0], [0, 0, 1, 1],
  );
  assert.equal(hardWallSegments(pair, 1).length >> 2, 4, "the dashed pair survives as an existing wall");
});

test("a door swing arc becomes its straight chord — the room ends at the door line", () => {
  // doorway walls + a swing drawn as a bulging arc whose chord IS the threshold
  const walls = [
    0, 0, 200, 0,  200, 0, 200, 80,  200, 80, 0, 80,  0, 80, 0, 0,
    100, 0, 100, 25,   100, 55, 100, 80,
  ];
  const arc: number[] = [];
  const meta: number[] = new Array(walls.length >> 2).fill(0);
  const cx = 100, cy = 40, r = 15;
  for (let k = 0; k < 4; k++) {
    const a0 = -Math.PI / 2 + (k * Math.PI) / 4, a1 = -Math.PI / 2 + ((k + 1) * Math.PI) / 4;
    arc.push(cx + r * Math.cos(a0), cy + r * Math.sin(a0), cx + r * Math.cos(a1), cy + r * Math.sin(a1));
    meta.push(1);   // SEG_CURVE
  }
  const hard = hardWallSegments(geomOf([...walls, ...arc], meta), 1, undefined, 10);
  assert.equal(hard.length >> 2, (walls.length >> 2) + 1, "four arc chords → one straight chord");
  const rooms = detectAllRooms(hard, { pxPerFt: 10 });
  assert.equal(rooms.length, 2, "the chord closes the doorway");
  for (const r2 of rooms) assert.ok(Math.abs(r2.areaPx - 100 * 80) < 1, "straight threshold — exact halves, no scallop");
});

test("a revision-cloud squiggle never bounds a room; a radius wall still does", () => {
  // cloud: three semicircle bumps chained across the room interior
  const cloud: number[] = [];
  const cmeta: number[] = [];
  for (let b = 0; b < 3; b++) {
    const cx = 70 + b * 20, cy = 40, r = 10;
    for (let k = 0; k < 4; k++) {
      const a0 = Math.PI + (k * Math.PI) / 4, a1 = Math.PI + ((k + 1) * Math.PI) / 4;
      cloud.push(cx + r * Math.cos(a0), cy + r * Math.sin(a0), cx + r * Math.cos(a1), cy + r * Math.sin(a1));
      cmeta.push(1);
    }
  }
  const rect1 = rect(0, 0, 200, 80);
  const g = geomOf([...rect1, ...cloud], [...new Array(rect1.length >> 2).fill(0), ...cmeta]);
  const rooms = detectAllRooms(hardWallSegments(g, 1, undefined, 10), { pxPerFt: 10 });
  assert.equal(rooms.length, 1, "the cloud is ignored — one room, unsplit");

  // radius wall: a quarter arc (span 113 px, gentle) must stay a boundary
  const rw: number[] = [0, 0, 100, 0];
  const rmeta: number[] = [0];
  for (let k = 0; k < 6; k++) {
    const a0 = -Math.PI / 2 + (k * Math.PI) / 12, a1 = -Math.PI / 2 + ((k + 1) * Math.PI) / 12;
    rw.push(100 + 80 * Math.cos(a0), 80 + 80 * Math.sin(a0), 100 + 80 * Math.cos(a1), 80 + 80 * Math.sin(a1));
    rmeta.push(1);
  }
  rw.push(180, 80, 0, 80,  0, 80, 0, 0);
  rmeta.push(0, 0);
  const rrooms = detectAllRooms(hardWallSegments(geomOf(rw, rmeta), 1, undefined, 10), { pxPerFt: 10 });
  assert.equal(rrooms.length, 1, "the curved room closes through its radius wall");
  assert.ok(rrooms[0].areaPx > 100 * 80, "…and includes the bay beyond the square corner");
});

test("wall-first: only paired linework bounds; keynote boxes stop existing", () => {
  // a double-line room (6" wall at 12 px/ft) with a finish-keynote box inside —
  // the box is wall-thickness tall, but a wall RUNS and a box doesn't
  const segs = [...rect(0, 0, 212, 172), ...rect(6, 6, 206, 166), ...rect(50, 50, 90, 62)];
  const meta = new Array(segs.length >> 2).fill(0);
  const info: import("../src/lib/polygonize.ts").WallInfo = {};
  const hard = hardWallSegments({ points: [], segs, meta: Uint8Array.from(meta), imageArea: 0 } as never, 1, undefined, 12, info);
  assert.equal(info.mode, "walls", "paired coverage engages wall-first");
  assert.equal(hard.length >> 2, 8, "eight wall faces — the keynote box paired with nothing");
  const rooms = detectAllRooms(hard, { pxPerFt: 12 });
  assert.equal(rooms.length, 1, "one room, no keynote-box phantom");
  assert.ok(Math.abs(rooms[0].areaPx - 200 * 160) < 1, "bounded at the INNER wall face");
});

test("wall-first falls back to open linework on single-stroke plans", () => {
  const segs = [...rect(0, 0, 200, 160), 100, 0, 100, 160, 0, 80, 200, 80];
  const info: import("../src/lib/polygonize.ts").WallInfo = {};
  const hard = hardWallSegments({ points: [], segs, meta: new Uint8Array(segs.length >> 2), imageArea: 0 } as never, 1, undefined, 12, info);
  assert.equal(info.mode, "linework", "nothing pairs — subtractive mode");
  assert.equal(detectAllRooms(hard, { pxPerFt: 12 }).length, 4, "the single-line grid still detects");
});

test("the pen tier adds jamb stubs; text-row impostors die to their own text", () => {
  // a double-line room at pen weight 2, a 6px heavy jamb stub the pairing
  // minLen always dropped, three light text-row pairs at wall-ish offsets
  // (they PAIR — wave 4 admitted them; their own span boxes kill them now),
  // and two lone light leader lines that keep the tier share in band
  const wallSegs = [...rect(0, 0, 412, 312), ...rect(6, 6, 406, 306)];
  const lightRows: number[] = [];
  for (let r = 0; r < 3; r++) lightRows.push(40, 60 + r * 40, 140, 60 + r * 40, 40, 68 + r * 40, 140, 68 + r * 40);
  const leaders = [500, 50, 800, 50, 500, 400, 800, 400];
  const cap = [406, 150, 412, 150];   // spans the wall pair, inner face to outer
  const segs = [...wallSegs, ...lightRows, ...leaders, ...cap];
  const meta = [
    ...new Array(wallSegs.length >> 2).fill(2 << 4),
    ...new Array(lightRows.length >> 2).fill(1 << 4),
    1 << 4, 1 << 4,
    2 << 4,
  ];
  const spans = Array.from({ length: 3 }, (_, r) => ({ str: "NOTE ROW TEXT", x0: 38, y0: 56 + r * 40, x1: 142, y1: 70 + r * 40 }));
  const info: import("../src/lib/polygonize.ts").WallInfo = {};
  const hard = hardWallSegments(geomOf(segs, meta), 1, undefined, 12, info, { spans });
  assert.equal(info.mode, "walls");
  assert.ok(info.tier, "the pen tier engaged alongside pairing");
  assert.equal(hard.length >> 2, (wallSegs.length >> 2) + 1, "walls + the short heavy cap; text rows and lone leaders gone");
  const rooms = detectAllRooms(hard, { pxPerFt: 12 });
  assert.equal(rooms.length, 1, "one room, no text-row phantoms");
  assert.ok(Math.abs(rooms[0].areaPx - 400 * 300) < 1, "bounded at the inner wall face");
});

test("the pen tier stands down when the sheet draws everything heavy", () => {
  // uniform heavy ink carries no signal — pairing must gatekeep alone or the
  // union would admit every heavy annotation on the sheet
  const segs = [...rect(0, 0, 212, 172), ...rect(6, 6, 206, 166)];
  const meta = new Array(segs.length >> 2).fill(2 << 4);
  const info: import("../src/lib/polygonize.ts").WallInfo = {};
  hardWallSegments(geomOf(segs, meta), 1, undefined, 12, info);
  assert.equal(info.mode, "walls", "pairing carries the all-heavy sheet");
  assert.equal(info.tier, undefined, "no tier claimed");
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
  // tighter cap: the field is DECLARED not-hatch, and its periodic parallel
  // lines then pair as walls (wall-first can't re-litigate what the hatch
  // classifier was told) — the unpaired outer rect drops in walls mode
  const info: import("../src/lib/polygonize.ts").WallInfo = {};
  const tight = hardWallSegments(geom, 1, 12, undefined, info);
  assert.equal(info.mode, "walls");
  assert.equal(tight.length >> 2, nLines, "the declared-hard field pairs as walls");
});
