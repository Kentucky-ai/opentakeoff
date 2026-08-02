// Benchmark scorer — the IoU/aggregate math the corpus gate stands on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { polyIoU, scoreGolden, aggregate, crossAgreement, aggregateCross, polyOverlapPx2, caseCoverage, confidenceGate, checkWallSemantics, goldenVertexCoverage, CONF_GATE, CONF_GATE_EXEMPT, type ProbeScore, type CrossScore } from "../bench/score.ts";
import { KNOWN_WALL_SEMANTICS, WALL_SEMANTICS } from "../bench/corpus.ts";
import type { Point } from "../src/lib/oneclick.ts";

const sq = (x0: number, y0: number, x1: number, y1: number): Point[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

test("polyIoU: identical squares ≈ 1, disjoint = 0, half-overlap ≈ 1/3", () => {
  assert.ok(polyIoU(sq(0, 0, 100, 100), sq(0, 0, 100, 100)) > 0.97);
  assert.equal(polyIoU(sq(0, 0, 10, 10), sq(50, 50, 60, 60)), 0);
  const half = polyIoU(sq(0, 0, 100, 100), sq(50, 0, 150, 100));   // overlap 50 of union 150
  assert.ok(Math.abs(half - 1 / 3) < 0.03, `≈1/3, got ${half}`);
});

test("scoreGolden: refusal, leak, and clean trace classify correctly", () => {
  const golden = sq(0, 0, 100, 100);
  assert.deepEqual(scoreGolden("leak", null, golden), { iou: 0, leak: false, refused: true });
  const ballooned = scoreGolden("ok", sq(-100, -100, 300, 300), golden);   // 16× the golden
  assert.ok(ballooned.leak && ballooned.iou < 0.5, "a ballooned trace is a leak");
  const clean = scoreGolden("ok", sq(1, 1, 99, 99), golden);
  assert.ok(!clean.leak && !clean.refused && clean.iou > 0.9);
});

test("aggregate: known-fail probes are tracked but never gate", () => {
  const scores: ProbeScore[] = [
    { caseName: "a", probeName: "p1", expect: "golden", status: "ok", iou: 0.98, leak: false, refused: false },
    { caseName: "a", probeName: "p2", expect: "golden", status: "ok", iou: 0.94, leak: false, refused: false },
    { caseName: "b", probeName: "r1", expect: "refusal", status: "leak", correctRefusal: true },
    { caseName: "c", probeName: "kf", expect: "refusal", status: "ok", correctRefusal: false, knownFail: true },
  ];
  const agg = aggregate(scores);
  assert.equal(agg.goldenProbes, 2);
  assert.ok(Math.abs(agg.meanIoU - 0.96) < 1e-9);
  assert.equal(agg.floorIoU, 0.94);
  assert.equal(agg.refusalRate, 0);
  assert.equal(agg.leakRate, 0);
  assert.equal(agg.correctRefusalRate, 1, "the known-fail wrong refusal must not drag the gate");
  assert.equal(agg.knownFails, 1);
});

test("crossAgreement: same verdict everywhere agrees; a flip disagrees; rings score pairwise", () => {
  const ring = sq(0, 0, 100, 100);
  const allTraced = crossAgreement([
    { res: 1, status: "ok", ring },
    { res: 0.5, status: "ok", ring: sq(1, 1, 99, 99) },
  ]);
  assert.ok(allTraced.statusAgree);
  assert.ok((allTraced.minPairIoU ?? 0) > 0.9);

  const allRefused = crossAgreement([
    { res: 1, status: "leak", ring: null },
    { res: 0.5, status: "tiny", ring: null },
  ]);
  assert.ok(allRefused.statusAgree, "leak vs tiny is the same verdict: refused");
  assert.equal(allRefused.minPairIoU, undefined);

  const flip = crossAgreement([
    { res: 1, status: "ok", ring },
    { res: 0.5, status: "tiny", ring: null },
  ]);
  assert.ok(!flip.statusAgree, "traced at one resolution, refused at another = disagreement");
});

test("crossAgreement: divergent rings drive minPairIoU down", () => {
  const three = crossAgreement([
    { res: 1, status: "ok", ring: sq(0, 0, 100, 100) },
    { res: 0.75, status: "ok", ring: sq(0, 0, 100, 100) },
    { res: 0.5, status: "ok", ring: sq(0, 0, 100, 50) },   // half the room lost
  ]);
  assert.ok(three.statusAgree);
  assert.ok((three.minPairIoU ?? 1) < 0.6, `worst pair must reflect the loss, got ${three.minPairIoU}`);
});

test("aggregateCross: known-fail excluded from gating; floor is the worst gating pair", () => {
  const scores: CrossScore[] = [
    { caseName: "a", probeName: "p1", expect: "golden", resolutions: [1, 0.5], statuses: ["ok", "ok"], statusAgree: true, minPairIoU: 0.98 },
    { caseName: "a", probeName: "p2", expect: "golden", resolutions: [1, 0.5], statuses: ["ok", "ok"], statusAgree: true, minPairIoU: 0.92 },
    { caseName: "b", probeName: "r1", expect: "refusal", resolutions: [1, 0.5], statuses: ["leak", "leak"], statusAgree: true },
    { caseName: "c", probeName: "kf", expect: "golden", resolutions: [1, 0.5], statuses: ["ok", "tiny"], statusAgree: false, minPairIoU: 0.10, knownFail: true },
  ];
  const x = aggregateCross(scores);
  assert.equal(x.crossProbes, 3);
  assert.equal(x.disagreements, 0, "the known-fail flip must not gate");
  assert.equal(x.crossFloorIoU, 0.92);
  assert.equal(x.knownFails, 1);
});

// ── SF error + case coverage (round-8 metric additions) ─────────────────────

test("scoreGolden: SF error is the relative area difference", () => {
  const golden: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100]];      // 10,000
  const traced: [number, number][] = [[0, 0], [98, 0], [98, 100], [0, 100]];        // 9,800
  const s = scoreGolden("ok", traced, golden);
  assert.ok(Math.abs((s.sfErr ?? 0) - 0.02) < 1e-9, `2% SF error, got ${s.sfErr}`);
});

