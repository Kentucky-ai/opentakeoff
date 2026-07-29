// Roll-goods wiring (lib/rollTakeoff.js, #136) — the pure bridge between the
// shape/condition model and the packing engine. The invariants:
//   - opt-in is roll_setup PRESENCE (corrupt setups read as opted out);
//   - rings convert verts_norm → feet through the sheet's dims × upp, and
//     shapes on unscaled/unrendered sheets are skipped, never guessed;
//   - overrides collect off shape.roll_layout keyed "<shapeId>:<laneIndex>"
//     with the parent's laneCount (the engine's stale-override guard reads it);
//   - the overlay rects land in SHEET PX on the right axes for both run
//     directions;
//   - report rows apply ×N (the house convention for every quantity) and
//     stay quantities-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasRollSetup, mintRollSetup, rollConfig, collectRollOverrides,
  computeRollTakeoff, rollReportRows, stripSheetRect,
} from "../src/lib/rollTakeoff.js";
import { conditionTotals } from "../src/lib/totals.js";

// A 20×14-ft room drawn on a 1000×1000-px sheet at upp = 0.05 ft/px:
// 20 ft = 400 px wide (x), 14 ft = 280 px tall (y), anchored at (100, 100) px.
const UPP = 0.05;
const DIMS = { w: 1000, h: 1000 };
const room = (id: string, condId: string) => ({
  id, condition_id: condId, sheet_id: "s1", measure_role: "floor_area",
  verts_norm: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.38], [0.1, 0.38]],
  computed: { area_sf: 280, perimeter_lf: 68 },
});
const dimsFor = (k: string) => (k === "s1" ? DIMS : null);
const uppFor = (k: string) => (k === "s1" ? UPP : null);

test("opt-in is roll_setup presence; corrupt setups read as opted out", () => {
  assert.equal(hasRollSetup({ roll_setup: mintRollSetup("carpet") }), true);
  assert.equal(hasRollSetup({}), false);
  assert.equal(hasRollSetup({ roll_setup: "corrupt" }), false);
  assert.equal(hasRollSetup({ roll_setup: ["x"] }), false);
  assert.equal(hasRollSetup({ roll_setup: { roll_width_ft: 0 } }), false);
});

test("mintRollSetup: engine defaults + the material class; carpet sells by SY, resilient by SF", () => {
  const c = mintRollSetup("carpet");
  assert.deepEqual({ m: c.material, w: c.roll_width_ft, u: c.price_unit }, { m: "carpet", w: 12, u: "sy" });
  assert.equal(mintRollSetup("sheet_vinyl").price_unit, "sf");
  assert.equal(mintRollSetup("nonsense").material, "carpet", "unknown class falls back, never throws");
});

test("rollConfig coerces every field and clamps direction to the engine's vocabulary", () => {
  const cfg = rollConfig({ roll_width_ft: "12", seam_allowance_in: -3, wall_overage_in: null, direction: "diagonal" });
  assert.deepEqual(cfg, { rollWidthFt: 12, rollLengthFt: 0, seamAllowanceIn: 0, wallOverageIn: 0, doorwayOverageIn: 0, direction: "auto" });
});

test("computeRollTakeoff: a 20×14 room on a 12-ft roll figures 2 lanes and a to-scale overlay", () => {
  const conds = [{ id: "cpt", finish_tag: "CPT-1", roll_setup: { ...mintRollSetup("carpet"), direction: "ns" } }];
  const shapes = [room("r1", "cpt")];
  const { byCond, cutsBySheet } = computeRollTakeoff(conds, shapes, dimsFor, uppFor);
  const ri = byCond.get("cpt");
  assert.ok(ri, "the opted-in condition figures");
  assert.equal(ri.direction, "ns");
  assert.equal(ri.cutCount, 2, "20 ft across a 12-ft roll = 2 lanes");
  // each N–S cut runs the room's 14-ft height + 3″ wall overage per end
  const lens = ri.strips.map((s: any) => s.runMax - s.runMin);
  for (const ln of lens) assert.ok(Math.abs(ln - 14.5) < 1e-9, `cut length ${ln} = 14 + 2×0.25 wall overage`);
  // order footage: two cuts side-by-side won't fit one 12-ft width — they
  // stack down the roll: 2 × 14.5 = 29 ft, rounded up to the inch
  assert.ok(Math.abs(ri.orderFt - 29) < 1e-9, `orderFt ${ri.orderFt}`);
  assert.equal(ri.rollCount, 1, "no max roll length = one continuous roll");
  assert.ok(Math.abs(ri.qty - (29 * 12) / 9) < 0.01, "SY = orderFt × width ÷ 9");
  // overlay rects: sheet px, lanes tiling across x (ns), full-lane cut 12 ft
  // wide draws at the TRUE roll width incl. allowances, not the coverage split
  const cuts = cutsBySheet.get("s1");
  assert.equal(cuts.length, 2);
  const c0 = cuts.find((c: any) => c.laneIndex === 0);
  assert.ok(Math.abs(c0.h - 14.5 / UPP) < 1e-6, "run extent in sheet px");
  assert.ok(c0.multi && c0.laneCount === 2, "a seamed room's cuts read as multi");
  assert.ok(cuts.every((c: any) => c.num >= 1 && c.num <= 2), "numbered in cutting order");
});

