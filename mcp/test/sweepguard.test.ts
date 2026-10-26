// #376 — the seed-too-common commit guard, pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepCommitRefusal, SEED_SEGMENTS_FLOOR, COMMON_MATCH_CEILING } from "../src/sweepGuard.ts";

test("the cleanout that started it: 31 segments, 104 found, no guard, no negatives — refused", () => {
  const r = sweepCommitRefusal({ seedSegments: 31, found: 104, variantGuard: false, negatives: 0 });
  assert.ok(r && /commit refused/.test(r));
  assert.match(r!, /variant_guard: true/);
  assert.match(r!, /exclude/);
});

test("the same sweep with variant_guard, or with a counter-example, commits — the caller is discriminating by hand", () => {
  assert.equal(sweepCommitRefusal({ seedSegments: 31, found: 104, variantGuard: true, negatives: 0 }), null);
  assert.equal(sweepCommitRefusal({ seedSegments: 31, found: 104, variantGuard: false, negatives: 1 }), null);
});

test("a bigger seed stands the guard down; a small seed under the ceiling commits", () => {
  assert.equal(sweepCommitRefusal({ seedSegments: SEED_SEGMENTS_FLOOR, found: 104, variantGuard: false, negatives: 0 }), null);
  assert.equal(sweepCommitRefusal({ seedSegments: 5, found: COMMON_MATCH_CEILING, variantGuard: false, negatives: 0 }), null, "the fixture's five drains from a five-segment seed are never refused");
  assert.ok(sweepCommitRefusal({ seedSegments: SEED_SEGMENTS_FLOOR - 1, found: COMMON_MATCH_CEILING + 1, variantGuard: false, negatives: 0 }));
});
