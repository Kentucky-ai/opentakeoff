// One-Click benchmark runner — the corpus gate the upstream RFC calls for:
//   npm run bench          (from web/)
// Scores every probe (synthetic goldens by construction + pinned real-PDF
// goldens) through the production pipeline and reports mean IoU, floor IoU,
// refusal rate, leak rate, and correct-refusal rate. Non-zero exit when a
// gating threshold fails — wire it into CI next to the unit suite.
//
// CROSS-RESOLUTION (RFC failure mode #3): every case also runs at reduced mask
// resolutions (ws × 0.75, × 0.5 of the production cap — exactly what a bigger
// sheet or a different render scale does to the working raster). The verdict
// must not flip and the traced rings must pairwise-agree by IoU, or the bench
// fails: a measurement that changes with raster resolution is not a
// measurement. Baseline metrics are always scored at factor 1 so the headline
// numbers stay comparable across runs.
//
// AUDIT A5b — WHAT THIS BENCH MEASURES. Production does not return
// `traceRegion(f)`. Every vector One-Click ring in the product is trace-THEN-
// SNAP (corners pulled onto true PDF vertices) and `area_sf` comes off the
// SNAPPED ring. This file used to call bare `traceRegion` and never imported
// `snapVertices` at all, so every number it printed — and every engine-pinned
// golden it graded against — was a quantity the product never returns
// (enclosed-room: bench 117.568 SF, product 120.000, which
// e2e/one-click.e2e.cjs independently confirms through real Chromium). Both the
// bench and bench/pin-goldens.mts now go through `oneClickRing`, the single
// shared composition in src/lib/oneclick.ts.
//
// The snap costs the corpus something, so it is bought back explicitly: pulling
// corners onto exact vertices makes the synthetic probes' rings identical
// across mask resolutions, which would have turned the 9 truth-by-construction
// probes into ~1.000-by-construction and voided the cross-resolution signal on
// them. So every probe is ALSO traced un-snapped, and that reading is reported
// as MASK FIDELITY beside the production one — rasterisation error stays
// visible, it just stops being mistaken for the product's accuracy. Audit F6
// GATED that reading (it shipped ungated, so a regression to raw IoU 0.60
// passed) and ratcheted the snapped thresholds onto the post-A5b baseline.
import { createRequire } from "module";
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { extractVectorGeometry, buildMask, floodRegionSealed, sealRadiiFor, doorWedgeCapPx, minPassRadiusFor, traceRegion, oneClickRing, snapNearest, MASK_MAX_DIM, DETERMINISM_MIN_MPPF, SNAP_TOL_PX } from "../src/lib/oneclick.ts";
import type { FloodResult, Point, NearestFn } from "../src/lib/oneclick.ts";
import { syntheticCorpus, WALL_SEMANTICS, KNOWN_WALL_SEMANTICS } from "./corpus.ts";
import { scoreGolden, aggregate, aggregateCross, crossAgreement, polyIoU, ringAreaAbs, caseCoverage, confidenceGate, checkWallSemantics, CONF_GATE, CONF_GATE_EXEMPT, type ProbeScore, type CrossScore, type CrossRun, type CaseCoverage, type SemanticsCoverage } from "./score.ts";
import { traceConfidence, floodSignals } from "../src/lib/confidence.ts";

