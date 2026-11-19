// Pure geometric revision diffing: vector segment differencing and raster fallback.
// No DOM dependencies; runs cleanly under Node and in the browser worker or UI thread.

export type Point = [number, number];
export type Segment = [number, number, number, number]; // [x0, y0, x1, y1]
export type Polygon = Point[];

export interface ChangedRegion {
  id: string;
  type: "added" | "removed" | "modified";
  bounds: [number, number, number, number]; // [minX, minY, maxX, maxY]
  hull: Polygon;
  segmentCount: number;
}

export interface VectorDiffResult {
  method: "vector";
  unchangedSegments: Segment[];
  removedSegments: Segment[]; // In base but not incoming
  addedSegments: Segment[];   // In incoming but not base
  changedRegions: ChangedRegion[];
  stats: {
    baseCount: number;
    incomingCount: number;
    unchangedCount: number;
    removedCount: number;
    addedCount: number;
  };
}

export interface RasterDiffResult {
  method: "raster";
  dpi: number;
  changedRegions: ChangedRegion[];
  stats: {
    totalPixels: number;
    changedPixels: number;
    changeRatio: number;
  };
}

export type DiffResult = VectorDiffResult | RasterDiffResult;

export interface TransformOffset {
  dx: number;
  dy: number;
  scale?: number;
}

/** Canonicalize a segment so (x0, y0) <= (x1, y1) for order-independent comparison. */
export function canonicalizeSegment(x0: number, y0: number, x1: number, y1: number): Segment {
  if (x0 < x1 || (Math.abs(x0 - x1) < 1e-5 && y0 <= y1)) {
    return [x0, y0, x1, y1];
  }
  return [x1, y1, x0, y0];
}

/** Check if two canonicalized segments are equal within an absolute geometric tolerance. */
export function segmentsMatch(
  s1: Segment,
  s2: Segment,
  tol = 1.0
): boolean {
  // Direct match: (s1.p0 ≈ s2.p0) and (s1.p1 ≈ s2.p1)
  const d00x = Math.abs(s1[0] - s2[0]);
  const d00y = Math.abs(s1[1] - s2[1]);
  const d11x = Math.abs(s1[2] - s2[2]);
  const d11y = Math.abs(s1[3] - s2[3]);

  if (d00x <= tol && d00y <= tol && d11x <= tol && d11y <= tol) {
    return true;
  }

  // Reverse match (in case canonicalization had float jitter): (s1.p0 ≈ s2.p1) and (s1.p1 ≈ s2.p0)
  const d01x = Math.abs(s1[0] - s2[2]);
  const d01y = Math.abs(s1[1] - s2[3]);
  const d10x = Math.abs(s1[2] - s2[0]);
  const d10y = Math.abs(s1[3] - s2[1]);

  return d01x <= tol && d01y <= tol && d10x <= tol && d10y <= tol;
}

/** 2D Spatial grid index for fast segment queries. */
class SegmentSpatialGrid {
  private cellSize: number;
  private grid = new Map<string, number[]>();
  private segments: Segment[];

  constructor(segments: Segment[], cellSize = 25) {
    this.segments = segments;
    this.cellSize = cellSize;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const minX = Math.min(seg[0], seg[2]);
      const maxX = Math.max(seg[0], seg[2]);
      const minY = Math.min(seg[1], seg[3]);
      const maxY = Math.max(seg[1], seg[3]);

      const c0x = Math.floor(minX / cellSize);
      const c1x = Math.floor(maxX / cellSize);
      const c0y = Math.floor(minY / cellSize);
      const c1y = Math.floor(maxY / cellSize);

      for (let cx = c0x; cx <= c1x; cx++) {
        for (let cy = c0y; cy <= c1y; cy++) {
          const key = `${cx},${cy}`;
          let bucket = this.grid.get(key);
          if (!bucket) {
            bucket = [];
            this.grid.set(key, bucket);
          }
          bucket.push(i);
        }
      }
    }
  }

  /** Find and take the first matching segment index. */
  findAndMarkMatch(target: Segment, matched: Uint8Array, tol = 1.0): number {
    const minX = Math.min(target[0], target[2]) - tol;
    const maxX = Math.max(target[0], target[2]) + tol;
    const minY = Math.min(target[1], target[3]) - tol;
    const maxY = Math.max(target[1], target[3]) + tol;

    const c0x = Math.floor(minX / this.cellSize);
    const c1x = Math.floor(maxX / this.cellSize);
    const c0y = Math.floor(minY / this.cellSize);
    const c1y = Math.floor(maxY / this.cellSize);

    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cy = c0y; cy <= c1y; cy++) {
        const bucket = this.grid.get(`${cx},${cy}`);
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const idx = bucket[k];
          if (matched[idx] === 1) continue;
          if (segmentsMatch(this.segments[idx], target, tol)) {
            matched[idx] = 1;
            return idx;
          }
        }
      }
    }
    return -1;
  }
}

