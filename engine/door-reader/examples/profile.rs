//! Native timing of the reader's stages on a dumped sheet (web/bench/doors/dump.mts).
//!   cargo run --release --example profile -- <sheet.bin> [fpp]
use door_reader::{arcs, doors, paths_from, segs};
use std::time::Instant;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let buf = std::fs::read(&a[1]).unwrap();
    let ni = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
    let np = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
    let f: Vec<f64> = buf[8..].chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
    let paths = paths_from(&f[..ni * 10], &f[ni * 10..ni * 10 + np * 2]);
    let t = Instant::now();
    let segs = segs::Segments::new(&paths);
    let t1 = t.elapsed();
    let found = arcs::page_arcs(&paths, None);
    let t2 = t.elapsed();
    let ring = doors::rings(&found);
    let live: Vec<_> = found.iter().cloned().zip(ring.iter()).filter(|(_, r)| !**r).map(|(a, _)| a).collect();
    let t3 = t.elapsed();
    let fpp = doors::scale_from_arcs(&live, &segs);
    let t4 = t.elapsed();
    let kept = doors::keep(&live, fpp.unwrap_or(1.0 / 9.0), &paths, &segs);
    let t5 = t.elapsed();
    let all = t.elapsed();
    let r = door_reader::read(&paths, a.get(2).map(|s| s.parse().unwrap()));
    eprintln!("items {ni} paths {np} arcs {} kept {} doors {} | segs {:?} arcs {:?} rings {:?} scale {:?} keep {:?} | full read {:?}",
        found.len(), kept.len(), r.doors.len(), t1, t2 - t1, t3 - t2, t4 - t3, t5 - t4, t.elapsed() - all);
}
