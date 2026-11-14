// False-find filters, second set, from the rendered page and its text:
// toilet-compartment doors judged by the compartment (a thin partition at an
// end of the door, a fixture bowl or a restroom word nearby), and door
// symbols in a legend. Ported from the Python prototype (filters2.py,
// f2_raster.py, f2_feats.py) the cutoffs were chosen with.
import { arange, dist, mid, rint, wid, type Mask, type Pred, type Pt } from "./geom.ts";

const REST = /^(TOILETS?|RESTROOMS?|REST|MEN'?S?|WOMEN'?S?|BOYS'?|GIRLS'?|RR|R\.R\.|WC|W\.C\.|LAV|LAVATORY|BATH|BATHROOM|UNISEX|SHOWERS?|LOCKERS?)$/;
const VOCAB = /\b(DOORS?|WALLS?|PARTITIONS?|WINDOWS?|REMAIN|EXISTING|DEMOLISH(ED)?|REMOVED?|TAG|LEGEND|SYMBOLS?|OPENING|HINGED|SLIDING)\b/;

/** A word of page text with its centre, page points. */
export interface Word { str: string; c: Pt }

/** Centres of the words that name a restroom. */
export function restroomWords(words: Word[]): Pt[] {
  return words.filter((w) => REST.test(w.str.toUpperCase().replace(/^[.,()]+|[.,()]+$/g, ""))).map((w) => w.c);
}

/** Centres of short text lines that read like legend labels (door / wall / window vocabulary). */
export function legendLabels(lines: Array<{ str: string; c: Pt }>, maxChars = 45): Pt[] {
  const out: Pt[] = [];
  for (const l of lines) {
    const t = l.str.trim().toUpperCase();
    if (t.length >= 4 && t.length <= maxChars && VOCAB.test(t)) out.push(l.c);
  }
  return out;
}

const median = (v: number[]): number => { const s = [...v].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

/** Ink extent (inches) of the group of dark samples nearest the centre of a profile; samples closer than 9 in to each other are one wall (its two faces). -1: nothing near. */
function extent(run: boolean[], stepIn: number, centre: number, reachIn: number): number {
  const idx: number[] = [];
  for (let i = 0; i < run.length; i++) if (run[i]) idx.push(i);
  if (!idx.length) return -1;
  let k = 0;
  for (let i = 1; i < idx.length; i++) if (Math.abs(idx[i] - centre) < Math.abs(idx[k] - centre)) k = i;
  if (Math.abs(idx[k] - centre) * stepIn > reachIn) return -1;
  let lo = k, hi = k;
  while (lo > 0 && (idx[lo] - idx[lo - 1]) * stepIn <= 9 && (idx[hi] - idx[lo - 1]) * stepIn <= 15) lo--;
  while (hi < idx.length - 1 && (idx[hi + 1] - idx[hi]) * stepIn <= 9 && (idx[hi + 1] - idx[lo]) * stepIn <= 15) hi++;
  return (idx[hi] - idx[lo] + 1) * stepIn;
}

const samp = (m: Mask, x: number, y: number): boolean => {
  const xi = rint(x), yi = rint(y);
  return xi >= 0 && yi >= 0 && xi < m.w && yi < m.h && m.data[yi * m.w + xi] === 1;
};

/**
 * The wall at each end of a line (b first, then a): its thickness in inches,
 * or -1 for none. A wall that runs on past the end along the line is measured
 * across the line; failing that, a wall the end butts into is measured along it.
 */
export function wallEnds(m: Mask, ppf: number, a: ArrayLike<number>, b: ArrayLike<number>): [number, number] {
  const z = m.z, ax = a[0] * z, ay = a[1] * z, bx = b[0] * z, by = b[1] * z;
  const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy), ux = dx / Math.max(L, 1e-9), uy = dy / Math.max(L, 1e-9), nx = -uy, ny = ux;
  const inch = (ppf / 12) * z, step = 0.5;
  const offs = arange(-15, 15 + 1e-9, step), c = Math.floor(offs.length / 2);
  const tt = arange(-2, 14 + 1e-9, step), c2 = Math.round(2 / step);
  const res: number[] = [];
  for (const [ox, oy, sgn] of [[bx, by, 1], [ax, ay, -1]] as const) {
    const got: number[] = [];
    for (const t of [3, 4.5, 6, 7.5, 9, 10.5]) {
      const e = extent(offs.map((o) => samp(m, ox + sgn * ux * t * inch + nx * o * inch, oy + sgn * uy * t * inch + ny * o * inch)), step, c, 6);
      if (e >= 0) got.push(e);
    }
    if (got.length >= 4) { res.push(median(got)); continue; }
    const got2: number[] = [];
    for (const w of [-8, -5, -2.5, 2.5, 5, 8]) {
      const e = extent(tt.map((t) => samp(m, ox + nx * w * inch + sgn * ux * t * inch, oy + ny * w * inch + sgn * uy * t * inch)), step, c2, 5);
      if (e >= 0) got2.push(e);
    }
    res.push(got2.length >= 3 ? median(got2) : -1);
  }
  return [res[0], res[1]];
}

