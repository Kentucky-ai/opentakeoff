//! Why two swings were or were not joined as a pair: every two kept swings hinged about two leaf widths apart, near a point.
//!   cargo run --release --example whypair -- <sheet.bin> <x> <y> <radius pt> [fpp]
use door_reader::{arcs, doors, paths_from, segs};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let buf = std::fs::read(&a[1]).unwrap();
    let ni = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
    let np = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
    let f: Vec<f64> = buf[8..].chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
    let paths = paths_from(&f[..ni * 10], &f[ni * 10..ni * 10 + np * 2]);
    let (x, y, rad): (f64, f64, f64) = (a[2].parse().unwrap(), a[3].parse().unwrap(), a[4].parse().unwrap());
    let segs = segs::Segments::new(&paths);
    let found = arcs::page_arcs(&paths, None);
    let ring = doors::rings(&found);
    let live: Vec<_> = found.iter().cloned().zip(ring.iter()).filter(|(_, r)| !**r).map(|(a, _)| a).collect();
    let fpp = a.get(5).map(|s| s.parse().unwrap()).or_else(|| doors::scale_from_arcs(&live, &segs)).unwrap();
    let mut kept = doors::one_per_swing(doors::keep(&live, fpp, &paths, &segs));
    let chords = doors::chord_swings(&kept, &segs, fpp);
    kept.extend(chords);
    doors::stalls(&mut kept, &segs, fpp);
    let near: Vec<_> = kept.into_iter().filter(|k| (k.hinge.x - x).hypot(k.hinge.y - y) <= rad).collect();
    println!("fpp {fpp:.5}, {} kept swings within {rad} pt", near.len());
    for l in doors::pair_why(&near, fpp, &segs) {
        println!("{l}");
    }
}
