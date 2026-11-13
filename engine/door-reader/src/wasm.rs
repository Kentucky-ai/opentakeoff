//! The WebAssembly boundary: flat f64 arrays in, flat f64 array out. No bindgen, no allocator tricks.
//!
//! Input (written by the caller into memory from `dr_alloc`):
//! - items: `n_items` records of 10 f64 `[path, kind, x0, y0, x1, y1, x2, y2, x3, y3]` in drawing order, page points
//!   (unrotated, y down). kind 0 = line (x0 y0 -> x1 y1), 1 = cubic Bezier (start, control, control, end), 2 = edge of a
//!   rectangle or quad figure (a segment that is never part of a faceted arc).
//! - paths: `n_paths` records of 2 f64 `[dashed, dark_fill]` (0 or 1).
//!
//! Output (`dr_out_ptr`, `dr_read`'s return value f64s long): `[n_doors, fpp (NaN = none), scale source (0 none, 1 given,
//! 2 arcs), arcs read]`, then per door 32 f64: `bbox x0 y0 x1 y1, pair, stall, dashed, leaves, confidence, doubt bits` (confidence.rs),
//! then two leaves of 11:
//! `hinge x, hinge y, radius pt, leaf tip x, leaf tip y, drawn (0 curve, 1 polyline, 2 strokes, 3 coarse), sweep deg, misfit pt,
//! jamb ft (NaN: no wall at the hinge), strike (wall runs on from the closed end), leaf (0 drawn, 1 dashed, 2 none, 3 part-open)`
//! (NaN for a single's second leaf).

use crate::geom::{Drawn, Item, Path, P};
use crate::{read, ScaleSource};
use std::cell::RefCell;

pub const ITEM_F64: usize = 10;
pub const PATH_F64: usize = 2;
pub const DOOR_F64: usize = 10 + 2 * LEAF_F64;
pub const LEAF_F64: usize = 11;
pub const HEAD_F64: usize = 4;

thread_local! {
    static OUT: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };
}

/// Paths from the flat arrays.
pub fn paths_from(items: &[f64], paths: &[f64]) -> Vec<Path> {
    let n_paths = paths.len() / PATH_F64;
    let mut out: Vec<Path> = (0..n_paths)
        .map(|k| Path { items: vec![], dashed: paths[k * PATH_F64] != 0.0, dark_fill: paths[k * PATH_F64 + 1] != 0.0 })
        .collect();
    for r in items.chunks_exact(ITEM_F64) {
        let k = r[0] as usize;
        if k >= out.len() {
            continue;
        }
        let p = |i: usize| P::new(r[2 + 2 * i], r[3 + 2 * i]);
        let item = match r[1] as i32 {
            0 => Item::Line(p(0), p(1)),
            1 => Item::Curve(p(0), p(1), p(2), p(3)),
            _ => Item::Edge(p(0), p(1)),
        };
        out[k].items.push(item);
    }
    out
}

/// The reading as the flat output layout.
pub fn encode(paths: &[Path], fpp: Option<f64>) -> Vec<f64> {
    let got = read(paths, fpp);
    let mut o = Vec::with_capacity(HEAD_F64 + DOOR_F64 * got.doors.len());
    o.push(got.doors.len() as f64);
    o.push(got.fpp.unwrap_or(f64::NAN));
    o.push(match got.scale_source {
        ScaleSource::None => 0.0,
        ScaleSource::Given => 1.0,
        ScaleSource::Arcs => 2.0,
    });
    o.push(got.arcs as f64);
    let style = crate::confidence::page_style(&got.doors);
    let radii: Vec<f64> = got.doors.iter().flat_map(|d| d.leaves.iter().map(|a| a.r)).collect();
    for d in &got.doors {
        o.extend_from_slice(&d.bbox);
        o.push(d.pair as u8 as f64);
        o.push(d.stall as u8 as f64);
        o.push(d.dashed as u8 as f64);
        o.push(d.leaves.len() as f64);
        let bits = crate::confidence::doubts(d, got.fpp.unwrap_or(1.0), style, &radii);
        o.push(crate::confidence::score(bits));
        o.push(bits as f64);
        for k in 0..2 {
            match d.leaves.get(k) {
                Some(a) => {
                    let drawn = match a.drawn { Drawn::Curve => 0.0, Drawn::Polyline => 1.0, Drawn::Strokes => 2.0, Drawn::Coarse => 3.0 };
                    let leaf = if a.leafless { 2.0 } else if a.leaf_dashes { 1.0 } else if a.drawn == Drawn::Coarse { 3.0 } else { 0.0 };
                    o.extend_from_slice(&[a.hinge.x, a.hinge.y, a.r, a.leaf_far.x, a.leaf_far.y, drawn, a.sweep, a.misfit, a.jamb, a.strike as u8 as f64, leaf]);
                }
                None => o.extend_from_slice(&[f64::NAN; LEAF_F64]),
            }
        }
    }
    o
}

#[no_mangle]
pub extern "C" fn dr_alloc(n_f64: usize) -> *mut f64 {
    let mut v: Vec<f64> = vec![0.0; n_f64.max(1)];
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` must come from `dr_alloc(n_f64)` with the same `n_f64`, freed once.
#[no_mangle]
pub unsafe extern "C" fn dr_free(ptr: *mut f64, n_f64: usize) {
    drop(Vec::from_raw_parts(ptr, n_f64.max(1), n_f64.max(1)));
}

/// Reads the page; returns the output's length in f64. `fpp` <= 0 or NaN: no scale given.
///
/// # Safety
/// `items` / `paths` must point at `n_items * 10` / `n_paths * 2` initialised f64 (from `dr_alloc`).
#[no_mangle]
pub unsafe extern "C" fn dr_read(items: *const f64, n_items: usize, paths: *const f64, n_paths: usize, fpp: f64) -> usize {
    let items = if n_items == 0 { &[][..] } else { std::slice::from_raw_parts(items, n_items * ITEM_F64) };
    let paths = if n_paths == 0 { &[][..] } else { std::slice::from_raw_parts(paths, n_paths * PATH_F64) };
    let ps = paths_from(items, paths);
    let fpp = if fpp > 0.0 && fpp.is_finite() { Some(fpp) } else { None };
    let out = encode(&ps, fpp);
    let n = out.len();
    OUT.with(|o| *o.borrow_mut() = out);
    n
}

#[no_mangle]
pub extern "C" fn dr_out_ptr() -> *const f64 {
    OUT.with(|o| o.borrow().as_ptr())
}