/** Build a bounding box convex rectangle polygon from [minX, minY, maxX, maxY]. */
export function bboxToPolygon(box: [number, number, number, number], pad = 4): Polygon {
  const x0 = box[0] - pad;
  const y0 = box[1] - pad;
  const x1 = box[2] + pad;
  const y1 = box[3] + pad;
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** Group changed segments into discrete spatial regions. */
export function clusterChangedSegments(
  segments: Array<{ seg: Segment; type: "added" | "removed" }>,
  clusterDist = 30
): ChangedRegion[] {
  if (!segments.length) return [];

  // Simple disjoint-set / flood-clustering by proximity
  const n = segments.length;
  const visited = new Uint8Array(n);
  const regions: ChangedRegion[] = [];

  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    visited[i] = 1;

    const group: Array<{ seg: Segment; type: "added" | "removed" }> = [segments[i]];
    const queue = [i];

    let minX = Math.min(segments[i].seg[0], segments[i].seg[2]);
    let maxX = Math.max(segments[i].seg[0], segments[i].seg[2]);
    let minY = Math.min(segments[i].seg[1], segments[i].seg[3]);
    let maxY = Math.max(segments[i].seg[1], segments[i].seg[3]);

    while (queue.length > 0) {
      const curIdx = queue.pop()!;
      const cur = segments[curIdx].seg;

      for (let j = 0; j < n; j++) {
        if (visited[j]) continue;
        const cand = segments[j].seg;

        // Check distance between cur and cand
        const bMinX = Math.min(cand[0], cand[2]);
        const bMaxX = Math.max(cand[0], cand[2]);
        const bMinY = Math.min(cand[1], cand[3]);
        const bMaxY = Math.max(cand[1], cand[3]);

        const dx = Math.max(0, Math.max(minX - bMaxX, bMinX - maxX));
        const dy = Math.max(0, Math.max(minY - bMaxY, bMinY - maxY));

        if (dx <= clusterDist && dy <= clusterDist) {
          visited[j] = 1;
          queue.push(j);
          group.push(segments[j]);

          if (bMinX < minX) minX = bMinX;
          if (bMaxX > maxX) maxX = bMaxX;
          if (bMinY < minY) minY = bMinY;
          if (bMaxY > maxY) maxY = bMaxY;
        }
      }
    }

    const hasAdded = group.some((g) => g.type === "added");
    const hasRemoved = group.some((g) => g.type === "removed");
    const regionType: "added" | "removed" | "modified" =
      hasAdded && hasRemoved ? "modified" : hasAdded ? "added" : "removed";

    const box: [number, number, number, number] = [minX, minY, maxX, maxY];
    regions.push({
      id: `crg-${regions.length + 1}`,
      type: regionType,
      bounds: box,
      hull: bboxToPolygon(box, 4),
      segmentCount: group.length,
    });
  }

  return regions;
}

/**
 * Compare two sets of vector segments (e.g. from pdf.js extractVectorGeometry).
 * An optional alignment offset (dx, dy) is applied to the incoming segments.
 */
