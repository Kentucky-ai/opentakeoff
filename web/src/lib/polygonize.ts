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

import { classifyHatchSegs, SEG_CLIP, type VectorGeometry } from "./oneclick.ts";

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
  /** true when this face is bigger than the sum of all the others. On a
   *  degenerate trace that is the floor plate leaking through the sign
   *  filter; on a real sheet it can simply be the one big open room — the
   *  two are undecidable here, so the face is flagged for review, never
   *  silently dropped. */
  suspectOuter: boolean;
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
  /** smallest face kept, SF (default 4 — detectRooms' tiny threshold) */
  minAreaSf?: number;
  /** px² fallback when scale is unknown */
  minAreaPxFallback?: number;
  /** thinnest face kept: 2·area/perimeter, feet (default 0.75 ft — a wall
   *  cavity is ≤ ~8", a real room never is) */
  minThickFt?: number;
  /** px fallback for thinness when scale is unknown */
  minThickPxFallback?: number;
}

const D = {
  snapFt: 0.15, snapPxFloor: 2,
  extendFt: 1.0, extendPxFallback: 8,
  minAreaSf: 4, minAreaPxFallback: 400,
  minThickFt: 0.75, minThickPxFallback: 6,
};

/** The hard-barrier segments of a sheet, flat quads [x1,y1,x2,y2,…] — the
 *  same authority buildMask plots as bit 1. `ws` is the mask scale hatch
 *  classification runs at, and `pitchCapPx` the hatch pitch cap — pass the
 *  SAME values the mask build uses (feet-true `HATCH_MAX_PITCH_FT * mppf`
 *  when the scale is known, see buildMask) so the two surfaces cannot
 *  disagree about what is hatch. buildMask's second soft contributor (inset
 *  annotation rings) is NOT replicated here — a known, accepted gap. */
export function hardWallSegments(geom: VectorGeometry, ws: number, pitchCapPx?: number): number[] {
  const n = geom.segs.length >> 2;
  const soft = classifyHatchSegs(geom.segs, geom.meta, ws, pitchCapPx);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (geom.meta[i] & SEG_CLIP) continue;   // invisible ink
    if (soft[i]) continue;                   // periodic fill, not a wall
    out.push(geom.segs[i * 4], geom.segs[i * 4 + 1], geom.segs[i * 4 + 2], geom.segs[i * 4 + 3]);
  }
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

/** Trace all faces of the arrangement via the rotation system: at each vertex
 *  the outgoing edges sort by angle; next(u→v) is the edge after (v→u) in
 *  clockwise order. Interior faces come back with one orientation sign, the
 *  outer face of each component with the other — the caller filters by sign
 *  (positive shoelace here, with y-down image coordinates). Dangles are
 *  trimmed first (a dead-end bounds nothing). */
export function polygonizeFaces(segs: number[]): { ring: Pt[]; areaPx: number; perimPx: number }[] {
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
  // walk faces
  const seen = new Uint8Array(hes.length);
  const faces: { ring: Pt[]; areaPx: number; perimPx: number }[] = [];
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
    if (areaPx > EPS) faces.push({ ring, areaPx, perimPx: perim });
  }
  return faces;
}

/** Whole-floor detection: hard segments → node → weld → heal → faces →
 *  room-plausible faces. All thresholds feet-true when `pxPerFt` is known,
 *  with documented px fallbacks when it isn't (weaker measurement, same
 *  posture as oneClickArgs' scaleBlind). */
export function detectAllRooms(hardSegs: number[], opts: PolygonizeOptions = {}): RoomFace[] {
  const ppf = Number.isFinite(opts.pxPerFt) && (opts.pxPerFt as number) > 0 ? (opts.pxPerFt as number) : 0;
  const snapTol = ppf > 0 ? Math.max(opts.snapPxFloor ?? D.snapPxFloor, (opts.snapFt ?? D.snapFt) * ppf) : (opts.snapPxFloor ?? D.snapPxFloor);
  const extPx = ppf > 0 ? (opts.extendFt ?? D.extendFt) * ppf : (opts.extendPxFallback ?? D.extendPxFallback);
  const minArea = ppf > 0 ? (opts.minAreaSf ?? D.minAreaSf) * ppf * ppf : (opts.minAreaPxFallback ?? D.minAreaPxFallback);
  const minThick = ppf > 0 ? (opts.minThickFt ?? D.minThickFt) * ppf : (opts.minThickPxFallback ?? D.minThickPxFallback);

  const noded = nodeSegments(hardSegs);
  const welded = snapSegments(noded, snapTol);
  const healed = extendDangles(welded.segs, welded.ends, extPx);
  // re-node the union so each heal splits the segment it landed on (its hit
  // point is a T-junction the arrangement must have)
  const finalSegs = healed.count ? nodeSegments(welded.segs.concat(healed.added)) : welded.segs;
  const healSet = new Set<string>();
  for (let i = 0; i < healed.added.length; i += 4)
    healSet.add(`${Math.round(healed.added[i])},${Math.round(healed.added[i + 1])}`);
  const faces = polygonizeFaces(finalSegs);
  const rooms: RoomFace[] = [];
  for (const f of faces) {
    if (f.areaPx < minArea) continue;
    if ((2 * f.areaPx) / f.perimPx < minThick) continue;     // wall-cavity sliver
    const isHealed = f.ring.some(([x, y]) => healSet.has(`${Math.round(x)},${Math.round(y)}`));
    rooms.push({ ring: f.ring, areaPx: f.areaPx, perimPx: f.perimPx, healed: isHealed, suspectOuter: false });
  }
  // the outer face of a component can survive the sign filter only when the
  // component is traversed inside-out (degenerate inputs). A face bigger than
  // the sum of all the others is EITHER that floor plate OR a genuinely big
  // open room (a warehouse floor with two closets) — undecidable from area
  // alone, so it is flagged for review, never dropped.
  if (rooms.length > 2) {
    let mi = 0;
    for (let i = 1; i < rooms.length; i++) if (rooms[i].areaPx > rooms[mi].areaPx) mi = i;
    const rest = rooms.reduce((s, r) => s + r.areaPx, 0) - rooms[mi].areaPx;
    if (rooms[mi].areaPx > rest) rooms[mi].suspectOuter = true;
  }
  return rooms;
}
