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
