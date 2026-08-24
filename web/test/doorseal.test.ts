// doorseal — reading a hinged opening off its own swing and closing it.
// Built on synthetic rooms at a stated scale, so every assertion is about the
// mechanism and not about one drafter's habits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findDoorSeals, sealDoorways } from "../src/lib/doorseal.ts";
import { buildMask, floodRegion, SEG_CURVE } from "../src/lib/oneclick.ts";

const FT = 18;                       // image px per foot
const W = 40 * FT, H = 30 * FT;      // sheet

/** Straight wall run as segments, with a gap [gap0, gap1) left open. */
function wallX(y: number, x0: number, x1: number, gap0 = 0, gap1 = 0): number[] {
  const out: number[] = [];
  const step = FT / 2;
  for (let x = x0; x < x1; x += step) {
    const xe = Math.min(x + step, x1);
    if (gap1 > gap0 && xe > gap0 && x < gap1) continue;
    out.push(x, y, xe, y);
  }
  return out;
}
function wallY(x: number, y0: number, y1: number): number[] {
  const out: number[] = [];
  const step = FT / 2;
  for (let y = y0; y < y1; y += step) out.push(x, y, x, Math.min(y + step, y1));
  return out;
}

/** A quarter-circle swing, tessellated as chords, hinged at (cx,cy). */
function swing(cx: number, cy: number, r: number, a0: number, a1: number, n = 12): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = a0 + (a1 - a0) * (i / n), t1 = a0 + (a1 - a0) * ((i + 1) / n);
    out.push(cx + r * Math.cos(t0), cy + r * Math.sin(t0), cx + r * Math.cos(t1), cy + r * Math.sin(t1));
  }
  return out;
}

/** A room 4 ft..24 ft × 4 ft..19 ft with a 3 ft doorway in its south wall,
 *  and (optionally) the swing the drafter would draw at that doorway. */
function room(withSwing: boolean) {
  const gap0 = 12 * FT, gap1 = 15 * FT;
  const straight = [
    ...wallX(4 * FT, 4 * FT, 24 * FT),
    ...wallX(19 * FT, 4 * FT, 24 * FT, gap0, gap1),
    ...wallY(4 * FT, 4 * FT, 19 * FT),
    ...wallY(24 * FT, 4 * FT, 19 * FT),
    // the corridor on the far side of the doorway, so a leak has somewhere to go
    ...wallX(24 * FT, 4 * FT, 24 * FT),
  ];
  const segs = straight.slice();
  const meta = new Uint8Array(straight.length >> 2);          // straight ink: no bits
  if (withSwing) {
    // hinged at the west jamb, swinging up into the room
    const arc = swing(gap0, 19 * FT, 3 * FT, -Math.PI / 2, 0);
    const before = segs.length >> 2;
    segs.push(...arc);
    const m2 = new Uint8Array(segs.length >> 2);
    m2.set(meta);
    for (let i = before; i < segs.length >> 2; i++) m2[i] = SEG_CURVE;
    return { segs, meta: m2 };
  }
  return { segs, meta };
}

const maskOf = (segs: number[], meta: Uint8Array) =>
  buildMask(segs, W, H, 3000, meta, FT, FT, { pageW: W, pageH: H, renderScale: 1, baseScale: 1 }, null, null);

test("a doorway with no swing drawn yields no seal — refusing beats guessing", () => {
  const { segs, meta } = room(false);
  const mo = maskOf(segs, meta);
  assert.equal(findDoorSeals(segs, meta, mo, FT).length, 0);
});

test("a swing is read as one door, hinge on the jamb", () => {
  const { segs, meta } = room(true);
  const mo = maskOf(segs, meta);
  const seals = findDoorSeals(segs, meta, mo, FT);
  assert.equal(seals.length, 1);
  const [s] = seals;
  assert.ok(Math.abs(s.hinge[0] - 12 * FT) < FT, `hinge x ${s.hinge[0]} near the jamb`);
  assert.ok(Math.abs(s.hinge[1] - 19 * FT) < FT, `hinge y ${s.hinge[1]} on the wall`);
  assert.ok(Math.abs(s.r - 3 * FT) < 0.3 * FT, `leaf ${(s.r / FT).toFixed(2)} ft`);
});

test("sealing the door turns a leaking room into a measurable one", () => {
  const { segs, meta } = room(true);
  const mo = maskOf(segs, meta);
  const seed: [number, number] = [Math.round(14 * FT * mo.ws), Math.round(10 * FT * mo.ws)];
  const before = floodRegion(mo, seed[0], seed[1]);
  const sealed = sealDoorways(mo, findDoorSeals(segs, meta, mo, FT));
  assert.equal(sealed.sealed, 1);
  const after = floodRegion(sealed.mo, seed[0], seed[1]);
  assert.equal(after.status, "ok");
  if (after.status !== "ok") return;
  const sf = after.count / (mo.mppf ?? FT * mo.ws) ** 2;
  // the room is 20 × 15 ft measured wall centre to wall centre; the flood runs
  // to the wall FACE, so it comes in just under
  assert.ok(sf > 270 && sf < 300, `sealed room ${sf.toFixed(1)} SF`);
  // and it is a real improvement: unsealed either leaks or overruns the room
  if (before.status === "ok") {
    assert.ok(before.count > after.count, "unsealed flood escaped through the doorway");
  }
});

test("the seal never edits the caller's mask", () => {
  const { segs, meta } = room(true);
  const mo = maskOf(segs, meta);
  const copy = new Uint8Array(mo.mask);
  sealDoorways(mo, findDoorSeals(segs, meta, mo, FT));
  assert.deepEqual(mo.mask, copy);
});

test("a fixture arc floating in open floor is not a door", () => {
  const { segs, meta } = room(false);
  // a full-circle-ish sweep in the middle of the room, touching no wall
  const arc = swing(14 * FT, 10 * FT, 2 * FT, 0, Math.PI / 2);
  const before = segs.length >> 2;
  const segs2 = segs.concat(arc);
  const meta2 = new Uint8Array(segs2.length >> 2);
  meta2.set(meta);
  for (let i = before; i < segs2.length >> 2; i++) meta2[i] = SEG_CURVE;
  const mo = maskOf(segs2, meta2);
  assert.equal(findDoorSeals(segs2, meta2, mo, FT).length, 0);
});
