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
  origin?: {
    method?: string;
    actor?: string;
    reviewed?: boolean;
    flagged_for_revision?: boolean;
    review_reason?: string;
    intersected_change_regions?: string[];
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

    if (vertsPx.length >= 3 && changedRegions.length > 0) {
      // Shape bounding box
      let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
      for (const [vx, vy] of vertsPx) {
        if (vx < sMinX) sMinX = vx;
        if (vx > sMaxX) sMaxX = vx;
        if (vy < sMinY) sMinY = vy;
        if (vy > sMaxY) sMaxY = vy;
      }
      const shapeBox: [number, number, number, number] = [sMinX, sMinY, sMaxX, sMaxY];

      for (const region of changedRegions) {
        if (!aabbOverlap(shapeBox, region.bounds)) continue;
        if (polygonsIntersect(vertsPx, region.hull)) {
          touchesChange = true;
          intersectedRegionIds.push(region.id);
        }
      }
    }

    if (touchesChange) {
      flaggedCount++;
      shapes.push({
        ...shape,
        sheet_id: targetSheetKey,
        origin: {
          ...shape.origin,
          reviewed: false, // Flag for human review
          flagged_for_revision: true,
          review_reason: "Check after revision",
          intersected_change_regions: intersectedRegionIds,
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

