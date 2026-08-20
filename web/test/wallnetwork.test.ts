// Wall network — the connectivity evidence that separates a partition drawn at
// hatch weight from the hatch it stands in.
//
// Every case here is a claim the mechanism makes, built as linework rather than
// asserted on a fixture: a hatch field is drawn as a hatch field, a partition as
// a partition, and the classifier has to tell them apart with no pen-weight help.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  networkWallSegs, collectFaces, chainFaces, seedWeight, onLattice,
  junctionsAndCrossings, SEED_SHARE,
} from "../src/lib/wallnetwork.ts";
import { SEG_CLIP, SEG_FILLONLY } from "../src/lib/oneclick.ts";

const PPF = 10;                       // mask px per foot for these fixtures
const ft = (n: number): number => n * PPF;

/** segment pusher that stamps the pen class into meta's high nibble */
function rig() {
  const segs: number[] = [];
  const meta: number[] = [];
  return {
    segs, meta,
    line(x1: number, y1: number, x2: number, y2: number, w = 1, flags = 0): number {
      segs.push(x1, y1, x2, y2);
      meta.push(flags | (w << 4));
      return meta.length - 1;
    },
    metaArr(): Uint8Array { return Uint8Array.from(meta); },
  };
}

test("collectFaces — keeps axial runs and poché outlines, drops diagonals and clip-only ink", () => {
  const r = rig();
  r.line(ft(0), ft(0), ft(0), ft(10), 2);           // vertical
  r.line(ft(0), ft(0), ft(10), ft(0), 2);           // horizontal
  r.line(ft(0), ft(0), ft(10), ft(10), 2);          // diagonal — no axis line answers for it
  r.line(ft(5), ft(0), ft(5), ft(10), 2, SEG_CLIP); // invisible ink bounds nothing
  r.line(ft(6), ft(0), ft(6), ft(10), 2, SEG_FILLONLY);  // solid poché IS a wall face
  const { V, H } = collectFaces(r.segs, r.metaArr(), 1, ft(0.5));
  assert.equal(V.length, 2);                        // the vertical and the poché edge
  assert.equal(H.length, 1);
  assert.equal(V.some((f) => Math.abs(f.c - ft(5)) < 1), false);   // never the clip
});

test("collectFaces / chainFaces — welds collinear pieces of one pen but never across pen classes", () => {
  const r = rig();
  r.line(ft(0), ft(0), ft(0), ft(5), 3);
  r.line(ft(0), ft(5.2), ft(0), ft(10), 3);        // same pen, small gap → one run
  r.line(ft(0), ft(10.2), ft(0), ft(15), 1);       // hairline — must NOT inherit
  const { V } = collectFaces(r.segs, r.metaArr(), 1, ft(0.5));
  const chained = chainFaces(V, ft(0.35), ft(0.06), ft(2));
  assert.equal(chained.length, 2);
  const heavy = chained.find((f) => f.w === 3);
  assert.equal(heavy && Math.round(heavy.length / PPF), 10);
  // the welded run keeps its raw pieces — their endpoints are the evidence
  assert.equal(heavy && heavy.parts.length, 2);
});

test("seedWeight — the heavy tier is read off the sheet, not a constant — ignores a top pen used for a handful of accents", () => {
  const r = rig();
  for (let i = 0; i < 20; i++) r.line(ft(i), ft(0), ft(i), ft(20), 2);  // the drawing
  r.line(ft(3), ft(3), ft(3), ft(5), 9);                                 // two accents
  r.line(ft(4), ft(3), ft(4), ft(5), 9);
  const { V } = collectFaces(r.segs, r.metaArr(), 1, ft(0.5));
  const chained = chainFaces(V, ft(0.35), ft(0.06), ft(2));
  assert.equal(seedWeight(chained), 2);
});

test("seedWeight — the heavy tier is read off the sheet, not a constant — picks the heaviest pen when it really is the drawing's structure", () => {
  const r = rig();
  for (let i = 0; i < 10; i++) r.line(ft(i), ft(0), ft(i), ft(20), 5);
  for (let i = 0; i < 10; i++) r.line(ft(i) + 1, ft(0), ft(i) + 1, ft(20), 1);
  const { V } = collectFaces(r.segs, r.metaArr(), 1, ft(0.5));
  assert.equal(seedWeight(chainFaces(V, ft(0.35), ft(0.06), ft(2))), 5);
});

