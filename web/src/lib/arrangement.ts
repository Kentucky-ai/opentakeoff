// Planar arrangement — the exact half of room detection.
//
// Everything else in this program guesses. This does not: given a set of line
// segments, there is exactly one planar subdivision they induce, and its faces
// are a fact about the geometry, not an opinion about it. A room is a face.
//
// That is the whole reason to build this rather than flood pixels or pick a
// pre-drawn figure. A face is bounded by real edges on every side, so a region
// derived from one CANNOT be inset from a wall, CANNOT cross a partition, and
// CANNOT depend on where inside it you clicked — those three failures are
// structurally impossible here, where in a flood they are the common case.
//
// The pipeline, each step exact:
//   1. WELD    endpoints within tolerance collapse to one node (CAD emits the
//              same corner twice with float drift; two walls that visually
//              meet must share a node or the face walks past the corner).
//   2. SPLIT   every segment is cut at every crossing, so no edge interior
//              contains another edge's endpoint. This is what makes the graph
//              planar and the traversal well-defined.
//   3. FACES   half-edge traversal taking the most-clockwise turn at each
//              node. Every directed edge belongs to exactly one face, so the
//              faces partition the plane and nothing is double-counted.
//
// Pure, DOM-free, no dependencies — the node runner exercises it directly.

export type Pt = [number, number];

export interface ArrNode { x: number; y: number; out: number[] }   // out: half-edge ids
/** Half-edge: from node `a` to node `b`. `twin` is the reverse half-edge.
 *  `face` is filled by extractFaces. `seg` traces back to the input segment. */
export interface ArrHalfEdge { a: number; b: number; twin: number; face: number; seg: number; ang: number }
export interface ArrFace {
  /** half-edge ids walked in order */
  edges: number[];
  /** node ring, closed (first !== last) */
  verts: Pt[];
  /** signed shoelace area; NEGATIVE for the one unbounded outer face */
  area: number;
  /** tight bbox */
  x0: number; y0: number; x1: number; y1: number;
}
export interface Arrangement {
  nodes: ArrNode[];
  edges: ArrHalfEdge[];
  faces: ArrFace[];
  /** index of the unbounded face in `faces`, or -1 */
  outer: number;
}

/** Weld tolerance in the caller's units. Two endpoints closer than this are
 *  ONE corner: CAD writes a shared corner twice with float drift, and a
 *  drafter's "touching" walls are routinely a few thousandths apart. Too
 *  small and every corner leaks; too large and a real thin gap (a doorway
 *  reveal) is welded shut, which silently merges two rooms. */
export const WELD_TOL = 0.75;
/** Below this a segment is a duplicate point, not an edge. */
const MIN_EDGE = 1e-6;

const key = (v: number, cell: number) => Math.floor(v / cell);

/** Weld endpoints into shared nodes. Returns node list plus, for each input
 *  segment, its two node ids (or -1 when the segment collapsed). */
function weld(segs: number[], tol: number): { nodes: Pt[]; ends: Int32Array } {
  const n = segs.length >> 2;
  const nodes: Pt[] = [];
  const ends = new Int32Array(n * 2).fill(-1);
  const cell = Math.max(tol, 1e-9);
  const grid = new Map<string, number[]>();
  const tol2 = tol * tol;
  const nodeAt = (x: number, y: number): number => {
    const gx = key(x, cell), gy = key(y, cell);
    // the point may weld to a node in any of the 9 neighbouring buckets
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const b = grid.get(`${gx + dx},${gy + dy}`);
      if (!b) continue;
      for (const id of b) {
        const p = nodes[id];
        const ddx = p[0] - x, ddy = p[1] - y;
        if (ddx * ddx + ddy * ddy <= tol2) return id;
      }
    }
    const id = nodes.length;
    nodes.push([x, y]);
    const k = `${gx},${gy}`;
    const b = grid.get(k);
    if (b) b.push(id); else grid.set(k, [id]);
    return id;
  };
  for (let i = 0; i < n; i++) {
    const a = nodeAt(segs[i * 4], segs[i * 4 + 1]);
    const b = nodeAt(segs[i * 4 + 2], segs[i * 4 + 3]);
    if (a === b) continue;                       // collapsed to a point
    ends[i * 2] = a; ends[i * 2 + 1] = b;
  }
  return { nodes, ends };
}

/** Every crossing between two segments, as a parameter along each. Uses a
 *  uniform grid so this stays near-linear on a sheet with tens of thousands
 *  of strokes instead of quadratic. */
