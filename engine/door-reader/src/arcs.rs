//! Every arc on the page. A swing reaches the PDF as Bezier curves, as a polyline, or as loose short strokes (each possibly
//! its own path, possibly dashed), so all three are read into one list.

use crate::geom::{dist, Arc, Drawn, Item, Path, P};
use crate::geom::Map as HashMap;

pub const MIN_R_PT: f64 = 4.0;
pub const MAX_R_PT: f64 = 500.0;
pub const SWEEP_DEG: (f64, f64) = (35.0, 115.0); // one arc piece; a 45-degree leaf drawn across a swing cuts it in two
const PARTIAL_SWEEP_DEG: f64 = 20.0; // a Bezier piece this short may still join its neighbour
const FIT_TOL_PT: f64 = 0.12;
const FIT_TOL_R: f64 = 0.025;
const STROKE_PT: (f64, f64) = (0.2, 12.0); // a loose stroke of a faceted arc
const CHAIN_GAPS_PT: [f64; 2] = [6.5, 12.0]; // dashes leave gaps
const TURN_COS: f64 = 0.81;
const HEADING_COS: f64 = 0.8;
const CHAIN_MIN_STROKES: usize = 4;
const CHAIN_TINY_PT: f64 = 2.0;
const COARSE_SWEEP_DEG: (f64, f64) = (20.0, 60.0);
const COARSE_FIT_R: f64 = 0.03;
const COARSE_RUN_MAX: usize = 8;
/// Short single-curve swings (20 to 35 degrees) are judged as coarse arcs.
const SHORT_SWINGS: bool = true;
const TINY_PAGE: (usize, f64) = (500, 0.9);
const MIN_ARC_POINTS: usize = 5;
const HATCH_SAME_DIRECTION: usize = 1500;
const NEIGHBOURS_KEPT: usize = 16;
const TRIM_MAX_POINTS: usize = 120;
const TRIM_MAX_CUT: usize = 12;
pub const TRIM_MIN_SWEEP: (f64, f64) = (60.0, 35.0);
const TRIM_FIT_SLACK: (f64, f64) = (2.0, 0.01);
const CHAIN_MAX_STEPS: usize = 96;
const CHAIN_STRAIGHT: f64 = 0.985;

/// Algebraic least-squares circle of an ordered run, solved about its mean. None unless it is one arc turning one way.
/// Returns (centre, radius, sweep degrees, mean misfit).
pub fn circle(pts: &[P]) -> Option<(P, f64, f64, f64)> {
    let n = pts.len();
    if n < MIN_ARC_POINTS {
        return None;
    }
    let (mut ox, mut oy) = (0.0, 0.0);
    for p in pts {
        ox += p.x;
        oy += p.y;
    }
    ox /= n as f64;
    oy /= n as f64;
    let (mut suu, mut svv, mut suv, mut b1, mut b2) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for p in pts {
        let (u, v) = (p.x - ox, p.y - oy);
        let q = u * u + v * v;
        suu += u * u;
        svv += v * v;
        suv += u * v;
        b1 += u * q;
        b2 += v * q;
    }
    b1 *= 0.5;
    b2 *= 0.5;
    let det = suu * svv - suv * suv;
    if det <= 1e-12 * (suu + svv) * (suu + svv) {
        return None;
    }
    let cu = (b1 * svv - b2 * suv) / det;
    let cv = (suu * b2 - suv * b1) / det;
    let r = (cu * cu + cv * cv + (suu + svv) / n as f64).max(0.0).sqrt();
    if !(MIN_R_PT..=MAX_R_PT).contains(&r) {
        return None;
    }
    let tol = FIT_TOL_PT.max(FIT_TOL_R * r);
    let (mut worst, mut sum_off) = (0.0f64, 0.0);
    let (mut pos, mut neg, mut turn) = (0usize, 0usize, 0.0);
    let mut prev: Option<(f64, f64)> = None;
    for p in pts {
        let (du, dv) = (p.x - ox - cu, p.y - oy - cv);
        let off = ((du * du + dv * dv).sqrt() - r).abs();
        worst = worst.max(off);
        sum_off += off;
        if let Some((pu, pv)) = prev {
            let s = (pu * dv - pv * du).atan2(pu * du + pv * dv);
            if s > 0.005 {
                pos += 1;
            } else if s < -0.005 {
                neg += 1;
            }
            turn += s;
        }
        prev = Some((du, dv));
    }
    if worst > tol || pos.min(neg) > 1 {
        return None;
    }
    Some((P::new(ox + cu, oy + cv), r, turn.abs().to_degrees(), sum_off / n as f64))
}

