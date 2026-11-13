//! Error audit over many sheets. Manifest lines: `<sheet.bin>\t<missed boxes json>\t<false-find boxes json>`.
//! Prints one line per missed door (the verdicts on the arcs near it) and per false find (the kept arcs behind it).
use door_reader::{arcs, doors, paths_from, segs};

fn boxes(s: &str) -> Vec<Vec<f64>> {
    let nums: Vec<f64> = s.split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == 'e')).filter(|t| !t.is_empty() && *t != "-").filter_map(|t| t.parse().ok()).collect();
    nums.chunks_exact(4).map(|c| c.to_vec()).collect()
}

fn main() {
    let man = std::fs::read_to_string(std::env::args().nth(1).unwrap()).unwrap();
    for line in man.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        let buf = std::fs::read(f[0]).unwrap();
        let ni = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
        let np = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
        let v: Vec<f64> = buf[8..].chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
        let paths = paths_from(&v[..ni * 10], &v[ni * 10..ni * 10 + np * 2]);
        let sg = segs::Segments::new(&paths);
        let found = arcs::page_arcs(&paths, None);
        let ring = doors::rings(&found);
        let live: Vec<_> = found.iter().cloned().zip(ring.iter()).filter(|(_, r)| !**r).map(|(a, _)| a).collect();
        let Some(fpp) = doors::scale_from_arcs(&live, &sg) else { println!("{}\tNOSCALE", f[0]); continue };
        let verdicts = doors::judge_all(&live, fpp, &paths, &sg);
        let name = f[0].rsplit('/').next().unwrap();
        for (kind, bs) in [("MISS", boxes(f[1])), ("FP", boxes(f[2]))] {
            for b in bs {
                let pad = if kind == "MISS" { 0.25 * (b[2] - b[0]).max(b[3] - b[1]) } else { 0.0 };
                let mut out = vec![];
                for (k, x) in found.iter().enumerate() {
                    let c = ((x.bbox[0] + x.bbox[2]) / 2.0, (x.bbox[1] + x.bbox[3]) / 2.0);
                    if c.0 < b[0] - pad || c.0 > b[2] + pad || c.1 < b[1] - pad || c.1 > b[3] + pad {
                        continue;
                    }
                    let v = if ring[k] { "ring".to_string() } else {
                        let li = live.iter().position(|l| l.hinge == x.hinge && l.r == x.r && l.ends == x.ends).unwrap();
                        match &verdicts[li] {
                            Ok(a) => format!("KEPT{}{}", if a.leafless { "-leafless" } else if a.leaf_dashes { "-dashleaf" } else { "" }, if a.dashed { "-dashed" } else { "" }),
                            Err(e) => e.to_string(),
                        }
                    };
                    out.push(format!("{:?}:{:.1}ft:{:.0}deg:{}", x.drawn, x.r * fpp, x.sweep, v));
                }
                println!("{}\t{}\t{:.0},{:.0},{:.0},{:.0}\t{}", name, kind, b[0], b[1], b[2], b[3], if out.is_empty() { "NOARC".into() } else { out.join(" ") });
            }
        }
    }
}
