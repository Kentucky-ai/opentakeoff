// Real polygon boolean subtraction for the Eraser/deduct tool — #137.
//
// Before this, a cutout committed as a second, independent shape
// (measure_role: "deduct") sitting on top of its condition's polygon; totals
// did plain arithmetic (sum floor_area, subtract deduct's area_sf), and the
// canvas painted a red hatch decal over the condition instead of an actual
// hole. No multi-ring polygon ever existed anywhere in the data model, so
// perimeter/LF never shrank around the cut and a deduct that touched the
// condition's edge didn't clip correctly.
//
// This module runs the real boolean subtract (turf `difference`) between a
// parent floor_area shape's own ring and the deduct's ring, and hands back
// the result as an outer ring + hole ring(s) — TakeoffCanvas.commitPoly
// stores that on the parent as `verts_norm_holes` (see lib/shapeCommands.js's
// `cutout` command) instead of minting a second overlapping shape.
//
// Coordinate convention: pixel-space in, pixel-space out — the SAME
// panel-relative px used everywhere else in this file (closedMetrics,
// commitPoly). Turf's boolean ops (difference/booleanContains/booleanOverlap)
// are purely topological — ray-casting and winding, not spherical trig — so
// running them on plain image px instead of lon/lat is safe. Only turf's
// MEASUREMENT functions (area/length/distance/bearing) assume a sphere; this
// module never calls those. Area/perimeter come from closedMetrics via
// polyWithHolesMetrics, exactly like every other shape on this canvas.
//
// Scope (see #137 and its follow-up issue for the fuller story): this
// resolves a deduct against a SINGLE, unambiguous parent floor_area shape on
// the same sheet — including a parent that ALREADY carries reconciled
// cutout(s): the new ring subtracts against (outer + existing holes), so N
// deducts compose into N holes and the overlap between two deducts is never
// double-subtracted (set subtraction). A deduct that touches/overlaps more
// than one floor_area shape is intentionally left AMBIGUOUS here — the
// caller (TakeoffCanvas.resolveCutout) treats a null return as "fall back to
// the legacy independent-shape behavior," which stays exactly as safe as it
// was before this file existed. Feeding the real hole geometry to export
// (JobHub/DXF) is follow-up work.
import { polygon as turfPolygon, featureCollection } from "@turf/helpers";
import turfDifference from "@turf/difference";
import booleanOverlap from "@turf/boolean-overlap";
import booleanContains from "@turf/boolean-contains";
import { polyWithHolesMetrics, openLen, pointInPoly } from "./geometry.js";

// GeoJSON rings are CLOSED (first === last); this canvas's rings are OPEN
// (verts_norm never repeats the closing vertex — see closedMetrics). These
// two convert at the turf boundary only; nothing outside this file should
// ever see a closed ring.
const closeRing = (pts) => {
  if (!pts.length) return pts;
  const [x0, y0] = pts[0], [xn, yn] = pts[pts.length - 1];
  return (x0 === xn && y0 === yn) ? pts : [...pts, [x0, y0]];
};
const openRing = (pts) => {
  if (pts.length > 1) {
    const [x0, y0] = pts[0], [xn, yn] = pts[pts.length - 1];
    if (x0 === xn && y0 === yn) return pts.slice(0, -1);
  }
  return pts;
};

// True when `ringA` (the deduct) meaningfully touches `ringB` (a candidate
// parent's outer ring) — fully contained OR a partial/edge overlap (the
// "hole touches the edge" case). booleanOverlap alone misses full
// containment by its own definition (true only when NEITHER fully contains
// the other), so both checks are needed. Malformed rings (self-intersecting,
// <3 points) fail closed (not a match) rather than throwing.
function touches(ringA, ringB) {
  if (ringA.length < 3 || ringB.length < 3) return false;
  try {
    const a = turfPolygon([closeRing(ringA)]);
    const b = turfPolygon([closeRing(ringB)]);
    return booleanContains(b, a) || booleanOverlap(a, b);
  } catch {
    return false;
  }
}

/**
 * True when `innerRingPx` sits FULLY inside `outerRingPx` — the MCP server's
 * cut_out gate (#206): over the wire the house rule is refusal-over-guessing,
 * so an edge-crossing cut (which the canvas clips as a boundary affordance)
 * is refused rather than resolved. Malformed rings fail closed.
 * @param {number[][]} outerRingPx
 * @param {number[][]} innerRingPx
 * @returns {boolean}
 */
