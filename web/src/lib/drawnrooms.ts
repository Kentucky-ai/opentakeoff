// Drawn rooms — the boundaries the sheet already states.
//
// One-Click's flood exists to RECOVER a room boundary from a 1-bit raster.
// On a great many sheets it never needed to: the drafter drew the room as a
// closed path, and the file still carries it. A finish plan is the clearest
// case — its hatch and stipple are CLIPPED to each room, so the clip path is
// the room's own outline, to the vertex.
//
// Measured on a commercial finish plan against an estimator's hand takeoff of
// the same 13 rooms: a drawn polygon matched his area within 5% on 9 of them,
// the four tightest at +0.1%, +0.2%, +0.5% and +2.4%, and the four tightest
// were all clip paths. The flood, on the same rooms, landed 2 of 13 within 5%
// and 0 of 13 with a ring he would not have had to fix by hand.
//
// So this is not another barrier heuristic. It is a lookup: which drawn
// figure encloses the click. That difference is what removes the failures the
// flood cannot escape —
//   • the vertices are the drafter's, so a ring never comes back jagged and
//     never needs hand-correcting (19 drawn segments where a raster trace of
//     the same room produced 47);
//   • there is no seed, so clicking anywhere inside a room gives the same
//     answer — the "click two inches over, different number" failure is not
//     mitigated, it is absent;
//   • a label box fails the room-size floor, so the click looks outward
//     instead of measuring the tag;
//   • a closed path cannot leak, so two rooms sharing a doorway stay two.
//
// It is deliberately NOT total: a sheet whose drafter drew no room polygons
// (or one exploded to loose dashes) yields nothing here, and the caller falls
// back to the flood. Refusing is the honest answer, and the caller has a
// working one behind it.
//
// Pure and DOM-free, like oneclick/sheets — the node runner exercises it
// directly.
import type { Point, SubPath } from "./oneclick.ts";
import { SEG_CLIP, SEG_FILLONLY, rdpClosed } from "./oneclick.ts";

/** How the sheet stated this figure. Kept because it is real evidence about
 *  trust: a clip path is a region the drafter defined so a pattern would fill
 *  it EXACTLY, which is the same question a takeoff asks. */
export type DrawnSource = "clip" | "fill" | "stroke";

export interface DrawnRegion {
  /** the figure's own vertices, image px, in draw order */
  verts: Point[];
  /** shoelace area, square feet */
  areaSF: number;
  source: DrawnSource;
  /** tight bbox, image px */
  x0: number; y0: number; x1: number; y1: number;
  /** segment index range into segs/meta — provenance back to the ink */
  i0: number; i1: number;
}

/** Smallest space anyone takes off. A figure under this is a tag box, a
 *  fixture, a hatch cell or a symbol — never a room, whatever encloses it.
 *  (A broom closet runs 15-20 SF; the largest genuine label box measured on
 *  two sheets was 1.5 SF, so the gap here is wide and the floor is not
 *  delicately placed.) */
export const ROOM_MIN_SF = 12;
/** …and no single drawn figure is a room if it covers most of the sheet: that
 *  is the drawing border, the title block frame, or the whole-plan clip. */
export const ROOM_MAX_SHEET_FRAC = 0.5;
/** Two figures this close in area and centre are the same room stated twice
 *  (a clip path and the stroked outline that shadows it). */
/** A clip within this factor of the smallest enclosing figure is describing
 *  the same space (a stroked outline rides a pen centreline, so it reads a few
 *  percent small against the clip that bounds the same finish); beyond it,
 *  the clip is a larger space that merely contains the click. */
export const CLIP_SAME_REGION = 1.5;
/** Ring simplification tolerance, FEET. A drafter's outline carries every jog
 *  of casework, jamb and threshold — real detail, but 90 vertices where an
 *  estimator would draw 13, and a ring that size is unpleasant to edit even
 *  when it is right. Half an inch is below the precision any takeoff claims
 *  (the engine's own snap tolerance is larger), so collapsing to it costs no
 *  measurable area while handing back a ring shaped like the room. */
