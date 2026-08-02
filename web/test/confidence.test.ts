// traceConfidence — the RFC item-D adapter over engine signals.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  traceConfidence, floodSignals, CONF_RASTER, CONF_HATCH, CONF_HATCH_TIER, CONF_WEDGE,
  CONF_CURVE_K, CONF_MINPASS, CONF_MINPASS_SOLE, CONF_OVERSIZE_MAX, ROOM_PLAUSIBLE_SF, ROOM_ABSURD_SF,
} from "../src/lib/confidence.ts";

test("verbatim vector trace scores 1.0 with no factors", () => {
  assert.deepEqual(traceConfidence({}), { score: 1, factors: [] });
});

test("each signal deducts once, with a named factor", () => {
  assert.equal(traceConfidence({ raster: true }).score, CONF_RASTER);
  assert.equal(traceConfidence({ hatchFiltered: true }).score, CONF_HATCH);
  assert.equal(traceConfidence({ wedges: 1 }).score, CONF_WEDGE);
  const sealed = traceConfidence({ sealedPx: 8, virtualFrac: 0.07 });
  assert.equal(sealed.score, 0.93);
  assert.match(sealed.factors[0], /sealed-opening\(7% synthetic boundary\)/);
});

test("deductions compose multiplicatively and clamp the virtual fraction", () => {
  const c = traceConfidence({ raster: true, sealedPx: 4, virtualFrac: 0.9 });   // junk fraction clamps to 0.25
  assert.equal(c.score, +(0.9 * 0.75).toFixed(2));
  assert.equal(c.factors.length, 2);
});

test("a sealed result missing its fraction assumes a door's worth, not zero", () => {
  assert.equal(traceConfidence({ sealedPx: 4 }).score, 0.9);
});

// ── audit A2: the score must react to HOW FAR an inference reached, not only
// to WHICH one ran — and every signal the engine emits must reach it. ────────

test("A2: hatch deduction is keyed on the escalation's verification regime, not its growth", () => {
  // bounded = grow-but-verify (≤ growthMax); trapped = strict found nothing;
  // override = a bounded strict result was DISCARDED, with no growth bound.
  assert.equal(traceConfidence({ hatchFiltered: true, hatchTier: "bounded" }).score, CONF_HATCH);
  assert.equal(traceConfidence({ hatchFiltered: true, hatchTier: "trapped" }).score, CONF_HATCH_TIER.trapped);
  assert.equal(traceConfidence({ hatchFiltered: true, hatchTier: "override" }).score, CONF_HATCH_TIER.override);
  assert.ok(CONF_HATCH_TIER.override < CONF_HATCH_TIER.trapped && CONF_HATCH_TIER.trapped <= CONF_HATCH_TIER.bounded,
    "an unbounded escalation that threw away a valid measurement is the most exposed of the three");
  // pre-A2 provenance carries no tier: read it as the safest regime, never
  // as a new penalty applied retroactively to stored shapes
  assert.equal(traceConfidence({ hatchFiltered: true }).score, CONF_HATCH);
  assert.match(traceConfidence({ hatchFiltered: true, hatchTier: "override" }).factors[0], /hatch-filtered\(override\)/);
});

test("A2: wedgeGrowth actually reaches the score — a token door retry is not a 3% doubt", () => {
  // wedgeGrowth was declared and supplied by NO caller; the deduction was flat.
  const token = traceConfidence({ wedges: 2, wedgeGrowth: 1.001 });     // 0.1% annexed
  const real = traceConfidence({ wedges: 2, wedgeGrowth: 1.511 });      // 33.8% annexed
  assert.ok(token.score > real.score, `growth must move the score (${token.score} vs ${real.score})`);
  assert.equal(real.score, CONF_WEDGE, "past the reference fraction it saturates at the historical flat deduction");
  assert.ok(token.score > 0.99, `a 0.1% annexation is not a 3% doubt (got ${token.score})`);
  assert.match(real.factors[0], /door-swing-crossed\(33\.8% annexed swing\)/);
  // no growth supplied at all (old provenance) ⇒ the historical flat deduction
  assert.equal(traceConfidence({ wedges: 1 }).score, CONF_WEDGE);
});

test("A2: curve-bounded boundary deducts by its share, at half a seal's weight", () => {
  assert.equal(traceConfidence({ curveFrac: 0.315 }).score, +(1 - CONF_CURVE_K * 0.315).toFixed(2));
  assert.ok(traceConfidence({ curveFrac: 0.315 }).score < traceConfidence({ curveFrac: 0.153 }).score);
  assert.equal(traceConfidence({ curveFrac: 0 }).factors.length, 0, "a straight-walled room is not charged for curves");
  // half a seal's weight, by construction
  assert.equal(traceConfidence({ curveFrac: 0.2 }).score, traceConfidence({ sealedPx: 1, virtualFrac: 0.1 }).score);
});

