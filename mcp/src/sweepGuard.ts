// The seed-too-common commit guard (#376). Pure, node-tested.
//
// Measured on a VA site utility plan: an 8 px sewer-cleanout glyph (31
// segments) seeded with commit: true and no variant_guard returned 104
// placements — tree canopies, text glyphs, line ticks, most at score 0.93–1.0
// with rotation and mirror on — and committed every one as a count marker.
// The sheet has two new cleanouts. The disclosure discipline (variant_guard,
// a pinned orientation, tolerance_px 1) took the second pass to 2 found and
// 43 withheld, so the machinery exists; it was opt-in, and a commit of 104
// markers from a seed that small must not be the default outcome.
//
// The rule: a seed under SEED_SEGMENTS_FLOOR segments whose sweep clears more
// than COMMON_MATCH_CEILING placements is too common to commit on shape alone.
// The matches are still returned as found — the geometry is what it is — but
// nothing lands in the takeoff until the caller either passes variant_guard
// (whole-symbol mode, a deliberate statement that the seed IS the symbol),
// supplies exclude counter-examples, or tightens the seed. variant_guard and
// exclude both stand the guard down because each is the caller discriminating
// by hand; a bigger seed stands it down because a fingerprint with more
// linework is exactly what a common-shape false positive lacks.

/** Seeds with fewer segments than this are "small": an 8 px circle, a bare
 *  triangle, a tick — geometry the sheet repeats for reasons unrelated to the
 *  symbol. The cleanout that started this carried 31. */
export const SEED_SEGMENTS_FLOOR = 40;
/** More cleared placements than this from a small seed is the signature of
 *  common geometry, not a dense family: nothing on a plan sheet carries fifty
 *  identical tiny devices without a schedule tag beside each one (and a
 *  labeled family is count_marks' job). */
export const COMMON_MATCH_CEILING = 50;

export interface SweepGuardInput {
  /** vector segments fully inside the seed rect */
  seedSegments: number;
  /** placements that cleared the commit bar (across every swept sheet) */
  found: number;
  /** whole-symbol mode requested by the caller */
  variantGuard: boolean;
  /** counter-example rects supplied by the caller */
  negatives: number;
}

/** null = commit proceeds; a string = the commit is refused and this is why. */
export function sweepCommitRefusal(i: SweepGuardInput): string | null {
  if (i.variantGuard || i.negatives > 0) return null;
  if (i.seedSegments >= SEED_SEGMENTS_FLOOR) return null;
  if (i.found <= COMMON_MATCH_CEILING) return null;
  return `commit refused (#376): the seed is ${i.seedSegments} segment(s) of linework and ${i.found} placement(s) cleared the bar — geometry this small and this common on the sheet is tree canopy, text, and line ticks as often as it is the symbol. Nothing was committed; the ${i.found} placements are listed in matches so you can look. To commit, say what you mean: variant_guard: true (the seed IS the whole symbol — richer placements become questions), exclude rects around what you do NOT mean, or a seed rect that captures more of the symbol's own linework (${SEED_SEGMENTS_FLOOR}+ segments stands the guard down).`;
}
