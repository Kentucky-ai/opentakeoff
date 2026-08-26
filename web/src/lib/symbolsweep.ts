// Symbol Sweep — deterministic repeated-symbol matching (pure, no DOM;
// node-testable, the sheets.ts/oneclick.ts precedent).
//
// Plan symbols — drains, thresholds, fixtures, transition markers — are
// repeated vector blocks: the same little cluster of segments stamped across
// the sheet. Given ONE example instance (a marquee around it), find every
// other placement of that same cluster from the linework alone. No ML, no
// vision, no guessing: a placement either reproduces the seed's segments
// within a pixel tolerance or it doesn't, and the score says exactly how much
// of the seed it reproduced.
//
// The pipeline:
//   1. FINGERPRINT — the segments fully inside the seed rect, expressed
//      relative to their length-weighted centroid. Fully-inside, not
//      intersecting: a marquee around a drain must not drag in the wall run
//      passing behind it.
//   2. CANDIDATES — constellation anchoring. Sheets run 100k+ segments, so a
//      naive O(n·m) scan of every position is out. Instead, up to
//      ANCHOR_COUNT seed segments of DISTINCT quantized length (rarest
//      sheet-wide first — a rare length prunes hardest) each vote: every
//      sheet segment of matching length proposes the centroid the symbol
//      would have if that segment were this anchor, per symmetry transform.
//      Several anchors, deliberately: a placement stays discoverable even
//      when one of its segments is drawn perturbed (the near-miss case whose
//      whole point is to be REPORTED).
//   3. SCORE — for each candidate placement, each transformed seed segment
//      looks up a sheet segment whose endpoints both sit within tolPx (either
//      orientation) via an endpoint grid. Score = length-weighted fraction of
//      seed segments matched — a long wall-side matching counts more than a
//      tick mark.
//   4. CLASSIFY — score ≥ scoreHigh is a match; [scoreLow, scoreHigh) is a
//      WITHHELD near-match with a reason (a question the caller can answer
//      with a look, never a silent commit or a silent drop); below is not the
//      symbol. The seed's own location is reported separately and never
//      returned as a match.
//
// Symmetry: symbols rotate and flip on plans, so placements are searched
// under the square's symmetry group — 0/90/180/270 rotation × optional
// mirror — with both options ON by default and independently switchable.
//
// Work is CEILINGED and the ceiling is REPORTED: by default every proposed
// placement is scored (proposal enumeration is paid before the cap ever
// applied, so the cap only ever saved scoring time — #261 measured 19 of 62
// receptacles surviving a 20k cap that saved ~1 s), up to a hard ceiling for
// pathological sheets. `complete: false` plus candidates.dropped > 0 means
// some placements were never scored, and the caller is told rather than
// handed a silently truncated count (the sheet_context decimation doctrine).
//
// Phase 2 splits the pipeline at its natural seam: fingerprintSymbol (step 1)
// builds the centroid-relative fingerprint from ONE sheet's segments, and
// matchSymbol (steps 2–4) searches ANY sheet's segments for it — so a symbol
// marqueed on a detail or legend sheet can be counted across the plan sheets.
//
// Scale (#186). The fingerprint is size-true — translation plus the square
// symmetry group, no scaling — and the search stays that way: a scale SEARCH
// would trade exactness for guesses. But a detail sheet is drawn enlarged
// (1-1/2" = 1'-0" against a 1/8" plan is a 12× ratio), so a size-true search
// finds nothing there and, worse, finds it silently: no placement clears
// scoreLow, so zero matches with zero near-misses reads exactly like "that
// symbol isn't on these sheets." The fix is a STATED ratio, never a searched
// one — `opts.scale` is seed-sheet px per target-sheet px, which the caller
// computes from the two sheets' own committed scales (upp_seed / upp_target).
// One number, derived from data the estimator already stated. The endpoint
// test stays exactly as strict; tolerance rides the ratio only when the seed
// is being MAGNIFIED (its jitter magnifies with it), so scale ≤ 1 and the
// whole one-sheet surface are bit-for-bit unchanged.
//
// sweepSymbols composes the two on one sheet, unchanged.

import i18n from "../i18n/index.js";
import { markDanger } from "./danger.js";

const _t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: "lib", ...opts });

export type Point = [number, number];

export interface SweepOptions {
  /** Also try 90/180/270 rotated placements (default true — symbols rotate on plans). */
  rotations?: boolean;
  /** Also try mirrored placements (default true). */
  mirror?: boolean;
  /** Endpoint match tolerance, image px (default 2 — CAD jitter, not drift). */
  tolPx?: number;
  /** Commit bar: score ≥ this is a match (default 0.92). */
  scoreHigh?: number;
  /** Withhold floor: [scoreLow, scoreHigh) is a reported near-match (default 0.75). */
  scoreLow?: number;
  /** Cap on scored placements (default SWEEP_CANDIDATE_CEILING — every
   * proposal is scored unless the sheet is pathological). Overflow is
   * counted in candidates.dropped and flips `complete` false, never silent. */
  maxCandidates?: number;
  /** The sheet's per-segment stroke luminance (#260), aligned to `segs`.
   * Carried through on its own; it gates NOTHING unless `lumTol` is stated. */
  lum?: Uint8Array;
  /** Stated luminance tolerance, 0–255: a sheet segment only answers for a
   * seed segment when their stroke luminances are within it (#260, reported by
   * @FrankAtGHub). Opt-in and disclosed, in the spirit of `tolPx` — a hidden
   * color heuristic would silently drop a symbol somebody redrew in a
   * different pen. The case it exists for is a flattened export where a black
   * fixture outline and a grey ceiling grid are geometrically identical: 0 vs
   * 219 is not a near miss, so a tolerance of 32–64 separates them without
   * touching anti-aliasing wobble. Ignored when no `lum` is supplied. */
  lumTol?: number;
  /** Counter-examples: rects around instances you do NOT mean (#259, reported
   * by @FrankAtGHub). The same gesture as the seed — drag a box around the
   * thing that is not it — and the engine works out WHY it is not it. See
   * `buildNegative` for the two mechanics and how the mode is inferred. Read
   * against the segments handed to THIS call; for a sweep that crosses sheets,
   * build them once on the seed sheet and pass `negatives` instead. */
  exclude?: Array<[Point, Point]>;
  /** Counter-examples already read (canonical frame) — the cross-sheet form of
   * `exclude`, scaled with the fingerprint when a size ratio applies. */
  negatives?: SymbolNegative[];
}

export interface SweepMatch {
  /** The placed symbol's centroid, image px. */
  at: Point;
  /** Length-weighted fraction of seed segments matched, 0..1. */
  score: number;
  /** Detected rotation, degrees CW in image space (y down): 0 | 90 | 180 | 270. */
  rotation: number;
  mirrored: boolean;
}

export interface SweepWithheld extends SweepMatch {
  reason: string;
}

