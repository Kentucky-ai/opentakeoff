// Scope collision (#366): exact shared floor between committed floor shapes,
// the whole-takeoff number that has to read zero, the loser's remainder, and
// agreement with the room eval's own pair rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeCollisions, collisionsByCondition, subtractWinner, SCOPE_DUPLICATE_IOU } from "../src/lib/scopeCollision.js";
import { batchMetrics, DUPLICATE_FRAC } from "../bench/batch.ts";

// a 1000×1000 sheet at 0.1 ft/px: 100 px = 10 ft, a 100×100 px square = 100 SF
const DIMS = { w: 1000, h: 1000, upp: 0.1 };
const frame = () => DIMS;
const norm = (pts: number[][]) => pts.map(([x, y]) => [x / DIMS.w, y / DIMS.h]);
const sq = (x: number, y: number, w: number, h = w) => norm([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
const shape = (id: string, cond: string, verts: number[][], over: Record<string, unknown> = {}) => ({ id, sheet_id: "a.pdf", condition_id: cond, measure_role: "floor_area", verts_norm: verts, computed: {}, ...over });
const conds = [{ id: "cpt", finish_tag: "CPT-1" }, { id: "lvt", finish_tag: "LVT-2" }];

test("a deliberate 100% overlap between two conditions is caught: shared = the smaller shape, fraction 1, iou 1", () => {
  const r = scopeCollisions([shape("a", "cpt", sq(0, 0, 100)), shape("b", "lvt", sq(0, 0, 100))], conds, frame);
  assert.equal(r.collisions.length, 1);
  const p = r.collisions[0];
  assert.deepEqual([p.a.condition, p.b.condition, p.shared_sf, p.fraction_of_smaller, p.iou, p.same_condition], ["CPT-1", "LVT-2", 100, 1, 1, false]);
  assert.deepEqual(p.look, { x0: 0, y0: 0, x1: 100, y1: 100 });
  assert.equal(r.shared_floor_sf, 100);
  assert.deepEqual(r.duplicates, []);
  assert.deepEqual(r.unmeasured, []);
});

test("partial overlap measures exactly; hairlines under the listing floor are not claims; a rectangle nested in a bigger room is a collision of the smaller", () => {
  // b covers the right half of a (50×100 px = 50 SF); c is a 1 px strip that
  // touches a along its edge (shares a boundary, no area) and sits inside b;
  // lip overlaps a by 3 px (3% of the smaller — under the 5% floor)
  const r = scopeCollisions([
    shape("a", "cpt", sq(0, 0, 100)), shape("b", "lvt", sq(50, 0, 100, 100)), shape("c", "lvt", sq(100, 0, 1, 100)),
    shape("nest", "lvt", sq(10, 10, 20)),   // 4 SF closet-sized box entirely inside a
    shape("lip", "x", sq(97, 200, 100)),    // far from everything but a; overlaps a by nothing (y ≥ 200)
    shape("lip2", "x", sq(-97, 0, 100)),    // 3 px × 100 px = 3 SF inside a → 3% of the smaller
  ], [...conds, { id: "x", finish_tag: "X" }], frame);
  const byIds = Object.fromEntries(r.collisions.map((p) => [`${p.a.shape_id}-${p.b.shape_id}`, p]));
  assert.equal(byIds["a-b"].shared_sf, 50);
  assert.equal(byIds["a-b"].fraction_of_smaller, 0.5);
  assert.equal(byIds["a-nest"].shared_sf, 4);
  assert.equal(byIds["a-nest"].fraction_of_smaller, 1);
  assert.equal(byIds["a-c"], undefined, "a shared boundary is not shared floor");
  assert.equal(byIds["a-lip2"], undefined, "3% of the smaller shape is under the 5% floor");
  assert.equal(byIds["b-c"], undefined, "same condition → never a collision");
  assert.equal(r.duplicates.length, 1, "b and c share floor on the same condition: a double trace");
  assert.equal(r.duplicates[0].shared_sf, 1);
  assert.equal(r.collisions[0].shared_sf, 50, "sorted biggest first");
  // Σ − union: a(100)+b(100)+c(1)+nest(4)+lip(100)+lip2(100) = 405 claimed; the union is
  // a∪b (150, c and nest fall inside) + lip (100) + lip2's part outside a (97) = 347 → 58.
  // The 3 SF lip2 shares counts here even though the pair is under the listing floor.
  assert.equal(r.shared_floor_sf, 58);
  const lowFloor = scopeCollisions([shape("a", "cpt", sq(0, 0, 100)), shape("lip2", "lvt", sq(-97, 0, 100))], conds, frame, { minFraction: 0 });
  assert.equal(lowFloor.collisions.length, 1, "a stated fraction of 0 lists everything that shares floor");
});

test("three shapes over one cell count that cell once in shared_floor_sf; holes are respected; deducts and other roles are not claims", () => {
  const three = [shape("a", "cpt", sq(0, 0, 100)), shape("b", "lvt", sq(0, 0, 100)), shape("c", "lvt", sq(0, 0, 100), { condition_id: "x" })];
  const r = scopeCollisions(three, [...conds, { id: "x", finish_tag: "X" }], frame);
  assert.equal(r.shared_floor_sf, 200, "300 claimed − 100 union: the cell is double-counted twice, never triple");
  assert.equal(r.collisions.length, 3);
  const holed = shape("h", "cpt", sq(0, 0, 100), { verts_norm_holes: [sq(20, 20, 60)] });
  const inHole = shape("i", "lvt", sq(20, 20, 60));
  const r2 = scopeCollisions([holed, inHole], conds, frame);
  assert.deepEqual(r2.collisions, [], "a room traced inside another room's hole shares nothing");
  assert.equal(r2.shared_floor_sf, 0);
  const r3 = scopeCollisions([holed, shape("j", "lvt", sq(10, 10, 20))], conds, frame);
  assert.equal(r3.collisions[0].shared_sf, 4 - 1, "the part of j that falls in the hole is not shared");
  const r4 = scopeCollisions([
    shape("a", "cpt", sq(0, 0, 100)),
    shape("d", "lvt", sq(0, 0, 100), { measure_role: "deduct" }),
    shape("l", "lvt", sq(0, 0, 100), { measure_role: "linear" }),
    shape("s", "lvt", sq(0, 0, 100), { measure_role: "surface_area" }),
  ], conds, frame);
  assert.deepEqual(r4.collisions, []);
  assert.equal(r4.shared_floor_sf, 0);
});

test("different sheets never pair; an unscaled or unloaded sheet is reported unmeasured, never counted as zero; a degenerate ring is named", () => {
  const r = scopeCollisions([shape("a", "cpt", sq(0, 0, 100)), shape("b", "lvt", sq(0, 0, 100), { sheet_id: "b.pdf" })], conds, (id) => (id === "a.pdf" ? DIMS : null));
  assert.deepEqual(r.collisions, []);
  assert.deepEqual(r.unmeasured, [{ shape_id: "b", sheet_id: "b.pdf", reason: "sheet not loaded" }]);
  const r2 = scopeCollisions([shape("a", "cpt", sq(0, 0, 100)), shape("b", "lvt", sq(0, 0, 100))], conds, () => ({ w: 1000, h: 1000, upp: 0 }));
  assert.equal(r2.unmeasured.length, 2);
  assert.equal(r2.unmeasured[0].reason, "sheet has no scale");
  const bow = shape("bow", "lvt", norm([[0, 0], [100, 100], [100, 0], [0, 100]]));
  const r3 = scopeCollisions([shape("a", "cpt", sq(0, 0, 100)), bow], conds, frame);
  assert.equal(r3.collisions.length, 1, "a bow-tie is repaired with buffer(0) and measured");
  assert.equal(r3.collisions[0].shared_sf, 25);
  const line = shape("flat", "lvt", norm([[0, 0], [100, 0], [200, 0]]));
  const r4 = scopeCollisions([shape("a", "cpt", sq(0, 0, 100)), line], conds, frame);
  assert.equal(r4.unmeasured.length, 1);
  assert.equal(r4.unmeasured[0].shape_id, "flat");
  assert.match(r4.unmeasured[0].reason, /zero area|self-intersecting|could not be built/);
  assert.deepEqual(r4.collisions, [], "and it is left out of every number");
});

test("collisionsByCondition counts a cross-condition pair on both rows and a double trace once", () => {
  const r = scopeCollisions([shape("a", "cpt", sq(0, 0, 100)), shape("b", "lvt", sq(0, 0, 100)), shape("c", "lvt", sq(0, 0, 100))], conds, frame);
  const by = collisionsByCondition(r);
  assert.equal(by.get("cpt")!.length, 2);
  assert.equal(by.get("lvt")!.length, 3, "two collisions with a, one double trace with c");
});

test("subtractWinner: the loser keeps its remainder to the polygon tolerance; a split or a vanish returns null", () => {
  const loser = shape("l", "cpt", sq(0, 0, 100)), winner = shape("w", "lvt", sq(50, 0, 100, 100));
  const r = subtractWinner(loser, winner, DIMS)!;
  assert.ok(r);
  assert.equal(r.area, 5000, "px²: 100×100 − 50×100");
  assert.equal(r.perim, 300);
  assert.equal(r.holes.length, 0);
  assert.equal(r.outer.length, 4);
  const island = subtractWinner(shape("l", "cpt", sq(0, 0, 100)), shape("w", "lvt", sq(25, 25, 50)), DIMS)!;
  assert.equal(island.holes.length, 1, "a winner inside the loser leaves a hole");
  assert.equal(island.area, 10000 - 2500);
  assert.equal(subtractWinner(shape("l", "cpt", sq(0, 0, 100)), shape("w", "lvt", sq(0, 40, 100, 20)), DIMS), null, "a winner cutting the loser in two is a re-trace decision");
  assert.equal(subtractWinner(shape("l", "cpt", sq(0, 0, 100)), shape("w", "lvt", sq(0, 0, 100)), DIMS), null, "nothing left");
});

test("the room eval's shared-floor gate and this module agree on the same set of duplicate pairs", () => {
  assert.equal(SCOPE_DUPLICATE_IOU, DUPLICATE_FRAC, "one threshold, pinned in both places");
  const px = (verts: number[][]) => verts.map(([x, y]) => [x * DIMS.w, y * DIMS.h]);
  const rings: Record<string, number[][]> = {
    r1: sq(0, 0, 200), r1dup: sq(5, 5, 200), r2: sq(300, 0, 150), r2half: sq(375, 0, 150), closet: sq(20, 20, 40), far: sq(700, 700, 100),
  };
  const shapes = Object.entries(rings).map(([id, v], i) => shape(id, i % 2 ? "lvt" : "cpt", v));
  const proposals = Object.entries(rings).map(([label, v]) => ({ label, seed: [0, 0] as [number, number], ring: px(v) as [number, number][] }));
  const bench = batchMetrics(proposals, proposals.length, 1 / DIMS.upp, 1);
  const mine = scopeCollisions(shapes, conds, frame, { minFraction: 0 });
  const key = (a: string, b: string) => [a, b].sort().join("|");
  const benchDups = new Set(bench.duplicates.map(([a, b]) => key(a, b)));
  const mineDups = new Set([...mine.collisions, ...mine.duplicates].filter((p) => p.iou >= SCOPE_DUPLICATE_IOU).map((p) => key(p.a.shape_id, p.b.shape_id)));
  assert.deepEqual([...mineDups].sort(), [...benchDups].sort());
  assert.deepEqual([...benchDups].sort(), ["r1|r1dup"], "the near-identical pair, and nothing that merely nests or touches");
  // the harness rasterizes at 1 px cells; the exact number agrees to that tolerance
  assert.ok(Math.abs(bench.overlapSF - mine.shared_floor_sf) < 3, `bench ${bench.overlapSF} vs exact ${mine.shared_floor_sf}`);
});
