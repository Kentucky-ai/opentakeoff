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
export function hitShape(shape, x, y, w, h, thr) {
  const pts = shape.verts_norm.map(([nx, ny]) => [nx * w, ny * h]);
  if (shape.measure_role === "count") return Math.hypot(pts[0][0] - x, pts[0][1] - y) < thr * 2;
  if (shape.measure_role === "linear" || shape.measure_role === "surface_area") { for (let i = 1; i < pts.length; i++) if (distToSeg(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) < thr) return true; return false; }
  if (pointInPoly(x, y, pts)) return true;
  for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; if (distToSeg(x, y, pts[i][0], pts[i][1], pts[j][0], pts[j][1]) < thr) return true; }
  return false;
}