test("seedWeight — the heavy tier is read off the sheet, not a constant — a share of 0 takes only the top class, a share of 1 takes everything", () => {
  const r = rig();
  for (let i = 0; i < 10; i++) r.line(ft(i), ft(0), ft(i), ft(20), 1);
  r.line(ft(50), ft(0), ft(50), ft(20), 7);
  const { V } = collectFaces(r.segs, r.metaArr(), 1, ft(0.5));
  const c = chainFaces(V, ft(0.35), ft(0.06), ft(2));
  assert.equal(seedWeight(c, 0), 7);
  assert.equal(seedWeight(c, 1), 1);
  assert.ok((SEED_SHARE) > (0));
});

test("onLattice — rhythm, not neighbour count — calls the interior courses of a regular field lattice and spares the extremes", () => {
  const r = rig();
  for (let i = 0; i < 9; i++) r.line(ft(i * 0.5), ft(0), ft(i * 0.5), ft(20), 1);
  const { V } = collectFaces(r.segs, r.metaArr(), 1, ft(0.5));
  const chained = chainFaces(V, ft(0.35), ft(0.06), ft(2)).sort((a, b) => a.c - b.c);
  const lat = onLattice(chained, ft(3), ft(1.5), ft(0.5));
  assert.equal(lat[0], false);                       // extremal course: one side only
  assert.equal(lat[lat.length - 1], false);
  assert.equal(lat[4], true);                        // interior of the rhythm
});

test("onLattice — rhythm, not neighbour count — spares an irregularly spaced family — rooms have neighbours too", () => {
  const r = rig();
  for (const x of [0, 2.4, 9.1, 14.7, 23.2]) r.line(ft(x), ft(0), ft(x), ft(20), 1);
  const { V } = collectFaces(r.segs, r.metaArr(), 1, ft(0.5));
  const chained = chainFaces(V, ft(0.35), ft(0.06), ft(2)).sort((a, b) => a.c - b.c);
  assert.equal(onLattice(chained, ft(3), ft(1.5), ft(0.5)).every((v) => v === false), true);
});

test("junctionsAndCrossings — landed on, not landing — counts a wall that ends on the face and not one that runs through it", () => {
  const r = rig();
  const face = { c: ft(10), lo: ft(0), hi: ft(20), w: 1, length: ft(20), parts: [[ft(0), ft(20)]] as Array<[number, number]>, idx: [0] };
  const ends = { c: ft(5), lo: ft(10), hi: ft(18), w: 3, length: ft(8), parts: [[ft(10), ft(18)]] as Array<[number, number]>, idx: [1] };
  const through = { c: ft(15), lo: ft(2), hi: ft(18), w: 3, length: ft(16), parts: [[ft(2), ft(18)]] as Array<[number, number]>, idx: [2] };
  assert.deepEqual(junctionsAndCrossings(face, [ends], ft(0.4), ft(0.5)), { j: 1, x: 0 });
  assert.deepEqual(junctionsAndCrossings(face, [through], ft(0.4), ft(0.5)), { j: 0, x: 1 });
});

/** a room bounded by two heavy shell walls, split by a HAIRLINE partition
 *  that both shell runs stop dead against */
function partitionPlan() {
  const r = rig();
  // shell: top and bottom, each drawn in two pieces meeting at the partition
  r.line(ft(0), ft(0), ft(12), ft(0), 5);
  r.line(ft(12), ft(0), ft(24), ft(0), 5);
  r.line(ft(0), ft(20), ft(12), ft(20), 5);
  r.line(ft(12), ft(20), ft(24), ft(20), 5);
  r.line(ft(0), ft(0), ft(0), ft(20), 5);          // left shell
  r.line(ft(24), ft(0), ft(24), ft(20), 5);        // right shell
  const part = r.line(ft(12), ft(0), ft(12), ft(20), 1);  // the hairline partition
  return { r, part };
}

test("networkWallSegs — the verdict the mask consumes — vouches for a hairline partition the shell terminates on", () => {
  const { r, part } = partitionPlan();
  const v = networkWallSegs(r.segs, r.metaArr(), 1, PPF);
  assert.equal(v[part], 1);
});

