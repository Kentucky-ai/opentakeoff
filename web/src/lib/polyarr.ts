// JSTS-backed planar arrangement — noding + polygonization for room detection.
//
// The hand-rolled half-edge arrangement (lib/arrangement.ts) is exact on clean
// input but real plan linework is degenerate: duplicated collinear segments,
// near-coincident parallels a fraction of a pixel apart, chorded polylines
// whose joints land mid-edge. Both room-detection forks independently hit
// face-fusion leaks there that JTS's snap + unary-union noding resolves, so
// this module delegates the one step that must be bulletproof — "given
// linework, what are the faces" — to the JTS port (GEOS lineage), and keeps
// everything downstream (containment, growth, outlines) as plain typed code.
//
// Deep imports keep the bundle to the reachable graph instead of the 492 KB
// UMD build.
import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import Coordinate from "jsts/org/locationtech/jts/geom/Coordinate.js";
import Polygonizer from "jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js";
import UnaryUnionOp from "jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js";

export type Pt = [number, number];

export interface PolyFace {
  /** exterior ring, closed (first !== last), CW or CCW as produced */
  ring: Pt[];
  /** interior rings (holes) */
  holes: Pt[][];
  /** positive area: |exterior| − Σ|holes| */
  area: number;
  /** tight bbox of the exterior ring */
  x0: number; y0: number; x1: number; y1: number;
  /** true when an edge of this face borders un-polygonized void (outside the
   *  enclosed network) — evidence the face touches the building perimeter */
  voidEdge?: boolean;
}

export interface PolyArrangement {
  faces: PolyFace[];
  /** face adjacency by shared edge */
  adj: Set<number>[];
  /** snap grid the input was welded on (input units) */
  snap: number;
}

/** Default weld grid: 2 px at the 18 px/ft corpus calibration ≈ 1.33 in.
 *  Callers with a known scale should pass `snap = SNAP_FT * pxPerFt`. */
export const SNAP_FT = 2 / 18;

/** Build the planar subdivision of `segs` (flat x0,y0,x1,y1 quadruples).
 *  Endpoints are welded to a `snap` grid, the linework is fully noded by
 *  unary union, and every enclosed face is returned with adjacency. */