test("polyOverlapPx2: disjoint rooms cost nothing; a known overlap measures", () => {
  const a: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const b: [number, number][] = [[200, 0], [300, 0], [300, 100], [200, 100]];
  assert.equal(polyOverlapPx2(a, b), 0, "disjoint");
  const c: [number, number][] = [[80, 0], [180, 0], [180, 100], [80, 100]];         // 20×100 overlap
  const ov = polyOverlapPx2(a, c, 1);
  assert.ok(Math.abs(ov - 2000) / 2000 < 0.05, `≈2000 px², got ${ov}`);
});

test("caseCoverage: totals, ratio, overlap, refused-room penalty, deducts", () => {
  const sq = (x0: number, y0: number, s: number): [number, number][] => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];
  // two 10×10 ft rooms at 10 px/ft; engine returns one exact, one 2% small
  const cv = caseCoverage("t", [
    { golden: sq(0, 0, 100), ring: sq(0, 0, 100) },
    { golden: sq(200, 0, 100), ring: [[200, 0], [298, 0], [298, 100], [200, 100]] },
  ], 10, true);
  assert.equal(cv.sumGoldenSF, 200);
  assert.ok(Math.abs(cv.sumEngineSF - 198) < 1e-9);
  assert.ok(Math.abs(cv.ratio - 0.99) < 1e-9);
  assert.equal(cv.overlapSF, 0);
  assert.ok(Math.abs(cv.maxSfErr - 0.02) < 1e-9);
  // a refused room counts as 100% error — missing floor can't hide in the mean
  const refused = caseCoverage("t2", [{ golden: sq(0, 0, 100), ring: null }], 10, true);
  assert.equal(refused.maxSfErr, 1);
  assert.equal(refused.sumEngineSF, 0);
  assert.equal(refused.maxSfAbs, 100, "...and 100% of its square footage, absolutely");
  // deducts reduce the golden total (human deducted a column; engine floods around it)
  const ded = caseCoverage("t3", [{ golden: sq(0, 0, 100), ring: sq(0, 0, 100) }], 10, true, 2);
  assert.equal(ded.sumGoldenSF, 98);
});

