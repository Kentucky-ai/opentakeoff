// ── ringTidy — one geometry pass for rings people have to live with ────────
// A mask-derived ring (One-Click flood, detect_rooms, a raster trace) carries
// dozens–hundreds of staircase vertices; hand-dragging them can't produce a
// straight wall. One shared pass fixes what the trace left jagged:
//   anchorFlags   which vertices sit ON a CAD endpoint (re-derived from the
//                 snap grid — per-vertex snap provenance is never stored)
//   tidyRing      consolidate collinear/micro-segment runs BETWEEN anchors,
//                 then Manhattan-lock near-axis runs — anchors never move,
//                 and drifted near-anchor vertices pull home
//   axisLockPoint live-drag helper: a dragged vertex locks onto its
//                 neighbors' axes so edited walls stay straight
// Pure TypeScript (no React, no DOM) like the rest of lib/. Everything works
// in image px (panel-local); callers convert at their edges. Discipline
// inherited from snapVertices: never return something worse than the input —
// a degenerate or area-drifting result falls back to the input ring.
import { rdpOpen, rdpClosed, ringArea } from "./oneclick.js";
import type { Point, NearestFn } from "./oneclick.js";

// A vertex within this of a CAD endpoint counts as anchored to it. Tight on
// purpose: anchors are vertices the snap tail ALREADY placed on an endpoint,
// not vertices that merely pass near one.
export const ANCHOR_TOL_PX = 1.25;

// A segment within this many degrees of horizontal/vertical is a wall the
// drafter meant straight; beyond it, a genuinely angled wall — left alone.
export const AXIS_TOL_DEG = 8;

export interface TidyResult {
  ring: Point[];
  anchors: boolean[];
  changed: boolean;
}

export interface TidyOpts {
  nearest?: NearestFn | null;   // snap-grid lookup; null → no anchors (pure simplify+ortho)
  eps?: number;                 // RDP tolerance, image px (1.5 — the mask-trace law)
  minGapPx?: number;            // micro-segment collapse distance (2, snapVertices' own)
  axisTolDeg?: number;
  maxAreaDriftPct?: number;     // guardrail: result drifting more area than this is refused
  anchorTol?: number;
}

export function anchorFlags(ring: Point[], nearest?: NearestFn | null, tol = ANCHOR_TOL_PX): boolean[] {
  if (!nearest) return ring.map(() => false);
  return ring.map(([x, y]) => {
    const hit = nearest(x, y, tol);
    return !!hit && Math.hypot(hit[0] - x, hit[1] - y) <= tol;
  });
}

// Consolidate: RDP each run between anchors (anchors are run endpoints, so
// they survive by construction); with no anchors at all, closed-ring RDP.
// Then collapse micro-segments, always keeping the anchor of a close pair.
function consolidate(ring: Point[], anchors: boolean[], eps: number, minGapPx: number): { ring: Point[]; anchors: boolean[] } {
  const n = ring.length;
  const anchorIdx: number[] = [];
  for (let i = 0; i < n; i++) if (anchors[i]) anchorIdx.push(i);
  let out: Point[], outAnchors: boolean[];
  if (!anchorIdx.length) {
    out = rdpClosed(ring, eps);
    outAnchors = out.map(() => false);
  } else {
    out = []; outAnchors = [];
    for (let k = 0; k < anchorIdx.length; k++) {
      const a = anchorIdx[k], b = anchorIdx[(k + 1) % anchorIdx.length];
      const run: Point[] = [];
      for (let i = a; ; i = (i + 1) % n) { run.push(ring[i]); if (i === b && run.length > 1) break; if (run.length > n + 1) break; }
      const simp = rdpOpen(run, eps);
      for (let j = 0; j < simp.length - 1; j++) {        // b opens the next run
        out.push(simp[j]); outAnchors.push(j === 0);
      }
    }
  }
  // micro-segment collapse — drop the non-anchor of any too-close pair
  const keep = out.map(() => true);
  for (let i = 0; i < out.length; i++) {
    if (!keep[i]) continue;
    const j = (i + 1) % out.length;
    if (!keep[j] || i === j) continue;
    if (Math.hypot(out[i][0] - out[j][0], out[i][1] - out[j][1]) <= minGapPx) {
      if (outAnchors[j] && !outAnchors[i]) keep[i] = false; else if (!outAnchors[j]) keep[j] = false;
    }
  }
  const ring2: Point[] = [], anchors2: boolean[] = [];
  for (let i = 0; i < out.length; i++) if (keep[i]) { ring2.push([out[i][0], out[i][1]]); anchors2.push(outAnchors[i]); }
  return { ring: ring2, anchors: anchors2 };
}