const THRESHOLDS = {
  // ── RATCHETED by audit F6 (was floor 0.90 / mean 0.95 / cross 0.90) ───────
  // Those numbers were set when the bench scored the UN-SNAPPED trace. A5b made
  // it score the product's snapped ring and the actuals went to floor 0.990,
  // mean 0.999, cross-floor 0.994 — while the gates never moved. A gate sitting
  // 0.09 below its own baseline is not a gate: the corpus's worst probe could
  // lose a third of its agreement and still ship green.
  //
  // THE MARGIN IS MEASURED, not chosen for comfort. The largest legitimate
  // movement any GATED (snapped) IoU shows on this corpus is 0.006:
  // curved-partition/left-half reads 0.990 / 0.991 / 0.985 against its golden
  // across ws ×1 / ×0.75 / ×0.5 — a 2× change of working raster resolution,
  // which is the biggest environmental change the bench simulates. FLOORS get
  // 0.02, more than 3× that, rounded down to 2 dp:
  //     floorIoU       0.990 − 0.02 → 0.97
  //     crossFloorIoU  0.994 − 0.02 → 0.97
  // The MEAN gets 0.01, because it averages 21 probes: for the mean to fall
  // 0.01 the equivalent of ten probes must each lose 0.02.
  //     meanIoU        0.999 − 0.01 → 0.99
  floorIoU: 0.97, meanIoU: 0.99, maxRefusalRate: 0, maxLeakRate: 0, minCorrectRefusal: 1,
  maxCrossDisagreements: 0, crossFloorIoU: 0.97,
  // ── MASK FIDELITY, NO LONGER UNGATED (audit F6) ───────────────────────────
  // The un-snapped reading below used to be printed and forgotten. It is the
  // only rasterisation signal left after the snap made 8 of 9 synthetic probes
  // agree at exactly 1.000 across resolutions, so leaving it ungated meant a
  // rasterisation regression to raw IoU 0.60 shipped green. Actuals: raw floor
  // 0.860 (va-finish-plan/patient-room-137-band), raw cross-resolution pair
  // floor 0.962 (two-doorways/center). These floors bind against regression
  // without binding today:
  //   rawFloorIoU 0.80 — the binding probe is a 1.15-ft-wide perimeter band on
  //     a sheet whose working mask cell is 1.34 in, so a half-cell contour
  //     error on both long edges is already ~10% of its area. 0.80 is "one more
  //     half-cell than today, on the narrowest thing the corpus measures".
  //   rawCrossFloorIoU 0.90 — 0.06 under the actual, and ~10× the 0.006 spread
  //     the SNAPPED rings show across the same resolution range: the raw
  //     contour is allowed to be resolution-sensitive, not resolution-random.
  // A raw MEAN floor was considered and rejected as redundant: any regression
  // broad enough to move the mean also moves the floor, which binds first.
  rawFloorIoU: 0.80,
  rawCrossFloorIoU: 0.90,
  // hard gates for HUMAN-MEASURED cases only (engine-pinned cases would gate
  // trivially against their own output; these numbers only mean something
  // when the answer key is independent):
  humanMaxSfErr: 0.025,        // any single room > 2.5% SF off fails
  humanCoverageBand: 0.02,     // Σ engine vs Σ golden within ±2% (missed/phantom floor)
  // 0.9's adjacency-tiling invariant. Unlike the two above this one is NOT
  // engine-self-referential: two probes' regions claiming the same floor is
  // double-counted SF whoever authored the answer key, so it gates every
  // whole-plan case, engine-pinned included.
  pairwiseOverlapFrac: 0.005,  // double-counted floor ≤ 0.5% of the engine total
  // ── per-ROOM ABSOLUTE square footage (audit F6) ───────────────────────────
  // Every SF check above is RELATIVE, and a relative band is blind on the room
  // that dominates a case. bench/pin-goldens.mts's ±2.5% re-pin band let
  // va-finish-plan/cloud-corridor move 36.7 SF — 54% of the whole case's delta
  // — with no adjudication, because 36.7 is 2.1% of 1743 SF. The equivalent
  // protection available HERE is the same trigger applied to the engine's
  // divergence from its pin, in square feet: it gates every whole-plan case
  // (engine-pinned included, on the pairwiseOverlapFrac argument — a room that
  // has silently moved 30 SF away from its answer key is 30 SF of somebody's
  // bid, whoever authored the key). Actual worst divergence today is 0.0505 SF
  // (va-finish-plan/ward-room), so 1.0 SF is ~20× the noise and still an order
  // of magnitude below anything a human would call a measurement difference.
  // NOTE the asymmetry this deliberately creates: on cloud-corridor 1.0 SF is
  // 0.06%, far tighter than humanMaxSfErr's 2.5%; on the 20.65 SF annotation
  // band it is 4.8%, looser — so the two triggers cover each other's blind
  // spots rather than duplicating each other.
  maxRoomSfAbs: 1.0,
  // ── the wall-semantics declaration must be EARNED (audit F5) ──────────────
  // Fraction of a probe's golden vertices that must sit within SNAP_TOL_PX of a
  // real drawn path vertex for the case's `wallSemantics: "drawn-path-vertex"`
  // to be a statement about the data rather than a stamp. Measured actuals per
  // probe: va-finish-plan 0.91–1.00 (worst: patient-toilet-137a, 21/23),
  // sample-plan 0.75 (3/4 — the fourth corner is the partition CROSS at
  // (1220,784), which is not an endpoint of either stroke and so not a vertex
  // at all; see bench/corpus.ts). 0.60 sits below both and above zero, which is
  // what a golden re-pinned onto something other than the drawn linework scores.
  wallSemanticsMinVertexCoverage: 0.60,
};
// 0.2 (audit B4): the corpus is discovered by directory listing, so a deleted
// or unreadable fixture used to shrink the run silently and still exit 0 —
// 21 probes became 13 with "bench passed". Pin the expected shape.
const EXPECT = { goldenProbes: 21, refusalProbes: 3, knownFails: 4, cases: 2 };
const RES_FACTORS = [1, 0.75, 0.5];  // ws multipliers; [0] must stay 1 (production baseline)
const CROSS_CELL = 2;                // image-px sampling cell for cross-scale IoU (4× faster, ±~0.005)
const here = dirname(fileURLToPath(import.meta.url));
const scores: ProbeScore[] = [];
const crossScores: CrossScore[] = [];
const coverages: CaseCoverage[] = [];

interface CaseProbe { name: string; seed: Point; expect: "golden" | "refusal"; golden?: Point[]; tags?: string[]; knownFail?: boolean }

/** Un-snapped reading of a probe, kept beside the production one. */
interface MaskFidelity { caseName: string; probeName: string; iou: number; sfErr: number; prodIou: number; prodSfErr: number; minPairIoU?: number; knownFail?: boolean }
const fidelity: MaskFidelity[] = [];