/** A placement a counter-example rejected (#259). Disclosed the way `withheld`
 * is — with the negative that did it and what it saw — because an exclusion is
 * a judgement and judgements get revised: everything needed to reinstate it by
 * hand is here, without re-running the sweep. */
export interface SweepRejected extends SweepMatch {
  /** Index into the `exclude` array — which counter-example rejected it. */
  by: number;
  /** "shape": the negative's extra linework is present here. "crossing": a
   * line the negative sits ON runs through this placement unbroken. */
  mode: "shape" | "crossing";
  /** Fraction of that negative's discriminating evidence found here, 0..1. */
  evidence: number;
  reason: string;
}

export interface SweepResult {
  seed: {
    /** Segments the fingerprint was built from (fully inside the rect). */
    segments: number;
    /** The seed instance's own centroid, image px — reported, never a match. */
    center: Point;
    /** Total seed linework length, image px. */
    length_px: number;
  };
  matches: SweepMatch[];
  withheld: SweepWithheld[];
  /** Work accounting: dropped > 0 means the candidate ceiling bit and some
   * placements were never scored — the caller must be told. */
  candidates: { considered: number; dropped: number };
  /** True when every proposed placement was scored — the count is a total.
   * False means the ceiling bit: the count is a FLOOR, not a total (#261). */
  complete: boolean;
  /** Placements a counter-example rejected (#259) — named, with which negative
   * did it and what it saw, so an exclusion can be revised without re-running
   * the sweep. Empty when no counter-example was given. */
  rejected: SweepRejected[];
  /** What each counter-example was read AS (#259), in `exclude` order: the
   * mechanic inferred from the rect's own contents, how much discriminating
   * linework it carries, and where the engine found the instance it aligned
   * to. A negative that read as nothing usable is reported null — silence
   * there would look like a negative that simply never fired. */
  negatives?: Array<{ mode: "shape" | "crossing"; segments: number; center: Point } | null>;
  /** The stated luminance gate and what it cost, when one was applied (#260):
   * every placement the geometry would have committed and the pen did not,
   * named — a rejection is a question answered, and the caller can look. */
  lum_gate?: { tol: number; seed_lum: number[]; rejected: number; at: Point[] };
}

export const SWEEP_TOL_PX = 2;
export const SWEEP_SCORE_HIGH = 0.92;
export const SWEEP_SCORE_LOW = 0.75;
/** Hard ceiling on scored placements. Proposals are fully enumerated before
 * this ever applies, so it bounds SCORING time only — measured ~1.6 s at 87.5k
 * on a 50k-segment sheet (#261), so the ceiling costs single-digit seconds at
 * worst. It exists for pathological sheets, not as a tuning knob: small dense
 * device symbols (short, common segment lengths — most of an electrical sheet)
 * legitimately propose ~90k placements, and the old 20k default silently hid
 * 43 of 62 receptacles behind a plausible-looking count. */
export const SWEEP_CANDIDATE_CEILING = 250000;
/** Distinct-length anchors used for candidate generation. Three means a
 * placement survives discovery even with one perturbed segment — the
 * near-miss band exists to be populated, and a single anchor would hide
 * exactly the placements it is supposed to report. */
export const ANCHOR_COUNT = 3;
/** Seed segments shorter than this (px) are dropped from the fingerprint —
 * sub-pixel specks can't be matched at any honest tolerance. */
const MIN_SEG_LEN = 0.5;
/** A marquee holding more segments than this is not one symbol instance. */
const MAX_SEED_SEGS = 2000;
/** Stated size ratios outside this band say the two sheets disagree by more
 * than any real drawing set does — 64× is already past a full-size detail
 * against a 1/16" plan — so the likelier reading is a wrong `set_scale` on one
 * of them than a genuine ratio. Refused rather than swept. */
export const SWEEP_MIN_SCALE = 1 / 64;
export const SWEEP_MAX_SCALE = 64;
/** A scaled-down symbol must still be this many tolerance balls across, or
 * "matching" degenerates: every tolerance ball covers the whole symbol and
 * anything scores. The refusal is the honest answer — the detail is drawn too
 * large relative to the plan for its linework to survive the trip. */
const MIN_FOOTPRINT_TOLS = 6;

interface Xform { rotation: number; mirrored: boolean; m: [number, number, number, number]; }

/** The symmetry transforms to search, deterministic order: unmirrored
 * rotations first, 0° first — ties in dedupe resolve toward the plainest
 * reading. Matrices act on centroid-relative coords in image space (y down);
 * rotation is CW degrees in that frame. */
function transformsFor(rotations: boolean, mirror: boolean): Xform[] {
  const rots: [number, [number, number, number, number]][] = [
    [0, [1, 0, 0, 1]], [90, [0, -1, 1, 0]], [180, [-1, 0, 0, -1]], [270, [0, 1, -1, 0]],
  ];
  const use = rotations ? rots : rots.slice(0, 1);
  const out: Xform[] = use.map(([rotation, m]) => ({ rotation, mirrored: false, m }));
  if (mirror) {
    // reflect x, then rotate: m' = R · diag(-1, 1)
    for (const [rotation, m] of use) out.push({ rotation, mirrored: true, m: [-m[0], m[1], -m[2], m[3]] });
  }
  return out;
}

const apply = (m: [number, number, number, number], x: number, y: number): Point =>
  [m[0] * x + m[1] * y, m[2] * x + m[3] * y];

/** m ∘ t — apply t first, then m. Both are orthogonal 2×2s from transformsFor. */
const compose = (m: [number, number, number, number], t: [number, number, number, number]): [number, number, number, number] =>
  [m[0] * t[0] + m[1] * t[2], m[0] * t[1] + m[1] * t[3], m[2] * t[0] + m[3] * t[2], m[2] * t[1] + m[3] * t[3]];

/** Endpoint spatial hash over the sheet's segments: cell → segment indices
 * with an endpoint in that cell. Cell size ≥ 2×tol so a tolerance ball around
 * any query point is covered by the 3×3 cell neighborhood. */
class EndpointGrid {
  private cells = new Map<number, number[]>();
  private cell: number;
  constructor(private segs: number[], tol: number) {
    this.cell = Math.max(2 * tol, 4);
    const n = segs.length >> 2;
    for (let i = 0; i < n; i++) {
      this.add(segs[i * 4], segs[i * 4 + 1], i);
      this.add(segs[i * 4 + 2], segs[i * 4 + 3], i);
    }
  }
  private key(cx: number, cy: number): number { return cx * 73856093 ^ cy * 19349663; }
  private add(x: number, y: number, i: number): void {
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    const a = this.cells.get(k);
    if (a) { if (a[a.length - 1] !== i) a.push(i); } else this.cells.set(k, [i]);
  }
  /** Indices of segments with an endpoint within one cell of (x, y). */
  near(x: number, y: number, out: number[]): number[] {
    out.length = 0;
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const a = this.cells.get(this.key(cx + dx, cy + dy));
      if (a) for (const i of a) out.push(i);
    }
    return out;
  }
}

