// Polygonize — whole-floor room detection (pure, no DOM; node-testable).
//
// One pass over the sheet's HARD linework → every bounded face at once. This
// is the vector-native topology the oneclick.ts threshold notes name as the
// endgame (RFC item A): no seed, no raster, no per-room question. Where the
// flood answers "what encloses THIS point", the planar arrangement answers
// "what are ALL the enclosures" — corridors, vestibules and every untagged
// space included, which is exactly the ceiling detectRooms.ts documents
// (NO_TAG_CAVEAT) and cannot lift.
//
// Pipeline (all px in the caller's image space, same as extractVectorGeometry):
//   hardWallSegments   VectorGeometry → the segments a fill may not cross.
//                      Same authority the mask uses: clip-only paths are
//                      invisible ink (out), hatch families are fills (out,
//                      via classifyHatchSegs), curves stay IN — door swings
//                      must keep closing doorways here exactly as they do in
//                      the mask.
//   nodeSegments       split every segment at every crossing / T-junction so
//                      the arrangement is a proper plane graph (walls meet
//                      mid-span constantly on CDs).
//   snapSegments       weld endpoints within a tolerance — CAD emits walls as
//                      disconnected strokes; sub-tolerance pinholes are
//                      drafting noise, not doorways (GAP_BRIDGE_MAX's premise).
//   extendDangles      a wall stroke that stops a hair short of the wall it
//                      abuts leaves a dead-end; extend it along its own line,
//                      a bounded distance, to the segment it was drawn to meet.
//   polygonizeFaces    half-edge rotation system → face rings + signed area.
//   detectAllRooms     the composition, with the two face filters that turn
//                      "bounded face" into "room": an area floor (label
//                      bubbles, fixtures) and a thinness floor (the cavity
//                      between a double-drawn wall's two lines is a face too —
//                      long, thin, and not a room; same MIN_THICK idea the
//                      flood applies to its region bbox).
//
// Determinism note (same honesty line as oneclick.ts): the snap tolerance
// quantizes connectivity. A drawn gap within a cell of the tolerance is
// genuinely undecidable — it welds at one tolerance and stays open at
// another. The tolerance is therefore feet-true where the scale is known,
// with a px floor, and every ring reports which healing steps produced it
// (`healed`) so a reviewer can distrust exactly the welded ones.

import { classifyHatchSegs, SEG_CLIP, SEG_CURVE, type VectorGeometry } from "./oneclick.ts";

export type Pt = [number, number];

/** One detected room: outer ring (image px, closed implicitly), its area in
 *  px², and provenance of the healing that produced it. */
export interface RoomFace {
  ring: Pt[];
  areaPx: number;
  /** perimeter in px */
  perimPx: number;
  /** true when an extended dangle participates in this ring's boundary —
   *  the ring exists partly because of a heal, so review it first. */
  healed: boolean;
  /** true when a door-line bridge participates in this ring's boundary — the
   *  space was separated from its neighbor at a doorway (expected takeoff
   *  behavior, recorded for provenance). */
  sealed: boolean;
  /** true when this face is bigger than the sum of all the others. On a
   *  degenerate trace that is the floor plate leaking through the sign
   *  filter; on a real sheet it can simply be the one big open room — the
   *  two are undecidable here, so the face is flagged for review, never
   *  silently dropped. */
  suspectOuter: boolean;
  /** indices into opts.labelPts that landed in this face (each label binds to
   *  the smallest face containing it — its room). One index = a named room;
   *  several = spaces merged through an open doorway. */
  labels?: number[];
}

export interface PolygonizeOptions {
  /** image px per foot; 0/absent = scale unknown (px fallbacks apply) */
  pxPerFt?: number;
  /** endpoint weld tolerance, feet (default 0.15 ft ≈ 1.8") */
  snapFt?: number;
  /** px floor / scale-blind fallback for the weld tolerance */
  snapPxFloor?: number;
  /** max dangle extension, feet (default 1.0 ft) — never doorway-sized */
  extendFt?: number;
  /** px fallback for extension when scale is unknown */
  extendPxFallback?: number;
  /** widest doorway sealed at the door line, feet (default 6 — a double door;
   *  0 disables sealing and open spaces merge honestly) */
  bridgeFt?: number;
  /** px fallback for the door-line bridge when scale is unknown */
  bridgePxFallback?: number;
  /** smallest face kept, SF (default 4 — detectRooms' tiny threshold) */
  minAreaSf?: number;
  /** px² fallback when scale is unknown */
  minAreaPxFallback?: number;
  /** thinnest face kept: 2·area/perimeter, feet (default 0.75 ft — a wall
   *  cavity is ≤ ~8", a real room never is) */
  minThickFt?: number;
  /** px fallback for thinness when scale is unknown */
  minThickPxFallback?: number;
  /** largest face the round-tag cull may touch, SF (default 30) */
  tagMaxSf?: number;
  /** roundness (4πA/P²) above which a small face reads as a tag bubble
   *  (default 0.88 — a square is ≈0.785, a circle ≈1) */
  tagMinRoundness?: number;
  /** a connected linework island is culled whole when its faces total less
   *  than this fraction of the biggest island (default 0.05 — a schedule or
   *  legend is sub-percent of the building; a second wing is comparable) */
  minComponentFrac?: number;
  /** room-tag text anchor points, image px (the sheet's own room numbers —
   *  roomLabelSeeds' seed points). With ≥5 of them, the smallest face holding
   *  most of them IS the plan region: linework neither connected to it,
   *  contained in it, nor chained under a kept face is annotation (title
   *  blocks, legends, schedules, detail blow-ups) regardless of its size —
   *  at 1/8" scale a schedule cell spans more "plan feet" than a real room,
   *  so no size rule can separate them. */
  labelPts?: Pt[];
}

const D = {
  snapFt: 0.15, snapPxFloor: 2,
  extendFt: 1.0, extendPxFallback: 8,
  bridgeFt: 6, bridgePxFallback: 24,
  minAreaSf: 4, minAreaPxFallback: 400,
  minThickFt: 0.75, minThickPxFallback: 6,
  tagMaxSf: 30, tagMinRoundness: 0.88,
  minComponentFrac: 0.05,
};

