// Slip-sheeting: sheet matching by title-block number, shape carryover,
// and collision flagging ("Check after revision").
// Pure geometry & logic, no DOM dependencies.

import type { ChangedRegion, Segment } from "./revisionDiff";

export interface SheetEntry {
  key: string;       // e.g. "file.pdf#1"
  file: string;
  page: number;
  sheetNumber?: string | null; // e.g. "A101"
  label?: string | null;
  width?: number;
  height?: number;
}

export interface SheetMatch {
  sheetNumber: string;
  baseSheet: SheetEntry;
  incomingSheet: SheetEntry;
}

export interface MatchSetResult {
  matched: SheetMatch[];
  unmatchedBase: SheetEntry[];
  unmatchedIncoming: SheetEntry[];
  ambiguous: Array<{ sheetNumber: string; base: SheetEntry[]; incoming: SheetEntry[] }>;
}

export interface TakeoffShape {
  id: string;
  sheet_id: string;
  condition_id: string;
  measure_role?: string;
  verts_norm?: Array<[number, number]>;
  computed?: Record<string, any>;
  flagged_for_revision?: boolean;
  origin?: {
    method?: string;
    actor?: string;
    reviewed?: boolean;
    flagged_for_revision?: boolean;
    review_reason?: string;
    proposal_id?: string;
    intersected_change_regions?: Array<{ id: string; type: string; bounds: [number, number, number, number] }> | string[];
    [key: string]: any;
  };
  label?: string;
  [key: string]: any;
}

export interface CarriedShapeResult {
  shapes: TakeoffShape[];
  flaggedCount: number;
  unmodifiedCount: number;
}

/** Normalize sheet number for safe comparison: uppercase, whitespace trimmed. */
export function normalizeSheetNumber(num?: string | null): string {
  if (!num) return "";
  return num.toUpperCase().replace(/\s+/g, "").trim();
}

/**
 * Match a set of incoming sheets to base sheets by title-block sheet number.
 * Strict invariant: Never guess. Only 1-to-1 unambiguous matches are accepted.
 */
export function matchSheetSets(
  baseSheets: SheetEntry[],
  incomingSheets: SheetEntry[]
): MatchSetResult {
  const baseByNum = new Map<string, SheetEntry[]>();
  const incByNum = new Map<string, SheetEntry[]>();

  const unmatchedBase: SheetEntry[] = [];
  const unmatchedIncoming: SheetEntry[] = [];

  for (const s of baseSheets) {
    const n = normalizeSheetNumber(s.sheetNumber);
    if (!n) {
      unmatchedBase.push(s);
      continue;
    }
    const list = baseByNum.get(n) || [];
    list.push(s);
    baseByNum.set(n, list);
  }

  for (const s of incomingSheets) {
    const n = normalizeSheetNumber(s.sheetNumber);
    if (!n) {
      unmatchedIncoming.push(s);
      continue;
    }
    const list = incByNum.get(n) || [];
    list.push(s);
    incByNum.set(n, list);
  }

  const matched: SheetMatch[] = [];
  const ambiguous: MatchSetResult["ambiguous"] = [];

  // Find 1-to-1 matches
  for (const [num, bList] of baseByNum.entries()) {
    const iList = incByNum.get(num);
    if (!iList || iList.length === 0) {
      unmatchedBase.push(...bList);
      continue;
    }
    if (bList.length === 1 && iList.length === 1) {
      matched.push({
        sheetNumber: num,
        baseSheet: bList[0],
        incomingSheet: iList[0],
      });
    } else {
      // Ambiguous multiple sheets with same number: do not guess!
      ambiguous.push({ sheetNumber: num, base: bList, incoming: iList });
      unmatchedBase.push(...bList);
      unmatchedIncoming.push(...iList);
    }
  }

  // Any incoming without base
  for (const [num, iList] of incByNum.entries()) {
    if (!baseByNum.has(num)) {
      unmatchedIncoming.push(...iList);
    }
  }

  return { matched, unmatchedBase, unmatchedIncoming, ambiguous };
}

/** Check if two 2D Axis-Aligned Bounding Boxes overlap. */
export function aabbOverlap(
  boxA: [number, number, number, number],
  boxB: [number, number, number, number]
): boolean {
  return (
    boxA[0] <= boxB[2] &&
    boxA[2] >= boxB[0] &&
    boxA[1] <= boxB[3] &&
    boxA[3] >= boxB[1]
  );
}

