// Fusion of the door reader with the detector: which reader doors stand,
// which withheld ones the detector brings back, which doorway line a swing
// gets, and which detector boxes are added where the reader found nothing.
// Ported rule for rule from the Python prototype the cutoffs were chosen
// with (r6_fuse.py, pick "strip"); test/doorDetectFuse.test.ts pins it.
import { area, boxSeg, dist, inter, leafSeg, mid, wid, type Box, type DetBox, type Pred, type Pt, type Seg } from "./geom.ts";

/** The part of a reader door the fusion uses (lib/doorReader.ts ReadDoor has all of it). */
export interface FuseDoor {
  box: Box;
  jambLine?: [Pt, Pt] | null;
  confidence: number;
  pair?: boolean;
  stall?: boolean;
  leaves: Array<{ hinge: Pt; tip: Pt; sweepDeg?: number | null; radiusPt?: number }>;
}

export interface FusionParams {
  strip_pick_min: number;
  veto: number;
  veto_any_det: number;
  rescue: number;
  merge: boolean;
  class_minimums: Record<string, number>;
  pads_ft: Record<string, number>;
}

interface Prepared { box: Box; conf: number; segs: Seg[]; sup: number; anyd: number; door: number }

/**
 * Each reader door's doorway line(s) and its detector support.
 * A pair keeps the reader's own hinge-to-hinge line. A single leaf keeps the
 * reader's line unless a doorway strip lies on the door: then, of hinge →
 * closed end and hinge → leaf tip, the one nearer the strip.
 */
export function prepareDoors(doors: FuseDoor[], det: DetBox[], ppf: number, P: FusionParams): Prepared[] {
  const strips = det.filter((q) => (q[5] === 6 || q[5] === 7) && q[4] >= P.strip_pick_min);
  return doors.map((d, door) => {
    const b = d.box, Lv = d.leaves, own = d.jambLine ? { p1: [...d.jambLine[0]] as Pt, p2: [...d.jambLine[1]] as Pt } : null;
    let segs: Seg[] = [];
    if (own && Lv.length !== 1) segs = [own];
    if (!segs.length) {
      for (const l of Lv.length !== 2 ? Lv.slice(0, 1) : Lv) {
        const c = leafSeg(l, b), t: Seg = { p1: [...l.hinge] as Pt, p2: [...l.tip] as Pt };
        const near = strips.filter((q) => inter(b, q) > 0);
        let pk: Seg = own ?? c;
        if (near.length) {
          let q = near[0];
          for (const n of near) if (n[4] > q[4]) q = n;
          const qm = mid(boxSeg(q, ppf, 0.3));
          pk = dist(mid(t), qm) < dist(mid(c), qm) ? t : c;
        }
        segs.push(pk);
      }
    }
    const g2 = 2 * ppf;
    let sup = 0, anyd = 0;
    for (const q of det) {
      if ((q[5] === 0 || q[5] === 7) && inter(b, q) > 0.2 * Math.min(area(b), area(q)) && q[4] > sup) sup = q[4];
      if (q[0] < b[2] + g2 && q[2] > b[0] - g2 && q[1] < b[3] + g2 && q[3] > b[1] - g2 && q[4] > anyd) anyd = q[4];
    }
    return { box: [b[0], b[1], b[2], b[3]] as Box, conf: d.confidence, segs, sup, anyd, door };
  });
}

export interface FuseStats { rescued: number; vetoed: number; dup: number; pairMerged: number; added: number }
export interface FuseResult {
  preds: Pred[];
  stats: FuseStats;
  /** reader door index → why it is not in preds ("withheld", "vetoed", "duplicate of door N") */
  out: Record<number, string>;
}

/**
 * The fused predictions for one sheet.
 * - A withheld reader door (confidence below 0) comes back when a swing box or doorway strip of score ≥ rescue sits on it.
 * - A weak reader door (confidence below veto) with no detector box of score ≥ veto_any_det within 2 ft is dropped.
 * - Two reader lines on one opening are one; two single leaves meeting at their closed ends are one pair.
 * - A detector box at or above its class minimum is added where no reader door is: not overlapping one by more than
 *   20% of the smaller box, and its centre not within 1 ft of one. Classes with no minimum (pocket, elevator) are never added.
 */
