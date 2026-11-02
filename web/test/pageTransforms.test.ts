import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rotateNormalizedPoint,
  rotateNormalizedRing,
  rotateNormalizedRect,
  rotatedSheetDims,
  rotateShape,
  rotateMarkup,
  rotateApproval,
  rotateTakeoffOnSheet,
  buildKeyRemap,
  remapTakeoffSheetKeys,
  remapWorkspaceState,
  formatSheetKey,
} from "../src/lib/pageTransforms.ts";
import { computeShapeMetrics } from "../src/lib/shapeMetrics.js";

test("rotateNormalizedPoint: 4 consecutive 90° rotations return to the exact starting point", () => {
  const original: [number, number] = [0.245, 0.789];
  const r90 = rotateNormalizedPoint(original, 90);
  assert.deepEqual(r90, [1 - 0.789, 0.245]);

  const r180 = rotateNormalizedPoint(r90, 90);
  assert.deepEqual(r180, [1 - 0.245, 1 - 0.789]);

  const r270 = rotateNormalizedPoint(r180, 90);
  assert.deepEqual(r270, [0.789, 1 - 0.245]);

  const r360 = rotateNormalizedPoint(r270, 90);
  assert.ok(Math.abs(r360[0] - original[0]) < 1e-12);
  assert.ok(Math.abs(r360[1] - original[1]) < 1e-12);
});

test("rotateShape: 4 x 90° rotation preserves area and perimeter to last decimal", () => {
  const dims = { w: 3000, h: 2000 };
  const upp = 0.05; // 0.05 ft per px

  // An L-shaped room
  const shape = {
    id: "shape-1",
    sheet_id: "plan.pdf",
    condition_id: "cond-1",
    measure_role: "floor_area",
    verts_norm: [
      [0.1, 0.1],
      [0.5, 0.1],
      [0.5, 0.3],
      [0.3, 0.3],
      [0.3, 0.6],
      [0.1, 0.6],
    ] as [number, number][],
    origin: {
      seed_norm: [0.2, 0.2] as [number, number],
      reviewed: true,
      reviewed_by: "human@test",
    },
  };

  const initialMetrics = computeShapeMetrics(shape, dims, upp, null);

  let currentShape = shape;
  let currentDims = dims;

  for (let step = 1; step <= 4; step++) {
    currentShape = rotateShape(currentShape, 90);
    currentDims = rotatedSheetDims(currentDims, 90);
    const stepMetrics = computeShapeMetrics(currentShape, currentDims, upp, null);

    // Area and perimeter must match to the exact decimal at every 90° step
    assert.equal(stepMetrics.area_sf, initialMetrics.area_sf);
    assert.equal(stepMetrics.perimeter_lf, initialMetrics.perimeter_lf);
  }

  // After 4 rotations, all vertices must be within 0.01 px (actually within 1e-9)
  for (let i = 0; i < shape.verts_norm.length; i++) {
    const orig = shape.verts_norm[i];
    const fin = currentShape.verts_norm[i];
    const diffX_px = Math.abs(fin[0] - orig[0]) * dims.w;
    const diffY_px = Math.abs(fin[1] - orig[1]) * dims.h;
    assert.ok(diffX_px < 0.01, `vertex ${i} X drift ${diffX_px} < 0.01 px`);
    assert.ok(diffY_px < 0.01, `vertex ${i} Y drift ${diffY_px} < 0.01 px`);
  }

  // Human review state remains intact
  assert.equal(currentShape.origin.reviewed, true);
  assert.equal(currentShape.origin.reviewed_by, "human@test");
  assert.ok(Math.abs(currentShape.origin.seed_norm[0] - shape.origin.seed_norm[0]) < 1e-12);
  assert.ok(Math.abs(currentShape.origin.seed_norm[1] - shape.origin.seed_norm[1]) < 1e-12);
});

