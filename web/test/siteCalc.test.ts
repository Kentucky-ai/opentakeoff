import { test } from "node:test";
import assert from "node:assert/strict";
// The public calculator pages (/tools/*) run this module in the browser; the
// expected values below are worked by hand.
import { sfToSy, syToSf, packageOrder, rollCut, rollCutBoth, baseOrder, ftIn } from "../site/assets/calc.js";
import { conditionTotals } from "../src/lib/totals.js";

test("SF ↔ SY is exactly nine", () => {
  assert.equal(sfToSy(900), 100);
  assert.equal(syToSf(100), 900);
  assert.equal(sfToSy(-5), 0);
  assert.equal(sfToSy("abc"), 0);
});

test("package order: net, waste and attic stock stay separate, then whole packages", () => {
  const r = packageOrder({ netSf: 1000, wastePct: 10, atticPct: 2, packageSf: 20 });
  assert.deepEqual(
    { net: r.net, waste: r.waste, attic: r.attic, required: r.required, packages: r.packages, rounding: r.rounding },
    { net: 1000, waste: 100, attic: 20, required: 1120, packages: 56, rounding: 0 },
  );
  // attic is a share of NET, not of net + waste
  assert.equal(packageOrder({ netSf: 1000, wastePct: 50, atticPct: 10, packageSf: 1 }).attic, 100);
  const odd = packageOrder({ netSf: 1000, wastePct: 8, packageSf: 23.4 });
  assert.equal(odd.required, 1080);
  assert.equal(odd.packages, 47); // 46.15 → 47
  assert.equal(odd.ordered, 1099.8);
  assert.equal(odd.rounding, 19.8);
});

test("package order with no attic stock matches the canvas report's ordered SF", () => {
  const conds = [{ id: "wd", finish_tag: "WD-1", waste_pct: 10 }];
  const shapes = [{ condition_id: "wd", measure_role: "floor_area", computed: { area_sf: 743.4 } }];
  const [row] = conditionTotals(conds, shapes);
  const ours = packageOrder({ netSf: 743.4, wastePct: 10, packageSf: 1 });
  assert.equal(Math.round(ours.required * 10) / 10, Math.round(row.total_sf_net * 10) / 10);
});

test("roll cut: drops, drop length, cut SY and seams for one room", () => {
  const r = rollCut({ runFt: 20, acrossFt: 14, rollWidthFt: 12 })!;
  assert.equal(r.drops, 2);
  assert.equal(r.dropFt, 20);
  assert.equal(r.cutLf, 40);
  assert.equal(r.cutSf, 480);
  assert.equal(r.cutSy, 53.33);
  assert.equal(r.netSy, 31.11);
  assert.equal(r.seams, 1);
  assert.equal(r.seamLf, 20);
  assert.equal(r.wastePct, 41.7);
});

test("roll cut: trim then round up to the next whole pattern repeat", () => {
  // 20′ = 240″ + 6″ trim = 246″ → 24″ repeat → 11 repeats = 264″ = 22′
  const r = rollCut({ runFt: 20, acrossFt: 10, rollWidthFt: 12, trimIn: 6, repeatIn: 24 })!;
  assert.equal(r.dropFt, 22);
  assert.equal(r.drops, 1);
});

test("roll cut: an exact multiple of the roll width is not an extra drop", () => {
  assert.equal(rollCut({ runFt: 10, acrossFt: 24, rollWidthFt: 12 })!.drops, 2);
  assert.equal(rollCut({ runFt: 10, acrossFt: 0.3 * 40, rollWidthFt: 12 })!.drops, 1);
  assert.equal(rollCut({ runFt: 0, acrossFt: 10, rollWidthFt: 12 }), null);
});

test("roll cut both ways: the cheaper direction comes first", () => {
  const [best, other] = rollCutBoth({ lengthFt: 20, widthFt: 14, rollWidthFt: 12 })!;
  assert.equal(best.direction, "width"); // two 14′ drops = 37.33 SY
  assert.equal(best.cutSy, 37.33);
  assert.equal(other.direction, "length"); // two 20′ drops = 53.33 SY
});

test("base: perimeter less openings, plus waste, whole pieces", () => {
  const r = baseOrder({ perimeterLf: 164.97, openings: 2, openingWidthFt: 3, wastePct: 5, pieceLf: 120 });
  assert.equal(r.deduct, 6);
  assert.equal(r.net, 158.97);
  assert.equal(r.required, 166.92);
  assert.equal(r.pieces, 2);
  assert.equal(r.ordered, 240);
  // openings can never deduct more than the perimeter
  assert.equal(baseOrder({ perimeterLf: 10, openings: 9, openingWidthFt: 3, pieceLf: 4 }).net, 0);
});

test("feet-and-inches display", () => {
  assert.equal(ftIn(14.5), "14′-6″");
  assert.equal(ftIn(11.999), "12′-0″");
  assert.equal(ftIn(0.25), "0′-3″");
});
