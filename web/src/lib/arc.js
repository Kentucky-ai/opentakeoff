// Three-point circular arc — the curve an estimator actually needs.
//
// A radius wall on a plan IS a circle: the architect drew it with a center and
// a radius, so the only curve that can sit ON it is a circular arc. Two clicks
// fix nothing (infinitely many circles pass through two points) and four or
// more over-determine it, so the gesture is exactly three: the arc's START is
// the vertex you already placed, then you click a point ON the bow, then the
// END — and the arc through those three is unique. Move the third and the arc
// re-solves live, which is what makes it a TRACE instead of a guess: put the
// middle click anywhere on the wall and the arc lands on the wall.
//
// This replaces splining a run of clicked points (Catmull-Rom, #284). A spline
// interpolates its points and wanders between them — it is right AT the clicks
// and wrong everywhere else, so tracing a bow meant chasing it with a dozen
// knots and still missing. Three clicks, exact everywhere.
//
// Sheet px in = sheet px out, and the arc is a DRAWING gesture, not a new
// geometry type: everything flattens at commit, so SF/LF, the eraser,
// hit-testing, the report and every export keep seeing plain polygons.

const TAU = Math.PI * 2;
const norm = (a) => ((a % TAU) + TAU) % TAU;

/**
 * The circle through three points, or null when there isn't one — collinear,
 * coincident, or so nearly straight that the center runs off to infinity and
 * the "arc" is a chord with rounding noise on it. Every caller falls back to
 * the straight segment on null, which is the right answer for a flat bow.
 *
 * @returns {{cx:number, cy:number, r:number, a0:number, a1:number, am:number, sweep:number}|null}
 *   sweep is SIGNED and carries the direction that passes through `m`:
 *   positive = increasing angle (clockwise on screen, y-down), |sweep| < 2π.
 */
export function circleThrough(a, m, b) {
  const [ax, ay] = a, [mx, my] = m, [bx, by] = b;
  // 2× the signed area of the triangle — zero when the three are collinear
  const d = 2 * (ax * (my - by) + mx * (by - ay) + bx * (ay - my));
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return null;
  const a2 = ax * ax + ay * ay, m2 = mx * mx + my * my, b2 = bx * bx + by * by;
  const cx = (a2 * (my - by) + m2 * (by - ay) + b2 * (ay - my)) / d;
  const cy = (a2 * (bx - mx) + m2 * (ax - bx) + b2 * (mx - ax)) / d;
  const r = Math.hypot(ax - cx, ay - cy);
  // A center this far out is a straight line wearing a circle's clothes; the
  // flattened arc would be indistinguishable from the chord anyway.
  if (!Number.isFinite(r) || r > 1e7) return null;
  const a0 = Math.atan2(ay - cy, ax - cx);
  const a1 = Math.atan2(by - cy, bx - cx);
  const am = Math.atan2(my - cy, mx - cx);
  // Which way round: take the direction whose path from a to b crosses m.
  const fwd = norm(a1 - a0);            // increasing-angle sweep a → b
  const fwdM = norm(am - a0);           // …and where m falls along it
  const sweep = fwdM <= fwd ? fwd : fwd - TAU;
  return { cx, cy, r, a0, a1, am, sweep };
}

// How many straight pieces the arc is worth. Scales with drawn length so a
// tight fillet and a 40 ft radius wall both read smooth, under a hard cap so a
// sweeping corridor can't mint a thousand-vertex shape (render-invariance
// budget), and with a floor so a small arc never goes faceted.
function stepsFor(r, sweep) {
  const len = Math.abs(sweep) * r;
  const bySpan = Math.abs(sweep) / (4 * Math.PI / 180);   // ≥ one piece per 4°
  return Math.max(8, Math.min(96, Math.ceil(Math.max(len / 4, bySpan))));
}

/**
 * a → (through m) → b, flattened to a polyline. Returns the INTERIOR points
 * only — neither `a` nor `b` — so a boundary walk can push its own corners and
 * never double one. Collinear input returns [] (the caller's straight segment
 * from a to b is already the right geometry).
 *
 * `m` is emitted EXACTLY, and the budget is split either side of it. The bow
 * point is a click, often a snapped one: it is a place on the wall the
 * estimator chose, so the drawn boundary has to actually go through it rather
 * than past it by half a step.
 */