function crossings(nodes: Pt[], ends: Int32Array, cellSize: number): Map<number, number[]> {
  const m = ends.length >> 1;
  const grid = new Map<string, number[]>();
  const put = (i: number) => {
    const a = ends[i * 2], b = ends[i * 2 + 1];
    if (a < 0) return;
    const p = nodes[a], q = nodes[b];
    const x0 = Math.min(p[0], q[0]), x1 = Math.max(p[0], q[0]);
    const y0 = Math.min(p[1], q[1]), y1 = Math.max(p[1], q[1]);
    for (let gx = key(x0, cellSize); gx <= key(x1, cellSize); gx++) {
      for (let gy = key(y0, cellSize); gy <= key(y1, cellSize); gy++) {
        const k = `${gx},${gy}`;
        const arr = grid.get(k);
        if (arr) arr.push(i); else grid.set(k, [i]);
      }
    }
  };
  for (let i = 0; i < m; i++) put(i);
  const cuts = new Map<number, number[]>();
  const addCut = (i: number, t: number) => {
    if (t <= 1e-9 || t >= 1 - 1e-9) return;      // an endpoint is already a node
    const a = cuts.get(i);
    if (a) a.push(t); else cuts.set(i, [t]);
  };
  const seen = new Set<number>();
  for (const bucket of grid.values()) {
    for (let u = 0; u < bucket.length; u++) {
      for (let v = u + 1; v < bucket.length; v++) {
        const i = bucket[u], j = bucket[v];
        const pk = i < j ? i * 1e7 + j : j * 1e7 + i;
        if (seen.has(pk)) continue;
        seen.add(pk);
        const ia = ends[i * 2], ib = ends[i * 2 + 1], ja = ends[j * 2], jb = ends[j * 2 + 1];
        if (ia < 0 || ja < 0) continue;
        if (ia === ja || ia === jb || ib === ja || ib === jb) continue;   // already share a node
        const p = nodes[ia], q = nodes[ib], r = nodes[ja], s = nodes[jb];
        const dx1 = q[0] - p[0], dy1 = q[1] - p[1];
        const dx2 = s[0] - r[0], dy2 = s[1] - r[1];
        const den = dx1 * dy2 - dy1 * dx2;
        if (Math.abs(den) < 1e-12) continue;      // parallel or collinear
        const t = ((r[0] - p[0]) * dy2 - (r[1] - p[1]) * dx2) / den;
        const u2 = ((r[0] - p[0]) * dy1 - (r[1] - p[1]) * dx1) / den;
        if (t < 0 || t > 1 || u2 < 0 || u2 > 1) continue;
        addCut(i, t);
        addCut(j, u2);
      }
    }
  }
  return cuts;
}

