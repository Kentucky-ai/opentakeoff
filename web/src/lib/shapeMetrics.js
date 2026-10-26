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

/** The vertical legs a linear run carries (#441): rise and drop in feet.
 *  The condition's rise_ft / drop_ft are the DEFAULTS for its runs and
 *  re-flow them live (the way thickness does); a run that carries its own
 *  rise_ft or drop_ft overrides that field outright, even to 0 — a run with
 *  no drop is a stated fact, not a missing one. Each field resolves on its
 *  own, so a run can keep the condition's rise and override only its drop.
 *  Negative or non-numeric values read as 0. */
export function linearVerticalFt(s, cond) {
  // a DERIVED run (base minted from a room's perimeter, a transition where
  // two finishes meet) is a floor-level line by construction — it never
  // takes a leg, whatever its condition's defaults say
  if (s?.origin?.derived) return { rise: 0, drop: 0 };
  const pick = (own, dflt) => {
    const v = own != null && own !== "" ? Number(own) : Number(dflt);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  return { rise: pick(s?.rise_ft, cond?.rise_ft), drop: pick(s?.drop_ft, cond?.drop_ft) };
}

/** @returns {{ area_sf?: number, perimeter_lf?: number, count?: number, plan_lf?: number, vertical_lf?: number }} */
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
    // #441 — a run's length is what the material actually travels: the plan
    // (2D) trace PLUS its vertical legs (a home run drops 8 ft to the panel,
    // rises 2 ft to a box). perimeter_lf stays the TOTAL so every summer,
    // report, workbook and marked set keep reading one number; plan_lf and
    // vertical_lf ride beside it only when a vertical exists, so a flat run's
    // record is byte-for-byte what it always was.
    const plan = openLen(s.curved ? flattenCurve(pts) : pts) * u;
    const { rise, drop } = linearVerticalFt(s, cond);
    const vert = rise + drop;
    const LF = plan + vert;
    const tIn = Number(cond?.thickness_in) || 0;
    return {
      perimeter_lf: +LF.toFixed(2),
      area_sf: tIn > 0 ? +((LF * tIn) / 12).toFixed(2) : 0,
      ...(vert > 0 ? { plan_lf: +plan.toFixed(2), vertical_lf: +vert.toFixed(2) } : {}),
    };
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

// Reprice one sheet as a unit, including the durable pre-cut snapshots used
// when a deduct is deleted later. Both canvas and MCP use this operation.
export function recalibrateShapes(shapes, dims, upp, conditions) {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const conds = new Map(conditions.map((c) => [c.id, c]));
  return shapes.map((s) => {
    if (s.measure_role === "count") return s; // imported counts may be fractional
    const next = { ...s, computed: computeShapeMetrics(s, dims, upp, conds.get(s.condition_id)) };
    const prev = s.origin?.parent_prev;
    const parent = prev && byId.get(s.cuts_shape_id);
    if (prev && parent) next.origin = { ...s.origin, parent_prev: { ...prev,
      computed: computeShapeMetrics({ ...parent, ...prev, verts_norm_holes: prev.verts_norm_holes }, dims, upp, conds.get(parent.condition_id)),
    } };
    return next;
  });
}
