// Parity: every value the browser and the MCP server must agree on comes from
// web/src/lib/takeoffConstants.ts. These tests fail if a hand copy reappears
// anywhere in the web app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TAKEOFF_SCHEMA, REPORT_SCHEMA, RENDER_SCALE, PALETTE, HATCH_IDS, SNAP_CELL, SNAP_TOL, nextHatchId, nextPaletteColor } from "../src/lib/takeoffConstants.ts";
import { HATCHES, PALETTE as CANVAS_PALETTE } from "../src/components/hatches.jsx";
import { ANN_SCHEMA, emptyAnnotations } from "../src/lib/store.js";
import { reportJson } from "../src/lib/totals.js";
import { RENDER_SCALE as SHEETS_RENDER_SCALE } from "../src/lib/sheets.ts";
import { SNAP_CELL as CANVAS_SNAP_CELL } from "../src/lib/canvasConstants.js";
import { SNAP_CELL_PX, SNAP_TOL_PX } from "../src/lib/oneclick.ts";
import { parseTakeoffImport } from "../src/lib/importTakeoff.js";

test("the module imports nothing and is DOM-free", async () => {
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync(new URL("../src/lib/takeoffConstants.ts", import.meta.url), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // comments are prose, not code
  assert.equal(/^\s*import\s/m.test(code), false, "takeoffConstants must not import");
  assert.equal(/\b(document|window|localStorage|indexedDB|React)\b/.test(code), false, "takeoffConstants must be DOM-free");
});

test("hatch ids: the canvas HATCHES vocabulary is HATCH_IDS, in order", () => {
  assert.deepEqual(HATCHES.map((h: { id: string }) => h.id), [...HATCH_IDS]);
  assert.equal(HATCH_IDS.length, 31);
  assert.equal(HATCH_IDS[0], "solid");
});

test("palette: the canvas exports the shared list itself", () => {
  assert.equal(CANVAS_PALETTE, PALETTE);
  assert.equal(PALETTE.length, 10);
  assert.equal(PALETTE[0], "#c96442");
  assert.throws(() => { (PALETTE as string[]).push("#000000"); }, "PALETTE is frozen user data");
});

test("rotation: nextHatchId / nextPaletteColor are the formulas both minting paths used", () => {
  for (let n = 0; n < 70; n++) {
    assert.equal(nextHatchId(n), HATCHES[1 + (n % (HATCHES.length - 1))].id);
    assert.equal(nextPaletteColor(n), PALETTE[n % PALETTE.length]);
  }
  assert.notEqual(nextHatchId(0), "solid", "a new condition never lands on solid");
});

test("schema ids: store, report envelope and importer all read the shared ids", () => {
  assert.equal(ANN_SCHEMA, TAKEOFF_SCHEMA);
  assert.equal(TAKEOFF_SCHEMA, "opentakeoff.takeoff_canvas.v1");
  assert.equal(emptyAnnotations().schema, TAKEOFF_SCHEMA);
  assert.equal(reportJson({}).schema, REPORT_SCHEMA);
  assert.equal(REPORT_SCHEMA, "opentakeoff.report.v1");
  assert.throws(() => parseTakeoffImport(JSON.stringify({ schema: REPORT_SCHEMA })), new RegExp(TAKEOFF_SCHEMA.replace(/\./g, "\\.")));
});

test("frame and snap: sheets, canvasConstants and oneclick re-export the shared values", () => {
  assert.equal(SHEETS_RENDER_SCALE, RENDER_SCALE);
  assert.equal(RENDER_SCALE, 2.0);
  assert.equal(CANVAS_SNAP_CELL, SNAP_CELL);
  assert.equal(SNAP_CELL_PX, SNAP_CELL);
  assert.equal(SNAP_TOL_PX, SNAP_TOL);
  assert.equal(SNAP_CELL, 24);
  assert.equal(SNAP_TOL, 7);
});