const segLen = (segs: number[], i: number): number =>
  Math.hypot(segs[i * 4 + 2] - segs[i * 4], segs[i * 4 + 3] - segs[i * 4 + 1]);

/** A symbol's fingerprint, detached from the sheet it was marqueed on:
 * centroid-relative segments plus the diagnostics every consumer reports.
 * Pure data — matchSymbol can run it against any sheet's segments. */
export interface SymbolFingerprint {
  /** Centroid-relative seed segments: [ax, ay, bx, by, len] per entry. */
  rel: number[][];
  /** Total seed linework length, px. */
  totalLen: number;
  /** Seed segment count. */
  segments: number;
  /** The seed instance's own length-weighted centroid, SOURCE-sheet image px
   * — meaningful only on the sheet the fingerprint was built from. */
  center: Point;
  /** Diagonal of the seed's tight bbox, px — the symbol's physical footprint.
   * Half of it is the shadow-suppression radius: two REAL instances can never
   * sit closer without physically overlapping. */
  footprint: number;
  /** Per-rel-entry stroke luminance, 0–255, when the caller handed in the
   * sheet's `lum` channel (#260). Only consulted when a luminance tolerance is
   * STATED — see MatchOptions.lumTol. */
  lum?: number[];
  /** Seed segments that fell below MIN_SEG_LEN when the fingerprint was scaled
   * down to a target sheet — detail that cannot survive the trip and is
   * excluded from the score rather than depressing it. Present only on a
   * scaled fingerprint, and only when something was actually dropped: the
   * caller discloses it, because "matched 100% of what was left" is a
   * different claim from "matched 100% of the symbol". */
  subPixelDropped?: number;
}

export interface SymbolMatchResult {
  matches: SweepMatch[];
  withheld: SweepWithheld[];
  candidates: { considered: number; dropped: number };
  /** True when every proposed placement was scored — the count is a total.
   * False means the ceiling bit: the count is a FLOOR, not a total (#261). */
  complete: boolean;
  /** Present ONLY when a stated ratio ≠ 1 was applied (#186), so a same-scale
   * result is the same object it always was. What the ratio cost, so the
   * caller can disclose it: the searched-for symbol's size on the target
   * sheet, how many seed segments went sub-pixel getting there, and the
   * tolerance the endpoints were actually tested at. */
  scaled?: { ratio: number; segments: number; sub_pixel_dropped: number; footprint_px: number; tol_px: number };
  /** Placements a counter-example rejected (#259) — named, with the negative
   * that did it and what it saw, so an exclusion can be revised without
   * re-running the sweep. Empty when no counter-example was given. */
  rejected: SweepRejected[];
  /** What each counter-example was read as, in `exclude` order (#259) — the
   * mechanic inferred from the rect's own contents. null means the rect held
   * nothing usable, which is a report, not a silence. */
  negatives?: Array<{ mode: "shape" | "crossing"; segments: number; center: Point } | null>;
  /** Present ONLY when a luminance tolerance was stated and the sheet supplied
   * the channel (#260). What the gate was and what it cost: the seed's own
   * luminance band, and how many placements it pulled under the commit bar —
   * a stated gate that removes 152 matches has to say so. */
  lum_gate?: { tol: number; seed_lum: number[]; rejected: number; at: Point[] };
}

export interface MatchOptions extends SweepOptions {
  /** Suppress placements within half a footprint of this point — the seed's
   * own location when matching the sheet it was marqueed on. Omit when the
   * fingerprint came from a DIFFERENT sheet: there is no seed here to shadow. */
  excludeCenter?: Point;
  /** Stated seed→target size ratio: seed-sheet image px per target-sheet image
   * px, i.e. `upp_seed / upp_target` (#186). Default 1 — the same-scale case,
   * bit-for-bit the pre-#186 search. A symbol marqueed on a 1-1/2" = 1'-0"
   * detail and swept across a 1/8" plan passes ~1/12. NEVER searched: the
   * caller states it from two committed scales or doesn't sweep across them. */
  scale?: number;
}

/** A fingerprint resized by a stated ratio, for matching against a sheet drawn
 * at a different scale (#186). Pure and separately testable.
 *
 * Sub-pixel casualties are real and are dropped, not carried: a seed segment
 * that scales below MIN_SEG_LEN cannot be matched at any honest tolerance, so
 * leaving it in `totalLen` would permanently depress every score on that sheet
 * and push real instances under the commit bar. `totalLen` is recomputed over
 * the survivors and the count of the fallen rides `subPixelDropped` — the
 * score stays a truthful fraction of what was actually searched for, and the
 * caller can say so. */
export function scaleFingerprint(fp: SymbolFingerprint, k: number): SymbolFingerprint {
  if (!Number.isFinite(k) || !(k > 0)) {
    throw new Error(markDanger(_t("sweep.ratio_not_finite", { k })));
  }
  if (k === 1) return fp;
  if (k < SWEEP_MIN_SCALE || k > SWEEP_MAX_SCALE) {
    throw new Error(markDanger(_t("sweep.ratio_out_of_band", { k: k.toFixed(4), min: SWEEP_MIN_SCALE, max: SWEEP_MAX_SCALE })));
  }
  const rel: number[][] = [];
  const lum: number[] = [];
  let totalLen = 0;
  let subPixelDropped = 0;
  for (let i = 0; i < fp.rel.length; i++) {
    const r = fp.rel[i];
    const len = r[4] * k;
    if (len < MIN_SEG_LEN) { subPixelDropped++; continue; }
    rel.push([r[0] * k, r[1] * k, r[2] * k, r[3] * k, len]);
    if (fp.lum) lum.push(fp.lum[i]);
    totalLen += len;
  }
  if (!rel.length) {
    throw new Error(markDanger(_t("sweep.ratio_all_subpixel", { k: k.toFixed(4), min: MIN_SEG_LEN })));
  }
  return {
    rel,
    totalLen,
    segments: rel.length,
    center: fp.center,
    footprint: fp.footprint * k,
    ...(fp.lum ? { lum } : {}),
    ...(subPixelDropped ? { subPixelDropped } : {}),
  };
}

/** Step 1 alone: the segments fully inside the seed rect, expressed relative
 * to their length-weighted centroid. Throws the same instructive refusals
 * sweepSymbols always has (empty marquee, region-sized marquee). */