test("A2: an implausibly large 'room' is flagged in FEET, not as a fraction of the sheet", () => {
  assert.equal(traceConfidence({ areaSF: ROOM_PLAUSIBLE_SF }).factors.length, 0);
  assert.equal(traceConfidence({ areaSF: 1_674 }).score, 1, "a real 1,674 SF corridor is a room");
  const margin = traceConfidence({ areaSF: 23_831 });      // va-finish-plan/open-margin
  assert.ok(margin.score <= 0.90, `sheet margin traced as a room must not score 1.00 (got ${margin.score})`);
  assert.match(margin.factors[0], /oversize-for-one-room\(23,831 SF\)/);
  assert.equal(traceConfidence({ areaSF: ROOM_ABSURD_SF * 10 }).score, +(1 - CONF_OVERSIZE_MAX).toFixed(2), "the ramp saturates");
});

test("A2: the coarse-mask deduction can fire on the RASTER path (buildRasterMask sets no mppf)", () => {
  const okFlood = { status: "ok", region: new Uint8Array(4), count: 4, mw: 2, mh: 2, ws: 0.5 } as const;
  // vector path: the mask carries its own mppf
  assert.deepEqual(traceConfidence(floodSignals({ ...okFlood, mppf: 4 })).factors, ["coarse-mask"]);
  // raster path: f.mppf is undefined, so the caller MUST pass ws/upp or the
  // factor silently never fires — which is what it did before A2
  assert.deepEqual(traceConfidence(floodSignals(okFlood, { mppf: 4 })).factors, ["coarse-mask"]);
  assert.deepEqual(traceConfidence(floodSignals(okFlood)).factors, [], "no scale at all is still not a penalty");
});

test("A2: floodSignals forwards EVERY confidence-bearing field of a FloodResult", () => {
  // the defect class this function exists to close: four call sites each
  // hand-listed the fields they knew about, so `wedgeGrowth` was declared and
  // supplied by nobody. A field added to FloodResult and read by
  // traceConfidence must arrive here or this fails.
  const f = {
    status: "ok", region: new Uint8Array(1), count: 1, mw: 1, mh: 1, ws: 1,
    mppf: 18, hatchFiltered: true, hatchTier: "override", sealedPx: 7, virtualFrac: 0.11,
    wedges: 3, wedgeGrowth: 1.4, curveFrac: 0.2, minPassPx: 5, minPassDelta: 0.33,
  } as const;
  const got = floodSignals(f, { raster: true, areaSF: 42 });
  for (const [k, v] of Object.entries({
    raster: true, hatchFiltered: true, hatchTier: "override", sealedPx: 7, virtualFrac: 0.11,
    wedges: 3, wedgeGrowth: 1.4, curveFrac: 0.2, minPassPx: 5, minPassDelta: 0.33, areaSF: 42, mppf: 18,
  })) assert.equal((got as Record<string, unknown>)[k], v, `floodSignals dropped ${k}`);
  // and every key traceConfidence reads is one floodSignals can produce
  assert.deepEqual(
    Object.keys(got).sort(),
    ["areaSF", "curveFrac", "hatchFiltered", "hatchTier", "minPassDelta", "minPassPx", "mppf", "raster", "sealedPx", "virtualFrac", "wedgeGrowth", "wedges"],
  );
});

test("A3: the minimum-passage rule is visible in the score, graded by whether it is load-bearing", () => {
  assert.equal(traceConfidence({}).score, 1, "a rule that changed nothing costs nothing");
  const trimmed = traceConfidence({ minPassPx: 6, minPassDelta: 0.2636 });   // the 0.3 ft slit fixture
  assert.equal(trimmed.score, CONF_MINPASS);
  assert.match(trimmed.factors[0], /min-passage-rule\(26\.4% of the verbatim flood removed\)/);
  const sole = traceConfidence({ minPassPx: 5, minPassDelta: 1 });
  assert.equal(sole.score, CONF_MINPASS_SOLE);
  assert.ok(sole.score <= 0.90, "when the drawn linework encloses nothing, the trace is not a 1.00");
  assert.match(sole.factors[0], /undecidable-passage/);
});

test("A3/A2: 1.0 no longer claims 'verbatim' — it claims 'no signal fired'", () => {
  // annotation-ring-room: every signal clean, 35% off. The docstring's old
  // promise ("the boundary is the plan's own vector linework, verbatim") is
  // the thing being retired; this pins the replacement's arithmetic.
  assert.deepEqual(traceConfidence({ mppf: 18, areaSF: 79, minPassDelta: 0 }), { score: 1, factors: [] });
});