/** The hard-barrier segments of a sheet, flat quads [x1,y1,x2,y2,…] — what
 *  the arrangement may treat as a wall. Starts from the mask's authority
 *  (`ws` + `pitchCapPx` = the same hatch classification buildMask runs) and
 *  removes what a wall can never be:
 *  - DASHED ink (match lines, property lines, hidden edges) — geom.dashed.
 *  - SHORT-SPAN curve runs: door/window swings. Dropping the arc leaves the
 *    jambs as tips and bridgeDangles seals the threshold STRAIGHT — the room
 *    ends at the door line instead of scalloping around the swing.
 *  - HIGH-BEND curve runs (arc length ≫ end-to-end span): revision clouds,
 *    scallop chains, circles. A radius WALL is a gentle arc (ratio ≈1.1)
 *    and stays.
 *  buildMask's inset-annotation-ring softening is NOT replicated here — a
 *  known, accepted gap. */
/** Optional out-parameter for hardWallSegments: which classification mode ran
 *  and how much of the long linework proved itself as walls. */
export interface WallInfo { mode?: "walls" | "linework"; coverage?: number; }

export function hardWallSegments(geom: VectorGeometry, ws: number, pitchCapPx?: number, pxPerFt?: number, info?: WallInfo): number[] {
  const n = geom.segs.length >> 2;
  const soft = classifyHatchSegs(geom.segs, geom.meta, ws, pitchCapPx);
  const s = geom.segs;
  // curve-run analysis: the extractor emits an arc's chords consecutively, so
  // a run = consecutive SEG_CURVE segs chained end-to-start. A short-span run
  // (a swing) is REPLACED by its chord — dropping it outright would leave the
  // doorway open when the straight door leaf keeps the hinge jamb busy, and
  // the chord is the straight closure the scallops were approximating. A
  // high-bend run (cloud, scallop chain, circle) is dropped outright.
  const dropCurve = new Uint8Array(n);
  const chordAdd: number[] = [];
  const swingSpan = pxPerFt && pxPerFt > 0 ? 5 * pxPerFt : 40;   // widest door swing, px
  let runStart = -1;
  const closeRun = (endExcl: number) => {
    if (runStart < 0) return;
    let arcLen = 0;
    for (let k = runStart; k < endExcl; k++) arcLen += Math.hypot(s[k * 4 + 2] - s[k * 4], s[k * 4 + 3] - s[k * 4 + 1]);
    const x0 = s[runStart * 4], y0 = s[runStart * 4 + 1];
    const x1 = s[(endExcl - 1) * 4 + 2], y1 = s[(endExcl - 1) * 4 + 3];
    const span = Math.hypot(x1 - x0, y1 - y0);
    if (span > 1e-6 && span <= swingSpan) {
      for (let k = runStart; k < endExcl; k++) dropCurve[k] = 1;
      chordAdd.push(x0, y0, x1, y1);
    } else if (arcLen >= Math.max(span, 1e-6) * 1.4) {
      for (let k = runStart; k < endExcl; k++) dropCurve[k] = 1;
    }
    runStart = -1;
  };
  for (let i = 0; i < n; i++) {
    const isCurve = (geom.meta[i] & SEG_CURVE) !== 0;
    const chains = i > 0 && s[i * 4] === s[(i - 1) * 4 + 2] && s[i * 4 + 1] === s[(i - 1) * 4 + 3];
    if (isCurve) {
      if (runStart >= 0 && !chains) closeRun(i);
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) closeRun(i);
  }
  closeRun(n);
  // candidates that survived the subtractive filters, with provenance:
  // auto = 1 for kept curve chords (radius walls — concentric arcs don't pair
  // chord-by-chord) and door chords (they exist only because a swing marked a
  // doorway) — they are walls by construction. Dashed candidates ride along
  // UNPAIRED-dropped but PAIRABLE: a dashed PAIR is an existing wall on a
  // renovation plan; a lone dashed stroke is a match line.
  const cand: number[] = [];
  const auto: number[] = [];
  const dashCand: number[] = [];
  for (let i = 0; i < n; i++) {
    if (geom.meta[i] & SEG_CLIP) continue;   // invisible ink
    if (soft[i]) continue;                   // periodic fill, not a wall
    if (dropCurve[i]) continue;              // swing / cloud / circle
    cand.push(s[i * 4], s[i * 4 + 1], s[i * 4 + 2], s[i * 4 + 3]);
    auto.push(geom.meta[i] & SEG_CURVE ? 1 : 0);
    dashCand.push(geom.dashed && geom.dashed[i] ? 1 : 0);
  }
  for (let k = 0; k < chordAdd.length; k += 4) { cand.push(chordAdd[k], chordAdd[k + 1], chordAdd[k + 2], chordAdd[k + 3]); auto.push(1); dashCand.push(0); }

  // ── wall-first: a boundary must PROVE it is a wall ──────────────────────
  // A drawn wall is two near-parallel strokes a wall-thickness apart running
  // together. Keynote boxes, text, leaders, grid lines can't pair — they stop
  // existing as boundaries. Engages only when the sheet's long linework pairs
  // convincingly; single-line plans fall back to the subtractive set.
  const walled = wallPairFilter(cand, auto, dashCand, pxPerFt);
  if (info) { info.mode = walled ? "walls" : "linework"; info.coverage = wallCoverageLast; }
  if (walled) return walled;
  // fallback: the subtractive set, minus dashed ink (unpaired dash = annotation)
  const out: number[] = [];
  for (let k = 0; k < cand.length >> 2; k++) {
    if (dashCand[k]) continue;
    out.push(cand[k * 4], cand[k * 4 + 1], cand[k * 4 + 2], cand[k * 4 + 3]);
  }
  return out;
}

let wallCoverageLast = 0;

/** Perpendicular distance from point to an infinite line through (x1,y1)→dir. */
function perpDist(px: number, py: number, x1: number, y1: number, dx: number, dy: number): number {
  return Math.abs((px - x1) * dy - (py - y1) * dx);
}

