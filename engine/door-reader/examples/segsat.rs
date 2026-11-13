//! The straight pieces near a box, as the reader sees them: path, kind, dashed, ends, length.
//!   cargo run --release --example segsat -- <sheet.bin> x0 y0 x1 y1
use door_reader::{geom::Item, paths_from};
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let buf = std::fs::read(&a[1]).unwrap();
    let ni = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
    let np = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
    let f: Vec<f64> = buf[8..].chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
    let paths = paths_from(&f[..ni * 10], &f[ni * 10..ni * 10 + np * 2]);
    let b: Vec<f64> = a[2..6].iter().map(|s| s.parse().unwrap()).collect();
    let inb = |x: f64, y: f64| x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
    for (k, p) in paths.iter().enumerate() {
        for it in &p.items {
            let (kind, s, e) = match *it { Item::Line(s, e) => ("L", s, e), Item::Edge(s, e) => ("E", s, e), Item::Curve(s, _, _, e) => ("C", s, e) };
            if inb(s.x, s.y) || inb(e.x, e.y) {
                let l = ((e.x - s.x).powi(2) + (e.y - s.y).powi(2)).sqrt();
                println!("p{k} {kind} dash={} ({:.2},{:.2})-({:.2},{:.2}) len {:.2} n_items {}", p.dashed as u8, s.x, s.y, e.x, e.y, l, p.items.len());
            }
        }
    }
}
