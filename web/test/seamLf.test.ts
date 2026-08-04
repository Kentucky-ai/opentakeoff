// Figured seam length (#147 follow-on) — weld rod and seam tape come off the
// CUT LAYOUT, not off a share of the area or the perimeter.
//
// The rule under test, stated as an estimator would: a 20-ft-wide room off a
// 12-ft roll needs one seam down its whole length; the same square footage as
// two separate 10-ft rooms needs none, because each takes one strip and the
// two rooms are separated by a wall and a threshold rather than welded
// together. No percentage of SF or LF can tell those two jobs apart, which is
// exactly why the old "seam materials = N% of perimeter" line was a guess.
//
// The invariants:
//   - seams are counted between ADJACENT lanes of the SAME source shape;
//   - measured on the in-room COVERAGE extent (run minus each lane's own wall
//     and doorway overage) — a weld does not run up the wall;
//   - only where the two lanes' extents OVERLAP, so an L-shaped room seams
//     along the part its lanes actually face each other and no further;
//   - kept per SHAPE, so a per-sheet or per-room slice of the takeoff totals
//     its own seams instead of inheriting the whole condition's;
//   - a materials row with basis "seam_lf" divides against that figure, and
//     reads 0 — not a guess — when nothing has laid the condition out yet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { seamLfBySrc, seamLfForStrips, layoutRingStrips, defaultRollSetup } from "../src/lib/rollgoods.js";
import { computeRollTakeoff, seamLfByShape, rollReportRows, mintRollSetup } from "../src/lib/rollTakeoff.js";
import { conditionTotals, sheetGroupedRows } from "../src/lib/totals.js";

// 1000×1000-px sheet at upp = 0.05 ft/px — one normalized unit is 50 ft.
const UPP = 0.05;
const DIMS = { w: 1000, h: 1000 };
const dimsFor = (k: string) => (k.startsWith("s") ? DIMS : null);
const uppFor = (k: string) => (k.startsWith("s") ? UPP : null);
const ft = (n: number) => n / 50;   // feet → normalized

// A rectangle in FEET, as a shape on sheet `sheet`.
const rect = (id: string, condId: string, x0: number, y0: number, w: number, h: number, extra: any = {}) => ({
  id, condition_id: condId, sheet_id: extra.sheet_id ?? "s1", measure_role: "floor_area",
  verts_norm: [[ft(x0), ft(y0)], [ft(x0 + w), ft(y0)], [ft(x0 + w), ft(y0 + h)], [ft(x0), ft(y0 + h)]],
  computed: { area_sf: w * h, perimeter_lf: 2 * (w + h) },
  ...extra,
});

// strips run along Y so lanes tile across X — the width that has to be covered
// by roll widths is the room's X dimension.
const NS = { ...defaultRollSetup("sheet_vinyl"), direction: "ns" };
const conds = (extra: any = {}) => [{ id: "sv", finish_tag: "SV-1", roll_setup: { material: "sheet_vinyl", ...NS }, ...extra }];

// ── the engine rule ─────────────────────────────────────────────────────────

test("one 20-ft-wide room off a 12-ft roll figures ONE seam its whole length", () => {
  // 20 ft across needs two lanes (a 12-ft roll loses seam + wall allowance);
  // 30 ft of run means 30 ft of weld.
  const ring = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 30 }, { x: 0, y: 30 }];
  const strips = layoutRingStrips({ id: "r", ring }, "ns", {
    rollWidthFt: 12, seamAllowanceIn: 2, wallOverageIn: 3, doorwayOverageIn: 0,
  });
  assert.equal(strips.length, 2);
  assert.equal(seamLfForStrips(strips), 30, "one seam, the full run — NOT the cut length (30.5 with overage)");
  assert.deepEqual([...seamLfBySrc(strips)], [["r", 30]]);
});