/** Build the arrangement of `segs` (flat x0,y0,x1,y1 quadruples). */
export function buildArrangement(segs: number[], tol = WELD_TOL): Arrangement {
  const { nodes: pts, ends } = weld(segs, tol);
  const m = ends.length >> 1;
  // grid cell sized to the median segment length keeps buckets small
  let lenSum = 0, lenN = 0;
  for (let i = 0; i < m; i++) {
    if (ends[i * 2] < 0) continue;
    const p = pts[ends[i * 2]], q = pts[ends[i * 2 + 1]];
    lenSum += Math.hypot(q[0] - p[0], q[1] - p[1]); lenN++;
  }
  const cellSize = Math.max(tol * 4, lenN ? (lenSum / lenN) * 2 : 32);
  const cuts = crossings(pts, ends, cellSize);

  // materialise nodes + edges, splitting where needed
  const nodes: ArrNode[] = pts.map((p) => ({ x: p[0], y: p[1], out: [] }));
  const edges: ArrHalfEdge[] = [];
  const nodeGrid = new Map<string, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const k = `${key(nodes[i].x, tol)},${key(nodes[i].y, tol)}`;
    const b = nodeGrid.get(k); if (b) b.push(i); else nodeGrid.set(k, [i]);
  }
  const tol2 = tol * tol;
  const nodeFor = (x: number, y: number): number => {
    const gx = key(x, tol), gy = key(y, tol);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const b = nodeGrid.get(`${gx + dx},${gy + dy}`);
      if (!b) continue;
      for (const id of b) {
        const ddx = nodes[id].x - x, ddy = nodes[id].y - y;
        if (ddx * ddx + ddy * ddy <= tol2) return id;
      }
    }
    const id = nodes.length;
    nodes.push({ x, y, out: [] });
    const k = `${gx},${gy}`;
    const b = nodeGrid.get(k); if (b) b.push(id); else nodeGrid.set(k, [id]);
    return id;
  };
  const seenEdge = new Set<string>();
  const addEdge = (a: number, b: number, seg: number) => {
    if (a === b) return;
    const ek = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seenEdge.has(ek)) return;                // one edge per node pair
    seenEdge.add(ek);
    const ax = nodes[a].x, ay = nodes[a].y, bx = nodes[b].x, by = nodes[b].y;
    if (Math.hypot(bx - ax, by - ay) < MIN_EDGE) return;
    const h1 = edges.length, h2 = h1 + 1;
    edges.push({ a, b, twin: h2, face: -1, seg, ang: Math.atan2(by - ay, bx - ax) });
    edges.push({ a: b, b: a, twin: h1, face: -1, seg, ang: Math.atan2(ay - by, ax - bx) });
    nodes[a].out.push(h1);
    nodes[b].out.push(h2);
  };
  for (let i = 0; i < m; i++) {
    const a = ends[i * 2], b = ends[i * 2 + 1];
    if (a < 0) continue;
    const cut = cuts.get(i);
    if (!cut || !cut.length) { addEdge(a, b, i); continue; }
    cut.sort((x, y) => x - y);
    const p = pts[a], q = pts[b];
    let prev = a;
    let lastT = 0;
    for (const t of cut) {
      if (t - lastT < 1e-9) continue;
      const id = nodeFor(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t);
      addEdge(prev, id, i);
      prev = id; lastT = t;
    }
    addEdge(prev, b, i);
  }
  // sort each node's outgoing edges by angle — the traversal depends on it
  for (const nd of nodes) nd.out.sort((h1, h2) => edges[h1].ang - edges[h2].ang);
  const faces = extractFaces(nodes, edges);
  let outer = -1;
  for (let i = 0; i < faces.length; i++) if (faces[i].area < 0 && (outer < 0 || faces[i].area < faces[outer].area)) outer = i;
  return { nodes, edges, faces, outer };
}

/** Walk every half-edge exactly once, taking the most-clockwise turn at each
 *  node. The turn rule is what makes each walk hug one face: arriving along
 *  h, the next edge is the one just BEFORE h's twin in the node's angular
 *  order, so the walk never cuts across the face it is tracing. */
export function extractFaces(nodes: ArrNode[], edges: ArrHalfEdge[]): ArrFace[] {
  const faces: ArrFace[] = [];
  // position of each half-edge within its origin node's sorted `out`
  const slot = new Int32Array(edges.length).fill(-1);
  for (const nd of nodes) for (let i = 0; i < nd.out.length; i++) slot[nd.out[i]] = i;
  for (let start = 0; start < edges.length; start++) {
    if (edges[start].face !== -1) continue;
    const fid = faces.length;
    const walk: number[] = [];
    let h = start;
    // guard: a malformed graph must not spin forever
    for (let guard = 0; guard <= edges.length + 1; guard++) {
      edges[h].face = fid;
      walk.push(h);
      const tw = edges[h].twin;
      const nd = nodes[edges[tw].a];
      const s = slot[tw];
      // the edge just before the twin, cyclically = most-clockwise turn
      const next = nd.out[(s - 1 + nd.out.length) % nd.out.length];
      if (next === start) break;
      if (edges[next].face !== -1) break;         // defensive; a sound graph closes on `start`
      h = next;
    }
    const verts: Pt[] = walk.map((e) => [nodes[edges[e].a].x, nodes[edges[e].a].y]);
    let area = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < verts.length; i++) {
      const p = verts[i], q = verts[(i + 1) % verts.length];
      area += p[0] * q[1] - q[0] * p[1];
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    faces.push({ edges: walk, verts, area: area / 2, x0, y0, x1, y1 });
  }
  return faces;
}

/** The face containing (x, y): the smallest positive-area face whose ring
 *  encloses it. Faces nest (a room inside a suite inside the plate), and the
 *  innermost is the one the point is actually in. */
export function faceAt(arr: Arrangement, x: number, y: number, skip?: (f: number) => boolean): number {
  let best = -1;
  for (let i = 0; i < arr.faces.length; i++) {
    const f = arr.faces[i];
    if (f.area <= 0) continue;                    // outer face and degenerate walks
    if (x < f.x0 || x > f.x1 || y < f.y0 || y > f.y1) continue;
    if (best >= 0 && f.area >= arr.faces[best].area) continue;
    // `skip` lets the caller ignore faces that are not SPACE — wall material,
    // or the sliver between a tag box and the ink beside it. Without it the
    // smallest containing face is often such a sliver, and a click that
    // plainly landed on a floor finds no room at all.
    if (skip && skip(i)) continue;
    if (!pointInRing(f.verts, x, y)) continue;
    best = i;
  }
  return best;
}

