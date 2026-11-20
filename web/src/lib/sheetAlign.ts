// Sheet registration and alignment: automatic title-block / frame matching
// and two-point manual fallback.
// Pure geometry, no DOM dependencies.

import type { Segment, TransformOffset } from "./revisionDiff";

export interface AlignmentResult extends TransformOffset {
  confidence: number; // 0..1
  method: "auto_frame" | "auto_linework" | "manual" | "identity";
  details?: string;
}

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

/** Compute the bounding box of a list of segments. */
export function segmentsExtent(segs: Segment[]): BoundingBox | null {
  if (!segs.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s[0] < minX) minX = s[0];
    if (s[2] < minX) minX = s[2];
    if (s[0] > maxX) maxX = s[0];
    if (s[2] > maxX) maxX = s[2];
    if (s[1] < minY) minY = s[1];
    if (s[3] < minY) minY = s[3];
    if (s[1] > maxY) maxY = s[1];
    if (s[3] > maxY) maxY = s[3];
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Find prominent long orthogonal lines (border frames / gridlines). */
export function findProminentOrthogonalLines(
  segs: Segment[],
  minLength = 200
): { horizontal: Segment[]; vertical: Segment[] } {
  const horizontal: Segment[] = [];
  const vertical: Segment[] = [];

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const dx = Math.abs(s[2] - s[0]);
    const dy = Math.abs(s[3] - s[1]);

    if (dy < 1.0 && dx >= minLength) {
      horizontal.push(s);
    } else if (dx < 1.0 && dy >= minLength) {
      vertical.push(s);
    }
  }

  return { horizontal, vertical };
}

/**
 * Align incoming sheet to base sheet automatically using title-block / drawing border linework.
 */
export function autoAlignSheets(
  baseSegs: Segment[],
  incomingSegs: Segment[],
  pageWidth: number,
  pageHeight: number
): AlignmentResult {
  if (!baseSegs.length || !incomingSegs.length) {
    return { dx: 0, dy: 0, confidence: 0, method: "identity", details: "empty segments" };
  }

  // 1. Try aligning by overall drawing extent if well-formed
  const extBase = segmentsExtent(baseSegs);
  const extInc = segmentsExtent(incomingSegs);

  if (extBase && extInc) {
    // If drawing extents match closely in dimensions (within 5%), test the translation
    const dw = Math.abs(extBase.width - extInc.width);
    const dh = Math.abs(extBase.height - extInc.height);

    if (dw <= extBase.width * 0.03 && dh <= extBase.height * 0.03) {
      const dx = extBase.minX - extInc.minX;
      const dy = extBase.minY - extInc.minY;

      // Check if this offset is small or plausible
      if (Math.abs(dx) <= pageWidth * 0.25 && Math.abs(dy) <= pageHeight * 0.25) {
        return {
          dx,
          dy,
          confidence: 0.9,
          method: "auto_frame",
          details: `aligned by drawing frame (dx=${dx.toFixed(1)}, dy=${dy.toFixed(1)})`,
        };
      }
    }
  }

  // 2. Try aligning prominent border lines
  const baseOrtho = findProminentOrthogonalLines(baseSegs, Math.min(pageWidth, pageHeight) * 0.25);
  const incOrtho = findProminentOrthogonalLines(incomingSegs, Math.min(pageWidth, pageHeight) * 0.25);

  if (baseOrtho.horizontal.length && incOrtho.horizontal.length &&
      baseOrtho.vertical.length && incOrtho.vertical.length) {
    // Find min Y among horizontal lines and min X among vertical lines
    const baseY = Math.min(...baseOrtho.horizontal.map((s) => s[1]));
    const incY = Math.min(...incOrtho.horizontal.map((s) => s[1]));
    const baseX = Math.min(...baseOrtho.vertical.map((s) => s[0]));
    const incX = Math.min(...incOrtho.vertical.map((s) => s[0]));

    const dx = baseX - incX;
    const dy = baseY - incY;

    if (Math.abs(dx) <= pageWidth * 0.25 && Math.abs(dy) <= pageHeight * 0.25) {
      return {
        dx,
        dy,
        confidence: 0.8,
        method: "auto_linework",
        details: `aligned by prominent border lines (dx=${dx.toFixed(1)}, dy=${dy.toFixed(1)})`,
      };
    }
  }

  // Fallback to identity
  return { dx: 0, dy: 0, confidence: 0.1, method: "identity", details: "default zero offset" };
}

/**
 * Manual two-point alignment: user clicks point A on base sheet and point B on incoming sheet.
 * Offset maps incoming coordinates into base coordinates: P_incoming + offset = P_base.
 */
export function manualTwoPointAlign(
  basePoint: [number, number],
  incomingPoint: [number, number]
): AlignmentResult {
  const dx = basePoint[0] - incomingPoint[0];
  const dy = basePoint[1] - incomingPoint[1];
  return {
    dx,
    dy,
    confidence: 1.0,
    method: "manual",
    details: `manual two-point match (${basePoint[0]}, ${basePoint[1]}) -> (${incomingPoint[0]}, ${incomingPoint[1]})`,
  };
}

