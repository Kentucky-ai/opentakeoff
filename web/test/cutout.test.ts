// Real polygon boolean subtraction behind the Cut Out tool (#137) —
// lib/cutout.js. Boundary-math cases: a square room with a square hole (the
// core case), a hole that touches the room's edge (a notch, not an interior
// ring), compose against an already-holed parent, overlap that must never
// double-deduct, the delete-one-of-several rebuild (recomposeCutouts), and
// the ambiguous/degenerate cases that must fall back to the legacy
// independent-shape path rather than guess. No browser, no pdf.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findCutoutParent, subtractCutout, recomposeCutouts, clipRunOutside, cutRun, cutRunsAcross } from "../src/lib/cutout.js";
import { polyWithHolesMetrics, closedMetrics, openLen } from "../src/lib/geometry.js";

const approx = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

// 100×100 square, [0,0]..[100,100] — open ring (no repeated closing vertex).
const SQUARE = [[0, 0], [100, 0], [100, 100], [0, 100]];
const FAR_SQUARE = [[500, 500], [600, 500], [600, 600], [500, 600]];

test("subtractCutout: square hole fully inside — area nets, perimeter ADDS the hole boundary", () => {
  const hole = [[40, 40], [60, 40], [60, 60], [40, 60]];   // 20×20 = 400
  const r = subtractCutout(SQUARE, [], hole);
  assert.ok(r);
  assert.ok(approx(r.area, 10000 - 400), `area ${r.area}`);
  assert.ok(approx(r.perim, 400 + 80), `perim ${r.perim}`);
  assert.equal(r.holes.length, 1);
  const outerAlone = closedMetrics(r.outer);
  assert.ok(approx(outerAlone.area, 10000) && approx(outerAlone.perim, 400), "outer ring untouched by an interior hole");
});

test("subtractCutout: edge-touching cut bites the OUTER ring — only the overlap is removed", () => {
  const hole = [[90, 40], [110, 40], [110, 60], [90, 60]];   // half inside
  const r = subtractCutout(SQUARE, [], hole);
  assert.ok(r);
  assert.ok(approx(r.area, 10000 - 200), `only the overlapping 10×20 sliver removed, got ${r.area}`);
  assert.equal(r.holes.length, 0, "a notch, not a floating interior ring");
  assert.ok(r.outer.length > SQUARE.length, "outer ring gained vertices for the notch");
});

test("subtractCutout: degenerate results bail to null (caller falls back to the legacy path)", () => {
  const covers = [[-10, -10], [110, -10], [110, 110], [-10, 110]];
  assert.equal(subtractCutout(SQUARE, [], covers), null, "erasing the whole parent");
  const bisects = [[-10, 45], [110, 45], [110, 55], [-10, 55]];
  assert.equal(subtractCutout(SQUARE, [], bisects), null, "splitting the parent (MultiPolygon)");
});

test("subtractCutout: composes against a parent that already carries a hole", () => {
  const first = subtractCutout(SQUARE, [], [[10, 10], [20, 10], [20, 20], [10, 20]]);
  assert.ok(first);
  const second = subtractCutout(first.outer, first.holes, [[70, 70], [80, 70], [80, 80], [70, 80]]);
  assert.ok(second);
  assert.equal(second.holes.length, 2, "both holes present");
  assert.ok(approx(second.area, 10000 - 100 - 100), "both cuts net out");
});

test("subtractCutout: overlapping second cut never double-deducts the shared area", () => {
  const first = subtractCutout(SQUARE, [], [[40, 40], [60, 40], [60, 60], [40, 60]]);   // 400 out
  assert.ok(first);
  // overlaps the first hole's right half: 400 gross, 200 already inside hole #1
  const second = subtractCutout(first.outer, first.holes, [[50, 40], [70, 40], [70, 60], [50, 60]]);
  assert.ok(second);
  assert.ok(approx(second.area, 10000 - 400 - 200), `union (600) not sum (800), got ${second.area}`);
  assert.equal(second.holes.length, 1, "overlapping cuts merged into ONE hole ring");
  // a cut fully INSIDE an existing hole is a no-op on the parent, not a failure
  const inside = subtractCutout(second.outer, second.holes, [[45, 45], [55, 45], [55, 55], [45, 55]]);
  assert.ok(inside && approx(inside.area, second.area), "swallowed cut resolves with zero net change");
});

test("findCutoutParent: unique / none / ambiguous", () => {
  const hole = [[40, 40], [60, 40], [60, 60], [40, 60]];
  assert.equal(findCutoutParent([{ id: "p1", ringPx: SQUARE }], hole), "p1");
  assert.equal(findCutoutParent([{ id: "far", ringPx: FAR_SQUARE }], hole), null);
  assert.equal(findCutoutParent([], hole), null);
  assert.equal(findCutoutParent([{ id: "p1", ringPx: SQUARE }, { id: "p2", ringPx: SQUARE }], hole), null,
    "two touching candidates → ambiguous, caller keeps the independent-shape path");
  const edgeHole = [[90, 40], [110, 40], [110, 60], [90, 60]];
  assert.equal(findCutoutParent([{ id: "p1", ringPx: SQUARE }], edgeHole), "p1", "partial edge overlap still resolves");
});