fn bbox(pts: &[P]) -> [f64; 4] {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for p in pts {
        b[0] = b[0].min(p.x);
        b[1] = b[1].min(p.y);
        b[2] = b[2].max(p.x);
        b[3] = b[3].max(p.y);
    }
    b
}

pub fn make_arc(hinge: P, r: f64, sweep: f64, misfit: f64, ends: [P; 2], bbox: [f64; 4], drawn: Drawn, refs: Vec<u32>) -> Arc {
    Arc { hinge, r, sweep, misfit, ends, bbox, drawn, refs, dashed: false, leaf_dashes: false, leafless: false, leaf_far: hinge, stall: false, joined: false, piece: false, jamb: f64::NAN, strike: false }
}

fn arc_of(pts: &[P], drawn: Drawn, refs: Vec<u32>) -> Option<Arc> {
    let (c, r, sweep, misfit) = circle(pts)?;
    Some(make_arc(c, r, sweep, misfit, [pts[0], pts[pts.len() - 1]], bbox(pts), drawn, refs))
}

fn in_range(a: &Option<Arc>, low: f64) -> bool {
    matches!(a, Some(a) if a.sweep >= low && a.sweep <= SWEEP_DEG.1)
}

fn bezier(a: P, b: P, c: P, d: P) -> [P; 13] {
    let mut out = [P::new(0.0, 0.0); 13];
    for (k, o) in out.iter_mut().enumerate() {
        let t = k as f64 / 12.0;
        let u = 1.0 - t;
        *o = P::new(
            u * u * u * a.x + 3.0 * u * u * t * b.x + 3.0 * u * t * t * c.x + t * t * t * d.x,
            u * u * u * a.y + 3.0 * u * u * t * b.y + 3.0 * u * t * t * c.y + t * t * t * d.y,
        );
    }
    out
}

/// A loose straight stroke: its two ends and the path it came from.
#[derive(Clone, Copy)]
pub struct Stroke {
    pub a: P,
    pub b: P,
    pub path: u32,
}

/// A part-open swing whose arc is drawn as two or three straight strokes: every vertex on one circle, turning one way, through
/// COARSE_SWEEP_DEG. It stands for a door only with a leaf of its radius and a wall running on from its closed end (the keep rule).
fn coarse(run: &[P], refs: &[u32]) -> Option<Arc> {
    let mut pts: Vec<P> = vec![run[0]];
    for q in &run[1..] {
        if dist(*q, *pts.last().unwrap()) > 0.3 {
            pts.push(*q);
        }
    }
    if !(3..=4).contains(&pts.len()) {
        return None;
    }
    let (a, b, c) = (pts[0], pts[pts.len() / 2], pts[pts.len() - 1]);
    let d = 2.0 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if d.abs() < 1e-9 {
        return None;
    }
    let (sa, sb, sc) = (a.x * a.x + a.y * a.y, b.x * b.x + b.y * b.y, c.x * c.x + c.y * c.y);
    let h = P::new(
        (sa * (b.y - c.y) + sb * (c.y - a.y) + sc * (a.y - b.y)) / d,
        (sa * (c.x - b.x) + sb * (a.x - c.x) + sc * (b.x - a.x)) / d,
    );
    let r = dist(h, pts[0]);
    if !(MIN_R_PT..=MAX_R_PT).contains(&r) || pts.iter().any(|q| (dist(h, *q) - r).abs() > COARSE_FIT_R * r) {
        return None;
    }
    let turns: Vec<f64> = (0..pts.len() - 2)
        .map(|k| (pts[k + 1].x - pts[k].x) * (pts[k + 2].y - pts[k + 1].y) - (pts[k + 1].y - pts[k].y) * (pts[k + 2].x - pts[k + 1].x))
        .collect();
    if !(turns.iter().all(|t| *t > 0.0) || turns.iter().all(|t| *t < 0.0)) {
        return None;
    }
    let a0 = (pts[0].y - h.y).atan2(pts[0].x - h.x);
    let a1 = (c.y - h.y).atan2(c.x - h.x);
    let sweep = ((a1 - a0 + std::f64::consts::PI).rem_euclid(2.0 * std::f64::consts::PI) - std::f64::consts::PI).abs().to_degrees();
    if !(COARSE_SWEEP_DEG.0..=COARSE_SWEEP_DEG.1).contains(&sweep) {
        return None;
    }
    Some(make_arc(h, r, sweep, 0.0, [pts[0], c], bbox(&pts), Drawn::Coarse, refs.to_vec()))
}

struct PathArcs {
    arcs: Vec<Arc>,
    strokes: Vec<Stroke>,
    pieces: Vec<(Arc, Vec<P>)>,
}