/** Mark segments that pair as wall faces (near-parallel, wall-thickness
 *  offset, real overlap), plus end caps bridging two marked faces, plus the
 *  auto set. Returns the marked quads, or null when paired coverage of the
 *  long straight linework is too low to trust (single-line plan). */
function wallPairFilter(cand: number[], auto: number[], dashCand: number[], pxPerFt?: number): number[] | null {
  const m = cand.length >> 2;
  const ppf = pxPerFt && pxPerFt > 0 ? pxPerFt : 0;
  const minLen = ppf ? Math.max(6, 0.9 * ppf) : 12;          // pairing considers strokes ≥ ~1 ft
  const bandLo = ppf ? Math.max(1.5, (2.5 / 12) * ppf) : 2;  // thinnest wall ≈ 2.5"
  const bandHi = ppf ? 1.5 * ppf : 20;                       // thickest assembly ≈ 18"
  const SIN_TOL = Math.sin((4 * Math.PI) / 180);
  const grid = segGrid(cand, 64);
  const mark = new Uint8Array(m);
  const dir = (i: number): [number, number, number] => {
    const dx = cand[i * 4 + 2] - cand[i * 4], dy = cand[i * 4 + 3] - cand[i * 4 + 1];
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len, len];
  };
  for (let i = 0; i < m; i++) {
    if (auto[i]) { mark[i] = 1; continue; }
    if (mark[i]) continue;
    const [dxi, dyi, li] = dir(i);
    if (li < minLen) continue;
    const seen = new Set<number>();
    const cx0 = Math.floor((Math.min(cand[i * 4], cand[i * 4 + 2]) - bandHi) / 64), cx1 = Math.floor((Math.max(cand[i * 4], cand[i * 4 + 2]) + bandHi) / 64);
    const cy0 = Math.floor((Math.min(cand[i * 4 + 1], cand[i * 4 + 3]) - bandHi) / 64), cy1 = Math.floor((Math.max(cand[i * 4 + 1], cand[i * 4 + 3]) + bandHi) / 64);
    outer: for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      for (const j of grid.get(cy * 131071 + cx) || []) {
        if (j === i || seen.has(j)) continue; seen.add(j);
        const [dxj, dyj, lj] = dir(j);
        if (lj < minLen) continue;
        if (Math.abs(dxi * dyj - dyi * dxj) > SIN_TOL) continue;          // not parallel
        const d0 = perpDist(cand[j * 4], cand[j * 4 + 1], cand[i * 4], cand[i * 4 + 1], dxi, dyi);
        const d1 = perpDist(cand[j * 4 + 2], cand[j * 4 + 3], cand[i * 4], cand[i * 4 + 1], dxi, dyi);
        const d = (d0 + d1) / 2;
        if (d < bandLo || d > bandHi || Math.abs(d0 - d1) > bandLo) continue;  // outside the thickness band / skewed
        const s0 = (cand[j * 4] - cand[i * 4]) * dxi + (cand[j * 4 + 1] - cand[i * 4 + 1]) * dyi;
        const s1 = (cand[j * 4 + 2] - cand[i * 4]) * dxi + (cand[j * 4 + 3] - cand[i * 4 + 1]) * dyi;
        const ov = Math.min(li, Math.max(s0, s1)) - Math.max(0, Math.min(s0, s1));
        if (ov < 0.5 * Math.min(li, lj)) continue;                        // barely alongside
        if (ov < 3.5 * d) continue;   // a wall RUNS — a keynote/tag box is wall-thickness tall but never 3.5× longer than it
        mark[i] = 1; mark[j] = 1;
        break outer;
      }
    }
  }
  // coverage check BEFORE caps: how much of the real (long, straight,
  // undashed) linework proved itself?
  let markedLen = 0, totalLen = 0;
  for (let i = 0; i < m; i++) {
    if (auto[i] || dashCand[i]) continue;
    const [, , len] = dir(i);
    if (len < minLen) continue;
    totalLen += len;
    if (mark[i]) markedLen += len;
  }
  wallCoverageLast = totalLen > 0 ? markedLen / totalLen : 0;
  if (wallCoverageLast < 0.35) return null;
  // end caps: a stroke whose BOTH endpoints land on marked walls closes a
  // wall end / jamb — it belongs to the assembly
  const capTol = ppf ? Math.max(2, 0.25 * ppf) : 3;
  const near = (px: number, py: number): boolean => {
    const cxm = Math.floor(px / 64), cym = Math.floor(py / 64);
    for (let cy = cym - 1; cy <= cym + 1; cy++) for (let cx = cxm - 1; cx <= cxm + 1; cx++) {
      for (const j of grid.get(cy * 131071 + cx) || []) {
        if (!mark[j]) continue;
        const [djx, djy, ljn] = dir(j);
        const t = Math.max(0, Math.min(ljn, (px - cand[j * 4]) * djx + (py - cand[j * 4 + 1]) * djy));
        const qx = cand[j * 4] + djx * t, qy = cand[j * 4 + 1] + djy * t;
        if (Math.hypot(px - qx, py - qy) <= capTol) return true;
      }
    }
    return false;
  };
  for (let i = 0; i < m; i++) {
    if (mark[i]) continue;
    if (near(cand[i * 4], cand[i * 4 + 1]) && near(cand[i * 4 + 2], cand[i * 4 + 3])) mark[i] = 1;
  }
  const out: number[] = [];
  for (let i = 0; i < m; i++) if (mark[i]) out.push(cand[i * 4], cand[i * 4 + 1], cand[i * 4 + 2], cand[i * 4 + 3]);
  return out;
}

// ── geometry helpers ────────────────────────────────────────────────────────

const EPS = 1e-9;

/** Proper + T-junction intersection of segments (p1,p2)-(p3,p4).
 *  Returns [t, u] params on each, or null. Endpoint-to-endpoint touches are
 *  excluded (the weld owns those); endpoint-into-interior counts (that IS a
 *  T-junction and the interior segment must split there). */
