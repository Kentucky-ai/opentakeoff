// Trace confidence — the upstream RFC's item D: surface the engine's internal
// state per trace as a 0–1 score plus the factors behind it, for UI and
// provenance. Pure and deliberately TRANSPARENT: multiplicative deductions
// from documented signals, no opaque weighting.
//
// WHAT 1.0 MEANS — corrected, audit A3/A2. It used to say "the boundary is the
// plan's own vector linework, verbatim", and that was false twice over. False
// in fact: the minimum-passage rule runs on every scaled sheet and could move a
// measurement 35.8% (bench: the 0.3 ft slit fixture) while this module scored
// the result 1.00, because sealAttempt's primary path set no provenance at all.
// False in kind: a score is a statement about SIGNALS, not about geometry. 1.0
// now means exactly this — EVERY SIGNAL THIS MODULE CAN SEE CAME BACK CLEAN.
// It is not a claim that the trace is right. The corpus holds
// annotation-ring-room: 35% off with every signal clean, because it IS a clean
// vector trace — it just stopped at a drawn finish-tag annotation ring instead
// of the wall. Nothing here can see that, and no tuning of these numbers closes
// it (that needs vector-native topology, RFC item A). Read 1.0 as "nothing to
// flag", never as "verified".
//
// Signals (all emitted by oneclick.ts today):
//   raster        — traced from scanned pixels, no vector truth        ×0.90
//   hatchFiltered — the fill crossed classified-hatch linework; the DEDUCTION
//                   is keyed on hatchTier, the verification regime that
//                   accepted the escalation, NOT on how far it grew:
//                     bounded  (grow-but-verify, ≤ growthMax)          ×0.95
//                     trapped  (strict pass found nothing; unbounded)  ×0.93
//                     override (a bounded strict result discarded,
//                               unbounded, on the classifier's word)   ×0.85
//                   Growth is deliberately unused: on this repo's corpus it is
//                   ANTI-correlated (tile-grid-room grows 451.8× and is right,
//                   IoU 0.992; partition-bank-15in grows 5.09× and is wrong,
//                   IoU 0.197), so any threshold on it punishes the correct
//                   trace harder than the incorrect one.
//   sealedPx      — a gap was sealed; deduct by the VIRTUAL fraction
//                   of the boundary (how much is synthetic seal line):  ×(1 − virtualFrac)
//                   guards cap virtualFrac at 0.25, so this floors ×0.75
//   minPassDelta  — the minimum-passage rule changed the answer, by this
//                   fraction of the verbatim flood's region (audit A3):
//                     0 < d < 1  the rule severed a hairline connection ×0.99
//                     d = 1      the verbatim linework bounds NOTHING here —
//                                the rule is the only reason there is a
//                                measurement, and the passage it ruled on sits
//                                inside the ±one-cell band minPassRadiusFor
//                                itself calls undecidable at any resolution ×0.85
//   wedges        — door linework was crossed under grow-but-verify; deduct in
//                   proportion to how much of the final region is annexed swing
//                   (wedgeGrowth), to a ceiling of the old flat ×0.97. A retry
//                   that annexed 0.1% of the room is not a 3% doubt.
//   curveFrac     — fraction of the boundary abutting CURVE linework no wedge
//                   opened (a curved wall, a cloud, a refused arc). The ring is
//                   an RDP staircase through CURVE_STEPS chords, so that share
//                   of the boundary approximates geometry the drawing states
//                   exactly — half-weighted against a seal's virtualFrac, which
//                   is boundary that is not in the drawing at all.
//   areaSF        — the traced region, read as a room. The engine's only size
//                   guard is LEAK_FRACTION — 30% OF THE SHEET, a framing-
//                   dependent number, not a measurement. A feet-true ramp says
//                   the rest: nothing below ROOM_PLAUSIBLE_SF, falling to ×0.65
//                   by ROOM_ABSURD_SF. (Corpus: va-finish-plan/open-margin
//                   traces 23,831 SF of sheet margin and calls it a room.)
//   mppf          — mask coarser than the determinism floor (a cell is
//                   wider than ~2", so half-foot topology — doorway vs
//                   slit — quantizes; see DETERMINISM_MIN_MPPF). NOTE: the
//                   RASTER path's MaskObj carries NO mppf (buildRasterMask
//                   cannot know the sheet scale), so callers on that path must
//                   pass mask-px-per-foot explicitly — `ws / upp` — or this
//                   factor silently never fires on a scan, which is exactly
//                   what it did until audit A2.
//
// The deductions compose: a raster-traced, sealed room multiplies both. The
// score is a REVIEW PRIORITIZER, not a probability — 1.0 traces need a
// glance, low scores deserve the estimator's eyes on the flagged edge.
import { DETERMINISM_MIN_MPPF, type FloodResult, type HatchTier } from "./oneclick";

