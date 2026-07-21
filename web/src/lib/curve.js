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