export function flattenArc(a, m, b) {
  const c = circleThrough(a, m, b);
  if (!c) return [];
  const total = stepsFor(c.r, c.sweep);
  // where m falls along the sweep, in the sweep's own direction
  const toM = c.sweep >= 0 ? norm(c.am - c.a0) : -norm(c.a0 - c.am);
  const f = Math.abs(c.sweep) > 1e-12 ? Math.min(1, Math.abs(toM) / Math.abs(c.sweep)) : 0;
  const n1 = Math.max(1, Math.min(total - 1, Math.round(total * f)));
  const n2 = Math.max(1, total - n1);
  const at = (t) => [c.cx + c.r * Math.cos(t), c.cy + c.r * Math.sin(t)];
  const out = [];
  for (let i = 1; i < n1; i++) out.push(at(c.a0 + toM * (i / n1)));
  out.push([m[0], m[1]]);
  for (let i = 1; i < n2; i++) out.push(at(c.am + (c.sweep - toM) * (i / n2)));
  return out;
}

/** Drawn length of the arc a → m → b, in the units the points came in. */
export function arcLength(a, m, b) {
  const c = circleThrough(a, m, b);
  return c ? Math.abs(c.sweep) * c.r : Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/**
 * SVG path data for the LIVE preview — one `A` command, so the bow you are
 * dragging is a true conic at any zoom instead of the flattened stand-in the
 * commit will store. Falls back to a straight `L` when there's no circle.
 */
export function arcPathD(a, m, b) {
  const c = circleThrough(a, m, b);
  if (!c) return `M ${a[0]} ${a[1]} L ${b[0]} ${b[1]}`;
  const large = Math.abs(c.sweep) > Math.PI ? 1 : 0;
  // angles come from atan2 in a y-down frame, so increasing angle IS SVG's
  // positive sweep direction — no flip needed
  const dir = c.sweep > 0 ? 1 : 0;
  return `M ${a[0]} ${a[1]} A ${c.r} ${c.r} 0 ${large} ${dir} ${b[0]} ${b[1]}`;
}

/**
 * Boundary points → the drawn polyline (sheet px in = sheet px out).
 *
 * `throughAt` marks the points that are the MIDDLE of an arc: index i marked
 * means the boundary runs pts[i-1] → pts[i] → pts[i+1] as one circular arc
 * instead of two straight segments. A marked point with no neighbour to lean
 * on — first or last of an open trace, or sitting next to another mark — is
 * demoted to a plain corner, so a half-placed arc still draws as something
 * honest while the estimator is mid-gesture.
 *
 * @param {number[][]} pts        traced vertices
 * @param {number[]|Set<number>} [throughAt] indices of arc MIDDLE points
 * @param {boolean} [closed]      true for a committed ring (the last point
 *                                wraps to the first), false for the
 *                                in-progress trace
 */
export function flattenArcRing(pts, throughAt, closed = true) {
  const src = pts || [];
  const n = src.length;
  const copy = () => src.map((p) => [p[0], p[1]]);
  const marks = throughAt instanceof Set ? throughAt : new Set(throughAt || []);
  if (n < 3 || !marks.size) return copy();

  // A mark only counts where both neighbours exist and neither is itself a
  // mark — resolved up front so the walk below never has to look two ways.
  const live = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (!marks.has(i)) continue;
    const hasPrev = closed || i > 0;
    const hasNext = closed || i < n - 1;
    if (!hasPrev || !hasNext) continue;
    const pi = (i - 1 + n) % n, ni = (i + 1) % n;
    if (marks.has(pi) || marks.has(ni)) continue;   // adjacent marks: no clean triple
    live[i] = true;
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    if (!live[i]) { out.push([src[i][0], src[i][1]]); continue; }
    // the corner before was pushed on its own turn; the corner after will be
    for (const p of flattenArc(src[(i - 1 + n) % n], src[i], src[(i + 1) % n])) out.push(p);
  }
  return out;
}