export function fingerprintSymbol(segs: number[], seedRect: [Point, Point], lum?: Uint8Array): SymbolFingerprint {
  const n = segs.length >> 2;
  const rx0 = Math.min(seedRect[0][0], seedRect[1][0]), rx1 = Math.max(seedRect[0][0], seedRect[1][0]);
  const ry0 = Math.min(seedRect[0][1], seedRect[1][1]), ry1 = Math.max(seedRect[0][1], seedRect[1][1]);

  const inside = (x: number, y: number): boolean => x >= rx0 && x <= rx1 && y >= ry0 && y <= ry1;
  const seedIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (inside(segs[i * 4], segs[i * 4 + 1]) && inside(segs[i * 4 + 2], segs[i * 4 + 3]) && segLen(segs, i) >= MIN_SEG_LEN) {
      seedIdx.push(i);
    }
  }
  if (!seedIdx.length) {
    throw new Error(markDanger(_t("sweep.no_segments_in_rect")));
  }
  if (seedIdx.length > MAX_SEED_SEGS) {
    throw new Error(markDanger(_t("sweep.too_many_segments", { count: seedIdx.length })));
  }

  let totalLen = 0, cxw = 0, cyw = 0;
  for (const i of seedIdx) {
    const L = segLen(segs, i);
    totalLen += L;
    cxw += ((segs[i * 4] + segs[i * 4 + 2]) / 2) * L;
    cyw += ((segs[i * 4 + 1] + segs[i * 4 + 3]) / 2) * L;
  }
  const seedCx = cxw / totalLen, seedCy = cyw / totalLen;
  // centroid-relative seed segments: [ax, ay, bx, by, len] per entry
  const rel = seedIdx.map((i) => [
    segs[i * 4] - seedCx, segs[i * 4 + 1] - seedCy,
    segs[i * 4 + 2] - seedCx, segs[i * 4 + 3] - seedCy,
    segLen(segs, i),
  ]);
  // the symbol's own footprint (tight bbox over the seed segments) — the
  // shadow-suppression radius in matchSymbol is half its diagonal
  let sbx0 = Infinity, sby0 = Infinity, sbx1 = -Infinity, sby1 = -Infinity;
  for (const i of seedIdx) {
    sbx0 = Math.min(sbx0, segs[i * 4], segs[i * 4 + 2]); sby0 = Math.min(sby0, segs[i * 4 + 1], segs[i * 4 + 3]);
    sbx1 = Math.max(sbx1, segs[i * 4], segs[i * 4 + 2]); sby1 = Math.max(sby1, segs[i * 4 + 1], segs[i * 4 + 3]);
  }
  return {
    rel,
    totalLen,
    segments: seedIdx.length,
    center: [seedCx, seedCy],
    footprint: Math.hypot(sbx1 - sbx0, sby1 - sby0),
    ...(lum && lum.length ? { lum: seedIdx.map((i) => lum[i] ?? 0) } : {}),
  };
}

// ── counter-examples ────────────────────────────────────────────────────────
// #259, reported by @FrankAtGHub, from counting a wall-mounted data outlet on
// an electrical set: the flush-floor variant of the same device is the SAME
// TRIANGLE inside a square, so it contains the wall symbol by drafting
// convention and matches on every sheet drawn that way. Asking drafting
// offices to stop reusing generic shapes is not a remedy — the matcher has to
// absorb the ambiguity.
//
// A negative is one more marquee: drag a box around the thing you do not mean.
// The caller never chooses a mechanism; the rect's own contents decide which
// of the two applies, because both are the same gesture to the person doing
// it.
//
//   SHAPE — the negative holds extra linework the positive does not (the
//   square around the flush outlet, the letter inside a keynote triangle).
//   The discriminator is local, so it fingerprints exactly like a positive.
//
//   CROSSING — the negative holds NO extra contained linework; what
//   distinguishes it is a line that passes THROUGH it. This mode exists
//   because `fingerprintSymbol` admits only segments FULLY INSIDE the rect,
//   which structurally excludes background structure — background structure
//   is long by nature. Frank's measured case: a 2×4 ceiling fixture on a 2 ft
//   grid, where two empty tiles reproduce the fixture's outline exactly. The
//   empty tile still has the grid line running through its middle at 337 px;
//   the real fixture, drawn over the grid, BREAKS it. A clean presence/absence
//   discriminator that no contained fingerprint can express.
//
// Both are expressed in the POSITIVE's canonical frame, so a rejection applies
// under every rotation and mirror the sweep searches.

/** Evidence bar: a placement is rejected when this fraction of the negative's
 * discriminating linework (by length) is present at it. Half is the honest
 * reading of "the negative explains this placement at least as well" — a
 * lookalike carries the whole feature or none of it, and demanding all of it
 * would let one clipped segment reinstate a phantom. */
export const EXCLUDE_EVIDENCE_BAR = 0.5;

/** A negative resized for a target sheet drawn at another scale (#186's rule
 * applied to #259's counter-examples): sub-pixel casualties are dropped rather
 * than carried, so the evidence fraction stays a truthful fraction of what was
 * actually searched for. */
export function scaleNegative(neg: SymbolNegative, k: number): SymbolNegative {
  if (k === 1) return neg;
  const rel: number[][] = [];
  for (const r of neg.rel) {
    const len = r[4] * k;
    if (len < MIN_SEG_LEN) continue;
    rel.push([r[0] * k, r[1] * k, r[2] * k, r[3] * k, len]);
  }
  return { mode: neg.mode, rel, totalLen: rel.reduce((t, r) => t + r[4], 0), center: neg.center };
}

export interface SymbolNegative {
  mode: "shape" | "crossing";
  /** Discriminating segments in the POSITIVE's canonical frame:
   * [ax, ay, bx, by, len] — contained extras (shape) or rect-clipped
   * crossings (crossing). */
  rel: number[][];
  totalLen: number;
  /** The negative instance's own centroid on the seed sheet — reported so a
   * caller can show what it read. */
  center: Point;
}

/** Cell index over segment BODIES — the endpoint hash cannot answer "is a
 * long line running through here", because a 337 px grid line's endpoints are
 * nowhere near the symbol it crosses. Built lazily, and only when a crossing
 * negative is in play. */
class BodyGrid {
  private cells = new Map<number, number[]>();
  constructor(private segs: number[], private cell: number) {
    const n = segs.length >> 2;
    for (let i = 0; i < n; i++) {
      const ax = segs[i * 4], ay = segs[i * 4 + 1], bx = segs[i * 4 + 2], by = segs[i * 4 + 3];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / cell));
      let last = -1;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const key = this.key(Math.floor((ax + (bx - ax) * t) / cell), Math.floor((ay + (by - ay) * t) / cell));
        if (key === last) continue;
        last = key;
        const a = this.cells.get(key);
        if (a) { if (a[a.length - 1] !== i) a.push(i); } else this.cells.set(key, [i]);
      }
    }
  }
  private key(cx: number, cy: number): number { return cx * 73856093 ^ cy * 19349663; }
  /** Segment indices whose body passes through the cell holding (x, y) or any neighbour. */
  near(x: number, y: number): number[] {
    const out: number[] = [];
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const a = this.cells.get(this.key(cx + dx, cy + dy));
      if (a) for (const i of a) if (!out.includes(i)) out.push(i);
    }
    return out;
  }
}