function segIntersect(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number,
): [number, number] | null {
  const dx1 = x2 - x1, dy1 = y2 - y1, dx2 = x4 - x3, dy2 = y4 - y3;
  const den = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(den) < EPS) return null;      // parallel / collinear: weld handles overlap ends
  const t = ((x3 - x1) * dy2 - (y3 - y1) * dx2) / den;
  const u = ((x3 - x1) * dy1 - (y3 - y1) * dx1) / den;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  const tEnd = t < EPS || t > 1 - EPS, uEnd = u < EPS || u > 1 - EPS;
  if (tEnd && uEnd) return null;             // endpoint kiss — welding's job
  return [Math.min(1, Math.max(0, t)), Math.min(1, Math.max(0, u))];
}

/** Uniform-grid spatial hash of segment bboxes. */
function segGrid(segs: number[], cell: number): Map<number, number[]> {
  const g = new Map<number, number[]>();
  const n = segs.length >> 2;
  for (let i = 0; i < n; i++) {
    const x0 = Math.min(segs[i * 4], segs[i * 4 + 2]), x1 = Math.max(segs[i * 4], segs[i * 4 + 2]);
    const y0 = Math.min(segs[i * 4 + 1], segs[i * 4 + 3]), y1 = Math.max(segs[i * 4 + 1], segs[i * 4 + 3]);
    for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++)
      for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++) {
        const k = cy * 131071 + cx;
        let a = g.get(k); if (!a) { a = []; g.set(k, a); }
        a.push(i);
      }
  }
  return g;
}

/** Split every segment at every crossing / T-junction. Grid-accelerated;
 *  output is again flat quads. */
export function nodeSegments(segs: number[], cell = 64): number[] {
  const n = segs.length >> 2;
  const cuts: number[][] = Array.from({ length: n }, () => []);
  const grid = segGrid(segs, cell);
  const seen = new Set<number>();
  for (const bucket of grid.values()) {
    for (let a = 0; a < bucket.length; a++) for (let b = a + 1; b < bucket.length; b++) {
      const i = bucket[a], j = bucket[b];
      const key = i < j ? i * n + j : j * n + i;
      if (seen.has(key)) continue; seen.add(key);
      const r = segIntersect(
        segs[i * 4], segs[i * 4 + 1], segs[i * 4 + 2], segs[i * 4 + 3],
        segs[j * 4], segs[j * 4 + 1], segs[j * 4 + 2], segs[j * 4 + 3],
      );
      if (!r) continue;
      if (r[0] > EPS && r[0] < 1 - EPS) cuts[i].push(r[0]);
      if (r[1] > EPS && r[1] < 1 - EPS) cuts[j].push(r[1]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x1 = segs[i * 4], y1 = segs[i * 4 + 1], x2 = segs[i * 4 + 2], y2 = segs[i * 4 + 3];
    const ts = [0, ...cuts[i].sort((p, q) => p - q), 1];
    for (let k = 0; k + 1 < ts.length; k++) {
      if (ts[k + 1] - ts[k] < EPS) continue;
      out.push(
        x1 + (x2 - x1) * ts[k], y1 + (y2 - y1) * ts[k],
        x1 + (x2 - x1) * ts[k + 1], y1 + (y2 - y1) * ts[k + 1],
      );
    }
  }
  return out;
}

/** Weld endpoints within `tol` px by grid quantization (a point joins the
 *  cluster of its rounded cell; representative = first arrival). Straddling a
 *  cell boundary can miss a pair at up to tol·√2 — the same half-cell honesty
 *  floor the raster owns; noted, not hidden. Returns [welded segs, vertex
 *  coords, per-seg vertex-index pairs]. */
export function snapSegments(segs: number[], tol: number): { segs: number[]; verts: Pt[]; ends: number[] } {
  const n = segs.length >> 2;
  const idxOf = new Map<string, number>();
  const verts: Pt[] = [];
  // string key, not a packed number: at the exact-weld tolerance (1e-6 in
  // polygonizeFaces) quantized coords overrun any packing stride and distinct
  // points would collide into one vertex
  const key = (x: number, y: number) => `${Math.round(x / tol)},${Math.round(y / tol)}`;
  const vid = (x: number, y: number): number => {
    const k = key(x, y);
    let v = idxOf.get(k);
    if (v === undefined) { v = verts.length; verts.push([x, y]); idxOf.set(k, v); }
    return v;
  };
  const out: number[] = [], ends: number[] = [];
  const edgeSeen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const a = vid(segs[i * 4], segs[i * 4 + 1]);
    const b = vid(segs[i * 4 + 2], segs[i * 4 + 3]);
    if (a === b) continue;                                  // collapsed by the weld
    const ek = a < b ? a * 4194304 + b : b * 4194304 + a;   // dedupe double-drawn strokes
    if (edgeSeen.has(ek)) continue; edgeSeen.add(ek);
    out.push(verts[a][0], verts[a][1], verts[b][0], verts[b][1]);
    ends.push(a, b);
  }
  return { segs: out, verts, ends };
}

/** Extend degree-1 endpoints along their own segment, up to `maxExt` px, to
 *  the first hard segment the ray meets. The heal a short-drawn wall needs;
 *  bounded well under doorway width so it can never seal a real opening.
 *  Returns the added closure quads (flat) and how many were added. */
export function extendDangles(
  segs: number[], ends: number[], maxExt: number, cell = 64,
): { added: number[]; count: number } {
  const n = segs.length >> 2;
  const deg = new Map<number, number>();
  for (const v of ends) deg.set(v, (deg.get(v) || 0) + 1);
  const grid = segGrid(segs, cell);
  const added: number[] = [];
  for (let i = 0; i < n; i++) {
    for (const end of [0, 1] as const) {
      const v = ends[i * 2 + end];
      if (deg.get(v) !== 1) continue;
      const tx = segs[i * 4 + (end ? 2 : 0)], ty = segs[i * 4 + (end ? 3 : 1)];
      const fx = segs[i * 4 + (end ? 0 : 2)], fy = segs[i * 4 + (end ? 1 : 3)];
      const len = Math.hypot(tx - fx, ty - fy) || 1;
      const dx = (tx - fx) / len, dy = (ty - fy) / len;
      const ex = tx + dx * maxExt, ey = ty + dy * maxExt;
      // nearest hit along the probe among grid-local candidates
      let best = Infinity, hx = 0, hy = 0;
      const cx0 = Math.floor(Math.min(tx, ex) / cell), cx1 = Math.floor(Math.max(tx, ex) / cell);
      const cy0 = Math.floor(Math.min(ty, ey) / cell), cy1 = Math.floor(Math.max(ty, ey) / cell);
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        for (const j of grid.get(cy * 131071 + cx) || []) {
          if (j === i) continue;
          const r = segIntersect(tx, ty, ex, ey, segs[j * 4], segs[j * 4 + 1], segs[j * 4 + 2], segs[j * 4 + 3]);
          if (r && r[0] > EPS && r[0] < best) {
            best = r[0];
            hx = tx + (ex - tx) * r[0]; hy = ty + (ey - ty) * r[0];
          }
        }
      }
      if (best <= 1) added.push(tx, ty, hx, hy);
    }
  }
  return { added, count: added.length >> 2 };
}