export function fuseSheet(doors: FuseDoor[], det: DetBox[], ppf: number, P: FusionParams): FuseResult {
  const prep = prepareDoors(doors, det, ppf, P);
  const stats: FuseStats = { rescued: 0, vetoed: 0, dup: 0, pairMerged: 0, added: 0 };
  const out: Record<number, string> = {};
  const kept: Prepared[] = [];
  for (const d of prep) {
    if (d.conf < 0) {
      if (P.rescue && d.sup >= P.rescue) { kept.push(d); stats.rescued++; }
      else out[d.door] = "withheld";
      continue;
    }
    if (P.veto && d.conf < P.veto && d.anyd < P.veto_any_det) { stats.vetoed++; out[d.door] = "vetoed"; continue; }
    kept.push(d);
  }
  let segs: Pred[] = [];
  for (const d of kept) for (const g of d.segs) segs.push({ p1: g.p1, p2: g.p2, src: "reader", conf: d.conf, box: [...d.box] as Box, doors: [d.door] });
  if (P.merge) {
    segs = segs.map((g, i) => [g, i] as const).sort((a, b) => b[0].conf! - a[0].conf! || a[1] - b[1]).map((x) => x[0]);
    let o2: Pred[] = [];
    for (const g of segs) {
      const twin = o2.find((o) => dist(mid(g), mid(o)) <= Math.max(0.5 * ppf, 0.25 * Math.max(wid(g), wid(o))) && Math.abs(wid(g) - wid(o)) <= 0.3 * Math.max(wid(g), wid(o)));
      if (twin) {
        stats.dup++;
        for (const k of g.doors!) if (!twin.doors!.includes(k)) out[k] = `duplicate of door ${twin.doors![0]}`;
        continue;
      }
      o2.push(g);
    }
    segs = o2; o2 = [];
    const used = new Set<number>();
    for (let i = 0; i < segs.length; i++) {
      if (used.has(i)) continue;
      let g = segs[i];
      for (let j = i + 1; j < segs.length; j++) {
        if (used.has(j)) continue;
        const h = segs[j];
        const wg = Math.max(wid(g), 1e-6), wh = Math.max(wid(h), 1e-6);
        const u1: Pt = [(g.p2[0] - g.p1[0]) / wg, (g.p2[1] - g.p1[1]) / wg], u2: Pt = [(h.p2[0] - h.p1[0]) / wh, (h.p2[1] - h.p1[1]) / wh];
        if (dist(g.p2, h.p2) <= 0.5 * ppf && u1[0] * u2[0] + u1[1] * u2[1] < -0.9 && Math.abs(wid(g) - wid(h)) <= 0.5 * Math.max(wid(g), wid(h))) {
          used.add(j);
          g = { ...g, p2: [...h.p1] as Pt, box: [Math.min(g.box[0], h.box[0]), Math.min(g.box[1], h.box[1]), Math.max(g.box[2], h.box[2]), Math.max(g.box[3], h.box[3])], doors: [...g.doors!, ...h.doors!] };
          stats.pairMerged++;
          break;
        }
      }
      o2.push(g);
    }
    segs = o2;
  }
  const vec = kept.map((d) => d.box);
  const add: DetBox[] = [];
  const g = ppf;
  const order = det.map((b, i) => [b, i] as const).sort((a, b) => b[0][4] - a[0][4] || a[1] - b[1]).map((x) => x[0]);
  for (const b of order) {
    const c = b[5], min = P.class_minimums[String(c)];
    if (min === undefined || b[4] < min) continue;
    const ar = area(b), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    if (vec.some((v) => inter(b, v) > 0.2 * Math.min(ar, area(v)) || (v[0] - g <= cx && cx <= v[2] + g && v[1] - g <= cy && cy <= v[3] + g))) continue;
    if (add.some((q) => inter(b, q) > 0.3 * Math.min(ar, area(q)))) continue;
    add.push(b);
    segs.push({ ...boxSeg(b, ppf, P.pads_ft[String(c)] ?? 0), src: "det", cls: c, box: [b[0], b[1], b[2], b[3]], score: b[4] });
    stats.added++;
  }
  return { preds: segs, stats, out };
}
