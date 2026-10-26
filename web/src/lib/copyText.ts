// Copy text (#471) — the pure half of the canvas tool. Two clicks box a
// region (or the receipt's / hint's "Copy page text" asks for the whole
// page); the READERS turn it into positioned tokens; textlines assembles them
// into reading-order lines; the text goes to the clipboard; a receipt says
// what was copied and by which reader. pdfjs-free apart from
// extractRegionText's transform maths; no DOM (the clipboard and the
// textarea are injected), so every decision here runs under node --test.
//
// The reader chain is the seam OCR joins: readers are asked in order,
// and the first one that finds ANY token in the rect answers. Only "no
// tokens" falls through — a box holding only rotated text-layer runs stops at
// the text layer and says so, so an OCR reader is never started on a box of
// dimension strings. A reader returns synchronously when it can (the text
// layer, once the page's text content is in hand), and readCopyText stays
// synchronous as long as every reader it asks does: the clipboard write then
// happens inside the click that asked for it.
//
// The OCR readers (ocrCopyReaders): first the page's own read (the canvas's
// Read page text, or its cached read), whose lines in the box copy
// synchronously when they're in memory; then, only when the page has no
// read at all, an on-device read of the box itself (not cached). A reader
// that couldn't read (declined, disabled, failed) hands over like an empty
// one, and the reason reaches the message. Their place in the chain is
// copyReaderChain's: after the text layer on a sheet with one, before it on
// a scan (planIndex indexIsScanLike), whose few stray runs are drawn on the
// page and read by OCR with the rest.
//
// A hybrid (#489: planIndex isHybrid, a vector sheet with an unread picture
// on it) copies a box over the picture through ONE combining reader
// (hybridCopyReader; copyPlan decides): the box's text layer, and OCR for
// the picture's own text.
import type { Token } from "./scheduleRows";
import type { OcrWord } from "./ocr/types";
import { extractRegionText } from "./sheets";
import { assembleLines, linesToText, type TextLine } from "./textlines";
import { carriesText, indexIsScanLike, isHybrid, type SheetIndex } from "./planIndex";
import { pageTextIndex } from "./pageTextIndex";
import { ocrOffReason } from "./scheduleRoute";
import { CANVAS_EDGE, FLOAT_GAP, RAIL_CLEAR, SWEEP_PANEL_W, ZONE_PANEL_W } from "./canvasConstants.js";

export type Rect = { x0: number; y0: number; x1: number; y1: number };
type TextContent = Parameters<typeof extractRegionText>[0];
type Viewport = Parameters<typeof extractRegionText>[1];

/** The text layer reader's label, shown on the receipt. */
export const TEXT_LAYER = "Text layer";
/** The OCR readers' label: text read from the page image, never the PDF's own. */
export const OCR_LABEL = "OCR";
/** A hybrid copy's label: the text layer, and OCR for the picture's text. */
export const TEXT_LAYER_OCR = "Text layer + OCR";

/** Why a reader couldn't read (lib/ocr/pageRead's ReadFailure). */
export type ReaderMissStatus = "declined" | "aborted" | "page-closed" | "failed" | "disabled" | "uninstalled" | "error" | "too-large";
export interface ReaderMiss { status: ReaderMissStatus; message?: string }
/** Tokens; none (null / []); why the reader couldn't read; or tokens with
 * the label they answer under (a reader that combines readers names what
 * found them) and whether a picture went unread. */
export type ReaderAnswer = Token[] | null | { miss: ReaderMiss } | { tokens: Token[]; reader?: string; imageUnread?: true };
type Answered = Extract<ReaderAnswer, { tokens: Token[] }>;

/** A reader: the tokens it finds in `rect` (null = the whole page), in the
 * page's rs-viewport px, or null / [] when it has none. `signal` aborts when
 * a newer read replaces this one (a slow reader should stop its work). */
export interface CopyReader {
  label: string;
  read(rect: Rect | null, opts: { signal?: AbortSignal }): ReaderAnswer | Promise<ReaderAnswer>;
  /** asked only if this holds for why the readers before it couldn't read
   *  (undefined: they read, and found nothing); absent = always asked */
  onlyAfter?: (miss: ReaderMiss | undefined) => boolean;
}