function runCase(caseName: string, segs: number[], points: Point[], imgW: number, imgH: number, meta: Uint8Array | null, ptPerFt: number, probes: CaseProbe[], humanMeasured = false, deductsSF = 0, wholePlan = false) {
  // factor 1 reproduces the production mask exactly: min(cap, image dim)
  const baseDim = Math.min(MASK_MAX_DIM, Math.max(imgW, imgH, 2));
  const masks = RES_FACTORS.map((f) => buildMask(segs, imgW, imgH, Math.max(2, Math.round(baseDim * f)), meta, ptPerFt));
  // A5b: the snap grid is built from op-list vertices in IMAGE px, so it is the
  // same object at every mask resolution — exactly as in production, where the
  // canvas caches one grid per sheet independent of the working raster.
  const nearest: NearestFn = snapNearest(points);
  const coverRows: Array<{ golden: Point[]; ring: Point[] | null; name: string }> = [];
  for (const p of probes) {
    const runs: Array<CrossRun & { flood: FloodResult; rawRing: Point[] | null }> = masks.map((mo, k) => {
      const mppf = mo.ws * ptPerFt;
      const f = floodRegionSealed(mo, p.seed[0], p.seed[1], 0.5, sealRadiiFor(mppf), doorWedgeCapPx(mppf), minPassRadiusFor(mppf));
      return {
        res: RES_FACTORS[k], status: f.status, flood: f,
        // `ring` is THE PRODUCTION RING — traced and snapped, the thing the
        // product puts on screen and in area_sf. Everything gating reads it.
        ring: f.status === "ok" ? oneClickRing(f, { nearest }) : null,
        // ...and the un-snapped trace, for the mask-fidelity report only.
        rawRing: f.status === "ok" ? traceRegion(f) : null,
      };
    });

    // baseline (production resolution) — the headline metrics
    const base = runs[0];
    // A2: confidence for EVERY probe that traced, refusal probes included.
    // It used to be computed only in the golden branch, so the four refusal
    // probes reported none — which put va-finish-plan/open-margin (a real-plan
    // probe that traces 23,831 SF of sheet margin instead of refusing) outside
    // any confidence gate at all. The signal set is the WHOLE FloodResult; a
    // caller that drops a field silently disables that deduction.
    const conf = (f: FloodResult, ring: Point[] | null) => (f.status !== "ok" ? undefined : traceConfidence(floodSignals(f, {
      areaSF: ring && ring.length >= 3 ? ringAreaAbs(ring) / (ptPerFt * ptPerFt) : undefined,
    })).score);
    if (p.expect === "refusal") {
      scores.push({ caseName, probeName: p.name, expect: "refusal", status: base.status, correctRefusal: base.status !== "ok", confidence: conf(base.flood, base.ring), knownFail: p.knownFail, tags: p.tags });
    } else {
      const f = base.flood;
      const s = scoreGolden(f.status, base.ring, p.golden!);
      scores.push({ caseName, probeName: p.name, expect: "golden", status: f.status, ...s, confidence: conf(f, base.ring), knownFail: p.knownFail, tags: p.tags } as ProbeScore);
      if (!p.knownFail) coverRows.push({ golden: p.golden!, ring: base.ring, name: p.name });
    }

    // cross-resolution agreement — gate only where the mask is at or above the
    // engine's determinism floor (below it, half-foot topology quantizes and
    // the engine itself says so via confidence); coarser runs stay visible.
    // A case with FEWER THAN TWO gated resolutions is not cross-checked at
    // all and is reported as such — comparing a run to itself asserts
    // nothing, and pretending otherwise inflated the gate (review round 8).
    const gatingRuns = runs.filter((_, k) => (masks[k].mppf ?? Infinity) >= DETERMINISM_MIN_MPPF);
    const subFloorRes = RES_FACTORS.filter((_, k) => (masks[k].mppf ?? Infinity) < DETERMINISM_MIN_MPPF);
    const ungated = gatingRuns.length < 2;
    const ca = ungated
      ? { statuses: runs.map((r) => r.status), statusAgree: true, minPairIoU: undefined }
      : crossAgreement(gatingRuns, CROSS_CELL);
    const iouByRes = p.expect === "golden" ? runs.map((r) => (r.ring && r.ring.length >= 3 ? polyIoU(r.ring, p.golden!, CROSS_CELL) : 0)) : undefined;
    crossScores.push({ caseName, probeName: p.name, expect: p.expect, resolutions: RES_FACTORS, ...ca, statuses: runs.map((r) => r.status), iouByRes, subFloorRes: subFloorRes.length ? subFloorRes : undefined, ungated: ungated || undefined, knownFail: p.knownFail, tags: p.tags });

    // ── MASK FIDELITY (A5b) — the same probe read UN-SNAPPED ─────────────────
    // Reported, never gated. Snapping pulls corners onto exact PDF vertices, so
    // a snapped ring can be byte-identical across resolutions while the
    // underlying raster contour is not — which is precisely how a corpus loses
    // its rasterisation signal without anyone noticing. This row is what keeps
    // that error on screen: the un-snapped IoU/SF error vs the same golden, and
    // the un-snapped cross-resolution pair-IoU beside the snapped one.
    if (p.expect === "golden" && base.rawRing && base.rawRing.length >= 3) {
      const ag = ringAreaAbs(p.golden!);
      const rawRuns = runs.filter((r) => r.rawRing && r.rawRing.length >= 3);
      let rawPair: number | undefined;
      if (!ungated) {
        const gatedRaw = rawRuns.filter((r) => (masks[RES_FACTORS.indexOf(r.res)].mppf ?? Infinity) >= DETERMINISM_MIN_MPPF);
        for (let i = 0; i < gatedRaw.length; i++)
          for (let j = i + 1; j < gatedRaw.length; j++) {
            const v = polyIoU(gatedRaw[i].rawRing!, gatedRaw[j].rawRing!, CROSS_CELL);
            if (rawPair === undefined || v < rawPair) rawPair = v;
          }
      }
      fidelity.push({
        caseName, probeName: p.name,
        iou: polyIoU(base.rawRing, p.golden!),
        sfErr: ag > 0 ? Math.abs(ringAreaAbs(base.rawRing) - ag) / ag : 0,
        prodIou: base.ring && base.ring.length >= 3 ? polyIoU(base.ring, p.golden!) : 0,
        prodSfErr: ag > 0 && base.ring && base.ring.length >= 3 ? Math.abs(ringAreaAbs(base.ring) - ag) / ag : 1,
        minPairIoU: rawPair,
        knownFail: p.knownFail,
      });
    }
  }
  // whole-case accounting: per-room SF error can't see floor NO probe covers
  // or floor counted twice — the case totals and pairwise overlaps can.
  // Real-plan cases only: synthetic cases may probe ONE room from several
  // seeds, which would read as double-counted floor.
  if (wholePlan && (coverRows.length >= 2 || humanMeasured)) {
    const pxPerFt = ptPerFt;                            // golden rings are image px at the case scale
    coverages.push(caseCoverage(caseName, coverRows, pxPerFt, humanMeasured, deductsSF));
  }
}

