// #293 — one instance, one row. The proposal dedupe keeps walking semantics
// (an entry follows the best-scoring proposal of its neighborhood), and the
// walk could end with two entries on the same peak: each walker absorbed its
// own chain, and nothing re-checked the pairwise invariant after a move.
// Measured on a real plumbing sheet as one floor drain committed twice —
// matches 0.2 px apart at 0.921 and 0.925, stacked into what renders as a
// single ×, ea_total one high with a machine's confidence behind it.
//
// The failure is a property of proposal ORDER, not of any particular ink —
// which is why the drawn-ink fixtures never tripped it and why the mechanism
// test drives `mergeProposals` directly with the choreographed chain. The
// sweep-level tests then lock the invariant on geometry, including the case
// the first fix attempt got wrong: ADJACENT real instances (a ceiling grid's
// abutting tiles) sit closer than half a symbol diagonal and must all count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepSymbols, mergeProposals } from "../src/lib/symbolsweep.ts";

const P = (x: number, y: number, score: number, xf = 0) =>
  ({ at: [x, y] as [number, number], score, xf, rotation: 0, mirrored: false });

test("mergeProposals: a migration chain cannot leave two entries on one peak (#293)", () => {
  // The choreography that reproduces the measured pair. mergeR = 4:
  //   A (0,0)   0.930  → seeds walker K1
  //   D (7.6,0) 0.926  → 7.6 px from K1: seeds walker K2
  //   B (3.8,0) 0.940  → within 4 of K1: K1 walks to 3.8
  //   C (7.4,0) 0.950  → within 4 of K1 (3.6 away): K1 walks to 7.4
  // Old behavior: K1 ends at (7.4, 0.950) and K2 at (7.6, 0.926) — 0.2 px
  // apart, both above the commit bar, one drain counted twice.
  const out = mergeProposals([P(0, 0, 0.93), P(7.6, 0, 0.926), P(3.8, 0, 0.94), P(7.4, 0, 0.95)], 4);
  assert.equal(out.length, 1, `one physical peak, one entry — got ${out.length}`);
  assert.equal(out[0].score, 0.95, "and the entry is the peak's best reading");

  // Distinct placements beyond the radius are never collapsed.
  const two = mergeProposals([P(0, 0, 0.95), P(30, 0, 0.93)], 4);
  assert.equal(two.length, 2);

  // Determinism: score tie breaks to the earliest transform, then position.
  const tie = mergeProposals([P(0, 0, 0.95, 3), P(1, 0, 0.95, 1)], 4);
  assert.equal(tie[0].xf, 1);
});

test("mergeProposals invariant: every output pair is separated by more than mergeR (#293)", () => {
  // A plateau chain along a line — the worst case for walkers.
  const chain = Array.from({ length: 20 }, (_, i) => P(i * 3, 0, 0.9 + i * 0.001));
  for (const mergeR of [4, 6, 8]) {
    const out = mergeProposals(chain, mergeR);
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const d = Math.hypot(out[i].at[0] - out[j].at[0], out[i].at[1] - out[j].at[1]);
        assert.ok(d > mergeR, `entries ${i},${j} are ${d.toFixed(1)} px apart at mergeR ${mergeR}`);
      }
    }
  }
});

// ── sweep-level: the invariant holds on ink, and adjacency survives ─────────
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
// A drain the way real plumbing sheets draw one: a 24-gon "circle" (radius
// 12) plus a cross — 26 short segments, dozens of usable anchor pairs.
const DRAIN: [number, number, number, number][] = [];
for (let i = 0; i < 24; i++) {
  const a = (i / 24) * 2 * Math.PI, b = ((i + 1) / 24) * 2 * Math.PI;
  DRAIN.push([12 * Math.cos(a), 12 * Math.sin(a), 12 * Math.cos(b), 12 * Math.sin(b)]);
}
DRAIN.push([-8, 0, 8, 0], [0, -8, 0, 8]);

test("dense jittered instances each count exactly once, matches pairwise separated by more than mergeR (#293)", () => {
  const rnd = lcg(293);
  const segs: number[] = [];
  const place = (ox: number, oy: number, jitter = 0) => {
    for (const [ax, ay, bx, by] of DRAIN) {
      const j = () => (rnd() - 0.5) * 2 * jitter;
      segs.push(ax + ox + j(), ay + oy + j(), bx + ox + j(), by + oy + j());
    }
  };
  place(100, 100);                          // the seed — clean
  const instances: [number, number][] = [[300, 100], [500, 100], [100, 300], [300, 300], [500, 300]];
  for (const [x, y] of instances) place(x, y, 0.8);   // drafting jitter inside tol 2

  const res = sweepSymbols(segs, [[86, 86], [114, 114]]);
  for (const [x, y] of instances) {
    assert.ok(res.matches.some((m) => Math.hypot(m.at[0] - x, m.at[1] - y) < 8), `the instance at ${x},${y} is counted`);
  }
  assert.equal(res.matches.length, instances.length, "one row per drawn instance");
  for (let i = 0; i < res.matches.length; i++) {
    for (let j = i + 1; j < res.matches.length; j++) {
      const d = Math.hypot(res.matches[i].at[0] - res.matches[j].at[0], res.matches[i].at[1] - res.matches[j].at[1]);
      assert.ok(d > 4, `rows ${i} and ${j} are ${d.toFixed(1)} px apart — one instance, two rows`);
    }
  }
});

test("adjacent REAL instances are not swallowed: abutting tiles all count (#293 first-attempt regression)", () => {
  // A 2×4 tile lattice: neighbors sit exactly one tile-height apart — CLOSER
  // than half the symbol diagonal, which is why the coalesce radius must be
  // mergeR and never suppressR. An estimator counting a tiled symbol must get
  // every tile.
  const TW = 50, TH = 25;
  const segs: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const x = c * TW, y = r * TH;
    segs.push(x, y, x + TW, y, x + TW, y, x + TW, y + TH, x + TW, y + TH, x, y + TH, x, y + TH, x, y);
    segs.push(x, y, x + TW, y + TH);        // a diagonal so the tile isn't a bare rect
  }
  // Orientation pinned: on a lattice, rotation/mirror freedom mints extra
  // legitimate readings off the shared edges (the phantom phenomenon the
  // crossing-mode counter-example exists for) — this test is about adjacency
  // spacing, not about those. The seed's own orthogonal neighbors sit inside
  // the seed-shadow radius and may be suppressed — that is the pre-existing
  // excludeCenter behavior, not this fix — so the assertion is on the SIX
  // far tiles, which include vertical pairs 25 px apart: closer than half
  // the symbol diagonal (~28), exactly the spacing a suppressR-radius
  // coalesce (the first fix attempt) wrongly halved.
  const res = sweepSymbols(segs, [[-2, -2], [TW + 2, TH + 2]], { rotations: false, mirror: false });
  const far: [number, number][] = [[2, 0], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]];
  for (const [c, r] of far) {
    const cx = c * TW + TW / 2, cy = r * TH + TH / 2;
    assert.ok(res.matches.some((m) => Math.hypot(m.at[0] - cx, m.at[1] - cy) < 8),
      `the tile at column ${c}, row ${r} is counted — adjacency must survive the coalesce`);
  }
});