export type CopyOutcome =
  /** clipped: OCR lines no raster held whole (split at a tile seam), when any */
  | { kind: "text"; reader: string; lines: TextLine[]; text: string; lineCount: number; skipped: number; clipped?: number; imageUnread?: true }
  /** the reader found text, all of it rotated past textlines' tilt limit */
  | { kind: "rotated-only"; reader: string; skipped: number }
  /** no reader found any text; `tried` = the readers asked, in order;
   * `miss` = why the last reader that couldn't read didn't */
  | { kind: "empty"; tried: string[]; miss?: ReaderMiss }
  /** a newer read replaced this one: post nothing */
  | { kind: "aborted" };
export type TextOutcome = Extract<CopyOutcome, { kind: "text" }>;

/** The page text layer in a rect, by glyph-box intersection (a line whose
 * baseline sits a hair outside the box still copies). null = whole page. */
export function textLayerReader(tc: TextContent, viewport: Viewport): CopyReader {
  return {
    label: TEXT_LAYER,
    read: (rect) => extractRegionText(tc, viewport, rect ?? { x0: 0, y0: 0, x1: viewport.width, y1: viewport.height }, { boxIntersects: true }),
  };
}

// one page's text-layer index per text content (a copy asks more than once)
const pageIndexes = new WeakMap<object, SheetIndex>();
const pageIndexOf = (tc: TextContent, viewport: Viewport): SheetIndex => {
  let ix = pageIndexes.get(tc as object);
  if (!ix) { ix = pageTextIndex("", tc, viewport); pageIndexes.set(tc as object, ix); }
  return ix;
};

/** Is the page a scan? The rule search and the Read control use
 * (pageTextIndex over the viewport, then planIndex indexIsScanLike): at
 * most SCAN_MAX_TEXT_LINES lines on the page carry a token, so blank,
 * punctuation-only or off-page text doesn't count. */
export const pageIsScanLike = (tc: TextContent, viewport: Viewport): boolean => indexIsScanLike(pageIndexOf(tc, viewport));

/** Is the page a scan, for Copy text? The page rule (pageIsScanLike), and
 * the page may hold an image: imageFrac not 0 (unknown counts as possibly
 * raster). A vector cover sheet — a few title lines, no placed image —
 * copies from its text layer at once, never via OCR and its download
 * notice. A page with no text at all is a scan whatever its images (text
 * drawn as outlines can still be read), as before the rule counted lines.
 * The Read control and the gallery decide differently: from the sheet's
 * index entry (planSearch readWhat), a scan by the page rule alone and a
 * hybrid by its measured pictures (#489). (On a scan OCR comes first, and an empty copy's message says the
 * sheet has little or no text layer instead of "empty box".) */
export function copyIsScanLike(tc: TextContent, viewport: Viewport, imageFrac?: number | null): boolean {
  const ix = pageIndexOf(tc, viewport);
  if (ix.lineCount === 0) return true;
  return indexIsScanLike(ix) && imageFrac !== 0;
}

// called only with a non-blank token, which assembleLines puts in a line or
// in skipped, so no lines means every token was rotated
// `after`: why the readers before this one couldn't read, if they couldn't
function outcomeOf(a: Answered, label: string, after?: ReaderMiss): CopyOutcome {
  const { tokens } = a;
  const reader = a.reader ?? label;
  const { lines, skipped } = assembleLines(tokens);
  if (!lines.length) return { kind: "rotated-only", reader, skipped: skipped.length };
  const text = linesToText(lines);
  const out: CopyOutcome = { kind: "text", reader, lines, text, lineCount: lines.length, skipped: skipped.length };
  const clipped = tokens.filter((t) => (t as { clipped?: boolean }).clipped).length;
  if (clipped) out.clipped = clipped;
  if (a.imageUnread || (after && IMAGE_UNREAD.has(after.status))) out.imageUnread = true;
  return out;
}

// the same rule for a reader's tokens: punctuation alone falls through to the
// next reader (OCR), as a text-less page does
const answered = (t: ReaderAnswer): Answered | null => {
  if (Array.isArray(t)) return carriesText(t) ? { tokens: t } : null;
  return t && "tokens" in t && carriesText(t.tokens) ? t : null;
};
const missOf = (t: ReaderAnswer): ReaderMiss | undefined => (t && "miss" in t ? t.miss : undefined);
const emptyOutcome = (tried: string[], miss: ReaderMiss | undefined): CopyOutcome => (miss ? { kind: "empty", tried, miss } : { kind: "empty", tried });

