// Counter-examples for symbol_sweep (#259, reported by @FrankAtGHub): "match
// these, but not those". Two mechanics, one gesture — the caller drags a box
// around the thing it does not mean and the rect's own contents decide which
// applies:
//
//   SHAPE — the lookalike carries EXTRA linework (the square around a flush
//   floor outlet, the letter inside a keynote triangle). Local evidence, so it
//   fingerprints like a positive.
//
//   CROSSING — the lookalike carries no extra contained linework; what marks
//   it is a line running THROUGH it. `fingerprintSymbol` admits fully-inside
//   segments only, so this is structurally inexpressible as a contained
//   fingerprint — background structure is long by nature. The reported case: a
//   2×4 fixture on a 2 ft ceiling grid, where two empty tiles reproduce the
//   fixture's outline exactly, and the only difference is that the empty tile
//   still has the grid line running through its middle while the real fixture,
//   drawn over the grid, breaks it.
//
// Both are synthetic reproductions of the reported cases, not the reported
// sheets. Every rejection must come back DISCLOSED: which negative, what it
// saw, and enough to reinstate it by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepSymbols, buildNegative, fingerprintSymbol, EXCLUDE_EVIDENCE_BAR } from "../src/lib/symbolsweep.ts";
import type { Point } from "../src/lib/oneclick.ts";

type Seg = [number, number, number, number];
const push = (segs: number[], s: Seg[], ox = 0, oy = 0) => {
  for (const [ax, ay, bx, by] of s) segs.push(ax + ox, ay + oy, bx + ox, by + oy);
};
const rect = (x: number, y: number, w: number, h: number): Seg[] => [
  [x, y, x + w, y], [x + w, y, x + w, y + h], [x + w, y + h, x, y + h], [x, y + h, x, y],
];
// the wall-mount device: a plain triangle, 24 px across
const TRI: Seg[] = [[0, 20, 12, 0], [12, 0, 24, 20], [24, 20, 0, 20]];
// the flush-floor variant: the SAME triangle inside a square — it CONTAINS the
// wall symbol by drafting convention, so it matches on every sheet
const BOX: Seg[] = rect(-4, -4, 32, 28);

test("shape mode: the flush variant's box rejects it, and every wall-mount survives", () => {
  const segs: number[] = [];
  const wall: [number, number][] = [[0, 0], [100, 0], [200, 0], [0, 100]];
  const flush: [number, number][] = [[100, 100], [200, 100], [0, 200]];
  for (const [x, y] of wall) push(segs, TRI, x, y);
  for (const [x, y] of flush) { push(segs, TRI, x, y); push(segs, BOX, x, y); }

  const seed: [Point, Point] = [[-2, -2], [26, 22]];            // the bare triangle at the origin
  const plain = sweepSymbols(segs, seed);
  assert.equal(plain.matches.length, wall.length - 1 + flush.length,
    "without a counter-example the flush variants count as wall mounts — the bug being reported");
  assert.deepEqual(plain.rejected, [], "and nothing is rejected, because nothing was excluded");

  const neg: [Point, Point] = [[95, 95], [133, 129]];           // a tight box around ONE flush instance
  const res = sweepSymbols(segs, seed, { exclude: [neg] });
  assert.equal(res.matches.length, wall.length - 1, "only the other wall mounts are counted");
  assert.equal(res.rejected.length, flush.length, "every flush variant is rejected, including the one marqueed");
  assert.equal(res.negatives?.[0]?.mode, "shape", "the rect's contents chose the mechanic, not the caller");

  const r = res.rejected[0];
  assert.equal(r.by, 0, "which counter-example did it");
  assert.ok(r.evidence >= EXCLUDE_EVIDENCE_BAR, "how much of its evidence was found");
  assert.ok(r.score >= 0.92, "and the geometry score it would have committed at");
  assert.match(r.reason, /explains this placement at least as well/);
  // reinstatable without a re-run: a rejection carries a full placement
  for (const [fx, fy] of flush) {
    assert.ok(res.rejected.some((q) => Math.abs(q.at[0] - (fx + 12)) < 6 && Math.abs(q.at[1] - (fy + 13)) < 6),
      `the flush instance at ${fx},${fy} is named`);
  }
});

