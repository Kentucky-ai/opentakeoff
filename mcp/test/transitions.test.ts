// The shared-boundary geometry behind derive_transitions (#202).
//
// The whole tool turns on one distinction, so that is what this pins: two rings
// that TOUCH are a butt joint and become a transition; two rings a wall apart
// are adjacent rooms whose transition is a threshold in a doorway nobody can
// see from the trace record, and must not become one. Getting it wrong in
// either direction ships a wrong number —
//   butt read as wall  → the transition is silently missing from the bid
//   wall read as butt  → 34 LF of threshold appears where a wall is
import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedRuns, sampleRing, distToRing, type Pt } from "../../web/src/lib/transitions.ts";

// 100 px per foot keeps the arithmetic readable: 1" = 8.333 px.
const PPF = 100;
const IN = PPF / 12;
const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

const OPTS = { step_px: PPF * 0.25, touch_px: IN, max_gap_px: IN * 12, min_len_px: PPF };

test("sampleRing walks the whole closed boundary, corners included", () => {
  const pts = sampleRing(rect(0, 0, 400, 400), 100);
  assert.equal(pts.length, 16, "4 sides x 4 samples");
  // the ring closes: the last sample is one step from the first vertex
  assert.deepEqual(pts[0], [0, 0]);
  assert.deepEqual(pts[12], [0, 400]);
});

test("distToRing measures to the BOUNDARY, not the interior", () => {
  const r = rect(0, 0, 100, 100);
  assert.equal(distToRing([50, 50], r), 50, "dead centre is 50 from every wall");
  assert.equal(distToRing([50, 0], r), 0, "a point on the boundary is 0");
  assert.equal(distToRing([50, -10], r), 10, "outside measures in");
});

test("BUTT JOINT: two rooms sharing an edge inside one open space", () => {
  // carpet 0..600, tile 600..1200 — one lobby, no wall, 4 ft of shared edge
  const a = rect(0, 0, 600, 400);
  const b = rect(600, 0, 1200, 400);
  const runs = sharedRuns(a, b, OPTS);
  assert.equal(runs.length, 1, "one shared run");
  assert.equal(runs[0].kind, "butt");
  assert.ok(runs[0].gap_px <= IN, `gap ${runs[0].gap_px} within an inch`);
  // the shared edge is 400 px = 4 ft; sampling lands within a step of it
  assert.ok(Math.abs(runs[0].length_px - 400) <= OPTS.step_px * 2,
    `run length ${runs[0].length_px} ≈ 400`);
  assert.deepEqual(runs[0].at.map(Math.round), [600, 200], "midpoint sits on the joint");
});

test("WALL-SEPARATED: the same two rooms across a 6\" partition", () => {
  const a = rect(0, 0, 600, 400);
  const b = rect(600 + IN * 6, 0, 1200, 400);   // 6" of wall between them
  const runs = sharedRuns(a, b, OPTS);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].kind, "wall", "a partition is NOT a butt joint");
  const gapIn = runs[0].gap_px / IN;
  assert.ok(Math.abs(gapIn - 6) < 0.5, `median gap ${gapIn}" ≈ 6"`);
});

test("a wall thicker than max_gap_in is not adjacency at all", () => {
  const a = rect(0, 0, 600, 400);
  const b = rect(600 + IN * 18, 0, 1200, 400);   // 18" apart, max is 12"
  assert.deepEqual(sharedRuns(a, b, OPTS), []);
});

test("rooms that only clip at a corner produce no run", () => {
  // Touching at one point: real on a plan, never a transition. Distance alone
  // does not reject this — A's right wall runs within a foot of B's corner for
  // two feet — so it is the perpendicularity rule that has to, and this is the
  // case that proves it: A heads STRAIGHT AT the corner it is close to.
  const a = rect(0, 0, 400, 400);
  const b = rect(400, 400, 800, 800);
  assert.deepEqual(sharedRuns(a, b, OPTS), [], "pointing at a corner is not running alongside it");
});

test("ONE median outlier does not turn a wall into a butt joint", () => {
  // the reason the kind is decided on the MEDIAN and not the mean: two rooms
  // across a partition whose corners pinch together at one end would average
  // their way under the touch threshold and commit a phantom transition.
  const a = rect(0, 0, 600, 400);
  const b: Pt[] = [[600 + IN * 6, 0], [1200, 0], [1200, 400], [600, 400]];   // splays from touching to 6"
  const runs = sharedRuns(a, b, OPTS);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].kind, "wall", "most of the run is a wall, so the run is a wall");
});