/** Bridge doorway openings: pair MUTUAL-nearest degree-1 endpoints within
 *  `maxBridge` px and connect them, unless anything solid crosses the gap.
 *  Door jambs are exactly this — two wall ends facing each other across an
 *  opening — and a flooring takeoff WANTS the room to end at the door line
 *  (the transition lives at the threshold; Div 9 practice, and what the
 *  seeded flood already does with its door-width seals). Bounded by door
 *  width so a storefront or a genuinely open bay stays open. */
export function bridgeDangles(
  segs: number[], ends: number[], maxBridge: number, cell = 64,
): { added: number[]; count: number } {
  if (maxBridge <= 0) return { added: [], count: 0 };
  const deg = new Map<number, number>();
  for (const v of ends) deg.set(v, (deg.get(v) || 0) + 1);
  // collect degree-1 endpoints with the direction their wall was heading
  const tips: { x: number; y: number; dx: number; dy: number; v: number; seg: number }[] = [];
  const n = segs.length >> 2;
  for (let i = 0; i < n; i++) for (const end of [0, 1] as const) {
    const v = ends[i * 2 + end];
    if (deg.get(v) !== 1) continue;
    const tx = segs[i * 4 + (end ? 2 : 0)], ty = segs[i * 4 + (end ? 3 : 1)];
    const fx = segs[i * 4 + (end ? 0 : 2)], fy = segs[i * 4 + (end ? 1 : 3)];
    const len = Math.hypot(tx - fx, ty - fy) || 1;
    tips.push({ x: tx, y: ty, dx: (tx - fx) / len, dy: (ty - fy) / len, v, seg: i });
  }
  const grid = segGrid(segs, cell);
  const blocked = (x1: number, y1: number, x2: number, y2: number): boolean => {
    const cx0 = Math.floor(Math.min(x1, x2) / cell), cx1 = Math.floor(Math.max(x1, x2) / cell);
    const cy0 = Math.floor(Math.min(y1, y2) / cell), cy1 = Math.floor(Math.max(y1, y2) / cell);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      for (const j of grid.get(cy * 131071 + cx) || []) {
        if (segIntersect(x1, y1, x2, y2, segs[j * 4], segs[j * 4 + 1], segs[j * 4 + 2], segs[j * 4 + 3])) return true;
      }
    }
    return false;
  };
  // mutual-nearest pairing; the connector must CONTINUE both walls (a door
  // opening interrupts a wall line — leader lines and stray strokes point in
  // arbitrary directions and must never seal a space shut)
  const COLL = Math.cos((25 * Math.PI) / 180);
  const collinear = (a: number, b: number): boolean => {
    const cx = tips[b].x - tips[a].x, cy = tips[b].y - tips[a].y;
    const len = Math.hypot(cx, cy) || 1;
    return Math.abs((cx * tips[a].dx + cy * tips[a].dy) / len) >= COLL
        && Math.abs((cx * tips[b].dx + cy * tips[b].dy) / len) >= COLL;
  };
  // nearest COLLINEAR candidate — on a double-line wall a jamb's two line
  // ends sit wall-thickness apart, perpendicular; they must not consume each
  // other's pairing, the opposite jamb's matching line must
  const nearest = new Array<number>(tips.length).fill(-1);
  for (let a = 0; a < tips.length; a++) {
    let best = maxBridge * maxBridge, bi = -1;
    for (let b = 0; b < tips.length; b++) {
      if (b === a || tips[b].seg === tips[a].seg || !collinear(a, b)) continue;
      const d = (tips[a].x - tips[b].x) ** 2 + (tips[a].y - tips[b].y) ** 2;
      if (d > 0 && d < best) { best = d; bi = b; }
    }
    nearest[a] = bi;
  }
  const added: number[] = [];
  for (let a = 0; a < tips.length; a++) {
    const b = nearest[a];
    if (b > a && nearest[b] === a && !blocked(tips[a].x, tips[a].y, tips[b].x, tips[b].y)) {
      added.push(tips[a].x, tips[a].y, tips[b].x, tips[b].y);
    }
  }
  return { added, count: added.length >> 2 };
}

/** Trace all faces of the arrangement via the rotation system: at each vertex
 *  the outgoing edges sort by angle; next(u→v) is the edge after (v→u) in
 *  clockwise order. Interior faces come back with one orientation sign, the
 *  outer face of each component with the other — the caller filters by sign
 *  (positive shoelace here, with y-down image coordinates). Dangles are
 *  trimmed first (a dead-end bounds nothing). */
