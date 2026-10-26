// markupText — a note is INK ON THE SHEET, not a chip on the screen.
//
// A callout, a text note, or the label on a cloud is something the estimator
// wrote on the drawing, so it has a size on the page (points), and the canvas
// shows it at that size times the zoom — exactly as a PDF viewer shows a
// comment. Before this module the canvas drew every note at a fixed SCREEN
// size divided by the zoom: at fit a three-line note spanned the whole floor
// plan, at 300% the same note was a chip too small to read, and the Marked
// Set (which has always burned notes at page points) never looked like the
// canvas it was reviewed on. One pure module now owns the number the canvas
// draws at and the number the export burns at, so the two cannot drift.
//
// Sizes are in PAGE POINTS. Image px = points × RENDER_SCALE (the sheet's
// logical raster, 2 px per point — the same constant the Marked Set uses to
// size its page from the image). Screen px = image px × zoom.
//
// The one deliberate departure from pure ink: a legibility FLOOR. Zoomed to
// fit on a 36×24 sheet a 9 pt note is 4 screen px — unreadable — so the canvas
// never draws text smaller than MIN_SCREEN_PX on screen. The floor is a
// screen-only aid and never reaches the export: the print is exact ink.
import { RENDER_SCALE } from "./takeoffConstants.ts";

/** Callout and text-note body — the size the Marked Set has always burned callouts at. */
export const NOTE_PT = 8.5;
/** Labels sitting on a cloud, highlight, arrow or dimension — the export's label size. */
export const LABEL_PT = 8;
/** A note wraps at three inches of page: long notes become a paragraph block, not a banner. */
export const NOTE_MAX_W_PT = 216;
/** Line pitch as a multiple of the font size. */
export const LINE_PITCH = 1.28;
/** Box padding around a note, in points (left/right and top/bottom). */
export const NOTE_PAD_PT = 3;
/** The canvas never shows note text smaller than this on screen (px). */
export const MIN_SCREEN_PX = 9;
/** The note face, for measuring and drawing alike. Mono so a canvas 2D
 *  measure and an SVG render agree to the pixel across platforms. */
export const NOTE_FONT_FAMILY = '"JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace';

/** Points → image px. */
export function ptToImg(pt) { return pt * RENDER_SCALE; }

/**
 * Font size in IMAGE px for text of `pt` points at zoom `z`: the ink size,
 * floored so it never renders under MIN_SCREEN_PX on screen. Export callers
 * pass no zoom and get pure ink.
 */
export function inkPx(pt, z) {
  const ink = ptToImg(pt);
  if (!(z > 0)) return ink;
  return Math.max(ink, MIN_SCREEN_PX / z);
}

/**
 * Greedy word wrap. `measure(str) → width` in whatever unit `maxW` is in.
 * Hard newlines are honored; a single word wider than the box is broken by
 * character so nothing ever overflows the block. Empty text → [] (callers
 * draw nothing). Whitespace runs collapse to one space.
 */
export function wrapLines(text, maxW, measure) {
  const src = String(text ?? "");
  if (!src.trim()) return [];
  const out = [];
  for (const para of src.split(/\r?\n/)) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(""); continue; }
    let line = "";
    for (const w of words) {
      const cand = line ? `${line} ${w}` : w;
      if (measure(cand) <= maxW || !line && measure(w) <= maxW) { line = cand; continue; }
      if (line) { out.push(line); line = ""; }
      // the word alone overflows — break it by character
      if (measure(w) <= maxW) { line = w; continue; }
      let piece = "";
      for (const ch of w) {
        if (measure(piece + ch) > maxW && piece) { out.push(piece); piece = ch; } else piece += ch;
      }
      line = piece;
    }
    out.push(line);
  }
  return out;
}

/**
 * Lay a note out as a block: wrapped lines, font size, line pitch, and the
 * box that holds them — all in IMAGE px, so the canvas renders it, hit-tests
 * it, and the export burns it from one answer.
 *
 * @param {object} o
 * @param {string} o.text
 * @param {number} o.fontPx   font size, image px (inkPx(...))
 * @param {(s:string)=>number} o.measure  width of a string at `fontPx`, image px
 * @param {number} [o.maxWPx] wrap width, image px (default NOTE_MAX_W_PT of page)
 * @param {number} [o.padPx]  box padding, image px (default NOTE_PAD_PT of page, scaled with the font floor)
 * @returns {{lines:string[], fontPx:number, lineH:number, padX:number, padY:number, w:number, h:number}}
 */
export function layoutNote({ text, fontPx, measure, maxWPx, padPx }) {
  // The wrap width and padding ride the FONT, not the page: when the screen
  // floor lifts a zoomed-out note above its ink size, the block keeps the same
  // proportions (about 40 characters a line) instead of collapsing into a
  // tall column ten characters wide. At ink size the ratio is 1 and the block
  // is exactly NOTE_MAX_W_PT of page — what the export burns.
  const ratio = fontPx / ptToImg(NOTE_PT);
  const maxW = maxWPx > 0 ? maxWPx : ptToImg(NOTE_MAX_W_PT) * ratio;
  const pad = padPx >= 0 ? padPx : ptToImg(NOTE_PAD_PT) * ratio;
  const lines = wrapLines(text, maxW - 2 * pad, measure);
  const lineH = fontPx * LINE_PITCH;
  const widest = lines.reduce((m, l) => Math.max(m, measure(l)), 0);
  return {
    lines, fontPx, lineH, padX: pad, padY: pad,
    w: lines.length ? widest + 2 * pad : 0,
    h: lines.length ? lines.length * lineH + 2 * pad : 0,
  };
}

/**
 * The box a note occupies from its anchor, image px. The anchor is the
 * BASELINE-LEFT of the first line — the point every existing note record was
 * placed by — so a note written before this module keeps its place on the
 * sheet. The box grows right and down from there.
 */
export function noteBox(ax, ay, L) {
  const x0 = ax - L.padX;
  const y0 = ay - L.fontPx - L.padY;   // ascent ≈ font size for the mono face
  return { x0, y0, x1: x0 + L.w, y1: y0 + L.h };
}

/** Baseline y of line i for a note anchored at `ay`. */
export function lineBaseline(ay, L, i) { return ay + i * L.lineH; }

/**
 * A width measure for the canvas: a 2D context set to the note face at the
 * given size. Falls back to a mono estimate (0.6 em per char — the JetBrains
 * Mono advance) where there is no DOM (tests, SSR), so layout never throws.
 */
let _ctx = null;
export function canvasMeasure(fontPx, weight = 600) {
  if (typeof document !== "undefined" && !_ctx) {
    try { _ctx = document.createElement("canvas").getContext("2d"); } catch { _ctx = null; }
  }
  if (!_ctx) return (s) => s.length * fontPx * 0.6;
  _ctx.font = `${weight} ${fontPx}px ${NOTE_FONT_FAMILY}`;
  return (s) => _ctx.measureText(s).width;
}
