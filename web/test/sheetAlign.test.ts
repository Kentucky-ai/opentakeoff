import { test } from "node:test";
import assert from "node:assert/strict";
import {
  segmentsExtent,
  findProminentOrthogonalLines,
  autoAlignSheets,
  manualTwoPointAlign,
} from "../src/lib/sheetAlign.ts";
import type { Segment } from "../src/lib/revisionDiff.ts";

test("segmentsExtent calculates tight bounding box", () => {
  const segs: Segment[] = [
    [10, 20, 100, 20],
    [100, 20, 100, 200],
  ];
  const ext = segmentsExtent(segs);
  assert.ok(ext);
  assert.equal(ext.minX, 10);
  assert.equal(ext.minY, 20);
  assert.equal(ext.maxX, 100);
  assert.equal(ext.maxY, 200);
  assert.equal(ext.width, 90);
  assert.equal(ext.height, 180);
});

test("findProminentOrthogonalLines filters out short or diagonal lines", () => {
  const segs: Segment[] = [
    [0, 50, 300, 50],   // prominent horizontal (length 300)
    [50, 0, 50, 350],   // prominent vertical (length 350)
    [0, 0, 50, 0],      // short line (length 50 < 200)
    [0, 0, 300, 300],   // diagonal line
  ];
  const { horizontal, vertical } = findProminentOrthogonalLines(segs, 200);
  assert.equal(horizontal.length, 1);
  assert.equal(vertical.length, 1);
  assert.deepEqual(horizontal[0], [0, 50, 300, 50]);
  assert.deepEqual(vertical[0], [50, 0, 50, 350]);
});

test("autoAlignSheets finds translation offset between shifted drawings", () => {
  const base: Segment[] = [
    [100, 100, 800, 100],
    [800, 100, 800, 600],
    [800, 600, 100, 600],
    [100, 600, 100, 100],
  ];
  // Incoming has frame shifted by +20, +15
  const incoming: Segment[] = base.map(([x0, y0, x1, y1]) => [x0 + 20, y0 + 15, x1 + 20, y1 + 15]);

  const align = autoAlignSheets(base, incoming, 1000, 1000);
  assert.ok(align.confidence >= 0.8);
  assert.equal(align.dx, -20);
  assert.equal(align.dy, -15);
});

test("manualTwoPointAlign calculates exact translation", () => {
  const pBase: [number, number] = [150, 200];
  const pInc: [number, number] = [162, 195];

  const align = manualTwoPointAlign(pBase, pInc);
  assert.equal(align.dx, -12);
  assert.equal(align.dy, 5);
  assert.equal(align.method, "manual");
  assert.equal(align.confidence, 1.0);
});