test("the same area as two separate 10-ft rooms figures NO seam", () => {
  const cfg = { rollWidthFt: 12, seamAllowanceIn: 2, wallOverageIn: 3, doorwayOverageIn: 0 };
  const a = layoutRingStrips({ id: "a", ring: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 30 }, { x: 0, y: 30 }] }, "ns", cfg);
  const b = layoutRingStrips({ id: "b", ring: [{ x: 20, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }, { x: 20, y: 30 }] }, "ns", cfg);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(seamLfForStrips([...a, ...b]), 0, "600 SF either way — the layout, not the area, decides");
  assert.equal(seamLfBySrc([...a, ...b]).size, 0, "zero entries, not zero-valued ones");
});

test("adjacent rooms are never welded across the wall between them", () => {
  // Two 10-ft rooms sharing a wall look like one 20-ft room to an area-based
  // guess. They are not: each takes one strip, and the threshold between them
  // is a transition, not a seam.
  const cfg = { rollWidthFt: 12, seamAllowanceIn: 2, wallOverageIn: 3, doorwayOverageIn: 0 };
  const a = layoutRingStrips({ id: "a", ring: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 30 }, { x: 0, y: 30 }] }, "ns", cfg);
  const b = layoutRingStrips({ id: "b", ring: [{ x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 30 }, { x: 10, y: 30 }] }, "ns", cfg);
  assert.equal(seamLfForStrips([...a, ...b]), 0);
});

test("an L-shaped room seams only where its two lanes actually face each other", () => {
  // 20 ft wide for the bottom 15 ft, 11 ft wide for the top 15. The second
  // lane exists only over the wide part, so the weld runs 15 ft, not 30.
  const ring = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 15 }, { x: 11, y: 15 }, { x: 11, y: 30 }, { x: 0, y: 30 }];
  const strips = layoutRingStrips({ id: "L", ring }, "ns", {
    rollWidthFt: 12, seamAllowanceIn: 2, wallOverageIn: 3, doorwayOverageIn: 0,
  });
  assert.equal(strips.length, 2);
  assert.equal(seamLfForStrips(strips), 15);
});

test("seams are measured net of wall overage — a weld does not run up the wall", () => {
  const ring = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 30 }, { x: 0, y: 30 }];
  const cut = (wallOverageIn: number) => layoutRingStrips({ id: "r", ring }, "ns",
    { rollWidthFt: 12, seamAllowanceIn: 2, wallOverageIn, doorwayOverageIn: 0 });
  assert.equal(seamLfForStrips(cut(3)), 30);
  assert.equal(seamLfForStrips(cut(6)), 30, "more overage buys more material, never more weld");
  // the CUTS did get longer — the seam figure is deliberately not the cut length
  assert.ok(cut(6)[0].runMax - cut(6)[0].runMin > cut(3)[0].runMax - cut(3)[0].runMin);
});

test("seamLfForStrips: empty and malformed input answer 0 rather than throwing", () => {
  assert.equal(seamLfForStrips([]), 0);
  assert.equal(seamLfForStrips(null as any), 0);
  assert.equal(seamLfBySrc(undefined as any).size, 0);
});

// ── the takeoff wiring ──────────────────────────────────────────────────────

test("computeRollTakeoff figures the condition's seam and keeps it per shape", () => {
  const shapes = [rect("wide", "sv", 5, 5, 20, 30), rect("narrow", "sv", 30, 5, 10, 30)];
  const { byCond } = computeRollTakeoff(conds(), shapes, dimsFor, uppFor);
  const ri = byCond.get("sv");
  assert.equal(ri.seamLf, 30, "the wide room's one seam; the narrow room adds none");
  assert.deepEqual([...ri.seamByShape], [["wide", 30]]);
  assert.deepEqual([...seamLfByShape(byCond)], [["wide", 30]]);
  assert.deepEqual([...seamLfByShape(null)], [], "no roll goods → an empty map, never a throw");
});

