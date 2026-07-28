// Gap bridging (lib/oneclick.ts): leak recovery for rooms whose walls don't
// quite meet. The property under test everywhere: a drafting pinhole seals
// and the room fills (with provenance), a real doorway never does, and a
// watertight room is byte-for-byte unaffected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMask, floodRegion, dilateHard, traceRegion, ringArea, GAP_BRIDGE_MAX } from "../src/lib/oneclick";

// Four wall segs of a rectangle, flat [x0,y0,x1,y1, …] like extractVectorGeometry emits.
const rectSegs = (x0: number, y0: number, x1: number, y1: number) =>
  [x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0];
// Same rectangle, but the TOP wall stops short: open cells (gx0..gx1, y0).
const gappedSegs = (x0: number, y0: number, x1: number, y1: number, gx0: number, gx1: number) =>
  [x0, y0, gx0 - 1, y0, gx1 + 1, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0];

// 600×600 sheet, ws = 1 (mask px = image px). The room must be a small
// fraction of the sheet or LEAK_FRACTION (30%) calls even a clean fill a
// leak — which is itself the property that keeps doorway leaks failing.
const W = 600, H = 600;
const mask = (segs: number[]) => buildMask(segs, W, H, 600);

test("watertight room: fills clean, no bridging flag", () => {
  const f = floodRegion(mask(rectSegs(20, 20, 180, 180)), 100, 100);
  assert.equal(f.status, "ok");
  if (f.status !== "ok") return;
  assert.equal(f.gapBridged, undefined);
  assert.ok(f.count > 150 * 150, "interior filled");
});

test("2px pinhole: leaks strict, seals at radius 1, count stays room-sized", () => {
  const f = floodRegion(mask(gappedSegs(20, 20, 180, 180, 96, 97)), 100, 100);
  assert.equal(f.status, "ok");
  if (f.status !== "ok") return;
  assert.equal(f.gapBridged, 1);
  // dilation shrinks the fill by ≤1 px per side — still plainly the room,
  // never the room plus the outside it used to leak into
  assert.ok(f.count > 150 * 150 && f.count < 160 * 160, `count ${f.count}`);
});

test("4px gap: needs radius 2, and the ring still traces to the room", () => {
  const f = floodRegion(mask(gappedSegs(20, 20, 180, 180, 96, 99)), 100, 100);
  assert.equal(f.status, "ok");
  if (f.status !== "ok") return;
  assert.equal(f.gapBridged, 2);
  const ring = traceRegion(f);
  const area = ringArea(ring);
  assert.ok(area > 145 * 145 && area < 160 * 160, `ring area ${area}`);
});

test("a real doorway (30px) never seals — the leak stands", () => {
  const f = floodRegion(mask(gappedSegs(20, 20, 180, 180, 90, 119)), 100, 100);
  assert.equal(f.status, "leak");
});

test("bridging is leak-recovery only: a tiny strict fill is not bridged away", () => {
  // 5×5-interior box: 25 cells, below TINY_PX (30) — "tiny" is a truthful
  // verdict, and bridging must not run and must not change it
  const f = floodRegion(mask(rectSegs(97, 97, 103, 103)), 100, 100);
  assert.equal(f.status, "tiny");
});

test("dilateHard: hard bit grows by Chebyshev r, soft bits and dims ride through", () => {
  const mw = 9, mh = 9;
  const m = new Uint8Array(mw * mh);
  m[4 * mw + 4] = 1;   // one hard cell, center
  m[0] = 2;            // one soft cell, corner
  const d = dilateHard({ mask: m, mw, mh, ws: 0.5, softCount: 1 }, 1);
  for (let y = 3; y <= 5; y++) for (let x = 3; x <= 5; x++) assert.ok(d.mask[y * mw + x] & 1, `(${x},${y}) hard`);
  assert.ok(!(d.mask[2 * mw + 4] & 1), "radius respected");
  assert.equal(d.mask[0], 2, "soft bit untouched");
  assert.equal(d.ws, 0.5);
  assert.equal(d.softCount, 1);
  assert.ok(GAP_BRIDGE_MAX <= 2, "cap stays pinhole-sized — doorways must keep leaking");
});