test("a run that wraps the ring's start vertex is ONE run, not two", () => {
  // ring A starts at its top-left corner; B hugs the left AND top walls, so a
  // naive scan reports the head and tail of the sample list separately — and
  // an estimator gets "a 3 LF and a 9 LF transition" on one piece of floor.
  const a = rect(0, 0, 400, 400);
  const b: Pt[] = [[-200, -200], [400, -200], [400, 0], [0, 0], [0, 400], [-200, 400]];
  const runs = sharedRuns(a, b, OPTS);
  assert.equal(runs.length, 1, "stitched back together across the seam");
  assert.equal(runs[0].kind, "butt");
  assert.ok(runs[0].length_px > 700, `${runs[0].length_px} px covers both walls, not one`);
});

test("a shared edge at awkward coordinates stays ONE run (the coincidence epsilon)", () => {
  // Found by driving a real sheet, not by reasoning: rings that share an edge
  // project onto each other at ~1e-16, not 0. At that magnitude the direction
  // vector is rounding noise and its angle to the tangent is random, so an
  // exact `=== 0` coincidence test rejected a scattering of samples along a
  // perfectly good joint — a 13.2 ft butt joint came back as 1.25 + 1.99 +
  // 7.47. The fixtures above missed it because their coordinates project
  // exactly; these deliberately do not.
  const a: Pt[] = [[6.8123, 8.8071], [20.4137, 8.8071], [20.4137, 22.0019], [6.8123, 22.0019]];
  const b: Pt[] = [[20.4137, 8.8071], [34.0091, 8.8071], [34.0091, 22.0019], [20.4137, 22.0019]];
  const opts = { step_px: 0.25, touch_px: 1 / 12, max_gap_px: 1, min_len_px: 1 };
  const runs = sharedRuns(a, b, opts);
  assert.equal(runs.length, 1, `one joint, not fragments (got ${runs.map((r) => r.length_px.toFixed(2)).join(" + ")})`);
  assert.equal(runs[0].kind, "butt");
  const shared = 22.0019 - 8.8071;
  assert.ok(Math.abs(runs[0].length_px - shared) <= opts.step_px * 2,
    `${runs[0].length_px.toFixed(2)} ≈ ${shared.toFixed(2)} — the WHOLE shared edge`);
});

test("degenerate rings are ignored rather than throwing", () => {
  assert.deepEqual(sharedRuns([[0, 0], [1, 1]] as Pt[], rect(0, 0, 10, 10), OPTS), []);
  assert.deepEqual(sharedRuns(rect(0, 0, 10, 10), [] as Pt[], OPTS), []);
});

test("ENDPOINT REFINEMENT: a partial joint whose ends fall between samples measures full length", () => {
  // A 100 px joint from y=107 to y=207 on A's right edge, sampled every 25 px:
  // only y=125..200 pass the alongside test, so the samples alone measure
  // 75 px — and a 100 px min_len gate silently drops a real transition.
  // Refinement bisects each open end toward its rejected neighbour and finds
  // the true endpoints at y=107 and y=207.
  const a = rect(0, 0, 100, 400);
  const b = rect(100, 107, 200, 207);
  const runs = sharedRuns(a, b, { step_px: 25, touch_px: 1, max_gap_px: 12, min_len_px: 99 });
  assert.equal(runs.length, 1, "the partial joint survives");
  assert.equal(runs[0].kind, "butt");
  assert.ok(Math.abs(runs[0].length_px - 100) < 0.01,
    `run length ${runs[0].length_px} ≈ 100 (samples alone measured 75)`);
  // the refined endpoints bound the true interval
  const ys = runs[0].path.map((p) => p[1]);
  assert.ok(Math.abs(Math.min(...ys) - 107) < 0.01, `head refined to y=107, got ${Math.min(...ys)}`);
  assert.ok(Math.abs(Math.max(...ys) - 207) < 0.01, `tail refined to y=207, got ${Math.max(...ys)}`);
});

test("ENDPOINT REFINEMENT: an aligned joint is unchanged — refinement adds no phantom length", () => {
  // B's edge endpoints land exactly on A's samples; the bisection converges to
  // the samples themselves and the path gains nothing.
  const a = rect(0, 0, 100, 400);
  const b = rect(100, 100, 200, 200);
  const runs = sharedRuns(a, b, { step_px: 25, touch_px: 1, max_gap_px: 12, min_len_px: 50 });
  assert.equal(runs.length, 1);
  assert.ok(Math.abs(runs[0].length_px - 100) < 0.01,
    `aligned run stays ${runs[0].length_px} ≈ 100`);
});