test("computeRollTakeoff: unscaled sheets and non-floor shapes are skipped, never guessed", () => {
  const conds = [{ id: "cpt", finish_tag: "CPT-1", roll_setup: mintRollSetup("carpet") }];
  const offSheet = { ...room("r2", "cpt"), sheet_id: "unrendered" };
  const linear = { ...room("r3", "cpt"), measure_role: "linear" };
  const { byCond } = computeRollTakeoff(conds, [offSheet, linear], dimsFor, uppFor);
  assert.equal(byCond.size, 0, "nothing figured — no ring can speak feet");
});

test("collectRollOverrides flattens lanes with the parent laneCount; corrupt layouts are ignored", () => {
  const shapes = [
    { id: "a", roll_layout: { laneCount: 2, lanes: { 0: { runMin: 1, runMax: 9 }, 1: { seq: 3 } } } },
    { id: "b", roll_layout: "corrupt" },
    { id: "c" },
  ];
  assert.deepEqual(collectRollOverrides(shapes), {
    "a:0": { runMin: 1, runMax: 9, laneCount: 2 },
    "a:1": { seq: 3, laneCount: 2 },
  });
});

test("a manual run override rides into the figured layout (and the engine's laneCount guard drops stale ones)", () => {
  const conds = [{ id: "cpt", finish_tag: "CPT-1", roll_setup: { ...mintRollSetup("carpet"), direction: "ns" } }];
  const withOverride = [{ ...room("r1", "cpt"), roll_layout: { laneCount: 2, lanes: { 0: { runMin: 4, runMax: 20 } } } }];
  const ri = computeRollTakeoff(conds, withOverride, dimsFor, uppFor).byCond.get("cpt");
  const lane0 = ri.strips.find((s: any) => s.laneIndex === 0);
  assert.deepEqual({ min: lane0.runMin, max: lane0.runMax }, { min: 4, max: 20 }, "override applied");
  const stale = [{ ...room("r1", "cpt"), roll_layout: { laneCount: 5, lanes: { 0: { runMin: 4, runMax: 20 } } } }];
  const ri2 = computeRollTakeoff(conds, stale, dimsFor, uppFor).byCond.get("cpt");
  const lane0b = ri2.strips.find((s: any) => s.laneIndex === 0);
  assert.ok(Math.abs((lane0b.runMax - lane0b.runMin) - 14.5) < 1e-9, "a laneCount mismatch (reshaped room) drops the override");
});

test("stripSheetRect maps both run directions onto the right screen axes", () => {
  const ns = stripSheetRect({ laneAxis: "x", laneMin: 5, laneMax: 17, runMin: 5, runMax: 19 }, UPP);
  assert.deepEqual(ns, { x: 100, y: 100, w: 240, h: 280 });
  const ew = stripSheetRect({ laneAxis: "y", laneMin: 5, laneMax: 17, runMin: 5, runMax: 19 }, UPP);
  assert.deepEqual(ew, { x: 100, y: 100, w: 280, h: 240 });
  assert.equal(stripSheetRect({ laneAxis: "x", laneMin: 0, laneMax: 1, runMin: 0, runMax: 1 }, 0), null, "no upp, no rect");
});

test("rollReportRows: ×N applies like every reported quantity; only figured conditions emit; quantities-only", () => {
  const conds = [
    { id: "cpt", finish_tag: "CPT-1", multiplier: 3, roll_setup: { ...mintRollSetup("carpet"), direction: "ns" } },
    { id: "vct", finish_tag: "VCT-1" },
  ];
  const shapes = [room("r1", "cpt"), room("r9", "vct")];
  const { byCond } = computeRollTakeoff(conds, shapes, dimsFor, uppFor);
  const rows = rollReportRows(byCond, conditionTotals(conds, shapes));
  assert.equal(rows.length, 1, "only the roll-goods condition emits a row");
  const r = rows[0];
  assert.deepEqual(
    { tag: r.finish_tag, lf: r.order_lf, rolls: r.rolls, unit: r.order_unit },
    { tag: "CPT-1", lf: 87, rolls: 3, unit: "sy" },   // 29 ft × 3 units
  );
  assert.ok(!("price" in r) && !("cost" in r), "quantities only — no dollars, ever");
  assert.deepEqual(rollReportRows(null, []), []);
});