/** Ask the readers in order; the first with any token answers. Synchronous
 * while every reader asked answers synchronously. An aborted signal (checked
 * before each reader and after each async one) ends it as "aborted". */
export function readCopyText(readers: CopyReader[], rect: Rect | null, opts: { signal?: AbortSignal } = {}, tried: string[] = [], missed?: ReaderMiss): CopyOutcome | Promise<CopyOutcome> {
  const { signal } = opts;
  let miss = missed;
  for (let i = 0; i < readers.length; i++) {
    if (signal?.aborted) return { kind: "aborted" };
    const { label, onlyAfter } = readers[i];
    if (onlyAfter && !onlyAfter(miss)) {
      // not asked: the rest are asked in its place
      return readCopyText(readers.slice(i + 1), rect, opts, [...tried, ...readers.slice(0, i).map((r) => r.label)], miss);
    }
    const got = readers[i].read(rect, { signal });
    const asked = [...tried, ...readers.slice(0, i).map((r) => r.label), label];
    if (got instanceof Promise) {
      const rest = readers.slice(i + 1);
      return got.then((t) => {
        if (signal?.aborted) return { kind: "aborted" } as const;
        const a = answered(t);
        return a ? outcomeOf(a, label, miss) : readCopyText(rest, rect, opts, asked, missOf(t) ?? miss);
      });
    }
    const a = answered(got);
    if (a) return outcomeOf(a, label, miss);
    miss = missOf(got) ?? miss;
  }
  return emptyOutcome([...tried, ...readers.map((r) => r.label)], miss);
}

/** OCR lines (rs px: x left, y bottom, w, h) whose box meets `rect` — the
 * text layer reader's glyph-box intersection (a line the box only clips
 * still copies).
 * null = the whole page. The lines go on as they are: textlines needs w. */
export function ocrWordsInRect<W extends OcrWord>(words: readonly W[], rect: Rect | null): W[] {
  if (!rect) return [...words];
  const x0 = Math.min(rect.x0, rect.x1), x1 = Math.max(rect.x0, rect.x1);
  const y0 = Math.min(rect.y0, rect.y1), y1 = Math.max(rect.y0, rect.y1);
  return words.filter((w) => !(w.x + w.w < x0 || w.x > x1 || w.y < y0 || w.y - w.h > y1));
}

/** Which OCR a copy may use (copyReaderChain puts it after the text layer,
 * or first on a scan). `scanLike`: planIndex indexIsScanLike for the page.
 *   "none"  OCR known to be off (this build, or the probe said disabled or
 *           not installed): no OCR reader, so a scan's text layer answers
 *           synchronously, inside the click, as before OCR existed; or
 *           a sheet with a text layer and no placed image at all (imageFrac
 *           exactly 0: oneclick's extractVectorGeometry adds to imageArea
 *           only on an image paint op): blank space or symbols there aren't
 *           text an image read could find, so no OCR (and no download
 *           notice). Any image, however small (a scanned schedule pasted
 *           onto a vector sheet), allows it;
 *   "page"  Copy page text on a scan (little or no text layer): the page
 *           read the Read control offers (kept, and put in the search index);
 *   "box"   otherwise: the page's read if it has one, else a read of the box.
 * imageFrac unknown (the sheet's stats aren't in yet): allowed. */
export type OcrRoute = "none" | "box" | "page";
export function copyOcrRoute(s: { scope: "box" | "page"; scanLike: boolean; imageFrac?: number | null; ocrOff?: boolean }): OcrRoute {
  if (s.ocrOff) return "none";
  if (!s.scanLike && s.imageFrac === 0) return "none";
  return s.scope === "page" && s.scanLike ? "page" : "box";
}

/** OCR known to be off before a copy starts — this build has it off
 * (`enabled` false), or the probe said disabled or not installed — with no
 * read of the page in memory: the miss to start the chain with
 * (readCopyText's `missed`), so the copy asks no OCR reader (the text layer
 * answers synchronously, inside the click) and an empty copy still says
 * why. undefined = OCR may run (not probed yet, or offline: the cache still
 * answers). */
export function copyStartMiss(s: { enabled: boolean; avail: string | null | undefined; hasRead: boolean }): ReaderMiss | undefined {
  if (s.hasRead) return undefined;
  if (!s.enabled || s.avail === "disabled") return { status: "disabled" };
  if (s.avail === "uninstalled") return { status: "uninstalled" };
  return undefined;
}

