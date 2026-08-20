// Wall network — connectivity evidence for walls a pen-weight test cannot see.
//
// The hatch classifier (classifyHatchSegs) softens strokes that sit inside a
// periodic parallel family, because a naive mask traps the fill between hatch
// lines. That is right for a tile grid and wrong for a PARTITION drawn at the
// same pen as the floor hatch it stands in — CAD offices do this constantly,
// and a softened partition lets a flood walk from one room into the next.
//
// Pen weight cannot separate those two: measured on a 25-room corpus, heavy
// ink alone accounts for 62.5% of the boundary an estimator actually commits
// to, and the missing third is drawn light. What DOES separate them is how
// the line is CONNECTED:
//
//   a wall gets LANDED ON — other walls stop dead against it (86.3% of real
//   boundary faces have two or more; 37.2% of impostors do), and
//   walls MEET, they do not CROSS — a line that continues well past a wall on
//   both sides is a course, a grid line or a dimension string, not a wall, and
//   a line sitting on a regular-pitch parallel field is the hatch itself.
//
// So: seed a network with the sheet's heaviest ink, then admit lighter faces
// that confirmed walls terminate on, that nothing crosses through, and that
// are not on a lattice. Repeat — admission propagates outward from the heavy
// skeleton and stops where the evidence stops. Ported from the Spline backend
// (`wall_network.py`), where it lifted boundary recall 72.5% → 83.0% on the
// corpus it was built on and 62.1% → 77.1% on eight plansets it had not seen.
//
// One deliberate divergence from that port: the seed there is an ABSOLUTE pen
// width, and on held-out plans that was its single worst failure — two big-box
// sets whose wall pen is thinner than the constant read as having no walls at
// all. Here the seed is RELATIVE (see seedWeight): the heaviest ink the sheet
// actually draws with, which is a property of the drawing rather than of a
// number someone tuned on other drawings.
//
// Pure module — no React, no DOM, same contract as oneclick.ts.

// meta bit, MIRRORED rather than imported: oneclick.ts consumes this module,
// so importing back would make the cycle real. Same value, one test pins it.
const SEG_CLIP = 2;       // clip-only path — invisible ink, never a wall

// ── geometry thresholds ──────────────────────────────────────────────────
// Feet-true when the sheet scale is known (mppf = mask px per foot); the px
// fallbacks are raster-honesty floors for a sheet of unknown scale, in the
// same spirit as HATCH_MAX_PITCH's fallback.
export const AXIS_TOL_PX = 1.0;        // drift across the axis before a line is diagonal
export const MIN_PIECE_FT = 0.5;       // a stroke shorter than this cannot even join a chain
export const MIN_FACE_FT = 2.0;        // ...and a welded run shorter than this vouches for nothing
export const CHAIN_GAP_FT = 0.35;      // below plank-course spacing, so a running-bond joint never welds
export const CHAIN_C_TOL_FT = 0.06;    // collinearity tolerance across the chain's axis
export const JOIN_FT = 0.4;            // a perpendicular endpoint this close is landing ON the face
export const CROSS_MARGIN_FT = 0.5;    // ...and one continuing this far past BOTH sides is crossing it
export const MIN_JUNCTIONS = 1;        // junctions needed to join the network
export const MAX_CROSSINGS = 0;        // walls meet; they do not cross
export const ROUNDS = 4;               // growth passes (measured: converges by 3)

// lattice (rhythm, NOT neighbour count — counting costs recall and throws away
// every banded exterior wall, which has neighbours but no regular pitch)
export const LATTICE_WIN_FT = 3.0;         // how far to look for family members
export const LATTICE_MIN_SIDE = 2;         // members needed on EACH side to be interior to a field
export const LATTICE_MAX_PITCH_FT = 1.5;   // a rhythm coarser than this is rooms, not hatch
export const LATTICE_PITCH_TOL = 0.30;     // regularity band around the median pitch
export const LATTICE_REGULAR = 0.7;        // fraction of gaps that must sit inside the band
export const LATTICE_MIN_OVERLAP_FT = 0.5; // members must actually run alongside each other

/** Cumulative share of axial ink the seed classes must account for. The
 *  heaviest pen on a sheet is often reserved for a handful of accents — one
 *  held-out planset had 1,185 strokes at its top weight and only 23 of them
 *  axis-aligned and longer than a foot, because that pen draws FIXTURES. So
 *  walk the pen classes from the top and stop at the first one that makes the
 *  heavy tier a real share of the drawing's axial ink.
 *
 *  0.12 is not a guess: polygonize's own pen tier landed on the same number
 *  from the other direction (TIER_MIN_SHARE, measured on the Prospect Cove
 *  corpus), and on the A123 clubhouse both rules pick the same class — w≥2,
 *  which is exactly the tier that branch documents as "wall with high
 *  precision". A tighter share stops at the top class and seeds the network
 *  with a token skeleton: 3% stopped at w6 on A123, 52 faces out of 1,727,
 *  while the partitions the network is supposed to reach ride w1. */
