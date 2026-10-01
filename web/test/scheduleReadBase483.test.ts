// #483 PR A: the word-based base guess. Integral / sanitary /
// flash cove base name no item, and a base phrase after "<floor surface> W/ …"
// is part of the floor's description, not a base row. A base item that merely
// carries a qualifier ("RUBBER BASE W/ PREMOLDED CORNERS") is still base.
import { test } from "node:test";
import assert from "node:assert/strict";
import { b4 } from "../src/lib/scheduleRead.ts";

test("base guess: integral, sanitary and flash cove base are not base", () => {
  for (const s of ["INTEGRAL COVED BASE", "INTEGRAL BASE", "SANITARY COVE BASE", "SANITARY COVED BASE", "SANITARY BASE", "FLASH COVED BASE"])
    assert.equal(b4(s), "none", s);
});

test("base guess: a base phrase after a floor surface W/ or WITH is the floor's, not a base", () => {
  for (const s of [
    'EPOXY W/ 4" COVED BASE', "EPOXY FLOORING W/ 4 IN. COVE BASE", 'RESINOUS FLOORING W/ 6" BASE',
    "SHEET VINYL WITH INTEGRAL COVE BASE", "CONCRETE FLOORING W/ RUBBER BASE", "PORCELAIN TILE W/ COVE BASE",
  ]) assert.equal(b4(s), "none", s);
});

test("base guess: a real base row stays base", () => {
  for (const s of ["RUBBER BASE W/ PREMOLDED CORNERS", "VINYL BASE W/ PREMOLDED CORNERS", "RUBBER COVED BASE", "VINYL BASE", "TILE BASE", "CERAMIC TILE BASE"])
    assert.equal(b4(s), "base", s);
});
