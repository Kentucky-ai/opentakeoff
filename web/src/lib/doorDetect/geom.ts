// Shared geometry for the door detector's fusion and filters (lib/doorDetect).
// Everything is in page points, unrotated frame, y down, the door reader's
// frame. Pure: no DOM, no pdf.js.

export type Pt = [number, number];
export type Box = [number, number, number, number];
/** A detector box: x0, y0, x1, y1, score, class id. */
export type DetBox = [number, number, number, number, number, number];
export interface Seg { p1: Pt; p2: Pt }

export interface FitLeaf { hinge: Pt; tip: Pt; closed: Pt; rFt: number }

/** A prediction: one opening as a jamb-to-jamb line, and where it came from. */
export interface Pred extends Seg {
  src: "reader" | "det";
  box: Box;
  /** reader confidence (reader doors) */
  conf?: number;
  /** detector class and score (detector doors) */
  cls?: number;
  score?: number;
  /** how a detector door's line was drawn, or which rule brought it in */
  how?: string;
  /** indices of the reader doors this prediction stands for (one, or two leaves joined as a pair) */
  doors?: number[];
  /** a fitted swing: its hinge, leaf tip and closed end */
  fit?: FitLeaf | null;
  /** two fitted swings joined as one pair */
  pairFit?: [FitLeaf, FitLeaf];
}

/** A page's ink as a bitmap: 1 = ink. `z` = pixels per page point. */
export interface Mask { w: number; h: number; z: number; data: Uint8Array }

export const inter = (p: ArrayLike<number>, q: ArrayLike<number>): number =>
  Math.max(0, Math.min(p[2], q[2]) - Math.max(p[0], q[0])) * Math.max(0, Math.min(p[3], q[3]) - Math.max(p[1], q[1]));
export const area = (b: ArrayLike<number>): number => Math.max(1e-6, (b[2] - b[0]) * (b[3] - b[1]));
export const mid = (g: Seg): Pt => [(g.p1[0] + g.p2[0]) / 2, (g.p1[1] + g.p2[1]) / 2];
export const wid = (g: Seg): number => Math.hypot(g.p1[0] - g.p2[0], g.p1[1] - g.p2[1]);
export const dist = (a: ArrayLike<number>, b: ArrayLike<number>): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** The box a prediction covers: its own, or its line's. */
export const pbox = (g: { box?: Box } & Seg): Box =>
  g.box ?? [Math.min(g.p1[0], g.p2[0]), Math.min(g.p1[1], g.p2[1]), Math.max(g.p1[0], g.p2[0]), Math.max(g.p1[1], g.p2[1])];
/** Distance from a point to a box (0 inside). */
export const dbox = (p: ArrayLike<number>, b: ArrayLike<number>): number => Math.hypot(Math.max(b[0] - p[0], 0, p[0] - b[2]), Math.max(b[1] - p[1], 0, p[1] - b[3]));
/** Distance from a point to a segment. */
export function dseg(p: ArrayLike<number>, g: Seg): number {
  const dx = g.p2[0] - g.p1[0], dy = g.p2[1] - g.p1[1];
  const L = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((p[0] - g.p1[0]) * dx + (p[1] - g.p1[1]) * dy) / L));
  return Math.hypot(p[0] - g.p1[0] - t * dx, p[1] - g.p1[1] - t * dy);
}

/** Round half to even, as numpy does (Math.round rounds halves up). */
export function rint(v: number): number {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** numpy.arange for floats: start, start + step, … below stop. */
export function arange(start: number, stop: number, step: number): number[] {
  const n = Math.max(0, Math.ceil((stop - start) / step));
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = start + i * step;
  return out;
}

/** A detector box's opening line: its centreline along the long side, shortened by pad_ft. */
export function boxSeg(b: ArrayLike<number>, ppf: number, padFt: number): Seg {
  const w = b[2] - b[0], h = b[3] - b[1], cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  const L = Math.max(Math.max(w, h) - padFt * ppf, 0.5 * ppf);
  return w >= h ? { p1: [cx - L / 2, cy], p2: [cx + L / 2, cy] } : { p1: [cx, cy - L / 2], p2: [cx, cy + L / 2] };
}

/** A reader leaf's hinge → closed end: the tip turned about the hinge by the sweep, towards the side inside the door's box. */
export function leafSeg(l: { hinge: Pt; tip: Pt; sweepDeg?: number | null }, box: ArrayLike<number>): Seg {
  const H = l.hinge, vx = l.tip[0] - H[0], vy = l.tip[1] - H[1];
  const th = ((l.sweepDeg || 90) * Math.PI) / 180;
  const c: Pt[] = [1, -1].map((s) => {
    const ca = Math.cos(s * th), sa = Math.sin(s * th);
    return [H[0] + ca * vx - sa * vy, H[1] + sa * vx + ca * vy] as Pt;
  });
  const out = (p: Pt) => Math.max(box[0] - p[0], p[0] - box[2], box[1] - p[1], p[1] - box[3], 0);
  const C = out(c[0]) <= out(c[1]) ? c[0] : c[1];
  return { p1: [H[0], H[1]], p2: C };
}

export const maskAt = (m: Mask, x: number, y: number): boolean => x >= 0 && y >= 0 && x < m.w && y < m.h && m.data[y * m.w + x] === 1;

/**
 * How much ink runs on past both ends of a line: the share of samples in a
 * band beyond each end (a quarter foot to a foot and a quarter out, three
 * tracks) that land on or beside ink. A wall runs on past a jamb line; a leaf
 * ends in open floor. `pxf` = the mask's pixels per foot.
 */
export function inkBeyond(m: Mask, a: ArrayLike<number>, b: ArrayLike<number>, pxf: number): number {
  const ax = a[0] * m.z, ay = a[1] * m.z, bx = b[0] * m.z, by = b[1] * m.z;
  const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
  if (L < 1) return 0;
  const ux = dx / L, uy = dy / L, nx = -uy, ny = ux, k = pxf / 16;
  let hit = 0, tot = 0;
  const ts = arange(0.25 * pxf, 1.25 * pxf, 1.5 * k);
  for (const [ox, oy, s] of [[bx, by, 1], [ax, ay, -1]] as const) {
    for (const t of ts) {
      for (const w of [-2.5 * k, 0, 2.5 * k]) {
        const x = rint(ox + s * ux * t + nx * w), y = rint(oy + s * uy * t + ny * w);
        tot++;
        if (y < 0 || y >= m.h || x < 0 || x >= m.w) continue;
        let any = false;
        for (let yy = Math.max(y - 1, 0); yy <= Math.min(y + 1, m.h - 1) && !any; yy++) {
          for (let xx = Math.max(x - 1, 0); xx <= Math.min(x + 1, m.w - 1); xx++) if (m.data[yy * m.w + xx]) { any = true; break; }
        }
        if (any) hit++;
      }
    }
  }
  return hit / Math.max(tot, 1);
}