export const SEED_SHARE = 0.12;

/** px fallbacks for a sheet whose scale is unknown (mppf ≤ 0). */
const PX_PER_FT_GUESS = 8;

export interface NetFace {
  /** constant coordinate (mask px): x for vertical faces, y for horizontal */
  c: number;
  lo: number;
  hi: number;
  /** pen class — meta's device line width nibble */
  w: number;
  /** run length in mask px */
  length: number;
  /** the RAW pieces this run welded. Their endpoints are the drafting
   *  evidence: a shell run drawn in two pieces meeting at a partition is what
   *  tells you the partition is there, and welding erases exactly that. */
  parts: Array<[number, number]>;
  /** segment indices this face is made of, for mapping a verdict back */
  idx: number[];
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Axis-aligned faces in mask px, vertical and horizontal, pen class kept.
 *  Clip-only ink is invisible and never bounds anything. Curve chords are
 *  KEPT: some offices draw wall faces as polylines, and an axis-aligned chord
 *  of one is a wall face like any other. */
export function collectFaces(
  segs: number[], meta: Uint8Array, ws: number, minPiecePx: number,
): { V: NetFace[]; H: NetFace[] } {
  const V: NetFace[] = [], H: NetFace[] = [];
  const n = segs.length >> 2;
  for (let i = 0; i < n; i++) {
    const mt = meta[i];
    // clip-only ink is invisible and never bounds anything. Filled-not-stroked
    // ink is NOT excluded: solid poché is how many offices draw a wall, and its
    // outline is a wall face like any other (same call oneclick's mask makes).
    if (mt & SEG_CLIP) continue;
    const x1 = segs[i * 4] * ws, y1 = segs[i * 4 + 1] * ws;
    const x2 = segs[i * 4 + 2] * ws, y2 = segs[i * 4 + 3] * ws;
    const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
    const w = mt >> 4;
    if (dx < AXIS_TOL_PX && dy >= minPiecePx) {
      const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
      V.push({ c: (x1 + x2) / 2, lo, hi, w, length: dy, parts: [[lo, hi]], idx: [i] });
    } else if (dy < AXIS_TOL_PX && dx >= minPiecePx) {
      const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
      H.push({ c: (y1 + y2) / 2, lo, hi, w, length: dx, parts: [[lo, hi]], idx: [i] });
    }
  }
  return { V, H };
}

/** Weld collinear same-pen pieces into runs; keep runs ≥ minFacePx.
 *  Chaining stays WITHIN a pen class on purpose — a hairline course collinear
 *  with a heavy stub would otherwise inherit the stub's weight and put a wall
 *  line down the middle of every hatched room. */
export function chainFaces(
  faces: NetFace[], gapPx: number, cTolPx: number, minFacePx: number,
): NetFace[] {
  const tol = Math.max(cTolPx, 1e-6);
  const sorted = faces.slice().sort((a, b) =>
    (a.w - b.w) || (Math.round(a.c / tol) - Math.round(b.c / tol)) || (a.lo - b.lo));
  const out: NetFace[] = [];
  for (const f of sorted) {
    const r = out.length ? out[out.length - 1] : null;
    if (r && r.w === f.w && Math.abs(r.c - f.c) <= tol && f.lo <= r.hi + gapPx) {
      r.hi = Math.max(r.hi, f.hi);
      r.length = r.hi - r.lo;
      r.parts.push([f.lo, f.hi]);
      r.idx.push(...f.idx);
    } else {
      out.push({ c: f.c, lo: f.lo, hi: f.hi, w: f.w, length: f.length, parts: [[f.lo, f.hi]], idx: f.idx.slice() });
    }
  }
  return out.filter((f) => f.length >= minFacePx);
}

/** The pen class at which the heavy tier starts, read off THIS sheet.
 *  Classes are walked from the heaviest down, accumulating axial run length,
 *  and the tier closes at the first class that brings the total over
 *  SEED_SHARE of all axial ink. Returns 0 when there is nothing to seed with,
 *  which makes every face a seed and lets the crossing/lattice tests do the
 *  discriminating on their own. */
export function seedWeight(faces: NetFace[], share = SEED_SHARE): number {
  if (!faces.length) return 0;
  const byW = new Map<number, number>();
  let total = 0;
  for (const f of faces) {
    byW.set(f.w, (byW.get(f.w) || 0) + f.length);
    total += f.length;
  }
  if (total <= 0) return 0;
  const classes = Array.from(byW.keys()).sort((a, b) => b - a);
  let acc = 0;
  for (const w of classes) {
    acc += byW.get(w) as number;
    if (acc / total >= share) return w;
  }
  return classes[classes.length - 1] ?? 0;
}

/** face index → true when the face sits ON a regular-pitch parallel field.
 *  Members on both sides at one repeating pitch is what a hatch course looks
 *  like from the inside. The EXTREMAL course of a field has members on one
 *  side only and stays off the lattice — the same extremal-row doctrine the
 *  hatch classifier uses, and the reason a wall drawn against a masonry band
 *  survives while the band's own courses do not. */
export function onLattice(
  faces: NetFace[], winPx: number, maxPitchPx: number, minOverlapPx: number,
): boolean[] {
  const order = faces.map((f, i) => i).sort((a, b) => faces[a].c - faces[b].c);
  const out = new Array<boolean>(faces.length).fill(false);
  for (let k = 0; k < order.length; k++) {
    const f = faces[order[k]];
    const up: number[] = [], dn: number[] = [];
    for (let j = k + 1; j < order.length; j++) {
      const g = faces[order[j]];
      const d = g.c - f.c;
      if (d > winPx) break;
      if (d < 0.02) continue;
      if (Math.min(f.hi, g.hi) - Math.max(f.lo, g.lo) > minOverlapPx) up.push(d);
    }
    for (let j = k - 1; j >= 0; j--) {
      const g = faces[order[j]];
      const d = f.c - g.c;
      if (d > winPx) break;
      if (d < 0.02) continue;
      if (Math.min(f.hi, g.hi) - Math.max(f.lo, g.lo) > minOverlapPx) dn.push(d);
    }
    if (up.length < LATTICE_MIN_SIDE || dn.length < LATTICE_MIN_SIDE) continue;
    const offs = dn.map((d) => -d).concat([0]).concat(up).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < offs.length; i++) gaps.push(offs[i] - offs[i - 1]);
    const pitch = median(gaps);
    if (pitch <= 0 || pitch > maxPitchPx) continue;
    let hits = 0;
    for (const g of gaps) if (Math.abs(g - pitch) <= LATTICE_PITCH_TOL * pitch) hits++;
    out[order[k]] = hits / gaps.length >= LATTICE_REGULAR;
  }
  return out;
}