/// Arcs drawn inside one path (runs of Bezier curves, connected polylines), plus the loose strokes and short curve pieces.
fn path_arcs(paths: &[Path], coarse_out: &mut Vec<Arc>) -> PathArcs {
    let mut out = PathArcs { arcs: vec![], strokes: vec![], pieces: vec![] };
    for (i, d) in paths.iter().enumerate() {
        let i = i as u32;
        let mut curve: Vec<P> = vec![];
        let mut poly: Vec<P> = vec![];
        let mut heading: Option<P> = None;
        let flush_curve = |curve: &mut Vec<P>, out: &mut PathArcs| {
            if !curve.is_empty() {
                let a = arc_of(curve, Drawn::Curve, vec![i]);
                if in_range(&a, SWEEP_DEG.0) {
                    out.arcs.push(a.unwrap());
                } else if in_range(&a, PARTIAL_SWEEP_DEG) {
                    out.pieces.push((a.unwrap(), curve.clone()));
                }
                curve.clear();
            }
        };
        let flush_poly = |poly: &mut Vec<P>, heading: &mut Option<P>, out: &mut PathArcs, coarse_out: &mut Vec<Arc>| {
            if !poly.is_empty() {
                let a = arc_of(poly, Drawn::Polyline, vec![i]);
                if in_range(&a, SWEEP_DEG.0) {
                    out.arcs.push(a.unwrap());
                } else if SHORT_SWINGS && poly.len() >= MIN_ARC_POINTS && in_range(&a, COARSE_SWEEP_DEG.0) {
                    let mut c = a.unwrap();
                    c.drawn = Drawn::Coarse;
                    c.piece = true;
                    coarse_out.push(c);
                } else if (3..=4).contains(&poly.len()) {
                    if let Some(c) = coarse(poly, &[i]) {
                        coarse_out.push(c);
                    }
                }
                poly.clear();
            }
            *heading = None;
        };
        for item in &d.items {
            match *item {
                Item::Curve(a, b, c, e) => {
                    flush_poly(&mut poly, &mut heading, &mut out, coarse_out);
                    let pts = bezier(a, b, c, e);
                    if !curve.is_empty() && dist(*curve.last().unwrap(), pts[0]) > 0.3 {
                        flush_curve(&mut curve, &mut out);
                    }
                    if curve.is_empty() {
                        curve.extend_from_slice(&pts);
                    } else {
                        curve.extend_from_slice(&pts[1..]);
                    }
                }
                Item::Edge(..) => {
                    flush_curve(&mut curve, &mut out);
                    flush_poly(&mut poly, &mut heading, &mut out, coarse_out);
                }
                Item::Line(a, b) => {
                    flush_curve(&mut curve, &mut out);
                    let length = dist(a, b);
                    if (STROKE_PT.0..=STROKE_PT.1).contains(&length) {
                        out.strokes.push(Stroke { a, b, path: i });
                    }
                    if length == 0.0 {
                        continue;
                    }
                    let v = P::new((b.x - a.x) / length, (b.y - a.y) / length);
                    if !poly.is_empty() {
                        let joins = dist(*poly.last().unwrap(), a) < 0.3 && matches!(heading, Some(h) if v.dot(h) > TURN_COS);
                        if !joins {
                            flush_poly(&mut poly, &mut heading, &mut out, coarse_out);
                        }
                    }
                    if poly.is_empty() {
                        poly.push(a);
                    }
                    poly.push(b);
                    heading = Some(v);
                }
            }
        }
        flush_curve(&mut curve, &mut out);
        flush_poly(&mut poly, &mut heading, &mut out, coarse_out);
    }
    out
}

/// Short Bezier runs on one circle whose ends touch.
fn join_pieces(pieces: &[(Arc, Vec<P>)], used: &mut Vec<bool>) -> Vec<Arc> {
    let mut out = vec![];
    *used = vec![false; pieces.len()];
    for i in 0..pieces.len() {
        if used[i] {
            continue;
        }
        let (a, pa) = &pieces[i];
        for j in i + 1..pieces.len() {
            let (b, pb) = &pieces[j];
            if used[j] || (a.r - b.r).abs() > 0.05 * a.r || dist(a.hinge, b.hinge) > 0.05 * a.r {
                continue;
            }
            let ra: Vec<P> = pa.iter().rev().copied().collect();
            let rb: Vec<P> = pb.iter().rev().copied().collect();
            let combos: [(&Vec<P>, &Vec<P>); 4] = [(pa, pb), (pa, &rb), (&ra, pb), (&ra, &rb)];
            for (x, y) in combos {
                if dist(*x.last().unwrap(), y[0]) < 0.5 {
                    let mut run = x.clone();
                    run.extend_from_slice(y);
                    let mut refs = a.refs.clone();
                    refs.extend_from_slice(&b.refs);
                    let joined = arc_of(&run, Drawn::Curve, refs);
                    if in_range(&joined, SWEEP_DEG.0) {
                        out.push(joined.unwrap());
                        used[i] = true;
                        used[j] = true;
                    }
                    break;
                }
            }
            if used[i] {
                break;
            }
        }
    }
    out
}