export interface ConfidenceInput {
  raster?: boolean;
  hatchFiltered?: boolean;
  hatchTier?: HatchTier;       // which escalation regime accepted it (absent ⇒ read as the safest)
  sealedPx?: number;
  virtualFrac?: number;
  wedges?: number;
  wedgeGrowth?: number;        // final region ÷ pre-wedge region (1 = nothing annexed)
  curveFrac?: number;          // boundary share abutting un-opened curve linework
  minPassPx?: number;          // minimum-passage radius that ran (provenance; no deduction of its own)
  minPassDelta?: number;       // fraction of the verbatim flood the rule removed; 1 = it bounds nothing
  areaSF?: number;             // the traced region's own area, square feet
  mppf?: number;               // mask px per foot; 0/absent = scale unknown (no deduction)
}
export interface Confidence { score: number; factors: string[]; }

export const CONF_RASTER = 0.90;
export const CONF_HATCH = 0.95;
/** Per hatch-escalation tier — see floodRegion. `bounded` keeps the historical
 *  CONF_HATCH exactly; the two unbounded tiers separate by how much the engine
 *  had to lose when it escalated, never by how far the escalation reached. */
export const CONF_HATCH_TIER: Record<HatchTier, number> = { bounded: CONF_HATCH, trapped: 0.93, override: 0.85 };
export const CONF_WEDGE = 0.97;
/** Annexed-swing fraction at which the wedge deduction reaches CONF_WEDGE in
 *  full; below it the deduction scales down — wedgeGrowth's whole point. */
export const WEDGE_ANNEX_REF = 0.10;
export const CONF_COARSE = 0.90;
export const CONF_MINPASS = 0.99;        // the rule trimmed a hairline connection
export const CONF_MINPASS_SOLE = 0.85;   // ...and without it nothing bounded this space at all
/** Curve-boundary weight: half a seal's, because a chord-approximated boundary
 *  is geometry stated imprecisely, where a seal's virtual run is geometry the
 *  drawing does not contain. */
export const CONF_CURVE_K = 0.5;
export const ROOM_PLAUSIBLE_SF = 5_000;   // below this, size says nothing
export const ROOM_ABSURD_SF = 50_000;     // at/above this, the oversize deduction is full
export const CONF_OVERSIZE_MAX = 0.35;    // ⇒ floors the oversize factor at 0.65
export const SEAL_VIRTUAL_DEFAULT = 0.10;   // sealed result missing its fraction (old data): assume a door's worth

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** THE adapter from an engine result to a ConfidenceInput. Audit A2 found
 *  `wedgeGrowth` declared here and supplied by NO caller — all four call sites
 *  (three in TakeoffCanvas, one in the bench) hand-listed the fields they
 *  happened to know about, so a signal the engine emits could be, and was,
 *  silently inert everywhere. Hand-listing is the bug; this function is the
 *  fix. Every caller goes through it, and a field added to FloodResult reaches
 *  every surface at once.
 *
 *  `opts.mppf` exists for ONE reason: buildRasterMask returns a MaskObj with no
 *  mppf (it cannot know the sheet scale), so on the raster path f.mppf is
 *  undefined and the coarse-mask deduction could never fire on a scan — the
 *  one path where a coarse working raster is not a choice. Raster callers pass
 *  `maskObj.ws / upp`. */
