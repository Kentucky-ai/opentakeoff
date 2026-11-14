// False-find filters over the fused predictions, from the page's linework:
// toilet-partition stall doors (never a Division 8 door) and second
// predictions on one opening. Ported from the Python prototype (filters.py,
// vecs.py) the cutoffs were chosen with.
import { dist, mid, rint, wid, type Pred, type Pt } from "./geom.ts";

/** A page's straight linework: n × [x0, y0, x1, y1, stroke width, 1 if filled-not-stroked], page points. */
export interface WallSegs { data: Float32Array; n: number }
export const SEG_F32 = 6;

/** The page's usual stroke width: the most common width (to 0.01 pt) among stroked lines. */
export function modalWidth(s: WallSegs): number {
  const count = new Map<number, number>();
  let best = 0, bestN = 0;
  for (let i = 0; i < s.n; i++) {
    const w = s.data[i * SEG_F32 + 4], fill = s.data[i * SEG_F32 + 5];
    if (fill !== 0 || !(w > 0)) continue;
    const k = Math.fround(rint(Math.fround(w * 100)) / 100);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  for (const [k, n] of count) if (n > bestN) { best = k; bestN = n; }
  return best;
}

/**
 * For each end of the line a → b (b first): the straight lines that run on
 * along the line's direction just beyond that end, as their perpendicular
 * offsets in inches and their stroke widths. A wall past a doorway's end shows
 * up as its face lines here.
 */
export function endProfile(s: WallSegs, a: ArrayLike<number>, b: ArrayLike<number>, ppf: number, halfIn = 10, outIn: [number, number] = [2, 16], minLenIn = 8): Array<{ o: number[]; w: number[] }> {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
  if (L < 1e-6) return [{ o: [], w: [] }, { o: [], w: [] }];
  const ux = dx / L, uy = dy / L, nx = -uy, ny = ux, inch = ppf / 12, res: Array<{ o: number[]; w: number[] }> = [];
  const d = s.data;
  for (const [bx, by, sgn] of [[b[0], b[1], 1], [a[0], a[1], -1]] as const) {
    const o: number[] = [], w: number[] = [];
    const reach = (outIn[1] + halfIn) * inch * 2 + 1;
    for (let i = 0; i < s.n; i++) {
      const k = i * SEG_F32;
      const px = d[k] - bx, py = d[k + 1] - by, qx = d[k + 2] - bx, qy = d[k + 3] - by;
      // nowhere near this end: both endpoints on one far side
      if ((px > reach && qx > reach) || (px < -reach && qx < -reach) || (py > reach && qy > reach) || (py < -reach && qy < -reach)) continue;
      const vx = qx - px, vy = qy - py, ln = Math.hypot(vx, vy);
      if (!(ln >= minLenIn * inch)) continue;
      if (!(Math.abs(vx * ux + vy * uy) / Math.max(ln, 1e-9) > 0.985)) continue;
      const t0 = (px * ux + py * uy) * sgn, t1 = (qx * ux + qy * uy) * sgn;
      const ov = Math.min(Math.max(t0, t1), outIn[1] * inch) - Math.max(Math.min(t0, t1), outIn[0] * inch);
      if (!(ov >= 5 * inch)) continue;
      const off = ((px + qx) / 2) * nx + ((py + qy) / 2) * ny;
      if (!(Math.abs(off) <= halfIn * inch)) continue;
      o.push(off / inch); w.push(d[k + 4]);
    }
    res.push({ o, w });
  }
  return res;
}

/** Per prediction: a wall at an end of its line, i.e. a heavy (or filled) line within heavy_in of the line running on past that end. */
export function heavyFlags(preds: Pred[], s: WallSegs, ppf: number, modal: number, heavyIn = 10, ratio = 1.6): boolean[] {
  const cut = Math.fround(ratio * modal);
  return preds.map((p) => {
    for (const { o, w } of endProfile(s, p.p1, p.p2, ppf)) {
      for (let i = 0; i < o.length; i++) if ((w[i] >= cut || w[i] === 0) && Math.abs(o[i]) <= heavyIn) return true;
    }
    return false;
  });
}

export interface StallParams { wmax: number; wmin: number; near_ft: number; hs_min: number; heavy_in: number; useA: boolean; useB: boolean; row_n: number; pitch_ft: number }

/**
 * Toilet-partition doors, first rule set. A narrow reader door is a stall door when
 *  A) no heavy or filled wall line runs on past either end of its line, another such door stands within near_ft,
 *     and the sheet does draw its walls heavy (at least hs_min of its reader doors have one); or
 *  B) it is one of row_n or more narrow doors in a row at a pitch of at most pitch_ft (a row of compartments).
 * Returns the indices to drop.
 */
export function stallDoors(pred: Pred[], s: WallSegs, ppf: number, modal: number, P: StallParams): Set<number> {
  const R = pred.map((_, i) => i).filter((i) => pred[i].src === "reader");
  const flags = heavyFlags(R.map((i) => pred[i]), s, ppf, modal, P.heavy_in);
  const hv = new Map(R.map((i, k) => [i, flags[k]]));
  const hs = flags.length ? flags.filter(Boolean).length / flags.length : 0;
  const nar = R.filter((i) => { const w = (wid(pred[i]) / ppf) * 12; return P.wmin <= w && w <= P.wmax; });
  const drop = new Set<number>();
  if (P.useA && hs >= P.hs_min) {
    const thin = nar.filter((i) => !hv.get(i));
    for (const i of thin) if (thin.some((j) => j !== i && dist(mid(pred[i]), mid(pred[j])) <= P.near_ft * ppf)) drop.add(i);
  }
  if (P.useB) {
    for (const i of nar) {
      const p = pred[i], L = Math.max(wid(p), 1e-9);
      const u: Pt = [(p.p2[0] - p.p1[0]) / L, (p.p2[1] - p.p1[1]) / L], n: Pt = [-u[1], u[0]], m = mid(p);
      const rows: Array<Array<[number, number]>> = [[], []];
      for (const j of nar) {
        const mj = mid(pred[j]), v: Pt = [mj[0] - m[0], mj[1] - m[1]], Lj = Math.max(wid(pred[j]), 1e-9);
        const uj: Pt = [(pred[j].p2[0] - pred[j].p1[0]) / Lj, (pred[j].p2[1] - pred[j].p1[1]) / Lj];
        // doors side by side along their own line, or stacked across it (compartments in a row)
        [[u, n], [n, u]].forEach(([ax, off], k) => {
          if (Math.abs(v[0] * off[0] + v[1] * off[1]) <= 0.5 * ppf && Math.abs(uj[0] * u[0] + uj[1] * u[1]) > 0.97) rows[k].push([v[0] * ax[0] + v[1] * ax[1], j]);
        });
      }
      for (const row of rows) {
        if (!row.length) continue;
        const ts = row.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const k0 = ts.findIndex((x) => x[1] === i);
        if (k0 < 0) continue;
        const run = new Set<number>([i]);
        for (let k = k0; k + 1 < ts.length && ts[k + 1][0] - ts[k][0] <= P.pitch_ft * ppf; k++) run.add(ts[k + 1][1]);
        for (let k = k0; k - 1 >= 0 && ts[k][0] - ts[k - 1][0] <= P.pitch_ft * ppf; k--) run.add(ts[k - 1][1]);
        if (run.size >= P.row_n) for (const j of run) drop.add(j);
      }
    }
  }
  return drop;
}

export interface DedupeParams { across_ft: number; wider: number; useA: boolean; useB: boolean }

/**
 * One opening, one prediction.
 *  A) two parallel lines on one opening (the narrower one's midpoint inside the other's width, within across_ft of its line);
 *  B) a reader leaf lying on a wider prediction's opening (a pair found once as a pair or a doorway strip, and again as a single leaf).
 * Keeps the wider line in B, otherwise the reader door, then the higher score. Doors back to back in separate walls are
 * more than across_ft apart across the wall and are left alone. Returns the indices to drop.
 */
export function dedupe(pred: Pred[], ppf: number, P: DedupeParams): Set<number> {
  const n = pred.length, M = pred.map(mid), W = pred.map(wid);
  const U = pred.map((p, i): Pt => [(p.p2[0] - p.p1[0]) / Math.max(W[i], 1e-9), (p.p2[1] - p.p1[1]) / Math.max(W[i], 1e-9)]);
  const rank = (i: number): [number, number] => [pred[i].src === "reader" ? 1 : 0, pred[i].conf ?? pred[i].score ?? 0];
  const geq = (a: [number, number], b: [number, number]) => a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]);
  const drop = new Set<number>();
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j || drop.has(i) || drop.has(j)) continue;
      if (dist(M[i], M[j]) > W[i] + W[j] + 2 * ppf) continue;
      const v: Pt = [M[i][0] - M[j][0], M[i][1] - M[j][1]];
      const al = v[0] * U[j][0] + v[1] * U[j][1], ac = Math.abs(-v[0] * U[j][1] + v[1] * U[j][0]), par = Math.abs(U[i][0] * U[j][0] + U[i][1] * U[j][1]);
      if (P.useB && pred[i].src === "reader" && W[j] >= P.wider * W[i] && Math.abs(al) <= 0.55 * W[j] && ac <= 0.6 * W[i] + 0.5 * ppf) {
        const e = Math.min(...[pred[i].p1, pred[i].p2].map((q) => Math.abs(-(q[0] - M[j][0]) * U[j][1] + (q[1] - M[j][1]) * U[j][0])));
        if (e <= P.across_ft * ppf) { drop.add(i); continue; }
      }
      if (W[i] > W[j] || (W[i] === W[j] && i < j)) continue;   // i is the narrower (or the later twin)
      if (P.useA && par > 0.9 && Math.abs(al) <= 0.5 * W[j] && ac <= P.across_ft * ppf) {
        if (W[j] >= 1.3 * W[i] || geq(rank(j), rank(i))) drop.add(i);
        else drop.add(j);
      }
    }
  }
  return drop;
}
