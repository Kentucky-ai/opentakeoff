// Curved-line geometry — a centripetal Catmull-Rom spline through the estimator's
// clicked control points, flattened to a dense polyline for length math, rendering,
// and hit-testing. The SHAPE stores only the control points (few, draggable — drag
// one and the curve re-smooths), while every consumer (totals, reflow, export)
// sees the flattened polyline, so downstream math is exactly the linear
// tool's. Centripetal parameterization (alpha 0.5) is the standard fix for the
// cusps/loops uniform Catmull-Rom produces on unevenly spaced clicks.

function crPoint(p0, p1, p2, p3, t) {
  // Barry–Goldman pyramidal evaluation with centripetal knots.
  const knot = (ti, a, b) => ti + Math.sqrt(Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), 1e-6));
  const t0 = 0, t1 = knot(t0, p0, p1), t2 = knot(t1, p1, p2), t3 = knot(t2, p2, p3);
  const u = t1 + (t2 - t1) * t;
  const lp = (a, b, ta, tb) => {
    const w = (u - ta) / ((tb - ta) || 1e-9);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  };
  const A1 = lp(p0, p1, t0, t1), A2 = lp(p1, p2, t1, t2), A3 = lp(p2, p3, t2, t3);
  const B1 = lp(A1, A2, t0, t2), B2 = lp(A2, A3, t1, t3);
  return lp(B1, B2, t1, t2);
}

// Control points → flattened polyline (sheet px in = sheet px out). Fewer than 3
// points is already a straight line — returned as a copy. Steps per segment scale
// with chord length (smooth at any zoom) under a hard total cap, so a long curved
// corridor can't mint a thousand-vertex shape (render-invariance budget).
export function flattenCurve(pts, opts = {}) {
  const maxPts = opts.maxPts || 220;
  const n = (pts || []).length;
  if (n < 3) return (pts || []).map((p) => [p[0], p[1]]);
  const P = [pts[0], ...pts, pts[n - 1]];
  const want = [];
  let total = 0;
  for (let i = 1; i < P.length - 2; i++) {
    const chord = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]);
    const steps = Math.max(6, Math.min(24, Math.round(chord / 6)));
    want.push(steps); total += steps;
  }
  const scale = total > maxPts ? maxPts / total : 1;
  const out = [[pts[0][0], pts[0][1]]];
  for (let i = 1; i < P.length - 2; i++) {
    const steps = Math.max(2, Math.round(want[i - 1] * scale));
    for (let j = 1; j <= steps; j++) out.push(crPoint(P[i - 1], P[i], P[i + 1], P[i + 2], j / steps));
  }
  return out;
}

// ── curved AREA boundaries (#284) ────────────────────────────────────────────
// A footprint is rarely all-straight or all-curved: it is straight walls with
// an arc in them. So a ring carries a set of CURVE vertices (shape.curve_at)
// alongside its points, and a maximal run of them — together with the plain
// anchor on each side — flattens through the same centripetal spline the
// curved line tool uses. Everything outside a run stays a straight segment,
// exactly as traced.
//
// The result is one closed polyline, which is the whole point: area,
// perimeter, cutouts, hit-testing, the marked PDF and every export keep
// treating it as a normal polygon. Nothing downstream learns a new geometry.

/** Every vertex curved, ring closed: one periodic spline, no seam. Same
 * chord-proportional step budget as flattenCurve (smooth at any zoom, hard
 * total cap so a big ring can't mint a thousand-vertex shape). */
export function flattenClosedCurve(pts, opts = {}) {
  const n = (pts || []).length;
  if (n < 3) return (pts || []).map((p) => [p[0], p[1]]);
  const maxPts = opts.maxPts || 220;
  const at = (i) => pts[((i % n) + n) % n];
  const want = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = at(i), b = at(i + 1);
    const steps = Math.max(6, Math.min(24, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 6)));
    want.push(steps); total += steps;
  }
  const scale = total > maxPts ? maxPts / total : 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const steps = Math.max(2, Math.round(want[i] * scale));
    out.push([at(i)[0], at(i)[1]]);
    for (let j = 1; j < steps; j++) out.push(crPoint(at(i - 1), at(i), at(i + 1), at(i + 2), j / steps));
  }
  return out;
}

/**
 * Boundary points → the drawn polyline (sheet px in = sheet px out).
 *
 * @param {number[][]} pts        traced vertices
 * @param {number[]|Set<number>} [curveAt] indices of CURVE vertices
 * @param {boolean} [closed]      true for a committed ring, false for the
 *                                in-progress trace (no wrap: a run at either
 *                                end anchors on itself)
 */
export function flattenRing(pts, curveAt, closed = true, opts = {}) {
  const src = pts || [];
  const n = src.length;
  const marks = curveAt instanceof Set ? curveAt : new Set(curveAt || []);
  const copy = () => src.map((p) => [p[0], p[1]]);
  if (n < 3 || !marks.size) return copy();
  const mark = new Array(n);
  let curved = 0;
  for (let i = 0; i < n; i++) { mark[i] = marks.has(i); if (mark[i]) curved++; }
  if (!curved) return copy();
  if (curved === n) return closed ? flattenClosedCurve(src, opts) : flattenCurve(src, opts);

  // Rotate a closed ring so it starts on a plain anchor — then a run can never
  // wrap past the end, and the walk below is the same for both modes. A ring's
  // start vertex is arbitrary (area, perimeter and the drawn path are all
  // invariant to it), so this costs nothing.
  let P = src, M = mark;
  if (closed) {
    const s = mark.indexOf(false);
    if (s > 0) { P = [...src.slice(s), ...src.slice(0, s)]; M = [...mark.slice(s), ...mark.slice(0, s)]; }
  }
  const out = [];
  let i = 0;
  while (i < n) {
    if (!M[i]) { out.push([P[i][0], P[i][1]]); i++; continue; }
    let j = i;
    while (j < n && M[j]) j++;
    // The span an anchor hands the curve is part of the curve: control points
    // are anchor → run → anchor, so the boundary leaves and rejoins the
    // straight work smoothly instead of kinking at the handover.
    const havePrev = closed || i > 0;
    const haveNext = closed || j < n;
    const prev = havePrev ? P[(i - 1 + n) % n] : P[i];
    const next = haveNext ? P[j % n] : P[j - 1];
    const flat = flattenCurve([prev, ...P.slice(i, j), next], opts);
    // drop an endpoint only when a real anchor owns it: prev was pushed on its
    // own turn, next will be
    for (let k = havePrev ? 1 : 0; k < (haveNext ? flat.length - 1 : flat.length); k++) out.push(flat[k]);
    i = j;
  }
  return out;
}