fn straight(run: &[P]) -> bool {
    let length: f64 = run.windows(2).map(|w| dist(w[0], w[1])).sum();
    dist(run[0], run[run.len() - 1]) > CHAIN_STRAIGHT * length
}

fn circle3(a: P, b: P, c: P) -> Option<(P, f64)> {
    let d = 2.0 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if d.abs() < 1e-6 {
        return None;
    }
    let (sa, sb, sc) = (a.x * a.x + a.y * a.y, b.x * b.x + b.y * b.y, c.x * c.x + c.y * c.y);
    let h = P::new(
        (sa * (b.y - c.y) + sb * (c.y - a.y) + sc * (a.y - b.y)) / d,
        (sa * (c.x - b.x) + sb * (a.x - c.x) + sc * (b.x - a.x)) / d,
    );
    Some((h, dist(h, a)))
}

/// The middle of the run sits near one circle (three points), so trimming its ends can pay.
fn near_circle(run: &[P]) -> bool {
    let n = run.len();
    let Some((h, r)) = circle3(run[n / 6], run[n / 2], run[n - 1 - n / 6]) else { return false };
    if !(MIN_R_PT..=MAX_R_PT).contains(&r) {
        return false;
    }
    let tol = 3.0 * FIT_TOL_PT.max(FIT_TOL_R * r);
    let step = (n / 12).max(1);
    let mut k = n / 6;
    while k < n - n / 6 {
        if (dist(h, run[k]) - r).abs() > tol {
            return false;
        }
        k += step;
    }
    true
}