/** The smallest rectangle (any angle) around a set of points: its two side lengths and its centre. */
function minAreaRect(pts: Array<[number, number]>): { w: number; h: number; cx: number; cy: number } {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [], upper: Array<[number, number]> = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  if (hull.length === 1) return { w: 0, h: 0, cx: hull[0][0], cy: hull[0][1] };
  let best = { w: 0, h: 0, cx: 0, cy: 0 }, bestA = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-12) continue;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    let t0 = Infinity, t1 = -Infinity, s0 = Infinity, s1 = -Infinity;
    for (const q of hull) {
      const t = q[0] * ux + q[1] * uy, s = -q[0] * uy + q[1] * ux;
      if (t < t0) t0 = t; if (t > t1) t1 = t; if (s < s0) s0 = s; if (s > s1) s1 = s;
    }
    const A = (t1 - t0) * (s1 - s0);
    if (A < bestA - 1e-9) {
      bestA = A;
      const tc = (t0 + t1) / 2, sc = (s0 + s1) / 2;
      best = { w: t1 - t0, h: s1 - s0, cx: tc * ux - sc * uy, cy: tc * uy + sc * ux };
    }
  }
  return best;
}

/**
 * Distance in feet to the nearest fixture-like oval (a toilet or lavatory
 * bowl) within r_ft of a point: an enclosed white shape 7–17 in by 10–27 in,
 * clearly longer than wide, filling an ellipse's share of its box. 99: none.
 */
