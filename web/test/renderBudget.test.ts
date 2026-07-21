// autoRenderScale — the base-raster budget contract. The floor at RENDER_SCALE
// must never override the physical caps: an ingested image is a 1px=1pt page,
// so a large scan mints a page thousands of points wide, and rendering it at
// the ×2 baseline builds a canvas past the panel budget — Chrome then composites
// a degraded low-res proxy (the "jagged linework" bug, 2026-07-20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { autoRenderScale } from "../src/lib/canvasUtil.js";
import { RENDER_SCALE } from "../src/lib/sheets";
import { MAX_PANEL_AREA, MAX_CANVAS_DIM, QUALITY_CEILING } from "../src/lib/canvasConstants.js";

const areaAt = (w: number, h: number, s: number) => w * s * (h * s);

test("normal plan pages keep the ×2 baseline (budget cap far above it)", () => {
  // ARCH D 36×24in = 2592×1728 pt
  assert.equal(Math.min(RENDER_SCALE, autoRenderScale(2592, 1728)), RENDER_SCALE);
  assert.ok(autoRenderScale(2592, 1728) >= RENDER_SCALE);
});

test("small pages ride the quality ceiling, not the floor", () => {
  // 500×600 pt: the area budget would allow >8× — the ceiling binds instead
  assert.equal(autoRenderScale(500, 600), QUALITY_CEILING);
});

test("an oversized 1px=1pt image page renders BELOW baseline, inside the panel budget", () => {
  // the finishplan-17 case: a 7920×5280 px scan → 7920×5280 pt page
  const s = autoRenderScale(7920, 5280);
  assert.ok(s < RENDER_SCALE, `scale ${s} must drop below the ×2 baseline`);
  assert.ok(areaAt(7920, 5280, s) <= MAX_PANEL_AREA * 1.0001, "canvas area within MAX_PANEL_AREA");
  assert.ok(7920 * s <= MAX_CANVAS_DIM && 5280 * s <= MAX_CANVAS_DIM, "within the per-side cap");
  assert.ok(s > 0.5, "still a usable working resolution");
});

test("degenerate dims fall back to the baseline", () => {
  assert.equal(autoRenderScale(0, 0), RENDER_SCALE);
  assert.equal(autoRenderScale(-1, 100), RENDER_SCALE);
});
