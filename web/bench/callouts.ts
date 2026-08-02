// Callout cross-check — pure core.
//
// Most finish plans print their own areas ("557 SF") beside the finish tags.
// Those numbers are DESIGNER-authored: the one quantity on the sheet that the
// engine did not compute. Clicking One-Click at each callout and comparing is
// therefore a check against truth we didn't write — unlike the pinned corpus
// goldens, which are the engine's own traces reviewed by eye.
//
// It is a REPORT, never a gate. A callout may annotate a finish zone rather
// than a room's floor, may follow a different boundary convention (to the
// wall face, the centerline, or the finish extent), and may cover several
// spaces at once. A disagreement is a question, not a failure — the hard
// gates belong to human-measured cases (bench/from-takeoff.mts), where the
// convention is known because a human applied it deliberately.
//
// Pure and dependency-free on purpose: the measurement is injected, so the
// core is testable without pdfjs, a mask, or a PDF.

export interface TextItem { str: string; x: number; y: number }
export interface AreaCallout { sf: number; x: number; y: number; raw: string }

/** `557 SF`, `1,718 SF`, `250 S.F.`, `40 sf` — the whole item, not a token
 *  inside a sentence. A schedule row reading "CARPET 557 SF" is deliberately
 *  NOT matched: its anchor is in the schedule, not in the room, so clicking
 *  there measures nothing. Fractional areas are accepted; a bare number is
 *  not (it would swallow room tags and title-block numerals). */
const CALLOUT_RE = /^(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:SF|S\.F\.|SQ\.?\s*FT\.?)$/i;
/** Text that looks like an area annotation but isn't matched exactly — "± 557
 *  SF", "(557 SF)", "557 GSF", "557 SF NET". Counting these is the difference
 *  between "this plan prints no areas" and "this plan prints areas I can't
 *  read": the first is a fact about the drawing, the second is a fact about
 *  this parser, and silence made them look identical. */
const NEAR_MISS_RE = /\d[\d,. ]*\s*(?:S\.?\s?F\.?|SQ\.?\s*FT|GSF|NSF)\b/i;

export function parseAreaCallouts(items: TextItem[]): AreaCallout[] {
  const out: AreaCallout[] = [];
  for (const it of items) {
    const m = CALLOUT_RE.exec((it.str || "").trim());
    if (!m) continue;
    const sf = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(sf) || sf <= 0) continue;
    out.push({ sf, x: it.x, y: it.y, raw: it.str.trim() });
  }
  return out;
}

/** Text this parser declined that still looks like a printed area. Report it —
 *  a silent miss reads as "the plan prints no areas". */
export function nearMissCallouts(items: TextItem[]): string[] {
  const matched = new Set(parseAreaCallouts(items).map((c) => c.raw));
  const out: string[] = [];
  for (const it of items) {
    const t = (it.str || "").trim();
    if (!t || matched.has(t) || !NEAR_MISS_RE.test(t)) continue;
    if (CALLOUT_RE.test(t)) continue;
    out.push(t);
  }
  return out;
}

/** Text within `radius` px of a point, nearest first — the context that says
 *  what a callout is annotating (a room name, a finish tag, a schedule). */
export function nearbyText(items: TextItem[], x: number, y: number, radius: number, limit = 6): string[] {
  return items
    .map((it) => ({ it, d: Math.hypot(it.x - x, it.y - y) }))
    .filter((r) => r.d > 0 && r.d <= radius)
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((r) => r.it.str.trim());
}

/** The seed grid, in FEET, swept around a callout's text anchor. The anchor is
 *  the text baseline origin, and a seed there frequently lands in linework
 *  rather than open floor — the box drawn around a tag, an underline, one cell
 *  of a tile grid. Sweeping and taking the modal region is what a human does
 *  implicitly by clicking in the open part of the room.
 *
 *  The span is derived from the area the callout CLAIMS, because a fixed grid
 *  is wrong at both ends: an 8 ft grid around a 16 SF closet puts most of its
 *  seeds in other rooms, and they then agree with each other — the harness
 *  reported a neighbouring 86 SF room as that closet's measurement, "stable"
 *  at 10 of 25 seeds, and it alone supplied 78% of the sheet's mean error. A
 *  room of A square feet is at most ~sqrt(A) across if compact, so half that
 *  is the furthest a seed can move and still be inside a convex room. */
