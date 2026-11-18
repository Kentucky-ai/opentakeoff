//! How sure the reader is that a find is a door, from the evidence it read: how the swing is drawn, the leaf, the wall at the
//! hinge, the jamb at the strike, the swing's size. Each piece of doubt subtracts its weight from 1; the caller commits finds at
//! or above a cutoff and returns the rest as withheld, with the reasons. Weights and cutoffs were chosen on development
//! sheets only (see WEIGHTS) and are frozen with the reader version.

use crate::doors::Door;
use crate::geom::Drawn;

/// One kind of doubt: its name (the withheld reason) and weight.
pub struct Doubt {
    pub name: &'static str,
    pub weight: f64,
}

pub const DOUBTS: [Doubt; 16] = [
    Doubt { name: "arc drawn as a polyline", weight: W[0] },
    Doubt { name: "arc drawn unlike the page's other swings", weight: W[1] },
    Doubt { name: "arc off its circle", weight: W[2] },
    Doubt { name: "no leaf drawn", weight: W[3] },
    Doubt { name: "dashed leaf", weight: W[4] },
    Doubt { name: "leaf under 2 ft", weight: W[5] },
    Doubt { name: "leaf over 3'-7\"", weight: W[6] },
    Doubt { name: "jamb under 3 in", weight: W[7] },
    Doubt { name: "no wall at the hinge", weight: W[8] },
    Doubt { name: "no wall past the strike", weight: W[9] },
    Doubt { name: "toilet-partition stall", weight: W[10] },
    Doubt { name: "swing of 60 to 80 degrees", weight: W[11] },
    Doubt { name: "drawn dashed", weight: W[12] },
    Doubt { name: "unlike the page's swings, one of 10+ alike", weight: W[13] },
    Doubt { name: "under 2 ft, one of 10+ alike", weight: W[14] },
    Doubt { name: "over 3'-7\", one of 10+ alike", weight: W[15] },
];

/// Leaves on the page whose radius is within 5% of this one (itself included): a family of alike doors is read at one scale and
/// drawn one way, so its size and style are the drawing's convention, not a doubt.
pub const FAMILY_MIN: usize = 10;
pub fn family_size(r: f64, radii: &[f64]) -> usize {
    radii.iter().filter(|x| (*x - r).abs() <= 0.05 * r).count()
}

/// Weights, chosen on development sheets only.
/// Logistic regression of "false find" on these doubts over a private development set of CAD plans whose door layers give the answer,
/// refit after the style families (curve vs faceted) and the same-size family split: each coefficient divided by the
/// intercept's magnitude (5.01), so confidence >= 0 means the model puts a find at no worse than even odds of being a door. Doubts
/// the keep rule already drops (off its circle, dashed leaf) weigh 0, and so does "under 2 ft, one of 10+ alike" (a family of
/// alike doors read small is the drawing's scale, not a doubt).
pub const W: [f64; 16] = [0.05, 0.92, 0.0, 0.83, 0.0, 0.75, 0.17, 0.58, 0.01, 0.24, 0.76, 0.31, 0.0, 0.58, 0.0, 0.03];

/// Cutoffs, chosen on the development set and frozen before any held-out read: found-first keeps nearly every door found,
/// balanced gives up about 1% of them, precision-first sits where precision stops rising.
pub const CUTOFF_FOUND_FIRST: f64 = 0.0;
pub const CUTOFF_BALANCED: f64 = 0.3;
pub const CUTOFF_PRECISION_FIRST: f64 = 0.55;

/// Bit k set = DOUBTS[k] applies to this door (worst leaf of a pair).
/// Two drawing styles: true curves (Bezier) and faceted arcs (a polyline in one path, or the same facets as loose strokes, which
/// exports emit interchangeably for one door block).
fn family(d: Drawn) -> Option<u8> {
    match d {
        Drawn::Curve => Some(0),
        Drawn::Polyline | Drawn::Strokes => Some(1),
        Drawn::Coarse | Drawn::Chord => None,
    }
}

/// The style most of the page's door swings are drawn in, when 60% or more share one.
pub fn page_style(doors: &[Door]) -> Option<u8> {
    let mut n = [0usize; 2];
    for d in doors {
        for a in &d.leaves {
            if let Some(f) = family(a.drawn) {
                n[f as usize] += 1;
            }
        }
    }
    let total = n[0] + n[1];
    let k = if n[0] >= n[1] { 0 } else { 1 };
    if total >= 3 && n[k] as f64 >= 0.6 * total as f64 {
        Some(k as u8)
    } else {
        None
    }
}

pub fn doubts(d: &Door, fpp: f64, style: Option<u8>, radii: &[f64]) -> u32 {
    let mut bits = 0u32;
    for a in &d.leaves {
        let r_ft = a.r * fpp;
        let mut set = |k: usize, on: bool| {
            if on {
                bits |= 1 << k
            }
        };
        set(0, a.drawn == Drawn::Polyline);
        let alike = family_size(a.r, radii) >= FAMILY_MIN;
        let unlike = matches!((style, family(a.drawn)), (Some(st), Some(f)) if st != f);
        set(1, unlike && !alike);
        set(13, unlike && alike);
        set(2, a.drawn != Drawn::Coarse && a.misfit >= 0.002 * a.r);
        set(3, a.leafless);
        set(4, a.leaf_dashes);
        set(5, r_ft < 2.0 && !alike);
        set(6, r_ft >= 3.6 && !alike);
        set(14, r_ft < 2.0 && alike);
        set(15, r_ft >= 3.6 && alike);
        set(7, a.jamb.is_finite() && a.jamb < 0.25);
        set(8, !a.jamb.is_finite());
        set(9, !a.strike);
        set(11, a.drawn != Drawn::Coarse && (60.0..80.0).contains(&a.sweep));
    }
    if d.stall {
        bits |= 1 << 10;
    }
    if d.dashed {
        bits |= 1 << 12;
    }
    bits
}

pub fn score(bits: u32) -> f64 {
    let mut s = 1.0;
    for (k, d) in DOUBTS.iter().enumerate() {
        if bits & (1 << k) != 0 {
            s -= d.weight;
        }
    }
    s
}
