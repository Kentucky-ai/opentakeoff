//! Which arcs are doors at the sheet's scale, one record per swing, stalls marked, pairs joined.

use crate::arcs::TRIM_MIN_SWEEP;
use crate::geom::{cover_deg, dist, iou, median, round_even, Arc, Drawn, Path, P};
use crate::segs::{Partition, Segments};
use crate::geom::Map as HashMap;

const MIN_R_FT: f64 = 1.45;
const MAX_R_FT: f64 = 4.6;
const MIN_DOOR_R_PT: f64 = 10.0;
const SHORT_TRUE: (f64, f64) = (0.0015, 0.02);
const WOBBLY: (f64, f64) = (0.004, 0.03);
const STALL_MAX_FT: f64 = 3.1;
const STALL_PANEL_FT: f64 = 2.75;
const STALL_ROW_MIN_FT: f64 = 1.9;
const STALL_ROW_FT: f64 = 8.0;
const STALL_LINE_FT: f64 = 0.3;
const TWIN_COVER_DEG: usize = 120;
const JAMB_MIN_FT: f64 = 0.1;
/// A swing narrower than this needs a wall at its hinge (an appliance or cabinet door hangs on casework).
const SMALL_NEEDS_WALL_FT: f64 = 2.2;
/// A swing whose points sit off their circle by this share of the radius on average is not a drafted swing.
const TRUE_ARCS: bool = true;
const TRUE_ARC_R: f64 = 0.002;
/// A swing whose only leaf is a dashed line from its centre is dropped.
const DROP_DASHED_LEAVES: bool = true;
/// Two leaves of unequal width that close onto one point are one pair.
const UNEQUAL_PAIRS: bool = true;
const PAIR_ALONG_COS: f64 = 0.866;
const PAIR_MEET_R: f64 = 0.2;
const ROW_FT: f64 = 0.5;
const NEAR_R: f64 = 0.15;
const OVERLAP_IOU: f64 = 0.4;
const JOIN_HINGE_R: f64 = 0.5;
const CIRCLE_DEG: usize = 200;
const CIRCLE_TOL_R: f64 = 0.04;
pub const SCALE_CHECK_MIN: usize = 6;
const DOOR_FT_MODE: (f64, f64) = (2.2, 4.0);
pub const SCALE_SWITCH_GAIN: f64 = 1.5;
const STD_SCALES_IN: [f64; 12] = [1.0 / 32.0, 1.0 / 16.0, 3.0 / 32.0, 1.0 / 8.0, 3.0 / 16.0, 1.0 / 4.0, 3.0 / 8.0, 1.0 / 2.0, 3.0 / 4.0, 1.0, 1.5, 3.0];

fn rnd(v: f64, s: f64) -> i64 {
    round_even(v / s)
}

/// Arcs that are pieces of one drawn circle (a bubble, a column, a turning circle): arcs about the same centre at the same
/// radius going more than CIRCLE_DEG round. Coarse arcs are too few strokes to tell a circle by and are never counted.
pub fn rings(found: &[Arc]) -> Vec<bool> {
    let full: Vec<usize> = (0..found.len()).filter(|&k| found[k].drawn != Drawn::Coarse || found[k].piece).collect();
    let mut grid: HashMap<(i64, i64), Vec<usize>> = HashMap::default();
    for &k in &full {
        grid.entry((rnd(found[k].hinge.x, 2.0), rnd(found[k].hinge.y, 2.0))).or_default().push(k);
    }
    let mut out = vec![false; found.len()];
    for &k in &full {
        if out[k] {
            continue;
        }
        let a = &found[k];
        let (cx, cy) = (rnd(a.hinge.x, 2.0), rnd(a.hinge.y, 2.0));
        let tol = 0.5f64.max(CIRCLE_TOL_R * a.r);
        let mut same = vec![];
        for x in cx - 1..=cx + 1 {
            for y in cy - 1..=cy + 1 {
                if let Some(list) = grid.get(&(x, y)) {
                    for &j in list {
                        if dist(found[j].hinge, a.hinge) < tol && (found[j].r - a.r).abs() < tol {
                            same.push(j);
                        }
                    }
                }
            }
        }
        if same.len() < 3 {
            continue;
        }
        if cover_deg(same.iter().map(|&j| &found[j])) > CIRCLE_DEG {
            for j in same {
                out[j] = true;
            }
        }
    }
    out
}