test("F6: caseCoverage reports ABSOLUTE worst-room SF, which a relative band cannot see", () => {
  // The blind spot, to scale: one 1,743 SF room (cloud-corridor) and one 20 SF
  // room (the annotation band). A 2% relative band lets the big room move 35 SF
  // and the small one 0.4 SF, so a relative trigger is ~90× looser on the room
  // that carries the case. The absolute figure is what run.mts gates on.
  const box = (x0: number, y0: number, w: number, h: number): [number, number][] => [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]];
  const cv = caseCoverage("scale", [
    // 1,000 SF golden at 10 px/ft, engine 2% small = 20 SF gone
    { name: "big-room", golden: box(0, 0, 1000, 100), ring: box(0, 0, 980, 100) },
    // 10 SF golden, engine 2% small = 0.2 SF gone
    { name: "small-room", golden: box(0, 500, 100, 10), ring: box(0, 500, 98, 10) },
  ], 10, false);
  assert.ok(Math.abs(cv.maxSfErr - 0.02) < 1e-9, "relative: both rooms read the SAME 2%");
  assert.ok(Math.abs(cv.maxSfAbs - 20) < 1e-9, `absolute: 20 SF, got ${cv.maxSfAbs}`);
  assert.equal(cv.maxSfAbsProbe, "big-room", "the failure message has to name the room that moved");
});

// ── F5: the wall-semantics declaration is CHECKED, not stamped ──────────────
// `bench/run.mts` used to hold `c.wallSemantics !== WALL_SEMANTICS`, comparing
// the corpus JSON's string against the very constant every writer of that field
// stamped it from — a tautology that passed for three months while the value it
// certified ("centerline") was false on 60% of the corpus's square footage.
// These pin the three things that can now fail, each with a distinct message.

const SEM = { engine: WALL_SEMANTICS, known: KNOWN_WALL_SEMANTICS, tolPx: 7, minCoverage: 0.60 };
/** a 4-corner golden and the drawn vertices it does or does not sit on */
const box = (x0: number, y0: number, s: number): Point[] => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];

test("F5: a case declaring the engine's measurand, with goldens ON drawn vertices, passes", () => {
  const golden = box(0, 0, 100);
  const r = checkWallSemantics({ ...SEM, caseName: "ok", declared: WALL_SEMANTICS, probes: [{ name: "p", golden }], points: [...golden, [500, 500]] });
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.coverage, [{ caseName: "ok", probeName: "p", onVertex: 4, verts: 4, cov: 1 }]);
  // within tolerance, not just exactly on: the snap has a 7 px reach
  assert.deepEqual(checkWallSemantics({ ...SEM, caseName: "ok", declared: WALL_SEMANTICS, probes: [{ name: "p", golden }], points: golden.map(([x, y]) => [x + 6, y] as Point) }).failures, []);
});

test("F5 branch 1: a value outside the vocabulary fails as a value, not as a measurand", () => {
  for (const bad of ["centreline", "face-to-face", "", undefined, null, 7]) {
    const r = checkWallSemantics({ ...SEM, caseName: "typo", declared: bad, probes: [{ name: "p", golden: box(0, 0, 100) }], points: box(0, 0, 100) });
    assert.equal(r.failures.length, 1, `${JSON.stringify(bad)} must fail`);
    assert.match(r.failures[0], /not one of/);
    assert.deepEqual(r.coverage, [], "an unreadable case is not measured, it is rejected");
  }
});

test("F5 branch 2: a DIFFERENT real measurand fails — the SF gates would compare two tapes", () => {
  for (const other of KNOWN_WALL_SEMANTICS.filter((v) => v !== WALL_SEMANTICS)) {
    const golden = box(0, 0, 100);
    const r = checkWallSemantics({ ...SEM, caseName: "human", declared: other, probes: [{ name: "p", golden }], points: golden });
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0], /two different measurands/);
    assert.match(r.failures[0], new RegExp(other));
  }
});