/// The arc in a chained run. A walk often runs on into a jamb tick or a wall stroke, so a few points are tried off either end and
/// the tightest circle wins; among trims about as tight as the tightest, the one that keeps the most of the arc.
fn trimmed(run: &[P]) -> Option<Arc> {
    let n = run.len();
    if n > TRIM_MAX_POINTS || !near_circle(run) {
        if n < 6 {
            return None;
        }
        let whole = arc_of(run, Drawn::Strokes, vec![]);
        return if in_range(&whole, SWEEP_DEG.0) { whole } else { None };
    }
    let maxcut = (TRIM_MAX_CUT + 1).min(n.saturating_sub(5));
    let mut cuts: Vec<(usize, usize)> = vec![];
    for cut in 0..maxcut {
        for head in 0..=cut {
            cuts.push((head, cut - head));
        }
    }
    if cuts.is_empty() {
        return None;
    }
    let (mut mx, mut my) = (0.0, 0.0);
    for p in run {
        mx += p.x;
        my += p.y;
    }
    mx /= n as f64;
    my /= n as f64;
    let u: Vec<f64> = run.iter().map(|p| p.x - mx).collect();
    let v: Vec<f64> = run.iter().map(|p| p.y - my).collect();
    // running moments: 1, u, v, uu, vv, uv, u q, v q
    let mut cs = vec![[0.0f64; 8]; n + 1];
    for k in 0..n {
        let q = u[k] * u[k] + v[k] * v[k];
        let row = [1.0, u[k], v[k], u[k] * u[k], v[k] * v[k], u[k] * v[k], u[k] * q, v[k] * q];
        for t in 0..8 {
            cs[k + 1][t] = cs[k][t] + row[t];
        }
    }
    struct Fit {
        lo: usize,
        hi: usize,
        sweep: f64,
        misfit: f64,
        good: bool,
    }
    let mut fits: Vec<Fit> = Vec::with_capacity(cuts.len());
    for &(head, tail) in &cuts {
        let (lo, hi) = (head, n - tail);
        let mut s = [0.0f64; 8];
        for t in 0..8 {
            s[t] = cs[hi][t] - cs[lo][t];
        }
        let (a, b, c, d, e, f) = (s[3], s[5], s[1], s[4], s[2], s[0]);
        let (r0, r1, r2) = (-s[6], -s[7], -(s[3] + s[4]));
        let (k0, k1, k2) = (d * f - e * e, c * e - b * f, b * e - c * d);
        let (k4, k5, k8) = (a * f - c * c, b * c - a * e, a * d - b * b);
        let det = a * k0 + b * k1 + c * k2;
        let mut fit = Fit { lo, hi, sweep: 0.0, misfit: f64::INFINITY, good: false };
        if det.abs() > 1e-9 {
            let sol0 = (k0 * r0 + k1 * r1 + k2 * r2) / det;
            let sol1 = (k1 * r0 + k4 * r1 + k5 * r2) / det;
            let sol2 = (k2 * r0 + k5 * r1 + k8 * r2) / det;
            let (cu, cv) = (-sol0 / 2.0, -sol1 / 2.0);
            let r = (cu * cu + cv * cv - sol2).max(0.0).sqrt();
            let (mut worst, mut sum_off, mut turn) = (0.0f64, 0.0, 0.0);
            let (mut pos, mut neg) = (0usize, 0usize);
            for k in lo..hi {
                let (du, dv) = (u[k] - cu, v[k] - cv);
                let off = ((du * du + dv * dv).sqrt() - r).abs();
                worst = worst.max(off);
                sum_off += off;
                if k + 1 < hi {
                    let (eu, ev) = (u[k + 1] - cu, v[k + 1] - cv);
                    let st = (du * ev - dv * eu).atan2(du * eu + dv * ev);
                    if st > 0.005 {
                        pos += 1;
                    } else if st < -0.005 {
                        neg += 1;
                    }
                    turn += st;
                }
            }
            let sweep = turn.abs().to_degrees();
            fit.sweep = sweep;
            fit.good = (MIN_R_PT..=MAX_R_PT).contains(&r)
                && worst <= FIT_TOL_PT.max(FIT_TOL_R * r)
                && pos.min(neg) <= 1
                && sweep >= SWEEP_DEG.0.max(TRIM_MIN_SWEEP.1)
                && sweep <= SWEEP_DEG.1
                && hi - lo >= MIN_ARC_POINTS;
            if fit.good {
                fit.misfit = sum_off / (hi - lo) as f64;
            }
        }
        fits.push(fit);
    }
    if !fits.iter().any(|f| f.good) {
        return None;
    }
    if fits.iter().any(|f| f.good && f.sweep >= TRIM_MIN_SWEEP.0) {
        for f in fits.iter_mut() {
            if f.sweep < TRIM_MIN_SWEEP.0 {
                f.good = false;
                f.misfit = f64::INFINITY;
            }
        }
    }
    let best_fit = fits.iter().filter(|f| f.good).map(|f| f.misfit).fold(f64::INFINITY, f64::min);
    let limit = TRIM_FIT_SLACK.0 * best_fit + TRIM_FIT_SLACK.1;
    // close ones first, then the widest sweep, then the tightest fit (index breaks ties, as a stable sort would)
    let mut order: Vec<usize> = (0..fits.len()).collect();
    order.sort_by(|&i, &j| {
        let ci = fits[i].good && fits[i].misfit <= limit;
        let cj = fits[j].good && fits[j].misfit <= limit;
        cj.cmp(&ci)
            .then(fits[j].sweep.partial_cmp(&fits[i].sweep).unwrap())
            .then(fits[i].misfit.partial_cmp(&fits[j].misfit).unwrap())
            .then(i.cmp(&j))
    });
    let k = order[0];
    let best = arc_of(&run[fits[k].lo..fits[k].hi], Drawn::Strokes, vec![]);
    if in_range(&best, SWEEP_DEG.0) {
        best
    } else {
        None
    }
}

/// Hatching is thousands of short strokes at one angle: walking them finds no door.
fn without_hatch(strokes: Vec<Stroke>) -> Vec<Stroke> {
    if strokes.len() < HATCH_SAME_DIRECTION {
        return strokes;
    }
    let bucket = |s: &Stroke| (((s.b.y - s.a.y).atan2(s.b.x - s.a.x).to_degrees()).rem_euclid(180.0) / 0.5) as usize;
    let mut counts = vec![0usize; 362];
    for s in &strokes {
        counts[bucket(s).min(361)] += 1;
    }
    strokes.into_iter().filter(|s| counts[bucket(s).min(361)] < HATCH_SAME_DIRECTION).collect()
}

/// For every stroke end (row 2k + e), its NEIGHBOURS_KEPT nearest other stroke ends within `gap`, nearest first (ties by row).
struct Neighbours {
    dist: Vec<f64>,
    nbr: Vec<i64>,
}

