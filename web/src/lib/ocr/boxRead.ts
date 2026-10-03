// Import from schedule's box, read on-device as a page read is (#484): tiled
// at 216 DPI with patches across the seams (readRegionText), not one raster
// of the box. One raster is capped at SCAN_MAX_DIM, so a large box rendered
// whole drops below 216 DPI (a 60-row table read at 164 DPI misread its bold
// header and came back "no table"); tiled, every raster is at 216.
//
// A leaf beside regionRead.ts, so scheduleOcrRead.ts stays pure: the canvas
// builds readWords here and hands it to readBoxOnDevice.
//   - boxReadWords(...) is the read. After each render it asks isCurrent()
//     (the canvas still on the box's sheet), and if not, aborts the read's
//     own controller, so readRegionText's abort check stops before that
//     raster is read: a render that finished for a sheet the canvas has left
//     is never read. The read then rejects AbortError; readBoxOnDevice
//     reports a failure while the read is no longer wanted as cancelled.
//   - boxTooLarge(...) is the size check, on the box clipped to the page as
//     readRegionText clips it, so a box hanging off the page's edge isn't
//     refused for the part that isn't there.
//   - boxWords(...) turns the read's lines into words for the reader.
import { rasterizeRegion } from "./rasterize";
import { readRegionText, readTooLarge, type PageLike, type Rasterize, type Recognizer } from "./regionRead";
import type { Rect, SeamLine, SeamProgress } from "./seams";
import type { OcrWord } from "./types";
import { cleanOcrText } from "./wordClean";

/** The box's words, image px at rs; the signal cancels a render or read
 * under way. */
export type ReadWords = (signal?: AbortSignal, onProgress?: (p: SeamProgress) => void) => Promise<OcrWord[]>;

export interface BoxReadDeps {
  /** default rasterizeRegion */
  rasterize?: Rasterize;
  /** default the app's one OCR client */
  client?: Recognizer;
}

/** `rect` (image px at rs, any corner order) clipped to `page`'s viewport. */
function clipToPage(page: PageLike, rs: number, rect: Rect): Rect {
  const vp = page.getViewport({ scale: rs });
  return {
    x0: Math.max(0, Math.min(rect.x0, rect.x1)), y0: Math.max(0, Math.min(rect.y0, rect.y1)),
    x1: Math.min(vp.width, Math.max(rect.x0, rect.x1)), y1: Math.min(vp.height, Math.max(rect.y0, rect.y1)),
  };
}

/** True when the box, clipped to the page, would take more than
 * OCR_MAX_TILES tiles. A box wholly off the page reads nothing and isn't
 * too large. */
export function boxTooLarge(page: PageLike, rs: number, rect: Rect): boolean {
  const r = clipToPage(page, rs, rect);
  if (!(r.x1 > r.x0 && r.y1 > r.y0)) return false;
  return readTooLarge(r, rs);
}

/** Read `rect` of `page` at render scale `rs`; see the header. */
export function boxReadWords(page: PageLike, rs: number, rect: Rect, isCurrent: () => boolean, deps: BoxReadDeps = {}): ReadWords {
  const base = deps.rasterize ?? (rasterizeRegion as unknown as Rasterize);
  return async (signal, onProgress) => {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) ac.abort();
    const rasterize: Rasterize = async (pg, r, render, o) => {
      const raster = await base(pg, r, render, o);
      if (!isCurrent()) ac.abort();
      return raster;
    };
    try {
      const { lines } = await readRegionText(page, rs, rect, { signal: ac.signal, onProgress, rasterize, client: deps.client });
      return boxWords(lines);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

const boxOf = (w: OcrWord): Rect => ({ x0: w.x, y0: w.y - w.h, x1: w.x + w.w, y1: w.y });

/** The same row: their boxes overlap across the line by at least half the
 * smaller height (seams.ts's own test for one line). */
function sameRow(a: Rect, b: Rect): boolean {
  return Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) >= 0.5 * Math.min(a.y1 - a.y0, b.y1 - b.y0);
}

/** A clipped piece that repeats `other`: on its row, at least 90% of its
 * width inside it, and `other` longer (or as long and earlier, so of two
 * equal pieces one is kept). */
function repeats(piece: OcrWord, i: number, other: OcrWord, j: number): boolean {
  if (!(other.w > piece.w || (other.w === piece.w && j < i))) return false;
  const a = boxOf(piece), b = boxOf(other);
  if (!sameRow(a, b)) return false;
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) >= 0.9 * piece.w - 1e-9;
}

/** The read's lines as the reader's words: the clipped flag dropped, and a
 * clipped piece dropped only when it repeats a longer clipped piece (a true
 * repeat). Pieces from either side of a seam that only share the overlap
 * band each hold a part of the line the other doesn't (seams.ts doesn't trim
 * them), so both are kept: some overlap text may repeat in a cell, none is
 * lost. Each line is first cleaned of the cell's ruling (cleanOcrText,
 * #482), and one that was only ruling is dropped with its box. */
export function boxWords(lines: readonly SeamLine[]): OcrWord[] {
  // cleaned first: a clipped piece that was only ruling ("______") is gone
  // before the repeat check, so it can't take a real piece with it
  const kept = lines.flatMap((l) => { const str = cleanOcrText(l.str); return str ? [{ ...l, str }] : []; });
  const clipped = kept.map((l, i) => (l.clipped ? i : -1)).filter((i) => i >= 0);
  const out: OcrWord[] = [];
  kept.forEach((l, i) => {
    if (l.clipped && clipped.some((j) => j !== i && repeats(l, i, kept[j], j))) return;
    const w: OcrWord = { str: l.str, x: l.x, y: l.y, w: l.w, h: l.h };
    if (l.confidence !== undefined) w.confidence = l.confidence;
    out.push(w);
  });
  return out;
}