/** OCR can't run on this deployment: the text layer is all there is. */
const OCR_UNAVAILABLE: ReadonlySet<ReaderMissStatus> = new Set(["disabled", "uninstalled"]);

/** Why OCR didn't read the image, where the stray runs still copy but the
 * receipt says the image wasn't read: declined, offline, too large. */
const IMAGE_UNREAD: ReadonlySet<ReaderMissStatus> = new Set(["declined", "error", "too-large"]);
/** The receipt's note on such a copy. */
export const IMAGE_UNREAD_NOTE = "the scanned image wasn't read";
/** The same note on a hybrid, whose unread image is a picture on a vector sheet. */
export const PICTURE_UNREAD_NOTE = "the picture wasn't read";

/** The readers for one copy, in the order they're asked.
 *   - A sheet with a text layer: the text layer, then OCR (copyOcrRoute
 *     decides which, if any).
 *   - A scan (copyIsScanLike): OCR first — the page's read, else a read of
 *     the box — since its few stray runs (a stamp, a scanner label) are
 *     drawn on the page and OCR reads them with the rest. The text layer is
 *     asked after it when OCR found nothing, can't run here (off, not
 *     installed: a build without the model copies the stray runs as
 *     before), or couldn't read the image (declined, offline, too large:
 *     the outcome is marked imageUnread and the receipt says so). A read
 *     that was stopped or failed ends the copy with its reason. */
export function copyReaderChain(c: { scanLike: boolean; textLayer: CopyReader; ocr: CopyReader[] }): CopyReader[] {
  if (!c.scanLike) return [c.textLayer, ...c.ocr];
  const fallback: CopyReader = { ...c.textLayer, onlyAfter: (miss) => !miss || OCR_UNAVAILABLE.has(miss.status) || IMAGE_UNREAD.has(miss.status) };
  return [...c.ocr, fallback];
}

/** An on-device read of a box: its lines, or why there are none. */
export type BoxRead = { ok: true; lines: OcrWord[] } | { ok: false; status: ReaderMissStatus; message?: string };

/** The two OCR readers, for one copy. `pageLines`: the page's own read
 * (null = none), synchronously when it's in memory. `readBox`: an on-device
 * read of the rect (null = the page), asked only when the page has no read;
 * the box's text-layer text, if any, already answered before either. */
export function ocrCopyReaders(deps: {
  pageLines: () => readonly OcrWord[] | null | undefined | Promise<readonly OcrWord[] | null | undefined>;
  readBox: (rect: Rect | null, signal?: AbortSignal) => Promise<BoxRead>;
}): CopyReader[] {
  let pageRead = false;
  const inRect = (lines: readonly OcrWord[] | null | undefined, rect: Rect | null): Token[] | null => {
    pageRead = !!lines;
    return lines ? ocrWordsInRect(lines, rect) : null;
  };
  const cached: CopyReader = {
    label: OCR_LABEL,
    read(rect) {
      const got = deps.pageLines();
      return got instanceof Promise ? got.then((l) => inRect(l, rect), () => inRect(null, rect)) : inRect(got, rect);
    },
  };
  const box: CopyReader = {
    label: OCR_LABEL,
    read(rect, { signal }) {
      if (pageRead) return null;   // the page's read covers the box: it has nothing there
      return deps.readBox(rect, signal).then((r): ReaderAnswer => (r.ok ? r.lines : { miss: r.message !== undefined ? { status: r.status, message: r.message } : { status: r.status } }));
    },
  };
  return [cached, box];
}

/** Which chain a copy takes (#489). `scan`: copyIsScanLike for the page;
 * `hybridPictures`: the sheet's unread pictures (planIndex SheetIndex.pictures
 * on a hybrid, [] on any other sheet or when the op list was unreadable) in
 * pt at scale 1; `pictureState` "unknown": not measured yet, so today's chain;
 * `rect`: the box in the page's rs-viewport px (null = the whole page);
 * `pageRead`: the page's read is in memory.
 *   scan    a scan: copyReaderChain's OCR-first chain, pictures or not;
 *   hybrid  a box over a picture: hybridCopyReader, OCR on each box ∩
 *           picture (`ocrRects`, rs px) kept when both its sides are at least
 *           COPY_PICTURE_MIN_SIDE_PT × rs; Copy page text with a read in
 *           memory: the same combine over every picture, no new read;
 *   text    otherwise (a box off the pictures, or only a sliver of one; Copy
 *           page text with no read in memory): the text layer first, as on
 *           any sheet with one. */