export const RING_SIMPLIFY_FT = 1 / 24;
const DUP_AREA_FRAC = 0.02;
const DUP_CENTRE_FT = 0.5;

const shoelace = (v: Point[]): number => {
  let a = 0;
  for (let i = 0; i < v.length; i++) {
    const p = v[i], q = v[(i + 1) % v.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
};

/** Ray cast, half-open on the upper edge so a point on a shared boundary
 *  belongs to exactly one of two abutting rooms. */
export function pointInRing(v: Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
    const yi = v[i][1], yj = v[j][1];
    if ((yi > y) !== (yj > y) && x < ((v[j][0] - v[i][0]) * (y - yi)) / (yj - yi) + v[i][0]) inside = !inside;
  }
  return inside;
}

/** Every closed drawn figure that could be a room floor, largest first.
 *  `ftPx` is image px per foot; `sheetSF` caps a figure at a fraction of the
 *  sheet so the border and title-block frames drop out. */
export function drawnRegions(
  segs: number[], subpaths: SubPath[] | null | undefined, ftPx: number, sheetSF = Infinity,
): DrawnRegion[] {
  const out: DrawnRegion[] = [];
  if (!subpaths?.length || !(ftPx > 0)) return out;
  const maxSF = Number.isFinite(sheetSF) ? sheetSF * ROOM_MAX_SHEET_FRAC : Infinity;
  for (const sp of subpaths) {
    if (!sp.closed) continue;
    const n = sp.i1 - sp.i0;
    if (n < 3) continue;                          // a triangle is the least a room can be
    const verts: Point[] = [];
    for (let i = sp.i0; i < sp.i1; i++) verts.push([segs[i * 4], segs[i * 4 + 1]]);
    const areaSF = shoelace(verts) / (ftPx * ftPx);
    if (!(areaSF >= ROOM_MIN_SF) || areaSF > maxSF) continue;
    // simplify AFTER measuring, so the area is the drafter's and only the
    // vertex list is ours
    const simple = verts.length > 4 ? rdpClosed(verts, RING_SIMPLIFY_FT * ftPx) : verts;
    out.push({
      verts: simple.length >= 3 ? simple : verts, areaSF,
      source: sp.flags & SEG_CLIP ? "clip" : sp.flags & SEG_FILLONLY ? "fill" : "stroke",
      x0: sp.x0, y0: sp.y0, x1: sp.x1, y1: sp.y1, i0: sp.i0, i1: sp.i1,
    });
  }
  // One room is routinely stated more than once — the clip path that bounds
  // its pattern, the filled poché behind it, the stroked outline over it.
  // Keep ONE, preferring the clip: it is the figure a pattern had to fill
  // exactly, so it is the one drawn to the true finish boundary rather than
  // to a pen's centreline.
  const rank: Record<DrawnSource, number> = { clip: 0, fill: 1, stroke: 2 };
  out.sort((a, b) => b.areaSF - a.areaSF || rank[a.source] - rank[b.source]);
  const dupTol = DUP_CENTRE_FT * ftPx;
  const kept: DrawnRegion[] = [];
  for (const r of out) {
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
    const dup = kept.some((k) => {
      if (Math.abs(k.areaSF - r.areaSF) > DUP_AREA_FRAC * Math.max(k.areaSF, r.areaSF)) return false;
      return Math.abs((k.x0 + k.x1) / 2 - cx) <= dupTol && Math.abs((k.y0 + k.y1) / 2 - cy) <= dupTol;
    });
    if (!dup) kept.push(r);
  }
  return kept;
}

/** Structural ink crossing a figure's INTERIOR disqualifies it as one room.
 *  A viewport clip, a detail window, a hatch field over a wing — each encloses
 *  a click as convincingly as a room does, is the same shape, and can be the
 *  same size. What it cannot hide is that the drawing inside it has WALLS: a
 *  single room contains furniture, fixtures, casework and text, none of which
 *  runs the length of the space, while a viewport contains the partitions
 *  between the rooms it frames.
 *
 *  Measured on an image-underlay sheet whose seven candidates were all detail
 *  viewports (777-1579 SF), the estimator's rooms were 41-453 SF and the
 *  engine was returning +249%, +2546% and +3769%. Refusing is the honest
 *  answer there — the caller still has the flood.
 *
 *  "Interior" means clear of the figure's own edges by `marginFt`, so the
 *  boundary linework the figure was drawn against never counts against it. */
export const WALL_RUN_MIN_FT = 6;     // shorter than this is casework, a fixture, a leader
export const WALL_RUNS_MAX = 2;       // a couple of long interior runs is millwork; more is a floor plan
const INTERIOR_MARGIN_FT = 1.5;
export function interiorWallRuns(
  region: DrawnRegion, segs: number[], meta: Uint8Array | null | undefined, ftPx: number,
): number {
  const minLen = WALL_RUN_MIN_FT * ftPx, m = INTERIOR_MARGIN_FT * ftPx;
  const n = segs.length >> 2;
  let runs = 0;
  for (let i = 0; i < n && runs <= WALL_RUNS_MAX; i++) {
    if (meta && (meta[i] & SEG_CLIP)) continue;            // invisible ink states nothing
    const ax = segs[i * 4], ay = segs[i * 4 + 1], bx = segs[i * 4 + 2], by = segs[i * 4 + 3];
    if (Math.hypot(bx - ax, by - ay) < minLen) continue;
    // both ends well inside the figure's box, then really inside the ring
    if (ax < region.x0 + m || ax > region.x1 - m || ay < region.y0 + m || ay > region.y1 - m) continue;
    if (bx < region.x0 + m || bx > region.x1 - m || by < region.y0 + m || by > region.y1 - m) continue;
    if (!pointInRing(region.verts, (ax + bx) / 2, (ay + by) / 2)) continue;
    runs++;
  }
  return runs;
}

/** What fraction of a figure's PERIMETER actually rides drawn ink.
 *
 *  A room's outline sits ON the walls — that is what makes it a room. A figure
 *  that merely encloses the click can be anything the drafter drew: a hatch
 *  clip that stops short of the wall, a grain-direction box, a finish zone that
 *  spans two rooms and crosses the partition between them. Those float in open
 *  floor or cut through walls, and returning one is worse than returning
 *  nothing — the estimator has to check every polygon, which is the whole cost
 *  the feature was supposed to remove.
 *
 *  So: walk the perimeter, sample it, and ask how much of it has drawn ink
 *  under it. Real boundaries score near 1. Reported from the field on a
 *  commercial finish plan, the figures that came back visibly inset from the
 *  walls, or crossing the partition between two rooms, are exactly the ones
 *  this separates out.
 *
 *  `tol` is how far off a sample may sit and still count as ON the ink —
 *  a wall is drawn with thickness and the figure may ride either face. */
export const EDGE_SAMPLE_FT = 0.5;      // one sample per half foot of perimeter
export const EDGE_ON_INK_FT = 0.75;     // …counts as on-ink within this of a stroke
export const EDGE_MIN_ON_INK = 0.85;    // …and this much of the perimeter must be
export function perimeterOnInk(
  region: DrawnRegion, segs: number[], meta: Uint8Array | null | undefined, ftPx: number,
): number {
  const v = region.verts;
  if (v.length < 3 || !(ftPx > 0)) return 0;
  const tol = EDGE_ON_INK_FT * ftPx, tol2 = tol * tol;
  const step = Math.max(1, EDGE_SAMPLE_FT * ftPx);
  const n = segs.length >> 2;
  // only ink near the figure can matter — a coarse bucket keeps this linear
  const pad = tol + 1;
  const cand: number[] = [];
  for (let i = 0; i < n; i++) {
    if (meta && (meta[i] & SEG_CLIP)) continue;         // invisible ink is not a wall
    const ax = segs[i * 4], ay = segs[i * 4 + 1], bx = segs[i * 4 + 2], by = segs[i * 4 + 3];
    if (Math.max(ax, bx) < region.x0 - pad || Math.min(ax, bx) > region.x1 + pad) continue;
    if (Math.max(ay, by) < region.y0 - pad || Math.min(ay, by) > region.y1 + pad) continue;
    cand.push(i);
  }
  if (!cand.length) return 0;
  let total = 0, on = 0;
  for (let k = 0; k < v.length; k++) {
    const a = v[k], b = v[(k + 1) % v.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(len > 0)) continue;
    const steps = Math.max(1, Math.ceil(len / step));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
      total++;
      let hit = false;
      for (const i of cand) {
        const ax = segs[i * 4], ay = segs[i * 4 + 1], bx = segs[i * 4 + 2], by = segs[i * 4 + 3];
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        let u = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const qx = ax + dx * u - px, qy = ay + dy * u - py;
        if (qx * qx + qy * qy <= tol2) { hit = true; break; }
      }
      if (hit) on++;
    }
  }
  return total ? on / total : 0;
}

