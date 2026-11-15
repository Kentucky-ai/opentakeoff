// Door tags as evidence for the detector's fusion, with no schedule needed.
// A page's own text is searched for door marks (101, 101A, A101.1, D12 …);
// text styles whose members mostly sit beside a door are door-tag styles.
// A tag with no door near it points at a door the reader withheld or a
// detector box below its cutoff; on a sheet whose doors are nearly all
// tagged, an untagged weak prediction is dropped.
// Ported from the Python prototype (tags.py, harness.py stage 4).
import { area, boxSeg, dbox, dist, dseg, inkBeyond, inter, leafSeg, mid, pbox, rint, wid, type Box, type DetBox, type Mask, type Pred, type Pt, type Seg } from "./geom.ts";
import type { FuseDoor } from "./fuse.ts";
import { swingBoxEdge } from "./swingAdd.ts";

/** A line of page text: its string, box (x0, y0, x1, y1), centre and font size, page points. */
export interface TextLine { str: string; box: Box; c: Pt; size: number }
export interface TagCandidate extends TextLine { mark: string; kind: "room" | "symbol" | "plain" }

const MARK = /^[A-Z]{0,2}\d{1,4}[A-Z]{0,2}([.\-/]\d{1,3}[A-Z]?)?$/;
const WORDY = /[A-Z]{3,}/i;
/** 101A → 9A, 112a → 9a, D012 → A9, 105-1 → 9-9 */
const template = (m: string) => m.replace(/\d+/g, "9").replace(/[A-Z]+/g, "A").replace(/[a-z]+/g, "a");

/** room = a wordy line stacked just above (a room-number label); symbol = enclosed by drawn ink on all sides; plain = loose text. */
export function tagKind(t: TextLine, lines: TextLine[], mask: Mask): TagCandidate["kind"] {
  const [x0, y0, x1, y1] = t.box, w = x1 - x0, h = y1 - y0, hh = Math.max(1, Math.min(w, h)), [cx, cy] = t.c, z = mask.z;
  for (const r of lines) {
    if (r === t || !WORDY.test(r.str) || MARK.test(r.str.toUpperCase())) continue;
    const dy = cy - r.c[1], ov = Math.min(r.box[2], x1) - Math.max(r.box[0], x0);
    if (hh * 0.4 < dy && dy < hh * 3.2 && ov > -hh * 0.5) return "room";
  }
  const reach = Math.max(w, h) / 2 + hh * 2.2;
  let hits = 0;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4, dx = Math.cos(a), dy = Math.sin(a);
    const inner = Math.min(Math.abs(dx) > 1e-9 ? w / 2 / Math.abs(dx) : 1e9, Math.abs(dy) > 1e-9 ? h / 2 / Math.abs(dy) : 1e9) * 1.05;
    for (let tt = inner; tt < reach; tt += 0.5 / z) {
      const x = rint((cx + dx * tt) * z), y = rint((cy + dy * tt) * z);
      if (y >= 0 && y < mask.h && x >= 0 && x < mask.w && mask.data[y * mask.w + x]) { hits++; break; }
    }
  }
  return hits >= 7 ? "symbol" : "plain";
}

/** Every text line that reads as a door mark, with its kind. */
export function tagCandidates(lines: TextLine[], mask: Mask, ppf: number): TagCandidate[] {
  const out: TagCandidate[] = [];
  for (const t of lines) {
    const s = t.str.toUpperCase().replace(/ /g, "");
    if (!MARK.test(s) || !(t.size >= 0.5 && t.size <= 3 * ppf)) continue;
    out.push({ ...t, mark: s, kind: tagKind(t, lines, mask) });
  }
  return out;
}

export interface TagParams {
  dup_drop: boolean; near_ft: number; style_share: number; style_min_n: number; style_uniq: number; reach_ft: number;
  orphan_reach_ft: number; det_floor: number; drop_share: number; drop_conf: number; drop_det: boolean; drop_min_tags: number;
  /** a lone tag whose number is already on a door brings nothing in (the same number in a room label, a keynote, a second view) */
  orphan_skip_repeats?: boolean;
}

/**
 * The page's door tags: candidates grouped by text style (size, kind, number
 * pattern); a style is a door-tag style when it has enough members, most sit
 * within near_ft of a predicted door, and most read differently (door numbers
 * do not repeat; wall-type and keynote tags do).
 */