test("polyWithHolesMetrics: matches subtractCutout's math; no holes = closedMetrics", () => {
  const hole = [[40, 40], [60, 40], [60, 60], [40, 60]];
  const m = polyWithHolesMetrics(SQUARE, [hole]);
  assert.ok(approx(m.area, 9600) && approx(m.perim, 480));
  const none = polyWithHolesMetrics(SQUARE, []);
  assert.ok(approx(none.area, 10000) && approx(none.perim, 400));
});

test("recomposeCutouts: rebuilding a parent after one cut in a chain is deleted", () => {
  const h1 = [[10, 10], [20, 10], [20, 20], [10, 20]];   // 100
  const h2 = [[70, 70], [80, 70], [80, 80], [70, 80]];   // 100
  // delete cut #1: pristine base minus the SURVIVING h2 only
  const r = recomposeCutouts(SQUARE, [], [h2]);
  assert.ok(r);
  assert.ok(approx(r.area, 10000 - 100), `only the surviving cut nets out, got ${r.area}`);
  assert.equal(r.holes.length, 1);
  // deleting the LAST cut of the chain: zero surviving rings → the base itself
  const none = recomposeCutouts(SQUARE, [], []);
  assert.ok(none && approx(none.area, 10000) && none.holes.length === 0);
  // three-cut chain, middle one deleted — both survivors re-subtract in order
  const h3 = [[40, 40], [50, 40], [50, 50], [40, 50]];   // 100
  const r3 = recomposeCutouts(SQUARE, [], [h1, h3]);
  assert.ok(r3 && approx(r3.area, 10000 - 200) && r3.holes.length === 2);
  // a surviving cut that bisects the base degenerates → null (caller falls
  // back to a plain delete; NEVER restores the pristine base over survivors)
  const bisects = [[-10, 45], [110, 45], [110, 55], [-10, 55]];
  assert.equal(recomposeCutouts(SQUARE, [], [bisects]), null);
});

// ── the deduct on an OPEN RUN (wall tile is a run × height, not a polygon) ───
const RUN = [[0, 50], [200, 50]];                        // a straight 200-px wall run

test("clipRunOutside: a cut at the end shortens the run", () => {
  const kept = clipRunOutside(RUN, [[150, 30], [260, 30], [260, 70], [150, 70]]);
  assert.equal(kept.length, 1);
  assert.ok(approx(openLen(kept[0]), 150), String(openLen(kept[0])));
});

test("clipRunOutside: a cut through the middle leaves TWO runs, ending ON the ring's edges", () => {
  const kept = clipRunOutside(RUN, [[80, 30], [120, 30], [120, 70], [80, 70]]);
  assert.equal(kept.length, 2);
  assert.ok(approx(openLen(kept[0]), 80) && approx(openLen(kept[1]), 80));
  assert.ok(approx(kept[0][1][0], 80) && approx(kept[1][0][0], 120), "the new ends land on the cut, not at the nearest vertex");
});

test("clipRunOutside: a ring over the whole run leaves nothing; a miss returns it whole", () => {
  assert.equal(clipRunOutside(RUN, [[-10, 30], [210, 30], [210, 70], [-10, 70]]).length, 0);
  const miss = clipRunOutside(RUN, [[0, 300], [50, 300], [50, 350], [0, 350]]);
  assert.equal(miss.length, 1);
  assert.ok(approx(openLen(miss[0]), 200));
});

test("clipRunOutside: cutting the corner out of an L crosses two segments and leaves both legs", () => {
  const L = [[0, 0], [100, 0], [100, 100]];
  const kept = clipRunOutside(L, [[80, -20], [120, -20], [120, 20], [80, 20]]);
  assert.equal(kept.length, 2);
  assert.ok(approx(openLen(kept[0]) + openLen(kept[1]), 160), "40 px of run came off");
});

test("cutRun: names the degenerate cases instead of collapsing them to null", () => {
  assert.equal(cutRun(RUN, [[500, 500], [520, 500], [520, 520], [500, 520]]), null, "no touch");
  assert.equal(cutRun(RUN, [[-10, 30], [210, 30], [210, 70], [-10, 70]])?.kind, "erased");
  const cut = cutRun(RUN, [[80, 30], [120, 30], [120, 70], [80, 70]]);
  assert.equal(cut?.kind, "cut");
  assert.equal(cut?.runs?.length, 2);
  assert.ok(approx(cut?.len ?? 0, 160));
});

test("cutRunsAcross: EVERY run the ring touches is cut — no unambiguous-parent rule", () => {
  const corner = cutRunsAcross([
    { id: "a", runPx: [[0, 50], [200, 50]] },
    { id: "b", runPx: [[100, 0], [100, 200]] },
    { id: "far", runPx: [[0, 900], [200, 900]] },
  ], [[80, 30], [120, 30], [120, 70], [80, 70]]);
  assert.equal(corner.length, 2, "the two crossing runs cut, the far one is not in the gesture");
  assert.deepEqual(corner.map((c) => c.id).sort(), ["a", "b"]);
  assert.ok(corner.every((c) => c.kind === "cut" && c.runs?.length === 2));
});