export function nearestOval(m: Mask, ppf: number, at: Pt, rFt = 8): number {
  const z = m.z, pxft = ppf * z, r = Math.trunc(rFt * pxft), cx = rint(at[0] * z), cy = rint(at[1] * z);
  const x0 = Math.max(cx - r, 0), y0 = Math.max(cy - r, 0), x1 = Math.min(cx + r, m.w), y1 = Math.min(cy + r, m.h);
  const W = x1 - x0, H = y1 - y0;
  if (W <= 0 || H <= 0) return 99;
  const lab = new Int32Array(W * H), pin = pxft / 12, stack: number[] = [];
  let best = 99, next = 0;
  for (let sy = 0; sy < H; sy++) {
    for (let sx = 0; sx < W; sx++) {
      const s = sy * W + sx;
      if (lab[s] || m.data[(y0 + sy) * m.w + x0 + sx]) continue;
      next++;
      lab[s] = next; stack.push(s);
      let ar = 0, bx0 = sx, bx1 = sx, by0 = sy, by1 = sy;
      const rowMin = new Map<number, number>(), rowMax = new Map<number, number>();
      while (stack.length) {
        const q = stack.pop()!, qx = q % W, qy = (q - qx) / W;
        ar++;
        if (qx < bx0) bx0 = qx; if (qx > bx1) bx1 = qx; if (qy < by0) by0 = qy; if (qy > by1) by1 = qy;
        if (!rowMin.has(qy) || qx < rowMin.get(qy)!) rowMin.set(qy, qx);
        if (!rowMax.has(qy) || qx > rowMax.get(qy)!) rowMax.set(qy, qx);
        if (qx > 0 && !lab[q - 1] && !m.data[(y0 + qy) * m.w + x0 + qx - 1]) { lab[q - 1] = next; stack.push(q - 1); }
        if (qx + 1 < W && !lab[q + 1] && !m.data[(y0 + qy) * m.w + x0 + qx + 1]) { lab[q + 1] = next; stack.push(q + 1); }
        if (qy > 0 && !lab[q - W] && !m.data[(y0 + qy - 1) * m.w + x0 + qx]) { lab[q - W] = next; stack.push(q - W); }
        if (qy + 1 < H && !lab[q + W] && !m.data[(y0 + qy + 1) * m.w + x0 + qx]) { lab[q + W] = next; stack.push(q + W); }
      }
      if (bx0 === 0 || by0 === 0 || bx1 + 1 >= W || by1 + 1 >= H) continue;
      if (!(50 * pin * pin <= ar && ar <= 380 * pin * pin)) continue;
      const pts: Array<[number, number]> = [];
      for (const [y, xa] of rowMin) { pts.push([xa, y]); const xb = rowMax.get(y)!; if (xb !== xa) pts.push([xb, y]); }
      const rect = minAreaRect(pts);
      const sides = [(rect.w + 1) / pin, (rect.h + 1) / pin].sort((p, q) => p - q);
      if (!(7 <= sides[0] && sides[0] <= 17 && 10 <= sides[1] && sides[1] <= 27 && 1.12 <= sides[1] / sides[0] && sides[1] / sides[0] <= 2.1)) continue;
      const fill = ar / Math.max((rect.w + 1) * (rect.h + 1), 1);
      if (!(0.68 <= fill && fill <= 0.87)) continue;
      const d = Math.hypot((x0 + rect.cx) / z - at[0], (y0 + rect.cy) / z - at[1]) / ppf;
      if (d < best) best = d;
    }
  }
  return best;
}

/** What the second filter set knows about a prediction. e0 / e1: wall thickness (in) at its line's two ends, -1 none. */
export interface Feat { w: number; cand: boolean; e0?: number; e1?: number; ov?: number; rd?: number; nb?: number }

/**
 * Per prediction: width, wall thickness at both ends, nearest fixture oval and
 * restroom word; and the sheet's share of ordinary doors (34 in or wider,
 * confident) that sit in a wall of thick_in or more at both ends. -1: no such door.
 */
export function features(pred: Pred[], mask: Mask, ppf: number, rest: Pt[], thickIn = 3.2): { feats: Feat[]; share: number } {
  const feats: Feat[] = pred.map((p) => {
    const w = (wid(p) / ppf) * 12, f: Feat = { w, cand: false };
    if (p.src === "reader" || p.cls === 0 || p.cls === 7) {
      const e = wallEnds(mask, ppf, p.p1, p.p2);
      f.e0 = e[0]; f.e1 = e[1];
      if (w >= 16 && w <= 40) {
        const m = mid(p);
        f.cand = true;
        f.ov = nearestOval(mask, ppf, m);
        f.rd = rest.length ? Math.min(...rest.map((r) => dist(r, m))) / ppf : 99;
      }
    }
    return f;
  });
  const od: boolean[] = [];
  pred.forEach((p, i) => { const f = feats[i]; if (p.src === "reader" && (p.conf ?? 0) >= 0.6 && f.w >= 34 && f.e0 !== undefined) od.push(Math.min(f.e0, f.e1!) >= thickIn); });
  const share = od.length ? od.filter(Boolean).length / od.length : -1;
  const M = pred.map(mid);
  feats.forEach((f, i) => {
    if (!f.cand) return;
    f.nb = feats.filter((g, j) => j !== i && g.cand && g.w <= 37 && Math.min(g.e0!, g.e1!) < thickIn && dist(M[j], M[i]) <= 10 * ppf).length;
  });
  return { feats, share };
}

