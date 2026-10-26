// The light half of Import from schedule: the row/seed types and rowToSeed,
// kept apart from the reader so the canvas can seed conditions without
// loading the sheet graph. Invariants:
//   - wall protection and "No section" (unassigned) seed like the other
//     categories: a hatch of their own, 0% waste;
//   - a schedule's REMARKS ride into spec.remarks, and an empty REMARKS cell
//     adds no key at all (a condition without remarks looks as it always has).
import { test } from "node:test";
import assert from "node:assert/strict";
import { rowToSeed, type ScheduleRow } from "../src/lib/scheduleRows.ts";

const row = (o: Partial<ScheduleRow>): ScheduleRow => ({
  finish_tag: "X-1", section: "", category: "floor", category_source: "heading", description: "", manufacturer: "",
  style: "", spec_color: "", size: "", remarks: "", suggested: true, ...o,
});

test("wall protection seeds with a horizontal hatch and no waste", () => {
  const s = rowToSeed(row({ finish_tag: "CG-1", category: "wall_protection" }), 0, ["#111"]);
  assert.equal(s.hatch, "horiz");
  assert.equal(s.waste_pct, 0);
  assert.equal(s.category, "wall_protection");
});

test("a row with no section seeds solid with no waste", () => {
  const s = rowToSeed(row({ finish_tag: "PR-1", category: "unassigned", category_source: "none" }), 0, ["#111"]);
  assert.equal(s.hatch, "solid");
  assert.equal(s.waste_pct, 0);
  assert.equal(s.category, "unassigned");
});

test("REMARKS ride into spec.remarks; an empty cell adds no key", () => {
  const withRemarks = rowToSeed(row({ remarks: "ADHESIVE: VENDOR-K" }), 0);
  assert.equal(withRemarks.spec.remarks, "ADHESIVE: VENDOR-K");
  const without = rowToSeed(row({ remarks: "" }), 0);
  assert.ok(!("remarks" in without.spec), "no remarks key when the cell is empty");
  assert.deepEqual(Object.keys(without.spec), ["manufacturer", "style", "color", "size", "description"]);
});
