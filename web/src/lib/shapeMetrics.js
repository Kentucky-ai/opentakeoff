// The ONE role-aware shape-quantity computer — extracted from
// TakeoffCanvas.recomputeShape so callers that have no mounted panel can
// price a shape too: the load-time heal (a shape that ARRIVES without
// `computed` — an import that carried geometry only — draws fine but reads
// as 0 SF in every summer and silently zeroes its condition's totals), and
// node tests. recomputeShape stays the canvas-side wrapper (panel dims +
// scale + cond lookup); the math lives here, once.
//
// `dims` is the sheet's logical image size — pdf.js viewport at
// RENDER_SCALE, the same frame verts_norm normalizes against. `upp` is that
// sheet's units-per-px at the SAME baseline. `cond` is the shape's condition
// record (surface height / linear thickness defaults).
import { closedMetrics, openLen, polyWithHolesMetrics } from "./geometry.js";
import { flattenCurve } from "./curve.js";

export function computeShapeMetrics(s, dims, upp, cond) {
  const pts = (s.verts_norm || []).map(([nx, ny]) => [nx * dims.w, ny * dims.h]);
  const u = upp || 0;
  if (s.measure_role === "count") return { count: 1 };
  if (s.measure_role === "surface_area") {
    // the wall keeps the height it was DRAWN at; the condition H is only the
    // default for new traces (and the fallback for legacy shapes without one).
    // An explicit override wins outright — even 0 — so a zeroed wall can't
    // silently recompute at the condition height.
    const h = s.height_override === true
      ? Number(s.height_ft) || 0
      : Number(s.height_ft) || Number(cond?.height_ft) || 0;
    const LF = openLen(pts) * u;
    return { area_sf: +(LF * h).toFixed(2), perimeter_lf: +LF.toFixed(2) };
  }
  if (s.measure_role === "linear") {
    const LF = openLen(s.curved ? flattenCurve(pts) : pts) * u;
    const tIn = Number(cond?.thickness_in) || 0;
    return { perimeter_lf: +LF.toFixed(2), area_sf: tIn > 0 ? +((LF * tIn) / 12).toFixed(2) : 0 };
  }
  // #137 — a shape carrying verts_norm_holes (a reconciled Cut Out) nets its
  // hole(s) out of area and adds their boundary into perimeter, so a later
  // rescale/flip/drag still prices the ACTUAL clipped geometry rather than
  // silently reverting to the un-holed outer ring. No-op for every shape
  // that has never had a cutout reconciled into it.
  const holesPx = (s.verts_norm_holes || []).map((ring) => ring.map(([nx, ny]) => [nx * dims.w, ny * dims.h]));
  const met = holesPx.length ? polyWithHolesMetrics(pts, holesPx) : closedMetrics(pts);
  return { area_sf: +(met.area * u * u).toFixed(2), perimeter_lf: +(met.perim * u).toFixed(2) };
}

// True when the shape is missing the number its role feeds the summers —
// null/absent ONLY, never 0 (an explicit 0 is a value someone computed, not
// a gap), and only when it carries enough vertices to price honestly (a
// malformed ring stays unpriced rather than guessed).
export function needsMetrics(s) {
  const c = s.computed || {};
  const n = s.verts_norm?.length || 0;
  switch (s.measure_role) {
    case "count": return c.count == null;
    case "floor_area":
    case "deduct": return c.area_sf == null && n >= 3;
    case "surface_area": return c.area_sf == null && n >= 2;
    case "linear": return c.perimeter_lf == null && n >= 2;
    default: return false;
  }
}