export interface Stall2Params {
  min_share: number; wmin: number; wmax: number; thin_in: number; ov_ft: number; rd_ft: number; nb: number; thin2_in: number; acc_max: number;
  prop_ft: number; prop_n: number; useS2: boolean; useS3: boolean; useS4: boolean;
}

/**
 * Toilet-compartment doors, by the compartment. On a sheet that draws its
 * walls with thickness (share ≥ min_share), a narrow door is a stall door when
 *  S1a an end sits in a thin partition and there is restroom evidence (a fixture oval, a restroom word, or nb other
 *      narrow doors with a thin or free end within 10 ft);
 *  S1b an end is free (no wall at all) and there is a fixture oval or nb such neighbours;
 *  S2  an end is thinner than thin2_in with BOTH a fixture oval within 5 ft and a restroom word within 8 ft;
 *  S4  accessible stall: wmax to acc_max wide, a thin partition end, a fixture oval within 7 ft AND a restroom word within 8 ft;
 *  S3  it has a thin or free end and stands within prop_ft of prop_n doors already dropped as stall doors.
 * Returns index → rule.
 */
export function stall2(pred: Pred[], feats: Feat[], share: number, ppf: number, already: Set<number>, P: Stall2Params): Map<number, string> {
  const D = new Map<number, string>();
  if (share < P.min_share) return D;
  const pos = (f: Feat, thr = P.thin_in) => [f.e0!, f.e1!].some((e) => e >= 0 && e < thr);
  const free = (f: Feat) => Math.min(f.e0!, f.e1!) < 0;
  feats.forEach((f, i) => {
    if (!f.cand) return;
    if (P.wmin <= f.w && f.w <= P.wmax) {
      if (pos(f) && (f.ov! <= P.ov_ft || f.rd! <= P.rd_ft || f.nb! >= P.nb)) D.set(i, "S1a");
      else if (free(f) && (f.ov! <= P.ov_ft || f.nb! >= P.nb)) D.set(i, "S1b");
      else if (P.useS2 && pos(f, P.thin2_in) && f.ov! <= 5 && f.rd! <= 8) D.set(i, "S2");
    } else if (P.useS4 && P.wmax < f.w && f.w <= P.acc_max && pos(f) && f.ov! <= 7 && f.rd! <= 8) D.set(i, "S4");
  });
  if (P.useS3) {
    const M = pred.map(mid);
    for (let pass = 0; pass < 2; pass++) {
      const got = new Set<number>([...D.keys(), ...already]), add = new Map<number, string>();
      feats.forEach((f, i) => {
        if (got.has(i) || !f.cand || !(P.wmin <= f.w && f.w <= P.wmax) || !(pos(f) || free(f))) return;
        let n = 0;
        for (const j of got) if (dist(M[j], M[i]) <= P.prop_ft * ppf) n++;
        if (n >= P.prop_n) add.set(i, "S3");
      });
      for (const [k, v] of add) D.set(k, v);
    }
  }
  return D;
}

export interface Legend2Params { labels: number; lab_ft: number; others: number; others_ft: number }

/** A door symbol in a legend: `labels` or more legend-label lines within lab_ft and at most `others` other predictions within others_ft. */
export function legend2(pred: Pred[], labels: Pt[], ppf: number, P: Legend2Params): Set<number> {
  const D = new Set<number>();
  if (!labels.length) return D;
  const M = pred.map(mid);
  M.forEach((m, i) => {
    if (labels.filter((l) => dist(l, m) <= P.lab_ft * ppf).length >= P.labels && M.filter((o) => dist(o, m) <= P.others_ft * ppf).length - 1 <= P.others) D.add(i);
  });
  return D;
}