/// Scallops of a revision cloud: arcs both of whose ends meet the end of another arc of about the same radius (a cloud is a
/// chain of them). A double door's two leaves meet at one end only.
pub fn cloud_scallops(arcs: &[Arc]) -> Vec<bool> {
    let mut grid: HashMap<(i64, i64), Vec<(usize, P)>> = HashMap::default();
    let key = |p: P| ((p.x / 4.0).floor() as i64, (p.y / 4.0).floor() as i64);
    for (k, a) in arcs.iter().enumerate() {
        for e in a.ends {
            grid.entry(key(e)).or_default().push((k, e));
        }
    }
    arcs.iter().enumerate().map(|(k, a)| {
        a.ends.iter().all(|&e| {
            let tol = 1.0f64.max(0.05 * a.r);
            let (cx, cy) = key(e);
            (cx - 1..=cx + 1).any(|x| (cy - 1..=cy + 1).any(|y| grid.get(&(x, y)).is_some_and(|l| l.iter().any(|&(j, f)| {
                j != k && dist(e, f) < tol && (arcs[j].r - a.r).abs() < 0.2 * a.r.max(arcs[j].r)
            }))))
        })
    }).collect()
}

fn leafed_radii(arcs: &[Arc], segs: &Segments) -> Vec<f64> {
    arcs.iter().filter(|a| a.r >= MIN_DOOR_R_PT && a.drawn != Drawn::Coarse && segs.leaf(a).is_some()).map(|a| a.r).collect()
}

/// Feet per point from the arcs: most doors are about 3 ft, so the commonest leafed radius is a 3-ft door.
pub fn scale_from_arcs(arcs: &[Arc], segs: &Segments) -> Option<f64> {
    let radii = leafed_radii(arcs, segs);
    if radii.len() < 3 {
        return None;
    }
    let mut bins: Vec<(i64, Vec<f64>)> = vec![];
    for r in radii {
        let key = round_even(r.ln() / 0.1);
        match bins.iter_mut().find(|b| b.0 == key) {
            Some(b) => b.1.push(r),
            None => bins.push((key, vec![r])),
        }
    }
    // the first bin of the largest size, in order of first appearance
    let mut best = 0;
    for (k, b) in bins.iter().enumerate() {
        if b.1.len() > bins[best].1.len() {
            best = k;
        }
    }
    let mut top = bins[best].1.clone();
    Some(3.0 / median(&mut top))
}

/// The printed scale is wrong for the doors when the commonest leafed swing reads over 4 ft at it: the larger standard scale
/// that makes it about 3 ft. Only toward a larger drawing scale (small symbols must not grow into doors).
pub fn door_scale(arcs: &[Arc], segs: &Segments, fpp: f64, least: usize) -> Option<f64> {
    let radii = leafed_radii(arcs, segs);
    if radii.len() < least {
        return None;
    }
    let mut bins: Vec<(i64, Vec<f64>)> = vec![];
    for &r in &radii {
        let key = round_even(r.ln() / 0.1);
        match bins.iter_mut().find(|b| b.0 == key) {
            Some(b) => b.1.push(r),
            None => bins.push((key, vec![r])),
        }
    }
    let minv = |v: &Vec<f64>| v.iter().cloned().fold(f64::INFINITY, f64::min);
    let mut best = 0;
    for (k, b) in bins.iter().enumerate() {
        let (lb, lk) = (b.1.len(), bins[best].1.len());
        if lb > lk || (lb == lk && -minv(&b.1) > -minv(&bins[best].1)) {
            best = k;
        }
    }
    let mut top = bins[best].1.clone();
    if top.len() < least || (top.len() as f64) < 0.3 * radii.len() as f64 {
        return None;
    }
    let r = median(&mut top);
    if (DOOR_FT_MODE.0..=DOOR_FT_MODE.1).contains(&(r * fpp)) {
        return None;
    }
    let mut bestsc = STD_SCALES_IN[0];
    for &sc in &STD_SCALES_IN {
        if (r / (72.0 * sc) - 3.0).abs() < (r / (72.0 * bestsc) - 3.0).abs() {
            bestsc = sc;
        }
    }
    let f = 1.0 / (72.0 * bestsc);
    if (2.2..=3.8).contains(&(r * f)) && f < fpp {
        Some(f)
    } else {
        None
    }
}

