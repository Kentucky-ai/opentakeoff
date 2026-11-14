// The doorway line of a detector "swing" box, fitted to the drawing's ink.
// The box only says a swing is there. The line across the opening comes from
// the arc itself, found on a 32 px/ft render of the box's neighbourhood, so
// it works on vector and scanned pages alike:
//   1. arc: over hinge positions in the padded box and radii near the box
//      side, the circle whose inked run of angles is longest;
//   2. leaf: of the arc's two ends, the one joined to the hinge by a straight
//      inked line is the leaf tip, the other the closed end;
//   3. pair: a second arc whose closed end meets the first one's gives
//      hinge to hinge;
//   4. line: hinge → closed end, or hinge → leaf tip when wall ink runs on
//      past the tip line by more than a margin (a door drawn shut).
// Ported from the Python prototype (swingfit.py) the cutoffs were chosen
// with. Pure: the caller supplies the ink mask.
import { arange, inkBeyond, rint, type Box, type Mask, type Pt, type Seg } from "./geom.ts";

const STEP = 4, NANG = 360 / STEP;
const CA = Array.from({ length: NANG }, (_, i) => Math.cos((i * STEP * Math.PI) / 180));
const SA = Array.from({ length: NANG }, (_, i) => Math.sin((i * STEP * Math.PI) / 180));
/** Render scale of the clip, pixels per foot; its ink threshold; and the fit's fixed proportions. */
export const FIT_PXF = 32, FIT_THR = 225, RMIN = 0.85, PAD = 0.18;

/** Ink grown by one pixel up, down, left and right. */
export function dilate(m: Mask): Mask {
  const { w, h, data } = m, d = new Uint8Array(data);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!data[y * w + x]) continue;
      if (y + 1 < h) d[(y + 1) * w + x] = 1;
      if (y > 0) d[(y - 1) * w + x] = 1;
      if (x + 1 < w) d[y * w + x + 1] = 1;
      if (x > 0) d[y * w + x - 1] = 1;
    }
  }
  return { w, h, z: m.z, data: d };
}

/** Longest circular run of set samples, single gaps bridged: [start index, length]. */
export function longestRun(row: Uint8Array): [number, number] {
  const n = row.length, r = new Uint8Array(n);
  let all = true, any = false;
  for (let i = 0; i < n; i++) {
    r[i] = row[i] || (row[(i + n - 1) % n] && row[(i + 1) % n]) ? 1 : 0;
    if (r[i]) any = true; else all = false;
  }
  if (all) return [0, n];
  if (!any) return [0, 0];
  let s0 = 0;
  while (r[s0]) s0++;
  let best: [number, number] = [0, 0];
  for (let i = 0; i < n; ) {
    if (r[(i + s0) % n]) {
      let j = i;
      while (j < n && r[(j + s0) % n]) j++;
      if (j - i > best[1]) best = [(i + s0) % n, j - i];
      i = j;
    } else i++;
  }
  return best;
}

/** Share of 24 samples along a → b (from f0 to f1 of the way) that are ink. */
function cover(D: Mask, ax: number, ay: number, bx: number, by: number, f0 = 0.15, f1 = 0.92): number {
  let hit = 0;
  for (let i = 0; i < 24; i++) {
    const t = f0 + (i * (f1 - f0)) / 23;
    const x = rint(ax + t * (bx - ax)), y = rint(ay + t * (by - ay));
    if (x >= 0 && y >= 0 && x < D.w && y < D.h && D.data[y * D.w + x]) hit++;
  }
  return hit / 24;
}

interface Arc { sc: number; hx: number; hy: number; r: number; a0: number; deg: number; tip: Pt; closed: Pt; leaf: number; other: number }

