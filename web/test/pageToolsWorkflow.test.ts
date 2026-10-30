import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import {
  rotateNormalizedPoint,
  rotateShape,
  rotatedSheetDims,
  buildKeyRemap,
  remapTakeoffSheetKeys,
  formatSheetKey,
} from "../src/lib/pageTransforms.ts";
import {
  rotatePdfPage,
  reorderPdfPages,
  extractPdfPages,
  mergePdfDocuments,
} from "../src/lib/pdfPageTools.ts";
import { computeShapeMetrics } from "../src/lib/shapeMetrics.js";
import { conditionTotals } from "../src/lib/totals.js";

const DEMO_PATH = fileURLToPath(new URL("../public/demo/sample-finish-plan.pdf", import.meta.url));
const demoBytes = new Uint8Array(readFileSync(DEMO_PATH));

test("Finish line 1: rotate sheet 1 by 90° four times; area, perimeter and vertices match within 0.01 px", async () => {
  const doc = await PDFDocument.load(demoBytes);
  const p1 = doc.getPage(0);
  const origDims = { w: p1.getWidth() * 2, h: p1.getHeight() * 2 }; // RENDER_SCALE = 2.0
  const upp = 0.027777777777777776; // 1/36 ft/px (1/4" = 1'-0")

  // Sample room on sheet 1
  const origShape = {
    id: "room-101",
    sheet_id: "sample-finish-plan.pdf",
    condition_id: "cpt-1",
    measure_role: "floor_area",
    verts_norm: [
      [0.2, 0.25],
      [0.65, 0.25],
      [0.65, 0.55],
      [0.45, 0.55],
      [0.45, 0.7],
      [0.2, 0.7],
    ] as [number, number][],
    origin: {
      seed_norm: [0.3, 0.4] as [number, number],
      reviewed: true,
      reviewed_by: "estimator",
    },
  };

  const initialMetrics = computeShapeMetrics(origShape, origDims, upp, null);

  let curShape = origShape;
  let curDims = origDims;
  let pdfBytes: Uint8Array = demoBytes;

  // Rotate 90° three times, then once more (total 4)
  for (let step = 1; step <= 4; step++) {
    curShape = rotateShape(curShape, 90);
    curDims = rotatedSheetDims(curDims, 90);
    pdfBytes = await rotatePdfPage(pdfBytes, 1, 90);

    const stepMetrics = computeShapeMetrics(curShape, curDims, upp, null);
    assert.equal(stepMetrics.area_sf, initialMetrics.area_sf, `Step ${step}: area_sf matches exactly`);
    assert.equal(stepMetrics.perimeter_lf, initialMetrics.perimeter_lf, `Step ${step}: perimeter_lf matches exactly`);
  }

  // After 4 full quarter-turns, every vertex returns within 0.01 px
  for (let i = 0; i < origShape.verts_norm.length; i++) {
    const [origX, origY] = origShape.verts_norm[i];
    const [finalX, finalY] = curShape.verts_norm[i];
    const driftX_px = Math.abs(finalX - origX) * origDims.w;
    const driftY_px = Math.abs(finalY - origY) * origDims.h;
    assert.ok(driftX_px < 0.01, `Vertex ${i} X drift (${driftX_px}px) < 0.01 px`);
    assert.ok(driftY_px < 0.01, `Vertex ${i} Y drift (${driftY_px}px) < 0.01 px`);
  }

  // Verify PDF rotation angle returned to initial
  const finalDoc = await PDFDocument.load(pdfBytes);
  assert.equal(finalDoc.getPage(0).getRotation().angle, p1.getRotation().angle);
});