/// The arcs that are doors at this scale: a leaf's radius, a drawn leaf, a jamb thicker than a panel.
pub fn keep(arcs: &[Arc], fpp: f64, paths: &[Path], segs: &Segments) -> Vec<Arc> {
    judge_all(arcs, fpp, paths, segs).into_iter().filter_map(|r| r.ok()).collect()
}

/// Every arc judged: the door it is, or why not.
pub fn judge_all(arcs: &[Arc], fpp: f64, paths: &[Path], segs: &Segments) -> Vec<Result<Arc, &'static str>> {
    let (lo, hi) = (MIN_R_FT / fpp, MAX_R_FT / fpp);
    let mut by_centre: HashMap<(i64, i64), Vec<usize>> = HashMap::default();
    for (k, a) in arcs.iter().enumerate() {
        by_centre.entry((rnd(a.hinge.x, 4.0), rnd(a.hinge.y, 4.0))).or_default().push(k);
    }
    // another arc about the same centre at the same radius: a leafless "swing" with one is a piece of a drawn circle.
    // `apart`: only when the arcs about that centre go further round than a swing does.
    let twin = |ai: usize, a: &Arc, apart: bool| -> bool {
        let tol = 0.5f64.max(CIRCLE_TOL_R * a.r);
        let (cx, cy) = (rnd(a.hinge.x, 4.0), rnd(a.hinge.y, 4.0));
        let mut same: Vec<&Arc> = vec![];
        for x in cx - 1..=cx + 1 {
            for y in cy - 1..=cy + 1 {
                if let Some(list) = by_centre.get(&(x, y)) {
                    for &j in list {
                        let b = &arcs[j];
                        if j != ai && b.sweep >= 45.0 && dist(b.hinge, a.hinge) < tol && (b.r - a.r).abs() < tol {
                            same.push(b);
                        }
                    }
                }
            }
        }
        if !apart || same.is_empty() {
            return !same.is_empty();
        }
        cover_deg(std::iter::once(a).chain(same.into_iter())) > TWIN_COVER_DEG
    };
    let dark = |a: &Arc| a.refs.iter().any(|&i| paths[i as usize].dark_fill);
    let judge = |ai: usize, a0: &Arc| -> Result<Arc, &'static str> {
        let mut a = a0.clone();
        let mut drop = false;
        let mut far: Option<P> = None;
        if !(lo..=hi).contains(&a.r) {
            return Err("radius");
        }
        if dark(&a) {
            return Err("dark fill");
        }
        if a.drawn == Drawn::Coarse {
            for (e, closed) in [(a.ends[0], a.ends[1]), (a.ends[1], a.ends[0])] {
                if let Some(f) = segs.leaf_to(&a, e) {
                    if segs.wall_beyond(&a, closed) {
                        far = Some(f);
                        break;
                    }
                }
            }
            if far.is_none() {
                return Err("no leaf");
            }
            a.jamb = segs.jamb_ft(&a, fpp).unwrap_or(f64::NAN);
            if a.jamb.is_nan() {
                return Err("no wall");
            }
        } else {
            far = segs.leaf(&a);
            if let Some(f) = far {
                if segs.leaf_styled(&a, f) {
                    a.dashed = true;
                }
            }
            if far.is_none() && (a.drawn == Drawn::Strokes || a.refs.iter().any(|&i| paths[i as usize].dashed)) {
                far = segs.dashed_leaf(&a);
                if far.is_some() && twin(ai, &a, true) {
                    far = None;
                    drop = true;
                }
                if far.is_some() {
                    a.dashed = true;
                    a.leaf_dashes = true;
                }
            }
            if far.is_none() && !drop {
                far = segs.opening(&a);
                if far.is_some() && twin(ai, &a, false) {
                    far = None;
                    drop = true;
                }
                if far.is_some() {
                    a.leafless = true;
                }
            }
            if far.is_none() {
                return Err(if drop { "circle piece" } else { "no leaf" });
            }
            let w = segs.jamb_ft(&a, fpp);
            a.jamb = w.unwrap_or(f64::NAN);
            if matches!(w, Some(w) if w < JAMB_MIN_FT) {
                return Err("thin jamb"); // a stall or equipment panel
            }
            if w.is_none() && a.r * fpp < SMALL_NEEDS_WALL_FT {
                return Err("small no wall"); // a dishwasher, washer or cabinet door on casework: no wall at its hinge
            }
            if w.is_none() && a.leaf_dashes {
                return Err("no wall"); // dashes from an arc's centre with no wall behind: a seal's or a logo's drawing
            }
            if TRUE_ARCS && a.misfit >= TRUE_ARC_R * a.r {
                return Err("off its circle"); // a door swing is drawn with a compass: its points sit on the circle
            }
            if DROP_DASHED_LEAVES && a.leaf_dashes {
                return Err("dashed leaf"); // dashes in a line from an arc's centre: a seal, a logo, a clearance line
            }
            if a.drawn == Drawn::Strokes && a.misfit > WOBBLY.0 * a.r + WOBBLY.1 {
                return Err("wobbly"); // stipple, an earth hatch
            }
            if a.drawn == Drawn::Strokes && a.sweep < TRIM_MIN_SWEEP.0 && (w.is_none() || a.misfit > SHORT_TRUE.0 * a.r + SHORT_TRUE.1) {
                return Err("short"); // a stair break, a leader
            }
        }
        a.leaf_far = far.unwrap();
        a.strike = segs.wall_beyond(&a, closed_end(&a));
        Ok(a)
    };
    arcs.iter().enumerate().map(|(ai, a)| judge(ai, a)).collect()
}