/** Check if a 2D point is inside a polygon (ray casting). */
export function pointInPolygon(pt: [number, number], poly: Array<[number, number]>): boolean {
  let inside = false;
  const x = pt[0], y = pt[1];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Line segment intersection test. */
export function segmentsIntersect(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  p4: [number, number]
): boolean {
  const ccw = (a: [number, number], b: [number, number], c: [number, number]) =>
    (c[1] - a[1]) * (b[0] - a[0]) > (b[1] - a[1]) * (c[0] - a[0]);

  return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
}

/** Test whether a polygon intersects or encloses another polygon. */
export function polygonsIntersect(polyA: Array<[number, number]>, polyB: Array<[number, number]>): boolean {
  if (polyA.length < 3 || polyB.length < 3) return false;

  // 1. Any edge of A intersects any edge of B
  for (let i = 0; i < polyA.length; i++) {
    const a1 = polyA[i];
    const a2 = polyA[(i + 1) % polyA.length];
    for (let j = 0; j < polyB.length; j++) {
      const b1 = polyB[j];
      const b2 = polyB[(j + 1) % polyB.length];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }

  // 2. A vertex of A is inside B
  if (pointInPolygon(polyA[0], polyB)) return true;

  // 3. A vertex of B is inside A
  if (pointInPolygon(polyB[0], polyA)) return true;

  return false;
}

export const COUNT_HIT_RADIUS = 16; // px at render scale 2.0 (~8 pt)
export const LINEAR_HIT_TOL = 6;    // px at render scale 2.0 (~3 pt)
export const POLY_HIT_TOL = 4;      // px at render scale 2.0 (~2 pt)

/** Shortest distance from point (px, py) to segment [x0, y0, x1, y1]. */
export function pointToSegmentDist(px: number, py: number, seg: Segment): number {
  const [x0, y0, x1, y1] = seg;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return Math.hypot(px - x0, py - y0);
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / lenSq));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

/** Shortest distance from point (px, py) to axis-aligned box [minX, minY, maxX, maxY]. */
export function pointToBoxDist(px: number, py: number, box: [number, number, number, number]): number {
  const dx = Math.max(0, box[0] - px, px - box[2]);
  const dy = Math.max(0, box[1] - py, py - box[3]);
  return Math.hypot(dx, dy);
}

/** Shortest distance between two 2D segments. */
function segmentToSegmentDist(a0: [number, number], a1: [number, number], b: Segment): number {
  if (segmentsIntersect(a0, a1, [b[0], b[1]], [b[2], b[3]])) return 0;
  return Math.min(
    pointToSegmentDist(a0[0], a0[1], b),
    pointToSegmentDist(a1[0], a1[1], b),
    pointToSegmentDist(b[0], b[1], [a0[0], a0[1], a1[0], a1[1]]),
    pointToSegmentDist(b[2], b[3], [a0[0], a0[1], a1[0], a1[1]])
  );
}

/** Test whether an axis-aligned box overlaps or touches a polygon. */
function boxIntersectsPolygon(box: [number, number, number, number], poly: Array<[number, number]>): boolean {
  const rect: Array<[number, number]> = [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[2], box[3]],
    [box[0], box[3]],
  ];
  return polygonsIntersect(rect, poly);
}

/**
 * Test whether a takeoff shape (in page px) touches the actual changed ink
 * of a ChangedRegion (never flagging a polygon solely because it sits inside
 * a large bounding rectangle of unrelated changed segments).
 */