/** (junctions, crossings) of confirmed perpendicular walls against `f`.
 *
 *  A junction is a confirmed wall ENDING on this face — the building hanging
 *  off it. The direction is not symmetric and that asymmetry is load-bearing:
 *  what earns a face its place is being LANDED ON, not landing. A hatch
 *  course's own ends touch the shell it runs up to, so crediting either
 *  direction admits the entire field (measured: symmetric junctions drop the
 *  corpus from 0.729 to 0.583 and the plank hatch walks straight back in).
 *
 *  A crossing is a wall continuing well past the face on both sides — an X no
 *  two walls draw, and the mark of a course, grid line or dimension string
 *  the partitions are merely drawn over. */
export function junctionsAndCrossings(
  f: NetFace, perpWalls: NetFace[], joinPx: number, marginPx: number,
): { j: number; x: number } {
  let j = 0, x = 0;
  for (const g of perpWalls) {
    if (g.c < f.lo - joinPx || g.c > f.hi + joinPx) continue;
    // endpoints come from the RAW pieces: a shell run drawn in two pieces
    // meeting at a partition IS the evidence for that partition, and the
    // welded run has no endpoint there any more
    let lands = false;
    for (const [lo, hi] of g.parts) {
      if (Math.abs(lo - f.c) <= joinPx || Math.abs(hi - f.c) <= joinPx) { lands = true; break; }
    }
    if (lands) j++;
    else if (g.lo < f.c - marginPx && g.hi > f.c + marginPx) x++;
  }
  return { j, x };
}

export interface WallNetworkOpts {
  rounds?: number;
  minJunctions?: number;
  maxCrossings?: number;
  seedShare?: number;
}

/** Heavy ink seeds the network; light ink that meets it joins. Takes CHAINED
 *  faces and returns, for each, whether it reads as wall. Each round re-derives
 *  junctions against the walls confirmed so far. */
