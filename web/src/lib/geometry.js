// Pure canvas-geometry helpers — module-level functions shared by the Takeoff
// Canvas (no DOM, no pdf.js; node-testable). Extracted verbatim from
// TakeoffCanvas.jsx so the math has one home and a test file; the canvas
// component itself deliberately stays one large JSX file (see DECISION-TREE
// D4) — this is its toolbox, not a decomposition.
//
// This file is kept BYTE-IDENTICAL between OpenTakeoff and Spline (the two
// canvases share a render model and port 1:1). Repo-specific tuning — e.g.
// the snap-grid cell size — is passed in by the caller, never defaulted here.

// small, sharp star marker (vertices + snap indicator) — easier to see corners than a dot
export function starPath(cx, cy, R, points = 4, innerRatio = 0.38) {
  const r = R * innerRatio; let d = "";
  for (let i = 0; i < points * 2; i++) {
    const a = (Math.PI * i) / points - Math.PI / 2, rad = i % 2 === 0 ? R : r;
    d += `${i === 0 ? "M" : "L"}${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)} `;
  }
  return d + "Z";
}

// Small filled arrowhead at (tipX,tipY), pointing along the direction from
// (fromX,fromY) → (tipX,tipY). Returns a closed SVG path (a triangle) — used
// for the callout leader's target end on-canvas and in the marked-set PDF.
// Degenerate (zero-length) leaders fall back to pointing straight up so the
// path is always valid.
export function arrowheadPath(fromX, fromY, tipX, tipY, size = 6) {
  let dx = tipX - fromX, dy = tipY - fromY;
  const len = Math.hypot(dx, dy);   // raw — so the degenerate (zero-length) guard can fire
  if (len < 1e-6) { dx = 0; dy = 1; } else { dx /= len; dy /= len; }
  const bx = tipX - dx * size, by = tipY - dy * size;   // base center, back along the leader
  const nx = -dy, ny = dx, half = size * 0.5;            // perpendicular half-width
  return `M${tipX},${tipY} L${bx + nx * half},${by + ny * half} L${bx - nx * half},${by - ny * half} Z`;
}

// Revision-cloud path: a scalloped rectangle around [x0,y0]-[x1,y1] (image px).
export function cloudPath(x0, y0, x1, y1) {
  const ax0 = Math.min(x0, x1), ay0 = Math.min(y0, y1), ax1 = Math.max(x0, x1), ay1 = Math.max(y0, y1);
  const r = Math.max(6, Math.min(22, (ax1 - ax0 + ay1 - ay0) / 22));
  const arc = (len) => Math.max(1, Math.round(len / (r * 1.6)));
  let d = `M ${ax0} ${ay0}`;
  const edge = (fromX, fromY, toX, toY) => {
    const n = arc(Math.hypot(toX - fromX, toY - fromY));
    for (let i = 1; i <= n; i++) {
      const px = fromX + (toX - fromX) * (i / n), py = fromY + (toY - fromY) * (i / n);
      d += ` A ${r} ${r} 0 0 1 ${px} ${py}`;
    }
  };
  edge(ax0, ay0, ax1, ay0); edge(ax1, ay0, ax1, ay1); edge(ax1, ay1, ax0, ay1); edge(ax0, ay1, ax0, ay0);
  return d + " Z";
}

