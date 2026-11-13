//! Every arc read whose box centre is in a region, with its fit: `arcat <sheet.bin> x0 y0 x1 y1`
use door_reader::{arcs, paths_from};
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let buf = std::fs::read(&a[1]).unwrap();
    let ni = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
    let np = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
    let v: Vec<f64> = buf[8..].chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
    let paths = paths_from(&v[..ni * 10], &v[ni * 10..ni * 10 + np * 2]);
    let r: Vec<f64> = a[2..6].iter().map(|s| s.parse().unwrap()).collect();
    for x in arcs::page_arcs(&paths, None) {
        let c = ((x.bbox[0] + x.bbox[2]) / 2.0, (x.bbox[1] + x.bbox[3]) / 2.0);
        if c.0 >= r[0] && c.0 <= r[2] && c.1 >= r[1] && c.1 <= r[3] {
            println!("{:?} h=({:.1},{:.1}) r={:.1} sw={:.0} ends=({:.1},{:.1})/({:.1},{:.1}) refs={:?}", x.drawn, x.hinge.x, x.hinge.y, x.r, x.sweep, x.ends[0].x, x.ends[0].y, x.ends[1].x, x.ends[1].y, x.refs);
        }
    }
}
