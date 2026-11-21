// Slip-sheeting: sheet matching by title-block number, shape carryover,
// and collision flagging ("Check after revision").
// Pure geometry & logic, no DOM dependencies.

import type { ChangedRegion } from "./revisionDiff";

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

/** Shortest distance from a point to a segment. */
export function pointSegmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Does a takeoff shape touch a changed region? Role-aware: a count is a point,
 * a linear run or wall surface is an open polyline, everything else is a
 * closed ring. A two-point run or a single count mark is still takeoff, and
 * changed ink under it still needs a second look.
 *
 * When the region carries its changed segments the test runs against the ink
 * itself (within `pad` px), not the region's rectangle: a long dashed line
 * that moved has a sheet-sized bounding box and touches almost nothing.
 */
export function shapeTouchesRegion(
  vertsPx: Array<[number, number]>,
  role: string | undefined,
  hull: Array<[number, number]>,
  bounds: [number, number, number, number],
  segments?: Array<[number, number, number, number]>,
  pad = 4
): boolean {
  if (!vertsPx.length || hull.length < 3) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [vx, vy] of vertsPx) {
    if (vx < minX) minX = vx;
    if (vx > maxX) maxX = vx;
    if (vy < minY) minY = vy;
    if (vy > maxY) maxY = vy;
  }
  // The hull is padded past the bounds, so pad the quick reject to match.
  let hMinX = bounds[0], hMinY = bounds[1], hMaxX = bounds[2], hMaxY = bounds[3];
  for (const [hx, hy] of hull) {
    if (hx < hMinX) hMinX = hx;
    if (hx > hMaxX) hMaxX = hx;
    if (hy < hMinY) hMinY = hy;
    if (hy > hMaxY) hMaxY = hy;
  }
  if (!aabbOverlap([minX, minY, maxX, maxY], [hMinX, hMinY, hMaxX, hMaxY])) return false;

  const isCount = role === "count";
  const open = isCount || role === "linear" || role === "surface_area" || vertsPx.length < 3;

  if (segments && segments.length) {
    // A count mark is drawn as a symbol around its point, so it reaches further.
    const reach = isCount ? Math.max(pad, 12) : pad;
    const edges = open ? vertsPx.length - 1 : vertsPx.length;
    for (const sg of segments) {
      if (Math.max(sg[0], sg[2]) < minX - reach || Math.min(sg[0], sg[2]) > maxX + reach
        || Math.max(sg[1], sg[3]) < minY - reach || Math.min(sg[1], sg[3]) > maxY + reach) continue;
      const a: [number, number] = [sg[0], sg[1]];
      const b: [number, number] = [sg[2], sg[3]];
      if (!open && (pointInPolygon(a, vertsPx) || pointInPolygon(b, vertsPx))) return true;
      for (const v of vertsPx) if (pointSegmentDistance(v, a, b) <= reach) return true;
      for (let i = 0; i < edges; i++) {
        const p = vertsPx[i];
        const q = vertsPx[(i + 1) % vertsPx.length];
        if (segmentsIntersect(p, q, a, b)) return true;
        if (pointSegmentDistance(a, p, q) <= reach || pointSegmentDistance(b, p, q) <= reach) return true;
      }
    }
    return false;
  }

  if (!open) return polygonsIntersect(vertsPx, hull);
  if (vertsPx.some((p) => pointInPolygon(p, hull))) return true;
  if (isCount) return false;
  for (let i = 0; i + 1 < vertsPx.length; i++) {
    for (let j = 0; j < hull.length; j++) {
      if (segmentsIntersect(vertsPx[i], vertsPx[i + 1], hull[j], hull[(j + 1) % hull.length])) return true;
    }
  }
  return false;
}

/**
 * Carry takeoff shapes from a base sheet forward to the incoming sheet.
 * Flags any shape whose boundary or interior crosses changed ink.
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

    for (const region of changedRegions) {
      if (shapeTouchesRegion(vertsPx, shape.measure_role, region.hull, region.bounds, region.segments)) {
        touchesChange = true;
        intersectedRegionIds.push(region.id);
        intersectedRegions.push({
          id: region.id,
          type: region.type,
          bounds: region.bounds,
        });
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