export function polygonizeFaces(segs: number[]): { ring: Pt[]; areaPx: number; perimPx: number; holes: Pt[][] }[] {
  // weld exact coords → vertex ids (inputs already welded; this is just ids)
  const { verts, ends } = snapSegments(segs, 1e-6);
  // iteratively trim degree-1 vertices
  const alive: boolean[] = new Array(ends.length >> 1).fill(true);
  for (;;) {
    const deg = new Map<number, number>();
    for (let e = 0; e < alive.length; e++) if (alive[e]) {
      deg.set(ends[e * 2], (deg.get(ends[e * 2]) || 0) + 1);
      deg.set(ends[e * 2 + 1], (deg.get(ends[e * 2 + 1]) || 0) + 1);
    }
    let trimmed = false;
    for (let e = 0; e < alive.length; e++) if (alive[e] && ((deg.get(ends[e * 2]) === 1) || (deg.get(ends[e * 2 + 1]) === 1))) { alive[e] = false; trimmed = true; }
    if (!trimmed) break;
  }
  // half-edges: 2 per edge; out[v] = outgoing half-edge list sorted by angle
  interface HE { from: number; to: number; ang: number; twin: number; next: number; }
  const hes: HE[] = [];
  for (let e = 0; e < alive.length; e++) if (alive[e]) {
    const a = ends[e * 2], b = ends[e * 2 + 1];
    const angAB = Math.atan2(verts[b][1] - verts[a][1], verts[b][0] - verts[a][0]);
    const i = hes.length;
    hes.push({ from: a, to: b, ang: angAB, twin: i + 1, next: -1 });
    hes.push({ from: b, to: a, ang: angAB > 0 ? angAB - Math.PI : angAB + Math.PI, twin: i, next: -1 });
  }
  const outAt = new Map<number, number[]>();
  for (let h = 0; h < hes.length; h++) {
    let a = outAt.get(hes[h].from); if (!a) { a = []; outAt.set(hes[h].from, a); }
    a.push(h);
  }
  for (const a of outAt.values()) a.sort((p, q) => hes[p].ang - hes[q].ang);
  for (let h = 0; h < hes.length; h++) {
    const at = outAt.get(hes[h].to)!;
    const k = at.indexOf(hes[h].twin);
    hes[h].next = at[(k - 1 + at.length) % at.length];   // clockwise successor of the reverse
  }
  // walk faces — positive rings are faces; negative rings are the hole
  // boundaries of whichever face's region they puncture (a component's
  // outside walk: the building outline is a hole of the sheet-frame face)
  const seen = new Uint8Array(hes.length);
  const faces: { ring: Pt[]; areaPx: number; perimPx: number; holes: Pt[][] }[] = [];
  const negRings: Pt[][] = [];
  for (let h0 = 0; h0 < hes.length; h0++) {
    if (seen[h0]) continue;
    const ring: Pt[] = [];
    let area2 = 0, perim = 0;
    let h = h0;
    do {
      seen[h] = 1;
      const p = verts[hes[h].from], q = verts[hes[h].to];
      ring.push(p);
      area2 += p[0] * q[1] - q[0] * p[1];
      perim += Math.hypot(q[0] - p[0], q[1] - p[1]);
      h = hes[h].next;
    } while (h !== h0 && ring.length <= hes.length);
    const areaPx = area2 / 2;
    if (areaPx > EPS) faces.push({ ring, areaPx, perimPx: perim, holes: [] });
    else if (areaPx < -EPS) negRings.push(ring);
  }
  // assign each hole to the smallest face whose ring contains it — the owner
  // must be BIGGER than the hole (the hole's vertices lie on the rings of the
  // faces it bounds, so containment against those is unreliable)
  for (const hole of negRings) {
    const holeArea = Math.abs(ringAreaOf(hole));
    const [hx, hy] = hole[0];
    let best = -1;
    for (let i = 0; i < faces.length; i++) {
      if (faces[i].areaPx <= holeArea) continue;
      if (!pointInRing(hx, hy, faces[i].ring)) continue;
      if (best === -1 || faces[i].areaPx < faces[best].areaPx) best = i;
    }
    if (best >= 0) faces[best].holes.push(hole);
  }
  return faces;
}

/** Signed shoelace area of a ring. */
function ringAreaOf(ring: Pt[]): number {
  let a2 = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    a2 += x1 * y2 - x2 * y1;
  }
  return a2 / 2;
}

/** Whole-floor detection: hard segments → node → weld → heal → faces →
 *  room-plausible faces. All thresholds feet-true when `pxPerFt` is known,
 *  with documented px fallbacks when it isn't (weaker measurement, same
 *  posture as oneClickArgs' scaleBlind). */
/** Ray-cast point-in-ring (ring implicitly closed). */
function pointInRing(x: number, y: number, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Area centroid of a ring (falls back to the first vertex when degenerate). */
function ringCentroid(ring: Pt[]): Pt {
  let a2 = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    const c = x1 * y2 - x2 * y1;
    a2 += c; cx += (x1 + x2) * c; cy += (y1 + y2) * c;
  }
  return a2 ? [cx / (3 * a2), cy / (3 * a2)] : [ring[0][0], ring[0][1]];
}

/** What the room-vs-annotation layer removed, by reason — surfaced so no cull
 *  is ever silent. */
export interface CullStats {
  /** small near-circles: room-number bubbles, column tags */
  tags: number;
  /** faces in linework islands tiny next to the building: finish schedules,
   *  legends, title-block cells, detail borders, freestanding annotation */
  floaters: number;
}

export function detectAllRooms(hardSegs: number[], opts: PolygonizeOptions = {}): RoomFace[] {
  return detectAllRoomsDetailed(hardSegs, opts).rooms;
}

/** Whole-floor detection with the room-vs-annotation layer and its receipts.
 *
 *  The arrangement gives every bounded face; a drawing also encloses things
 *  that are NOT rooms — finish-schedule grids, legends, title-block cells,
 *  room-number bubbles, casework. Turning faces into rooms is a containment
 *  problem: build the tree of who sits inside whom (border ⊃ plate ⊃ rooms ⊃
 *  annotation) and keep the faces that live directly under a plate-like
 *  container. Every cull is counted in `culled` — never silent. */
