// Close the openings — the step both published pipelines do before extracting
// rooms, and the one this engine has never done.
//
// The flood is bounded by drawn ink, and a doorway is a deliberate GAP in the
// drawn ink. The engine's existing answer is the seal ladder in
// floodRegionSealed: dilate hard ink until the gap closes, flood, grow back.
// That works where walls are drawn thick (poché) and fails where they are not
// — a sheet whose walls are a 0.05 ft filled sliver plus a hairline stroke
// needs ~1.5 ft of dilation to bridge a 3 ft door, and 1.5 ft of dilation
// swallows the walls themselves. Measured on the corpus: with interior ink
// crossed, that sheet's whole floor floods as one 3,180 SF region.
//
// So close the opening where the drafter SAID it is. A hinged door is drawn as
// its swing: an arc whose centre is the hinge and whose far end is the strike.
// The chord hinge→strike is the door in its closed position, which is exactly
// the line the finish stops at. That is not an inference about the geometry —
// it is reading the drafter's own statement of the opening, the same evidence
// `flagNonDoorArcs` and `arcClusterFit` already trade in.
//
// This module is deliberately mask-shaped rather than wall-network-shaped: the
// only question it asks of the drawing is "is there boundary ink here", which
// the mask answers directly. It needs no notion of what a wall IS — the thing
// that has defeated every attempt on sheets with no pen-weight signal.
import {
  SEG_CURVE, SEG_CLIP, DOOR_R_MIN_FT, DOOR_R_MAX_FT, flagNonDoorArcs,
} from "./oneclick.ts";
import type { Point, MaskObj } from "./oneclick.ts";

/** A door read off its own swing. `hinge` is the arc centre, `strike` the arc
 *  end that meets a wall; the chord between them is the closed leaf. */
export interface DoorSeal {
  hinge: Point;
  strike: Point;
  /** fitted swing radius, image px (the leaf width) */
  r: number;
}

// A swing sweeps a quarter turn, give or take how the drafter drew it. Below
// 0.7 rad the chord is too short to be a leaf and the "arc" is a fillet or a
// furniture curve; above 2.1 rad it is not a door being drawn. Both ends are
// physical facts about doors, not fitted to a sheet.
const SWEEP_MIN = 0.7;
const SWEEP_MAX = 2.1;
/** Circle-fit residual tolerance: px, or this fraction of the radius. */
const FIT_TOL_FRAC = 0.06;
const FIT_TOL_MIN_PX = 0.75;

/** Kasa circle fit over a chain of chords. Returns null when the chain is not
 *  circular to tolerance — a bezier tessellation of something that is not an
 *  arc must not be forced into one. */
function kasaFit(xs: number[], ys: number[]): { cx: number; cy: number; r: number } | null {
  const m = xs.length;
  if (m < 4) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < m; i++) { mx += xs[i]; my += ys[i]; }
  mx /= m; my /= m;
  let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
  for (let i = 0; i < m; i++) {
    const x = xs[i] - mx, y = ys[i] - my, z = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sxz += x * z; syz += y * z;
  }
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-9) return null;
  const cx = (sxz * syy - syz * sxy) / (2 * det);
  const cy = (syz * sxx - sxz * sxy) / (2 * det);
  let r = 0;
  for (let i = 0; i < m; i++) r += Math.hypot(xs[i] - mx - cx, ys[i] - my - cy);
  r /= m;
  if (!(r > 0)) return null;
  const tol = Math.max(FIT_TOL_MIN_PX, r * FIT_TOL_FRAC);
  for (let i = 0; i < m; i++) {
    if (Math.abs(Math.hypot(xs[i] - mx - cx, ys[i] - my - cy) - r) > tol) return null;
  }
  return { cx: cx + mx, cy: cy + my, r };
}

/** Is there boundary ink within `tolPx` (image px) of this image-px point? */
function inkNear(mo: MaskObj, x: number, y: number, tolPx: number): boolean {
  const mxc = x * mo.ws, myc = y * mo.ws, tr = Math.max(1, tolPx * mo.ws);
  const x0 = Math.max(0, Math.floor(mxc - tr)), x1 = Math.min(mo.mw - 1, Math.ceil(mxc + tr));
  const y0 = Math.max(0, Math.floor(myc - tr)), y1 = Math.min(mo.mh - 1, Math.ceil(myc + tr));
  const t2 = tr * tr;
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      if (!mo.mask[yy * mo.mw + xx]) continue;
      const dx = xx - mxc, dy = yy - myc;
      if (dx * dx + dy * dy <= t2) return true;
    }
  }
  return false;
}

export interface DoorSealOptions {
  /** Largest swing radius accepted as a door, ft. The ceiling exists to refuse
   *  curved WALLS, whose centres sit tens of feet away; see DOOR_R_MAX_FT. */
  maxRadiusFt?: number;
}

/** Read every hinged opening the drafter drew, as the chord it closes.
 *
 *  `segs`/`meta` are the sheet's vector geometry in image px; `mo` supplies the
 *  ink test, so a swing is only believed where it actually meets drawn ink at
 *  both ends — a fixture curve floating in open floor yields no seal. */