export const SWEEP_FT = [-4, -2, 0, 2, 4];
export const SWEEP_MIN_FT = 0.75, SWEEP_MAX_FT = 8;

export function sweepRadiusFt(printedSf?: number): number {
  if (!printedSf || !Number.isFinite(printedSf) || printedSf <= 0) return SWEEP_MAX_FT / 2;
  return Math.min(SWEEP_MAX_FT, Math.max(SWEEP_MIN_FT, Math.sqrt(printedSf) / 2));
}

export function sweepOffsets(pxPerFt: number, sweepFt: number[] = SWEEP_FT): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const dy of sweepFt) for (const dx of sweepFt) out.push([dx * pxPerFt, dy * pxPerFt]);
  return out;
}

/** The 5×5 grid for one callout, spanning ±sweepRadiusFt of its claimed area. */
export function sweepOffsetsFor(pxPerFt: number, printedSf?: number, steps = 5): Array<[number, number]> {
  const r = sweepRadiusFt(printedSf);
  const axis: number[] = [];
  for (let i = 0; i < steps; i++) axis.push(-r + (2 * r * i) / (steps - 1));
  return sweepOffsets(pxPerFt, axis);
}

export interface RegionGroup { sf: number; members: number }

/** Cluster areas that agree within `tol` (relative) and return them
 *  most-populous first; ties break toward the larger area, so the result is
 *  deterministic. The most-populous cluster is the modal region: the answer
 *  most seeds around this callout produce. */
export function clusterAreas(areas: number[], tol = 0.05): RegionGroup[] {
  // Sort first: greedy first-fit over the INPUT order is order-dependent and
  // non-transitive — [100,104,108] gives two clusters and [104,100,108] gives
  // one, from the same multiset, and the reported modal area moves with it.
  // Sorted single-linkage is a function of the multiset alone.
  const groups: { rep: number; members: number[] }[] = [];
  for (const a of [...areas].sort((x, y) => x - y)) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.members[g.members.length - 1] - a) <= tol * Math.max(Math.abs(a), 1)) g.members.push(a);
    else groups.push({ rep: a, members: [a] });
  }
  return groups
    .map((g) => ({ sf: g.members.reduce((x, y) => x + y, 0) / g.members.length, members: g.members.length }))
    .sort((a, b) => (b.members - a.members) || (b.sf - a.sf));
}

export interface CalloutRow {
  raw: string;                 // the callout as drawn
  printed_sf: number;          // what the drawing claims
  engine_sf: number | null;    // the modal region, null if no seed produced one
  err: number | null;          // (engine − printed) / printed
  agreement: number;           // seeds landing in the modal region
  seeds: number;               // seeds swept
  regions: number;             // distinct regions the sweep found (seed sensitivity)
  refused: number;             // seeds the engine refused
  stable: boolean;             // enough seeds agreed to call this a measurement
  context: string[];           // nearby text — what the callout annotates
}

/** A callout's anchor sits in the room, but the seeds around it can land in
 *  stroke-text glyphs, in a casework notch, or through a doorway. When the
 *  modal region carries fewer than this fraction of the seeds, the sweep did
 *  not find one answer — it found several, and the "modal" one is an artifact
 *  of which offsets happened to hit it. Such rows are reported (the seed
 *  sensitivity IS the finding) but never averaged. */
export const MIN_AGREEMENT_FRAC = 0.4;

/** Measure one seed: the caller's flood+trace, in SF. null = refused or
 *  degenerate. */
export type MeasureFn = (x: number, y: number) => number | null;

export function checkCallouts(
  callouts: AreaCallout[],
  measure: MeasureFn,
  offsets: Array<[number, number]> | ((c: AreaCallout) => Array<[number, number]>),
  context: (c: AreaCallout) => string[] = () => [],
): CalloutRow[] {
  return callouts.map((c) => {
    const offs = typeof offsets === "function" ? offsets(c) : offsets;
    const areas: number[] = [];
    let refused = 0;
    for (const [dx, dy] of offs) {
      const sf = measure(c.x + dx, c.y + dy);
      if (sf == null || !(sf > 0)) { refused++; continue; }
      areas.push(sf);
    }
    const groups = clusterAreas(areas);
    const mode = groups[0] ?? null;
    return {
      raw: c.raw,
      printed_sf: c.sf,
      engine_sf: mode ? mode.sf : null,
      err: mode ? (mode.sf - c.sf) / c.sf : null,
      agreement: mode ? mode.members : 0,
      seeds: offs.length,
      regions: groups.length,
      refused,
      stable: !!mode && offs.length > 0 && mode.members / offs.length >= MIN_AGREEMENT_FRAC,
      context: context(c),
    };
  });
}