export function doorTags(cands: TagCandidate[], doorBoxes: Box[], ppf: number, P: TagParams): TagCandidate[] {
  const G = new Map<string, TagCandidate[]>(), seen = new Set<string>();
  for (const c of cands) {
    const key = `${c.mark}|${rint(c.c[0] / 3)}|${rint(c.c[1] / 3)}`;   // the same text drawn twice (layers) is one tag
    if (c.kind === "room" || seen.has(key)) continue;
    seen.add(key);
    const style = `${rint(c.size * 2) / 2}|${c.kind}|${template(c.str.replace(/ /g, ""))}`;
    const m = G.get(style);
    if (m) m.push(c); else G.set(style, [c]);
  }
  const tags: TagCandidate[] = [];
  for (const M of G.values()) {
    const near = M.filter((c) => doorBoxes.some((b) => dbox(c.c, b) <= P.near_ft * ppf)).length;
    const uniq = new Set(M.map((c) => c.mark)).size / M.length;
    if (M.length >= P.style_min_n && near / M.length >= P.style_share && uniq >= P.style_uniq) tags.push(...M);
  }
  return tags;
}

export interface TagStageInfo { tags: number; orphanTags: number; pairJoined: number; dupDropped: number; withheldReader: number; detectorBox: number; untaggedDropped: number; tagShare: number | null }
export interface TagStageResult {
  preds: Pred[];
  info: TagStageInfo;
  /** predictions of the input list dropped here: index → why */
  dropped: Record<number, string>;
}

/**
 * The door-tag stage.
 * 1. Each tag takes its nearest prediction within reach_ft (one tag, one opening).
 * 2. Two reader leaves end to end on one tag become one pair.
 * 3. A tag with no prediction brings in a withheld reader door near it, else a detector box (any class but elevator, down to det_floor);
 *    with orphan_skip_repeats, not when its number is already on a door (door numbers do not repeat).
 * 4. On a sheet with at least drop_min_tags tags where at least drop_share of the predictions are tagged, an untagged
 *    prediction is dropped unless it is a reader door of confidence ≥ drop_conf.
 * `mask` is the page's ink, `pxf` its pixels per foot.
 */