/// Doors drawn without an arc (a solid leaf open square off a wall gap, a dashed chord from the far jamb to its tip), as swings
/// beside the arcs already kept: a quarter turn about the hinge, `Drawn::Chord`. One per opening; none where a kept swing is.
const CHORDS: bool = true;
pub fn chord_swings(kept: &[Arc], segs: &Segments, fpp: f64) -> Vec<Arc> {
    if !CHORDS {
        return vec![];
    }
    let mut out: Vec<Arc> = vec![];
    for (h, st, t) in segs.chord_doors(MIN_R_FT / fpp, MAX_R_FT / fpp) {
        let r = dist(h, t);
        let (u, n) = (P::new((t.x - h.x) / r, (t.y - h.y) / r), P::new((st.x - h.x) / r, (st.y - h.y) / r));
        let mut b = [h.x, h.y, h.x, h.y];
        for k in 0..=8 {
            let th = std::f64::consts::FRAC_PI_2 * k as f64 / 8.0;
            let p = P::new(h.x + r * (th.cos() * u.x + th.sin() * n.x), h.y + r * (th.cos() * u.y + th.sin() * n.y));
            b = [b[0].min(p.x), b[1].min(p.y), b[2].max(p.x), b[3].max(p.y)];
        }
        let mut a = crate::arcs::make_arc(h, r, 90.0, 0.0, [t, st], b, Drawn::Chord, vec![]);
        a.leaf_far = t;
        a.jamb = segs.jamb_ft(&a, fpp).unwrap_or(f64::NAN);
        a.strike = segs.wall_beyond(&a, st);
        let ab = a.swing_box();
        let c = ((ab[0] + ab[2]) / 2.0, (ab[1] + ab[3]) / 2.0);
        let taken = |q: &Arc| {
            let qb = q.swing_box();
            iou(&ab, &qb) > 0.3 || (qb[0] <= c.0 && c.0 <= qb[2] && qb[1] <= c.1 && c.1 <= qb[3])
        };
        if kept.iter().any(taken) || out.iter().any(taken) {
            continue;
        }
        out.push(a);
    }
    out
}

/// Swings filed by the grid cells their boxes cover.
struct BoxGrid {
    cells: HashMap<(i64, i64), Vec<usize>>,
}

