// view_sheet's pure half: grid-spec math (image px per real foot). The drawing
// itself is covered by the conformance suite's rendered-image assertions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gridPxPerFoot } from "../src/view.ts";
import { UserError } from "../src/format.ts";

test("drawing-scale specs: inches-per-foot → image px per foot at render scale 2.0", () => {
  // 1/4" = 1'-0" → 0.25 in × 72 pt × 2 px/pt = 36 image px per real foot
  assert.equal(gridPxPerFoot("1/4", null), 36);
  assert.equal(gridPxPerFoot("0.25", null), 36);
  assert.equal(gridPxPerFoot("3/16", null), 27);
  assert.equal(gridPxPerFoot("1/8", null), 18);
  assert.equal(gridPxPerFoot(" 1/4 ", null), 36, "whitespace-tolerant");
});

test("auto: reciprocal of the sheet's upp; refused until the scale is set", () => {
  const fromAuto = gridPxPerFoot("auto", 1 / 36);
  assert.ok(fromAuto !== null && Math.abs(fromAuto - 36) < 1e-9, "auto agrees with the 1/4\" drawing scale");
  assert.throws(() => gridPxPerFoot("auto", null), UserError);
  assert.throws(() => gridPxPerFoot("auto", null), /set_scale/);
});

test("no grid asked for → null", () => {
  assert.equal(gridPxPerFoot(undefined, null), null);
  assert.equal(gridPxPerFoot("", null), null);
  assert.equal(gridPxPerFoot("   ", 1 / 36), null);
});

test("junk and out-of-range specs are clean UserErrors", () => {
  for (const bad of ["banana", "1/0", "0/4", "-1/4", "0", "20", "0.005"]) {
    assert.throws(() => gridPxPerFoot(bad, null), UserError, `spec ${JSON.stringify(bad)}`);
  }
  assert.throws(() => gridPxPerFoot("banana", null), /inches-per-foot/);
  assert.throws(() => gridPxPerFoot("20", null), /out of range/);
});
