// Reading-order text assembly — the parsing half of the Copy-text marquee
// (#471). PURE and pdfjs/DOM-free (the scheduleParse.ts precedent): tokens
// are the shared {str,x,y,h, w?, ang?} shape BOTH text sources produce —
//   • vector plans: the page text layer (sheets.extractRegionText)
//   • text-less plans: on-device OCR (lib/ocr/types OcrWord, #469), where
//     each item is a whole detected LINE with y at the bottom of its ink
// so one assembly serves both and the copy path never learns which engine
// read the sheet. scheduleParse clusters the same tokens into TABLE rows
// (header hunt, column bands); this clusters them into PROSE lines: lines
// top→bottom, tokens left→right, one space between, one newline per line.
//
// Columns: a gap wider than COL_GAP line heights inside a row, between two
// runs with measured widths, is joined with a TAB, so a block of two columns
// side by side pastes into a spreadsheet as two columns. Known limit: reading
// order is by row — the left column is NOT read to the end before the right
// one starts.
//
// Raised marks: a superscript or footnote marker raised more than the
// baseline tolerance (0.6 of its height) is emitted on its own line, above
// the line it belongs to. Known limit, by choice: a short note touching a
// title looks the same as a footnote marker, and joining it wrongly would
// corrupt the copied text; a split only moves the mark.
//
// OCR tiles: an OCR line cut by a tile seam is joined back by the seam step
// (lib/ocr/seams.ts) before it reaches here, except a line too long for a
// patch; this module doesn't merge pieces of one line from adjacent tiles.
import type { Token } from "./scheduleRows";

/** Baseline tilt (degrees either way from 0°) beyond which a token is
 * excluded from the copy. Plans set prose horizontal but run dimension
 * strings and table headers at 90°, and an upside-down run (180°) isn't
 * prose either; read into a paragraph they garble whatever line they land
 * in, so they are skipped and counted (the caller can say so), never
 * silently mangled. */
export const MAX_TILT_DEG = 12;

/** y-distance from a row's running-average baseline that still means "same
 * visual line", as a fraction of text height — the fraction scheduleParse's
 * clusterRows uses (without its 4px floor, which would join small text set
 * at a tight pitch at low render scales). Scaled by the SMALLER of the row's and the token's
 * heights: small lines stacked beside a tall title sit less than the title's
 * height apart, so measuring against the tall one would chain them into one
 * line. */
const LINE_TOL = 0.6;

/** a horizontal gap between neighbours, in line heights, beyond which they are
 * separate columns (joined by a TAB) rather than words (joined by a space) */
const COL_GAP = 2;

/** width of a run when the token doesn't carry one (a text-layer run that
 * reported none): an average glyph advance of 0.6·h. Good enough to find
 * an overlapping twin, never to call a gap a column break. */
const extentOf = (t: Token): number => t.w ?? t.str.length * 0.6 * t.h;

/** degrees between a baseline angle (any value, 0 = reading left→right) and
 * 0°: 0 horizontal, 90 vertical either way, 180 upside down. ang is absent on
 * OCR items — the engine reports axis-aligned line boxes with no angle, so 0. */
const tiltOf = (ang: number): number => Math.min(ang, 360 - ang);

export interface TextLine {
  /** the line's tokens left→right: a space between words, a TAB across a
   * column gap */
  text: string;
  /** average baseline y of the line's tokens (image px, y down); increases
   * from each line to the next */
  y: number;
  tokens: Token[];
}

export interface AssembleResult {
  /** visual lines in reading order (top→bottom) */
  lines: TextLine[];
  /** tokens inside the region but excluded for tilt, with their angles [0,360) */
  skipped: { token: Token; ang: number }[];
}

/**
 * Assemble positioned tokens (already cropped to the marquee region) into
 * prose lines in reading order. Pure: same tokens in, same lines out.
 */
export function assembleLines(tokens: Token[]): AssembleResult {
  const kept: Token[] = [];
  const skipped: { token: Token; ang: number }[] = [];
  for (const t of tokens) {
    if (!t.str || !t.str.trim()) continue;
    const ang = (((t.ang ?? 0) % 360) + 360) % 360;
    if (tiltOf(ang) > MAX_TILT_DEG) skipped.push({ token: t, ang });
    else kept.push(t);
  }
  // y-major, x-minor: clustering walks baselines top→bottom
  kept.sort((a, b) => a.y - b.y || a.x - b.x);

  const rows: { sum: number; n: number; minH: number; toks: Token[] }[] = [];
  for (const t of kept) {
    const row = rows[rows.length - 1];
    // running-average baseline: one token a little off the line doesn't
    // move it far, and a slow drift eventually starts a new line
    const avg = row ? row.sum / row.n : 0;
    const tol = LINE_TOL * Math.min(row?.minH ?? t.h, t.h);
    if (row && Math.abs(t.y - avg) <= tol) {
      row.sum += t.y; row.n += 1; row.minH = Math.min(row.minH, t.h); row.toks.push(t);
    } else {
      rows.push({ sum: t.y, n: 1, minH: t.h, toks: [t] });
    }
  }

  const lines: TextLine[] = rows.map((r) => {
    const toks: Token[] = [];
    for (const t of [...r.toks].sort((a, b) => a.x - b.x)) {
      // a run drawn twice (faux bold, a stroke-then-fill export) overlaps its
      // twin with the same text — keep one
      if (toks.some((k) => k.str === t.str && t.x < k.x + extentOf(k))) continue;
      toks.push(t);
    }
    let text = toks[0].str;
    for (let i = 1; i < toks.length; i++) {
      const a = toks[i - 1], b = toks[i];
      // a TAB only on measured widths: an estimate can't justify a column
      const gap = b.x - (a.x + extentOf(a));
      const col = a.w != null && b.w != null && gap > COL_GAP * Math.max(a.h, b.h);
      text += (col ? "\t" : " ") + b.str;
    }
    return { text, y: r.sum / r.n, tokens: toks };
  });
  return { lines, skipped };
}

/** Lines → clipboard text: one line per visual row, newline-separated. */
export const linesToText = (lines: TextLine[]): string => lines.map((l) => l.text).join("\n");