export function buildPolyArrangement(segs: number[], snap: number): PolyArrangement {
  const gf = new GeometryFactory();
  const q = (v: number) => Math.round(v / snap) * snap;
  const lines: unknown[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 3 < segs.length; i += 4) {
    const x1 = q(segs[i]), y1 = q(segs[i + 1]), x2 = q(segs[i + 2]), y2 = q(segs[i + 3]);
    if (x1 === x2 && y1 === y2) continue;
    const key = x1 < x2 || (x1 === x2 && y1 < y2) ? `${x1},${y1},${x2},${y2}` : `${x2},${y2},${x1},${y1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(gf.createLineString([new Coordinate(x1, y1), new Coordinate(x2, y2)]));
  }
  const faces: PolyFace[] = [];
  const adj: Set<number>[] = [];
  if (!lines.length) return { faces, adj, snap };
  const mls = gf.createMultiLineString(lines);
  const noded = UnaryUnionOp.union(mls);
  const pz = new Polygonizer();
  pz.add(noded);
  const polys = pz.getPolygons();
  const edgeMap = new Map<string, number[]>();
  const nk = (x: number, y: number) => Math.round(x / snap) + "," + Math.round(y / snap);
  for (let it = polys.iterator(); it.hasNext();) {
    const p = it.next();
    const fi = faces.length;
    const ext = p.getExteriorRing().getCoordinates();
    const ring: Pt[] = ext.slice(0, ext.length - 1).map((c: { x: number; y: number }) => [c.x, c.y]);
    let area = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      area += a[0] * b[1] - b[0] * a[1];
      if (a[0] < x0) x0 = a[0]; if (a[0] > x1) x1 = a[0];
      if (a[1] < y0) y0 = a[1]; if (a[1] > y1) y1 = a[1];
    }
    const holes: Pt[][] = [];
    let holeA = 0;
    for (let h = 0; h < p.getNumInteriorRing(); h++) {
      const hc = p.getInteriorRingN(h).getCoordinates();
      const hr: Pt[] = hc.slice(0, hc.length - 1).map((c: { x: number; y: number }) => [c.x, c.y]);
      holes.push(hr);
      let hA = 0;
      for (let i = 0; i < hr.length; i++) { const a = hr[i], b = hr[(i + 1) % hr.length]; hA += a[0] * b[1] - b[0] * a[1]; }
      holeA += Math.abs(hA) / 2;
    }
    faces.push({ ring, holes, area: Math.abs(area / 2) - holeA, x0, y0, x1, y1 });
    const reg = (r: Pt[]) => {
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length];
        const ka = nk(a[0], a[1]), kb = nk(b[0], b[1]);
        if (ka === kb) continue;
        const key = ka < kb ? ka + "|" + kb : kb + "|" + ka;
        const l = edgeMap.get(key);
        if (l) l.push(fi); else edgeMap.set(key, [fi]);
      }
    };
    reg(ring);
    for (const hr of holes) reg(hr);
  }
  for (const f of faces) adj.push(new Set());
  for (const l of edgeMap.values()) {
    // an edge owned by exactly one face borders the un-polygonized outside
    if (l.length === 1) faces[l[0]].voidEdge = true;
    for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
      if (l[i] !== l[j]) { adj[l[i]].add(l[j]); adj[l[j]].add(l[i]); }
    }
  }
  return { faces, adj, snap };
}

export function pointInRing(v: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
    const yi = v[i][1], yj = v[j][1];
    if ((yi > y) !== (yj > y) && x < ((v[j][0] - v[i][0]) * (y - yi)) / (yj - yi) + v[i][0]) inside = !inside;
  }
  return inside;
}

/** The smallest face containing (x, y), skipping faces the caller vetoes
 *  (wall material, door cells). Holes exclude — a point in a face's hole is
 *  in some smaller face instead. */
export function faceAt(A: PolyArrangement, x: number, y: number, skip?: (f: number) => boolean): number {
  let best = -1;
  for (let i = 0; i < A.faces.length; i++) {
    const f = A.faces[i];
    if (x < f.x0 || x > f.x1 || y < f.y0 || y > f.y1) continue;
    if (best >= 0 && f.area >= A.faces[best].area) continue;
    if (skip && skip(i)) continue;
    if (!pointInRing(f.ring, x, y)) continue;
    let inHole = false;
    for (const h of f.holes) { if (pointInRing(h, x, y)) { inHole = true; break; } }
    if (inHole) continue;
    best = i;
  }
  return best;
}

/** Grow a room from a seed face: absorb neighbours smallest-first, refusing
 *  solid faces, faces above the per-face gate, and growth beyond a cumulative
 *  cap — a room's own fragments are pocket-scale and few; another room reached
 *  through a leak is big, and refusing it beats blobbing. (Window-bay
 *  carve-through was tried and rejected: his bay conventions differ
 *  room-to-room, and the owner accepts bays as out of scope.) */
export function growRoom(
  A: PolyArrangement, seed: number, solid: (f: number) => boolean,
  maxAbsorb?: number,
): number[] {
  if (seed < 0 || seed >= A.faces.length) return [];
  if (solid(seed)) return [];
  const seen = new Set<number>([seed]);
  const cap = maxAbsorb !== undefined ? Math.max(maxAbsorb, 0.5 * A.faces[seed].area) : Infinity;
  let absorbed = 0;
  const frontier = new Set<number>();
  const pushN = (f: number) => { for (const o of A.adj[f]) { if (!seen.has(o)) frontier.add(o); } };
  pushN(seed);
  while (frontier.size) {
    let best = -1, bestA = Infinity;
    for (const o of frontier) { if (A.faces[o].area < bestA) { bestA = A.faces[o].area; best = o; } }
    frontier.delete(best);
    if (seen.has(best)) continue;
    if (solid(best)) continue;
    if (maxAbsorb !== undefined && bestA > maxAbsorb) continue;
    if (absorbed + bestA > cap) break;
    absorbed += bestA;
    seen.add(best);
    pushN(best);
  }
  return [...seen];
}

/** Boundary of a face set: edges used an odd number of times, chained with a
 *  sharpest-right-turn rule at pinch points. Longest ring is the room's
 *  boundary; the rest are holes (columns, shafts). */
export function roomOutline(A: PolyArrangement, set: number[]): { ring: Pt[]; holes: Pt[][] } {
  const cnt = new Map<string, number>();
  const geo = new Map<string, [Pt, Pt]>();
  const reg = (r: Pt[]) => {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      const ka = Math.round(a[0]) + "," + Math.round(a[1]);
      const kb = Math.round(b[0]) + "," + Math.round(b[1]);
      if (ka === kb) continue;
      const key = ka < kb ? ka + "|" + kb : kb + "|" + ka;
      cnt.set(key, (cnt.get(key) || 0) + 1);
      geo.set(key, [a, b]);
    }
  };
  for (const fi of set) { const f = A.faces[fi]; reg(f.ring); for (const h of f.holes) reg(h); }
  const border: [Pt, Pt][] = [];
  for (const [k, c] of cnt) if (c % 2 === 1) border.push(geo.get(k) as [Pt, Pt]);
  const pk = (p: Pt) => Math.round(p[0]) + "," + Math.round(p[1]);
  const byStart = new Map<string, number[]>();
  border.forEach((e, i) => {
    for (const [a, b] of [[e[0], e[1]], [e[1], e[0]]] as [Pt, Pt][]) {
      void b;
      const k = pk(a);
      const l = byStart.get(k);
      if (l) l.push(i); else byStart.set(k, [i]);
    }
  });
  const used = new Set<number>();
  const rings: Pt[][] = [];
  for (let s = 0; s < border.length; s++) {
    if (used.has(s)) continue;
    const ring: Pt[] = [border[s][0]];
    used.add(s);
    let prev = border[s][0], cur = border[s][1];
    for (let guard = 0; guard <= border.length; guard++) {
      ring.push(cur);
      const cands = (byStart.get(pk(cur)) || []).filter((i) => !used.has(i));
      if (!cands.length) break;
      // sharpest right turn keeps the walk on this region at pinch points
      const back = Math.atan2(prev[1] - cur[1], prev[0] - cur[0]);
      let bi = -1, bt = Infinity;
      for (const i of cands) {
        const nx = pk(border[i][0]) === pk(cur) ? border[i][1] : border[i][0];
        let t = back - Math.atan2(nx[1] - cur[1], nx[0] - cur[0]);
        while (t <= 1e-9) t += Math.PI * 2;
        while (t > Math.PI * 2) t -= Math.PI * 2;
        if (t < bt) { bt = t; bi = i; }
      }
      used.add(bi);
      prev = cur;
      cur = pk(border[bi][0]) === pk(cur) ? border[bi][1] : border[bi][0];
      if (pk(cur) === pk(ring[0])) break;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  if (!rings.length) return { ring: [], holes: [] };
  const areaOf = (r: Pt[]) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; };
  rings.sort((a, b) => areaOf(b) - areaOf(a));
  return { ring: rings[0], holes: rings.slice(1) };
}
