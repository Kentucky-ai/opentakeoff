// Scope collision (#366) — two conditions claiming the same floor, as a
// number that has to read zero. Session-level against the bundled demo plan;
// the wire shape is pinned in conformance.test. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Session } from "../src/session.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";
// upp 1/36 → a 360 px square is 10 ft × 10 ft = 100 SF
const SQ = (x: number, y: number, w = 360, h = w): [number, number][] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const journalOf = (s: Session) => (s as any).journal as { op: string }[];

async function scaled() {
  const s = new Session();
  await s.loadPlan(PLAN);
  s.setScale(KEY, { upp: 1 / 36 });
  return s;
}

test("scope_duplicates: a deliberate 100% overlap between two conditions is caught, a partial one measured exactly, a same-condition one listed as a double trace; the summary carries the number", async () => {
  const s = await scaled();
  const a = s.measurePolygon(KEY, SQ(0, 0), { condition: "CPT-1", role: "floor_area" }).shape_id!;
  const b = s.measurePolygon(KEY, SQ(0, 0), { condition: "LVT-2", role: "floor_area" }).shape_id!;
  const c = s.measurePolygon(KEY, SQ(1000, 0), { condition: "CPT-1", role: "floor_area" }).shape_id!;
  const d = s.measurePolygon(KEY, SQ(1180, 0), { condition: "TILE-1", role: "floor_area" }).shape_id!;   // right half of c
  const e = s.measurePolygon(KEY, SQ(1000, 0), { condition: "CPT-1", role: "floor_area" }).shape_id!;   // c traced twice
  s.measurePolygon(KEY, SQ(0, 0), { condition: "LVT-2", role: "deduct" });                            // deducts are not claims
  const r = s.scopeDuplicates();
  const key = (p: any) => [p.a.shape_id, p.b.shape_id].sort().join("|");
  const byKey = Object.fromEntries(r.collisions.map((p) => [key(p), p]));
  assert.deepEqual([byKey[[a, b].sort().join("|")].shared_sf, byKey[[a, b].sort().join("|")].fraction_of_smaller, byKey[[a, b].sort().join("|")].iou], [100, 1, 1]);
  assert.equal(byKey[[c, d].sort().join("|")].shared_sf, 50);
  assert.equal(byKey[[c, d].sort().join("|")].fraction_of_smaller, 0.5);
  assert.equal(byKey[[d, e].sort().join("|")].shared_sf, 50, "the double trace collides with TILE-1 too");
  assert.equal(r.collisions.length, 3);
  assert.deepEqual(r.duplicates.map(key), [[c, e].sort().join("|")]);
  assert.equal(r.duplicates[0].shared_sf, 100);
  assert.deepEqual(r.collisions[0].look, { x0: 0, y0: 0, x1: 360, y1: 360 });
  assert.equal(r.collisions[0].a.condition, "CPT-1");
  // Σ − union: a,b (100+100−100) + c,d,e (100+100+100 − 150) = 100 + 150
  assert.equal(r.shared_floor_sf, 250);
  assert.equal(s.summary().shared_floor_sf, 250, "the summary carries the same number");
  assert.deepEqual(r.unmeasured, []);
  assert.equal(s.scopeDuplicates({ min_fraction: 0.6 }).collisions.length, 1, "a stated fraction filters the list, not the number");
  assert.equal(s.scopeDuplicates({ min_fraction: 0.6 }).shared_floor_sf, 250);
});

test("a clean takeoff reads 0, an unscaled sheet is unmeasured rather than zero", async () => {
  const s = await scaled();
  s.measurePolygon(KEY, SQ(0, 0), { condition: "CPT-1", role: "floor_area" });
  s.measurePolygon(KEY, SQ(400, 0), { condition: "LVT-2", role: "floor_area" });
  assert.equal(s.summary().shared_floor_sf, 0);
  assert.deepEqual(s.scopeDuplicates().collisions, []);
  const fresh = new Session();
  await fresh.loadPlan(PLAN);
  assert.equal(fresh.summary().shared_floor_sf, 0, "nothing measured → 0");
  assert.equal(fresh.summary().shared_floor_unmeasured, undefined);
});