export function ringFullyInside(outerRingPx, innerRingPx) {
  if (outerRingPx.length < 3 || innerRingPx.length < 3) return false;
  try {
    return booleanContains(turfPolygon([closeRing(outerRingPx)]), turfPolygon([closeRing(innerRingPx)]));
  } catch {
    return false;
  }
}

/**
 * Finds the ONE candidate this deduct ring resolves against.
 * @param {Array<{id: string, ringPx: number[][]}>} candidates floor_area
 *   shapes on the SAME sheet as the deduct, outer ring already denormalized
 *   to the panel's px space. Containment tests run against the OUTER ring
 *   only — a deduct landing inside an existing hole still resolves to that
 *   parent (and subtracts nothing new, which is the correct net).
 * @param {number[][]} deductRingPx the deduct's own ring, same px space.
 * @returns {string|null} the unique parent's id, or null (zero or 2+ hits —
 *   ambiguous, caller falls back to the legacy independent-shape path).
 */
export function findCutoutParent(candidates, deductRingPx) {
  const hits = candidates.filter(({ ringPx }) => touches(deductRingPx, ringPx));
  return hits.length === 1 ? hits[0].id : null;
}

/**
 * Runs the real boolean subtract: (parent outer ring + its existing holes)
 * minus the deduct ring. Returns null — never a guess — when the op fails or
 * degenerates: the deduct erases the parent outright (turf hands back null),
 * or splits it into disjoint pieces (a MultiPolygon result) — both are
 * genuinely harder cases than "cut a hole in this shape" and stay on the
 * legacy path rather than silently picking one piece.
 * @param {number[][]} outerRingPx parent's own outer ring, px space.
 * @param {number[][][]} holeRingsPx parent's EXISTING holes, px space (empty
 *   for the common single-cutout case).
 * @param {number[][]} deductRingPx the new deduct's ring, px space.
 * @returns {{outer: number[][], holes: number[][][], area: number, perim: number}|null}
 *   outer/holes are OPEN rings (this canvas's convention); area/perim are the
 *   same pixel-space units closedMetrics returns (caller scales by upp/upp²).
 */
export function subtractCutout(outerRingPx, holeRingsPx, deductRingPx) {
  let result;
  try {
    const parentPoly = turfPolygon([closeRing(outerRingPx), ...holeRingsPx.map(closeRing)]);
    const deductPoly = turfPolygon([closeRing(deductRingPx)]);
    result = turfDifference(featureCollection([parentPoly, deductPoly]));
  } catch {
    return null;
  }
  if (!result || result.geometry?.type !== "Polygon") return null;
  const [outer, ...holes] = result.geometry.coordinates.map(openRing);
  if (outer.length < 3) return null;
  const metrics = polyWithHolesMetrics(outer, holes);
  return { outer, holes, area: metrics.area, perim: metrics.perim };
}

/**
 * Re-derives a parent's geometry after ONE cutout in a multi-cut chain is
 * deleted: starts from a pristine base (the chain's EARLIEST frozen
 * parent_prev snapshot) and re-subtracts every SURVIVING deduct ring in
 * order. Set subtraction is order-insensitive, but commit order keeps each
 * intermediate step identical to how it first resolved. Zero surviving rings
 * → the base itself with fresh metrics.
 * @param {number[][]} baseOuterPx pristine outer ring, px space.
 * @param {number[][][]} baseHolesPx pristine holes (usually empty), px space.
 * @param {number[][][]} deductRingsPx surviving deduct rings, commit order.
 * @returns {{outer: number[][], holes: number[][][], area: number, perim: number}|null}
 *   null when any re-subtract degenerates — the caller must NOT restore the
 *   pristine base over surviving cuts; it falls back to a plain delete that
 *   leaves the doomed cut baked in (the pre-existing multi-delete limitation).
 */
export function recomposeCutouts(baseOuterPx, baseHolesPx, deductRingsPx) {
  let outer = baseOuterPx, holes = baseHolesPx;
  for (const ring of deductRingsPx) {
    const r = subtractCutout(outer, holes, ring);
    if (!r) return null;
    outer = r.outer; holes = r.holes;
  }
  const metrics = polyWithHolesMetrics(outer, holes);
  return { outer, holes, area: metrics.area, perim: metrics.perim };
}