/** The room under (x, y): the SMALLEST drawn figure that encloses it.
 *  Smallest, because rooms nest inside the corridor that serves them, inside
 *  the suite, inside the floor plate — and the innermost enclosure is the one
 *  the estimator pointed at. The size floor in drawnRegions is what stops
 *  "smallest" from meaning a tag box. Returns null when the sheet drew
 *  nothing here, which is the caller's cue to fall back to the flood. */
export function roomAtPoint(
  regions: DrawnRegion[], x: number, y: number,
  ink?: { segs: number[]; meta?: Uint8Array | null; ftPx: number } | null,
): DrawnRegion | null {
  const hits: DrawnRegion[] = [];
  for (const r of regions) {
    if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;   // bbox reject first
    if (pointInRing(r.verts, x, y)) hits.push(r);
  }
  if (!hits.length) return null;
  // ROOMS NEST, so containment proves nothing about either figure: a suite
  // holds offices, an open area holds a closet, and the innermost enclosure
  // is the right answer in every one of those cases — which the size rule
  // below already gives.
  //
  // What DOES separate a room from a viewport clip or a detail window is that
  // the drawing inside a viewport has WALLS running through it, where a room
  // holds only furniture, casework and text. Refusing on that evidence
  // returns null, which is the caller's cue to fall back to the flood, and is
  // the honest answer rather than a confidently wrong one. Measured on an
  // image-underlay sheet whose every candidate was a detail viewport, this
  // turned +249%, +2546% and +3769% into three clean refusals.
  const real = ink
    ? hits.filter((h) => interiorWallRuns(h, ink.segs, ink.meta, ink.ftPx) <= WALL_RUNS_MAX
        && perimeterOnInk(h, ink.segs, ink.meta, ink.ftPx) >= EDGE_MIN_ON_INK)
    : hits;
  if (!real.length) return null;
  // A CLIP path outranks anything else enclosing the same point, even a
  // smaller one. Measured against an estimator's hand takeoff: where a clip
  // path was chosen the area landed +0.1%, +0.2%, +2.4% and +2.4% off his
  // number on 16-22 vertices; where a stroked outline was chosen instead the
  // same rooms came in +2.6% to +11.6% off on 36-90. That is not a tie the
  // size rule should be allowed to decide — a clip is the boundary a pattern
  // had to fill EXACTLY, so it is drawn to the finish face, while a stroked
  // outline follows a pen centreline and picks up every jog of casework and
  // threshold detail on the way.
  let smallest = real[0];
  for (const r of real) if (r.areaSF < smallest.areaSF) smallest = r;
  // …but only among figures describing the SAME region. A clip that merely
  // encloses the click from further out is a different, larger space (the
  // suite, the tile field, the floor plate), and preferring it blindly turned
  // a 36 SF room into 481 SF. So the size rule chooses the region and the
  // source rule chooses how that region was best stated.
  let best = smallest;
  for (const r of real) {
    if (r.source !== "clip") continue;
    if (r.areaSF > smallest.areaSF * CLIP_SAME_REGION) continue;
    if (best.source === "clip" && best.areaSF <= r.areaSF) continue;
    best = r;
  }
  return best;
}