// Manhattan pass: classify each segment against the ORIGINAL geometry (one
// stable read — no drift across iterations), then relax non-anchor endpoints
// so near-horizontal segments share a y and near-vertical segments share an
// x. An anchored endpoint donates its coordinate; two anchors on one segment
// pin it as drawn (the CAD knows better than the tolerance). A few
// Gauss-Seidel passes settle chains between anchors.
function orthogonalize(ring: Point[], anchors: boolean[], axisTolDeg: number): Point[] {
  const n = ring.length;
  if (n < 3) return ring;
  const tol = Math.tan((axisTolDeg * Math.PI) / 180);
  const cls: number[] = new Array(n).fill(0);   // 0 none, 1 horizontal, 2 vertical
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
    if (dx === 0 && dy === 0) continue;
    if (dy <= dx * tol) cls[i] = 1; else if (dx <= dy * tol) cls[i] = 2;
  }
  const out: Point[] = ring.map((p) => [p[0], p[1]]);
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < n; i++) {
      if (!cls[i]) continue;
      const j = (i + 1) % n;
      const c = cls[i] === 1 ? 1 : 0;           // horizontal locks y, vertical locks x
      const A = out[i], B = out[j];
      if (anchors[i] && anchors[j]) continue;
      const target = anchors[i] ? A[c] : anchors[j] ? B[c] : (A[c] + B[c]) / 2;
      if (!anchors[i]) A[c] = target;
      if (!anchors[j]) B[c] = target;
    }
  }
  return out;
}

// Returns { ring, anchors, changed } — `changed` false means the input came
// back (already tidy, or the guardrail refused the result).
export function tidyRing(ring: Point[], opts: TidyOpts = {}): TidyResult {
  const { nearest = null, eps = 1.5, minGapPx = 2,
          axisTolDeg = AXIS_TOL_DEG, maxAreaDriftPct = 3,
          anchorTol = ANCHOR_TOL_PX } = opts;
  if (!Array.isArray(ring) || ring.length < 3)
    return { ring, anchors: (ring || []).map(() => false), changed: false };
  // Anchored vertices are also PULLED onto their endpoint — a freshly snapped
  // trace is already there (no-op); a hand-dragged vertex that drifted a hair
  // off its corner comes home.
  const flags: boolean[] = [];
  const pulled: Point[] = ring.map(([x, y]) => {
    const hit = nearest ? nearest(x, y, anchorTol) : null;
    if (hit && Math.hypot(hit[0] - x, hit[1] - y) <= anchorTol) { flags.push(true); return [hit[0], hit[1]]; }
    flags.push(false); return [x, y];
  });
  const c = consolidate(pulled, flags, eps, minGapPx);
  const tidy = c.ring.length >= 3 ? orthogonalize(c.ring, c.anchors, axisTolDeg) : ring;
  const anchors = c.ring.length >= 3 ? c.anchors : flags;
  const a0 = Math.abs(ringArea(ring)), a1 = Math.abs(ringArea(tidy));
  const drift = a0 > 0 ? (Math.abs(a1 - a0) / a0) * 100 : 100;
  if (tidy.length < 3 || drift > maxAreaDriftPct)
    return { ring, anchors: flags, changed: false };
  const changed = tidy.length !== ring.length ||
    tidy.some((p, i) => p[0] !== ring[i][0] || p[1] !== ring[i][1]);
  return { ring: tidy, anchors, changed };
}

// Live-drag straightener: lock the dragged point onto its neighbors' axes so
// the two segments it carries stay straight as they were meant to be. Each
// axis locks independently to whichever neighbor is nearer on that axis
// (within tolPx) — near a corner both lock and the corner lands square.
// Callers pass tolPx in image px (screen tolerance ÷ zoom). Endpoint snap
// (osnap) wins upstream — call this only when no CAD endpoint claimed the
// point.
export function axisLockPoint(p: Point, prev: Point | null, next: Point | null, tolPx: number): { pt: Point; locked: boolean } {
  const out: Point = [p[0], p[1]];
  let locked = false;
  for (const c of [0, 1] as const) {
    let best: number | null = null;
    for (const nb of [prev, next]) {
      if (!nb) continue;
      const d = Math.abs(p[c] - nb[c]);
      if (d <= tolPx && (best === null || d < Math.abs(p[c] - best)))
        best = nb[c];
    }
    if (best !== null) { out[c] = best; locked = true; }
  }
  return { pt: out, locked };
}
