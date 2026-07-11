// Zone check — the ephemeral trace-a-region breakdown. A zone is {key, pts}:
// the sheet it was drawn on plus a polygon normalized to that sheet's image.
// Shapes count by their center point (predictable, and the canvas traces every
// counted shape so inclusion is visible). Quantities come from feeding the
// filtered shapes through the same conditionTotals rules the Report uses —
// one source of role math, three scopes (Report / panel / zone).
import { pointInPoly } from "./geometry.js";

// Shoelace-formula area centroid (true center of mass), NOT a vertex average.
// A vertex average is pulled toward wherever a shape happens to have more
// points — one-click traces collapse straight walls to 2 points and keep
// extra points only where the outline is complex, so the vertex mean drifts
// off the visual center (and can land outside the polygon entirely for a
// concave shape like an L). Returns null for a degenerate (zero-area) ring.
function polygonCentroid(vs) {
  let area = 0, cx = 0, cy = 0;
  const n = vs.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = vs[i];
    const [x2, y2] = vs[(i + 1) % n];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-9) return null;
  return [cx / (6 * area), cy / (6 * area)];
}

// Bounding-box center — the fallback for shapes with no enclosed area
// (linear/2-point shapes, or a degenerate/self-intersecting ring where the
// shoelace centroid is undefined).
function bboxCenter(vs) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of vs) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

export function shapeCenter(shape) {
  const vs = shape?.verts_norm || [];
  if (!vs.length) return null;
  if (vs.length < 3) return bboxCenter(vs);
  return polygonCentroid(vs) || bboxCenter(vs);
}

export function shapesInZone(shapes, zone) {
  if (!zone || !(zone.pts || []).length) return [];
  return (shapes || []).filter((s) => {
    if (s.sheet_id !== zone.key) return false;
    const c = shapeCenter(s);
    return !!c && pointInPoly(c[0], c[1], zone.pts);
  });
}
