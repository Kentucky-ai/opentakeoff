//! Why the reader missed these doors: every arc read near each box, and the keep rule's verdict on it.
//!   cargo run --release --example why -- <sheet.bin> <boxes.json: [[x0,y0,x1,y1], ...]> [fpp]
use door_reader::{arcs, doors, paths_from, segs};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let buf = std::fs::read(&a[1]).unwrap();
    let ni = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
    let np = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
    let f: Vec<f64> = buf[8..].chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
    let paths = paths_from(&f[..ni * 10], &f[ni * 10..ni * 10 + np * 2]);
    let boxes: Vec<Vec<f64>> = parse_boxes(&std::fs::read_to_string(&a[2]).unwrap());
    let segs = segs::Segments::new(&paths);
    let found = arcs::page_arcs(&paths, None);
    let ring = doors::rings(&found);
    let live: Vec<_> = found.iter().cloned().zip(ring.iter()).filter(|(_, r)| !**r).map(|(a, _)| a).collect();
    let fpp = a.get(3).map(|s| s.parse().unwrap()).or_else(|| doors::scale_from_arcs(&live, &segs)).unwrap();
    let verdicts = doors::judge_all(&live, fpp, &paths, &segs);
    for b in &boxes {
        let pad = 0.25 * (b[2] - b[0]).max(b[3] - b[1]);
        print!("box {:.0},{:.0} {:.0}x{:.0}:", b[0], b[1], b[2] - b[0], b[3] - b[1]);
        let mut any = false;
        for (k, x) in found.iter().enumerate() {
            let c = ((x.bbox[0] + x.bbox[2]) / 2.0, (x.bbox[1] + x.bbox[3]) / 2.0);
            if c.0 < b[0] - pad || c.0 > b[2] + pad || c.1 < b[1] - pad || c.1 > b[3] + pad {
                continue;
            }
            any = true;
            let v = if ring[k] { "ring".to_string() } else {
                let li = live.iter().position(|l| l.hinge == x.hinge && l.r == x.r && l.ends == x.ends).unwrap();
                match &verdicts[li] { Ok(k) => format!("KEPT h=({:.1},{:.1}) ends=({:.1},{:.1})/({:.1},{:.1}) tip=({:.1},{:.1})", k.hinge.x, k.hinge.y, k.ends[0].x, k.ends[0].y, k.ends[1].x, k.ends[1].y, k.leaf_far.x, k.leaf_far.y), Err(e) => e.to_string() }
            };
            print!(" [{:?} r={:.1}ft sw={:.0} mis={:.3} -> {}]", x.drawn, x.r * fpp, x.sweep, x.misfit, v);
        }
        if !any { print!(" NO ARC"); }
        println!();
    }
}

fn parse_boxes(s: &str) -> Vec<Vec<f64>> {
    let nums: Vec<f64> = s.split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == 'e')).filter(|t| !t.is_empty()).map(|t| t.parse().unwrap()).collect();
    nums.chunks_exact(4).map(|c| c.to_vec()).collect()
}