test("scope_merge trims the loser to its remainder — measured to the polygon tolerance — as ONE step, and undo restores it verbatim", async () => {
  const s = await scaled();
  const c = s.measurePolygon(KEY, SQ(1000, 0), { condition: "CPT-1", role: "floor_area" }).shape_id!;
  const d = s.measurePolygon(KEY, SQ(1180, 0), { condition: "TILE-1", role: "floor_area" }).shape_id!;
  const before = structuredClone(s.exportPayload());
  const steps = journalOf(s).length;
  const r = s.scopeMerge({ shape_a: c, shape_b: d, winner: d });
  assert.deepEqual([r.action, r.winner, r.loser, r.shared_sf, r.loser_before_sf, r.loser_after_sf, r.loser_holes], ["trimmed", d, c, 50, 100, 50, 0]);
  assert.equal(journalOf(s).length, steps + 1, "one journal step");
  const loser = s.shapes.find((x) => x.id === c)!;
  assert.equal(loser.computed.area_sf, 50);
  assert.equal(loser.computed.perimeter_lf, 30, "5 ft × 10 ft remainder");
  assert.equal(loser.origin?.agent_edits, 1, "an agent revision of pending work, tallied as one");
  assert.equal(s.summary().shared_floor_sf, 0, "the collision is gone");
  assert.equal(s.summary().totals.total_sf, 150, "100 + 50, the floor counted once");
  assert.equal(s.undoLast(1).steps[0].op, "edit");
  assert.deepEqual(s.exportPayload(), before, "the loser is back verbatim");
  // a winner inside the loser leaves a hole
  const big = s.measurePolygon(KEY, SQ(2000, 0, 720), { condition: "CPT-1", role: "floor_area" }).shape_id!;
  const island = s.measurePolygon(KEY, SQ(2180, 180), { condition: "TILE-1", role: "floor_area" }).shape_id!;
  const r2 = s.scopeMerge({ shape_a: big, shape_b: island, winner: island });
  assert.deepEqual([r2.action, r2.loser_after_sf, r2.loser_holes], ["trimmed", 300, 1]);
  assert.equal(s.shapes.find((x) => x.id === big)!.verts_norm_holes?.length, 1);
});

test("scope_merge deletes a near-total loser (undo re-inserts it), and the reviewed shape wins when no winner is stated", async () => {
  const s = await scaled();
  const a = s.measurePolygon(KEY, SQ(0, 0), { condition: "CPT-1", role: "floor_area" }).shape_id!;
  const b = s.measurePolygon(KEY, SQ(0, 0), { condition: "LVT-2", role: "floor_area" }).shape_id!;
  s.shapes.find((x) => x.id === a)!.origin!.reviewed = true;
  const before = structuredClone(s.exportPayload());
  const r = s.scopeMerge({ shape_a: a, shape_b: b });
  assert.deepEqual([r.action, r.winner, r.loser, r.loser_after_sf, r.shape_count], ["deleted", a, b, 0, 1]);
  assert.equal(s.summary().shared_floor_sf, 0);
  assert.equal(s.undoLast(1).steps[0].op, "delete");
  assert.deepEqual(s.exportPayload(), before);
});

