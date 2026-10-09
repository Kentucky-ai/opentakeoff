import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPolyArrangement } from "../src/lib/polyarr.ts";
import { netRoomAt, netFieldAt } from "../src/lib/netroom.js";
import { polyWithHolesMetrics } from "../src/lib/geometry.js";
import { computeShapeMetrics } from "../src/lib/shapeMetrics.js";

// A room with a shallow wall jog and a 64 SF interior void, on a larger
// sheet. Exercise the actual arrangement→simplification→quantity boundary.
function fixture() {
  const outer = [[100,100],[400,100],[400,400],[250,400],[250,402],[240,402],[240,400],[100,400]];
  const hole = [[200,200],[280,200],[280,280],[200,280]];
  const segs = [outer, hole, [[0,0],[1000,0],[1000,1000],[0,1000]]].flatMap((r) => r.flatMap((p, i) => [...p, ...r[(i + 1) % r.length]]));
  const arr = buildPolyArrangement(segs, 0.01);
  return { arr, solid: (_i: number) => false, narrowFace: () => false, fixtureFace: () => false, starved: false, doorCellPolys: [],
    _field: { inkFam: () => ({ h: [10, ...Array(11).fill(0)], tot: 10 }), inDoorCell: () => false } };
}

test("room output quantity equals its simplified ring minus retained holes", () => {
  const net = fixture();
  // Refuse growth into the hole or sheet border; only the seed room is open.
  net.solid = (i: number) => net.arr.faces[i].area < 7000 || net.arr.faces[i].area > 100000;
  const r = netRoomAt(net, 150, 150, 10);
  assert.ok(r); assert.equal(r.holes.length, 1);
  assert.equal(r.ring.length, 4, "the shallow jog is simplified away");
  assert.equal(r.areaPx, 83600);
  assert.equal(r.areaPx, polyWithHolesMetrics(r.ring, r.holes).area);
  const shape = { measure_role: "floor_area", verts_norm: r.ring.map(([x,y]: number[]) => [x/1000,y/1000]), verts_norm_holes: r.holes.map((h: number[][]) => h.map(([x,y]) => [x/1000,y/1000])) };
  assert.deepEqual(computeShapeMetrics(shape, { w: 1000, h: 1000 }, 0.1), { area_sf: 836, perimeter_lf: 152 });
});

test("finish-field output also computes from final geometry", () => {
  const net = fixture();
  net.solid = (i: number) => net.arr.faces[i].area < 7000 || net.arr.faces[i].area > 100000;
  const r = netFieldAt(net, 150, 150, 10);
  assert.ok(r); assert.equal(r.holes.length, 1);
  assert.equal(r.areaPx, 83600);
  assert.equal(r.areaPx, polyWithHolesMetrics(r.ring, r.holes).area);
});

// The arrangement's ring start vertex and winding are accidents of its edge
// order (JSTS and other engines differ). The simplified room must not depend
// on them: a 2 px corner notch on a 20 x 346 room used to come out as 6574 or
// 6900 px² depending on where the ring started — the 6574 answer joined the
// notch across the whole 346 px wall as a diagonal.
function notchedRoom() {
  const room = [[0,0],[20,0],[20,346],[2,346],[2,344],[0,344]].map(([x, y]) => [x + 500, y + 500]);
  const border = [[0,0],[2000,0],[2000,2000],[0,2000]];
  const segs = [room, border].flatMap((r) => r.flatMap((p, i) => [...p, ...r[(i + 1) % r.length]]));
  const arr = buildPolyArrangement(segs, 0.01);
  const net = { arr, solid: (i: number) => arr.faces[i].area > 100000, narrowFace: () => false, fixtureFace: () => false, starved: false, doorCellPolys: [],
    _field: { inkFam: () => ({ h: [10, ...Array(11).fill(0)], tot: 10 }), inDoorCell: () => false } };
  return { net, fi: arr.faces.findIndex((f: { area: number }) => f.area < 100000) };
}

for (const [name, fn] of [["netRoomAt", netRoomAt], ["netFieldAt", netFieldAt]] as const) {
  test(`${name}: same room whatever vertex the ring starts at, either winding`, () => {
    const { net, fi } = notchedRoom();
    const orig = net.arr.faces[fi].ring.slice();
    const areas = new Set<number>();
    for (const base of [orig, orig.slice().reverse()]) {
      for (let k = 0; k < base.length; k++) {
        net.arr.faces[fi].ring = base.slice(k).concat(base.slice(0, k));
        const r = fn(net, 510, 600, 9);
        assert.ok(r);
        areas.add(r.areaPx);
      }
    }
    // one answer, and the one that changes the room least: the notch closes
    // across its own 20 px end, not as a wedge down the 346 px wall
    assert.deepEqual([...areas], [6900]);
  });
}
