// On-device OCR vocabulary (#469). Pure and DOM-free, like scheduleParse.ts:
// an OCR read turns a raster region into positioned words. wordsToSpans hands
// them to the sheet graph's finish reader as the spans a text layer would
// give it (Import from schedule's raster read, #470), and wordsToTokens to
// the token parser, so neither reader learns whether a schedule was vector or
// a raster image.
import type { Token } from "../scheduleParse";
import type { GraphSpan } from "../sheetgraph";

/** A recognized word in image px at the sheet's render scale, laid out like
 * the text layer's Tokens (sheets.extractRegionText): x is the left edge, y
 * the bottom (y grows down), h the height, so the word spans [y − h, y]. The
 * numbers come from the detector's text region with ppu's padding taken off
 * (raster.unpadCropBox): y is the bottom of that region, meant to be the
 * bottom of the ink, which is the baseline except where a descender (g, p,
 * y) hangs below it. How closely the detector's region hugs the ink, and so
 * the text layer's baseline, isn't measured yet. w is the width, carried
 * into Token.w; span-based readers need it (textlines tells a word gap from
 * a column gap on it). */
export type OcrWord = {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** engine confidence 0..1, when the engine reports one */
  confidence?: number;
  /** Schedule-import second-read disagreement; empty = no second code read.
   * Transient evidence, not a corrected value or a condition field. */
  codeAlternate?: string;
};

/** Words → tokens: keep the shared {str,x,y,h} and the measured width w
 * (the parser ignores it; textlines needs it to tell a word gap from a
 * column gap), drop confidence. */
export const wordsToTokens = (words: OcrWord[]): Token[] =>
  words.map(({ str, x, y, w, h }) => ({ str, x, y, h, w }));

/** A word counts when it has a letter or digit (scheduleRoute's run count
 * uses the same test). */
const HAS_TEXT = /[\p{L}\p{N}]/u;

/** Words → the sheet graph's spans: the same box with y moved from the
 * bottom to the top edge (a span spans [y, y + h]). Words with no letter or
 * digit (leader dots, rules, stray marks) are dropped. Every span is marked
 * rot 0, read left to right: a word's box carries no reading direction, and
 * without one the sheet graph guesses that a 4+ character run more than
 * twice as tall as wide is vertical text and leaves it out of the rows. */
export const wordsToSpans = (words: OcrWord[]): GraphSpan[] =>
  words
    .filter((w) => HAS_TEXT.test(w.str || ""))
    .map(({ str, x, y, w, h, codeAlternate }) => ({ str, x, y: y - h, w, h, rot: 0, ...(codeAlternate !== undefined ? { codeAlternate } : {}) }));