test("rollReportRows carries seam_lf, ×N like every other reported quantity", () => {
  const shapes = [rect("wide", "sv", 5, 5, 20, 30)];
  const cs = conds({ multiplier: 3 });
  const { byCond } = computeRollTakeoff(cs, shapes, dimsFor, uppFor);
  const [row] = rollReportRows(byCond, conditionTotals(cs, shapes));
  assert.equal(row.seam_lf, 90, "three identical units are three cuttings of the same layout");
});

test("a seam_lf materials row divides against the figured seams, ×N and coverage applied", () => {
  const shapes = [rect("wide", "sv", 5, 5, 20, 30)];
  const cs = conds({ multiplier: 2, materials: [
    { name: "Heat-weld rod", per: 1, basis: "seam_lf", unit: "lf" },
    { name: "Weld rod (coil)", per: 100, basis: "seam_lf", unit: "coil" },
  ] });
  const { byCond } = computeRollTakeoff(cs, shapes, dimsFor, uppFor);
  const [row] = conditionTotals(cs, shapes, { seamByShape: seamLfByShape(byCond) });
  assert.equal(row.materials[0].basis_qty, 60, "30 ft of seam ×2 units");
  assert.equal(row.materials[0].qty, 60);
  assert.equal(row.materials[1].qty, 1, "ceil(60 / 100) — you buy whole coils");
  // and the basis is disclosed on the line, so a pricing consumer can see it
  assert.equal(row.materials[0].basis, "seam_lf");
});

test("a seam_lf row reads 0 without a roll setup, and without shapes to lay out", () => {
  // `=== 0` rather than assert.equal: the whole-units ceil of an empty basis
  // is -0, which is what every zero-quantity materials row has always been
  // (it serializes as 0) — this is asserting "no quantity", not a sign.
  const materials = [{ name: "Heat-weld rod", per: 1, basis: "seam_lf", unit: "lf" }];
  // no roll_setup at all — nothing has decided how this gets cut
  const bare = [{ id: "sv", finish_tag: "SV-1", materials }];
  const [noSetup] = conditionTotals(bare, [rect("wide", "sv", 5, 5, 20, 30)],
    { seamByShape: seamLfByShape(computeRollTakeoff(bare, [], dimsFor, uppFor).byCond) });
  assert.ok(noSetup.materials[0].qty === 0, "no layout, no quantity — never a percentage of something else");
  assert.ok(noSetup.materials[0].basis_qty === 0);
  // a roll setup but no committed floor shapes
  const empty = [{ id: "sv", finish_tag: "SV-1", roll_setup: mintRollSetup("sheet_vinyl"), materials }];
  const [noShapes] = conditionTotals(empty, [], { seamByShape: seamLfByShape(computeRollTakeoff(empty, [], dimsFor, uppFor).byCond) });
  assert.ok(noShapes.materials[0].qty === 0);
  // and no seam context at all (every caller with no roll wiring) is the same 0
  const [noCtx] = conditionTotals(empty, [rect("wide", "sv", 5, 5, 20, 30)]);
  assert.ok(noCtx.materials[0].qty === 0);
});

test("per-shape seams slice: a sheet's rows carry that sheet's welding, not the project's", () => {
  const shapes = [
    rect("wide1", "sv", 5, 5, 20, 30),
    rect("wide2", "sv", 5, 5, 20, 20, { sheet_id: "s2" }),
  ];
  const cs = conds({ materials: [{ name: "Heat-weld rod", per: 1, basis: "seam_lf", unit: "lf" }] });
  const { byCond } = computeRollTakeoff(cs, shapes, dimsFor, uppFor);
  const ctx = { seamByShape: seamLfByShape(byCond) };
  const [whole] = conditionTotals(cs, shapes, ctx);
  assert.equal(whole.materials[0].basis_qty, 50, "30 + 20 across the project");
  const groups = sheetGroupedRows(cs, shapes, ctx);
  assert.deepEqual(groups.map((g: any) => [g.sheet_id, g.rows[0].materials[0].basis_qty]), [["s1", 30], ["s2", 20]]);
});
