//! Arcless chord doors on a sheet: hinge, strike jamb, leaf tip.  cargo run --release --example chords -- <sheet.bin> <fpp>
use door_reader::{paths_from, segs};
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let buf = std::fs::read(&a[1]).unwrap();
    let ni = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
    let np = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
    let f: Vec<f64> = buf[8..].chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
    let paths = paths_from(&f[..ni * 10], &f[ni * 10..ni * 10 + np * 2]);
    let fpp: f64 = a[2].parse().unwrap();
    let sg = segs::Segments::new(&paths);
    if a.len() >= 9 {
        let v: Vec<f64> = a[3..9].iter().map(|s| s.parse().unwrap()).collect();
        let (h, s, t) = (door_reader::geom::P::new(v[0], v[1]), door_reader::geom::P::new(v[2], v[3]), door_reader::geom::P::new(v[4], v[5]));
        let w = (t.x - h.x).hypot(t.y - h.y);
        println!("covered {:.2} of w {:.2}; dashed {}", sg.covered(h, s, 0.04 * w), w, sg.dashed_between(s, t));
        return;
    }
    for (h, s, t) in sg.chord_doors(1.45 / fpp, 4.6 / fpp) {
        println!("h ({:.1},{:.1}) s ({:.1},{:.1}) t ({:.1},{:.1}) w_ft {:.2}", h.x, h.y, s.x, s.y, t.x, t.y, ((t.x - h.x).hypot(t.y - h.y)) * fpp);
    }
}
// probe: chords <bin> <fpp> hx hy sx sy tx ty
#[allow(dead_code)]
fn probe() {}
