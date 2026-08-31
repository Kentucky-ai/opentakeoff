#!/usr/bin/env python3
"""Score one sheet's prediction against AEC-Geometric-Bench ground truth,
with per-task detail, using the benchmark's own scorer unmodified.

    score_one.py predictions/claude-ot-harness/sheet_02.json \
        --gt ../aec-geometric-bench/dataset

The benchmark repo is imported from alongside --gt (its scoring/score.py);
nothing from it is vendored here.
"""
import argparse, json, os, sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pred', help='one sheet_NN.json in the benchmark frame')
    ap.add_argument('--gt', default='../aec-geometric-bench/dataset')
    a = ap.parse_args()

    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(a.gt)), 'scoring'))
    import score as S

    name = os.path.splitext(os.path.basename(a.pred))[0]
    G = S.load_gt(a.gt)[name]
    gap = 0.0015 * min(G['w'], G['h'])
    P = json.load(open(a.pred))

    by_class = {c: [] for c in S.OBJECTS}
    for o in P.get('objects') or []:
        c, b = o.get('class'), o.get('bbox')
        if c in by_class and b and len(b) == 4:
            g = S._poly([(b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])])
            if g is not None:
                by_class[c].append(g)

    print(f'{name}: {"task":<20}{"TP":>5}{"FP":>5}{"FN":>5}{"F1":>8}')
    T = [0, 0, 0]
    for c in S.OBJECTS:
        tp, fp, fn = S.match(by_class[c], G['objects'][c])
        T[0] += tp; T[1] += fp; T[2] += fn
        if tp + fp + fn:
            print(f'  {c:<20}{tp:>5}{fp:>5}{fn:>5}{S.f1(tp,fp,fn)[2]:>8.3f}')
    print(f'  {"OBJECT MICRO":<20}{T[0]:>5}{T[1]:>5}{T[2]:>5}{S.f1(*T)[2]:>8.3f}')

    pa = S.merge_touching([S._poly(r) for r in (P.get('areas') or [])], gap)
    ga = S.merge_touching(G['areas'], gap)
    tp, fp, fn = S.match(pa, ga)
    print(f'  {"area instance":<20}{tp:>5}{fp:>5}{fn:>5}{S.f1(tp,fp,fn)[2]:>8.3f}'
          f'  (gt merged: {len(ga)}, pred merged: {len(pa)})')
    i, p_, g_ = S.pixel_counts(pa, ga, G['w'], G['h'])
    print(f'  {"area pixel":<20}{"":>15}{S.f1(i,p_,g_)[2]:>8.3f}')
    pw = [g for g in (S._poly(r) for r in (P.get('walls') or [])) if g is not None]
    i, p_, g_ = S.pixel_counts(pw, G['walls'], G['w'], G['h'])
    print(f'  {"wall pixel":<20}{"":>15}{S.f1(i,p_,g_)[2]:>8.3f}')


if __name__ == '__main__':
    main()