impl BoxGrid {
    const CELL: f64 = 40.0;
    fn new() -> BoxGrid {
        BoxGrid { cells: HashMap::default() }
    }
    fn keys(b: &[f64; 4]) -> impl Iterator<Item = (i64, i64)> {
        let c = Self::CELL;
        let (x0, x1) = ((b[0] / c).floor() as i64, (b[2] / c).floor() as i64);
        let (y0, y1) = ((b[1] / c).floor() as i64, (b[3] / c).floor() as i64);
        (x0..=x1).flat_map(move |x| (y0..=y1).map(move |y| (x, y)))
    }
    fn add(&mut self, k: usize, b: &[f64; 4]) {
        for key in Self::keys(b) {
            self.cells.entry(key).or_default().push(k);
        }
    }
    fn overlapping(&self, b: &[f64; 4]) -> Vec<usize> {
        let mut got: Vec<usize> = vec![];
        for key in Self::keys(b) {
            if let Some(l) = self.cells.get(&key) {
                for &k in l {
                    if !got.contains(&k) {
                        got.push(k);
                    }
                }
            }
        }
        got
    }
}

/// Two leaves back to back in one opening (a communicating pair, one swinging into each room): each piece has its own leaf
/// ending at its outer end, and the pieces meet at the strike, away from both leaves. A swing cut in two by a 45-degree leaf has
/// the leaf at the cut, where the pieces meet. Off: development rulers mostly count a communicating pair as one door (the joined
/// find), and splitting it cost far more false finds than it found (round 4, E9).
const BACK_TO_BACK: bool = false;
const BACK_TO_BACK_R: f64 = 0.25;
fn back_to_back(u: &Arc, q: &Arc) -> bool {
    let mut best = (u.ends[0], q.ends[0]);
    let mut bd = f64::INFINITY;
    for e in u.ends {
        for f in q.ends {
            if dist(e, f) < bd {
                bd = dist(e, f);
                best = (e, f);
            }
        }
    }
    let leafed = |a: &Arc| !a.leafless && dist(a.leaf_far, a.hinge) > 0.5 * a.r;
    leafed(u) && leafed(q) && dist(u.leaf_far, best.0) > BACK_TO_BACK_R * u.r && dist(q.leaf_far, best.1) > BACK_TO_BACK_R * q.r
}

/// A 45-degree leaf cuts one swing into two pieces; doubled strokes and nested clearance arcs draw it twice.
pub fn one_per_swing(arcs: Vec<Arc>) -> Vec<Arc> {
    let mut order: Vec<Arc> = arcs;
    order.sort_by(|p, q| q.r.partial_cmp(&p.r).unwrap()); // stable: ties keep their order
    let mut joined: Vec<Arc> = vec![];
    for q in order {
        let host = joined.iter().position(|u| {
            (u.r - q.r).abs() < 0.1 * u.r
                && dist(u.hinge, q.hinge) < JOIN_HINGE_R * u.r
                && u.sweep <= 80.0
                && q.sweep <= 80.0
                && u.sweep + q.sweep <= 110.0
                && u.ends.iter().flat_map(|e| q.ends.iter().map(move |f| dist(*e, *f))).fold(f64::INFINITY, f64::min) < 0.6 * u.r
                && !(BACK_TO_BACK && back_to_back(u, &q))
        });
        match host {
            None => joined.push(q),
            Some(h) => {
                let host = &mut joined[h];
                let pts = [host.ends[0], host.ends[1], q.ends[0], q.ends[1]];
                let mut best = (pts[0], pts[0]);
                let mut bd = -1.0;
                for e in pts {
                    for f in pts {
                        let d = dist(e, f);
                        if d > bd {
                            bd = d;
                            best = (e, f);
                        }
                    }
                }
                host.ends = [best.0, best.1];
                host.bbox = [host.bbox[0].min(q.bbox[0]), host.bbox[1].min(q.bbox[1]), host.bbox[2].max(q.bbox[2]), host.bbox[3].max(q.bbox[3])];
                host.sweep = 999.0;
                host.joined = true;
            }
        }
    }
    joined.sort_by(|p, q| q.r.partial_cmp(&p.r).unwrap());
    let mut unique: Vec<Arc> = vec![];
    let mut seen = BoxGrid::new();
    for q in joined {
        let qb = q.swing_box();
        let dup = seen.overlapping(&qb).into_iter().any(|k| {
            let u = &unique[k];
            dist(q.hinge, u.hinge) < NEAR_R * u.r && (q.r - u.r).abs() < NEAR_R * u.r && iou(&qb, &u.swing_box()) > 0.5
        });
        if dup {
            continue;
        }
        seen.add(unique.len(), &qb);
        unique.push(q);
    }
    let mut out: Vec<Arc> = vec![];
    let mut seen = BoxGrid::new();
    for q in unique {
        let qb = q.swing_box();
        if seen.overlapping(&qb).into_iter().any(|k| iou(&qb, &out[k].swing_box()) > OVERLAP_IOU) {
            continue;
        }
        seen.add(out.len(), &qb);
        out.push(q);
    }
    out
}

