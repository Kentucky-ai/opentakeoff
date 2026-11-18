import test from "node:test";
import assert from "node:assert/strict";
import { countDiameterPt, countRadiusPx } from "../src/lib/countDisplay.ts";
import { RENDER_SCALE } from "../src/lib/takeoffConstants.ts";

test("explicit count footprints follow paper geometry at overview and working zoom", () => {
  const condition = Object.freeze({ count_diameter_pt: 36 });
  for (const zoom of [0.25, 1, 2.5]) {
    const screenDiameter = countRadiusPx(condition, zoom) * 2 * zoom;
    assert.equal(screenDiameter, 36 * RENDER_SCALE * zoom);
  }
  assert.equal(countDiameterPt(condition), 36);
});

test("absent and invalid display sizes retain the legacy 14-pixel pin", () => {
  for (const value of [undefined, null, 0, -1, NaN, Infinity, "36"]) {
    const condition = { count_diameter_pt: value };
    assert.equal(countDiameterPt(condition), null);
    for (const zoom of [0.25, 1, 2.5]) assert.equal(countRadiusPx(condition, zoom) * 2 * zoom, 14);
  }
});