export interface CalloutSummary {
  matched: number;             // rows stable enough to average
  unstable: number;            // rows whose sweep found no single answer
  total: number;
  meanAbsErr: number; medianAbsErr: number; meanSignedErr: number;
  minErr: number; maxErr: number;
  uniformSign: boolean;        // every error the same direction
  fitFactor: number;           // best-fit AREA multiplier (geometric mean of engine/printed)
  fitSpread: number;           // sd of log(engine/printed) — scale-invariant
  verdict: string;
}

/** Rows below this and the scale question isn't answerable at all. */
export const MIN_SCALE_ROWS = 3;
/** log-ratio sd under which a common multiplier explains the whole set. */
export const SCALE_LOG_SD = 0.05;

/** The one inference this harness is entitled to make. A wrong sheet scale is
 *  a single multiplier on every area, so it shows up as errors that all share
 *  a sign AND cluster in magnitude. Mixed signs rule that out and leave the
 *  per-room questions (convention, annotation boundaries, real error), which
 *  only a human can settle. */
export function summarize(rows: CalloutRow[]): CalloutSummary {
  const errs = rows.filter((r) => r.stable).map((r) => r.err).filter((e): e is number => e != null);
  const total = rows.length;
  const unstable = rows.filter((r) => !r.stable).length;
  if (!errs.length) {
    return {
      matched: 0, unstable, total, meanAbsErr: NaN, medianAbsErr: NaN, meanSignedErr: NaN,
      minErr: NaN, maxErr: NaN, uniformSign: false, fitFactor: NaN, fitSpread: NaN,
      verdict: unstable
        ? "no callout produced a stable region — every sweep was seed-sensitive, which is itself the finding"
        : "no callout produced a measurable region",
    };
  }
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  const medianAbsErr = abs.length % 2 ? abs[(abs.length - 1) / 2] : (abs[abs.length / 2 - 1] + abs[abs.length / 2]) / 2;
  const meanAbsErr = errs.reduce((a, e) => a + Math.abs(e), 0) / errs.length;
  const meanSignedErr = errs.reduce((a, e) => a + e, 0) / errs.length;
  const minErr = Math.min(...errs), maxErr = Math.max(...errs);
  const uniformSign = errs.every((e) => e > 0) || errs.every((e) => e < 0);
  // A wrong sheet scale is a constant AREA multiplier c, so the right statistic
  // is the spread of log(engine/printed), which is invariant under c. Testing
  // the spread of RELATIVE error (the first version did) has power that decays
  // exactly as the error grows: a 1/8"-read-as-1/4" mix-up — c = 4, the most
  // common real one — spreads relative error by 8 points under ±1% noise and
  // was reported as "not a scale error".
  const logs = errs.map((e) => Math.log1p(e));
  const logMean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const fitFactor = Math.exp(logMean);
  const fitSpread = Math.sqrt(logs.reduce((a, b) => a + (b - logMean) ** 2, 0) / Math.max(1, logs.length - 1));
  const verdict = errs.length < MIN_SCALE_ROWS
    ? `only ${errs.length} stable row(s) — too few to say anything about the sheet scale; read the rows individually`
    : fitSpread <= SCALE_LOG_SD
      ? `every row is explained by one area multiplier of ×${fitFactor.toFixed(3)} (log-sd ${fitSpread.toFixed(3)}) — consistent with a wrong sheet scale; check the scale before reading these as engine error`
      : `no single multiplier explains these (best fit ×${fitFactor.toFixed(3)}, log-sd ${fitSpread.toFixed(3)} — too wide) — so this is not ONE scale error; but the spread is also too wide to rule a scale error out row by row, and ${uniformSign ? "the shared sign still suggests something systematic" : "the mixed signs mean each row is its own question"}`;
  return { matched: errs.length, unstable, total, meanAbsErr, medianAbsErr, meanSignedErr, minErr, maxErr, uniformSign, fitFactor, fitSpread, verdict };
}