test("networkWallSegs — the verdict the mask consumes — refuses a hairline course that crosses the room instead of meeting it", () => {
  const { r } = partitionPlan();
  const crossing = r.line(ft(-4), ft(10), ft(28), ft(10), 1);   // runs past both shells
  const v = networkWallSegs(r.segs, r.metaArr(), 1, PPF);
  assert.equal(v[crossing], 0);
});

test("networkWallSegs — the verdict the mask consumes — refuses the interior courses of a hatch field inside the room", () => {
  const { r } = partitionPlan();
  const hatch: number[] = [];
  for (let i = 1; i <= 12; i++) hatch.push(r.line(ft(i * 0.75), ft(1), ft(i * 0.75), ft(19), 1));
  const v = networkWallSegs(r.segs, r.metaArr(), 1, PPF);
  const vouchedHatch = hatch.filter((i) => v[i]).length;
  assert.equal(vouchedHatch, 0);
});

test("networkWallSegs — the verdict the mask consumes — still vouches for the partition with a hatch field in the room", () => {
  const { r, part } = partitionPlan();
  for (let i = 1; i <= 12; i++) r.line(ft(i * 0.75), ft(1), ft(i * 0.75), ft(19), 1);
  assert.equal(networkWallSegs(r.segs, r.metaArr(), 1, PPF)[part], 1);
});

test("networkWallSegs — the verdict the mask consumes — is inert on a payload with no linework, and on unknown scale still answers", () => {
  assert.equal(networkWallSegs([], null, 1, 0).length, 0);
  const { r, part } = partitionPlan();
  assert.notEqual(networkWallSegs(r.segs, r.metaArr(), 1, 0)[part], undefined);
});

test("networkWallSegs — the verdict the mask consumes — mirrors oneclick's meta bits — clip-only ink never bounds anything", () => {
  assert.equal(SEG_CLIP, 2);
  assert.equal(SEG_FILLONLY, 4);
  const { r } = partitionPlan();
  const clip = r.line(ft(6), ft(0), ft(6), ft(20), 5, SEG_CLIP);
  assert.equal(networkWallSegs(r.segs, r.metaArr(), 1, PPF)[clip], 0);
});

test("a face ON the hatch rhythm is refused even with junctions — the limit, measured", () => {
  // A partition sitting exactly on the field's own pitch is indistinguishable
  // from a course by rhythm, and the lattice test refuses it. This is the
  // mechanism's known ceiling, not a bug: crediting it would readmit the whole
  // field (the same trade the JS hatch classifier makes from the other side).
  const r = rig();
  r.line(ft(0), ft(0), ft(12), ft(0), 5);
  r.line(ft(12), ft(0), ft(24), ft(0), 5);
  r.line(ft(0), ft(20), ft(12), ft(20), 5);
  r.line(ft(12), ft(20), ft(24), ft(20), 5);
  r.line(ft(0), ft(0), ft(0), ft(20), 5);
  r.line(ft(24), ft(0), ft(24), ft(20), 5);
  const part = r.line(ft(12), ft(0), ft(12), ft(20), 1);
  for (let x = 0.75; x <= 23.25; x += 0.75) {
    if (Math.abs(x - 12) < 0.01) continue;
    r.line(ft(x), ft(0), ft(x), ft(20), 1);
  }
  assert.equal(networkWallSegs(r.segs, r.metaArr(), 1, PPF)[part], 0);
});

test("a hatched room ENDING at the partition still vouches for it — the extremal case", () => {
  // the realistic version of the same plan: the hatch stops at the wall, so the
  // wall has family on one side only, stays off the lattice, and the shell
  // terminating on it carries the verdict
  const r = rig();
  r.line(ft(0), ft(0), ft(12), ft(0), 5);
  r.line(ft(12), ft(0), ft(24), ft(0), 5);
  r.line(ft(0), ft(20), ft(12), ft(20), 5);
  r.line(ft(12), ft(20), ft(24), ft(20), 5);
  r.line(ft(0), ft(0), ft(0), ft(20), 5);
  r.line(ft(24), ft(0), ft(24), ft(20), 5);
  const part = r.line(ft(12), ft(0), ft(12), ft(20), 1);
  for (let x = 0.75; x <= 11.25; x += 0.75) r.line(ft(x), ft(0.5), ft(x), ft(19.5), 1);
  assert.equal(networkWallSegs(r.segs, r.metaArr(), 1, PPF)[part], 1);
});
