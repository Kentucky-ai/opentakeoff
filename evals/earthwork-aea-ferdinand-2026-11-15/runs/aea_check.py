"""Average-end-area check against the engineer's printed cross-section boxes.

Reads every station's printed Ac / Af (end areas, SF) and Vc / Vf (volumes, CY)
off the cross-section sheets, recomputes each volume as
    (A_prev + A_this) / 2 * station_distance / 27
and prints computed vs printed per station plus totals.

Usage:  python runs/aea_check.py sheets/indnr-ferdinand-culvert-XS.pdf
Needs:  pymupdf
"""
import re
import sys

import pymupdf

STA = re.compile(r"\d+\+\d\d\.\d\d")
NUM = re.compile(r"\d+(\.\d+)?")


def words(page):
    """Words in the rotated (as-displayed) frame, PDF pt."""
    m = page.rotation_matrix
    out = set()
    for w in page.get_text("words"):
        p = pymupdf.Point((w[0] + w[2]) / 2, (w[1] + w[3]) / 2) * m
        out.add((round(p.y), round(p.x), w[4]))
    return sorted(out)


def rows(doc):
    for page in doc:
        W = words(page)
        stas = []
        for y, x, t in W:
            if STA.fullmatch(t) and x > 1900 and t not in [s for _, s in stas]:
                stas.append((y, t))
        if not stas or not any(t == "Ac" for _, _, t in W):
            continue

        def grab(label):
            hits = []
            for y, x, t in W:
                if t == label and 1950 < x < 2340:
                    vals = [(x2, t2) for y2, x2, t2 in W
                            if abs(y2 - y) <= 2 and x < x2 < x + 110 and NUM.fullmatch(t2)]
                    hits.append((y, float(min(vals)[1])))
            return sorted(hits)

        boxes = {k: grab(k) for k in ("Ac", "Af", "Vc", "Vf")}
        for i, (_, s) in enumerate(sorted(stas)):
            yield {"sta": s, **{k: boxes[k][i][1] for k in boxes}}


def main(path):
    doc = pymupdf.open(path)
    R = sorted(rows(doc), key=lambda r: float(r["sta"].replace("+", "")))
    st = lambda r: float(r["sta"].replace("+", ""))
    print(f"{'station':>9} {'Ac':>6} {'Af':>6} | {'Vc calc':>7} {'Vc prt':>6} | {'Vf calc':>7} {'Vf prt':>6}")
    tc = tf = pc = pf = 0.0
    ok = 0
    prev = None
    for r in R:
        vc = vf = 0.0
        # stations more than 60 ft apart are separate runs (gaps in the alignment)
        if prev and st(r) - st(prev) <= 60:
            L = st(r) - st(prev)
            vc = (prev["Ac"] + r["Ac"]) / 2 * L / 27
            vf = (prev["Af"] + r["Af"]) / 2 * L / 27
        match = abs(round(vc) - r["Vc"]) <= 1 and abs(round(vf) - r["Vf"]) <= 1
        ok += match
        tc, tf, pc, pf = tc + vc, tf + vf, pc + r["Vc"], pf + r["Vf"]
        print(f"{r['sta']:>9} {r['Ac']:6.1f} {r['Af']:6.1f} | {vc:7.1f} {r['Vc']:6.0f} | "
              f"{vf:7.1f} {r['Vf']:6.0f}{'' if match else '  <-- differs'}")
        prev = r
    print(f"\n{ok}/{len(R)} stations within 1 CY on both cut and fill (as parsed)")
    print(f"TOTAL cut  computed {tc:.0f} CY / printed {pc:.0f} CY")
    print(f"TOTAL fill computed {tf:.0f} CY / printed {pf:.0f} CY")


if __name__ == "__main__":
    main(sys.argv[1])