test("F5 branch 3: the declaration must be EARNED by the goldens — this is the one with teeth", () => {
  const golden = box(0, 0, 100);
  // goldens re-pinned onto something that is not the drawn linework: every
  // corner 30 px off the nearest path vertex. Nothing about the string changed.
  const drifted = golden.map(([x, y]) => [x + 30, y + 30] as Point);
  const bad = checkWallSemantics({ ...SEM, caseName: "unearned", declared: WALL_SEMANTICS, probes: [{ name: "p", golden: drifted }], points: golden });
  assert.equal(bad.failures.length, 1, bad.failures.join("; "));
  assert.match(bad.failures[0], /unearned\/p: only 0\/4 golden vertices \(0%\)/);
  assert.match(bad.failures[0], /does not measure to one \(floor 60%\)/);
  assert.equal(bad.coverage[0].cov, 0, "reported as well as failed");
  // the floor is a floor, not an all-or-nothing: 3 of 4 (the sample plan's real
  // figure, where the partition CROSS is not a path vertex) passes at 75%…
  const three = [...golden.slice(0, 3), [130, 130] as Point];
  assert.deepEqual(checkWallSemantics({ ...SEM, caseName: "cross", declared: WALL_SEMANTICS, probes: [{ name: "p", golden: three }], points: golden }).failures, []);
  assert.equal(goldenVertexCoverage(three, golden, 7), 0.75);
  // …and 2 of 4 = 50% does not
  const two = [...golden.slice(0, 2), [130, 130] as Point, [140, 140] as Point];
  assert.equal(goldenVertexCoverage(two, golden, 7), 0.5);
  assert.equal(checkWallSemantics({ ...SEM, caseName: "half", declared: WALL_SEMANTICS, probes: [{ name: "p", golden: two }], points: golden }).failures.length, 1);
});

// ── audit A2: the anti-correlation gate ─────────────────────────────────────
// RFC item D shipped a confidence score anti-correlated with error. These pin
// the gate that keeps it fixed. Note every fixture below carries knownFail on
// the badly-calibrated probes ON PURPOSE: three of the four real offenders are
// flagged that way in the corpus, and `aggregate`/`aggregateCross` both open
// with `filter(s => !s.knownFail)`. A gate routed through either could not fire.

const gp = (probe: string, sfErr: number, confidence: number, knownFail = false): ProbeScore => {
  const [caseName, probeName] = probe.split("/");
  return { caseName, probeName, expect: "golden", status: "ok", iou: 0.9, sfErr, leak: false, refused: false, confidence, knownFail };
};

test("A2 gate: an inaccurate probe may not report high confidence — known-fail included", () => {
  const bad = confidenceGate([gp("acc/a", 0.000, 1.00), gp("acc/b", 0.001, 0.95), gp("wrong/x", 3.842, 0.95, true)]);
  assert.equal(bad.inaccurate.length, 1, "the known-fail probe is IN the population, not filtered out");
  assert.ok(bad.failures.some((f) => /wrong\/x/.test(f) && /anti-correlated/.test(f)), bad.failures.join("; "));
  const good = confidenceGate([gp("acc/a", 0.000, 1.00), gp("acc/b", 0.001, 0.95), gp("wrong/x", 3.842, 0.85, true)]);
  assert.deepEqual(good.failures, []);
});

test("A2 gate: it keys on SF ERROR, not IoU — the 4.3%-at-1.00 probe is caught", () => {
  // two-doorways/center: IoU 0.957 (invisible to any IoU threshold) but 4.33%
  // SF off — the number a bid is actually written from.
  const s = [gp("acc/a", 0.000, 1.00), gp("acc/b", 0.002, 0.95), gp("two-doorways/center", 0.0433, 1.00)];
  s[2].iou = 0.957;
  assert.ok(confidenceGate(s).failures.some((f) => /two-doorways/.test(f)));
});

test("A2 gate: a refusal probe that TRACES fails the ceiling whatever its confidence", () => {
  const refusalTraced = (conf?: number): ProbeScore =>
    ({ caseName: "va-finish-plan", probeName: "open-margin", expect: "refusal", status: "ok", correctRefusal: false, confidence: conf, knownFail: true });
  const base = [gp("acc/a", 0.000, 1.00), gp("acc/b", 0.001, 0.95)];
  assert.ok(confidenceGate([...base, refusalTraced(0.97)]).failures.some((f) => /open-margin/.test(f) && /refuse/.test(f)));
  // ...and reporting NO confidence is itself a failure: that is precisely how
  // open-margin sat outside the gate before A2.
  assert.ok(confidenceGate([...base, refusalTraced(undefined)]).failures.some((f) => /open-margin/.test(f) && /NO confidence/.test(f)));
  assert.deepEqual(confidenceGate([...base, refusalTraced(0.65)]).failures, []);
  // a refusal probe that correctly refuses is not in any population
  assert.deepEqual(confidenceGate([...base, { caseName: "c", probeName: "r", expect: "refusal", status: "leak", correctRefusal: true }]).failures, []);
});