function scan(D: Mask, HX: number[], HY: number[], R: number[], box: Box, pad: number, minDeg: number, maxDeg: number, rmax: number): Arc[] {
  const [x0, y0, x1, y1] = box, out: Arc[] = [], V = new Uint8Array(NANG);
  for (let k = 0; k < HX.length; k++) {
    const hx = HX[k], hy = HY[k], r = R[k];
    let cnt = 0;
    for (let j = 0; j < NANG; j++) {
      const px = rint(hx + r * CA[j]), py = rint(hy + r * SA[j]);
      const on = px >= 0 && py >= 0 && px < D.w && py < D.h && D.data[py * D.w + px] === 1 && px >= x0 - pad && px <= x1 + pad && py >= y0 - pad && py <= y1 + pad;
      V[j] = on ? 1 : 0;
      if (on) cnt++;
    }
    if (cnt < minDeg / STEP) continue;
    const [s, n] = longestRun(V), deg = n * STEP;
    if (deg < minDeg || deg > maxDeg) continue;
    const e = (s + n - 1) % NANG;
    const E0: Pt = [hx + r * CA[s], hy + r * SA[s]], E1: Pt = [hx + r * CA[e], hy + r * SA[e]];
    const c0 = cover(D, hx, hy, E0[0], E0[1]), c1 = cover(D, hx, hy, E1[0], E1[1]);
    const lc = Math.max(c0, c1), oc = Math.min(c0, c1);
    const [tip, closed] = c0 >= c1 ? [E0, E1] : [E1, E0];
    const sc = Math.min(deg, 96) - 1.2 * Math.max(0, deg - 100) + 45 * lc - 25 * oc * (oc > 0.7 ? 1 : 0) + (30 * r) / rmax;
    out.push({ sc, hx, hy, r, a0: s * STEP, deg, tip, closed, leaf: lc, other: oc });
  }
  return out;
}

function grid(xs: number[], ys: number[], rs: number[]): [number[], number[], number[]] {
  const HX: number[] = [], HY: number[] = [], R: number[] = [];
  for (const x of xs) for (const y of ys) for (const r of rs) { HX.push(x); HY.push(y); R.push(r); }
  return [HX, HY, R];
}

/** Candidate arcs in a box, best first: a coarse search on thickened ink, then a fine one around each of the best. */
function arcs(D: Mask, box: Box, rmin: number, rmax: number, pad: number, k: number, minDeg: number, minLeaf: number, maxDeg = 200, top = 6): Arc[] {
  const [x0, y0, x1, y1] = box, D2 = dilate(D);
  const [HX, HY, R] = grid(arange(x0 - pad, x1 + pad + 0.1, 3 * k), arange(y0 - pad, y1 + pad + 0.1, 3 * k), arange(rmin, rmax + 0.1, 3 * k));
  const coarse = scan(D2, HX, HY, R, box, pad, minDeg - 8, maxDeg, rmax).filter((o) => o.leaf >= minLeaf - 0.15);
  const order = coarse.map((o, i) => [o, i] as const).sort((a, b) => b[0].sc - a[0].sc || a[1] - b[1]).map((x) => x[0]);
  const keep: Arc[] = [];
  for (const o of order) {
    if (keep.every((q) => Math.hypot(o.hx - q.hx, o.hy - q.hy) > 0.5 * o.r)) keep.push(o);
    if (keep.length >= top) break;
  }
  const fine: Arc[] = [];
  for (const o of keep) {
    const d = arange(-3 * k, 3 * k + 0.1, k);
    const [fx, fy, fr] = grid(d.map((v) => o.hx + v), d.map((v) => o.hy + v), d.map((v) => o.r + v));
    const f = scan(D, fx, fy, fr, box, pad, minDeg, maxDeg, rmax).filter((q) => q.leaf >= minLeaf);
    if (!f.length) continue;
    let best = f[0];
    for (const q of f) if (q.sc > best.sc) best = q;
    fine.push(best);
  }
  return fine.map((o, i) => [o, i] as const).sort((a, b) => b[0].sc - a[0].sc || a[1] - b[1]).map((x) => x[0]);
}

export interface SwingFit {
  /** the fitted line, page points */
  seg: Seg | null;
  /** why there is no line */
  fail?: string;
  kind?: "pair" | "single";
  how?: string;
  /** the arc's sweep in degrees, its leaf's ink cover and the fit's score */
  deg?: number;
  leaf?: number;
  other?: number;
  score?: number;
  inkC?: number;
  inkT?: number;
  rFt?: number;
  hinge?: Pt;
  tip?: Pt;
  closed?: Pt;
}

/**
 * Fit a swing in a box. `clip` is the ink around the box, `origin` the clip's
 * top-left corner in page points; the box and the result are in page points.
 */