fn closed_end(a: &Arc) -> P {
    if dist(a.ends[1], a.leaf_far) > dist(a.ends[0], a.leaf_far) {
        a.ends[1]
    } else {
        a.ends[0]
    }
}

/// Toilet-partition doors: a thin panel ends at the hinge or the closed end, or the door closes on such a stall door's line.
pub fn stalls(arcs: &mut [Arc], segs: &Segments, fpp: f64) {
    let small: Vec<usize> = (0..arcs.len()).filter(|&k| arcs[k].r * fpp <= STALL_MAX_FT).collect();
    let mut part: HashMap<usize, Partition> = HashMap::default();
    let mut lines: HashMap<usize, P> = HashMap::default();
    for &k in &small {
        let a = &arcs[k];
        let closed = closed_end(a);
        let p = if a.r * fpp <= STALL_PANEL_FT { segs.partition_at(a, closed, fpp) } else { Partition::No };
        part.insert(k, p);
        let v = closed.sub(a.hinge);
        let n = v.norm();
        let n = if n > 0.0 { n } else { 1.0 };
        lines.insert(k, P::new(v.x / n, v.y / n));
    }
    let mut stall: HashMap<usize, bool> = small.iter().map(|&k| (k, part[&k] != Partition::No)).collect();
    let lone: Vec<usize> = small.iter().copied().filter(|k| matches!(part[k], Partition::Line | Partition::Wall) && arcs[*k].r * fpp >= STALL_ROW_MIN_FT).collect();
    for &a in &lone {
        let ok = lone.iter().any(|&b| b != a && dist(arcs[a].hinge, arcs[b].hinge) * fpp <= STALL_ROW_FT && lines[&a].dot(lines[&b]).abs() >= 0.97);
        stall.insert(a, ok);
    }
    let on_line = |a: usize, b: usize| {
        let (ua, ub) = (lines[&a], lines[&b]);
        let d = arcs[b].hinge.sub(arcs[a].hinge);
        let off = (d.x * ua.y - d.y * ua.x).abs() * fpp;
        ua.dot(ub).abs() >= 0.97 && off <= STALL_LINE_FT && dist(arcs[a].hinge, arcs[b].hinge) * fpp <= STALL_ROW_FT
    };
    let narrow: Vec<usize> = small.iter().copied().filter(|&k| (STALL_ROW_MIN_FT..=STALL_PANEL_FT).contains(&(arcs[k].r * fpp))).collect();
    let rowed: Vec<usize> = narrow.iter().copied().filter(|&a| !stall[&a] && narrow.iter().filter(|&&b| b != a && on_line(a, b)).count() >= 2).collect();
    for a in rowed {
        stall.insert(a, true);
    }
    let mut row = vec![];
    for &a in &small {
        if stall[&a] {
            continue;
        }
        let ua = lines[&a];
        for &s in &small {
            if !stall[&s] || dist(arcs[s].hinge, arcs[a].hinge) * fpp > STALL_ROW_FT {
                continue;
            }
            let us = lines[&s];
            let d = arcs[a].hinge.sub(arcs[s].hinge);
            let off = (d.x * us.y - d.y * us.x).abs() * fpp;
            if ua.dot(us).abs() >= 0.97 && off <= STALL_LINE_FT {
                row.push(a);
                break;
            }
        }
    }
    for a in row {
        stall.insert(a, true);
    }
    for (k, s) in stall {
        arcs[k].stall = s;
    }
}

pub struct Door {
    pub bbox: [f64; 4],
    pub pair: bool,
    pub stall: bool,
    pub dashed: bool,
    pub leaves: Vec<Arc>,
}

