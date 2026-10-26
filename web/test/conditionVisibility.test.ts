// Per-condition canvas visibility (#440) — the eye / isolate rules. The
// invariants under test:
//   - a plain click flips one condition and leaves the rest alone;
//   - ⌥-click isolates (hides every OTHER condition), and ⌥-click on the
//     already-isolated condition shows everything again;
//   - isolating a condition that is itself hidden reveals it;
//   - null / unknown id → show everything; deleted ids never linger;
//   - the input set is never mutated, and revealed() keeps identity when
//     there is nothing to reveal (no wasted React render).
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore — plain JS module
import { nextHidden, isIsolated, revealed } from "../src/lib/conditionVisibility.js";

const ALL = ["lighting", "power", "fire"];
const set = (...ids: string[]) => new Set(ids);
const ids = (s: Set<string>) => [...s].sort();

test("plain click flips one condition only", () => {
  const a = nextHidden(set(), "power", ALL);
  assert.deepEqual(ids(a), ["power"]);
  const b = nextHidden(a, "fire", ALL);
  assert.deepEqual(ids(b), ["fire", "power"]);
  assert.deepEqual(ids(nextHidden(b, "power", ALL)), ["fire"]);
});

test("isolate hides every other condition", () => {
  const h = nextHidden(set(), "power", ALL, { isolate: true });
  assert.deepEqual(ids(h), ["fire", "lighting"]);
  assert.equal(isIsolated(h, "power", ALL), true);
  assert.equal(isIsolated(h, "fire", ALL), false);
});

test("isolate on the isolated condition shows everything", () => {
  const h = nextHidden(set(), "power", ALL, { isolate: true });
  assert.equal(nextHidden(h, "power", ALL, { isolate: true }).size, 0);
});

test("isolate moves from one condition to another, and reveals a hidden target", () => {
  const h = nextHidden(set(), "power", ALL, { isolate: true });
  assert.deepEqual(ids(nextHidden(h, "fire", ALL, { isolate: true })), ["lighting", "power"]);
  assert.deepEqual(ids(nextHidden(set("power"), "power", ALL, { isolate: true })), ["fire", "lighting"]);
});

test("a lone condition is never 'isolated' into a no-op trap", () => {
  // one condition: isolating hides nothing; a second ⌥-click is still harmless
  const h = nextHidden(set(), "only", ["only"], { isolate: true });
  assert.equal(h.size, 0);
  assert.equal(nextHidden(h, "only", ["only"], { isolate: true }).size, 0);
});

test("null or unknown id shows everything; deleted ids are dropped", () => {
  assert.equal(nextHidden(set("power", "fire"), null, ALL).size, 0);
  assert.equal(nextHidden(set("power"), "gone", ALL).size, 0);
  assert.deepEqual(ids(nextHidden(set("deleted", "fire"), "power", ALL)), ["fire", "power"]);
});

test("never mutates its input; revealed() keeps identity when nothing changes", () => {
  const h = set("power");
  nextHidden(h, "fire", ALL);
  nextHidden(h, "fire", ALL, { isolate: true });
  assert.deepEqual(ids(h), ["power"]);
  assert.equal(revealed(h, "fire"), h);
  const r = revealed(h, "power");
  assert.notEqual(r, h);
  assert.equal(r.size, 0);
  assert.deepEqual(ids(h), ["power"]);
});