/** Clip a segment to a rect (Liang–Barsky), or null when it misses. */
function clipToRect(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] | null {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
  for (let k = 0; k < 4; k++) {
    if (p[k] === 0) { if (q[k] < 0) return null; continue; }
    const r = q[k] / p[k];
    if (p[k] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy];
}

/** Distance from (px,py) to the segment (ax,ay)-(bx,by). */
function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Read one counter-example rect into a negative, in the positive's frame.
 *
 * Alignment first: the negative is an instance of the positive PLUS whatever
 * makes it not one, so the positive is located inside the rect (best scoring
 * placement whose centroid lands there) and everything is expressed relative
 * to THAT placement. Without this step a negative marqueed at a different
 * rotation, or a few px off-centre, would describe geometry that never lines
 * up with a candidate.
 *
 * Returns null when the rect holds no recognisable instance of the positive
 * (nothing to subtract from — the caller refuses rather than guessing) or when
 * it holds no discriminating geometry at all (a negative identical to the
 * positive would reject every real match).
 */
export function buildNegative(fp: SymbolFingerprint, segs: number[], rect: [Point, Point], opts: MatchOptions = {}): SymbolNegative | null {
  const tol = opts.tolPx ?? SWEEP_TOL_PX;
  const rx0 = Math.min(rect[0][0], rect[1][0]), rx1 = Math.max(rect[0][0], rect[1][0]);
  const ry0 = Math.min(rect[0][1], rect[1][1]), ry1 = Math.max(rect[0][1], rect[1][1]);
  const pad = fp.footprint + 4 * tol;
  // work against the rect's neighbourhood only: alignment is a local question
  const localIdx: number[] = [];
  const local: number[] = [];
  const n = segs.length >> 2;
  for (let i = 0; i < n; i++) {
    const ax = segs[i * 4], ay = segs[i * 4 + 1], bx = segs[i * 4 + 2], by = segs[i * 4 + 3];
    if (Math.max(ax, bx) < rx0 - pad || Math.min(ax, bx) > rx1 + pad) continue;
    if (Math.max(ay, by) < ry0 - pad || Math.min(ay, by) > ry1 + pad) continue;
    localIdx.push(i);
    local.push(ax, ay, bx, by);
  }
  if (!local.length) return null;

  // align: score the positive against the neighbourhood and keep the best
  // placement centred inside the rect
  const aligned = matchSymbol(fp, local, {
    rotations: opts.rotations ?? true,
    mirror: opts.mirror ?? true,
    tolPx: tol,
    scoreHigh: 1.01,          // classify nothing; we only want the scored list
    scoreLow: 0.5,
  });
  const inRect = aligned.withheld.filter((w) => w.at[0] >= rx0 && w.at[0] <= rx1 && w.at[1] >= ry0 && w.at[1] <= ry1);
  if (!inRect.length) return null;
  const best = inRect.reduce((a, b) => (b.score > a.score ? b : a));
  const xf = transformsFor(opts.rotations ?? true, opts.mirror ?? true)
    .find((x) => x.rotation === best.rotation && x.mirrored === best.mirrored);
  if (!xf) return null;
  // canonical frame: undo the negative instance's own placement. The
  // transforms are orthogonal, so the inverse is the transpose.
  const inv: [number, number, number, number] = [xf.m[0], xf.m[2], xf.m[1], xf.m[3]];
  const toCanon = (x: number, y: number): Point => apply(inv, x - best.at[0], y - best.at[1]);

  // which local segments the positive already explains at that placement
  const explained = new Set<number>();
  for (const r of fp.rel) {
    const a = apply(xf.m, r[0], r[1]);
    const b = apply(xf.m, r[2], r[3]);
    const ax = a[0] + best.at[0], ay = a[1] + best.at[1], bx = b[0] + best.at[0], by = b[1] + best.at[1];
    for (let k = 0; k < localIdx.length; k++) {
      const px = local[k * 4], py = local[k * 4 + 1], qx = local[k * 4 + 2], qy = local[k * 4 + 3];
      const hit = (Math.hypot(px - ax, py - ay) <= tol && Math.hypot(qx - bx, qy - by) <= tol)
        || (Math.hypot(qx - ax, qy - ay) <= tol && Math.hypot(px - bx, py - by) <= tol);
      // no break: EVERY local segment the positive explains is explained.
      // Drafting duplicates coincident linework constantly — adjacent ceiling
      // tiles each draw the edge they share — and stopping at the first hit
      // would leave the twin looking like extra evidence, which flips the
      // inferred mode and turns a background line into a "shape" negative.
      if (hit) explained.add(k);
    }
  }

  const inside = (x: number, y: number): boolean => x >= rx0 && x <= rx1 && y >= ry0 && y <= ry1;
  const extras: number[][] = [];
  const crossings: number[][] = [];
  for (let k = 0; k < localIdx.length; k++) {
    if (explained.has(k)) continue;
    const ax = local[k * 4], ay = local[k * 4 + 1], bx = local[k * 4 + 2], by = local[k * 4 + 3];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < MIN_SEG_LEN) continue;
    if (inside(ax, ay) && inside(bx, by)) {
      const a = toCanon(ax, ay), b = toCanon(bx, by);
      extras.push([a[0], a[1], b[0], b[1], L]);
    } else {
      const c = clipToRect(ax, ay, bx, by, rx0, ry0, rx1, ry1);
      // a crossing must genuinely PASS THROUGH: a stub poking into the rect is
      // an alignment artifact, not background structure
      if (c && Math.hypot(c[2] - c[0], c[3] - c[1]) >= 2 * tol && L > fp.footprint) {
        const a = toCanon(c[0], c[1]), b = toCanon(c[2], c[3]);
        crossings.push([a[0], a[1], b[0], b[1], Math.hypot(c[2] - c[0], c[3] - c[1])]);
      }
    }
  }
  // Contained extras win where they exist: they are local evidence, and a
  // symbol that carries its own distinguishing mark should not be judged by
  // what happens to run past it.
  const rel = extras.length ? extras : crossings;
  if (!rel.length) return null;
  return {
    mode: extras.length ? "shape" : "crossing",
    rel,
    totalLen: rel.reduce((t, r) => t + r[4], 0),
    center: [Math.round(best.at[0] * 10) / 10, Math.round(best.at[1] * 10) / 10],
  };
}

/** One physical placement, one entry (#293). A dense symbol proposes the same
 * instance from many anchor pairs at centers spread wider than the merge
 * radius, so clustering keeps the old walking semantics — an entry follows
 * the best-scoring proposal of its neighborhood — but that walk could END
 * with two entries on the same peak: each walker absorbed its own chain, and
 * nothing re-checked the pairwise invariant after a move. Measured on a real
 * plumbing sheet as one floor drain committed twice, 0.2 px apart (0.921 and
 * 0.925), the two markers stacked into what renders as a single ×. The final
 * pass restores the invariant greedily by score — greedy never moves a
 * position, so it cannot re-break what it enforces. Exported for the tests:
 * the failure is a property of proposal ORDER, which drawn-ink fixtures
 * cannot pin down deterministically. */