test("Finish line 2: merge, reorder, extract with takeoff following its page and totals matching", async () => {
  // Setup: 2 two-page documents
  const conditions = [
    { id: "c1", finish_tag: "CPT-1" },
    { id: "c2", finish_tag: "VCT-1" },
  ];

  // Document A: sample-finish-plan.pdf (2 pages)
  // Shape A1 on Page 1, Shape A2 on Page 2
  const docAShapes = [
    {
      id: "sa1",
      sheet_id: "planA.pdf",
      condition_id: "c1",
      measure_role: "floor_area",
      computed: { area_sf: 150.5, perimeter_lf: 50 },
    },
    {
      id: "sa2",
      sheet_id: "planA.pdf#2",
      condition_id: "c2",
      measure_role: "floor_area",
      computed: { area_sf: 200.0, perimeter_lf: 60 },
    },
  ];

  // Document B: planB.pdf (2 pages)
  // Shape B1 on Page 1
  const docBShapes = [
    {
      id: "sb1",
      sheet_id: "planB.pdf",
      condition_id: "c1",
      measure_role: "floor_area",
      computed: { area_sf: 75.25, perimeter_lf: 35 },
    },
  ];

  const initialTotalsA = conditionTotals(conditions, docAShapes);
  const initialTotalsB = conditionTotals(conditions, docBShapes);
  const totalCptInitial = (initialTotalsA.find((r: any) => r.id === "c1")?.total_sf || 0) +
                          (initialTotalsB.find((r: any) => r.id === "c1")?.total_sf || 0);
  assert.equal(totalCptInitial, 225.75);

  // 1. Merge planA and planB into merged.pdf (4 pages total)
  // Page 1: planA p1 -> merged.pdf
  // Page 2: planA p2 -> merged.pdf#2
  // Page 3: planB p1 -> merged.pdf#3
  // Page 4: planB p2 -> merged.pdf#4
  const mergedPdfBytes = await mergePdfDocuments([demoBytes, demoBytes]);
  const mergedDoc = await PDFDocument.load(mergedPdfBytes);
  assert.equal(mergedDoc.getPageCount(), 4);

  const mergedRemap: Record<string, string> = {
    "planA.pdf": "merged.pdf",
    "planA.pdf#2": "merged.pdf#2",
    "planB.pdf": "merged.pdf#3",
    "planB.pdf#2": "merged.pdf#4",
  };

  const mergedTakeoff = remapTakeoffSheetKeys(
    { shapes: [...docAShapes, ...docBShapes] },
    mergedRemap
  );

  const mergedTotals = conditionTotals(conditions, mergedTakeoff.shapes);
  const cptMerged = mergedTotals.find((r: any) => r.id === "c1")?.total_sf;
  assert.equal(cptMerged, totalCptInitial);

  // 2. Reorder pages: swap page 1 and page 2 of merged.pdf -> [2, 1, 3, 4]
  const reorderedPdfBytes = await reorderPdfPages(mergedPdfBytes, [2, 1, 3, 4]);
  const reorderRemap = buildKeyRemap("merged.pdf", { 1: 2, 2: 1, 3: 3, 4: 4 }, 4);
  const reorderedTakeoff = remapTakeoffSheetKeys(mergedTakeoff, reorderRemap);

  // The shape that was on page 1 ("sa1") is now on page 2 ("merged.pdf#2")
  const sa1 = reorderedTakeoff.shapes.find((s: any) => s.id === "sa1");
  assert.equal(sa1.sheet_id, "merged.pdf#2");

  // The shape that was on page 2 ("sa2") is now on page 1 ("merged.pdf")
  const sa2 = reorderedTakeoff.shapes.find((s: any) => s.id === "sa2");
  assert.equal(sa2.sheet_id, "merged.pdf");

  // Totals still match exactly
  const reorderedTotals = conditionTotals(conditions, reorderedTakeoff.shapes);
  assert.equal(reorderedTotals.find((r: any) => r.id === "c1")?.total_sf, totalCptInitial);

  // 3. Extract pages: extract page 2 and page 3 into extracted.pdf
  // New Page 1 was Page 2 (sa1)
  // New Page 2 was Page 3 (sb1)
  const extractedPdfBytes = await extractPdfPages(reorderedPdfBytes, [2, 3]);
  const extractedDoc = await PDFDocument.load(extractedPdfBytes);
  assert.equal(extractedDoc.getPageCount(), 2);

  const extractRemap: Record<string, string | null> = {
    "merged.pdf": null, // Page 1 dropped
    "merged.pdf#2": "extracted.pdf", // Page 2 becomes Page 1
    "merged.pdf#3": "extracted.pdf#2", // Page 3 becomes Page 2
    "merged.pdf#4": null, // Page 4 dropped
  };

  const extractedTakeoff = remapTakeoffSheetKeys(reorderedTakeoff, extractRemap);
  assert.equal(extractedTakeoff.shapes.length, 2);
  assert.equal(extractedTakeoff.shapes.find((s: any) => s.id === "sa1").sheet_id, "extracted.pdf");
  assert.equal(extractedTakeoff.shapes.find((s: any) => s.id === "sb1").sheet_id, "extracted.pdf#2");

  // Both sa1 (150.5) and sb1 (75.25) are CPT-1
  const extractedTotals = conditionTotals(conditions, extractedTakeoff.shapes);
  assert.equal(extractedTotals.find((r: any) => r.id === "c1")?.total_sf, 150.5 + 75.25);
});