// One SVG elliptical-arc (equal radii `r`, no x-rotation) from (x0,y0) to
// (x1,y1) with the given large-arc/sweep flags, approximated by a SINGLE cubic
// bezier. Returns [c1x, c1y, c2x, c2y] (the two control points; the end point is
// the caller's (x1,y1)). Endpoint→center conversion per SVG F.6.5, then the
// classic tangent construction alpha = 4/3·tan(Δθ/4) (alpha is computed from the
// REAL sweep Δθ, ~106° for the default r*1.6 scallop spacing — kappa≈0.5523 is the
// 90° reference; one cubic per scallop stays sub-percent error at this angle).
// Control points are plain points, so — unlike an `A` command — they survive an
// arbitrary affine page transform. Used to draw revision-cloud scallops in the
// marked-set PDF (arcs there would flatten under toPage).
function arcToBezier(x0, y0, x1, y1, r, laf, sf) {
  const dx = (x0 - x1) / 2, dy = (y0 - y1) / 2;   // F.6.5.1 (no rotation)
  let rr = Math.abs(r) || 1;
  const lambda = (dx * dx + dy * dy) / (rr * rr);
  if (lambda > 1) rr *= Math.sqrt(lambda);        // F.6.6.2: grow r to reach the chord
  const sign = laf !== sf ? 1 : -1;
  const num = rr * rr * rr * rr - rr * rr * dy * dy - rr * rr * dx * dx;
  const den = rr * rr * dy * dy + rr * rr * dx * dx;
  const coef = sign * Math.sqrt(Math.max(0, den === 0 ? 0 : num / den));
  const cxp = coef * dy, cyp = -coef * dx;        // center in the primed frame
  const ang = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy, len = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const th1 = ang(1, 0, (dx - cxp) / rr, (dy - cyp) / rr);
  let dth = ang((dx - cxp) / rr, (dy - cyp) / rr, (-dx - cxp) / rr, (-dy - cyp) / rr);
  if (!sf && dth > 0) dth -= 2 * Math.PI;
  if (sf && dth < 0) dth += 2 * Math.PI;
  const th2 = th1 + dth;
  const alpha = (4 / 3) * Math.tan(dth / 4);      // signed with dth → correct sweep
  return [
    x0 - alpha * rr * Math.sin(th1), y0 + alpha * rr * Math.cos(th1),
    x1 + alpha * rr * Math.sin(th2), y1 - alpha * rr * Math.cos(th2),
  ];
}

// Revision cloud as cubic-bezier segments — the transform-safe twin of
// cloudPath. Same scallop geometry (identical `r` and per-edge arc count), but
// each `A` arc becomes one cubic bezier so the outline survives the marked-set
// affine page transform (control points map correctly; arcs don't). Coordinate-
// space agnostic (feed it image px, like cloudPath). Returns { start:[x,y],
// segments:[[[c1x,c1y],[c2x,c2y],[endx,endy]], …] } — a closed loop
// (last end ≈ start). Consumers emit `M start C c1 c2 end … Z`.
export function cloudBezier(x0, y0, x1, y1) {
  const ax0 = Math.min(x0, x1), ay0 = Math.min(y0, y1), ax1 = Math.max(x0, x1), ay1 = Math.max(y0, y1);
  const r = Math.max(6, Math.min(22, (ax1 - ax0 + ay1 - ay0) / 22));
  const arc = (len) => Math.max(1, Math.round(len / (r * 1.6)));
  const segments = [];
  let px = ax0, py = ay0;
  const edge = (fromX, fromY, toX, toY) => {
    const n = arc(Math.hypot(toX - fromX, toY - fromY));
    for (let i = 1; i <= n; i++) {
      const qx = fromX + (toX - fromX) * (i / n), qy = fromY + (toY - fromY) * (i / n);
      const [c1x, c1y, c2x, c2y] = arcToBezier(px, py, qx, qy, r, 0, 1);
      segments.push([[c1x, c1y], [c2x, c2y], [qx, qy]]);
      px = qx; py = qy;
    }
  };
  edge(ax0, ay0, ax1, ay0); edge(ax1, ay0, ax1, ay1); edge(ax1, ay1, ax0, ay1); edge(ax0, ay1, ax0, ay0);
  return { start: [ax0, ay0], segments };
}

// Mirror a normalized vertex ring about its OWN bbox center on one axis.
// axis "h" flips left↔right (reflects X), "v" flips top↔bottom (reflects Y).
// Isometry: perimeter/area are invariant, so quantities never change.
export function reflectVertsNorm(verts, axis) {
  if (!Array.isArray(verts) || verts.length < 2) return verts;
  const ax = axis === "v" ? 1 : 0;
  let lo = Infinity, hi = -Infinity;
  for (const v of verts) { if (v[ax] < lo) lo = v[ax]; if (v[ax] > hi) hi = v[ax]; }
  const s = lo + hi;
  return verts.map((v) => (ax === 0 ? [s - v[0], v[1]] : [v[0], s - v[1]]));
}