export function mergeProposals<T extends { at: Point; score: number; xf: number; rotation: number; mirrored: boolean }>(scored: T[], mergeR: number): T[] {
  const kept: T[] = [];
  for (const s of scored) {
    const twin = kept.find((k) => Math.hypot(k.at[0] - s.at[0], k.at[1] - s.at[1]) <= mergeR);
    if (!twin) { kept.push({ ...s }); continue; }
    if (s.score > twin.score || (s.score === twin.score && s.xf < twin.xf)) {
      twin.at = s.at; twin.score = s.score; twin.rotation = s.rotation; twin.mirrored = s.mirrored; twin.xf = s.xf;
    }
  }
  const byBest = [...kept].sort((a, b) =>
    b.score - a.score || a.xf - b.xf || a.at[1] - b.at[1] || a.at[0] - b.at[0]);
  const out: T[] = [];
  for (const s of byBest) {
    if (out.some((k) => Math.hypot(k.at[0] - s.at[0], k.at[1] - s.at[1]) <= mergeR)) continue;
    out.push(s);
  }
  return out;
}

/** Steps 2–4 against ANY sheet's segments: constellation candidates, scoring,
 * classification. Anchor rarity is judged per TARGET sheet — the same seed
 * prunes differently on sheets with different length histograms, which is the
 * point of rarity-first anchors. */
