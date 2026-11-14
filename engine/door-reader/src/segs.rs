//! The page's straight segments, indexed for the questions the keep rule asks around an arc: is there a leaf from its hinge, a
//! wall behind it, a thin toilet partition at it.

use crate::geom::{angles, dist, Arc, Item, Path, P};
use std::cell::RefCell;
use crate::geom::Map as HashMap;

const LEAF_HINGE_R: f64 = 0.15; // the leaf starts this close to the hinge (share of the radius)
const LEAF_LEN_R: (f64, f64) = (0.7, 1.2); // and is about one radius long
const LEAF_TIP_R: f64 = 0.2; // its far end sits on an arc end
/// With strokes from the hinge to both arc ends, the leaf is the one with no wall running on behind the hinge.
const LEAF_PICK_BY_WALL: bool = true;
const LEAFLESS_SWEEP: (f64, f64) = (80.0, 100.0);
const LEAFLESS_REACH_R: f64 = 0.3;
const LEAFLESS_RUN_R: f64 = 0.2;
const LEAFLESS_MISFIT: (f64, f64) = (0.003, 0.02);
const DASH_OFF_R: f64 = 0.08;
const DASH_SPAN_R: (f64, f64) = (-0.15, 1.25);
const DASH_MAX_R: f64 = 0.6;
const DASH_MIN: usize = 3;
const DASH_COVER_R: f64 = 0.5;
const DASH_ENDS_R: (f64, f64) = (0.25, 0.75);
const DASH_EVEN: f64 = 0.2;
const DASH_SHARE: f64 = 0.55;
const PANEL_FT: (f64, f64) = (0.03, 0.2);
const PANEL_LEN_FT: (f64, f64) = (2.5, 7.5);
const PANEL_REACH_FT: f64 = 0.6;
const PANEL_WALL_FT: f64 = 0.6;
const WALL_PARTITION_FT: (f64, f64) = (0.35, 4.0);
const PANEL_LEN_R: f64 = 1.25;
const CLIP_LEN_R: (f64, f64) = (0.85, 1.15);
const CLIP_GAP_DEG: f64 = 35.0;
const CLIP_TURN_DEG: (f64, f64) = (82.0, 98.0);
const JAMB_REACH_FT: f64 = 3.0;
// the jamb-line test: probes from 3 to 15 in past each end of a candidate line, on it and 2 in to either side; linework within 1.1 in counts
const JAMB_PROBE_FT: (f64, f64) = (0.25, 1.25);
const JAMB_PROBE_STEPS: usize = 11;
const JAMB_PROBE_SIDE_FT: f64 = 0.156;
const JAMB_PROBE_TOL_FT: f64 = 0.09;
const BOX_CELL: f64 = 40.0;
const BOX_CELLS_MAX: i64 = 400;
const END_CELL: f64 = 40.0;
/// Arcless doors (a solid leaf plus a dashed chord): how near the jamb ends the wall lines must end, their least length, the chord's
/// dashes' offset from its line, their count, longest dash, the share of the chord they cover, how near its ends they reach.
const CHORD_JAMB_R: f64 = 0.12;
const CHORD_WALL_MIN_R: f64 = 0.3;
const CHORD_OFF_R: f64 = 0.04;
const CHORD_DASHES: usize = 2;
const CHORD_DASH_MAX: f64 = 0.45;
const CHORD_PAST_R: f64 = 0.08;
const CHORD_COVER: (f64, f64) = (0.3, 0.92);
const CHORD_ENDS_R: f64 = 0.15;
/// The leaf's tip is free: nothing lies on its line this share of it past the tip. This many strokes parallel to the chord within this share of its
/// length beside it make it a hatch.
const CHORD_TIP_FREE_R: f64 = 0.3;
const CHORD_HATCH_R: f64 = 0.3;
const CHORD_HATCH_MIN: usize = 2;
pub const COARSE_LEAF_R: (f64, f64) = (0.08, 0.08);
pub const COARSE_JAMB_R: (f64, f64) = (0.08, 0.1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Partition {
    No,
    Line,
    Wall,
    Panel,
}

pub struct Segments {
    a: Vec<[f64; 4]>,
    d: Vec<P>,
    len: Vec<f64>,
    styled: Vec<bool>,
    any_styled: bool,
    ends: HashMap<(i64, i64), Vec<(u32, bool)>>,
    boxes: HashMap<(i64, i64), Vec<u32>>,
    wide: Vec<u32>,
    leaves: RefCell<HashMap<[u64; 8], Option<P>>>,
    stamp: RefCell<(Vec<u32>, u32)>,
}

fn cell(v: f64, size: f64) -> i64 {
    (v / size).floor() as i64
}

impl Segments {
    pub fn new(paths: &[Path]) -> Segments {
        let mut a = vec![];
        let mut styled = vec![];
        for p in paths {
            for it in &p.items {
                match *it {
                    Item::Line(s, e) | Item::Edge(s, e) => {
                        a.push([s.x, s.y, e.x, e.y]);
                        styled.push(p.dashed);
                    }
                    Item::Curve(..) => {}
                }
            }
        }
        let d: Vec<P> = a.iter().map(|s| P::new(s[2] - s[0], s[3] - s[1])).collect();
        let len: Vec<f64> = d.iter().map(|v| v.norm() + 1e-9).collect();
        let mut ends: HashMap<(i64, i64), Vec<(u32, bool)>> = HashMap::default();
        for (k, s) in a.iter().enumerate() {
            ends.entry((cell(s[0], END_CELL), cell(s[1], END_CELL))).or_default().push((k as u32, false));
            ends.entry((cell(s[2], END_CELL), cell(s[3], END_CELL))).or_default().push((k as u32, true));
        }
        let mut boxes: HashMap<(i64, i64), Vec<u32>> = HashMap::default();
        let mut wide = vec![];
        for (k, s) in a.iter().enumerate() {
            let (x0, y0) = (cell(s[0].min(s[2]), BOX_CELL), cell(s[1].min(s[3]), BOX_CELL));
            let (x1, y1) = (cell(s[0].max(s[2]), BOX_CELL), cell(s[1].max(s[3]), BOX_CELL));
            if (x1 - x0 + 1) * (y1 - y0 + 1) > BOX_CELLS_MAX {
                wide.push(k as u32);
                continue;
            }
            for x in x0..=x1 {
                for y in y0..=y1 {
                    boxes.entry((x, y)).or_default().push(k as u32);
                }
            }
        }
        let n = a.len();
        let any_styled = styled.iter().any(|s| *s);
        Segments { a, d, len, styled, any_styled, ends, boxes, wide, leaves: RefCell::new(HashMap::default()), stamp: RefCell::new((vec![0; n], 0)) }
    }

    /// Segments with an end within reach of p: (index, that end, the other end), cell by cell.
    fn ends_near(&self, p: P, reach: f64, mut f: impl FnMut(usize, P, P) -> bool) -> bool {
        let span = (reach / END_CELL).floor() as i64 + 1;
        let (cx, cy) = (cell(p.x, END_CELL), cell(p.y, END_CELL));
        for x in cx - span..=cx + span {
            for y in cy - span..=cy + span {
                if let Some(list) = self.ends.get(&(x, y)) {
                    for &(k, is_end) in list {
                        let s = self.a[k as usize];
                        let (near, far) = if is_end { (P::new(s[2], s[3]), P::new(s[0], s[1])) } else { (P::new(s[0], s[1]), P::new(s[2], s[3])) };
                        if dist(near, p) <= reach && f(k as usize, near, far) {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    /// Indices of the segments whose bounding box comes within reach of p (a page-spanning line is always among them).
    fn around(&self, p: P, reach: f64) -> Vec<usize> {
        let mut st = self.stamp.borrow_mut();
        st.1 += 1;
        let tag = st.1;
        let mut out: Vec<usize> = vec![];
        for &k in &self.wide {
            if st.0[k as usize] != tag {
                st.0[k as usize] = tag;
                out.push(k as usize);
            }
        }
        let (x0, y0) = (cell(p.x - reach, BOX_CELL), cell(p.y - reach, BOX_CELL));
        let (x1, y1) = (cell(p.x + reach, BOX_CELL), cell(p.y + reach, BOX_CELL));
        for x in x0..=x1 {
            for y in y0..=y1 {
                if let Some(list) = self.boxes.get(&(x, y)) {
                    for &k in list {
                        if st.0[k as usize] != tag {
                            st.0[k as usize] = tag;
                            out.push(k as usize);
                        }
                    }
                }
            }
        }
        out.sort_unstable();
        out
    }

    /// The far end of the drawn leaf: a stroke from the hinge about one radius long ending on an arc end (or, where a wall cut the
    /// swing short, just past it). Memoised per arc.
    pub fn leaf(&self, a: &Arc) -> Option<P> {
        let key = [a.hinge.x.to_bits(), a.hinge.y.to_bits(), a.r.to_bits(), a.ends[0].x.to_bits(), a.ends[0].y.to_bits(), a.ends[1].x.to_bits(), a.ends[1].y.to_bits(), a.sweep.to_bits()];
        if let Some(got) = self.leaves.borrow().get(&key) {
            return *got;
        }
        let got = self.leaf_uncached(a);
        self.leaves.borrow_mut().insert(key, got);
        got
    }

    fn leaf_uncached(&self, a: &Arc) -> Option<P> {
        let r = a.r;
        let mut clipped = None;
        // the first stroke found toward each arc end: a door drawn at a corner has a wall line from its hinge to its closed end
        // too (the header across the opening), as long as the leaf and ending on the arc
        let mut toward: [Option<P>; 2] = [None, None];
        let mut first: Option<usize> = None;
        self.ends_near(a.hinge, LEAF_HINGE_R * r, |k, _near, far| {
            let l = self.len[k];
            if !(LEAF_LEN_R.0 * r..=LEAF_LEN_R.1 * r).contains(&l) {
                return false;
            }
            let (d0, d1) = (dist(far, a.ends[0]), dist(far, a.ends[1]));
            if d0.min(d1) < LEAF_TIP_R * r {
                let e = if d0 <= d1 { 0 } else { 1 };
                if toward[e].is_none() {
                    toward[e] = Some(far);
                    first.get_or_insert(e);
                }
                return toward[0].is_some() && toward[1].is_some();
            }
            if clipped.is_none() && (CLIP_LEN_R.0 * r..=CLIP_LEN_R.1 * r).contains(&l) && clipped_swing(a, far) {
                clipped = Some(far);
            }
            false
        });
        match (toward[0], toward[1]) {
            (Some(p0), Some(p1)) if LEAF_PICK_BY_WALL => {
                // the leaf stands off the wall; the header lies along it, the wall running on behind the hinge
                let (w0, w1) = (self.wall_behind(a.hinge, p0, r), self.wall_behind(a.hinge, p1, r));
                if w0 && !w1 {
                    Some(p1)
                } else if w1 && !w0 {
                    Some(p0)
                } else {
                    toward[first.unwrap()]
                }
            }
            _ => first.and_then(|e| toward[e]).or(clipped),
        }
    }

    /// A wall line runs on from the hinge away from `tip`, along the hinge-to-tip line (past a fifth of the radius behind it).
    fn wall_behind(&self, h: P, tip: P, r: f64) -> bool {
        let v = tip.sub(h);
        let n = v.norm();
        if n <= 0.0 {
            return false;
        }
        let u = P::new(v.x / n, v.y / n);
        let n = P::new(-u.y, u.x);
        self.ends_near(h, LEAFLESS_REACH_R * r, |k, near, far| {
            self.d[k].dot(u).abs() >= 0.97 * self.len[k]
                && self.len[k] >= 0.5 * r
                && near.sub(h).dot(n).abs() <= 0.2 * r
                && far.sub(h).dot(u) < -LEAFLESS_RUN_R * r
        })
    }

    /// The leaf found from the hinge to `far` is stroked with a dash pattern.
    pub fn leaf_styled(&self, a: &Arc, far: P) -> bool {
        if !self.any_styled {
            return false;
        }
        let mut out = false;
        self.ends_near(a.hinge, LEAF_HINGE_R * a.r, |k, _near, other| {
            if dist(other, far) < 1e-6 {
                out = self.styled[k];
                return true;
            }
            false
        });
        out
    }

    /// A dashed leaf: short strokes of one length in a line from the hinge out to one end of the arc, with no line running on
    /// through the hinge or past the arc. Returns that arc end.
    pub fn dashed_leaf(&self, a: &Arc) -> Option<P> {
        let h = a.hinge;
        let r = a.r;
        let ks = self.around(h, (DASH_SPAN_R.1 + 0.1) * r);
        if ks.is_empty() {
            return None;
        }
        let tol = DASH_OFF_R * r;
        for e in a.ends {
            let v = e.sub(h);
            let nv = v.norm();
            let nv = if nv > 0.0 { nv } else { 1.0 };
            let u = P::new(v.x / nv, v.y / nv);
            let n = P::new(-u.y, u.x);
            let mut on: Vec<(f64, f64, f64)> = vec![]; // (lo, hi, len)
            let mut bad = false;
            for &k in &ks {
                let s = self.a[k];
                let (p0, p1) = (P::new(s[0], s[1]), P::new(s[2], s[3]));
                let (t0, t1) = (p0.sub(h).dot(u), p1.sub(h).dot(u));
                let (lo, hi) = (t0.min(t1), t0.max(t1));
                let ln = self.len[k];
                let hit = self.d[k].dot(u).abs() >= 0.97 * ln
                    && p0.sub(h).dot(n).abs() <= tol
                    && p1.sub(h).dot(n).abs() <= tol
                    && hi > DASH_SPAN_R.0 * r
                    && lo < DASH_SPAN_R.1 * r;
                if hit {
                    if lo < DASH_SPAN_R.0 * r || hi > DASH_SPAN_R.1 * r || ln > DASH_MAX_R * r {
                        bad = true;
                    }
                    on.push((lo, hi, ln));
                }
            }
            if on.len() < DASH_MIN || bad {
                continue;
            }
            let total: f64 = on.iter().map(|x| x.2).sum();
            let mut best_share = 0.0f64;
            let mut best_count = 0usize;
            for i in 0..on.len() {
                let (mut share, mut count) = (0.0, 0usize);
                for j in 0..on.len() {
                    if (on[i].2 - on[j].2).abs() <= DASH_EVEN * on[i].2 {
                        share += on[j].2;
                        count += 1;
                    }
                }
                best_share = best_share.max(share / total);
                best_count = best_count.max(count);
            }
            if best_share < DASH_SHARE || best_count < 2 {
                continue;
            }
            let mut spans: Vec<(f64, f64)> = on.iter().map(|x| (x.0.clamp(0.0, r), x.1.clamp(0.0, r))).collect();
            spans.sort_by(|p, q| p.partial_cmp(q).unwrap());
            let (mut cover, mut reach) = (0.0, 0.0);
            for &(x0, x1) in &spans {
                let x0 = x0.max(reach);
                if x1 > x0 {
                    cover += x1 - x0;
                    reach = x1;
                }
            }
            let far_most = spans.iter().map(|s| s.1).fold(f64::NEG_INFINITY, f64::max);
            if cover >= DASH_COVER_R * r && spans[0].0 <= DASH_ENDS_R.0 * r && far_most >= DASH_ENDS_R.1 * r {
                return Some(e);
            }
        }
        None
    }

    /// A swing drawn with no leaf: a quarter arc spanning a wall opening, the wall running on from behind the hinge and on from the
    /// arc's closed end. Returns the open end.
    pub fn opening(&self, a: &Arc) -> Option<P> {
        if !(LEAFLESS_SWEEP.0..=LEAFLESS_SWEEP.1).contains(&a.sweep) || a.misfit > LEAFLESS_MISFIT.0 * a.r + LEAFLESS_MISFIT.1 {
            return None;
        }
        let (h, r) = (a.hinge, a.r);
        let reach = LEAFLESS_REACH_R * r;
        for (closed, open) in [(a.ends[0], a.ends[1]), (a.ends[1], a.ends[0])] {
            let u = P::new((closed.x - h.x) / r, (closed.y - h.y) / r);
            let wall = |p: P, beyond: &dyn Fn(f64) -> bool| {
                self.ends_near(p, reach, |k, _near, far| {
                    if self.d[k].dot(u).abs() < 0.97 * self.len[k] {
                        return false;
                    }
                    beyond(far.sub(h).dot(u))
                })
            };
            if wall(h, &|t| t < -LEAFLESS_RUN_R * r) && wall(closed, &|t| t > (1.0 + LEAFLESS_RUN_R) * r) {
                return Some(open);
            }
        }
        None
    }

    /// Doors drawn with no arc: a solid leaf standing open square off a wall gap, and a dashed straight line (the swing's chord)
    /// from the far jamb to the leaf's tip. Leaves `lo..=hi` points long; returns (hinge, strike jamb, leaf tip) per find.
    pub fn chord_doors(&self, lo: f64, hi: f64) -> Vec<(P, P, P)> {
        let mut out: Vec<(P, P, P)> = vec![];
        for k in 0..self.a.len() {
            let w = self.len[k];
            if !(lo..=hi).contains(&w) || self.styled[k] {
                continue;
            }
            let s = self.a[k];
            let (p0, p1) = (P::new(s[0], s[1]), P::new(s[2], s[3]));
            for (h, t) in [(p0, p1), (p1, p0)] {
                let u = P::new((t.x - h.x) / w, (t.y - h.y) / w);
                for sg in [1.0, -1.0] {
                    let n = P::new(-u.y * sg, u.x * sg); // hinge -> strike, along the wall
                    let st = P::new(h.x + w * n.x, h.y + w * n.y);
                    // the wall runs on behind the hinge and on past the strike jamb, along the opening
                    let wall = |p: P, beyond: &dyn Fn(f64) -> bool| {
                        self.ends_near(p, CHORD_JAMB_R * w, |j, _near, far| {
                            self.d[j].dot(n).abs() >= 0.97 * self.len[j] && self.len[j] >= CHORD_WALL_MIN_R * w && beyond(far.sub(h).dot(n))
                        })
                    };
                    if !wall(h, &|x| x < -LEAFLESS_RUN_R * w) || !wall(st, &|x| x > (1.0 + LEAFLESS_RUN_R) * w) {
                        continue;
                    }
                    // the leaf ends in the room: no line runs on along it past its tip (a wall face read as a leaf does)
                    let past = P::new(t.x + CHORD_TIP_FREE_R * w * u.x, t.y + CHORD_TIP_FREE_R * w * u.y);
                    if self.covered(t, past, CHORD_OFF_R * w) > 0.0 {
                        continue;
                    }
                    // the gap is no figure's side: no one stroke runs from hinge to strike jamb (a line running on through
                    // the opening is a boundary drawn over it and is fine)
                    let tol = CHORD_JAMB_R * w;
                    let side = self.ends_near(h, tol, |_j, _near, far| dist(far, st) <= tol);
                    // and nothing stands square off the leaf at its tip (a box's corner)
                    let corner = self.ends_near(t, tol, |j, _near, _far| self.len[j] >= CHORD_WALL_MIN_R * w && self.d[j].dot(u).abs() <= 0.26 * self.len[j]);
                    if side || corner {
                        continue;
                    }
                    if self.dashed_between(st, t) {
                        out.push((h, st, t));
                    }
                }
            }
        }
        out
    }

    /// How much of the line from `a` to `b` (between a tenth and nine tenths along) strokes lying on it cover.
    pub fn covered(&self, a: P, b: P, tol: f64) -> f64 {
        let v = b.sub(a);
        let l = v.norm();
        if l <= 0.0 {
            return 0.0;
        }
        let u = P::new(v.x / l, v.y / l);
        let n = P::new(-u.y, u.x);
        let mid = P::new((a.x + b.x) / 2.0, (a.y + b.y) / 2.0);
        let mut spans: Vec<(f64, f64)> = vec![];
        for k in self.around(mid, 0.6 * l) {
            let s = self.a[k];
            let (p0, p1) = (P::new(s[0], s[1]), P::new(s[2], s[3]));
            if self.d[k].dot(u).abs() < 0.97 * self.len[k] || p0.sub(a).dot(n).abs() > tol || p1.sub(a).dot(n).abs() > tol {
                continue;
            }
            let (t0, t1) = (p0.sub(a).dot(u), p1.sub(a).dot(u));
            let (x0, x1) = (t0.min(t1).max(0.1 * l), t0.max(t1).min(0.9 * l));
            if x1 > x0 {
                spans.push((x0, x1));
            }
        }
        spans.sort_by(|p, q| p.partial_cmp(q).unwrap());
        let (mut cover, mut reach) = (0.0, 0.0f64);
        for &(x0, x1) in &spans {
            let x0 = x0.max(reach);
            if x1 > x0 {
                cover += x1 - x0;
                reach = x1;
            }
        }
        cover
    }

    /// Short strokes in a line from `a` to `b` with gaps between them: a dashed line, no solid run along it.
    pub fn dashed_between(&self, a: P, b: P) -> bool {
        let v = b.sub(a);
        let l = v.norm();
        if l <= 0.0 {
            return false;
        }
        let u = P::new(v.x / l, v.y / l);
        let n = P::new(-u.y, u.x);
        let mid = P::new((a.x + b.x) / 2.0, (a.y + b.y) / 2.0);
        let tol = CHORD_OFF_R * l;
        let mut spans: Vec<(f64, f64)> = vec![];
        let mut beside = 0usize;
        for k in self.around(mid, 0.6 * l) {
            let s = self.a[k];
            let (p0, p1) = (P::new(s[0], s[1]), P::new(s[2], s[3]));
            if self.d[k].dot(u).abs() < 0.97 * self.len[k] {
                continue;
            }
            let (t0, t1) = (p0.sub(a).dot(u), p1.sub(a).dot(u));
            let (x0, x1) = (t0.min(t1), t0.max(t1));
            let (o0, o1) = (p0.sub(a).dot(n).abs(), p1.sub(a).dot(n).abs());
            if o0 > tol || o1 > tol {
                // short strokes parallel to the chord just beside it, over its span: a hatch, not a dashed line (a hatch of long lines
                // across a whole area is the room's, drawn over the door)
                if o0.min(o1) <= CHORD_HATCH_R * l && x1 > 0.1 * l && x0 < 0.9 * l && self.len[k] <= l {
                    beside += 1;
                }
                continue;
            }
            if x1 < -tol || x0 > l + tol {
                continue;
            }
            if self.len[k] > CHORD_DASH_MAX * l || x0 < -CHORD_PAST_R * l || x1 > (1.0 + CHORD_PAST_R) * l {
                return false; // a solid line along it, or one running on past it
            }
            spans.push((x0.max(0.0), x1.min(l)));
        }
        if spans.len() < CHORD_DASHES || beside >= CHORD_HATCH_MIN {
            return false;
        }
        spans.sort_by(|p, q| p.partial_cmp(q).unwrap());
        let (mut cover, mut reach) = (0.0, 0.0f64);
        for &(x0, x1) in &spans {
            let x0 = x0.max(reach);
            if x1 > x0 {
                cover += x1 - x0;
                reach = x1;
            }
        }
        let first = spans[0].0;
        let last = spans.iter().map(|s| s.1).fold(f64::NEG_INFINITY, f64::max);
        (CHORD_COVER.0 * l..=CHORD_COVER.1 * l).contains(&cover) && first <= CHORD_ENDS_R * l && last >= (1.0 - CHORD_ENDS_R) * l
    }

    /// A stroke from the hinge, of the radius to within 8%, ending on `end` to within 8% of the radius (a coarse arc's leaf).
    pub fn leaf_to(&self, a: &Arc, end: P) -> Option<P> {
        let r = a.r;
        let mut got = None;
        self.ends_near(a.hinge, LEAF_HINGE_R * r, |k, _near, far| {
            if (self.len[k] - r).abs() <= COARSE_LEAF_R.0 * r && dist(far, end) <= COARSE_LEAF_R.1 * r {
                got = Some(far);
                return true;
            }
            false
        });
        got
    }

    /// A wall runs on from the swing's closed end, away from the hinge along the closed leaf.
    pub fn wall_beyond(&self, a: &Arc, closed: P) -> bool {
        let (h, r) = (a.hinge, a.r);
        let u = P::new((closed.x - h.x) / r, (closed.y - h.y) / r);
        self.ends_near(closed, COARSE_JAMB_R.0 * r, |k, _near, far| {
            if self.d[k].dot(u).abs() < 0.97 * self.len[k] {
                return false;
            }
            far.sub(h).dot(u) > (1.0 + COARSE_JAMB_R.1) * r
        })
    }

    /// Share of probe points with linework on them, just past both ends of the line from `a` to `b`: a wall runs on beyond a
    /// jamb line's ends; a leaf ends in open floor. Probes sit 3 to 15 in out along the line, on it and 2 in to either side.
    pub fn ink_beyond(&self, a: P, b: P, fpp: f64) -> f64 {
        let ft = 1.0 / fpp;
        let v = b.sub(a);
        let l = v.norm();
        if l < 1e-6 {
            return 0.0;
        }
        let u = P::new(v.x / l, v.y / l);
        let n = P::new(-u.y, u.x);
        let mid = P::new((a.x + b.x) / 2.0, (a.y + b.y) / 2.0);
        let near = self.around(mid, l / 2.0 + (JAMB_PROBE_FT.1 + JAMB_PROBE_SIDE_FT + JAMB_PROBE_TOL_FT) * ft);
        let tol = JAMB_PROBE_TOL_FT * ft;
        let (mut hit, mut tot) = (0usize, 0usize);
        for (base, sign) in [(b, 1.0), (a, -1.0)] {
            for k in 0..JAMB_PROBE_STEPS {
                let t = (JAMB_PROBE_FT.0 + (JAMB_PROBE_FT.1 - JAMB_PROBE_FT.0) * k as f64 / JAMB_PROBE_STEPS as f64) * ft * sign;
                for w in [-JAMB_PROBE_SIDE_FT, 0.0, JAMB_PROBE_SIDE_FT] {
                    let p = P::new(base.x + u.x * t + n.x * w * ft, base.y + u.y * t + n.y * w * ft);
                    tot += 1;
                    if near.iter().any(|&k| self.off(k, p) <= tol) {
                        hit += 1;
                    }
                }
            }
        }
        hit as f64 / tot.max(1) as f64
    }

    /// Distance from p to segment k.
    fn off(&self, k: usize, p: P) -> f64 {
        let s = self.a[k];
        let (d, l) = (self.d[k], self.len[k]);
        let t = (((p.x - s[0]) * d.x + (p.y - s[1]) * d.y) / (l * l)).clamp(0.0, 1.0);
        dist(p, P::new(s[0] + d.x * t, s[1] + d.y * t))
    }

    /// A toilet-partition door: at its hinge or closed end a thin panel ends, running across the closed leaf for a stall's depth.
    pub fn partition_at(&self, a: &Arc, closed: P, fpp: f64) -> Partition {
        let ft = 1.0 / fpp;
        let h = a.hinge;
        let v = closed.sub(h);
        let nv = v.norm();
        let nv = if nv > 0.0 { nv } else { 1.0 };
        let u = P::new(v.x / nv, v.y / nv);
        let n = P::new(-u.y, u.x);
        let mut found = Partition::No;
        for p in [h, closed] {
            let ks = self.around(p, PANEL_REACH_FT * ft);
            if ks.is_empty() {
                continue;
            }
            let m = ks.len();
            let mut off = vec![0.0; m];
            let mut along = vec![(0.0, 0.0); m];
            let mut ln = vec![0.0; m];
            let mut run = vec![false; m];
            let mut parallel = vec![false; m];
            for (t, &k) in ks.iter().enumerate() {
                let s = self.a[k];
                let (p0, p1) = (P::new(s[0], s[1]), P::new(s[2], s[3]));
                ln[t] = self.len[k];
                let near = dist(p0, p).min(dist(p1, p));
                parallel[t] = self.d[k].dot(n).abs() >= 0.97 * ln[t];
                run[t] = parallel[t] && ln[t] >= (PANEL_LEN_FT.0 * ft).max(PANEL_LEN_R * a.r) && ln[t] <= PANEL_LEN_FT.1 * ft && near <= PANEL_REACH_FT * ft;
                off[t] = P::new((p0.x + p1.x) / 2.0 - p.x, (p0.y + p1.y) / 2.0 - p.y).dot(u);
                along[t] = (p0.sub(p).dot(n), p1.sub(p).dot(n));
            }
            if run.iter().filter(|x| **x).count() < 2 {
                continue;
            }
            let amin = |t: usize| along[t].0.min(along[t].1);
            let amax = |t: usize| along[t].0.max(along[t].1);
            for i in 0..m {
                if !run[i] {
                    continue;
                }
                let mates: Vec<usize> = (0..m).filter(|&j| run[j] && (off[j] - off[i]).abs() <= PANEL_FT.1 * ft).collect();
                let beside: Vec<bool> = (0..m)
                    .map(|j| parallel[j] && ln[j] >= PANEL_LEN_FT.0 * ft && (off[j] - off[i]).abs() <= PANEL_WALL_FT * ft && amax(j).min(amax(i)) - amin(j).max(amin(i)) > 0.5 * ln[i])
                    .collect();
                if mates.len() < 2 {
                    let nb = beside.iter().filter(|x| **x).count();
                    if nb == 1 {
                        if found == Partition::No {
                            found = Partition::Line;
                        }
                    } else if ln[i] >= WALL_PARTITION_FT.1 * ft {
                        let long: Vec<usize> = (0..m).filter(|&j| beside[j] && ln[j] >= WALL_PARTITION_FT.1 * ft).collect();
                        let pair = long.iter().filter(|&&j| (off[j] - off[i]).abs() <= WALL_PARTITION_FT.0 * ft).count();
                        if long.len() == 2 && pair == 2 && found == Partition::No {
                            found = Partition::Wall;
                        }
                    }
                    continue;
                }
                let lo = amin(i).max(mates.iter().map(|&j| amin(j)).fold(f64::NEG_INFINITY, f64::max));
                let hi = amax(i).min(mates.iter().map(|&j| amax(j)).fold(f64::INFINITY, f64::min));
                let omin = mates.iter().map(|&j| off[j]).fold(f64::INFINITY, f64::min);
                let omax = mates.iter().map(|&j| off[j]).fold(f64::NEG_INFINITY, f64::max);
                if omax - omin < PANEL_FT.0 * ft || hi - lo < 0.6 * ln[i] {
                    continue;
                }
                let mut is_mate = vec![false; m];
                for &j in &mates {
                    is_mate[j] = true;
                }
                if !(0..m).any(|j| beside[j] && !is_mate[j]) {
                    return Partition::Panel;
                }
            }
        }
        found
    }

    /// Wall thickness behind the hinge, in feet: strokes parallel to the closed leaf running past the hinge on the wall side.
    pub fn jamb_ft(&self, a: &Arc, fpp: f64) -> Option<f64> {
        let h = a.hinge;
        let r = a.r;
        let ft = 1.0 / fpp;
        let ks = self.around(h, JAMB_REACH_FT * ft);
        let mut best: Option<f64> = None;
        for e in a.ends {
            let u = P::new((e.x - h.x) / r, (e.y - h.y) / r);
            let n = P::new(-u.y, u.x);
            let (mut lo, mut hi, mut cnt) = (f64::INFINITY, f64::NEG_INFINITY, 0usize);
            for &k in &ks {
                let s = self.a[k];
                let (p0, p1) = (P::new(s[0], s[1]), P::new(s[2], s[3]));
                let ln = self.len[k];
                let (t0, t1) = (p0.sub(h).dot(u), p1.sub(h).dot(u));
                let off = P::new((p0.x + p1.x) / 2.0 - h.x, (p0.y + p1.y) / 2.0 - h.y).dot(n);
                if ln >= 0.1 * ft && self.d[k].dot(u).abs() / ln >= 0.97 && t0.min(t1) < -0.08 * ft && t0.max(t1) > -0.6 * ft && off.abs() < 1.2 * ft {
                    cnt += 1;
                    lo = lo.min(off);
                    hi = hi.max(off);
                }
            }
            if cnt >= 2 {
                let w = (hi - lo) * fpp;
                best = Some(best.map_or(w, |b: f64| b.max(w)));
            }
        }
        best
    }
}

/// A leaf drawn open whose swing stops short of it, cut where it meets a wall: the leaf lies just past one end of the arc, and
/// arc and gap together make a quarter turn.
pub fn clipped_swing(a: &Arc, tip: P) -> bool {
    let h = a.hinge;
    let (t0, t1) = angles(a);
    let phi = (tip.y - h.y).atan2(tip.x - h.x).to_degrees().rem_euclid(360.0);
    let past_end = (phi - t1).rem_euclid(360.0);
    let before_start = (t0 - phi).rem_euclid(360.0);
    let gap = past_end.min(before_start);
    gap > 0.0 && gap <= CLIP_GAP_DEG && (CLIP_TURN_DEG.0..=CLIP_TURN_DEG.1).contains(&(a.sweep + gap))
}