test("A2 gate: the floor is RELATIVE with a margin — a constant-score stub cannot pass it", () => {
  // "replacing traceConfidence with () => ({score: 0.5, factors: []})" — the
  // stated anti-gaming case. It satisfies every ceiling and any non-strict
  // floor; the margin is what refuses it.
  const stub = [gp("acc/a", 0.000, 0.5), gp("acc/b", 0.001, 0.5), gp("wrong/x", 3.842, 0.5, true), gp("wrong/y", 0.974, 0.5, true)];
  const r = confidenceGate(stub);
  assert.deepEqual(r.inaccurate.map((p) => p.confidence), [0.5, 0.5]);
  assert.ok(r.failures.length >= 2, `a constant score must FAIL the floor: ${JSON.stringify(r.failures)}`);
  assert.ok(r.failures.every((f) => /median-of-inaccurate|absolute floor/.test(f)));
});

test("A2 gate: an accurate probe below the inaccurate median + margin fails", () => {
  const s = [gp("acc/low", 0.000, 0.86), gp("acc/hi", 0.001, 0.99), gp("wrong/x", 3.842, 0.85, true)];
  assert.ok(confidenceGate(s).failures.some((f) => /acc\/low/.test(f) && /median-of-inaccurate/.test(f)));
  const ok = [gp("acc/low", 0.000, 0.89), gp("acc/hi", 0.001, 0.99), gp("wrong/x", 3.842, 0.85, true)];
  assert.deepEqual(confidenceGate(ok).failures, []);
});

test("A2 gate: empty populations do something, not nothing", () => {
  // no accurate probe at all ⇒ the gate is NOT satisfied. Otherwise deleting
  // the accurate probes would silently disable the floor.
  const noAcc = confidenceGate([gp("wrong/x", 3.842, 0.85, true)]);
  assert.ok(noAcc.failures.some((f) => /the floor cannot be evaluated/.test(f)), noAcc.failures.join("; "));
  // no inaccurate probe ⇒ no median to compare to, so the CALIBRATED ABSOLUTE
  // floor applies instead — the check is not skipped.
  assert.deepEqual(confidenceGate([gp("acc/a", 0.000, 0.99)]).failures, []);
  const low = confidenceGate([gp("acc/a", 0.000, CONF_GATE.floorAbs - 0.01)]);
  assert.ok(low.failures.some((f) => /ABSOLUTE floor/.test(f)), low.failures.join("; "));
  // probes in the dead zone between the two thresholds join neither population
  const dead = confidenceGate([gp("acc/a", 0.000, 0.99), gp("mid/m", 0.02, 0.10)]);
  assert.deepEqual(dead.inaccurate, []);
  assert.equal(dead.accurate.length, 1);
});

test("A2 gate: the POPULATED-case absolute floor fires where the relative floor passes", () => {
  // W4/W5/W6 review finding: `confidenceGate`'s absolute floor inside the
  // else-branch — the one that applies when BOTH populations exist — had no
  // test. Only the empty-inaccurate fallback (line ~390) was covered, so the
  // calibrated floor could have been deleted from the populated path and every
  // test would still pass. This is the reviewer's fixture: an inaccurate
  // population with median 0.60 and an accurate probe at 0.70. The RELATIVE
  // floor is 0.60 + margin 0.03 = 0.63, which 0.70 clears; the ABSOLUTE floor is
  // CONF_GATE.floorAbs = 0.88, which it does not.
  const s = [gp("acc/a", 0.000, 0.70), gp("wrong/x", 3.842, 0.60, true), gp("wrong/y", 0.974, 0.60, true)];
  const r = confidenceGate(s);
  assert.equal(r.medianInaccurate, 0.60);
  assert.equal(r.minAccurate, 0.70);
  assert.ok(0.70 >= r.medianInaccurate! + CONF_GATE.floorMargin, "fixture precondition: the relative floor is CLEARED");
  assert.ok(!r.failures.some((f) => /median-of-inaccurate/.test(f)), `the relative floor must not fire: ${r.failures.join("; ")}`);
  assert.equal(r.failures.length, 1, `exactly one failure, the absolute one: ${JSON.stringify(r.failures)}`);
  assert.match(r.failures[0], /calibrated absolute floor/);
  assert.ok(!/no inaccurate probes/.test(r.failures[0]), "this is the POPULATED path, not the empty-median fallback");
  // and it is the FLOOR that fires, not the ceiling: 0.60 is under ceilConf
  assert.ok(r.inaccurate.every((p) => p.confidence <= CONF_GATE.ceilConf));
  // …raise the accurate probe to the floor and the gate is satisfied, so the
  // assertion above is about the floor's VALUE, not about the fixture being
  // unsatisfiable
  assert.deepEqual(confidenceGate([gp("acc/a", 0.000, CONF_GATE.floorAbs), gp("wrong/x", 3.842, 0.60, true), gp("wrong/y", 0.974, 0.60, true)]).failures, []);
});

