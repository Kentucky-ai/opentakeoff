// Swing doors the reader has no door for, added from the detector's swing
// boxes (class 0) after the fusion. Each gets a doorway line fitted to its
// ink (swingfit.ts); where the fit fails, a very confident box falls back to
// its doorway strip's centreline or the box edge with the most wall past it.
// Ported from the Python prototype (swingadd4.py, mode "fitstrip").
import { area, boxSeg, dist, inkBeyond, inter, mid, pbox, type Box, type DetBox, type Mask, type Pred, type Pt, type Seg } from "./geom.ts";
import type { SwingFit } from "./swingfit.ts";

export interface SwingBoxParams { min: number; strip_min: number; arc_sweep_deg: [number, number] | number[]; margin: number; fallback: number }

/** A swing ink box has the wall along one of its edges: the edge with the most ink running on past its ends. */
export function swingBoxEdge(b: ArrayLike<number>, mask: Mask, pxf: number): Seg {
  const [x0, y0, x1, y1] = [b[0], b[1], b[2], b[3]];
  const E: Array<[Pt, Pt]> = [[[x0, y0], [x1, y0]], [[x0, y1], [x1, y1]], [[x0, y0], [x0, y1]], [[x1, y0], [x1, y1]]];
  let best = E[0], bv = -1;
  for (const e of E) { const v = inkBeyond(mask, e[0], e[1], pxf); if (v > bv) { bv = v; best = e; } }
  return { p1: best[0], p2: best[1] };
}

function fitLine(r: SwingFit, strips: DetBox[], margin: number): [Seg | null, string] {
  if (!r.seg) return [null, "nofit"];
  if (r.kind === "pair") return [r.seg, "fit-pair"];
  const c: Seg = { p1: r.hinge!, p2: r.closed! }, t: Seg = { p1: r.hinge!, p2: r.tip! };
  if (strips.length) {
    let q = strips[0];
    for (const s of strips) if (s[4] > q[4]) q = s;
    const qm: Pt = [(q[0] + q[2]) / 2, (q[1] + q[3]) / 2];
    return dist(mid(t), qm) < dist(mid(c), qm) ? [t, "fit-tip/strip"] : [c, "fit-closed/strip"];
  }
  return r.inkT! > r.inkC! + margin ? [t, "fit-tip/ink"] : [c, "fit-closed/ink"];
}

/**
 * Add swing boxes of score ≥ P.min where no prediction is yet.
 * `fitFor` fits one box (it may render a clip, so it can be async);
 * `edgeMask` gives the page's ink for the box-edge fallback.
 */
export async function addSwingBoxes(
  preds: Pred[], det: DetBox[], ppf: number, P: SwingBoxParams,
  fitFor: (b: DetBox) => SwingFit | null | Promise<SwingFit | null>,
  edgeMask: (() => { mask: Mask; pxf: number } | Promise<{ mask: Mask; pxf: number }>) | null,
): Promise<Pred[]> {
  const out: Pred[] = [...preds], boxes: Box[] = preds.map(pbox);
  const n0 = preds.length;
  const cand = det.map((b, i) => [b, i] as const).filter(([b]) => b[5] === 0 && b[4] >= P.min).sort((a, b) => b[0][4] - a[0][4] || a[1] - b[1]).map((x) => x[0]);
  for (const b of cand) {
    const ar = area(b), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    if (boxes.some((v) => inter(b, v) > 0.2 * Math.min(ar, area(v)) || (v[0] <= cx && cx <= v[2] && v[1] <= cy && cy <= v[3]))) continue;
    const strips = det.filter((q) => (q[5] === 6 || q[5] === 7) && q[4] >= P.strip_min && inter(b, q) > 0.3 * area(q));
    const r = await fitFor(b);
    let seg: Seg | null = null, how = "";
    if (r && r.seg && (r.deg ?? 0) >= P.arc_sweep_deg[0] && (r.deg ?? 0) <= P.arc_sweep_deg[1]) [seg, how] = fitLine(r, strips, P.margin);
    if (!seg && b[4] >= P.fallback) {
      if (strips.length) {
        let q = strips[0];
        for (const s of strips) if (s[4] > q[4]) q = s;
        seg = boxSeg(q, ppf, 0.3); how = "strip";
      } else if (edgeMask) {
        const { mask, pxf } = await edgeMask();
        seg = swingBoxEdge(b, mask, pxf); how = "edge";
      }
    }
    if (!seg) continue;
    const single = r && how.startsWith("fit") && r.kind === "single";
    out.push({
      ...seg, src: "det", cls: 0, box: [b[0], b[1], b[2], b[3]], score: b[4], how: "swingbox-" + how,
      fit: single ? { hinge: r.hinge!, tip: r.tip!, closed: r.closed!, rFt: r.rFt! } : null,
    });
    boxes.push([b[0], b[1], b[2], b[3]]);
  }
  // two added leaves whose closed ends meet, hinges a leaf-plus-leaf apart: one pair, hinge to hinge
  const used = new Set<number>(), res = out.slice(0, n0);
  for (let i = n0; i < out.length; i++) {
    if (used.has(i)) continue;
    let p = out[i];
    const fi = p.fit;
    for (let j = i + 1; j < out.length; j++) {
      const q = out[j], fj = q.fit;
      if (used.has(j) || !fi || !fj) continue;
      const r1 = fi.rFt * ppf, r2 = fj.rFt * ppf, d = dist(fi.hinge, fj.hinge);
      let ends = Infinity;
      for (const a of [fi.closed, fi.tip]) for (const c of [fj.closed, fj.tip]) ends = Math.min(ends, dist(a, c));
      if (Math.abs(d - (r1 + r2)) <= 0.25 * (r1 + r2) && ends <= 0.35 * Math.max(r1, r2) && Math.abs(r1 - r2) <= 0.5 * Math.max(r1, r2)) {
        used.add(j);
        p = { ...p, p1: fi.hinge, p2: fj.hinge, box: [Math.min(p.box[0], q.box[0]), Math.min(p.box[1], q.box[1]), Math.max(p.box[2], q.box[2]), Math.max(p.box[3], q.box[3])], how: "swingbox-fit-pairjoin", fit: null, pairFit: [fi, fj] } as Pred;
        break;
      }
    }
    res.push(p);
  }
  return res;
}
