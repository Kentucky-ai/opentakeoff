// On-device OCR vocabulary (#469). Pure and DOM-free, like scheduleParse.ts:
// an OCR read turns a raster region into positioned words, and wordsToTokens
// hands them to the same parser the text layer feeds, so the parser never
// learns whether a schedule was vector or scanned.
import type { Token } from "../scheduleParse";

/** A recognized word in image px at the sheet's render scale, laid out like
 * the text layer's Tokens (sheets.extractRegionText): x is the left edge, y
 * the bottom (y grows down), h the height, so the word spans [y − h, y]. The
 * numbers come from the detector's text region with ppu's padding taken off
 * (raster.unpadCropBox): y is the bottom of that region, meant to be the
 * bottom of the ink, which is the baseline except where a descender (g, p,
 * y) hangs below it. How closely the detector's region hugs the ink, and so
 * the text layer's baseline, isn't measured yet. w is the width, which
 * Tokens don't carry but span-based readers need. */
export type OcrWord = {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** engine confidence 0..1, when the engine reports one */
  confidence?: number;
};

/** Words → parser tokens: keep the shared {str,x,y,h}, drop the rest. */
export const wordsToTokens = (words: OcrWord[]): Token[] =>
  words.map(({ str, x, y, h }) => ({ str, x, y, h }));