export function tagStage(input: Pred[], lines: TextLine[], doors: FuseDoor[], det: DetBox[], ppf: number, P: TagParams, mask: Mask, pxf: number): TagStageResult {
  const pred = input.map((p) => ({ ...p }));
  const info: TagStageInfo = { tags: 0, orphanTags: 0, pairJoined: 0, dupDropped: 0, withheldReader: 0, detectorBox: 0, untaggedDropped: 0, tagShare: null };
  const dropped: Record<number, string> = {};
  const tags = doorTags(tagCandidates(lines, mask, ppf), pred.map(pbox), ppf, P);
  info.tags = tags.length;
  const dpred = (p: Pt, g: Pred) => Math.min(dseg(p, g), dbox(p, pbox(g)));
  const R = P.reach_ft * ppf;
  const cand: Array<[number, number, number]> = [];
  tags.forEach((t, ti) => pred.forEach((p, pi) => { const d = dpred(t.c, p); if (d <= R) cand.push([d, ti, pi]); }));
  cand.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const tagOf = new Map<number, number>(), predOf = new Map<number, number>();
  for (const [, ti, pi] of cand) {
    if (predOf.has(ti) || tagOf.has(pi)) continue;
    predOf.set(ti, pi); tagOf.set(pi, ti);
  }
  const drop = new Set<number>();
  for (const [, ti, pi] of cand) {
    if (tagOf.has(pi) || drop.has(pi) || !predOf.has(ti)) continue;
    const qi = predOf.get(ti)!, q = pred[qi], p = pred[pi];
    const dm = dist(mid(p), mid(q)), wq = wid(q), wp = wid(p);
    if (P.dup_drop && dm <= 0.5 * Math.max(wq, wp)) { drop.add(pi); dropped[pi] = "second line on a tagged opening"; info.dupDropped++; }
    else if (p.src === "reader" && q.src === "reader" && Math.abs(dm - (wq + wp) / 2) <= 0.25 * ppf && Math.abs(wq - wp) <= 0.5 * Math.max(wq, wp)) {
      const u: Pt = [(q.p2[0] - q.p1[0]) / Math.max(wq, 1e-6), (q.p2[1] - q.p1[1]) / Math.max(wq, 1e-6)], v: Pt = [(p.p2[0] - p.p1[0]) / Math.max(wp, 1e-6), (p.p2[1] - p.p1[1]) / Math.max(wp, 1e-6)];
      if (Math.abs(u[0] * v[0] + u[1] * v[1]) > 0.95) {
        const pts = [q.p1, q.p2, p.p1, p.p2];
        let far: [Pt, Pt] = [pts[0], pts[0]], fd = -1;
        for (const a of pts) for (const b of pts) { const d = dist(a, b); if (d > fd) { fd = d; far = [a, b]; } }
        const bq = pbox(q), bp = pbox(p);
        q.p1 = [...far[0]] as Pt; q.p2 = [...far[1]] as Pt;
        q.box = [Math.min(bq[0], bp[0]), Math.min(bq[1], bp[1]), Math.max(bq[2], bp[2]), Math.max(bq[3], bp[3])];
        q.doors = [...(q.doors ?? []), ...(p.doors ?? [])];
        drop.add(pi); dropped[pi] = "joined as a pair"; info.pairJoined++;
      }
    }
  }
  const taken = new Set([...predOf.keys()].map((ti) => tags[ti].mark));
  const orphans = tags.filter((t, ti) => !predOf.has(ti) && !(P.orphan_skip_repeats && taken.has(t.mark)));
  info.orphanTags = orphans.length;
  const fresh: Pred[] = [];
  if (orphans.length) {
    const Ro = P.orphan_reach_ft * ppf, kept = pred.map(pbox);
    const free = (b: ArrayLike<number>) => ![...kept, ...fresh.map(pbox)].some((v) => inter(b, v) > 0.2 * Math.min(area(b), area(v)));
    for (const t of orphans) {
      let got: Pred | null = null;
      let best: { d: number; i: number } | null = null;
      doors.forEach((f, i) => {
        if (!(f.confidence < 0)) return;
        const d = dbox(t.c, f.box);
        if (d <= Ro && free(f.box) && (!best || d < best.d)) best = { d, i };
      });
      if (best) {
        const i = (best as { d: number; i: number }).i, f = doors[i], Lv = f.leaves, l = Lv[0];
        let g: Seg | null = null;
        if (Lv.length === 2) g = { p1: [...Lv[0].hinge] as Pt, p2: [...Lv[1].hinge] as Pt };
        else if (l) {
          const c = leafSeg(l, f.box), tp: Seg = { p1: [...l.hinge] as Pt, p2: [...l.tip] as Pt };
          g = inkBeyond(mask, tp.p1, tp.p2, pxf) > inkBeyond(mask, c.p1, c.p2, pxf) + 0.15 ? tp : c;
        }
        if (g) { got = { ...g, src: "reader", conf: f.confidence, box: [...f.box] as Box, how: "tag-withheld", doors: [i] }; info.withheldReader++; }
      } else {
        const D: Array<[number, DetBox]> = [];
        for (const q of det) {
          if (!(q[4] >= P.det_floor) || q[5] === 5) continue;
          const d = dbox(t.c, q);
          if (d <= Ro && free(q)) D.push([d, q]);
        }
        if (D.length) {
          let pick = D[0];
          for (const x of D) if (x[0] - 0.5 * ppf * x[1][4] < pick[0] - 0.5 * ppf * pick[1][4]) pick = x;
          let b = pick[1], c = b[5];
          const strips = D.filter(([, q]) => (q[5] === 6 || q[5] === 7) && inter(q, b) > 0).map((x) => x[1]);
          if (c === 0 && strips.length) { b = strips[0]; for (const s of strips) if (s[4] > b[4]) b = s; c = b[5]; }
          const g = c === 0 ? swingBoxEdge(b, mask, pxf) : boxSeg(b, ppf, c === 6 || c === 7 ? 0.3 : 0);
          got = { ...g, src: "det", cls: c, box: [b[0], b[1], b[2], b[3]], score: b[4], how: "tag-box" };
          info.detectorBox++;
        }
      }
      if (got) fresh.push(got);
    }
  }
  let keepIdx = pred.map((_, i) => i).filter((i) => !drop.has(i));
  const share = tagOf.size / Math.max(keepIdx.length, 1);
  info.tagShare = Math.round(share * 100) / 100;
  if (tags.length >= P.drop_min_tags && share >= P.drop_share) {
    keepIdx = keepIdx.filter((i) => {
      const p = pred[i];
      if (tagOf.has(i) || (p.src === "reader" && (p.conf ?? 0) >= P.drop_conf) || (p.src === "det" && !P.drop_det)) return true;
      dropped[i] = "no door tag on a sheet whose doors are tagged"; info.untaggedDropped++;
      return false;
    });
  }
  return { preds: [...keepIdx.map((i) => pred[i]), ...fresh], info, dropped };
}