test("A2 gate: the exemption list is BOUNDED, reasoned, and xfailed WITH A DIRECTION", () => {
  // (b) the bound — an exemption list that can grow is `knownFail` again.
  // A5b took it from 1 to 3: measuring the product's SNAPPED ring moved the
  // nine synthetic probes out of the gate's dead zone and into the accurate
  // population for the first time, where two of them fail the floor for
  // reasons that are findings, not miscalibrations. See CONF_GATE_EXEMPT.
  assert.deepEqual(Object.keys(CONF_GATE_EXEMPT).sort(),
    ["annotation-ring-room/center", "tile-grid-room/in-cell", "two-doorways/center"],
    "adding another needs its own argument, not a bigger list");
  // (c) EVERY entry records the signal set it was evaluated against — not just
  // "known limit" — and (a) EVERY entry carries at least one xfail DIRECTION,
  // so the day the situation improves the gate fails instead of absorbing it.
  for (const [probe, e] of Object.entries(CONF_GATE_EXEMPT)) {
    for (const signal of ["raster", "hatchFiltered", "wedges", "wedgeGrowth", "curveFrac", "minPassDelta", "areaSF", "mppf"])
      assert.match(e.reason, new RegExp(signal), `${probe}: the exemption must name ${signal} among the signals it was evaluated against`);
    assert.match(e.reason, /XFAIL DIRECTION/, `${probe}: the reason must state its xfail direction in prose too`);
    assert.ok(e.xfailAbove != null || e.xfailAtMost != null || e.xfailEquals != null,
      `${probe}: an exemption with no direction is \`knownFail\` under a new name`);
  }
  const { reason, xfailAbove } = CONF_GATE_EXEMPT["annotation-ring-room/center"];
  for (const signal of ["sealedPx", "virtualFrac"]) assert.match(reason, new RegExp(signal));
  assert.equal(xfailAbove, 0.90);
  // the two A5b entries assert in the OTHER direction: they say a deduction
  // that cannot yet discriminate still cannot.
  assert.equal(CONF_GATE_EXEMPT["two-doorways/center"].xfailAtMost, 0.87);
  assert.ok(CONF_GATE_EXEMPT["two-doorways/center"].xfailAtMost! < CONF_GATE.floorAbs,
    "the ceiling it is held under must sit BELOW the floor it is excused from, or the exemption excuses nothing");
  // F6/W6: an `xfailAtMost` alone tolerates COLLAPSE — 0.10 also satisfies
  // "still ≤ 0.87". Every upper-bounded exemption must be BANDED.
  for (const [probe, e] of Object.entries(CONF_GATE_EXEMPT)) {
    if (e.xfailAtMost == null) continue;
    assert.ok(e.xfailAtLeast != null, `${probe}: xfailAtMost without xfailAtLeast tolerates the score collapsing to zero`);
    assert.ok(e.xfailAtLeast! < e.xfailAtMost!, `${probe}: the band must be non-empty`);
  }
  assert.equal(CONF_GATE_EXEMPT["two-doorways/center"].xfailAtLeast, 0.80);
  assert.equal(CONF_GATE_EXEMPT["tile-grid-room/in-cell"].xfailEquals, "partition-bank-15in/mid-bay");
  const exempt = (conf?: number): ProbeScore =>
    ({ caseName: "annotation-ring-room", probeName: "center", expect: "golden", status: "ok", iou: 0.65, sfErr: 0.35, leak: false, refused: false, confidence: conf, knownFail: true });
  const base = [gp("acc/a", 0.000, 1.00), gp("acc/b", 0.001, 0.95), gp("wrong/x", 3.842, 0.85, true)];
  assert.deepEqual(confidenceGate([...base, exempt(1.00)]).failures, [], "today it scores 1.00 and is exempt");
  const flipped = confidenceGate([...base, exempt(0.88)]);
  assert.ok(flipped.failures.some((f) => /XFAIL FLIPPED/.test(f)), flipped.failures.join("; "));
  assert.ok(confidenceGate([...base, exempt(undefined)]).failures.some((f) => /no confidence at all/.test(f)));
  // exempt probes are in neither gating population
  assert.equal(confidenceGate([...base, exempt(1.00)]).inaccurate.length, 1);
});