export type CopyPlan = { kind: "scan" } | { kind: "text" } | { kind: "hybrid"; ocrRects: Rect[] };
/** A box ∩ picture narrower or shorter than this (pt) is the box's edge
 * grazing the picture, not a request to read it. */
export const COPY_PICTURE_MIN_SIDE_PT = 11;
export function copyPlan(p: {
  scope: "box" | "page"; rect: Rect | null; scan: boolean;
  hybridPictures: readonly Rect[]; pictureState: "unknown" | "measured"; rs: number; pageRead: boolean;
}): CopyPlan {
  if (p.scan) return { kind: "scan" };
  if (p.pictureState !== "measured" || !p.hybridPictures.length) return { kind: "text" };
  const pics = p.hybridPictures.map((r) => ({ x0: r.x0 * p.rs, y0: r.y0 * p.rs, x1: r.x1 * p.rs, y1: r.y1 * p.rs }));
  if (p.scope === "page" || !p.rect) return p.pageRead ? { kind: "hybrid", ocrRects: pics } : { kind: "text" };
  const b = normRect(p.rect);
  const min = COPY_PICTURE_MIN_SIDE_PT * p.rs;
  const ocrRects = pics
    .map((r) => ({ x0: Math.max(b.x0, r.x0), y0: Math.max(b.y0, r.y0), x1: Math.min(b.x1, r.x1), y1: Math.min(b.y1, r.y1) }))
    .filter((r) => r.x1 - r.x0 >= min && r.y1 - r.y0 >= min);
  return ocrRects.length ? { kind: "hybrid", ocrRects } : { kind: "text" };
}

/** copyPlan's picture inputs from the sheet's index entry: "unknown" until
 * its pictures are measured (no entry, or one the canvas's label loop made);
 * once measured, the unread pictures on a hybrid (isHybrid: a read of one
 * carries them too), and none on any other sheet ("failed" included). */
export function copyPictureInputs(ix: SheetIndex | undefined): { hybridPictures: Rect[]; pictureState: "unknown" | "measured" } {
  if (!ix || ix.pictures === undefined) return { hybridPictures: [], pictureState: "unknown" };
  return { hybridPictures: isHybrid(ix) ? (ix.pictures as Rect[]) : [], pictureState: "measured" };
}

/** The page read the text chain's OCR (ocrCopyReaders `pageLines`) may use.
 * On a hybrid (copyPictureInputs: unread pictures on its entry, a read of
 * them included) none: its read covers only the pictures, and copyPlan sends
 * a box to the text chain only when it's off them or grazes one, so that
 * read would call the box empty or copy a clipped picture's words as OCR.
 * The box is read on its own instead, as before #489. Any other sheet: the
 * page's read as given (a scan's covers the page). */
export function textChainPageLines<T>(ix: SheetIndex | undefined, pageLines: () => T): () => T | null {
  return copyPictureInputs(ix).hybridPictures.length ? () => null : pageLines;
}

const normRect = (r: Rect): Rect => ({ x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1) });

