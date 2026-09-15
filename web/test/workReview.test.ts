import test from "node:test";
import assert from "node:assert/strict";
import { filterWork, workActor, workQuantity, workReviewState } from "../src/lib/workReview.js";

test("review receipts distinguish missing state, pending work, and reviewed work", () => {
  assert.equal(workReviewState({}), "Recorded");
  assert.equal(workReviewState({ origin: { reviewed: false } }), "Needs review");
  assert.equal(workReviewState({ origin: { reviewed: true } }), "Reviewed");
  assert.equal(workActor({}), "Not recorded");
  assert.equal(workActor({ author: "Estimator" }), "Named author");
  assert.equal(workActor({ origin: { actor: "agent", method: "manual" } }), "Agent");
  assert.equal(workActor({ origin: { actor: "canvas" } }), "Canvas");
  assert.equal(workActor({ origin: { method: "rule_v1" } }), "Rule");
});

test("receipts retain zero, missing quantities, measurement units, and deduct roles", () => {
  assert.deepEqual(workQuantity({ measure_role: "count", computed: { count: 0, area_sf: 88 } }), { kind: "count", value: 0, deduct: false });
  assert.deepEqual(workQuantity({ measure_role: "linear", computed: { perimeter_lf: 12, area_sf: 3 } }), { kind: "length", value: 12, deduct: false });
  assert.deepEqual(workQuantity({ measure_role: "deduct", computed: { area_sf: 25 } }), { kind: "area", value: 25, deduct: true });
  assert.equal(workQuantity({ computed: { area_sf: NaN } }).value, null);
  assert.equal(workQuantity({}).value, null);
});

test("work filters search across sheets without mutating or accepting shapes", () => {
  const shapes = [
    { id: "one", sheet_id: "plan#2", author: "Estimator", origin: { reviewed: false } },
    { id: "two", sheet_id: "plan", label: "Level 3", origin: { actor: "agent", reviewed: true } },
    { id: "three", sheet_id: "plan" },
  ];
  const before = structuredClone(shapes);
  assert.deepEqual(filterWork(shapes, { filter: "pending" }).map((s: any) => s.id), ["one"]);
  assert.deepEqual(filterWork(shapes, { filter: "agent" }).map((s: any) => s.id), ["two"]);
  assert.deepEqual(filterWork(shapes, { query: " ESTIMATOR " }).map((s: any) => s.id), ["one"]);
  assert.deepEqual(filterWork(shapes, { query: "level 3" }).map((s: any) => s.id), ["two"]);
  assert.deepEqual(shapes, before);
});