/** Grow a ROOM from a face: every face reachable without crossing into solid
 *  material. `solid(faceIdx)` answers "is this face wall material" — on a
 *  drawn plan that is poché, the filled polygon a drafter uses to say SOLID.
 *
 *  This is the step that makes the arrangement usable. On its own the
 *  arrangement is too fine: a tag box, a fixture outline, a tile joint and a
 *  grain arrow each cut a real face, so a click lands in a 1.5 SF fragment of
 *  the room it is actually in. Merging across every non-wall edge puts the
 *  room back together, and merging across a WALL is refused — so the boundary
 *  of the result is, by construction, wall material on every side. It cannot
 *  be inset from a wall and cannot cross a partition; those are not tuned
 *  away, they are unreachable.
 *
 *  Returns the face ids of the room, or [] when the seed face is itself solid. */
export function growRoom(arr: Arrangement, seedFace: number, solid: (f: number) => boolean): number[] {
  if (seedFace < 0 || seedFace >= arr.faces.length) return [];
  if (arr.faces[seedFace].area <= 0) return [];
  if (solid(seedFace)) return [];
  const seen = new Set<number>([seedFace]);
  const stack = [seedFace];
  while (stack.length) {
    const f = stack.pop() as number;
    for (const h of arr.faces[f].edges) {
      const other = arr.edges[arr.edges[h].twin].face;
      if (other < 0 || seen.has(other)) continue;
      if (other === arr.outer) continue;              // never grow into open sheet
      if (arr.faces[other].area <= 0) continue;
      if (solid(other)) continue;                     // a wall stops the room
      seen.add(other);
      stack.push(other);
    }
  }
  return [...seen];
}

/** The outline of a merged room: the half-edges whose TWIN lies outside the
 *  set, walked into closed rings. The longest ring is the room's boundary;
 *  the rest are holes (a column, a shaft, a chase). */
export function roomOutline(arr: Arrangement, faces: number[]): { ring: Pt[]; holes: Pt[][] } {
  const inSet = new Set(faces);
  const border: number[] = [];
  for (const f of faces) {
    for (const h of arr.faces[f].edges) {
      const other = arr.edges[arr.edges[h].twin].face;
      if (!inSet.has(other)) border.push(h);
    }
  }
  // chain the border half-edges by shared nodes
  const byStart = new Map<number, number[]>();
  for (const h of border) {
    const a = arr.edges[h].a;
    const l = byStart.get(a); if (l) l.push(h); else byStart.set(a, [h]);
  }
  const used = new Set<number>();
  const rings: Pt[][] = [];
  for (const h0 of border) {
    if (used.has(h0)) continue;
    const ring: Pt[] = [];
    let h = h0;
    for (let guard = 0; guard <= border.length + 1; guard++) {
      used.add(h);
      ring.push([arr.nodes[arr.edges[h].a].x, arr.nodes[arr.edges[h].a].y]);
      const nexts = (byStart.get(arr.edges[h].b) || []).filter((e) => !used.has(e));
      if (!nexts.length) break;
      // at a node where several border edges meet, take the sharpest RIGHT
      // turn so the walk hugs this room rather than cutting into a neighbour
      const back = arr.edges[h].ang + Math.PI;
      let best = nexts[0], bestT = Infinity;
      for (const e of nexts) {
        let t = back - arr.edges[e].ang;
        while (t <= 0) t += Math.PI * 2;
        while (t > Math.PI * 2) t -= Math.PI * 2;
        if (t < bestT) { bestT = t; best = e; }
      }
      h = best;
      if (h === h0) break;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  if (!rings.length) return { ring: [], holes: [] };
  const areaOf = (r: Pt[]) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; };
  rings.sort((x, y) => areaOf(y) - areaOf(x));
  return { ring: rings[0], holes: rings.slice(1) };
}

export function pointInRing(v: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
    const yi = v[i][1], yj = v[j][1];
    if ((yi > y) !== (yj > y) && x < ((v[j][0] - v[i][0]) * (y - yi)) / (yj - yi) + v[i][0]) inside = !inside;
  }
  return inside;
}
