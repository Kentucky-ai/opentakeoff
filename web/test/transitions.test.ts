// The canvas-side half of derive_transitions — the layer between sharedRuns'
// pure geometry and a takeoff you can accept.
//
// mcp/test/transitions.test.ts already pins the geometry (butt vs wall, the
// perpendicularity rule, the start-vertex stitch). What is pinned HERE is the
// consequence of that verdict for an estimator: a butt joint comes back as a
// committable linear shape carrying both parents, and a wall-separated run
// comes back in `withheld` and never becomes a shape — because the transition
// across a partition is a threshold in a doorway that nothing in the trace
// record can locate, and 34 LF of it appearing on the bid because two rooms
// share 34 LF of wall is a wrong number with a machine's confidence behind it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveTransitionRuns, transitionRefusal, dropCollinear,
  type SheetFrame, type TransitionSourceShape, type Pt,
} from "../src/lib/transitions.ts";

// 100 px per foot keeps the arithmetic readable: upp = 0.01 ft/px, 1" = 8.333 px.
const PPF = 100, IN = PPF / 12;
const W = 2400, H = 1600;
const SHEET = "plan.pdf#p1";
const sheets = (): Map<string, SheetFrame> => new Map([[SHEET, { widthPx: W, heightPx: H, upp: 1 / PPF }]]);

/** A committed floor shape from a px rectangle, normalized to the sheet frame. */
const room = (id: string, x0: number, y0: number, x1: number, y1: number): TransitionSourceShape => ({
  id, sheet_id: SHEET,
  verts_norm: ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as Pt[]).map(([x, y]) => [x / W, y / H] as [number, number]),
});

const side = (tag: string, shapes: TransitionSourceShape[]) => ({ tag, shapes });

test("BUTT JOINT: the shared edge becomes a committable run with both parents", () => {
  // carpet 0..600, tile 600..1200 — one lobby, no wall, 4 ft of shared edge
  const a = side("C-1", [room("shp-a", 0, 0, 600, 400)]);
  const b = side("T-1", [room("shp-b", 600, 0, 1200, 400)]);
  const { runs, withheld } = deriveTransitionRuns(a, b, sheets());
  assert.equal(withheld.length, 0, "nothing withheld — the rooms touch");
  assert.equal(runs.length, 1);
  const r = runs[0];
  assert.deepEqual(r.between_shape_ids, ["shp-a", "shp-b"], "both parents ride the record");
  assert.deepEqual(r.between, ["C-1", "T-1"]);
  assert.ok(Math.abs(r.length_lf - 4) <= 0.5, `${r.length_lf} LF ≈ the 4 ft edge`);
  assert.ok(r.gap_in <= 1, `gap ${r.gap_in}" is a touch, not a wall`);
  assert.deepEqual(r.at, [600, 200], "midpoint sits on the joint, image px");
  // the geometry comes back ready to be a linear shape's verts_norm
  assert.ok(r.verts_norm.length >= 2);
  for (const [nx, ny] of r.verts_norm) {
    assert.ok(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1, `${nx},${ny} inside the sheet frame`);
    assert.ok(Math.abs(nx - 600 / W) < 1e-9, "a vertical joint stays on x = 600 px");
  }
});

test("WALL-SEPARATED: reported, never counted", () => {
  // the same two rooms across a 6" partition — adjacent, but the transition is
  // a threshold in a doorway the trace record cannot locate
  const a = side("C-1", [room("shp-a", 0, 0, 600, 400)]);
  const b = side("T-1", [room("shp-b", 600 + IN * 6, 0, 1200, 400)]);
  const { runs, withheld } = deriveTransitionRuns(a, b, sheets());
  assert.equal(runs.length, 0, "a partition commits NOTHING");
  assert.equal(withheld.length, 1);
  assert.equal(withheld[0].reason, "wall_separated");
  assert.ok(Math.abs(withheld[0].gap_in - 6) < 0.5, `gap ${withheld[0].gap_in}" ≈ 6"`);
  assert.ok(withheld[0].length_lf > 3, "the estimator is told how much wall it is");
  assert.deepEqual(withheld[0].between, ["C-1", "T-1"]);
});

test("rooms that only clip at a corner are neither committed nor reported", () => {
  const a = side("C-1", [room("shp-a", 0, 0, 400, 400)]);
  const b = side("T-1", [room("shp-b", 400, 400, 800, 800)]);
  const { runs, withheld } = deriveTransitionRuns(a, b, sheets());
  assert.deepEqual(runs, [], "pointing at a corner is not running alongside it");
  assert.deepEqual(withheld, [], "and it is not a question either");
});

test("a sheet with no scale takes no part — a transition is a real length", () => {
  const a = side("C-1", [room("shp-a", 0, 0, 600, 400)]);
  const b = side("T-1", [room("shp-b", 600, 0, 1200, 400)]);
  const unscaled = new Map([[SHEET, { widthPx: W, heightPx: H, upp: 0 }]]);
  assert.deepEqual(deriveTransitionRuns(a, b, unscaled), { runs: [], withheld: [] });
});

test("rooms on different sheets never meet", () => {
  const a = side("C-1", [room("shp-a", 0, 0, 600, 400)]);
  const b = side("T-1", [{ ...room("shp-b", 600, 0, 1200, 400), sheet_id: "plan.pdf#p2" }]);
  const { runs, withheld } = deriveTransitionRuns(a, b, sheets());
  assert.deepEqual([runs, withheld], [[], []]);
});

test("dropCollinear keeps the corners and drops the walk", () => {
  // a quarter-foot walk down a straight 4 ft edge: 17 samples, 2 real ends
  const straight: Pt[] = Array.from({ length: 17 }, (_, i) => [600, i * 25] as Pt);
  assert.deepEqual(dropCollinear(straight), [[600, 0], [600, 400]]);
  // an L keeps its knee
  const bent: Pt[] = [[0, 0], [50, 0], [100, 0], [100, 50], [100, 100]];
  assert.deepEqual(dropCollinear(bent), [[0, 0], [100, 0], [100, 100]]);
  assert.deepEqual(dropCollinear([[0, 0], [1, 1]] as Pt[]), [[0, 0], [1, 1]], "two points are already minimal");
});

test("the transition must land on its OWN condition", () => {
  const a = side("C-1", [room("shp-a", 0, 0, 600, 400)]);
  const b = side("T-1", [room("shp-b", 600, 0, 1200, 400)]);
  const gate = { a, b, sheets: sheets() };
  assert.equal(transitionRefusal({ ...gate, activeTag: "TR-1" }), null, "a third tag is fine");
  const onto = transitionRefusal({ ...gate, activeTag: "C-1" });
  assert.match(String(onto), /own condition/, "committing onto C-1 would lengthen the carpet it separates");
  assert.match(String(transitionRefusal({ ...gate, activeTag: "TR-1", b: a })), /DIFFERENT/);
  assert.match(String(transitionRefusal({ ...gate, activeTag: "TR-1", b: side("T-1", []) })), /no rooms/);
  assert.match(String(transitionRefusal({ ...gate, activeTag: "TR-1", unscaled: ["A-102"] })), /no scale/);
});