test("rotateMarkup: transforms callout, arrow, cloud rect, and image", () => {
  const dims = { w: 2000, h: 1000 };

  const callout = {
    id: "m-1",
    sheet_id: "plan.pdf",
    type: "callout",
    at: [0.2, 0.3] as [number, number],
    target: [0.4, 0.5] as [number, number],
  };

  const rotCallout = rotateMarkup(callout, 90, dims);
  assert.deepEqual(rotCallout.at, [1 - 0.3, 0.2]);
  assert.deepEqual(rotCallout.target, [1 - 0.5, 0.4]);

  const cloud = {
    id: "m-2",
    sheet_id: "plan.pdf",
    type: "cloud",
    rect: [[0.1, 0.2], [0.4, 0.6]] as [[number, number], [number, number]],
  };

  const rotCloud = rotateMarkup(cloud, 90, dims);
  // [0.1, 0.2] -> [0.8, 0.1]; [0.4, 0.6] -> [0.4, 0.4]
  // Normalized rect: min [0.4, 0.1], max [0.8, 0.4]
  assert.deepEqual(rotCloud.rect, [[0.4, 0.1], [0.8, 0.4]]);

  // Image markup placed dimensions
  const imgMarkup = {
    id: "m-3",
    sheet_id: "plan.pdf",
    type: "image",
    at: [0.5, 0.5] as [number, number],
    w: 0.2,
    aspect: 1.5,
  };
  // Original pixel size: bw = 0.2 * 2000 = 400, bh = 400 * 1.5 = 600
  // When rotated 90°, new sheet dims: w' = 1000, h' = 2000
  // New pixel size: bw' = 600, bh' = 400
  // New w = bw' / w' = 600 / 1000 = 0.6
  // New aspect = bh' / bw' = 400 / 600 = 1 / 1.5
  const rotImg = rotateMarkup(imgMarkup, 90, dims);
  assert.equal(rotImg.aspect, 1 / 1.5);
  assert.equal(rotImg.w, 0.6);

  // 4 rotations on image return to original w and aspect
  let img = imgMarkup;
  let curDims = dims;
  for (let i = 0; i < 4; i++) {
    img = rotateMarkup(img, 90, curDims);
    curDims = rotatedSheetDims(curDims, 90);
  }
  assert.ok(Math.abs(img.w - imgMarkup.w) < 1e-12);
  assert.ok(Math.abs(img.aspect - imgMarkup.aspect) < 1e-12);
});

test("formatSheetKey and buildKeyRemap", () => {
  assert.equal(formatSheetKey("doc.pdf", 1), "doc.pdf");
  assert.equal(formatSheetKey("doc.pdf", 2), "doc.pdf#2");
  assert.equal(formatSheetKey("doc.pdf", 5), "doc.pdf#5");

  // Reorder 3 pages: page 2 becomes 1, page 1 becomes 2, page 3 stays 3
  const remap = buildKeyRemap("doc.pdf", { 1: 2, 2: 1, 3: 3 }, 3);
  assert.equal(remap.get("doc.pdf"), "doc.pdf#2");
  assert.equal(remap.get("doc.pdf#2"), "doc.pdf");
  assert.equal(remap.get("doc.pdf#3"), "doc.pdf#3");
});

test("remapTakeoffSheetKeys: updates shapes, markups, sheets, tabs, approvals", () => {
  const takeoff = {
    shapes: [
      { id: "s1", sheet_id: "doc.pdf" },
      { id: "s2", sheet_id: "doc.pdf#2" },
      { id: "s3", sheet_id: "other.pdf" },
    ],
    markups: [
      { id: "m1", sheet_id: "doc.pdf" },
      { id: "m2", sheet_id: "doc.pdf#2", src_sheet_id: "doc.pdf" },
    ],
    sheets: [
      { sheet_id: "doc.pdf", units_per_px: 0.05 },
      { sheet_id: "doc.pdf#2", units_per_px: 0.05 },
    ],
    sheet_tabs: ["doc.pdf", "doc.pdf#2", "other.pdf"],
    approvals: [{ id: "a1", sheet_id: "doc.pdf" }],
  };

  // Swap page 1 and page 2
  const remap = buildKeyRemap("doc.pdf", { 1: 2, 2: 1 }, 2);
  const remapped = remapTakeoffSheetKeys(takeoff, remap);

  assert.equal(remapped.shapes[0].sheet_id, "doc.pdf#2");
  assert.equal(remapped.shapes[1].sheet_id, "doc.pdf");
  assert.equal(remapped.shapes[2].sheet_id, "other.pdf");

  assert.equal(remapped.markups[0].sheet_id, "doc.pdf#2");
  assert.equal(remapped.markups[1].sheet_id, "doc.pdf");
  assert.equal(remapped.markups[1].src_sheet_id, "doc.pdf#2");

  assert.equal(remapped.sheets[0].sheet_id, "doc.pdf#2");
  assert.equal(remapped.sheets[1].sheet_id, "doc.pdf");

  assert.deepEqual(remapped.sheet_tabs, ["doc.pdf#2", "doc.pdf", "other.pdf"]);
  assert.equal(remapped.approvals[0].sheet_id, "doc.pdf#2");
});