// ── snap-to-vector spatial hash. The op-list walk that feeds it (endpoints +
// line segments for One-Click Area) lives in lib/oneclick: extractVectorGeometry.
// `cell` is the caller's tuning (raster px per bucket) — see SNAP_CELL in the canvas.
export function buildSnapGrid(points, cell) {
  const map = new Map();
  for (const p of points) { const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`; let a = map.get(k); if (!a) { a = []; map.set(k, a); } if (a.length < 40) a.push(p); }
  return { cell, map };
}
export function nearestSnap(grid, x, y, maxDist) {
  if (!grid) return null;
  const { cell, map } = grid, cx = Math.floor(x / cell), cy = Math.floor(y / cell);
  let best = null, bestD = maxDist * maxDist;
  for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
    const a = map.get(`${gx},${gy}`); if (!a) continue;
    for (const p of a) { const dx = p[0] - x, dy = p[1] - y, d = dx * dx + dy * dy; if (d < bestD) { bestD = d; best = p; } }
  }
  return best;
}

// ── polar tracking: lock the next segment to the 45° family (sheet axes).
// Within ANGLE_TOL° of a 45° multiple — or at any angle while Shift forces it —
// the cursor projects onto the locked ray from the last vertex, so the committed
// segment is exactly on-axis. The stage transform is translate+scale only, so
// image-space angles ARE sheet angles.
export const ANGLE_TOL = 4;
export function angleSnap(last, cur, force) {
  const dx = cur[0] - last[0], dy = cur[1] - last[1];
  if (!dx && !dy) return null;
  const theta = (Math.atan2(dy, dx) * 180) / Math.PI;
  const snapped = Math.round(theta / 45) * 45;
  if (!force && Math.abs(theta - snapped) > ANGLE_TOL) return null;
  const rad = (snapped * Math.PI) / 180, ux = Math.cos(rad), uy = Math.sin(rad);
  const d = dx * ux + dy * uy;   // projection keeps the cursor's distance along the ray
  return { pt: [last[0] + d * ux, last[1] + d * uy], ux, uy, deg: ((snapped % 180) + 180) % 180 };
}

export function closedMetrics(pts) {
  const n = pts.length;
  if (n < 3) {
    let perim = 0;
    for (let i = 1; i < n; i++) perim += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return { area: 0, perim };
  }
  let area = 0, perim = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
    perim += Math.hypot(x2 - x1, y2 - y1);
  }
  return { area: Math.abs(area) / 2, perim };
}
export function openLen(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; }
// #137 — a polygon that carries real holes (verts_norm_holes: a Cut Out that
// was reconciled into the parent's own geometry via a real boolean subtract,
// see lib/cutout.js): outer ring's area LESS every hole's, perimeter PLUS
// every hole's boundary — a hole is a real wall, it gets walked same as the
// outer ring, not zeroed out. Same pixel-space-in/pixel-space-out convention
// as closedMetrics (caller scales by upp/upp²). Floors at 0 so a degenerate
// hole set (shouldn't happen off a real turf.difference result, but a stale
// hand-edited project file could carry one) can't hand back negative SF.
export function polyWithHolesMetrics(outerPts, holesPts = []) {
  const outer = closedMetrics(outerPts);
  let area = outer.area, perim = outer.perim;
  for (const h of holesPts) {
    const hm = closedMetrics(h);
    area -= hm.area; perim += hm.perim;
  }
  return { area: Math.max(0, area), perim };
}
export function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
export function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// does (x,y) image-px hit this shape (within thr px)?
// #137 — hole-aware: a shape carrying verts_norm_holes (a real Cut Out) does
// NOT hit-test true for a point strictly inside one of its holes — clicking
// into the cut should reach whatever's underneath (or nothing), not the
// condition it was cut out of. The hole's own boundary still counts as an
// edge hit, exactly like the outer ring's. No-op (byte-identical to before)
// when the shape carries no holes.
export function hitShape(shape, x, y, w, h, thr) {
  const pts = shape.verts_norm.map(([nx, ny]) => [nx * w, ny * h]);
  if (shape.measure_role === "count") return Math.hypot(pts[0][0] - x, pts[0][1] - y) < thr * 2;
  if (shape.measure_role === "linear" || shape.measure_role === "surface_area") { for (let i = 1; i < pts.length; i++) if (distToSeg(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) < thr) return true; return false; }
  const holes = (shape.verts_norm_holes || []).map((ring) => ring.map(([nx, ny]) => [nx * w, ny * h]));
  if (pointInPoly(x, y, pts) && !holes.some((hpts) => pointInPoly(x, y, hpts))) return true;
  for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; if (distToSeg(x, y, pts[i][0], pts[i][1], pts[j][0], pts[j][1]) < thr) return true; }
  for (const hpts of holes) {
    for (let i = 0; i < hpts.length; i++) { const j = (i + 1) % hpts.length; if (distToSeg(x, y, hpts[i][0], hpts[i][1], hpts[j][0], hpts[j][1]) < thr) return true; }
  }
  return false;
}

// ── freehand highlighter geometry (byte-identical with Spline's canvas copy) ──
// Freehand capture: drop points closer than minDist to the last kept point (keep first+last).
export function thinStroke(pts, minDist) {
  if (pts.length <= 2) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(pts[i][0] - last[0], pts[i][1] - last[1]) >= minDist) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
// Open Catmull-Rom → cubic Bézier SVG "d" through pts (k=6 tangent divisor).
export function strokePathD(pts) {
  if (!pts.length) return "";
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}
// Chisel-nib ribbon: offset every point ±w/2 along a FIXED nib direction (nibDeg),
// forward offsets then reversed backward offsets — a closed polygon. Faceting on the
// raw polyline is authentic to a chisel nib and keeps the PDF exporters trivial.
export function chiselRibbon(pts, w, nibDeg = 45) {
  const a = (nibDeg * Math.PI) / 180, vx = (Math.cos(a) * w) / 2, vy = -(Math.sin(a) * w) / 2;
  return [...pts.map(([x, y]) => [x + vx, y + vy]), ...[...pts].reverse().map(([x, y]) => [x - vx, y - vy])];
}

// Do two segments (p1p2, p3p4) intersect? Full predicate: the general straddle
// test, plus collinear-overlap and T-touch handling, with shared endpoints
// deliberately excluded (a ring's adjacent edges always share one).
export function segsIntersect(p1, p2, p3, p4) {
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0) {
    // collinear: compare 1-D intervals on the line's own axis (y only when the
    // shared line is vertical — then x can't tell points apart)
    const k = p1[0] === p2[0] && p1[0] === p3[0] && p1[0] === p4[0] ? 1 : 0;
    const aLo = Math.min(p1[k], p2[k]), aHi = Math.max(p1[k], p2[k]);
    const bLo = Math.min(p3[k], p4[k]), bHi = Math.max(p3[k], p4[k]);
    const lo = Math.max(aLo, bLo), hi = Math.min(aHi, bHi);
    if (lo > hi) return false;                                 // disjoint
    if (lo < hi) return true;                                  // a real overlap run
    // single-point contact: intersects only if it is NOT an endpoint of both
    return !((aLo === lo || aHi === lo) && (bLo === lo || bHi === lo));
  }
  // T-touch: an endpoint riding the OTHER segment (cross 0 puts it on the line,
  // so bbox containment puts it on the segment); shared endpoints excluded.
  const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
  const onSeg = (a, b, c) =>
    Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);
  if (d1 === 0 && onSeg(p3, p4, p1) && !eq(p1, p3) && !eq(p1, p4)) return true;
  if (d2 === 0 && onSeg(p3, p4, p2) && !eq(p2, p3) && !eq(p2, p4)) return true;
  if (d3 === 0 && onSeg(p1, p2, p3) && !eq(p3, p1) && !eq(p3, p2)) return true;
  if (d4 === 0 && onSeg(p1, p2, p4) && !eq(p4, p1) && !eq(p4, p2)) return true;
  return false;
}

// Does a closed ring cross itself? Every non-adjacent edge pair, closing edge
// included. Feeds the drawing-styles invalid-flip (a theme with invalidColor
// recolors a self-crossing area/deduct/zone draft). Ring tools only — an open
// polyline has no closing edge and must never flip.
export function ringSelfIntersects(pts) {
  const n = Array.isArray(pts) ? pts.length : 0;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;                    // adjacent through the closing edge
      if (segsIntersect(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

// ── snap-to-vector spatial hash. The op-list walk that feeds it (endpoints +
// line segments for One-Click Area) lives in lib/oneclick: extractVectorGeometry.
// `cell` is the caller's tuning (raster px per bucket) — see SNAP_CELL in the canvas.
