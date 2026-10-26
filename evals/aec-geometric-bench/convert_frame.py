#!/usr/bin/env python3
"""Convert OpenTakeoff shape coordinates to the AEC-Geometric-Bench pixel frame.

OpenTakeoff tools return image px at render scale 2.0 (PDF pt x 2, origin
top-left, y down). The benchmark scores in the frame given by width/height in
its manifest.json (empirically PDF pt x 2.7778 on all 15 released sheets).
One multiplicative factor per sheet converts between them:

    bench_px = ot_px * (manifest_width / (pdf_width_pt * 2))

Usage: convert_frame.py raw.json sheet_NN --manifest ../aec-geometric-bench/dataset/manifest.json
where raw.json is {"areas": [[[x,y],...],...], "walls": [...], "objects": [...]}
in OT coordinates; writes the benchmark-frame prediction JSON to stdout.
"""
import argparse, json, sys

import fitz  # pymupdf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('raw')
    ap.add_argument('sheet')
    ap.add_argument('--manifest', required=True)
    a = ap.parse_args()

    m = json.load(open(a.manifest))
    entry = next(s for s in m['sheets'] if s['sheet'] == a.sheet)
    import os
    pdf = os.path.join(os.path.dirname(a.manifest), entry['pdf'])
    k = entry['width'] / (fitz.open(pdf)[0].rect.width * 2)

    raw = json.load(open(a.raw))
    scale_ring = lambda ring: [[round(x * k, 1), round(y * k, 1)] for x, y in ring]
    out = {
        'sheet': a.sheet,
        'objects': [
            {'class': o['class'], 'bbox': [round(v * k, 1) for v in o['bbox']]}
            for o in raw.get('objects') or []
        ],
        'areas': [scale_ring(r) for r in raw.get('areas') or []],
        'walls': [scale_ring(r) for r in raw.get('walls') or []],
    }
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    main()