test("remapWorkspaceState: remaps all 11+ per-sheet maps, swapping scales when pages reorder", () => {
  // Two sheets at DIFFERENT scales:
  // Sheet 1 (AF101 / doc.pdf): 1/8" = 1'-0" (upp ~ 0.027778)
  // Sheet 2 (AF600 / doc.pdf#2): 1/4" = 1'-0" (upp ~ 0.055556)
  const state = {
    shapes: [
      { id: "s1", sheet_id: "doc.pdf" },
      { id: "s2", sheet_id: "doc.pdf#2" },
    ],
    markups: [
      { id: "m1", sheet_id: "doc.pdf" },
    ],
    approvals: [
      { id: "a1", sheet_id: "doc.pdf" },
    ],
    scales: {
      "doc.pdf": 0.027777777777777776,
      "doc.pdf#2": 0.05555555555555555,
    },
    scaleSources: {
      "doc.pdf": "standard",
      "doc.pdf#2": "calibrated",
    },
    scaleUnconfirmed: {
      "doc.pdf#2": true,
    } as Record<string, boolean>,
    sheetLevels: {
      "doc.pdf": "L1",
      "doc.pdf#2": "L2",
    } as Record<string, string>,
    sheetGroup: ["doc.pdf", "doc.pdf#2"],
    lastGroup: ["doc.pdf"],
    openTabs: ["doc.pdf", "doc.pdf#2"],
    stitches: [
      {
        id: "stitch-1",
        members: [{ key: "doc.pdf", x: 0, y: 0 }, { key: "doc.pdf#2", x: 100, y: 0 }],
      },
    ],
    layerOverrides: {
      "doc.pdf": { ocg1: "exclude" },
    } as Record<string, any>,
    rfis: [
      { id: "rfi-1", sheet_id: "doc.pdf" },
    ],
  };

  // Reorder: swap page 1 and page 2 ([2, 1])
  const remap = buildKeyRemap("doc.pdf", { 1: 2, 2: 1 }, 2);
  const remapped = remapWorkspaceState(state, remap);

  // Scales must swap with their sheets:
  // Page 1 now has 1/4", Page 2 now has 1/8"
  assert.equal(remapped.scales["doc.pdf"], 0.05555555555555555);
  assert.equal(remapped.scales["doc.pdf#2"], 0.027777777777777776);

  // Scale sources and unconfirmed flags swap
  assert.equal(remapped.scaleSources["doc.pdf"], "calibrated");
  assert.equal(remapped.scaleSources["doc.pdf#2"], "standard");
  assert.equal(remapped.scaleUnconfirmed["doc.pdf"], true);
  assert.equal(remapped.scaleUnconfirmed["doc.pdf#2"], undefined);

  // Sheet levels swap
  assert.equal(remapped.sheetLevels["doc.pdf"], "L2");
  assert.equal(remapped.sheetLevels["doc.pdf#2"], "L1");

  // Tabs and groups
  assert.deepEqual(remapped.openTabs, ["doc.pdf#2", "doc.pdf"]);
  assert.deepEqual(remapped.sheetGroup, ["doc.pdf#2", "doc.pdf"]);
  assert.deepEqual(remapped.lastGroup, ["doc.pdf#2"]);

  // Stitches
  assert.equal(remapped.stitches[0].members[0].key, "doc.pdf#2");
  assert.equal(remapped.stitches[0].members[1].key, "doc.pdf");

  // Layer overrides and rfis
  assert.deepEqual(remapped.layerOverrides["doc.pdf#2"], { ocg1: "exclude" });
  assert.equal(remapped.rfis[0].sheet_id, "doc.pdf#2");

  // Shapes and markups
  assert.equal(remapped.shapes[0].sheet_id, "doc.pdf#2");
  assert.equal(remapped.shapes[1].sheet_id, "doc.pdf");
  assert.equal(remapped.markups[0].sheet_id, "doc.pdf#2");
  assert.equal(remapped.approvals[0].sheet_id, "doc.pdf#2");
});

test("remapWorkspaceState: deletion drops the deleted sheet across all maps and shifts later sheets", () => {
  const state = {
    shapes: [
      { id: "s1", sheet_id: "doc.pdf" },
      { id: "s2", sheet_id: "doc.pdf#2" },
      { id: "s3", sheet_id: "doc.pdf#3" },
    ],
    scales: {
      "doc.pdf": 0.02,
      "doc.pdf#2": 0.04,
      "doc.pdf#3": 0.08,
    },
    openTabs: ["doc.pdf", "doc.pdf#2", "doc.pdf#3"],
    sheetLevels: {
      "doc.pdf": "L1",
      "doc.pdf#2": "L2",
      "doc.pdf#3": "L3",
    },
  };

  // Delete page 2: page 1 stays 1, page 2 is deleted (null), page 3 becomes 2
  const remap = buildKeyRemap(
    "doc.pdf",
    (p) => (p === 2 ? null : p > 2 ? p - 1 : p),
    3
  );
  const remapped = remapWorkspaceState(state, remap);

  // s2 dropped, s3 moved to doc.pdf#2
  assert.equal(remapped.shapes.length, 2);
  assert.equal(remapped.shapes[0].sheet_id, "doc.pdf");
  assert.equal(remapped.shapes[1].sheet_id, "doc.pdf#2");

  // Scales: doc.pdf#2 dropped, doc.pdf#3's scale moved to doc.pdf#2
  assert.equal(remapped.scales["doc.pdf"], 0.02);
  assert.equal(remapped.scales["doc.pdf#2"], 0.08);
  assert.equal(remapped.scales["doc.pdf#3"], undefined);

  // Tabs and levels
  assert.deepEqual(remapped.openTabs, ["doc.pdf", "doc.pdf#2"]);
  assert.equal(remapped.sheetLevels["doc.pdf"], "L1");
  assert.equal(remapped.sheetLevels["doc.pdf#2"], "L3");
  assert.equal(remapped.sheetLevels["doc.pdf#3"], undefined);
});

