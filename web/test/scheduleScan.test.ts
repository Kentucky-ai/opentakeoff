// SCAN_MAX_DIM — the per-side cap a schedule raster is rendered to (a memory
// limit; lib/scheduleScan.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCAN_MAX_DIM } from "../src/lib/scheduleScan.js";

test("the schedule raster cap is 4096 px a side", () => {
  assert.equal(SCAN_MAX_DIM, 4096);
});