test("scope_merge refusals: unknown id, same id, not floor, different sheets, disjoint, a stated winner outside the pair, neither reviewed with no winner, both reviewed, a reviewed loser, a split, reconciled cuts — none journal", async () => {
  const s = await scaled();
  const a = s.measurePolygon(KEY, SQ(0, 0), { condition: "CPT-1", role: "floor_area" }).shape_id!;
  const b = s.measurePolygon(KEY, SQ(0, 0), { condition: "LVT-2", role: "floor_area" }).shape_id!;
  const far = s.measurePolygon(KEY, SQ(2000, 2000), { condition: "LVT-2", role: "floor_area" }).shape_id!;
  const line = s.measureLine(KEY, [[0, 0], [360, 0]], { condition: "RB-1" }).shape_id!;
  const steps = journalOf(s).length;
  assert.throws(() => s.scopeMerge({ shape_a: "shp-nope", shape_b: b }), /No shape with id/);
  assert.throws(() => s.scopeMerge({ shape_a: a, shape_b: a }), /same shape/);
  assert.throws(() => s.scopeMerge({ shape_a: a, shape_b: line, winner: a }), /only floor_area/);
  assert.throws(() => s.scopeMerge({ shape_a: a, shape_b: far, winner: a }), /share no floor/);
  assert.throws(() => s.scopeMerge({ shape_a: a, shape_b: b, winner: far }), /winner must be/);
  assert.throws(() => s.scopeMerge({ shape_a: a, shape_b: b }), /Neither shape is reviewed/);
  s.shapes.find((x) => x.id === a)!.origin!.reviewed = true;
  s.shapes.find((x) => x.id === b)!.origin!.reviewed = true;
  assert.throws(() => s.scopeMerge({ shape_a: a, shape_b: b }), /Both shapes were affirmed/);
  assert.throws(() => s.scopeMerge({ shape_a: a, shape_b: b, winner: a }), /affirmed by a human/, "a stated winner never overrides ink");
  s.shapes.find((x) => x.id === b)!.origin!.reviewed = false;
  assert.throws(() => s.scopeMerge({ shape_a: a, shape_b: b, winner: b }), /affirmed by a human/, "naming the ink as the loser is refused");
  // a winner that cuts the loser in two
  const wide = s.measurePolygon(KEY, SQ(3000, 0, 720, 360), { condition: "CPT-1", role: "floor_area" }).shape_id!;
  const band = s.measurePolygon(KEY, SQ(3300, -10, 120, 380), { condition: "TILE-1", role: "floor_area" }).shape_id!;
  assert.throws(() => s.scopeMerge({ shape_a: wide, shape_b: band, winner: band }), /split it into disjoint pieces/);
  // a loser carrying a reconciled cut
  const parent = s.measurePolygon(KEY, SQ(5000, 0), { condition: "CPT-1", role: "floor_area" }).shape_id!;
  s.cutOut({ parent_shape_id: parent, verts: SQ(5100, 100, 60) });
  const over = s.measurePolygon(KEY, SQ(5180, 0), { condition: "TILE-1", role: "floor_area" }).shape_id!;
  const stepsBefore = journalOf(s).length;
  assert.throws(() => s.scopeMerge({ shape_a: parent, shape_b: over, winner: over }), /reconciled cutouts/);
  assert.equal(journalOf(s).length, stepsBefore);
  assert.equal(journalOf(s).length - steps, 5, "only the four commits and the cut between journaled");
});

test("a hole and a reconciled cut: the number respects geometry, not arithmetic", async () => {
  const s = await scaled();
  const parent = s.measurePolygon(KEY, SQ(0, 0, 720), { condition: "CPT-1", role: "floor_area" }).shape_id!;
  s.cutOut({ parent_shape_id: parent, verts: SQ(180, 180) });   // a real hole in the middle
  s.measurePolygon(KEY, SQ(180, 180), { condition: "LVT-2", role: "floor_area" });   // a room traced inside the hole
  assert.equal(s.summary().shared_floor_sf, 0, "the hole is not CPT-1's floor, so nothing is shared");
  s.measurePolygon(KEY, SQ(90, 90), { condition: "TILE-1", role: "floor_area" });   // straddles the hole's corner
  const r = s.scopeDuplicates();
  assert.equal(r.collisions.length, 2, "TILE-1 shares with the parent's remainder and with the LVT-2 island");
  const withParent = r.collisions.find((p) => [p.a.shape_id, p.b.shape_id].includes(parent))!;
  // the TILE-1 box spans px 90..450; the hole spans 180..540 — 270×270 px (7.5 ft × 7.5 ft
  // = 56.25 SF) of the box falls in the hole and is not CPT-1's floor
  assert.equal(withParent.shared_sf, 43.75, "100 SF box minus the 56.25 SF that falls in the hole");
});