fn end_neighbours(ends: &[P], gap: f64) -> Neighbours {
    let m = ends.len();
    let kk = NEIGHBOURS_KEPT;
    let mut dist_v = vec![0.0; m * kk];
    let mut nbr = vec![-1i64; m * kk];
    let key = |p: P| ((p.x / gap).floor() as i64, (p.y / gap).floor() as i64);
    let mut grid: HashMap<(i64, i64), Vec<u32>> = HashMap::default();
    for (k, p) in ends.iter().enumerate() {
        grid.entry(key(*p)).or_default().push(k as u32);
    }
    let mut cand: Vec<(f64, u32)> = Vec::new();
    for (row, p) in ends.iter().enumerate() {
        cand.clear();
        let (cx, cy) = key(*p);
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(list) = grid.get(&(cx + dx, cy + dy)) {
                    for &j in list {
                        if (j as usize) / 2 == row / 2 {
                            continue;
                        }
                        let q = ends[j as usize];
                        let (dx, dy) = (q.x - p.x, q.y - p.y);
                        let d = (dx * dx + dy * dy).sqrt();
                        if d <= gap {
                            cand.push((d, j));
                        }
                    }
                }
            }
        }
        if cand.len() > kk {
            cand.select_nth_unstable_by(kk - 1, |a, b| a.0.partial_cmp(&b.0).unwrap().then(a.1.cmp(&b.1)));
            cand.truncate(kk);
        }
        cand.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.1.cmp(&b.1)));
        for (t, (d, j)) in cand.iter().enumerate() {
            dist_v[row * kk + t] = *d;
            nbr[row * kk + t] = *j as i64;
        }
    }
    Neighbours { dist: dist_v, nbr }
}

fn stroke_ends(strokes: &[Stroke]) -> Vec<P> {
    let mut e = Vec::with_capacity(strokes.len() * 2);
    for s in strokes {
        e.push(s.a);
        e.push(s.b);
    }
    e
}

/// For each stroke end and each of its neighbours: could a walk standing there, heading out of its own stroke, take it next
/// (the walk's own tests, every stroke free, a hair of slack). A stroke neither of whose ends can step walks nowhere.
fn first_steps(ends: &[P], nb: &Neighbours) -> Vec<bool> {
    let kk = NEIGHBOURS_KEPT;
    let eps = 1e-9;
    let mut out = vec![false; nb.nbr.len()];
    for row in 0..ends.len() {
        let p = ends[row];
        let back = ends[row ^ 1];
        let mut v = p.sub(back);
        let l = v.norm().max(1e-300);
        v = P::new(v.x / l, v.y / l);
        for t in 0..kk {
            let q = nb.nbr[row * kk + t];
            if q < 0 {
                break;
            }
            let q = q as usize;
            let (a, b) = (ends[q], ends[q ^ 1]);
            let ab = b.sub(a);
            let mut seg = ab.norm();
            if seg <= 0.0 {
                seg = 1.0;
            }
            let turn = ab.dot(v) / seg >= TURN_COS - eps;
            let d = nb.dist[row * kk + t];
            let head = d <= 0.3 + eps || a.sub(p).dot(v) / (if d > 0.0 { d } else { 1.0 }) >= HEADING_COS - eps;
            out[row * kk + t] = turn && head;
        }
    }
    out
}

struct Walker<'a> {
    strokes: &'a [Stroke],
    ends: Vec<P>,
    lens: Vec<f64>,
    widest: &'a Neighbours,
    steppable: &'a [bool],
}