// synthetic cases — goldens by construction
for (const c of syntheticCorpus()) {
  runCase(c.name, c.segs, c.points, c.imgW, c.imgH, c.meta ?? null, c.ptPerFt, c.probes);
}

// pinned real-PDF cases. corpus/sealed/ holds the run-once protocol cases
// (human-measured plans nobody calibrates against) — included only with
// BENCH_SEALED=1 so day-to-day runs can't overfit to them.
const req = createRequire(import.meta.url);
const pdfjs = await import(req.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
const caseFiles = readdirSync(join(here, "corpus")).filter((f) => f.endsWith(".json")).map((f) => join(here, "corpus", f));
if (process.env.BENCH_SEALED) {
  try {
    for (const f of readdirSync(join(here, "corpus", "sealed")).filter((f) => f.endsWith(".json"))) caseFiles.push(join(here, "corpus", "sealed", f));
  } catch { /* no sealed dir yet */ }
}
const realCaseNames: string[] = [];   // 0.7: which cases are engine-pinned
// 0.9: every golden that ever moved more than ±2.5% carries the reason it was
// allowed to, written into the corpus JSON by bench/pin-goldens.mts. Reprint it
// on every run — an adjudication filed once and never seen again is a note, not
// a record, and the −33% re-pin (bug #17) was invisible precisely because the
// justification lived in a commit body nobody re-read.
interface CorpusAdjudication { at?: string; scope?: string; from_sf?: number; to_sf?: number; delta_pct?: number; iou_old_new?: number; overlap_sf?: number; frac_pct?: number; reason: string }
const adjudications: Array<{ caseName: string; subject: string; a: CorpusAdjudication }> = [];
const caseSemanticsFailures: string[] = [];
/** F5: the measured backing for each case's `wallSemantics` declaration. */
const semanticsCoverage: SemanticsCoverage[] = [];
for (const file of caseFiles) {
  const c = JSON.parse(readFileSync(file, "utf8"));
  const doc = await pdfjs.getDocument({ url: join(dirname(file), c.pdf), useSystemFonts: true }).promise;
  const page = await doc.getPage(c.page || 1);
  const vp = page.getViewport({ scale: c.scale });
  const ops = await page.getOperatorList();
  const g = extractVectorGeometry(ops, vp.transform, pdfjs.OPS);
  const name = file.replace(/^.*[\\/]/, "").replace(".json", "");
  if (!c.humanMeasured) realCaseNames.push(name);   // human-measured cases ARE independent truth
  for (const a of (c.adjudications ?? []) as CorpusAdjudication[]) adjudications.push({ caseName: name, subject: a.scope ?? "case", a });
  for (const p of c.probes as Array<{ name: string; adjudications?: CorpusAdjudication[] }>)
    for (const a of p.adjudications ?? []) adjudications.push({ caseName: name, subject: p.name, a });
  // ── wall-line semantics: DECLARED, and then VERIFIED (A5b; fixed by F5) ────
  // A case that does not declare which line its goldens measure to cannot be
  // read (the measurands differ by ~1.6% on the sample plan, 8.5% on a narrow
  // band, and ~5.9 in per shared wall on the VA plan). But the declaration used
  // to be checked ONLY against the constant every writer stamped it from —
  // `bench/from-takeoff.mts` for human keys, `bench/pin-goldens.mts` for
  // engine-pinned ones — so the check compared a constant to itself and passed
  // for three months while the value it certified ("centerline") was false on
  // 60% of the corpus's square footage. Two changes fix that: from-takeoff now
  // requires the semantics as an explicit CLI argument (a person declares what
  // a person measured), and the string is now checked against the DATA below.
  // The check itself is `checkWallSemantics` in bench/score.ts — pure, so its
  // three failure branches are unit-tested (test/benchScore.test.ts) instead of
  // being reachable only by perturbing the corpus.
  {
    const ws = checkWallSemantics({
      caseName: name, declared: c.wallSemantics, engine: WALL_SEMANTICS, known: KNOWN_WALL_SEMANTICS,
      probes: c.probes as Array<{ name: string; golden?: Point[] }>, points: g.points,
      tolPx: SNAP_TOL_PX, minCoverage: THRESHOLDS.wallSemanticsMinVertexCoverage,
    });
    caseSemanticsFailures.push(...ws.failures);
    semanticsCoverage.push(...ws.coverage);
  }
  runCase(name, g.segs, g.points, vp.width, vp.height, g.meta, c.ptPerFt, c.probes, !!c.humanMeasured, c.deducts_sf || 0, true);   // ptPerFt is image px/ft at the pinned scale
}

// ── report ──────────────────────────────────────────────────────────────────
for (const s of scores) {
  const bits = [
    s.expect === "golden"
      ? (s.refused ? "REFUSED" : `IoU ${(s.iou ?? 0).toFixed(3)}${s.sfErr != null ? `  SF±${(s.sfErr * 100).toFixed(1)}%` : ""}${s.leak ? " LEAK" : ""}${(s as { confidence?: number }).confidence != null ? `  conf ${(s as { confidence?: number }).confidence!.toFixed(2)}` : ""}`)
      : (s.correctRefusal ? "refused ✓" : `NOT refused (${s.status})${s.confidence != null ? `  conf ${s.confidence.toFixed(2)}` : ""}`),
    s.knownFail ? "[known-fail]" : "",
    s.tags?.length ? `(${s.tags.join(",")})` : "",
  ].filter(Boolean).join("  ");
  console.log(`${(s.caseName + " / " + s.probeName).padEnd(44)} ${bits}`);
}
if (coverages.length) {
  console.log("\n── case coverage (Σ engine vs Σ golden, double-counted floor) ──");
  for (const cv of coverages) {
    const ov = cv.sumEngineSF > 0 ? (cv.overlapSF / cv.sumEngineSF) * 100 : 0;
    console.log(`${cv.caseName.padEnd(28)} ${String(cv.probes).padStart(2)} probes | golden ${cv.sumGoldenSF.toFixed(1)} SF | engine ${cv.sumEngineSF.toFixed(1)} SF (×${cv.ratio.toFixed(3)}) | overlap ${cv.overlapSF.toFixed(2)} SF (${ov.toFixed(3)}%, gate ${THRESHOLDS.pairwiseOverlapFrac * 100}%) | worst room SF±${(cv.maxSfErr * 100).toFixed(1)}% / ±${cv.maxSfAbs.toFixed(2)} SF abs (gate ${THRESHOLDS.maxRoomSfAbs} SF, ${cv.maxSfAbsProbe})${cv.humanMeasured ? "  [HUMAN-MEASURED — gated]" : ""}`);
  }
  // 0.9: these are whole-CASE figures. They catch floor no probe covers and
  // floor counted twice — they do NOT catch a single room losing a third of
  // its area, because 2730050 → 92c1242 did exactly that while this line would
  // have read +0.5%. The per-probe rule in bench/pin-goldens.mts is that guard.
  console.log("  (whole-case figures — a per-ROOM regression can hide inside them; see bench/pin-goldens.mts)");
  console.log(`  (the per-room ABSOLUTE SF trigger above is the part a relative band cannot do: 2.5% of`);
  console.log(`   cloud-corridor is 43.6 SF, which is how 36.7 SF moved without an adjudication — see THRESHOLDS)`);
}
// F5: what backs each case's `wallSemantics` declaration, measured.
if (semanticsCoverage.length) {
  console.log(`\n── wall semantics "${WALL_SEMANTICS}" — golden vertices ON a drawn path vertex (≤ ${SNAP_TOL_PX} px) ──`);
  for (const s of semanticsCoverage)
    console.log(`${(s.caseName + " / " + s.probeName).padEnd(44)} ${String(s.onVertex).padStart(3)}/${String(s.verts).padEnd(3)} = ${(s.cov * 100).toFixed(0).padStart(3)}%  (floor ${(THRESHOLDS.wallSemanticsMinVertexCoverage * 100).toFixed(0)}%)`);
  console.log(`  ↑ the declaration is checked against the DATA, not against the constant every writer stamps`);
  console.log(`    it from. It equals the wall CENTRELINE only where walls are single strokes; on the VA`);
  console.log(`    plan's double-line walls (pairs measured 4.96–6.17 in apart) it lands on a FACE.`);
}
if (adjudications.length) {
  console.log("\n── re-pin adjudications on record (bench/pin-goldens.mts, task 0.9) ──");
  for (const { caseName, subject, a } of adjudications) {
    const move = a.from_sf != null && a.to_sf != null ? `${a.from_sf.toFixed(2)} → ${a.to_sf.toFixed(2)} SF (${a.delta_pct}%${a.iou_old_new != null ? `, IoU ${a.iou_old_new.toFixed(3)}` : ""})` : a.removed_sf != null ? `removed (was ${a.removed_sf.toFixed(2)} SF)` : a.overlap_sf != null ? `${a.overlap_sf} SF overlap (${a.frac_pct}%)` : "";
    console.log(`  ${(caseName + " / " + subject).padEnd(42)} ${a.at ?? ""} ${move}\n      ↳ ${a.reason}`);
  }
}
const agg = aggregate(scores);

// 0.7 (audit B1): NEVER print a blended accuracy figure again. 12 of the 21
// gating goldens are the engine graded against its own frozen output and score
// ~1.000 by construction; the 9 synthetic probes carry truth independent of the
// engine. A single mean over both buckets reads as accuracy and is not.
const PINNED_CASES = new Set(realCaseNames);
const synth = aggregate(scores.filter((s) => !PINNED_CASES.has(s.caseName)));
const pinned = aggregate(scores.filter((s) => PINNED_CASES.has(s.caseName)));

// ── MASK FIDELITY (A5b) — printed BEFORE the headline, on purpose ───────────
// The synthetic goldens are still independent of the engine (linework and
// golden come from the same authored numbers), but since A5b the engine's ring
// is SNAPPED onto those very numbers, so a synthetic probe scores ~1.000
// whenever its golden corners are drawn vertices — by construction OF THE SNAP,
// not by the raster getting them right. That is what the product returns and it
// is the right thing to gate; it is NOT a measurement of how well the flood
// approximates the room. This block is the measurement that still is.
const fidGate = fidelity.filter((f) => !f.knownFail);
const fidMeanIoU = fidGate.length ? fidGate.reduce((a, f) => a + f.iou, 0) / fidGate.length : 1;
const fidFloorIoU = fidGate.length ? Math.min(...fidGate.map((f) => f.iou)) : 1;
const fidWorstSf = fidGate.length ? Math.max(...fidGate.map((f) => f.sfErr)) : 0;
const fidPairs = fidGate.map((f) => f.minPairIoU).filter((v): v is number => v !== undefined);
console.log(`\n── mask fidelity: the SAME probes traced UN-SNAPPED (GATED since audit F6) ──`);
console.log(`   ${"probe".padEnd(42)} ${"raw IoU".padStart(8)} ${"raw SF±".padStart(9)}   ${"prod IoU".padStart(8)} ${"prod SF±".padStart(9)}   raw x-res pair IoU`);
for (const f of fidelity) {
  console.log(`   ${(f.caseName + " / " + f.probeName).padEnd(42)} ${f.iou.toFixed(3).padStart(8)} ${(`${(f.sfErr * 100).toFixed(2)}%`).padStart(9)}   ${f.prodIou.toFixed(3).padStart(8)} ${(`${(f.prodSfErr * 100).toFixed(2)}%`).padStart(9)}   ${f.minPairIoU !== undefined ? f.minPairIoU.toFixed(3) : "—"}${f.knownFail ? "  [known-fail]" : ""}`);
}
const fidCrossFloor = fidPairs.length ? Math.min(...fidPairs) : 1;
console.log(`   raw (rasterisation only, known-fails excluded): n=${fidGate.length} | mean IoU ${fidMeanIoU.toFixed(3)} | floor IoU ${fidFloorIoU.toFixed(3)} (gate ${THRESHOLDS.rawFloorIoU}) | worst SF ${(fidWorstSf * 100).toFixed(2)}%`);
console.log(`   raw cross-resolution pair-IoU floor: ${fidPairs.length ? fidCrossFloor.toFixed(3) : "n/a"} (gate ${THRESHOLDS.rawCrossFloorIoU}; ${fidPairs.length} probe(s) with ≥2 gated resolutions)`);
console.log(`   ↑ this is the rasterisation error the snap hides, and since audit F6 it GATES. It used to be`);
console.log(`     reported only, on the argument that the product ships the snapped ring — true, but the snap`);
console.log(`     had also made cross-resolution pair-IoU exactly 1.000 on 8 of 9 synthetic probes, so this`);
console.log(`     was the corpus's last rasterisation signal and nothing was holding it. See THRESHOLDS.`);

console.log(`\nsynthetic — PRODUCTION RINGS (trace+snap) vs goldens authored from the same numbers.`);
console.log(`  Independent of the engine's own past output, but NOT a raw accuracy figure: the snap`);
console.log(`  lands corners on the authored vertices, so this says "the flood found the right drawn`);
console.log(`  boundary", not "the raster is this good" — for that, read mask fidelity above.`);
console.log(`  n=${synth.goldenProbes} | mean IoU ${synth.meanIoU.toFixed(3)} | floor IoU ${synth.floorIoU.toFixed(3)}  [wall semantics: ${WALL_SEMANTICS}]`);
console.log(`engine-pinned (REGRESSION SAFETY ONLY — not accuracy; these are the engine's own past output):`);
console.log(`  n=${pinned.goldenProbes} | mean IoU ${pinned.meanIoU.toFixed(3)} | floor IoU ${pinned.floorIoU.toFixed(3)}`);
console.log(`\ngolden probes: ${agg.goldenProbes} | mean IoU ${agg.meanIoU.toFixed(3)} | floor IoU ${agg.floorIoU.toFixed(3)} | refusal ${(agg.refusalRate * 100).toFixed(1)}% | leak ${(agg.leakRate * 100).toFixed(1)}% (gating aggregate — see the split above before quoting the mean)`);
console.log(`refusal probes: ${agg.refusalProbes} (all synthetic) | correct ${agg.refusalProbes ? (agg.correctRefusalRate * 100).toFixed(1) + "%" : "n/a"} | known-fail tracked: ${agg.knownFails}`);

// 0.4 (audit B3): known-fails are excluded from every aggregate, so a probe that
// is actively failing right now is invisible in the summary. Print them.
const kf = scores.filter((s) => s.knownFail);
if (kf.length) {
  console.log(`\n── known-fails (EXCLUDED from every metric above) ──`);
  for (const s of kf) {
    const verdict = s.expect === "refusal"
      ? (s.refused ? "correctly refuses" : "*** NOT REFUSED — actively failing ***")
      : `IoU ${s.iou.toFixed(3)} SF±${(s.sfErr * 100).toFixed(1)}%${s.leak ? " LEAK" : ""}`;
    console.log(`  ${(s.caseName + " / " + s.probeName).padEnd(42)} ${verdict}`);
  }
}

console.log(`\n── cross-resolution (ws × ${RES_FACTORS.join(" / ")}) ──`);
for (const s of crossScores) {
  const bits = [
    s.ungated ? `statuses ${s.statuses.join("/")}` : (s.statusAgree ? `statuses ${s.statuses.join("/")}` : `DISAGREE ${s.statuses.join("/")}`),
    s.minPairIoU !== undefined ? `pair IoU ${s.minPairIoU.toFixed(3)}` : "",
    s.iouByRes ? `vs-golden ${s.iouByRes.map((v) => v.toFixed(3)).join("/")}` : "",
    s.ungated ? "[NO GATED PAIR — not cross-checked]" : "",
    s.subFloorRes?.length ? `[sub-floor: ×${s.subFloorRes.join(",×")}]` : "",
    s.knownFail ? "[known-fail]" : "",
  ].filter(Boolean).join("  ");
  console.log(`${(s.caseName + " / " + s.probeName).padEnd(44)} ${bits}`);
}
const xagg = aggregateCross(crossScores);
console.log(`\ncross probes: ${xagg.crossProbes} | disagreements ${xagg.disagreements} | pair-IoU floor ${xagg.crossFloorIoU.toFixed(3)} | pair-IoU mean ${xagg.crossMeanIoU.toFixed(3)}${xagg.ungated ? ` | NOT cross-checked (single gated resolution): ${xagg.ungated}` : ""}`);
// ── confidence vs error (audit A2's anti-correlation gate) ──────────────────
// Evaluated over EVERY probe, known-fails included — see confidenceGate.
const cgate = confidenceGate(scores);
console.log(`\n── confidence vs SF error (gate: >${CONF_GATE.ceilSfErr * 100}% SF ⇒ conf ≤ ${CONF_GATE.ceilConf}; ≤${CONF_GATE.floorSfErr * 100}% SF ⇒ conf ≥ median-of-inaccurate + ${CONF_GATE.floorMargin}, and ≥ ${CONF_GATE.floorAbs}) ──`);
console.log(`  INACCURATE (n=${cgate.inaccurate.length}, median conf ${cgate.medianInaccurate?.toFixed(2) ?? "n/a"}):`);
for (const p of cgate.inaccurate) console.log(`    ${p.probe.padEnd(40)} conf ${p.confidence.toFixed(2)}   ${p.why}`);
console.log(`  ACCURATE   (n=${cgate.accurate.length}, worst conf ${cgate.minAccurate?.toFixed(2) ?? "n/a"}):`);
for (const p of [...cgate.accurate].sort((a, b) => a.confidence - b.confidence)) console.log(`    ${p.probe.padEnd(40)} conf ${p.confidence.toFixed(2)}`);
for (const p of cgate.exempt) {
  const x = CONF_GATE_EXEMPT[p.probe];
  const dir = [
    x.xfailAbove != null ? `must stay > ${x.xfailAbove}` : "",
    x.xfailAtMost != null ? `must stay ≤ ${x.xfailAtMost}` : "",
    x.xfailEquals != null ? `must stay EQUAL to ${x.xfailEquals}` : "",
  ].filter(Boolean).join("; ");
  console.log(`  EXEMPT     ${p.probe.padEnd(40)} conf ${p.confidence?.toFixed(2) ?? "n/a"}  (xfail: ${dir})`);
  console.log(`      ↳ ${x.reason}`);
}

writeFileSync(join(here, "results.json"), JSON.stringify({ scores, aggregate: agg, coverages, crossScores, crossAggregate: xagg, confidenceGate: cgate, resFactors: RES_FACTORS, thresholds: THRESHOLDS, wallSemantics: WALL_SEMANTICS, semanticsCoverage, maskFidelity: { probes: fidelity, meanIoU: fidMeanIoU, floorIoU: fidFloorIoU, worstSfErr: fidWorstSf, crossFloorIoU: fidPairs.length ? fidCrossFloor : null, gated: true, floorGate: THRESHOLDS.rawFloorIoU, crossFloorGate: THRESHOLDS.rawCrossFloorIoU } }, null, 1));

const failures: string[] = [...caseSemanticsFailures];
for (const cv of coverages) {
  // 0.9: adjacency tiling gates every whole-plan case (see THRESHOLDS above).
  if (cv.sumEngineSF > 0 && cv.overlapSF > cv.sumEngineSF * THRESHOLDS.pairwiseOverlapFrac) failures.push(`${cv.caseName}: ${cv.overlapSF.toFixed(1)} SF double-counted (> ${THRESHOLDS.pairwiseOverlapFrac * 100}% of total)`);
  // F6: the ABSOLUTE per-room trigger, on every whole-plan case (see THRESHOLDS)
  if (cv.maxSfAbs > THRESHOLDS.maxRoomSfAbs) failures.push(`${cv.caseName}/${cv.maxSfAbsProbe}: engine diverges from its answer key by ${cv.maxSfAbs.toFixed(2)} SF > ${THRESHOLDS.maxRoomSfAbs} SF (absolute per-room trigger — a big room can move real square footage inside a relative band)`);
  if (!cv.humanMeasured) continue;                     // the rest gate human-measured cases only
  if (cv.maxSfErr > THRESHOLDS.humanMaxSfErr) failures.push(`${cv.caseName}: worst room SF error ${(cv.maxSfErr * 100).toFixed(1)}% > ${THRESHOLDS.humanMaxSfErr * 100}%`);
  if (Math.abs(cv.ratio - 1) > THRESHOLDS.humanCoverageBand) failures.push(`${cv.caseName}: engine total ×${cv.ratio.toFixed(3)} of the human total (band ±${THRESHOLDS.humanCoverageBand * 100}%)`);
}
// 0.2: a shrinking corpus must be loud, not green.
if (caseFiles.length !== EXPECT.cases && !process.env.BENCH_SEALED) failures.push(`expected ${EXPECT.cases} corpus case files, found ${caseFiles.length}`);
if (agg.goldenProbes !== EXPECT.goldenProbes) failures.push(`expected ${EXPECT.goldenProbes} golden probes, found ${agg.goldenProbes} — a fixture was added or lost`);
if (agg.refusalProbes !== EXPECT.refusalProbes) failures.push(`expected ${EXPECT.refusalProbes} refusal probes, found ${agg.refusalProbes}`);
if (agg.knownFails !== EXPECT.knownFails) failures.push(`expected ${EXPECT.knownFails} known-fails, found ${agg.knownFails} — re-pin EXPECT deliberately`);
// 0.3 (audit B3): nothing checked that a known-fail still fails, so a fixed
// limitation could silently re-break, and any regression could be neutralised
// with one knownFail:true. A known-fail that passes is a result, not a pass.
for (const s of scores) {
  if (!s.knownFail) continue;
  if (s.expect === "refusal" && s.refused) failures.push(`known-fail ${s.caseName}/${s.probeName} now REFUSES correctly — re-pin it or drop the flag`);
  if (s.expect === "golden" && s.iou >= THRESHOLDS.floorIoU && !s.leak) failures.push(`known-fail ${s.caseName}/${s.probeName} now passes (IoU ${s.iou.toFixed(3)}) — re-pin it or drop the flag`);
}
if (agg.floorIoU < THRESHOLDS.floorIoU) failures.push(`floor IoU ${agg.floorIoU.toFixed(3)} < ${THRESHOLDS.floorIoU}`);
if (agg.meanIoU < THRESHOLDS.meanIoU) failures.push(`mean IoU ${agg.meanIoU.toFixed(3)} < ${THRESHOLDS.meanIoU}`);
if (agg.refusalRate > THRESHOLDS.maxRefusalRate) failures.push(`refusal rate ${(agg.refusalRate * 100).toFixed(1)}%`);
// 0.5 (audit B5): maxLeakRate can never be the binding gate — leak is defined as
// IoU < 0.5 AND area > 1.5×, and any IoU < 0.5 already fails floorIoU 0.90. It is
// kept as a diagnostic, not reported as independent evidence.
if (agg.leakRate > THRESHOLDS.maxLeakRate) failures.push(`leak rate ${(agg.leakRate * 100).toFixed(1)}% (diagnostic — floorIoU should already have fired)`);
if (agg.correctRefusalRate < THRESHOLDS.minCorrectRefusal) failures.push(`correct-refusal ${(agg.correctRefusalRate * 100).toFixed(1)}%`);
if (xagg.disagreements > THRESHOLDS.maxCrossDisagreements) failures.push(`${xagg.disagreements} cross-resolution verdict flip(s)`);
if (xagg.crossFloorIoU < THRESHOLDS.crossFloorIoU) failures.push(`cross-resolution pair-IoU floor ${xagg.crossFloorIoU.toFixed(3)} < ${THRESHOLDS.crossFloorIoU}`);
// F6: mask fidelity — the un-snapped reading, no longer merely printed.
if (fidGate.length && fidFloorIoU < THRESHOLDS.rawFloorIoU) failures.push(`raw (un-snapped) IoU floor ${fidFloorIoU.toFixed(3)} < ${THRESHOLDS.rawFloorIoU} — the snap is covering for a rasterisation regression`);
if (fidPairs.length && fidCrossFloor < THRESHOLDS.rawCrossFloorIoU) failures.push(`raw (un-snapped) cross-resolution pair-IoU floor ${fidCrossFloor.toFixed(3)} < ${THRESHOLDS.rawCrossFloorIoU} — the mask contour moves with resolution even where the snapped ring does not`);
failures.push(...cgate.failures);
if (failures.length) { console.error(`\nBENCH FAILED: ${failures.join("; ")}`); process.exit(1); }
console.log("\nbench passed");