export function shapeTouchesRegion(
  vertsPx: Array<[number, number]>,
  region: ChangedRegion,
  measureRole?: string
): boolean {
  if (!vertsPx.length) return false;

  const isCount = measureRole === "count" || vertsPx.length === 1;
  const isLinear = !isCount && (measureRole === "linear" || vertsPx.length === 2);
  const pad = isCount ? COUNT_HIT_RADIUS : isLinear ? LINEAR_HIT_TOL : POLY_HIT_TOL;

  let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
  for (const [vx, vy] of vertsPx) {
    if (vx < sMinX) sMinX = vx;
    if (vx > sMaxX) sMaxX = vx;
    if (vy < sMinY) sMinY = vy;
    if (vy > sMaxY) sMaxY = vy;
  }
  const expandedBox: [number, number, number, number] = [sMinX - pad, sMinY - pad, sMaxX + pad, sMaxY + pad];
  if (!aabbOverlap(expandedBox, region.bounds)) return false;

  const segs = region.segments;
  const cells = region.rasterCells;

  if (isCount) {
    for (const [vx, vy] of vertsPx) {
      if (segs && segs.length > 0) {
        for (const s of segs) {
          if (pointToSegmentDist(vx, vy, s) <= COUNT_HIT_RADIUS) return true;
        }
      } else if (cells && cells.length > 0) {
        for (const c of cells) {
          if (pointToBoxDist(vx, vy, c) <= COUNT_HIT_RADIUS) return true;
        }
      } else if (pointInPolygon([vx, vy], region.hull) || pointToBoxDist(vx, vy, region.bounds) <= COUNT_HIT_RADIUS) {
        return true;
      }
    }
    return false;
  }

  if (isLinear) {
    for (let i = 0; i < vertsPx.length - 1; i++) {
      const p0 = vertsPx[i];
      const p1 = vertsPx[i + 1];
      if (segs && segs.length > 0) {
        for (const s of segs) {
          if (segmentToSegmentDist(p0, p1, s) <= LINEAR_HIT_TOL) return true;
        }
      } else if (cells && cells.length > 0) {
        for (const c of cells) {
          const rPoly: Array<[number, number]> = [[c[0], c[1]], [c[2], c[1]], [c[2], c[3]], [c[0], c[3]]];
          if (pointInPolygon(p0, rPoly) || pointInPolygon(p1, rPoly)) return true;
          for (let k = 0; k < 4; k++) {
            if (segmentToSegmentDist(p0, p1, [rPoly[k][0], rPoly[k][1], rPoly[(k + 1) % 4][0], rPoly[(k + 1) % 4][1]]) <= LINEAR_HIT_TOL) {
              return true;
            }
          }
        }
      } else {
        // Text-only or cloud region
        if (pointInPolygon(p0, region.hull) || pointInPolygon(p1, region.hull)) return true;
        for (let j = 0; j < region.hull.length; j++) {
          const h1 = region.hull[j];
          const h2 = region.hull[(j + 1) % region.hull.length];
          if (segmentsIntersect(p0, p1, h1, h2)) return true;
        }
      }
    }
    return false;
  }

  // Polygon (vertsPx.length >= 3)
  if (region.isCloud) {
    return polygonsIntersect(vertsPx, region.hull);
  }
  if (segs && segs.length > 0) {
    for (const s of segs) {
      const a: [number, number] = [s[0], s[1]];
      const b: [number, number] = [s[2], s[3]];
      if (pointInPolygon(a, vertsPx) || pointInPolygon(b, vertsPx)) return true;
      for (let i = 0; i < vertsPx.length; i++) {
        const p0 = vertsPx[i];
        const p1 = vertsPx[(i + 1) % vertsPx.length];
        if (segmentsIntersect(a, b, p0, p1)) return true;
        if (pointToSegmentDist(p0[0], p0[1], s) <= POLY_HIT_TOL) return true;
      }
    }
    return false;
  }
  if (cells && cells.length > 0) {
    for (const c of cells) {
      if (boxIntersectsPolygon(c, vertsPx)) return true;
    }
    return false;
  }
  return polygonsIntersect(vertsPx, region.hull);
}

/**
 * Carry takeoff shapes from a base sheet forward to the incoming sheet.
 * Flags any shape whose geometry (count mark, linear run, or polygon) touches changed ink.
 */
export function carryTakeoffShapes(
  baseShapes: TakeoffShape[],
  baseSheetKey: string,
  targetSheetKey: string,
  sheetWidth: number,
  sheetHeight: number,
  changedRegions: ChangedRegion[]
): CarriedShapeResult {
  const shapes: TakeoffShape[] = [];
  let flaggedCount = 0;
  let unmodifiedCount = 0;

  for (const shape of baseShapes) {
    if (shape.sheet_id !== baseSheetKey) continue;

    // Convert verts_norm (0..1) to page px for collision test
    const vertsPx: Array<[number, number]> = (shape.verts_norm || []).map(([nx, ny]) => [
      nx * sheetWidth,
      ny * sheetHeight,
    ]);

    let touchesChange = false;
    const intersectedRegionIds: string[] = [];
    const intersectedRegions: Array<{ id: string; type: string; bounds: [number, number, number, number] }> = [];

    if (vertsPx.length >= 1 && changedRegions.length > 0) {
      for (const region of changedRegions) {
        if (shapeTouchesRegion(vertsPx, region, shape.measure_role)) {
          touchesChange = true;
          intersectedRegionIds.push(region.id);
          intersectedRegions.push({
            id: region.id,
            type: region.type,
            bounds: region.bounds,
          });
        }
      }
    }

    if (touchesChange) {
      flaggedCount++;
      shapes.push({
        ...shape,
        sheet_id: targetSheetKey,
        flagged_for_revision: true,
        origin: {
          ...shape.origin,
          reviewed: false, // Flag for human review
          flagged_for_revision: true,
          review_reason: "Check after revision",
          proposal_id: "revision-check",
          intersected_change_regions: intersectedRegionIds,
          intersected_change_details: intersectedRegions,
        },
      });
    } else {
      unmodifiedCount++;
      shapes.push({
        ...shape,
        sheet_id: targetSheetKey,
      });
    }
  }

  return { shapes, flaggedCount, unmodifiedCount };
}

