// Roll-goods layout engine (lib/rollgoods.js) — pure packing/nesting math for
// fixed-width roll materials, contributed by Michael Hartman. Pins the layout
// invariants and the quantities-only contract on roll_setup. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeRollLayout, layoutRingStrips, rollCutNumbers, rollLayoutOrderLengthFt,
  rollLayoutRollCount, isRollType, defaultRollSetup, rollQtyForUnit,
  ROLL_FLOORING_TYPES,
} from "../src/lib/rollgoods.js";

// rectangular room ring, feet, {x,y} points
const rect = (w: number, h: number) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
const CFG = { rollWidthFt: 12, rollLengthFt: 0, seamAllowanceIn: 2, wallOverageIn: 3, doorwayOverageIn: 1, direction: "auto" };

test("roll material classes: carpet, sheet vinyl, rubber — never modular goods", () => {
  assert.deepEqual(ROLL_FLOORING_TYPES, ["carpet", "sheet_vinyl", "rubber"]);
  assert.ok(isRollType("carpet") && !isRollType("carpet_tile") && !isRollType("lvt"));
});

test("roll_setup is quantities-only: a unit of sale, never a price", () => {
  const rs = defaultRollSetup("carpet");
  assert.ok(!("roll_price" in rs), "no price field on roll_setup");
  assert.equal(rs.price_unit, "sy");
  assert.equal(defaultRollSetup("sheet_vinyl").price_unit, "sf");
  assert.equal(rs.roll_width_ft, 12);
});

test("single-drop room: one strip, order length ≈ room length + overage", () => {
  const layout = computeRollLayout([{ ring: rect(10, 13) }], CFG);
  assert.equal(layout.strips.length, 1);
  const orderFt = rollLayoutOrderLengthFt(layout.strips);
  assert.ok(orderFt >= 13 && orderFt < 15, `order ${orderFt}`);
});

test("seamed room: a 20' span under a 12' roll seams; no cut ever wider than the roll", () => {
  const layout = computeRollLayout([{ ring: rect(20, 30) }], CFG);
  assert.ok(layout.strips.length >= 2);
  for (const s of layout.strips) assert.ok(s.laneMax - s.laneMin <= CFG.rollWidthFt + 1e-6);
});

test("auto direction never orders more than the worse fixed direction", () => {
  const auto = rollLayoutOrderLengthFt(computeRollLayout([{ ring: rect(20, 30) }], CFG).strips);
  const ns = rollLayoutOrderLengthFt(computeRollLayout([{ ring: rect(20, 30) }], { ...CFG, direction: "ns" }).strips);
  const ew = rollLayoutOrderLengthFt(computeRollLayout([{ ring: rect(20, 30) }], { ...CFG, direction: "ew" }).strips);
  assert.ok(auto <= Math.max(ns, ew) + 1e-6);
});

test("multi-roll: 40' of cuts on 25' rolls needs a second roll; every cut numbered", () => {
  const layout = computeRollLayout([{ ring: rect(11, 40) }], { ...CFG, rollLengthFt: 25 });
  assert.ok(rollLayoutRollCount(layout.strips) >= 2);
  const nums = rollCutNumbers(layout.strips);   // Map: strip id → 1-based cut number
  assert.equal(nums.size, layout.strips.length);
  for (const s of layout.strips) assert.ok(nums.get(s.id)! >= 1);
});

test("unit conversion: order footage → SY / SF / LF", () => {
  assert.equal(rollQtyForUnit(90, 12, "sy"), 120);
  assert.equal(rollQtyForUnit(90, 12, "sf"), 1080);
  assert.equal(rollQtyForUnit(90, 12, "lf"), 90);
});

test("degenerate input: null ring and empty room list yield no strips", () => {
  assert.equal(layoutRingStrips({ ring: null }, "ns", CFG).length, 0);
  assert.equal(computeRollLayout([], CFG).strips.length, 0);
});
