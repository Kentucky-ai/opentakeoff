// The condition multiplier rule (#455): absent = ×1, otherwise a finite
// number > 0. Import refuses a bad value (importTakeoff.test.ts); a project
// saved before that guard is repaired on load to what it already billed at.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidMultiplier, repairConditionMultipliers, describeMultiplierRepair } from "../src/lib/multiplier.js";
import { conditionTotals } from "../src/lib/totals.js";
import { isDangerMsg } from "../src/lib/canvasUtil.js";

test("isValidMultiplier matches edit_condition's z.number().positive() plus 'absent'", () => {
  for (const v of [1, 2, 0.5, 12, undefined, null]) assert.equal(isValidMultiplier(v), true, String(v));
  for (const v of [0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, "2", "abc", "", true, {}, []]) assert.equal(isValidMultiplier(v), false, String(v));
});

test("load repair: bad values fall to what the report already billed, good ones keep identity", () => {
  const good = { id: "g", finish_tag: "OK", multiplier: 3 };
  const bare = { id: "b", finish_tag: "BARE" };
  const { conditions, repaired } = repairConditionMultipliers([
    good, bare,
    { id: "z", finish_tag: "ZERO", multiplier: 0 },
    { id: "n", finish_tag: "NEG", multiplier: -2 },
    { id: "j", finish_tag: "JUNK", multiplier: "abc" },
    { id: "s", finish_tag: "STR", multiplier: "3" },
  ]);
  assert.equal(conditions[0], good);   // untouched conditions are the same object
  assert.equal(conditions[1], bare);
  assert.deepEqual(conditions.slice(2).map((c: any) => c.multiplier), [1, 1, 1, 3]);
  assert.deepEqual(repaired.map((r) => r.finish_tag), ["ZERO", "NEG", "JUNK", "STR"]);
  const msg = describeMultiplierRepair(repaired);
  assert.equal(msg, 'Couldn\'t load 4 condition multipliers as saved (must be a positive number) — reset: ZERO 0 → ×1, NEG -2 → ×1, JUNK "abc" → ×1, STR "3" → ×3. Check these quantities.');
  assert.equal(isDangerMsg(msg), true);   // sticky: a changed quantity must not age out unread
  assert.match(describeMultiplierRepair(repaired.slice(0, 1)), /^Couldn't load a condition multiplier as saved/);
  assert.equal(describeMultiplierRepair([]), "");
});

test("the issue's repro, after repair: no ×0-as-×1 surprise, no negative, no NaN in totals", () => {
  const { conditions } = repairConditionMultipliers([
    { id: "x0", finish_tag: "ZERO", multiplier: 0 },
    { id: "xneg", finish_tag: "NEG", multiplier: -2 },
    { id: "xstr", finish_tag: "JUNK", multiplier: "abc" },
  ]);
  const shapes = conditions.map((c: any) => ({ condition_id: c.id, measure_role: "floor_area", computed: { area_sf: 1000, perimeter_lf: 130 } }));
  for (const r of conditionTotals(conditions, shapes)) {
    assert.equal(r.floor_sf, 1000, r.finish_tag);
    assert.equal(r.multiplier, 1, r.finish_tag);
  }
});

test("non-array input is empty, not a throw", () => {
  assert.deepEqual(repairConditionMultipliers(undefined as any), { conditions: [], repaired: [] });
});