export function detectAllRoomsDetailed(hardSegs: number[], opts: PolygonizeOptions = {}): { rooms: RoomFace[]; culled: CullStats } {
  const ppf = Number.isFinite(opts.pxPerFt) && (opts.pxPerFt as number) > 0 ? (opts.pxPerFt as number) : 0;
  const snapTol = ppf > 0 ? Math.max(opts.snapPxFloor ?? D.snapPxFloor, (opts.snapFt ?? D.snapFt) * ppf) : (opts.snapPxFloor ?? D.snapPxFloor);
  const extPx = ppf > 0 ? (opts.extendFt ?? D.extendFt) * ppf : (opts.extendPxFallback ?? D.extendPxFallback);
  const minArea = ppf > 0 ? (opts.minAreaSf ?? D.minAreaSf) * ppf * ppf : (opts.minAreaPxFallback ?? D.minAreaPxFallback);
  const minThick = ppf > 0 ? (opts.minThickFt ?? D.minThickFt) * ppf : (opts.minThickPxFallback ?? D.minThickPxFallback);
  // a room-number bubble is a small, nearly round face; rooms are rectangular
  // (a square's roundness 4πA/P² is ≈0.785, a circle's ≈1)
  const tagMaxArea = ppf > 0 ? (opts.tagMaxSf ?? D.tagMaxSf) * ppf * ppf : (opts.tagMaxSf ?? D.tagMaxSf) * (opts.minAreaPxFallback ?? D.minAreaPxFallback) / D.minAreaSf;
  const tagRoundness = opts.tagMinRoundness ?? D.tagMinRoundness;
  const culled: CullStats = { tags: 0, floaters: 0 };

  const bridgePx = ppf > 0 ? (opts.bridgeFt ?? D.bridgeFt) * ppf : (opts.bridgePxFallback ?? D.bridgePxFallback);

  const noded = nodeSegments(hardSegs);
  const welded = snapSegments(noded, snapTol);
  const healed = extendDangles(welded.segs, welded.ends, extPx);
  // door-line bridges pair the jambs the heal didn't own: a healed tip is
  // already resolved, so it must not also bridge
  const healedTips = new Set<string>();
  for (let i = 0; i < healed.added.length; i += 4)
    healedTips.add(`${Math.round(healed.added[i] * 8)},${Math.round(healed.added[i + 1] * 8)}`);
  const bridgedRaw = bridgeDangles(welded.segs, welded.ends, bridgePx);
  const bridged: number[] = [];
  for (let i = 0; i < bridgedRaw.added.length; i += 4) {
    const aKey = `${Math.round(bridgedRaw.added[i] * 8)},${Math.round(bridgedRaw.added[i + 1] * 8)}`;
    const bKey = `${Math.round(bridgedRaw.added[i + 2] * 8)},${Math.round(bridgedRaw.added[i + 3] * 8)}`;
    if (!healedTips.has(aKey) && !healedTips.has(bKey)) bridged.push(...bridgedRaw.added.slice(i, i + 4));
  }
  // re-node the union so each heal/bridge splits the segment it landed on
  // (its hit point is a T-junction the arrangement must have)
  const finalSegs = healed.count || bridged.length
    ? nodeSegments(welded.segs.concat(healed.added, bridged))
    : welded.segs;
  const healSet = new Set<string>();
  for (let i = 0; i < healed.added.length; i += 4)
    healSet.add(`${Math.round(healed.added[i])},${Math.round(healed.added[i + 1])}`);
  const sealSet = new Set<string>();
  for (let i = 0; i < bridged.length; i += 2)
    sealSet.add(`${Math.round(bridged[i])},${Math.round(bridged[i + 1])}`);
  const faces = polygonizeFaces(finalSegs);
  let rooms: RoomFace[] = [];
  let holesOf: Pt[][][] = [];
  for (const f of faces) {
    // filters run on the NET region — ring minus holes — or a nested cavity
    // (outer wall line wrapping the inner) masquerades as a room-sized face
    let holeArea = 0, holePerim = 0;
    for (const h of f.holes) {
      holeArea += Math.abs(ringAreaOf(h));
      for (let k = 0; k < h.length; k++) { const [x1, y1] = h[k], [x2, y2] = h[(k + 1) % h.length]; holePerim += Math.hypot(x2 - x1, y2 - y1); }
    }
    const net = f.areaPx - holeArea;
    if (net < minArea) continue;
    if ((2 * net) / (f.perimPx + holePerim) < minThick) continue;   // wall-cavity sliver
    if (f.areaPx < tagMaxArea && (4 * Math.PI * f.areaPx) / (f.perimPx * f.perimPx) > tagRoundness) { culled.tags++; continue; }
    const isHealed = f.ring.some(([x, y]) => healSet.has(`${Math.round(x)},${Math.round(y)}`));
    const isSealed = f.ring.some(([x, y]) => sealSet.has(`${Math.round(x)},${Math.round(y)}`));
    rooms.push({ ring: f.ring, areaPx: f.areaPx, perimPx: f.perimPx, healed: isHealed, sealed: isSealed, suspectOuter: false });
    holesOf.push(f.holes);
  }

  // ── linework islands ────────────────────────────────────────────────────
  // A finish schedule, legend or title block never shares a welded vertex
  // with the building's walls — it is its own connected island of linework.
  // ── containment tree ────────────────────────────────────────────────────
  // Arrangement faces are disjoint, but their RINGS nest (an island room's
  // ring sits inside the plate's outline ring). parent = smallest strictly-
  // larger ring containing the centroid.
  const n = rooms.length;
  const order = rooms.map((_, i) => i).sort((a, b) => rooms[a].areaPx - rooms[b].areaPx);
  const parent = new Array<number>(n).fill(-1);
  const children: number[][] = Array.from({ length: n }, () => []);
  for (let oi = 0; oi < n; oi++) {
    const i = order[oi];
    const [cx, cy] = ringCentroid(rooms[i].ring);
    for (let oj = oi + 1; oj < n; oj++) {           // candidates ascend by area — first hit is the smallest container
      const j = order[oj];
      if (rooms[j].areaPx <= rooms[i].areaPx) continue;
      if (pointInRing(cx, cy, rooms[j].ring)) { parent[i] = j; children[j].push(i); break; }
    }
  }

  // ── label binding ───────────────────────────────────────────────────────
  // Each room-tag point binds to the SMALLEST face containing it — its room.
  // (`order` ascends by area, so the first hit is the smallest.)
  const labelPts = opts.labelPts ?? [];
  const labelFace = new Array<number>(labelPts.length).fill(-1);
  for (let li = 0; li < labelPts.length; li++) {
    for (let oi = 0; oi < n; oi++) {
      const i = order[oi];
      if (pointInRing(labelPts[li][0], labelPts[li][1], rooms[i].ring)) {
        labelFace[li] = i;
        (rooms[i].labels ??= []).push(li);
        break;
      }
    }
  }

  // ── linework islands ────────────────────────────────────────────────────
  // A finish schedule, legend or title block never shares a welded vertex
  // with the building's walls — it is its own island of linework. With
  // enough room tags, the plan region is FOUND, not guessed: the smallest
  // face holding most of the tags is the building; keep its island, whatever
  // its ring contains, and whatever chains under a kept face. Without tags,
  // fall back to island size: keep islands carrying real area next to the
  // biggest one. Schedule cells chain only to their own border and die.
  const minFrac = opts.minComponentFrac ?? D.minComponentFrac;
  {
    const compOf = new Map<string, number>();      // welded vertex key → union-find node
    const up: number[] = [];
    const find = (a: number): number => { while (up[a] !== a) { up[a] = up[up[a]]; a = up[a]; } return a; };
    const faceComp: number[] = [];
    for (const r of rooms) {
      let fc = -1;
      for (const [x, y] of r.ring) {
        const k = `${Math.round(x * 8)},${Math.round(y * 8)}`;
        let c = compOf.get(k);
        if (c === undefined) { c = up.length; up.push(c); compOf.set(k, c); }
        if (fc === -1) fc = c;
        else { const ra = find(fc), rb = find(c); if (ra !== rb) up[rb] = ra; }
      }
      faceComp.push(fc);
    }
    const compArea = new Map<number, number>();
    const roots = faceComp.map((c) => (c === -1 ? -1 : find(c)));
    roots.forEach((c, i) => compArea.set(c, (compArea.get(c) || 0) + rooms[i].areaPx));
    const keep = new Array<boolean>(n).fill(false);
    const maxArea = Math.max(0, ...compArea.values());
    for (let oi = n - 1; oi >= 0; oi--) {           // descend by area so parents resolve before children
      const i = order[oi];
      keep[i] = (compArea.get(roots[i]) || 0) >= maxArea * minFrac || (parent[i] >= 0 && keep[parent[i]]);
    }
    if (keep.some((k) => !k)) {
      culled.floaters = keep.filter((k) => !k).length;
      const remap = new Array<number>(n).fill(-1);
      let w = 0;
      for (let i = 0; i < n; i++) if (keep[i]) remap[i] = w++;
      const keptRooms: RoomFace[] = [], keptParent: number[] = [], keptChildren: number[][] = [], keptHoles: Pt[][][] = [];
      for (let i = 0; i < n; i++) {
        if (!keep[i]) continue;
        keptRooms.push(rooms[i]);
        keptHoles.push(holesOf[i]);
        keptParent.push(parent[i] >= 0 && keep[parent[i]] ? remap[parent[i]] : -1);
        keptChildren.push(children[i].filter((c) => keep[c]).map((c) => remap[c]));
      }
      rooms = keptRooms;
      holesOf = keptHoles;
      parent.length = 0; parent.push(...keptParent);
      children.length = 0; children.push(...keptChildren);
    }
  }

  // Review flags — never silent drops: a face whose children cover most of it
  // (the sheet border over the plate, the plate over a dense floor) or that
  // dwarfs everything else combined (the plate / corridor network / a huge
  // open room — undecidable from area alone). Committing a flagged ring
  // double-counts the rooms inside it, so the reviewer decides.
  for (let i = 0; i < rooms.length; i++) {
    const cov = children[i].reduce((s, c) => s + rooms[c].areaPx, 0) / rooms[i].areaPx;
    if (children[i].length && cov > 0.5) rooms[i].suspectOuter = true;
  }
  if (rooms.length > 2) {
    let mi = 0;
    for (let i = 1; i < rooms.length; i++) if (rooms[i].areaPx > rooms[mi].areaPx) mi = i;
    const rest = rooms.reduce((s, r) => s + r.areaPx, 0) - rooms[mi].areaPx;
    if (rooms[mi].areaPx > rest) rooms[mi].suspectOuter = true;
  }

  // ── the region cull ─────────────────────────────────────────────────────
  // A flagged face's REGION is its ring minus its holes. Rooms live in the
  // holes (the building outline is a hole of the sheet-frame face); legends,
  // notes and title blocks live in the region itself. Anything unflagged
  // whose centroid sits in a flagged region is annotation — and whatever
  // nests under a culled face goes with it.
  {
    const m = rooms.length;
    const cullSet = new Array<boolean>(m).fill(false);
    const flagged: number[] = [];
    for (let i = 0; i < m; i++) if (rooms[i].suspectOuter) flagged.push(i);
    // a hole is only sanctuary if the sheet's own room tags vouch for it —
    // the building outline holds them, a legend's outline holds none. With
    // too few tags to judge, every hole is sanctuary (never over-cull).
    const holeHasTags = (holes: Pt[][], h: number): boolean =>
      labelPts.length < 5 || labelPts.some(([lx, ly]) => pointInRing(lx, ly, holes[h]));
    for (let i = 0; i < m; i++) {
      if (rooms[i].suspectOuter) continue;
      const [cx, cy] = ringCentroid(rooms[i].ring);
      for (const f of flagged) {
        if (f === i || rooms[f].areaPx <= rooms[i].areaPx) continue;
        if (!pointInRing(cx, cy, rooms[f].ring)) continue;
        let sanctuary = false;
        for (let h = 0; h < holesOf[f].length; h++) {
          if (pointInRing(cx, cy, holesOf[f][h]) && holeHasTags(holesOf[f], h)) { sanctuary = true; break; }
        }
        if (!sanctuary) { cullSet[i] = true; break; }
      }
    }
    // descend: a face under a culled parent dies with it (legend cells under
    // a culled legend box). Parents are larger, so walk by descending area.
    const byAreaDesc = rooms.map((_, i) => i).sort((a, b) => rooms[b].areaPx - rooms[a].areaPx);
    for (const i of byAreaDesc) if (!cullSet[i] && parent[i] >= 0 && cullSet[parent[i]]) cullSet[i] = true;
    if (cullSet.some(Boolean)) {
      culled.floaters += cullSet.filter(Boolean).length;
      rooms = rooms.filter((_, i) => !cullSet[i]);
    }
  }
  return { rooms, culled };
}