impl<'a> Walker<'a> {
    /// Faceted or dashed arcs: loose strokes walked end to end while the heading holds. Returns the arcs and the strokes each took.
    fn chain(&self, gap: f64, taken: &[bool], tiny: f64, fits: &mut HashMap<Vec<u64>, Option<Arc>>, mut coarse_out: Option<&mut Vec<Arc>>) -> Vec<(Arc, Vec<usize>)> {
        let kk = NEIGHBOURS_KEPT;
        let ns = self.strokes.len();
        let mut out = vec![];
        if ns == 0 {
            return out;
        }
        let within = |row: usize, t: usize| -> Option<(f64, usize)> {
            let q = self.widest.nbr[row * kk + t];
            let d = self.widest.dist[row * kk + t];
            if q < 0 || d > gap {
                None
            } else {
                Some((d, q as usize))
            }
        };
        let steps: Vec<bool> = (0..2 * ns).map(|row| (0..kk).any(|t| within(row, t).is_some() && self.steppable[row * kk + t])).collect();
        let mut claimed: Vec<bool> = taken.to_vec();
        let mut tries = vec![0u8; ns];
        let mut used: Vec<usize> = vec![];
        let mut in_used = vec![false; ns];
        for seed in 0..ns {
            if claimed[seed] || tries[seed] >= 3 {
                continue;
            }
            if !steps[2 * seed] && !steps[2 * seed + 1] {
                tries[seed] = 3;
                continue;
            }
            let s = self.strokes[seed];
            let mut head: Vec<P> = vec![];
            let mut tail: Vec<P> = vec![s.a, s.b];
            for &k in &used {
                in_used[k] = false;
            }
            used.clear();
            used.push(seed);
            in_used[seed] = true;
            for forward in [true, false] {
                let mut tip = 2 * seed + if forward { 1 } else { 0 };
                for _ in 0..CHAIN_MAX_STEPS {
                    let (p, back) = if forward {
                        let p = *tail.last().unwrap();
                        let back = tail.iter().rev().find(|q| dist(**q, p) >= 2.0).copied()
                            .or_else(|| head.iter().find(|q| dist(**q, p) >= 2.0).copied())
                            .unwrap_or(tail[tail.len() - 2]);
                        (p, back)
                    } else {
                        let p = if head.is_empty() { tail[0] } else { *head.last().unwrap() };
                        let back = head.iter().rev().find(|q| dist(**q, p) >= 2.0).copied()
                            .or_else(|| tail.iter().find(|q| dist(**q, p) >= 2.0).copied())
                            .unwrap_or(if head.is_empty() { tail[1] } else if head.len() > 1 { head[head.len() - 2] } else { tail[0] });
                        (p, back)
                    };
                    let mut length = dist(p, back);
                    if length == 0.0 {
                        length = 1.0;
                    }
                    let v = P::new((p.x - back.x) / length, (p.y - back.y) / length);
                    let mut best: Option<(usize, usize)> = None;
                    for t in 0..kk {
                        let Some((d, q)) = within(tip, t) else { break };
                        let (k, e) = (q >> 1, q & 1);
                        if in_used[k] || claimed[k] || tries[k] >= 3 {
                            continue;
                        }
                        let a = self.ends[2 * k + e];
                        let b = self.ends[2 * k + 1 - e];
                        let seg = self.lens[k];
                        if b.sub(a).dot(v) / seg < TURN_COS {
                            let lead = dist(b, back);
                            let ok_tiny = seg < tiny && b.sub(back).dot(v) / (if lead > 0.0 { lead } else { 1.0 }) >= TURN_COS;
                            if !ok_tiny {
                                continue;
                            }
                        }
                        if d > 0.3 && a.sub(p).dot(v) / d < HEADING_COS {
                            continue;
                        }
                        best = Some((k, e));
                        break;
                    }
                    let Some((k, e)) = best else { break };
                    used.push(k);
                    in_used[k] = true;
                    tip = 2 * k + 1 - e;
                    let (a, b) = (self.ends[2 * k + e], self.ends[2 * k + 1 - e]);
                    if forward {
                        tail.push(a);
                        tail.push(b);
                    } else {
                        head.push(a);
                        head.push(b);
                    }
                }
            }
            let mut run: Vec<P> = head.iter().rev().copied().collect();
            run.extend_from_slice(&tail);
            let mut sorted_used = used.clone();
            sorted_used.sort_unstable();
            let refs: Vec<u32> = sorted_used.iter().map(|k| self.strokes[*k].path).collect();
            if straight(&run) {
                for &k in &used {
                    tries[k] = 3;
                }
                if let Some(c) = coarse_out.as_deref_mut() {
                    if used.len() > 1 && used.len() <= COARSE_RUN_MAX {
                        coarse_windows(&run, &refs, c);
                    }
                }
                continue;
            }
            for &k in &used {
                tries[k] = tries[k].saturating_add(1);
            }
            let mut arc = None;
            if used.len() >= CHAIN_MIN_STROKES {
                let key: Vec<u64> = run.iter().flat_map(|p| [p.x.to_bits(), p.y.to_bits()]).collect();
                let got = fits.entry(key).or_insert_with(|| trimmed(&run)).clone();
                if let Some(mut a) = got {
                    a.refs = refs.clone();
                    for &k in &used {
                        claimed[k] = true;
                    }
                    out.push((a.clone(), sorted_used.clone()));
                    arc = Some(a);
                }
            }
            if arc.is_none() {
                if let Some(c) = coarse_out.as_deref_mut() {
                    if used.len() <= COARSE_RUN_MAX {
                        coarse_windows(&run, &refs, c);
                    }
                }
            }
        }
        out
    }
}

/// `coarse` of every two and three strokes in a row of a walk's run (a walk often runs on from the arc into a wall or the leaf).
fn coarse_windows(run: &[P], refs: &[u32], out: &mut Vec<Arc>) {
    let n = run.len() / 2;
    for w in [2usize, 3] {
        if n < w {
            continue;
        }
        for i in 0..=n - w {
            if let Some(c) = coarse(&run[2 * i..2 * (i + w)], refs) {
                out.push(c);
            }
        }
    }
}

/// The page draws its curves as loose point-long strokes, nearly every one its own path (an export that tessellates curves).
fn tessellated(strokes: &[Stroke], paths: &[Path]) -> bool {
    let tiny: Vec<&Stroke> = strokes.iter().filter(|s| dist(s.a, s.b) < CHAIN_TINY_PT).collect();
    if tiny.len() < TINY_PAGE.0 {
        return false;
    }
    let lone = tiny.iter().filter(|s| paths[s.path as usize].items.len() == 1).count();
    lone as f64 >= TINY_PAGE.1 * tiny.len() as f64
}