export function findDoorSeals(
  segs: number[], meta: Uint8Array, mo: MaskObj, pxPerFt: number, opts: DoorSealOptions = {},
): DoorSeal[] {
  if (!(pxPerFt > 0)) return [];
  const maxR = (opts.maxRadiusFt ?? DOOR_R_MAX_FT) * pxPerFt;
  const minR = DOOR_R_MIN_FT * pxPerFt;
  const veto = flagNonDoorArcs(segs, meta);
  const n = segs.length >> 2;
  const segLen = (i: number) => Math.hypot(segs[i * 4 + 2] - segs[i * 4], segs[i * 4 + 3] - segs[i * 4 + 1]);

  // ── chain contiguous curve chords into candidate swings ──────────────────
  const arcs: Array<{ C: Point; P0: Point; P1: Point; r: number }> = [];
  let chain: number[] = [];
  const flush = () => {
    const c = chain; chain = [];
    if (c.length < 3 || c.some((i) => veto[i])) return;
    const xs = [segs[c[0] * 4]], ys = [segs[c[0] * 4 + 1]];
    for (const i of c) { xs.push(segs[i * 4 + 2]); ys.push(segs[i * 4 + 3]); }
    const fit = kasaFit(xs, ys);
    if (!fit || fit.r < minR || fit.r > maxR) return;
    const P0: Point = [segs[c[0] * 4], segs[c[0] * 4 + 1]];
    const P1: Point = [segs[c[c.length - 1] * 4 + 2], segs[c[c.length - 1] * 4 + 3]];
    const a0 = Math.atan2(P0[1] - fit.cy, P0[0] - fit.cx);
    const a1 = Math.atan2(P1[1] - fit.cy, P1[0] - fit.cx);
    let sweep = Math.abs(a1 - a0);
    if (sweep > Math.PI) sweep = 2 * Math.PI - sweep;
    if (sweep < SWEEP_MIN || sweep > SWEEP_MAX) return;
    arcs.push({ C: [fit.cx, fit.cy], P0, P1, r: fit.r });
  };
  for (let i = 0; i < n; i++) {
    if (segLen(i) < 0.5) continue;
    if (!(meta[i] & SEG_CURVE) || (meta[i] & SEG_CLIP)) { flush(); continue; }
    if (chain.length) {
      const p = chain[chain.length - 1];
      const gap = Math.hypot(segs[i * 4] - segs[p * 4 + 2], segs[i * 4 + 1] - segs[p * 4 + 3]);
      if (meta[i] !== meta[p] || gap > Math.max(segLen(i), segLen(p))) flush();
    }
    chain.push(i);
  }
  flush();

  // ── keep the ones that behave like doors, and pick the striking end ───────
  // A door hinges ON a wall and strikes A wall. The hinge test alone throws out
  // fixture curves; the strike score decides WHICH end of the swing is the jamb
  // the leaf closes against, by probing just past the endpoint for the wall it
  // meets. Probing past the end rather than at it matters: the arc is drawn a
  // frame-width shy of the wall face.
  const seals: DoorSeal[] = [];
  for (const a of arcs) {
    if (!inkNear(mo, a.C[0], a.C[1], 0.45 * pxPerFt)) continue;
    const score = (E: Point) => {
      const ux = (E[0] - a.C[0]) / a.r, uy = (E[1] - a.C[1]) / a.r;
      let sc = 0;
      for (const t of [0.2, 0.45, 0.7]) {
        if (inkNear(mo, E[0] + ux * t * pxPerFt, E[1] + uy * t * pxPerFt, 0.2 * pxPerFt)) sc++;
      }
      if (inkNear(mo, E[0], E[1], 0.3 * pxPerFt)) sc++;
      return sc;
    };
    const s0 = score(a.P0), s1 = score(a.P1);
    if (Math.max(s0, s1) < 2) continue;      // strikes nothing: not a door
    seals.push({ hinge: a.C, strike: s0 >= s1 ? a.P0 : a.P1, r: a.r });
  }
  return seals;
}

/** The mask with every door closed — a COPY, so the caller keeps the honest
 *  one. Sealed ink is written as hard (1), because a closed door is exactly as
 *  much of a boundary to the finish as the wall it sits in. Returns the new
 *  mask and how many closures were written, so provenance can report which part
 *  of a room's boundary was inferred (the `sealedPx` precedent). */
export function sealDoorways(mo: MaskObj, seals: DoorSeal[]): { mo: MaskObj; sealed: number } {
  if (!seals.length) return { mo, sealed: 0 };
  const mask = new Uint8Array(mo.mask);
  const put = (mx: number, my: number) => {
    if (mx < 0 || my < 0 || mx >= mo.mw || my >= mo.mh) return;
    mask[my * mo.mw + mx] = 1;
  };
  for (const s of seals) {
    const x0 = s.hinge[0] * mo.ws, y0 = s.hinge[1] * mo.ws;
    const x1 = s.strike[0] * mo.ws, y1 = s.strike[1] * mo.ws;
    const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = Math.round(x0 + (x1 - x0) * t), cy = Math.round(y0 + (y1 - y0) * t);
      // 4-neighbourhood too: the flood is 4-connected, so a 1 px diagonal line
      // of ink is not a barrier — it leaks through the corner.
      put(cx, cy); put(cx + 1, cy); put(cx, cy + 1);
    }
  }
  return { mo: { ...mo, mask }, sealed: seals.length };
}
