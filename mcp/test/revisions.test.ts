import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "../src/session.ts";

const DEMO = fileURLToPath(new URL("../../demo/sample-finish-plan.pdf", import.meta.url));

test("compare_sheets compares two sheets, computes diff and returns changed regions and stats", async () => {
  const session = new Session();
  const loaded = await session.loadPlan(DEMO);
  const sheets = loaded.sheets;
  assert.ok(sheets.length >= 2, "sample plan has at least two sheets");

  // Add a shape to sheet 1
  session.conditions.push({ id: "cnd-test", finish_tag: "CPT-TEST", description: "Carpet Test", color: "#1f3fc7" } as any);
  session.shapes.push({
    id: "shp-test",
    sheet_id: sheets[0].sheet,
    condition_id: "cnd-test",
    measure_role: "floor_area",
    verts_norm: [
      [0.2, 0.2],
      [0.3, 0.2],
      [0.3, 0.3],
      [0.2, 0.3],
    ],
    origin: { method: "manual", actor: "agent", reviewed: true },
  } as any);

  // Compare sheet 1 with sheet 1 (identical)
  const resSame = await session.compareSheets(sheets[0].sheet, sheets[0].sheet);
  assert.equal(resSame.diff_method, "vector");
  assert.equal(resSame.stats.removed_segments, 0);
  assert.equal(resSame.stats.added_segments, 0);
  assert.equal(resSame.flagged_shape_ids.length, 0);

  // Compare sheet 1 with sheet 2 (different sheets)
  const resDiff = await session.compareSheets(sheets[0].sheet, sheets[1].sheet);
  assert.equal(resDiff.diff_method, "vector");
  assert.ok(resDiff.stats.removed_segments > 0 || resDiff.stats.added_segments > 0);
  assert.ok(Array.isArray(resDiff.changed_regions));
});
