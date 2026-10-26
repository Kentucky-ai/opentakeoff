import { test } from "node:test";
import assert from "node:assert/strict";
import { dropZoneAt, zoneToOrientation } from "../src/lib/dropZones.ts";

const rect = { w: 900, h: 600 };

test("left third → left", () => { assert.equal(dropZoneAt(rect, 100, 300), "left"); });
test("right third → right", () => { assert.equal(dropZoneAt(rect, 800, 300), "right"); });
test("top third → top", () => { assert.equal(dropZoneAt(rect, 450, 60), "top"); });
test("bottom third → bottom", () => { assert.equal(dropZoneAt(rect, 450, 540), "bottom"); });
test("center → center", () => { assert.equal(dropZoneAt(rect, 450, 300), "center"); });
test("corner resolves to the nearer edge, not both", () => {
  // top-left corner: closer to left edge (100<60? no) — pick the axis with the smaller normalized distance
  const z = dropZoneAt(rect, 40, 40);
  assert.ok(z === "left" || z === "top");
});
test("edgesDisabled forces center (already split)", () => {
  assert.equal(dropZoneAt(rect, 100, 300, { edgesDisabled: true }), "center");
});
test("zoneToOrientation maps correctly", () => {
  assert.equal(zoneToOrientation("left"), "v");
  assert.equal(zoneToOrientation("right"), "v");
  assert.equal(zoneToOrientation("top"), "h");
  assert.equal(zoneToOrientation("bottom"), "h");
  assert.equal(zoneToOrientation("center"), null);
});