fn leaf_along(a: &Arc, h1: P, h2: P) -> bool {
    let u = h2.sub(h1);
    let l = a.leaf_far.sub(a.hinge);
    u.dot(l).abs() > PAIR_ALONG_COS * u.norm() * l.norm()
}

/// One entry per door: two leaves hinged one door apart, drawn alike, meeting in the middle, are one pair.
pub fn doors(arcs: &[Arc], fpp: f64) -> Vec<Door> {
    let mut used = vec![false; arcs.len()];
    let mut out: Vec<Door> = vec![];
    let row = ROW_FT / fpp;
    for i in 0..arcs.len() {
        if used[i] {
            continue;
        }
        let p = &arcs[i];
        let mut mate: Option<usize> = None;
        for j in i + 1..arcs.len() {
            if used[j] {
                continue;
            }
            let q = &arcs[j];
            let rr = p.r + q.r;
            // an unequal pair (an active leaf and a narrower inactive one) is allowed when the two leaves close onto one point
            let unequal_ok = UNEQUAL_PAIRS && dist(closed_end(p), closed_end(q)) <= 0.12 * p.r.min(q.r);
            let ratio = if unequal_ok { 0.55 } else { 0.25 };
            if (p.r - q.r).abs() > ratio * p.r.max(q.r) || (dist(p.hinge, q.hinge) - rr).abs() > 0.12 * rr {
                continue;
            }
            if leaf_along(p, p.hinge, q.hinge) != leaf_along(q, p.hinge, q.hinge) {
                continue;
            }
            let (bp, bq) = (p.swing_box(), q.swing_box());
            let meet = p.ends.iter().flat_map(|e| q.ends.iter().map(move |f| dist(*e, *f))).fold(f64::INFINITY, f64::min);
            if iou(&bp, &bq) < 0.3
                && (bp[0].max(bq[0]) - bp[2].min(bq[2])).max(0.0) < 0.1 * rr
                && (bp[1].max(bq[1]) - bp[3].min(bq[3])).max(0.0) < 0.1 * rr
                && meet <= PAIR_MEET_R * p.r.min(q.r)
            {
                mate = Some(j);
                break;
            }
        }
        if let Some(m) = mate {
            let (h1, h2) = (p.hinge, arcs[m].hinge);
            let (bp, bq) = (p.swing_box(), arcs[m].swing_box());
            let c = P::new((bp[0] + bp[2] + bq[0] + bq[2]) / 4.0, (bp[1] + bp[3] + bq[1] + bq[3]) / 4.0);
            let side = |x: f64, y: f64| (h2.x - h1.x) * (y - h1.y) - (h2.y - h1.y) * (x - h1.x);
            for (k, w) in arcs.iter().enumerate() {
                if k == i || k == m {
                    continue;
                }
                let wb = w.swing_box();
                if dist(w.hinge, h1).min(dist(w.hinge, h2)) < row && side((wb[0] + wb[2]) / 2.0, (wb[1] + wb[3]) / 2.0) * side(c.x, c.y) > 0.0 {
                    mate = None;
                    break;
                }
            }
        }
        let leaves: Vec<Arc> = match mate {
            None => vec![p.clone()],
            Some(m) => {
                used[m] = true;
                vec![p.clone(), arcs[m].clone()]
            }
        };
        let mut bbox = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for a in &leaves {
            let b = a.swing_box();
            bbox = [bbox[0].min(b[0]), bbox[1].min(b[1]), bbox[2].max(b[2]), bbox[3].max(b[3])];
        }
        out.push(Door { bbox, pair: leaves.len() == 2, stall: leaves.len() == 1 && p.stall, dashed: leaves.iter().all(|a| a.dashed), leaves });
    }
    // one door, one find: a find centred inside an earlier one is the same door
    let mut fin: Vec<Door> = vec![];
    for d in out {
        let c = ((d.bbox[0] + d.bbox[2]) / 2.0, (d.bbox[1] + d.bbox[3]) / 2.0);
        if !fin.iter().any(|k| k.bbox[0] <= c.0 && c.0 <= k.bbox[2] && k.bbox[1] <= c.1 && c.1 <= k.bbox[3]) {
            fin.push(d);
        }
    }
    let _ = fpp;
    fin
}