/// Every arc on the page, one record per drawn arc. `tiny`: walk the point-long strokes once more (Some(true)), not
/// (Some(false)), or only on a page that draws its curves in them (None).
pub fn page_arcs(paths: &[Path], tiny: Option<bool>) -> Vec<Arc> {
    let mut coarse: Vec<Arc> = vec![];
    let pa = path_arcs(paths, &mut coarse);
    let strokes = without_hatch(pa.strokes);
    let mut arcs = pa.arcs;
    let mut joined = vec![];
    arcs.extend(join_pieces(&pa.pieces, &mut joined));
    if SHORT_SWINGS {
        // a part-open swing drawn as one short curve (a leaf drawn at 30 degrees): judged as a coarse arc is, by its leaf to one
        // end, a wall running on from the other and a wall at the hinge
        for (k, (a, _)) in pa.pieces.iter().enumerate() {
            if !joined[k] && a.sweep >= COARSE_SWEEP_DEG.0 && a.sweep < SWEEP_DEG.0 {
                let mut c = a.clone();
                c.drawn = Drawn::Coarse;
                c.piece = true;
                coarse.push(c);
            }
        }
    }
    let ends = stroke_ends(&strokes);
    let lens: Vec<f64> = strokes.iter().map(|s| {
        let l = dist(s.a, s.b);
        if l > 0.0 { l } else { 1.0 }
    }).collect();
    let widest = end_neighbours(&ends, CHAIN_GAPS_PT[1]);
    let steppable = first_steps(&ends, &widest);
    let walker = Walker { strokes: &strokes, ends, lens, widest: &widest, steppable: &steppable };
    let mut fits: HashMap<Vec<u64>, Option<Arc>> = HashMap::default();
    let mut taken = vec![false; strokes.len()];
    let none = vec![false; strokes.len()];
    for (g, &gap) in CHAIN_GAPS_PT.iter().enumerate() {
        let got = walker.chain(gap, &none, 0.0, &mut fits, if g == 0 { Some(&mut coarse) } else { None });
        for (a, used) in got {
            for k in used {
                taken[k] = true;
            }
            arcs.push(a);
        }
    }
    if tiny.unwrap_or_else(|| tessellated(&strokes, paths)) {
        let got = walker.chain(CHAIN_GAPS_PT[0], &taken, CHAIN_TINY_PT, &mut fits, None);
        arcs.extend(got.into_iter().map(|(a, _)| a));
    }
    // one record per drawn arc
    let mut out: Vec<Arc> = vec![];
    let mut grid: HashMap<(i64, i64), Vec<(usize, P)>> = HashMap::default();
    for a in arcs {
        let c = P::new((a.bbox[0] + a.bbox[2]) / 2.0, (a.bbox[1] + a.bbox[3]) / 2.0);
        let key = ((c.x / 4.0).floor() as i64, (c.y / 4.0).floor() as i64);
        let tol = 0.5f64.max(0.06 * a.r);
        let mut dup = false;
        'outer: for x in key.0 - 1..=key.0 + 1 {
            for y in key.1 - 1..=key.1 + 1 {
                if let Some(list) = grid.get(&(x, y)) {
                    for &(o, oc) in list {
                        if dist(c, oc) < tol && (a.r - out[o].r).abs() < tol && dist(a.hinge, out[o].hinge) < tol {
                            dup = true;
                            break 'outer;
                        }
                    }
                }
            }
        }
        if !dup {
            grid.entry(key).or_default().push((out.len(), c));
            out.push(a);
        }
    }
    if !coarse.is_empty() {
        let mut centres: HashMap<(i64, i64), Vec<usize>> = HashMap::default();
        for (k, a) in out.iter().enumerate() {
            centres.entry(((a.hinge.x / 8.0).floor() as i64, (a.hinge.y / 8.0).floor() as i64)).or_default().push(k);
        }
        for c in coarse {
            let (cx, cy) = ((c.hinge.x / 8.0).floor() as i64, (c.hinge.y / 8.0).floor() as i64);
            let mut near = false;
            for x in cx - 1..=cx + 1 {
                for y in cy - 1..=cy + 1 {
                    if let Some(list) = centres.get(&(x, y)) {
                        for &k in list {
                            let a = &out[k];
                            if dist(a.hinge, c.hinge) < 1.0f64.max(0.15 * c.r) && (a.r - c.r).abs() < 0.15 * c.r {
                                near = true;
                            }
                        }
                    }
                }
            }
            if !near {
                centres.entry((cx, cy)).or_default().push(out.len());
                out.push(c);
            }
        }
    }
    out
}