export function floodSignals(
  f: Extract<FloodResult, { status: "ok" }>,
  opts: { raster?: boolean; mppf?: number; areaSF?: number } = {},
): ConfidenceInput {
  return {
    raster: opts.raster,
    hatchFiltered: f.hatchFiltered,
    hatchTier: f.hatchTier,
    sealedPx: f.sealedPx,
    virtualFrac: f.virtualFrac,
    wedges: f.wedges,
    wedgeGrowth: f.wedgeGrowth,
    curveFrac: f.curveFrac,
    minPassPx: f.minPassPx,
    minPassDelta: f.minPassDelta,
    areaSF: opts.areaSF,
    mppf: f.mppf ?? opts.mppf,
  };
}

export function traceConfidence(s: ConfidenceInput): Confidence {
  let score = 1;
  const factors: string[] = [];
  if (s.raster) { score *= CONF_RASTER; factors.push("raster-traced"); }
  if (s.hatchFiltered) {
    // absent tier = provenance minted before A2; read it as the safest regime
    // rather than inventing a penalty for data that predates the distinction
    const tier: HatchTier = s.hatchTier ?? "bounded";
    score *= CONF_HATCH_TIER[tier];
    factors.push(`hatch-filtered(${tier})`);
  }
  if (s.sealedPx) {
    const vf = typeof s.virtualFrac === "number" ? clamp(s.virtualFrac, 0, 0.25) : SEAL_VIRTUAL_DEFAULT;
    score *= 1 - vf;
    factors.push(`sealed-opening(${Math.round(vf * 100)}% synthetic boundary)`);
  }
  if (s.minPassDelta) {
    const sole = s.minPassDelta >= 1;
    score *= sole ? CONF_MINPASS_SOLE : CONF_MINPASS;
    factors.push(sole
      ? "undecidable-passage(the drawn linework does not enclose this space)"
      : `min-passage-rule(${(s.minPassDelta * 100).toFixed(1)}% of the verbatim flood removed)`);
  }
  if (s.wedges) {
    // wedgeGrowth = final ÷ pre-wedge, so the annexed share is (g−1)/g
    const annex = typeof s.wedgeGrowth === "number" && s.wedgeGrowth > 1 ? (s.wedgeGrowth - 1) / s.wedgeGrowth : undefined;
    const w = annex === undefined ? 1 : clamp(annex / WEDGE_ANNEX_REF, 0, 1);
    score *= 1 - (1 - CONF_WEDGE) * w;
    factors.push(annex === undefined ? "door-swing-crossed" : `door-swing-crossed(${(annex * 100).toFixed(1)}% annexed swing)`);
  }
  if (s.curveFrac) {
    const cf = clamp(s.curveFrac, 0, 1);
    score *= 1 - CONF_CURVE_K * cf;
    factors.push(`curve-bounded(${Math.round(cf * 100)}% of the boundary)`);
  }
  if (typeof s.areaSF === "number" && s.areaSF > ROOM_PLAUSIBLE_SF) {
    const over = clamp((s.areaSF - ROOM_PLAUSIBLE_SF) / (ROOM_ABSURD_SF - ROOM_PLAUSIBLE_SF), 0, 1);
    score *= 1 - CONF_OVERSIZE_MAX * over;
    factors.push(`oversize-for-one-room(${Math.round(s.areaSF).toLocaleString("en-US")} SF)`);
  }
  if (typeof s.mppf === "number" && s.mppf > 0 && s.mppf < DETERMINISM_MIN_MPPF) { score *= CONF_COARSE; factors.push("coarse-mask"); }
  return { score: +score.toFixed(2), factors };
}