export function fitSwing(b: ArrayLike<number>, clip: Mask, origin: Pt, ppf: number, opts: { margin?: number; minLeaf?: number; minDeg?: number; pxf?: number } = {}): SwingFit {
  const margin = opts.margin ?? 0.15, minLeaf = opts.minLeaf ?? 0.7, minDeg = opts.minDeg ?? 36, pxf = opts.pxf ?? FIT_PXF;
  const z = clip.z, [ox, oy] = origin;
  const D = dilate(clip);
  const x0 = (b[0] - ox) * z, y0 = (b[1] - oy) * z, x1 = (b[2] - ox) * z, y1 = (b[3] - oy) * z;
  const w = x1 - x0, h = y1 - y0, lo = Math.min(w, h), hi = Math.max(w, h);
  if (lo < 6) return { seg: null, fail: "box too small" };
  const pair = hi >= 1.6 * lo, side = pair ? lo : hi;
  const A = arcs(D, [x0, y0, x1, y1], pair ? 0.36 * hi : RMIN * side, 1.12 * side, PAD * side, pxf / 16, minDeg, minLeaf);
  if (!A.length) return { seg: null, fail: "no arc with a leaf" };
  const a = A[0], hpt: Pt = [a.hx, a.hy], tip = a.tip, r = a.r;
  let closed = a.closed;
  const page = (p: Pt): Pt => [p[0] / z + ox, p[1] / z + oy];
  const local = (p: Pt): Pt => [p[0] / z, p[1] / z];
  for (const o of A.slice(1)) {
    const d = Math.hypot(hpt[0] - o.hx, hpt[1] - o.hy);
    if (Math.hypot(closed[0] - o.closed[0], closed[1] - o.closed[1]) <= 0.35 * Math.max(r, o.r) && Math.abs(d - (r + o.r)) <= 0.3 * (r + o.r) && Math.abs(r - o.r) <= 0.6 * Math.max(r, o.r)) {
      return { seg: { p1: page(hpt), p2: page([o.hx, o.hy]) }, kind: "pair", deg: a.deg, leaf: a.leaf, score: a.sc };
    }
  }
  // The arc's run can stop short (crossed by text, clipped, faint): the closed end is the arc's end, or the leaf turned
  // 90 degrees the arc's way, whichever line has more wall running on past its ends.
  const tl = Math.max(Math.hypot(tip[0] - hpt[0], tip[1] - hpt[1]), 1e-6);
  const u: Pt = [(tip[0] - hpt[0]) / tl, (tip[1] - hpt[1]) / tl], v: Pt = [closed[0] - hpt[0], closed[1] - hpt[1]];
  const sgn = u[0] * v[1] - u[1] * v[0] > 0 ? 1 : -1;
  const c90: Pt = [hpt[0] + r * sgn * -u[1], hpt[1] + r * sgn * u[0]];
  if (a.deg < 82) {
    const iArc = inkBeyond(clip, local(hpt), local(closed), pxf), i90 = inkBeyond(clip, local(hpt), local(c90), pxf);
    if (i90 > iArc || (a.deg >= 60 && i90 >= iArc)) closed = c90;
  }
  const ic = inkBeyond(clip, local(hpt), local(closed), pxf), it = inkBeyond(clip, local(hpt), local(tip), pxf);
  const useTip = it > ic + margin;
  return {
    seg: { p1: page(hpt), p2: page(useTip ? tip : closed) }, kind: "single", how: useTip ? "tip/ink" : "closed/ink",
    deg: a.deg, leaf: a.leaf, other: a.other, score: a.sc, inkC: ic, inkT: it, rFt: r / z / ppf, hinge: page(hpt), tip: page(tip), closed: page(closed),
  };
}

/** The neighbourhood of a box the fit needs, in page points, kept on the page. */
export function clipRect(b: ArrayLike<number>, ppf: number, pageW: number, pageH: number): Box {
  const pad = Math.max(b[2] - b[0], b[3] - b[1]) * 0.4 + 1.6 * ppf;
  return [Math.max(b[0] - pad, 0), Math.max(b[1] - pad, 0), Math.min(b[2] + pad, pageW), Math.min(b[3] + pad, pageH)];
}

/** A gray clip → its ink: darker than 225, and on a filled or tinted plan clearly darker than the fill (the clip's median). */
export function clipMask(gray: Uint8Array, w: number, h: number, z: number, thr = FIT_THR): Mask {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const n = gray.length, lo = Math.floor((n - 1) / 2), hi = Math.floor(n / 2);
  let acc = 0, mLo = 0, mHi = 0, gotLo = false;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (!gotLo && acc > lo) { mLo = v; gotLo = true; }
    if (acc > hi) { mHi = v; break; }
  }
  const cut = Math.min(thr, (mLo + mHi) / 2 - 35);
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = gray[i] < cut ? 1 : 0;
  return { w, h, z, data };
}