// ── the deduct on an OPEN RUN (surface_area / linear) ────────────────────────
// Wall tile is not a polygon. The Surface Area tool traces the wall RUN in
// plan and multiplies its length by the condition's height (commitSurface);
// wall base and transitions are the same open polyline without the height.
// Everything above this line — and, before this, every path the Cut Out tool
// could take — resolves against `floor_area` shapes only, so an estimator who
// took a wall off and then needed a stretch of it back OUT (a wet wall to be
// re-traced under a waterproofed condition, say) had nothing to do it with:
// the deduct landed as an independent overlay whose area was subtracted from
// the condition's FLOOR total, a bucket a wall run never contributes to. The
// wall SF never moved.
//
// Subtracting a ring from a run means CLIPPING: keep every part of the
// polyline OUTSIDE the ring. A run cut in the middle comes back as two runs,
// and that split is legitimate here in a way a polygon split is not — length
// is additive, and each piece keeps the condition, the height and the label
// that made it. A polygon split asks "which piece is the room?"; a run split
// asks nothing.
//
// Pixel-space in, pixel-space out, same as everything above.

// Parametric position along a→b where it crosses c→d, or null (parallel, or
// the crossing lies off either segment). Endpoint-exact hits are kept — the
// caller drops the degenerate slivers they produce.
function segCrossT(a, b, c, d) {
  const rx = b[0] - a[0], ry = b[1] - a[1];
  const sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;              // parallel / collinear
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/**
 * Clips an open run against a ring, keeping what falls OUTSIDE the ring.
 * @param {number[][]} runPx the run's points, px space (2+ points).
 * @param {number[][]} ringPx the deduct ring, px space (3+ points, open).
 * @returns {number[][][]} the surviving runs in draw order — [] when the ring
 *   swallowed the whole run, [runPx] when it missed entirely.
 */
export function clipRunOutside(runPx, ringPx) {
  if (runPx.length < 2 || ringPx.length < 3) return [runPx];
  const EPS = 1e-9;
  const runs = [];
  let cur = null;                                       // the run being extended; null = the last piece was cut away
  for (let i = 1; i < runPx.length; i++) {
    const a = runPx[i - 1], b = runPx[i];
    const ts = [0, 1];
    for (let j = 0; j < ringPx.length; j++) {
      const t = segCrossT(a, b, ringPx[j], ringPx[(j + 1) % ringPx.length]);
      if (t !== null && t > EPS && t < 1 - EPS) ts.push(t);
    }
    ts.sort((p, q) => p - q);
    for (let k = 1; k < ts.length; k++) {
      const t0 = ts[k - 1], t1 = ts[k];
      if (t1 - t0 < EPS) continue;
      const mid = lerp(a, b, (t0 + t1) / 2);
      if (pointInPoly(mid[0], mid[1], ringPx)) { cur = null; continue; }
      // sub-segments partition the run IN ORDER, so "contiguous with what came
      // before" is exactly "the previous sub-segment survived too"
      if (!cur) { cur = [lerp(a, b, t0)]; runs.push(cur); }
      cur.push(lerp(a, b, t1));
    }
  }
  return runs.filter((r) => r.length >= 2 && openLen(r) > EPS);
}

/**
 * One run vs the deduct ring — the open-polyline twin of subtractCutout, with
 * the degenerate cases NAMED rather than collapsed to null:
 *   null                              the ring never touched this run
 *   { kind: "erased" }                the ring swallowed it whole — DELETE it
 *   { kind: "cut", runs, len }        what survives (1+ runs, px space) and
 *                                     their total length in px
 * A run cut never refuses: splitting a run is a normal outcome, not the
 * identity problem splitting a polygon is.
 */
export function cutRun(runPx, deductRingPx) {
  if (runPx.length < 2) return null;
  const before = openLen(runPx);
  const runs = clipRunOutside(runPx, deductRingPx);
  const len = runs.reduce((n, r) => n + openLen(r), 0);
  if (before - len < 1e-9) return null;                 // nothing came off
  if (!runs.length) return { kind: "erased" };
  return { kind: "cut", runs, len };
}

/**
 * Every run the ring touches, each clipped independently — order-independent,
 * and unlike the floor_area path it does NOT need one unambiguous parent: a
 * ring dropped over a corner where two wall runs meet cuts both, which is what
 * the estimator drew.
 * @param {Array<{id: string, runPx: number[][]}>} runs
 * @param {number[][]} deductRingPx
 */
export function cutRunsAcross(runs, deductRingPx) {
  const out = [];
  for (const r of runs) {
    const c = cutRun(r.runPx, deductRingPx);
    if (c) out.push({ id: r.id, ...c });
  }
  return out;
}