// ── crossing ───────────────────────────────────────────────────────────────
// A ceiling grid drawn tile by tile — each 2×4 tile a closed rectangle — plus
// the main runner drawn as a long line down the middle of each tile row. A 2×4
// fixture is the same rectangle as a tile, so its outline is reproducible from
// an empty tile and nothing contained tells them apart. The difference is the
// runner: it passes through an empty tile unbroken, and the fixture, drawn
// over it, breaks it. That is the discriminator no contained fingerprint can
// express — the runner is 300 px long and can never sit inside a symbol-sized
// rect.
const TW = 50.4, TH = 25.2, COLS = 6, ROWS = 5;
function ceilingSheet(fixtures: [number, number][]) {
  const segs: number[] = [];
  const has = new Set(fixtures.map(([c, r]) => `${c},${r}`));
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) push(segs, rect(c * TW, r * TH, TW, TH));
    // the runner: one long line per row, broken where a fixture covers it
    const y = r * TH + TH / 2;
    let x = 0;
    for (let c = 0; c < COLS; c++) {
      if (!has.has(`${c},${r}`)) continue;
      if (c * TW > x) push(segs, [[x, y, c * TW, y]]);
      x = (c + 1) * TW;
    }
    if (x < COLS * TW) push(segs, [[x, y, COLS * TW, y]]);
  }
  // A fixture IS its tile's rectangle — the outline the drafter reused. What
  // marks it is the runner it broke, which is the entire point.
  return segs;
}

test("crossing mode: an empty tile's unbroken runner rejects the phantom, the real fixtures stand", () => {
  const fixtures: [number, number][] = [[0, 0], [3, 1], [1, 3], [4, 4]];
  const segs = ceilingSheet(fixtures);
  const seed: [Point, Point] = [[-1, -1], [TW + 1, TH + 1]];    // the fixture on tile (0,0)

  const plain = sweepSymbols(segs, seed);
  assert.ok(plain.matches.length > 10 * fixtures.length,
    `without a counter-example every empty tile counts (${plain.matches.length} placements for ${fixtures.length} fixtures)`);

  // marquee ONE empty tile — nothing extra inside it, just the runner through
  const ex = 2 * TW, ey = 2 * TH;
  const neg: [Point, Point] = [[ex - 1, ey - 1], [ex + TW + 1, ey + TH + 1]];
  const res = sweepSymbols(segs, seed, { exclude: [neg] });
  assert.equal(res.negatives?.[0]?.mode, "crossing",
    "no extra contained linework, so the rect reads as the line passing through it");
  assert.ok(res.rejected.length > 0, "and the phantoms are rejected, not silently dropped");
  for (const r of res.rejected) assert.equal(r.mode, "crossing");
  assert.match(res.rejected[0].reason, /UNBROKEN/);

  // A lattice of identical rectangles is the most symmetric sheet there is, so
  // one fixture can be proposed at several near-centroids — the count to check
  // is not the placement count but WHERE the survivors are.
  const onFixture = (p: Point) => fixtures.some(([c, r]) =>
    Math.hypot(p[0] - (c * TW + TW / 2), p[1] - (r * TH + TH / 2)) < TH / 2);
  for (const m of res.matches) assert.ok(onFixture(m.at), `every surviving match sits on a real fixture (${m.at})`);
  for (const [c, r] of fixtures.slice(1)) {
    const cx = c * TW + TW / 2, cy = r * TH + TH / 2;
    assert.ok(res.matches.some((m) => Math.hypot(m.at[0] - cx, m.at[1] - cy) < TH / 2),
      `the fixture on tile ${c},${r} is still counted`);
  }
  // the acceptance criterion from the report: zero true fixtures rejected
  for (const [c, r] of fixtures) {
    assert.ok(!res.rejected.some((q) => Math.hypot(q.at[0] - (c * TW + TW / 2), q.at[1] - (r * TH + TH / 2)) < TH / 2),
      `the real fixture on tile ${c},${r} is not rejected`);
  }
  assert.ok(res.matches.length < plain.matches.length / 5,
    `and the phantom count collapses (${plain.matches.length} → ${res.matches.length})`);
});

test("a counter-example that holds no instance of the positive is refused, not guessed at", () => {
  const segs: number[] = [];
  push(segs, TRI, 0, 0);
  push(segs, TRI, 100, 0);
  const fp = fingerprintSymbol(segs, [[-2, -2], [26, 22]]);
  assert.equal(buildNegative(fp, segs, [[400, 400], [460, 440]], {}), null, "empty rect → nothing to read");
  // and the sweep says so rather than silently sweeping unexcluded
  const res = sweepSymbols(segs, [[-2, -2], [26, 22]], { exclude: [[[400, 400], [460, 440]]] });
  assert.deepEqual(res.negatives, [null], "a negative that read as nothing is reported as nothing");
  assert.equal(res.matches.length, 1, "and the sweep is exactly what it would have been");
  assert.deepEqual(res.rejected, []);
});

test("a counter-example identical to the positive rejects nothing (it carries no discriminator)", () => {
  const segs: number[] = [];
  for (const x of [0, 100, 200]) push(segs, TRI, x, 0);
  const res = sweepSymbols(segs, [[-2, -2], [26, 22]], { exclude: [[[98, -2], [126, 22]]] });
  assert.deepEqual(res.negatives, [null], "nothing distinguishes it, so it is not a counter-example");
  assert.equal(res.matches.length, 2, "and every real instance still counts");
});
