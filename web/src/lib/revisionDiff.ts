// Pure geometric revision diffing: vector segment differencing, text-layer diffing,
// and raster fallback.
// No DOM dependencies; runs cleanly under Node and in the browser worker or UI thread.

import { joinAbuttingSpans, type BoxSpan } from "./textjoin";

export type Point = [number, number];
export type Segment = [number, number, number, number]; // [x0, y0, x1, y1]
export type Polygon = Point[];

export interface TextDiffItem {
  id: string;
  type: "added" | "removed" | "modified";
  textA?: string;
  textB?: string;
  boundsA?: [number, number, number, number];
  boundsB?: [number, number, number, number];
  bounds: [number, number, number, number];
}

export interface ChangedRegion {
  id: string;
  type: "added" | "removed" | "modified";
  bounds: [number, number, number, number]; // [minX, minY, maxX, maxY]
  hull: Polygon;
  segmentCount: number;
  segments?: Segment[];
  rasterCells?: Array<[number, number, number, number]>;
  isCloud?: boolean;
  textChanges?: TextDiffItem[];
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
  rotationDeg?: number;
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

/** Transform a 2D point by alignment (scale, rotationDeg, dx, dy). */
export function transformPoint(x: number, y: number, alignment: TransformOffset): [number, number] {
  const scale = alignment.scale ?? 1;
  const rot = alignment.rotationDeg ?? 0;
  let px = x * scale;
  let py = y * scale;
  if (rot !== 0) {
    const rad = (rot * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const rx = px * c - py * s;
    const ry = px * s + py * c;
    px = rx;
    py = ry;
  }
  return [px + alignment.dx, py + alignment.dy];
}

/** Detect if a cluster of changed segments forms a closed revision cloud boundary. */
export function detectRevisionCloud(segs: Segment[], bounds: [number, number, number, number]): boolean {
  if (segs.length < 12) return false;
  const w = bounds[2] - bounds[0];
  const h = bounds[3] - bounds[1];
  if (w < 30 || h < 30) return false;

  // Revision clouds are made of many short arc-chord segments whose endpoints
  // chain together around a perimeter, leaving the interior mostly empty.
  let totalLen = 0;
  let nearPerimeter = 0;
  const margin = Math.max(12, Math.min(w, h) * 0.18);
  for (const s of segs) {
    const len = Math.hypot(s[2] - s[0], s[3] - s[1]);
    totalLen += len;
    const mx = (s[0] + s[2]) / 2;
    const my = (s[1] + s[3]) / 2;
    const distEdge = Math.min(
      Math.abs(mx - bounds[0]),
      Math.abs(bounds[2] - mx),
      Math.abs(my - bounds[1]),
      Math.abs(bounds[3] - my)
    );
    if (distEdge <= margin) nearPerimeter++;
  }
  const avgLen = totalLen / segs.length;
  const perimeter = 2 * (w + h);
  // Short segments (avg < 35px or < 8% of perimeter) and mostly near the outer boundary
  return avgLen <= 40 && totalLen >= perimeter * 0.7 && nearPerimeter / segs.length >= 0.65;
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
      const cMinX = Math.min(cur[0], cur[2]);
      const cMaxX = Math.max(cur[0], cur[2]);
      const cMinY = Math.min(cur[1], cur[3]);
      const cMaxY = Math.max(cur[1], cur[3]);

      for (let j = 0; j < n; j++) {
        if (visited[j]) continue;
        const cand = segments[j].seg;

        // Check distance between cur and cand
        const bMinX = Math.min(cand[0], cand[2]);
        const bMaxX = Math.max(cand[0], cand[2]);
        const bMinY = Math.min(cand[1], cand[3]);
        const bMaxY = Math.max(cand[1], cand[3]);

        const dx = Math.max(0, Math.max(cMinX - bMaxX, bMinX - cMaxX));
        const dy = Math.max(0, Math.max(cMinY - bMaxY, bMinY - cMaxY));

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
    const segs = group.map((g) => g.seg);
    const isCloud = hasAdded && !hasRemoved && detectRevisionCloud(segs, box);
    regions.push({
      id: `crg-${regions.length + 1}`,
      type: regionType,
      bounds: box,
      hull: bboxToPolygon(box, 4),
      segmentCount: group.length,
      segments: segs,
      ...(isCloud ? { isCloud: true } : {}),
    });
  }

  return regions;
}

/**
 * Compare two sets of vector segments (e.g. from pdf.js extractVectorGeometry).
 * An optional alignment offset (dx, dy, scale, rotationDeg) is applied to the incoming segments.
 */
export function diffVectorSegments(
  baseRawSegs: Segment[],
  incomingRawSegs: Segment[],
  alignment: TransformOffset = { dx: 0, dy: 0 },
  tolerance = 1.0
): VectorDiffResult {
  const baseSegs: Segment[] = baseRawSegs.map((s) => canonicalizeSegment(s[0], s[1], s[2], s[3]));
  const incomingSegs: Segment[] = incomingRawSegs.map((s) => {
    const [x0, y0] = transformPoint(s[0], s[1], alignment);
    const [x1, y1] = transformPoint(s[2], s[3], alignment);
    return canonicalizeSegment(x0, y0, x1, y1);
  });

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
          rasterCells: [box],
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

export interface CoalescedTextLine {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  rot: number;
}

export interface TextDiffResult {
  unchangedCount: number;
  items: TextDiffItem[];
  changedRegions: ChangedRegion[];
}

/**
 * Coalesce PDF text runs into logical visual lines so that two PDF writers
 * splitting the same printed line into different runs produce identical lines.
 */
export function coalesceTextLines(rawSpans: readonly BoxSpan[]): CoalescedTextLine[] {
  const cleaned = rawSpans
    .filter((s) => s.str && s.str.trim().length > 0)
    .map((s) => ({ ...s, rot: s.rot ?? 0 }));
  if (!cleaned.length) return [];

  // First join abutting runs (0-gap split tags/dates/numbers)
  const abutted = joinAbuttingSpans(cleaned);

  // Group by quantized rotation (0, 90, 180, 270)
  const byRot = new Map<number, BoxSpan[]>();
  for (const s of abutted) {
    const r = ((Math.round((s.rot ?? 0) / 90) * 90) % 360 + 360) % 360;
    let list = byRot.get(r);
    if (!list) byRot.set(r, (list = []));
    list.push(s);
  }

  const lines: CoalescedTextLine[] = [];

  for (const [rot, list] of byRot.entries()) {
    const axisOf = (s: BoxSpan) => {
      if (rot === 90) return { a0: s.y0, a1: s.y1, p: (s.x0 + s.x1) / 2, h: Math.max(1, s.x1 - s.x0) };
      if (rot === 270) return { a0: -s.y1, a1: -s.y0, p: (s.x0 + s.x1) / 2, h: Math.max(1, s.x1 - s.x0) };
      if (rot === 180) return { a0: -s.x1, a1: -s.x0, p: (s.y0 + s.y1) / 2, h: Math.max(1, s.y1 - s.y0) };
      return { a0: s.x0, a1: s.x1, p: (s.y0 + s.y1) / 2, h: Math.max(1, s.y1 - s.y0) };
    };

    const items = list.map((s) => ({ s, ax: axisOf(s) }));
    // Sort by baseline p, then along-line a0
    items.sort((u, v) => u.ax.p - v.ax.p || u.ax.a0 - v.ax.a0);

    // Cluster into baseline rows
    const rows: Array<typeof items> = [];
    for (const item of items) {
      const lastRow = rows[rows.length - 1];
      if (lastRow) {
        const ref = lastRow[0].ax;
        const tol = 0.35 * Math.min(ref.h, item.ax.h);
        if (Math.abs(item.ax.p - ref.p) <= tol && Math.abs(ref.h - item.ax.h) <= 0.4 * Math.max(ref.h, item.ax.h)) {
          lastRow.push(item);
          continue;
        }
      }
      rows.push([item]);
    }

    // Within each row, sort by a0 and split on large horizontal gaps (> 1.2 * h)
    for (const row of rows) {
      row.sort((u, v) => u.ax.a0 - v.ax.a0);
      let curText = row[0].s.str.trim();
      let { x0, y0, x1, y1 } = row[0].s;
      let prevAx = row[0].ax;

      const flush = () => {
        const norm = curText.replace(/\s+/g, " ").trim();
        if (norm) lines.push({ text: norm, x0, y0, x1, y1, rot });
      };

      for (let i = 1; i < row.length; i++) {
        const cur = row[i];
        const h = Math.max(prevAx.h, cur.ax.h);
        const gap = cur.ax.a0 - prevAx.a1;
        // Skip faux-bold duplicate runs at the exact same position
        if (cur.s.str.trim() === row[i - 1].s.str.trim() && gap < -0.5 * (prevAx.a1 - prevAx.a0)) {
          continue;
        }
        if (gap <= 1.2 * h) {
          const sep = gap > 0.12 * h ? " " : "";
          curText += sep + cur.s.str.trim();
          x0 = Math.min(x0, cur.s.x0);
          y0 = Math.min(y0, cur.s.y0);
          x1 = Math.max(x1, cur.s.x1);
          y1 = Math.max(y1, cur.s.y1);
          prevAx = cur.ax;
        } else {
          flush();
          curText = cur.s.str.trim();
          ({ x0, y0, x1, y1 } = cur.s);
          prevAx = cur.ax;
        }
      }
      flush();
    }
  }

  return lines;
}

/**
 * Diff text layers between two sheets after coalescing re-chunked runs.
 * Re-chunked text runs at the same aligned position produce zero entries.
 */
export function diffTextSpans(
  baseSpans: readonly BoxSpan[],
  incomingSpans: readonly BoxSpan[],
  alignment: TransformOffset = { dx: 0, dy: 0 },
  posTol = 28
): TextDiffResult {
  const baseLines = coalesceTextLines(baseSpans);
  const incLinesRaw = coalesceTextLines(incomingSpans);

  const incLines = incLinesRaw.map((l) => {
    const [tx0, ty0] = transformPoint(l.x0, l.y0, alignment);
    const [tx1, ty1] = transformPoint(l.x1, l.y1, alignment);
    return {
      ...l,
      x0: Math.min(tx0, tx1),
      y0: Math.min(ty0, ty1),
      x1: Math.max(tx0, tx1),
      y1: Math.max(ty0, ty1),
    };
  });

  const baseMatched = new Uint8Array(baseLines.length);
  const incMatched = new Uint8Array(incLines.length);
  let unchangedCount = 0;

  const centerOf = (l: CoalescedTextLine): [number, number] => [(l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2];
  const boxesOverlap = (a: CoalescedTextLine, b: CoalescedTextLine, pad = 8) =>
    a.x0 - pad <= b.x1 && a.x1 + pad >= b.x0 && a.y0 - pad <= b.y1 && a.y1 + pad >= b.y0;

  // Pass 1: exact normalized text match near the same position
  for (let i = 0; i < baseLines.length; i++) {
    const b = baseLines[i];
    const [bcx, bcy] = centerOf(b);
    let bestJ = -1;
    let bestDist = Infinity;
    for (let j = 0; j < incLines.length; j++) {
      if (incMatched[j]) continue;
      const inc = incLines[j];
      if (b.text !== inc.text) continue;
      const [icx, icy] = centerOf(inc);
      const dist = Math.hypot(bcx - icx, bcy - icy);
      if ((dist <= posTol || boxesOverlap(b, inc, 10)) && dist < bestDist) {
        bestDist = dist;
        bestJ = j;
      }
    }
    if (bestJ >= 0) {
      baseMatched[i] = 1;
      incMatched[bestJ] = 1;
      unchangedCount++;
    }
  }

  const items: TextDiffItem[] = [];
  let seq = 1;

  // Pass 2: pair remaining lines at the same position as "modified" (retyped text)
  for (let i = 0; i < baseLines.length; i++) {
    if (baseMatched[i]) continue;
    const b = baseLines[i];
    const [bcx, bcy] = centerOf(b);
    let bestJ = -1;
    let bestDist = Infinity;
    for (let j = 0; j < incLines.length; j++) {
      if (incMatched[j]) continue;
      const inc = incLines[j];
      const [icx, icy] = centerOf(inc);
      const dist = Math.hypot(bcx - icx, bcy - icy);
      if ((boxesOverlap(b, inc, 8) || dist <= posTol) && dist < bestDist) {
        bestDist = dist;
        bestJ = j;
      }
    }
    if (bestJ >= 0) {
      baseMatched[i] = 1;
      incMatched[bestJ] = 1;
      const inc = incLines[bestJ];
      const boundsA: [number, number, number, number] = [b.x0, b.y0, b.x1, b.y1];
      const boundsB: [number, number, number, number] = [inc.x0, inc.y0, inc.x1, inc.y1];
      const bounds: [number, number, number, number] = [
        Math.min(boundsA[0], boundsB[0]),
        Math.min(boundsA[1], boundsB[1]),
        Math.max(boundsA[2], boundsB[2]),
        Math.max(boundsA[3], boundsB[3]),
      ];
      items.push({
        id: `txt-${seq++}`,
        type: "modified",
        textA: b.text,
        textB: inc.text,
        boundsA,
        boundsB,
        bounds,
      });
    }
  }

  // Pass 3: remaining unmatched -> removed / added
  for (let i = 0; i < baseLines.length; i++) {
    if (baseMatched[i]) continue;
    const b = baseLines[i];
    const bounds: [number, number, number, number] = [b.x0, b.y0, b.x1, b.y1];
    items.push({ id: `txt-${seq++}`, type: "removed", textA: b.text, boundsA: bounds, bounds });
  }
  for (let j = 0; j < incLines.length; j++) {
    if (incMatched[j]) continue;
    const inc = incLines[j];
    const bounds: [number, number, number, number] = [inc.x0, inc.y0, inc.x1, inc.y1];
    items.push({ id: `txt-${seq++}`, type: "added", textB: inc.text, boundsB: bounds, bounds });
  }

  const changedRegions: ChangedRegion[] = items.map((it, idx) => ({
    id: `crg-t-${idx + 1}`,
    type: it.type,
    bounds: it.bounds,
    hull: bboxToPolygon(it.bounds, 4),
    segmentCount: 0,
    textChanges: [it],
  }));

  return { unchangedCount, items, changedRegions };
}

