import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeSegment,
  segmentsMatch,
  diffVectorSegments,
  diffRasterGrayscale,
  clusterChangedSegments,
  type Segment,
} from "../src/lib/revisionDiff.ts";

test("canonicalizeSegment preserves order or swaps so (x0, y0) <= (x1, y1)", () => {
  assert.deepEqual(canonicalizeSegment(10, 20, 30, 40), [10, 20, 30, 40]);
  assert.deepEqual(canonicalizeSegment(30, 40, 10, 20), [10, 20, 30, 40]);
  assert.deepEqual(canonicalizeSegment(10, 50, 10, 20), [10, 20, 10, 50]);
});

test("segmentsMatch within tolerance, regardless of endpoint direction", () => {
  const s1: Segment = [100, 100, 200, 100];
  const s2: Segment = [100.4, 99.8, 200.2, 100.1];
  const s3: Segment = [200.2, 100.1, 100.4, 99.8];
  const s4: Segment = [110, 100, 200, 100]; // outside tol

  assert.ok(segmentsMatch(s1, s2, 0.5));
  assert.ok(segmentsMatch(s1, s3, 0.5));
  assert.ok(!segmentsMatch(s1, s4, 0.5));
});

test("diffVectorSegments: identical drawings have 0 added, 0 removed, all unchanged", () => {
  const segs: Segment[] = [
    [0, 0, 100, 0],
    [100, 0, 100, 100],
    [100, 100, 0, 100],
    [0, 100, 0, 0],
  ];

  const res = diffVectorSegments(segs, segs);
  assert.equal(res.method, "vector");
  assert.equal(res.stats.removedCount, 0);
  assert.equal(res.stats.addedCount, 0);
  assert.equal(res.stats.unchangedCount, 4);
  assert.equal(res.changedRegions.length, 0);
});

test("diffVectorSegments: removed and added segments correctly categorized and clustered", () => {
  // Base has a room at x=0..100
  const base: Segment[] = [
    [0, 0, 100, 0],
    [100, 0, 100, 100], // this wall moves in incoming
    [100, 100, 0, 100],
    [0, 100, 0, 0],
  ];

  // Incoming has the east wall moved from x=100 to x=120
  const incoming: Segment[] = [
    [0, 0, 100, 0],
    [120, 0, 120, 100], // new wall
    [100, 100, 0, 100],
    [0, 100, 0, 0],
  ];

  const res = diffVectorSegments(base, incoming);
  assert.equal(res.stats.unchangedCount, 3);
  assert.equal(res.stats.removedCount, 1);
  assert.equal(res.stats.addedCount, 1);

  // Removed is at x=100, added is at x=120 -> grouped into a "modified" region
  assert.equal(res.changedRegions.length, 1);
  assert.equal(res.changedRegions[0].type, "modified");
  assert.ok(res.changedRegions[0].bounds[0] <= 100);
  assert.ok(res.changedRegions[0].bounds[2] >= 120);
});

test("diffVectorSegments: applies alignment offset (dx, dy)", () => {
  const base: Segment[] = [[10, 10, 50, 10]];
  // Incoming is shifted by +5 in X and +10 in Y
  const incoming: Segment[] = [[15, 20, 55, 20]];

  // Without alignment: counts as removed and added
  const noAlign = diffVectorSegments(base, incoming);
  assert.equal(noAlign.stats.unchangedCount, 0);
  assert.equal(noAlign.stats.removedCount, 1);
  assert.equal(noAlign.stats.addedCount, 1);

  // With alignment (dx = -5, dy = -10): matches perfectly!
  const aligned = diffVectorSegments(base, incoming, { dx: -5, dy: -10 });
  assert.equal(aligned.stats.unchangedCount, 1);
  assert.equal(aligned.stats.removedCount, 0);
  assert.equal(aligned.stats.addedCount, 0);
});

test("diffRasterGrayscale detects changed pixel clusters", () => {
  const w = 64, h = 64;
  const base = new Uint8Array(w * h).fill(255); // white background
  const inc = new Uint8Array(w * h).fill(255);

  // Add a black line in incoming at (10, 10) to (20, 10)
  for (let x = 10; x <= 20; x++) {
    inc[10 * w + x] = 0;
  }

  const res = diffRasterGrayscale(base, inc, w, h, 150, 30, 2);
  assert.equal(res.method, "raster");
  assert.equal(res.dpi, 150);
  assert.equal(res.stats.changedPixels, 11);
  assert.ok(res.changedRegions.length >= 1);
  assert.ok(res.changedRegions[0].bounds[0] <= 10);
  assert.ok(res.changedRegions[0].bounds[2] >= 20);
});

