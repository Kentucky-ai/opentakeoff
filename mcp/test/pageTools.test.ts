import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { readFile, unlink, copyFile } from "node:fs/promises";
import { Session } from "../src/session.ts";
import { fileURLToPath } from "node:url";

const DEMO_PATH = fileURLToPath(new URL("../../web/public/demo/sample-finish-plan.pdf", import.meta.url));

test("MCP page tools: rotate_page, reorder_pages, extract_pages, merge_documents", async () => {
  // Use a copy in temp dir so we don't modify the public fixture on disk
  const tmpDir = os.tmpdir();
  const testPdf = path.join(tmpDir, `test-plan-${Date.now()}.pdf`);
  await copyFile(DEMO_PATH, testPdf);

  const session = new Session();
  await session.loadPlan(testPdf);

  const base = path.basename(testPdf);
  const sheet1Key = base;
  const sheet2Key = `${base}#2`;

  // Set scale on sheet 1
  session.setScale(sheet1Key, { upp: 0.027777777777777776 });

  // Add a shape to sheet 1
  const origRes = session.measurePolygon(
    sheet1Key,
    [
      [300, 300],
      [900, 300],
      [900, 700],
      [300, 700],
    ],
    { condition: "CPT-1", role: "floor_area" }
  );

  const origShape = session.shapes.find((s) => s.id === origRes.shape_id)!;
  const origArea = origRes.area_sf;
  const origPerim = origRes.perimeter_lf;

  // 1. rotate_page
  const rotRes = await session.rotatePage(sheet1Key, 90);
  assert.equal(rotRes.sheet, sheet1Key);
  assert.equal(rotRes.angle, 90);
  assert.equal(rotRes.shapes_transformed, 1);

  // Shape on sheet 1 should maintain the exact same computed area and perimeter
  const rotShape = session.shapes.find((s) => s.id === origShape.id)!;
  assert.equal(rotShape.computed.area_sf, origArea);
  assert.equal(rotShape.computed.perimeter_lf, origPerim);

  // Rotate 3 more times to complete 360°
  await session.rotatePage(sheet1Key, 90);
  await session.rotatePage(sheet1Key, 90);
  await session.rotatePage(sheet1Key, 90);

  const finalShape = session.shapes.find((s) => s.id === origShape.id)!;
  assert.equal(finalShape.computed.area_sf, origArea);
  assert.equal(finalShape.computed.perimeter_lf, origPerim);

  // 2. reorder_pages: swap page 1 and page 2
  const reorderRes = await session.reorderPages(base, [2, 1]);
  assert.equal(reorderRes.file, base);
  assert.deepEqual(reorderRes.order, [2, 1]);
  assert.equal(reorderRes.shapes_remapped, 1);

  // Shape that was on page 1 is now on page 2 (sheet2Key)
  const movedShape = session.shapes.find((s) => s.id === origShape.id)!;
  assert.equal(movedShape.sheet_id, sheet2Key);

  // 3. extract_pages: extract page 2 (which now holds the shape)
  const extractPath = path.join(tmpDir, `test-extract-${Date.now()}.pdf`);
  const extractRes = await session.extractPages(base, [2], extractPath, true);
  assert.equal(extractRes.page_count, 1);
  assert.equal(extractRes.shapes_carried, 1);

  const extractBytes = await readFile(extractPath);
  assert.ok(extractBytes.length > 0);

  // 4. merge_documents: merge testPdf and extractPath into a combined document
  const mergePath = path.join(tmpDir, `test-merge-${Date.now()}.pdf`);
  const mergeRes = await session.mergeDocuments([testPdf, extractPath], mergePath, true);
  assert.equal(mergeRes.total_pages, 3); // 2 pages from testPdf + 1 page from extractPath

  const mergeBytes = await readFile(mergePath);
  assert.ok(mergeBytes.length > 0);

  // Clean up temp files
  await unlink(testPdf).catch(() => {});
  await unlink(extractPath).catch(() => {});
  await unlink(mergePath).catch(() => {});
});
