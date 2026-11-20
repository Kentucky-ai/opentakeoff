// Verify actual browser exports from the public-plan inspection regression.
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const read = async (name) => JSON.parse(await fs.readFile(new URL(name, import.meta.url), "utf8"));
const baseline = await read("before.takeoff.json");
const observations = await read("observations.json");
const byId = new Map(baseline.shapes.map((shape) => [shape.id, shape]));
const batch = new Set(observations.reviewed_ids);
assert.equal(batch.size, 28);
assert.equal(batch.has(observations.excluded_id), false);

for (const file of ["after-inspection.takeoff.json", "after-undo.takeoff.json", "after-reopen.takeoff.json"]) {
  const saved = await read(file);
  assert.deepEqual(saved.shapes, baseline.shapes, file);
  assert.deepEqual(saved.conditions, baseline.conditions, file);
  for (const sheet of baseline.sheets) {
    const match = saved.sheets.find((item) => item.sheet_id === sheet.sheet_id);
    for (const [key, value] of Object.entries(sheet)) assert.deepEqual(match?.[key], value, `${file}: ${key}`);
  }
  assert.equal(Object.keys(saved).some((key) => /selection/i.test(key)), false);
}

const reviewed = await read("after-review.takeoff.json");
assert.deepEqual(reviewed.conditions, baseline.conditions);
assert.deepEqual(reviewed.shapes.map((shape) => shape.id), baseline.shapes.map((shape) => shape.id));
for (const shape of reviewed.shapes) {
  const original = byId.get(shape.id);
  if (!batch.has(shape.id)) {
    assert.deepEqual(shape, original, `Unselected or previously reviewed: ${shape.id}`);
    continue;
  }
  assert.equal(original.origin.reviewed, false);
  assert.equal(shape.origin.reviewed, true);
  assert.ok(shape.origin.accepted_ts);
  const { reviewed: _reviewed, accepted_ts: _accepted, ...origin } = shape.origin;
  const { reviewed: _wasReviewed, accepted_ts: _wasAccepted, ...originalOrigin } = original.origin;
  assert.deepEqual(origin, originalOrigin);
  assert.deepEqual({ ...shape, origin: original.origin }, original);
}
assert.equal(reviewed.shapes.filter((shape) => shape.origin?.reviewed === false).length, 58);
console.log("PASS: inspection, Undo and reopening preserve all 89 records; only the 28 checked pending HA records change on review; the unchecked exception and three prior decisions remain intact.");
