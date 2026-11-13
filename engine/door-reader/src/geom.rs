//! Points, the input page, and the arc record every stage passes along.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct P {
    pub x: f64,
    pub y: f64,
}

impl P {
    pub const fn new(x: f64, y: f64) -> P {
        P { x, y }
    }
    pub fn sub(self, o: P) -> P {
        P::new(self.x - o.x, self.y - o.y)
    }
    pub fn dot(self, o: P) -> f64 {
        self.x * o.x + self.y * o.y
    }
    pub fn norm(self) -> f64 {
        (self.x * self.x + self.y * self.y).sqrt()
    }
}

pub fn dist(a: P, b: P) -> f64 {
    let (dx, dy) = (a.x - b.x, a.y - b.y);
    (dx * dx + dy * dy).sqrt()
}

/// One drawn piece of a path, in page points (unrotated, y down).
#[derive(Clone, Copy, Debug)]
pub enum Item {
    /// A straight stroke the drafter drew as a line.
    Line(P, P),
    /// A cubic Bezier: start, two controls, end.
    Curve(P, P, P, P),
    /// One edge of a rectangle (or quad) figure: a straight segment, never part of a faceted arc.
    Edge(P, P),
}

/// One painted path: its pieces in drawing order, whether it is stroked with a dash pattern, and whether it is filled dark.
#[derive(Clone, Debug, Default)]
pub struct Path {
    pub items: Vec<Item>,
    pub dashed: bool,
    pub dark_fill: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Drawn {
    Curve,
    Polyline,
    Strokes,
    Coarse,
}

/// A circular arc read off the page: the centre stands for a door's hinge, the radius for its leaf.
#[derive(Clone, Debug)]
pub struct Arc {
    pub hinge: P,
    pub r: f64,
    pub sweep: f64,
    pub misfit: f64,
    pub ends: [P; 2],
    pub bbox: [f64; 4],
    pub drawn: Drawn,
    /// Paths the arc was read from.
    pub refs: Vec<u32>,
    // set by the keep rule
    pub dashed: bool,
    pub leaf_dashes: bool,
    pub leafless: bool,
    pub leaf_far: P,
    pub stall: bool,
    /// a piece already joined with another (takes no third)
    pub joined: bool,
    /// a short swing read from one true curve (judged as a coarse arc, but still counted as part of a drawn circle)
    pub piece: bool,
    /// evidence for the confidence score (set by the keep rule)
    pub jamb: f64,
    pub strike: bool,
}

impl Arc {
    pub fn swing_box(&self) -> [f64; 4] {
        let b = self.bbox;
        let h = self.hinge;
        [b[0].min(h.x), b[1].min(h.y), b[2].max(h.x), b[3].max(h.y)]
    }
}

pub fn iou(p: &[f64; 4], q: &[f64; 4]) -> f64 {
    let w = (p[2].min(q[2]) - p[0].max(q[0])).max(0.0);
    let h = (p[3].min(q[3]) - p[1].max(q[1])).max(0.0);
    let i = w * h;
    i / ((p[2] - p[0]) * (p[3] - p[1]) + (q[2] - q[0]) * (q[3] - q[1]) - i).max(1e-9)
}

/// Start and end angle about the centre, counter-clockwise, degrees (end - start = the arc's sweep, under 180).
pub fn angles(a: &Arc) -> (f64, f64) {
    let h = a.hinge;
    let ang = |e: P| ((e.y - h.y).atan2(e.x - h.x).to_degrees()).rem_euclid(360.0);
    let (mut t0, mut t1) = (ang(a.ends[0]), ang(a.ends[1]));
    if (t1 - t0).rem_euclid(360.0) > 180.0 {
        std::mem::swap(&mut t0, &mut t1);
    }
    (t0, t0 + (t1 - t0).rem_euclid(360.0))
}

/// Degrees of a full turn covered by these arcs (1-degree cells).
pub fn cover_deg<'a>(arcs: impl Iterator<Item = &'a Arc>) -> usize {
    let mut cover = [false; 360];
    for a in arcs {
        let (t0, t1) = angles(a);
        let mut k = t0 as i64;
        let end = t1.ceil() as i64;
        while k < end {
            cover[k.rem_euclid(360) as usize] = true;
            k += 1;
        }
    }
    cover.iter().filter(|c| **c).count()
}

/// Python-style round half to even (the scale bins are keyed this way).
pub fn round_even(x: f64) -> i64 {
    let r = x.round();
    if (x - x.trunc()).abs() == 0.5 {
        let f = x.floor();
        if (f as i64) % 2 == 0 {
            f as i64
        } else {
            f as i64 + 1
        }
    } else {
        r as i64
    }
}

pub fn median(v: &mut [f64]) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        0.5 * (v[n / 2 - 1] + v[n / 2])
    }
}

/// A fast deterministic hasher for the grid keys (std's SipHash is slow in WebAssembly).
#[derive(Default, Clone, Copy)]
pub struct FxHasher(u64);

impl std::hash::Hasher for FxHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 = (self.0.rotate_left(5) ^ *b as u64).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
        }
    }
    fn write_u64(&mut self, n: u64) {
        self.0 = (self.0.rotate_left(5) ^ n).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
    fn write_i64(&mut self, n: i64) {
        self.write_u64(n as u64);
    }
    fn write_usize(&mut self, n: usize) {
        self.write_u64(n as u64);
    }
}

pub type Map<K, V> = std::collections::HashMap<K, V, std::hash::BuildHasherDefault<FxHasher>>;