export function matchSymbol(fp: SymbolFingerprint, segs: number[], opts: MatchOptions = {}): SymbolMatchResult {
  const scale = opts.scale ?? 1;
  // The seed's own drawn jitter is magnified along with the seed, so tolerance
  // follows the ratio UP and never down: the target sheet's jitter is its own
  // and does not shrink because the fingerprint did. max(1, scale) also makes
  // every scale ≤ 1 path — including the whole one-sheet surface — take the
  // identical tolerance it took before #186.
  const tol = (opts.tolPx ?? SWEEP_TOL_PX) * Math.max(1, scale);
  const scoreHigh = opts.scoreHigh ?? SWEEP_SCORE_HIGH;
  const scoreLow = opts.scoreLow ?? SWEEP_SCORE_LOW;
  const maxCandidates = opts.maxCandidates ?? SWEEP_CANDIDATE_CEILING;
  const xforms = transformsFor(opts.rotations ?? true, opts.mirror ?? true);
  const n = segs.length >> 2;
  if (scale !== 1 && opts.excludeCenter) {
    throw new Error(markDanger(_t("sweep.exclude_center_scale")));
  }
  const fpS = scale === 1 ? fp : scaleFingerprint(fp, scale);
  // Only the scaling trip is guarded. A caller who widens tolPx on a same-scale
  // sweep is making a deliberate, long-standing choice about ITS OWN sheet and
  // is not owed a refusal; a symbol that shrank into the tolerance did not
  // choose anything, and its "matches" would be noise.
  if (scale !== 1 && fpS.footprint < MIN_FOOTPRINT_TOLS * tol) {
    throw new Error(markDanger(_t("sweep.symbol_too_small", { scale: scale.toFixed(4), footprint: fpS.footprint.toFixed(1), tol: tol.toFixed(1) })));
  }
  const { rel, totalLen } = fpS;

  // ── 2. candidates ──────────────────────────────────────────────────────────
  // Sheet-wide length histogram (bucket = round(len)) for anchor rarity and
  // the per-anchor candidate walk. Deterministic: plain arrays, sorted scans.
  const lenBucket = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const b = Math.round(segLen(segs, i));
    const a = lenBucket.get(b);
    if (a) a.push(i); else lenBucket.set(b, [i]);
  }
  const bucketBand = (L: number): number[] => {
    // every sheet segment with |len − L| ≤ 2·tol (both endpoints off by tol
    // can stretch/shrink the drawn length by up to 2·tol)
    const out: number[] = [];
    for (let b = Math.floor(L - 2 * tol); b <= Math.ceil(L + 2 * tol); b++) {
      const a = lenBucket.get(b);
      if (a) for (const i of a) if (Math.abs(segLen(segs, i) - L) <= 2 * tol) out.push(i);
    }
    return out;
  };

  // anchor selection: rarest DISTINCT quantized lengths first (rarity prunes
  // hardest), longest first on ties so structure beats tick marks
  const byLenQ = new Map<number, { relIdx: number; len: number; rarity: number }>();
  for (let k = 0; k < rel.length; k++) {
    const L = rel[k][4];
    const q = Math.round(L);
    if (!byLenQ.has(q)) byLenQ.set(q, { relIdx: k, len: L, rarity: bucketBand(L).length });
  }
  const anchors = [...byLenQ.values()]
    .sort((a, b) => a.rarity - b.rarity || b.len - a.len || a.relIdx - b.relIdx)
    .slice(0, ANCHOR_COUNT);

  // Each (anchor, transform, matching sheet segment, endpoint pairing)
  // proposes ONE candidate centroid. Both endpoint mappings must agree on the
  // centroid within tolerance, or the sheet segment merely shares a length.
  type Cand = { tx: number; ty: number; xf: number };
  const proposals: Cand[] = [];
  const seen = new Set<string>();
  const quant = Math.max(tol, 1);
  for (let xi = 0; xi < xforms.length; xi++) {
    const { m } = xforms[xi];
    for (const anc of anchors) {
      const r = rel[anc.relIdx];
      const A = apply(m, r[0], r[1]);
      const B = apply(m, r[2], r[3]);
      for (const j of bucketBand(anc.len)) {
        const px = segs[j * 4], py = segs[j * 4 + 1], qx = segs[j * 4 + 2], qy = segs[j * 4 + 3];
        // pairing 1: (p, q) = (A, B); pairing 2: reversed
        for (const [ax, ay, bx, by] of [[A[0], A[1], B[0], B[1]], [B[0], B[1], A[0], A[1]]] as const) {
          const c1x = px - ax, c1y = py - ay;
          const c2x = qx - bx, c2y = qy - by;
          if (Math.abs(c1x - c2x) > 2 * tol || Math.abs(c1y - c2y) > 2 * tol) continue;
          const tx = (c1x + c2x) / 2, ty = (c1y + c2y) / 2;
          const key = `${xi}:${Math.round(tx / quant)}:${Math.round(ty / quant)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          proposals.push({ tx, ty, xf: xi });
        }
      }
    }
  }

  // Deterministic scoring order (reading order, then transform preference),
  // so the cap — when it bites — always drops the same placements and the
  // dropped count means the same thing run to run.
  proposals.sort((a, b) => a.ty - b.ty || a.tx - b.tx || a.xf - b.xf);
  const considered = Math.min(proposals.length, maxCandidates);
  const dropped = proposals.length - considered;

  // ── 3. score ───────────────────────────────────────────────────────────────
  const grid = new EndpointGrid(segs, tol);
  const scratch: number[] = [];
  const tol2 = tol * tol;
  const near = (x1: number, y1: number, x2: number, y2: number): boolean =>
    (x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2) <= tol2;
  // #260 — the stated luminance gate. Live only when the caller supplied the
  // sheet's channel AND a tolerance: a sheet segment answers for a seed
  // segment only if their stroke luminances are within it. Off by default, so
  // every existing sweep scores exactly as it did.
  const sheetLum = opts.lum;
  const lumTol = opts.lumTol;
  const lumGate = sheetLum && sheetLum.length && fpS.lum && typeof lumTol === "number" && lumTol >= 0 && lumTol < 255;
  const lumOk = (j: number, k: number): boolean =>
    !lumGate || Math.abs((sheetLum as Uint8Array)[j] - (fpS.lum as number[])[k]) <= (lumTol as number);
  const scoreAt = (m: [number, number, number, number], tx: number, ty: number, ungated?: { v: number }): number => {
    let matched = 0, matchedAny = 0;
    for (let k = 0; k < rel.length; k++) {
      const r = rel[k];
      const a = apply(m, r[0], r[1]);
      const b = apply(m, r[2], r[3]);
      const ax = a[0] + tx, ay = a[1] + ty, bx = b[0] + tx, by = b[1] + ty;
      let hit = false, hitAny = false;
      for (const j of grid.near(ax, ay, scratch)) {
        const px = segs[j * 4], py = segs[j * 4 + 1], qx = segs[j * 4 + 2], qy = segs[j * 4 + 3];
        if ((near(px, py, ax, ay) && near(qx, qy, bx, by)) || (near(qx, qy, ax, ay) && near(px, py, bx, by))) {
          hitAny = true;
          if (lumOk(j, k)) { hit = true; break; }
        }
      }
      if (hit) matched += r[4];
      if (hitAny) matchedAny += r[4];
    }
    if (ungated) ungated.v = matchedAny / totalLen;
    return matched / totalLen;
  };

  // ── 4. classify + dedupe ───────────────────────────────────────────────────
  // One physical placement can be proposed by several anchors and — for a
  // symmetric symbol — several transforms; centers agree within ~tol, so a
  // small merge radius collapses them to the best score (earliest transform
  // on ties: the plainest reading wins deterministically).
  type Scored = SweepMatch & { xf: number };
  const scored: Scored[] = [];
  const ungated = { v: 0 };
  // Placements the geometry alone would have COMMITTED and the stated
  // luminance gate did not — the gate's cost, collected as placements rather
  // than tallied as proposals: one physical spot is proposed by several
  // anchors and transforms, and a count that says 16 for 8 phantoms is a
  // count nobody can check against the sheet.
  const lumOut: Point[] = [];
  for (let k = 0; k < considered; k++) {
    const c = proposals[k];
    const score = scoreAt(xforms[c.xf].m, c.tx, c.ty, lumGate ? ungated : undefined);
    if (lumGate && ungated.v >= scoreHigh && score < scoreHigh) lumOut.push([c.tx, c.ty]);
    if (score < scoreLow) continue;
    scored.push({ at: [c.tx, c.ty], score, rotation: xforms[c.xf].rotation, mirrored: xforms[c.xf].mirrored, xf: c.xf });
  }
  const mergeR = Math.max(2 * tol, 4);
  const kept = mergeProposals(scored, mergeR);

  // Shadow suppression. A partially-symmetric symbol reads ALMOST as itself
  // under the wrong transform — square + diagonal without the stub — at a
  // center offset by up to the centroid's eccentricity. Those readings are
  // not questions: the instance is already counted (or is the seed itself).
  // Two REAL instances can never sit within half a symbol diagonal of each
  // other without physically overlapping, so anything that close to the seed
  // or to an accepted match is the same ink read sideways, and listing it as
  // withheld would bury the real near-misses in symmetry noise.
  const suppressR = Math.max(mergeR, fpS.footprint / 2);
  const ex = opts.excludeCenter;
  const away = ex ? kept.filter((s) => Math.hypot(s.at[0] - ex[0], s.at[1] - ex[1]) > suppressR) : kept;

  // one physical spot per entry, seed shadow excluded, reading order — the
  // same treatment matches and withheld get, so the numbers are comparable
  const lumRejectedAt: Point[] = [];
  for (const p of lumOut) {
    if (ex && Math.hypot(p[0] - ex[0], p[1] - ex[1]) <= suppressR) continue;
    if (lumRejectedAt.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= mergeR)) continue;
    lumRejectedAt.push([Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
  }
  lumRejectedAt.sort((a, b) => a[1] - b[1] || a[0] - b[0]);

  // ── 4b. counter-examples (#259) ───────────────────────────────────────────
  // Read each negative rect once, then test every surviving placement against
  // it. Rejection is disclosed, never silent: a placement that the geometry
  // accepted and a negative refused is the most interesting thing the sweep
  // has to say.
  // A counter-example's discriminating linework is expressed in the POSITIVE's
  // canonical frame — but a symbol that maps onto ITSELF under a rotation or a
  // mirror has no single canonical frame, and the transform a match reports is
  // then arbitrary among its equivalents (the merge keeps the earliest on a
  // tie). A square seed is the extreme case: eight transforms, one shape. So
  // the negative is tested under every transform that maps the SEED onto
  // itself, and the best reading wins. Without this, a rotated instance of the
  // very thing you excluded comes back counted, which is the same miscount the
  // issue is about, wearing a different hat.
  const selfSym: Array<[number, number, number, number]> = [];
  {
    const relPts = rel.map((r) => [r[0], r[1], r[2], r[3], r[4]] as const);
    const hasSeg = (ax: number, ay: number, bx: number, by: number): boolean =>
      relPts.some((q) =>
        (Math.hypot(q[0] - ax, q[1] - ay) <= tol && Math.hypot(q[2] - bx, q[3] - by) <= tol)
        || (Math.hypot(q[2] - ax, q[3] - ay) <= tol && Math.hypot(q[0] - bx, q[1] - by) <= tol));
    for (const xf of xforms) {
      let same = true;
      for (const r of relPts) {
        const a = apply(xf.m, r[0], r[1]);
        const b = apply(xf.m, r[2], r[3]);
        if (!hasSeg(a[0], a[1], b[0], b[1])) { same = false; break; }
      }
      if (same) selfSym.push(xf.m);
    }
    if (!selfSym.length) selfSym.push([1, 0, 0, 1]);
  }

  const negRects = opts.exclude || [];
  const negatives: Array<SymbolNegative | null> = opts.negatives
    ? opts.negatives.map((neg) => (scale === 1 ? neg : scaleNegative(neg, scale)))
    : negRects.map((r) => buildNegative(fp, segs, r, { ...opts, exclude: undefined, negatives: undefined }));
  const liveNegs = negatives.filter((neg): neg is SymbolNegative => !!neg);
  const needsBody = liveNegs.some((neg) => neg.mode === "crossing");
  const body = needsBody ? new BodyGrid(segs, Math.max(32, fpS.footprint)) : null;
  // how much of a negative's discriminating linework is present at a placement
  const evidenceOne = (neg: SymbolNegative, m: [number, number, number, number], tx: number, ty: number): number => {
    let found = 0;
    for (const r of neg.rel) {
      const a = apply(m, r[0], r[1]);
      const b = apply(m, r[2], r[3]);
      const ax = a[0] + tx, ay = a[1] + ty, bx = b[0] + tx, by = b[1] + ty;
      if (neg.mode === "shape") {
        // the extra mark itself, endpoint-matched exactly like the positive
        let hit = false;
        for (const j of grid.near(ax, ay, scratch)) {
          const px = segs[j * 4], py = segs[j * 4 + 1], qx = segs[j * 4 + 2], qy = segs[j * 4 + 3];
          if ((near(px, py, ax, ay) && near(qx, qy, bx, by)) || (near(qx, qy, ax, ay) && near(px, py, bx, by))) { hit = true; break; }
        }
        if (hit) found += r[4];
      } else {
        // the line that passes through: present when ONE sheet segment covers
        // the whole chord. A broken line — the fixture drawn over the grid —
        // has no such segment, which is the whole discriminator.
        let covered = false;
        for (const j of body!.near((ax + bx) / 2, (ay + by) / 2)) {
          const px = segs[j * 4], py = segs[j * 4 + 1], qx = segs[j * 4 + 2], qy = segs[j * 4 + 3];
          if (distToSeg(ax, ay, px, py, qx, qy) <= tol && distToSeg(bx, by, px, py, qx, qy) <= tol) { covered = true; break; }
        }
        if (covered) found += r[4];
      }
    }
    return neg.totalLen ? found / neg.totalLen : 0;
  };
  /** The best reading across the seed's own symmetry group (see selfSym). */
  const evidenceAt = (neg: SymbolNegative, m: [number, number, number, number], tx: number, ty: number): number => {
    let best = 0;
    for (const t of selfSym) {
      best = Math.max(best, evidenceOne(neg, compose(m, t), tx, ty));
      if (best >= 1) break;
    }
    return best;
  };
  const rejected: SweepRejected[] = [];
  const survivors: Scored[] = [];
  for (const sc of away) {
    let killed: { by: number; neg: SymbolNegative; ev: number } | null = null;
    for (let bi = 0; bi < negatives.length; bi++) {
      const neg = negatives[bi];
      if (!neg) continue;
      const ev = evidenceAt(neg, xforms[sc.xf].m, sc.at[0], sc.at[1]);
      if (ev >= EXCLUDE_EVIDENCE_BAR && (!killed || ev > killed.ev)) killed = { by: bi, neg, ev };
    }
    if (killed) {
      rejected.push({
        at: [Math.round(sc.at[0] * 10) / 10, Math.round(sc.at[1] * 10) / 10] as Point,
        score: Math.round(sc.score * 1000) / 1000,
        rotation: sc.rotation,
        mirrored: sc.mirrored,
        by: killed.by,
        mode: killed.neg.mode,
        evidence: Math.round(killed.ev * 1000) / 1000,
        reason: killed.neg.mode === "shape"
          ? `matched the seed at ${Math.round(sc.score * 100)}%, but ${Math.round(killed.ev * 100)}% of counter-example ${killed.by + 1}'s extra linework is here too — the negative explains this placement at least as well`
          : `matched the seed at ${Math.round(sc.score * 100)}%, but the line counter-example ${killed.by + 1} sits on runs through this placement UNBROKEN (${Math.round(killed.ev * 100)}% of it) — a real instance drawn over it would break it`,
      });
      continue;
    }
    survivors.push(sc);
  }

  const matches: SweepMatch[] = [];
  const withheld: SweepWithheld[] = [];
  const pct = (v: number): number => Math.round(v * 1000) / 1000;
  const row = (s: Scored): SweepMatch => ({
    at: [Math.round(s.at[0] * 10) / 10, Math.round(s.at[1] * 10) / 10] as Point,
    score: pct(s.score),
    rotation: s.rotation,
    mirrored: s.mirrored,
  });
  for (const s of survivors) if (s.score >= scoreHigh) matches.push(row(s));
  for (const s of survivors) {
    if (s.score >= scoreHigh) continue;
    if (matches.some((m) => Math.hypot(m.at[0] - s.at[0], m.at[1] - s.at[1]) <= suppressR)) continue;
    withheld.push({ ...row(s), reason: `matched ${Math.round(s.score * 100)}% of the seed's linework (commit bar ${Math.round(scoreHigh * 100)}%) — likely a variant or an overlapped instance; look before counting it` });
  }
  const order = (a: SweepMatch, b: SweepMatch): number =>
    a.at[1] - b.at[1] || a.at[0] - b.at[0] || a.rotation - b.rotation || Number(a.mirrored) - Number(b.mirrored);
  matches.sort(order);
  withheld.sort(order);
  rejected.sort(order);

  return {
    matches,
    withheld,
    rejected,
    ...(negatives.length ? { negatives: negatives.map((neg) => (neg ? { mode: neg.mode, segments: neg.rel.length, center: neg.center } : null)) } : {}),
    candidates: { considered, dropped },
    complete: dropped === 0,
    ...(lumGate ? { lum_gate: {
      tol: lumTol as number,
      seed_lum: [...new Set(fpS.lum as number[])].sort((a, b) => a - b),
      rejected: lumRejectedAt.length,
      at: lumRejectedAt,
    } } : {}),
    ...(scale === 1 ? {} : {
      scaled: {
        ratio: Math.round(scale * 1e6) / 1e6,
        segments: fpS.segments,
        sub_pixel_dropped: fpS.subPixelDropped ?? 0,
        footprint_px: Math.round(fpS.footprint * 10) / 10,
        tol_px: Math.round(tol * 100) / 100,
      },
    }),
  };
}

/** The one-sheet sweep, unchanged: fingerprint the marquee, match the same
 * sheet, suppress the seed's own location. */
export function sweepSymbols(segs: number[], seedRect: [Point, Point], opts: SweepOptions = {}): SweepResult {
  const fp = fingerprintSymbol(segs, seedRect, opts.lum);
  const m = matchSymbol(fp, segs, { ...opts, excludeCenter: fp.center });
  return {
    seed: {
      segments: fp.segments,
      center: [Math.round(fp.center[0] * 10) / 10, Math.round(fp.center[1] * 10) / 10],
      length_px: Math.round(fp.totalLen * 10) / 10,
    },
    matches: m.matches,
    withheld: m.withheld,
    rejected: m.rejected,
    ...(m.negatives ? { negatives: m.negatives } : {}),
    candidates: m.candidates,
    complete: m.complete,
    ...(m.lum_gate ? { lum_gate: m.lum_gate } : {}),
  };
}
