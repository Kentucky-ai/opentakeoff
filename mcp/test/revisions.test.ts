import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
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
  assert.deepEqual(resSame.alignment, { dx: 0, dy: 0, confidence: 1, method: "identity" });
  const extracted = await session.sheetVectors(sheets[0].sheet, { limit: 1 });
  assert.equal(resSame.stats.unchanged_segments, extracted.total, "every extracted segment matches itself");
  assert.equal(resSame.stats.removed_segments, 0);
  assert.equal(resSame.stats.added_segments, 0);
  assert.equal(resSame.flagged_shape_ids.length, 0);

  // Compare sheet 1 with sheet 2 (different sheets)
  const resDiff = await session.compareSheets(sheets[0].sheet, sheets[1].sheet);
  assert.equal(resDiff.diff_method, "vector");
  assert.ok(resDiff.stats.removed_segments > 0 || resDiff.stats.added_segments > 0);
  assert.ok(Array.isArray(resDiff.changed_regions));
  const incoming = await session.sheetVectors(sheets[1].sheet, { limit: 1 });
  assert.equal(resDiff.stats.unchanged_segments + resDiff.stats.removed_segments, extracted.total);
  assert.equal(resDiff.stats.unchanged_segments + resDiff.stats.added_segments, incoming.total);
});

test("compare_sheets reports one shared, one removed, and one added PDF segment", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "opentakeoff-revision-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const pdf = await PDFDocument.create();
  const base = pdf.addPage([300, 200]);
  const revised = pdf.addPage([300, 200]);
  for (const page of [base, revised]) {
    page.drawLine({ start: { x: 20, y: 160 }, end: { x: 40, y: 160 }, thickness: 1 });
  }
  base.drawLine({ start: { x: 80, y: 120 }, end: { x: 110, y: 120 }, thickness: 1 });
  revised.drawLine({ start: { x: 180, y: 60 }, end: { x: 215, y: 60 }, thickness: 1 });
  const file = path.join(scratch, "revision.pdf");
  await writeFile(file, await pdf.save());

  const session = new Session();
  const { sheets } = await session.loadPlan(file);
  const result = await session.compareSheets(sheets[0].sheet, sheets[1].sheet, { dx: 0, dy: 0 });
  assert.deepEqual(result.stats, { unchanged_segments: 1, removed_segments: 1, added_segments: 1 });
  assert.deepEqual(result.alignment, { dx: 0, dy: 0, confidence: 1, method: "manual" });
  assert.deepEqual(result.changed_regions.map((region) => [region.type, region.bounds]), [
    ["removed", [160, 160, 220, 160]],
    ["added", [360, 280, 430, 280]],
  ]);
});