// a token's glyph box in px: extractRegionText's corners (baseline start, +
// w along the run, + h toward the glyph tops); an OCR word is the ang-0 case
function glyphBox(t: Token): Rect {
  const rad = ((t.ang ?? 0) * Math.PI) / 180;
  const dx = Math.cos(rad), dy = Math.sin(rad), ux = dy * t.h, uy = -dx * t.h;
  const len = t.w ?? t.str.length * 0.6 * t.h;
  const xs = [t.x, t.x + dx * len, t.x + ux, t.x + dx * len + ux];
  const ys = [t.y, t.y + dy * len, t.y + uy, t.y + dy * len + uy];
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
const centreIn = (t: Token, rects: readonly Rect[]): boolean => {
  const g = glyphBox(t), cx = (g.x0 + g.x1) / 2, cy = (g.y0 + g.y1) / 2;
  return rects.some((r) => cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1);
};
// boxes that share area (touching edges don't)
const overlaps = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** The one reader for a copy over a hybrid's picture (copyPlan "hybrid"):
 * every text-layer run in the box, the picture's callouts included (the text
 * layer is exact, a read isn't), plus OCR words whose centre lies inside
 * `ocrRects`; an OCR word overlapping a text-layer run (the read of a
 * callout drawn over the picture, often run into the text under it) is
 * dropped. OCR words come from the page's read in memory (`pageLines`,
 * synchronous), else its cached read (`lookup`), else an on-device read of
 * each ocrRect in turn, never of the whole box. Synchronous with a read in memory, or when OCR is known
 * off (`startMiss`, copyStartMiss) or the copy is the whole page with no
 * read in memory: the text layer answers then, as on any sheet with one.
 * A text-layer run textlines skips as rotated hides no OCR word.
 * When OCR doesn't read the picture, the scan chain's rule: found nothing,
 * off or not installed → every text-layer run in the box; declined, offline
 * or too large → the same (with any earlier picture's words already read),
 * flagged imageUnread; stopped, failed or the page
 * closed → nothing, with the reason. The answer is labelled by what found
 * it: TEXT_LAYER_OCR, or Text layer / OCR when only one did. */
export function hybridCopyReader(d: {
  tc: TextContent; viewport: Viewport; ocrRects: readonly Rect[]; startMiss?: ReaderMiss;
  pageLines: () => readonly OcrWord[] | null | undefined;
  lookup: () => Promise<readonly OcrWord[] | null | undefined>;
  readBox: (rect: Rect, signal?: AbortSignal) => Promise<BoxRead>;
}): CopyReader {
  return {
    label: TEXT_LAYER_OCR,
    read(rect, { signal }) {
      const inBox = extractRegionText(d.tc, d.viewport, rect ?? { x0: 0, y0: 0, x1: d.viewport.width, y1: d.viewport.height }, { boxIntersects: true });
      // the text layer alone: no OCR text in the picture
      const textOnly = (miss?: ReaderMiss, imageUnread?: boolean): ReaderAnswer => {
        if (!carriesText(inBox)) return miss ? { miss } : [];
        return imageUnread ? { tokens: inBox, reader: TEXT_LAYER, imageUnread: true } : { tokens: inBox, reader: TEXT_LAYER };
      };
      // `unread`: a picture's read missed (declined, offline, too large)
      // after the words here were read: they copy, flagged imageUnread
      const combine = (words: readonly OcrWord[], unread?: ReaderMiss): ReaderAnswer => {
        // a run textlines skips as rotated isn't copied, so it hides no OCR
        // word (its axis-aligned box would cover words off its glyphs)
        const rotated = new Set(assembleLines(inBox).skipped.map((s) => s.token));
        const runs = inBox.filter((t) => !rotated.has(t)).map(glyphBox);
        const read = words.filter((w) => centreIn(w, d.ocrRects) && !runs.some((k) => overlaps(k, glyphBox(w))));
        if (!carriesText(read)) return textOnly(unread, !!unread);
        const flag = unread ? { imageUnread: true as const } : {};
        if (!carriesText(inBox)) return { tokens: read, reader: OCR_LABEL, ...flag };
        return { tokens: [...inBox, ...read], reader: TEXT_LAYER_OCR, ...flag };
      };
      const mem = d.pageLines();
      if (mem) return combine(mem);
      if (d.startMiss) return textOnly(d.startMiss);
      if (!rect) return textOnly();
      return (async (): Promise<ReaderAnswer> => {
        const cached = await d.lookup().catch(() => null);
        if (cached) return combine(cached);
        const words: OcrWord[] = [];
        for (const r of d.ocrRects) {
          if (signal?.aborted) return null;   // readCopyText reports it aborted
          const got = await d.readBox(r, signal);
          if (!got.ok) {
            const miss: ReaderMiss = got.message !== undefined ? { status: got.status, message: got.message } : { status: got.status };
            if (OCR_UNAVAILABLE.has(got.status)) return textOnly(miss);
            // the words already read (an earlier picture's) still copy
            if (IMAGE_UNREAD.has(got.status)) return combine(words, miss);
            return { miss };
          }
          words.push(...got.lines);
        }
        return combine(words);
      })();
    },
  };
}

/** One read at a time: begin() aborts the read before it and hands out the
 * new read's signal, so two quick boxes can't race to post receipts. */
export function createReadGate(): { begin(): AbortSignal } {
  let current: AbortController | null = null;
  return {
    begin() {
      current?.abort();
      current = new AbortController();
      return current.signal;
    },
  };
}

/** How messages name OCR: one phrase everywhere. */
export const OCR_READER = "the on-device text reader (OCR)";
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** The status-bar line for an outcome that put nothing on the clipboard.
 * `isScanLike`: planIndex indexIsScanLike for the page; `hybrid`: the copy
 * was copyPlan's "hybrid", which is never called a scan. */
export function outcomeMessage(o: CopyOutcome, scope: "box" | "page", isScanLike: boolean, hybrid = false): string {
  const scanLike = isScanLike && !hybrid;
  if (o.kind === "aborted") return "";
  if (o.kind === "rotated-only") {
    return `Only rotated text ${scope === "box" ? "in that box" : "on this sheet"} (${o.skipped} rotated run${o.skipped === 1 ? "" : "s"}: dimension strings, vertical headers) — nothing reads left to right.`;
  }
  if (o.kind === "text") return "";
  const where = scope === "box" ? "in that box" : "on this sheet";
  const what = scope === "box" ? "that box" : "this sheet";
  const miss = o.miss;
  if (miss) {
    switch (miss.status) {
      case "declined": return `Nothing copied: ${OCR_READER} wasn't downloaded.`;
      case "aborted": return `${cap(OCR_READER)} was stopped; nothing copied.`;
      case "too-large": return `${cap(what)} is too large for ${OCR_READER}.`;
      case "disabled":
      case "uninstalled":
        if (hybrid) return `No text layer ${where}, and the picture can't be read here: ${ocrOffReason(miss.status)}.`;
        if (!scanLike) return scope === "box" ? "No text in that box." : "No text on this sheet.";
        return `This sheet has little or no text layer, and ${OCR_READER} isn't available here, so there's no text to copy.`;
      default: return `Couldn't read ${what} with ${OCR_READER}: ${miss.message || "unknown error"}`;
    }
  }
  // the combining reader asked the text layer too: it reads as OCR here
  const others = [...new Set(o.tried.filter((t) => t !== TEXT_LAYER).map((t) => (t === TEXT_LAYER_OCR ? OCR_LABEL : t)))];
  if (others.length) return `No text found ${where}: ${!scanLike ? "no text-layer text there" : "the sheet has little or no text layer"}, and ${others.join(", ")} read none.`;
  if (scanLike) return `This sheet has little or no text layer (a scan or a flattened export), so there's no text to copy.`;
  return scope === "box" ? "No text in that box." : "No text on this sheet.";
}

type PanelLike = { key: string; xOffset: number; img: { w: number; h: number } };

/** Two stage-px corners → a rect in the panel's own px, clamped to the sheet
 * (an over-drag never reads off the page). Refused across two sheets or
 * under 4 px a side. */
export function boxOnPanel(a: number[], b: number[], pa: PanelLike, pb: PanelLike): { rect: Rect } | { error: "cross" | "small" } {
  if (pa.key !== pb.key) return { error: "cross" };
  const cl = (v: number, hi: number) => Math.min(hi, Math.max(0, v));
  const rect = {
    x0: cl(Math.min(a[0], b[0]) - pa.xOffset, pa.img.w),
    y0: cl(Math.min(a[1], b[1]), pa.img.h),
    x1: cl(Math.max(a[0], b[0]) - pa.xOffset, pa.img.w),
    y1: cl(Math.max(a[1], b[1]), pa.img.h),
  };
  if (rect.x1 - rect.x0 < 4 || rect.y1 - rect.y0 < 4) return { error: "small" };
  return { rect };
}

type ClipboardLike = { writeText?: (t: string) => Promise<void> } | undefined | null;

/** Write to the clipboard; true if it took. writeText is called before the
 * first await, so a caller inside a click is still inside its activation. A
 * missing clipboard (non-secure context) or a refusal is false, never a throw. */
export async function deliverCopy(text: string, clipboard: ClipboardLike): Promise<boolean> {
  let pending: Promise<void>;
  try {
    if (!clipboard || typeof clipboard.writeText !== "function") return false;
    pending = clipboard.writeText(text);
  } catch { return false; }
  try { await pending; return true; } catch { return false; }
}

/** The fallback's Copy button: select the textarea's text and copy the
 * selection (execCommand) — synchronously, inside the click, since browsers
 * may refuse a copy that isn't, and a context that refuses the async
 * clipboard may still allow this — then try the clipboard again. false =
 * both refused; the text stays selected for ⌘C. */
export async function retryCopy(text: string, env: { clipboard: ClipboardLike; select: () => void; execCopy: () => boolean }): Promise<boolean> {
  env.select();
  let copied = false;
  try { copied = !!env.execCopy(); } catch { copied = false; }
  if (copied) return true;
  return deliverCopy(text, env.clipboard);
}

/** Esc in the receipt (its textarea has focus after a retry, and the canvas's
 * Esc chain ignores textareas) closes it, and goes no further. */
export function receiptKeyDown(e: { key: string; preventDefault(): void; stopPropagation(): void }, onClose: () => void): void {
  if (e.key !== "Escape") return;
  e.preventDefault(); e.stopPropagation();
  onClose();
}

export const PREVIEW_CHARS = 220;
export const previewOf = (text: string): string => (text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text);

export interface CopyReceipt {
  text: string;
  lineCount: number;
  preview: string;
  reader: string;
  skipped: number;
  /** the clipboard refused: the receipt shows the text in a textarea instead */
  failed: boolean;
  scope: "box" | "page";
  /** the sheet key it was read from (its "Copy page text" reads that page) */
  key: string;
  /** OCR lines split at a tile seam, when any */
  clipped?: number;
}

/** `hybrid`: the copy was copyPlan's "hybrid" (its note names the picture). */
export function makeReceipt(o: TextOutcome, opts: { failed: boolean; scope: "box" | "page"; key: string; hybrid?: boolean }): CopyReceipt {
  const reader = o.imageUnread ? `${o.reader} · ${opts.hybrid ? PICTURE_UNREAD_NOTE : IMAGE_UNREAD_NOTE}` : o.reader;
  const r: CopyReceipt = { text: o.text, lineCount: o.lineCount, preview: previewOf(o.text), reader, skipped: o.skipped, failed: opts.failed, scope: opts.scope, key: opts.key };
  if (o.clipped) r.clipped = o.clipped;
  return r;
}

/** How long a receipt whose write took stays up. */
export const RECEIPT_MS = 7000;
/** A refused write never expires: its textarea is the only copy left. */
export const receiptExpires = (r: CopyReceipt): boolean => !r.failed;
/** The canvas's Esc clears a receipt, except a refused one (same reason). */
export const receiptAfterEsc = (r: CopyReceipt | null): CopyReceipt | null => (r && r.failed ? r : null);

/** Receipt box: its width, the fallback textarea's height, the preview's cap. */
export const RECEIPT_W = 300;
export const RECEIPT_TEXTAREA_H = 110;
export const RECEIPT_PREVIEW_MAX_H = 96;

export type ReceiptPlacement = { position: "absolute"; right?: number; left?: number; top?: number; bottom?: number };
/** Where the receipt sits, absolute inside the canvas (so a right-docked rail
 * or panel is never covered): bottom-right, below the live readout (top-right)
 * the way the zone panel stacks; left of the Sweep panel while a sweep is live
 * (the canvas's right edge is at or left of the window's, so clearing the
 * Sweep's window-right span from the canvas edge clears it) and beside the
 * Zone check panel while it's up; on a phone,
 * where the readout is a bottom strip, across the top. */
export function receiptPlacement({ sweepOpen, zoneOpen, narrow }: { sweepOpen: boolean; zoneOpen: boolean; narrow: boolean }): ReceiptPlacement {
  if (narrow) return { position: "absolute", left: 10, right: 10, top: CANVAS_EDGE };
  let right = RAIL_CLEAR;
  if (sweepOpen) right = Math.max(right, FLOAT_GAP + SWEEP_PANEL_W + FLOAT_GAP);
  // the zone panel shares the corner and its height varies (up to the whole
  // canvas), so there's no fixed spot above it: the receipt moves beside it
  if (zoneOpen) right = Math.max(right, RAIL_CLEAR + ZONE_PANEL_W + FLOAT_GAP);
  return { position: "absolute", right, bottom: CANVAS_EDGE };
}

/** Why a copy can't start on this panel, or null. A stitched surface has no
 * page of its own (its members' pages are each their own). */
export function copyUnavailable(p: { stitch: boolean; hasPage: boolean }): string | null {
  if (p.stitch) return "Copy text works on single sheets — open the sheet on its own.";
  return p.hasPage ? null : "Open a sheet first.";
}