export function growNetwork(
  V: NetFace[], H: NetFace[], px: { join: number; margin: number; win: number; maxPitch: number; overlap: number },
  opts: WallNetworkOpts = {},
): { inV: boolean[]; inH: boolean[] } {
  const rounds = opts.rounds ?? ROUNDS;
  const minJ = opts.minJunctions ?? MIN_JUNCTIONS;
  const maxX = opts.maxCrossings ?? MAX_CROSSINGS;
  const latV = onLattice(V, px.win, px.maxPitch, px.overlap);
  const latH = onLattice(H, px.win, px.maxPitch, px.overlap);
  const seedW = seedWeight(V.concat(H), opts.seedShare ?? SEED_SHARE);
  const inV = V.map((f) => f.w >= seedW);
  const inH = H.map((f) => f.w >= seedW);

  const joins = (f: NetFace, perp: NetFace[], lat: boolean, i: number): boolean => {
    if (lat) return false;
    const { j, x } = junctionsAndCrossings(f, perp, px.join, px.margin);
    return j >= minJ && x <= maxX;
  };

  for (let r = 0; r < Math.max(0, rounds); r++) {
    const wallV = V.filter((_, i) => inV[i]);
    const wallH = H.filter((_, i) => inH[i]);
    const addV: number[] = [], addH: number[] = [];
    for (let i = 0; i < V.length; i++) if (!inV[i] && joins(V[i], wallH, latV[i], i)) addV.push(i);
    for (let i = 0; i < H.length; i++) if (!inH[i] && joins(H[i], wallV, latH[i], i)) addH.push(i);
    if (!addV.length && !addH.length) break;
    for (const i of addV) inV[i] = true;
    for (const i of addH) inH[i] = true;
  }
  return { inV, inH };
}

/** Per-segment verdict: 1 where the wall network vouches for the segment.
 *
 *  A seed is admitted on pen weight alone, which is not evidence a hatch
 *  classifier should be overruled with, so the final pass re-tests EVERY face
 *  in the network against the confirmed wall set: only faces carrying their
 *  own junction evidence (and off the lattice) come back vouched. A heavy
 *  hatch stays hatch.
 *
 *  `ws` maps image px → mask px (as classifyHatchSegs takes it) and `mppf` is
 *  mask px per foot, 0 when the sheet scale is unknown. */
export function networkWallSegs(
  segs: number[], meta: Uint8Array | null, ws: number, mppf = 0, opts: WallNetworkOpts = {},
): Uint8Array {
  const n = segs.length >> 2;
  const vouched = new Uint8Array(n);
  if (!meta || !n) return vouched;
  const ppf = mppf > 0 ? mppf : PX_PER_FT_GUESS;
  const px = {
    join: JOIN_FT * ppf,
    margin: CROSS_MARGIN_FT * ppf,
    win: LATTICE_WIN_FT * ppf,
    maxPitch: LATTICE_MAX_PITCH_FT * ppf,
    overlap: LATTICE_MIN_OVERLAP_FT * ppf,
  };
  const { V, H } = collectFaces(segs, meta, ws, MIN_PIECE_FT * ppf);
  if (!V.length && !H.length) return vouched;
  const cV = chainFaces(V, CHAIN_GAP_FT * ppf, CHAIN_C_TOL_FT * ppf, MIN_FACE_FT * ppf);
  const cH = chainFaces(H, CHAIN_GAP_FT * ppf, CHAIN_C_TOL_FT * ppf, MIN_FACE_FT * ppf);
  if (!cV.length && !cH.length) return vouched;
  const { inV, inH } = growNetwork(cV, cH, px, opts);

  const wallV = cV.filter((_, i) => inV[i]);
  const wallH = cH.filter((_, i) => inH[i]);
  const latV = onLattice(cV, px.win, px.maxPitch, px.overlap);
  const latH = onLattice(cH, px.win, px.maxPitch, px.overlap);
  const minJ = opts.minJunctions ?? MIN_JUNCTIONS;
  const maxX = opts.maxCrossings ?? MAX_CROSSINGS;
  const stamp = (faces: NetFace[], inside: boolean[], lat: boolean[], perp: NetFace[]): void => {
    for (let i = 0; i < faces.length; i++) {
      if (!inside[i] || lat[i]) continue;
      const { j, x } = junctionsAndCrossings(faces[i], perp, px.join, px.margin);
      if (j < minJ || x > maxX) continue;
      for (const si of faces[i].idx) vouched[si] = 1;
    }
  };
  stamp(cV, inV, latV, wallH);
  stamp(cH, inH, latH, wallV);
  return vouched;
}