test("A2/A5b gate: the xfailAtMost and xfailEquals directions flip the same way round", () => {
  const base = [gp("acc/a", 0.000, 1.00), gp("acc/b", 0.001, 0.95), gp("wrong/x", 3.842, 0.85, true)];
  // xfailAtMost — two-doorways/center. Today 0.85 ≤ 0.87 and it is excused;
  // the day the engine can justify withholding the deduction it rises and this
  // fires instead of quietly absorbing the improvement.
  const twoDoor = (conf: number): ProbeScore =>
    ({ caseName: "two-doorways", probeName: "center", expect: "golden", status: "ok", iou: 1, sfErr: 0, leak: false, refused: false, confidence: conf });
  assert.deepEqual(confidenceGate([...base, twoDoor(0.85)]).failures, []);
  assert.ok(confidenceGate([...base, twoDoor(0.92)]).failures.some((f) => /two-doorways/.test(f) && /XFAIL FLIPPED/.test(f)));
  // …and DOWNWARD (F6/W6). The one-sided bound excused any score at all below
  // 0.87, so a confidence model that piled three more deductions onto this
  // fixture — or returned 0.10 — passed the gate through the exemption. The
  // band is 0.80–0.87; both edges are live and the inside is quiet.
  assert.deepEqual(confidenceGate([...base, twoDoor(0.80)]).failures, [], "the lower edge is inclusive");
  assert.deepEqual(confidenceGate([...base, twoDoor(0.87)]).failures, [], "so is the upper edge");
  const collapsed = confidenceGate([...base, twoDoor(0.79)]);
  assert.ok(collapsed.failures.some((f) => /two-doorways/.test(f) && /XFAIL FLIPPED DOWNWARD/.test(f)), collapsed.failures.join("; "));
  assert.ok(confidenceGate([...base, twoDoor(0.10)]).failures.some((f) => /two-doorways/.test(f) && /XFAIL FLIPPED DOWNWARD/.test(f)),
    "a collapse to 0.10 used to satisfy `still ≤ 0.87` and pass");

  // xfailEquals — tile-grid-room/in-cell is excused only for as long as its
  // score is IDENTICAL to partition-bank-15in/mid-bay's, which is the finding.
  const tile = (conf: number): ProbeScore =>
    ({ caseName: "tile-grid-room", probeName: "in-cell", expect: "golden", status: "ok", iou: 1, sfErr: 0, leak: false, refused: false, confidence: conf });
  const bank = (conf: number): ProbeScore =>
    ({ caseName: "partition-bank-15in", probeName: "mid-bay", expect: "golden", status: "ok", iou: 0.2, sfErr: 4.0, leak: true, refused: false, confidence: conf, knownFail: true });
  assert.deepEqual(confidenceGate([...base, tile(0.85), bank(0.85)]).failures, []);
  const split = confidenceGate([...base, tile(0.95), bank(0.85)]);
  assert.ok(split.failures.some((f) => /tile-grid-room/.test(f) && /no longer equals/.test(f)), split.failures.join("; "));
  // …and if the probe it is compared against leaves the corpus, the assertion
  // is UNCHECKABLE, which is a failure rather than a silent pass
  const orphan = confidenceGate([...base, tile(0.85)]);
  assert.ok(orphan.failures.some((f) => /XFAIL UNCHECKABLE/.test(f)), orphan.failures.join("; "));
});
