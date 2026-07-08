// Zone check — the ephemeral trace-a-region breakdown. A zone is {key, pts}:
// the sheet it was drawn on plus a polygon normalized to that sheet's image.
// Shapes count by their center point (predictable, and the canvas traces every
// counted shape so inclusion is visible). Quantities come from feeding the
// filtered shapes through the same conditionTotals rules the Report uses —
// one source of role math, three scopes (Report / panel / zone).
import { pointInPoly } from "./geometry.js";

export function shapeCenter(shape) {
  const vs = shape?.verts_norm || [];
  if (!vs.length) return null;
  return [
    vs.reduce((n, v) => n + v[0], 0) / vs.length,
    vs.reduce((n, v) => n + v[1], 0) / vs.length,
  ];
}

export function shapesInZone(shapes, zone) {
  if (!zone || !(zone.pts || []).length) return [];
  return (shapes || []).filter((s) => {
    if (s.sheet_id !== zone.key) return false;
    const c = shapeCenter(s);
    return !!c && pointInPoly(c[0], c[1], zone.pts);
  });
}
