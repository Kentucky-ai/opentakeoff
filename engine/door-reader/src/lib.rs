//! OpenTakeoff door reader: every door swing drawn on a plan page, read from the page's own vector linework.
//!
//! A swing door is drawn as a circular arc about the hinge plus a straight leaf from the hinge out to one end of that arc. The arc
//! reaches the PDF as Bezier curves, as a polyline, or as loose short strokes (each possibly its own path, possibly dashed), so all
//! three are read into one list of arcs. An arc is kept as a door when it has its leaf (drawn, dashed, or a quarter arc spanning a
//! wall opening) and hangs on a wall thicker than a partition panel. Toilet-partition stalls are marked; two leaves hinged one door
//! apart and drawn alike are one pair. Without a sheet scale, the commonest leafed radius is taken as a 3-ft door.
//!
//! Deterministic, no model, no dependencies. The caller extracts the page's paths (pdf.js in the app) and hands them over as flat
//! arrays; see `wasm` for the layout.

pub mod arcs;
pub mod confidence;
pub mod doors;
pub mod geom;
pub mod segs;
mod wasm;

use geom::{Arc, Path};

/// Arcs chained end to end at both ends (revision-cloud scallops) are never doors.
const DROP_CLOUDS: bool = true;

pub use doors::Door;
pub use wasm::{encode, paths_from};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScaleSource {
    None,
    Given,
    Arcs,
}

pub struct Reading {
    pub doors: Vec<Door>,
    pub fpp: Option<f64>,
    pub scale_source: ScaleSource,
    pub arcs: usize,
}

fn without(found: Vec<Arc>, drop: &[bool]) -> Vec<Arc> {
    let cloud = if DROP_CLOUDS { doors::cloud_scallops(&found) } else { vec![false; found.len()] };
    let drop: Vec<bool> = drop.iter().zip(cloud.iter()).map(|(a, b)| *a || *b).collect();
    found.into_iter().zip(drop.iter()).filter(|(_, d)| !**d).map(|(a, _)| a).collect()
}

/// The page's doors. `fpp`: feet per page point at the sheet's scale, when known.
pub fn read(paths: &[Path], fpp: Option<f64>) -> Reading {
    let segs = segs::Segments::new(paths);
    let mut found = arcs::page_arcs(paths, None);
    let n_found;
    let mut fpp = fpp.filter(|f| *f > 0.0 && f.is_finite());
    let mut source = if fpp.is_some() { ScaleSource::Given } else { ScaleSource::None };
    let ring = doors::rings(&found);
    let mut live = without(found.clone(), &ring);
    if fpp.is_none() {
        fpp = doors::scale_from_arcs(&live, &segs);
        if fpp.is_none() {
            // too few leafed arcs to tell the scale: every arc the walks can find has its say
            found = arcs::page_arcs(paths, Some(true));
            let ring = doors::rings(&found);
            live = without(found.clone(), &ring);
            fpp = doors::scale_from_arcs(&live, &segs);
        }
        if fpp.is_some() {
            source = ScaleSource::Arcs;
        }
    }
    n_found = found.len();
    let Some(mut f) = fpp else {
        return Reading { doors: vec![], fpp: None, scale_source: ScaleSource::None, arcs: n_found };
    };
    let mut kept = doors::keep(&live, f, paths, &segs);
    if source == ScaleSource::Given {
        let least = if kept.is_empty() { 3 } else { doors::SCALE_CHECK_MIN };
        if let Some(better) = doors::door_scale(&live, &segs, f, least) {
            let more = doors::keep(&live, better, paths, &segs);
            if more.len() as f64 >= doors::SCALE_SWITCH_GAIN * kept.len() as f64 + 2.0 {
                f = better;
                source = ScaleSource::Arcs;
                kept = more;
            }
        }
    }
    let mut kept = doors::one_per_swing(kept);
    doors::stalls(&mut kept, &segs, f);
    Reading { doors: doors::doors(&kept, f), fpp: Some(f), scale_source: source, arcs: n_found }
}