export function diffVectorSegments(
  baseRawSegs: Segment[],
  incomingRawSegs: Segment[],
  alignment: TransformOffset = { dx: 0, dy: 0 },
  tolerance = 1.0
): VectorDiffResult {
  const baseSegs: Segment[] = baseRawSegs.map((s) => canonicalizeSegment(s[0], s[1], s[2], s[3]));
  const incomingSegs: Segment[] = incomingRawSegs.map((s) =>
    canonicalizeSegment(s[0] + alignment.dx, s[1] + alignment.dy, s[2] + alignment.dx, s[3] + alignment.dy)
  );

  const baseMatched = new Uint8Array(baseSegs.length);
  const incomingMatched = new Uint8Array(incomingSegs.length);

  const baseGrid = new SegmentSpatialGrid(baseSegs);
  const unchangedSegments: Segment[] = [];
  const addedSegments: Segment[] = [];
  const removedSegments: Segment[] = [];

  // Match incoming against base
  for (let i = 0; i < incomingSegs.length; i++) {
    const inc = incomingSegs[i];
    const matchIdx = baseGrid.findAndMarkMatch(inc, baseMatched, tolerance);
    if (matchIdx >= 0) {
      incomingMatched[i] = 1;
      unchangedSegments.push(inc);
    } else {
      addedSegments.push(inc);
    }
  }

  // Any base segment not matched is removed
  for (let i = 0; i < baseSegs.length; i++) {
    if (baseMatched[i] === 0) {
      removedSegments.push(baseSegs[i]);
    }
  }

  // Combine changed segments for clustering
  const allChanged: Array<{ seg: Segment; type: "added" | "removed" }> = [
    ...removedSegments.map((seg) => ({ seg, type: "removed" as const })),
    ...addedSegments.map((seg) => ({ seg, type: "added" as const })),
  ];

  const changedRegions = clusterChangedSegments(allChanged);

  return {
    method: "vector",
    unchangedSegments,
    removedSegments,
    addedSegments,
    changedRegions,
    stats: {
      baseCount: baseSegs.length,
      incomingCount: incomingSegs.length,
      unchangedCount: unchangedSegments.length,
      removedCount: removedSegments.length,
      addedCount: addedSegments.length,
    },
  };
}

/**
 * Fallback raster diffing for scanned/flattened pages.
 * Operates over 8-bit grayscale pixel buffers.
 */
export function diffRasterGrayscale(
  basePixels: Uint8Array,
  incomingPixels: Uint8Array,
  width: number,
  height: number,
  dpi = 150,
  threshold = 30,
  minBlobSize = 4
): RasterDiffResult {
  const totalPixels = width * height;
  let changedPixels = 0;
  const diffMask = new Uint8Array(totalPixels);

  for (let i = 0; i < totalPixels; i++) {
    const diff = Math.abs(basePixels[i] - incomingPixels[i]);
    if (diff > threshold) {
      diffMask[i] = 1;
      changedPixels++;
    }
  }

  // Grid binning for fast connected region clustering
  const binSize = 32;
  const cols = Math.ceil(width / binSize);
  const rows = Math.ceil(height / binSize);
  const binCounts = new Int32Array(cols * rows);

  for (let y = 0; y < height; y++) {
    const by = Math.floor(y / binSize);
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      if (diffMask[rowOffset + x] === 1) {
        const bx = Math.floor(x / binSize);
        binCounts[by * cols + bx]++;
      }
    }
  }

  const changedRegions: ChangedRegion[] = [];
  let regionId = 1;

  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const count = binCounts[by * cols + bx];
      if (count >= minBlobSize) {
        const x0 = bx * binSize;
        const y0 = by * binSize;
        const x1 = Math.min(width, (bx + 1) * binSize);
        const y1 = Math.min(height, (by + 1) * binSize);
        const box: [number, number, number, number] = [x0, y0, x1, y1];
        changedRegions.push({
          id: `crg-r-${regionId++}`,
          type: "modified",
          bounds: box,
          hull: bboxToPolygon(box, 2),
          segmentCount: count,
        });
      }
    }
  }

  return {
    method: "raster",
    dpi,
    changedRegions,
    stats: {
      totalPixels,
      changedPixels,
      changeRatio: totalPixels > 0 ? changedPixels / totalPixels : 0,
    },
  };
}

