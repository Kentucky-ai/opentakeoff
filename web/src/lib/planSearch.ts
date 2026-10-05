// Plan-set search as the gallery shows it — a thin layer over planIndex.ts.
//
// Pure, DOM-free, pdfjs-free, like planIndex: the gallery hands over its index
// map and the sheet keys currently in the plan set, and gets back what it
// renders. Ranking is planIndex.searchPlan's alone (text before OCR, then
// score, then canonical sheet order); nothing here re-sorts.
import { buildSheetIndex, indexIsScanLike, isHybrid, isScan, searchPlan, type IndexedTextItem, type Rect, type SheetHit, type SheetIndex } from "./planIndex";
import type { OcrWord } from "./ocr/types";
import { parseSheetKey } from "./sheetKey";
import { isStitchKey } from "./stitches";
import { pageReadView, UNREACHABLE, type PageReadStatus, type PageReadView, type ReadPlan } from "./ocr/pageRead";

export interface PlanSearchResult {
  /** matching sheets in the set, in searchPlan's order */
  hits: SheetHit[];
  /** key → the distinct index terms it matched on, in query order */
  chipsByKey: Record<string, string[]>;
  /** hit keys whose match came from OCR text, not the PDF's text layer
   *  (each hit's own source: planIndex searchPlan) */
  ocrKeys: Set<string>;
  /** sheets in the set that have been checked, are scans or hybrids (a
   *  picture the text layer can't read), and have no OCR entry: needsRead */
  unreadCount: number;
}

/** Search the sheets in `allKeys`.
 *
 *  Entries for keys outside `allKeys` are dropped BEFORE searchPlan sees them:
 *  searchPlan decides per query token, across every sheet it is given, whether
 *  a code may extend by digit, so a leftover entry for a closed file that has
 *  CPT-1 exactly would stop "CPT-1" finding a live sheet that only has CPT-12.
 *  Filtering the results afterwards would still show the wrong set. */
export function runPlanSearch(
  query: string,
  indexes: ReadonlyMap<string, SheetIndex>,
  allKeys: readonly string[],
): PlanSearchResult {
  const live: SheetIndex[] = [];
  let unreadCount = 0;
  for (const key of allKeys) {
    const ix = indexes.get(key);
    if (!ix) continue;
    live.push(ix);
    if (needsRead(ix)) unreadCount++;
  }
  const hits = searchPlan(live, query);
  const chipsByKey: Record<string, string[]> = {};
  const ocrKeys = new Set<string>();
  for (const h of hits) {
    chipsByKey[h.key] = [...new Set(h.matched)];
    if (h.source === "ocr") ocrKeys.add(h.key);
  }
  return { hits, chipsByKey, ocrKeys, unreadCount };
}

/** A sheet the text pass checked (or a thumbnail record seeded) and found
 *  to be a scan (planIndex isScan: no text layer, or a few stray runs) or a
 *  hybrid (isHybrid: a text layer, and a picture it can't read), with no OCR
 *  entry yet: "not read". Its text stays searchable while it waits. Not
 *  indexed yet is unknown, not unread; a stitch is never read. */
export function needsRead(ix: SheetIndex | undefined): boolean {
  return !!ix && ix.source === "text" && readable(ix);
}

/** Scans and hybrids are read; a stitch (a working surface over several
 *  sheets) never is. The same answer as readPlanOf's "not none". */
function readable(ix: SheetIndex): boolean {
  return !isStitchKey(ix.key) && (isScan(ix) || isHybrid(ix));
}

/** What a read of this sheet reads (ocr/pageRead's plan), from its index
 *  entry: a scan (isScan) whole; a hybrid (isHybrid) its pictures, stored in
 *  pt and handed over in px at `rs`; anything else nothing (a vector sheet
 *  with no picture, not measured yet, or whose op list failed; a stitch).
 *  No entry: no plan (undefined), and readPageText reads the page whole, as
 *  before #489.
 *  An OCR entry plans by the fields it carries, not by its own text: a read
 *  over a hybrid's entry or seed carries the pictures and plans them again;
 *  a read placed over nothing carries no flag and plans a scan (isScan:
 *  reads only ran on scans before #489); a read over a vector entry not
 *  measured, or whose op list failed, plans nothing. The Read offer asks
 *  the same (readWhat), so it never offers what this wouldn't read. */
export function readPlanOf(ix: SheetIndex, rs: number): ReadPlan;
export function readPlanOf(ix: SheetIndex | undefined, rs: number): ReadPlan | undefined;
export function readPlanOf(ix: SheetIndex | undefined, rs: number): ReadPlan | undefined {
  if (!ix) return undefined;
  if (isStitchKey(ix.key)) return { kind: "none" };
  if (isScan(ix)) return { kind: "scan" };
  if (isHybrid(ix)) return { kind: "pictures", rects: (ix.pictures as Rect[]).map((r) => ({ x0: r.x0 * rs, y0: r.y0 * rs, x1: r.x1 * rs, y1: r.y1 * rs })) };
  return { kind: "none" };
}

/** What a read of this sheet covers (readPlanOf): "page" for a scan,
 *  "picture" for a hybrid, null when there's nothing to read (or no entry
 *  yet). The canvas's and the gallery's Read offer and label both ask it. */
export function readWhat(ix: SheetIndex | undefined): "page" | "picture" | null {
  const kind = ix ? readPlanOf(ix, 1).kind : "none";
  return kind === "scan" ? "page" : kind === "pictures" ? "picture" : null;
}

/** May a cache lookup run for this sheet now? Not when its entry plans no
 *  read: such a sheet was never read, and the reader memoizes a lookup per
 *  sheet, miss included, so a lookup before the sheet is measured (Copy on
 *  a vector sheet, ahead of the canvas's measure) would hide a hybrid's
 *  saved pictures read until its file is dropped. Not with no entry either
 *  (Copy ahead of the canvas's first pass, or a file just dropped from the
 *  index): a lookup with no plan is a whole-page one, which would land a
 *  hybrid's saved pictures read as an OCR entry over nothing, and that
 *  entry plans, and offers Read again, as a scan. The sheet's measure puts
 *  its entry in, and its lookup runs then. */
export function mayLookUp(ix: SheetIndex | undefined): boolean {
  return !!ix && readWhat(ix) !== null;
}

/** What the canvas's Read rows show, kept in step with the index: each
 *  sheet already shown (measured) re-derived with readWhat from its entry
 *  now (a gallery adopt can turn a "failed" sheet into a hybrid; a read
 *  keeps what its entry planned), and dropped when its entry is gone (its
 *  file left or was re-added). A sheet not in `prev` stays unknown until
 *  measured. The same object when nothing changed, so a state setter given
 *  it doesn't re-render. */
export type ReadableByKey = Readonly<Record<string, "page" | "picture" | null>>;
export function readableFromIndex(prev: ReadableByKey, index: ReadonlyMap<string, SheetIndex>): ReadableByKey {
  let next: Record<string, "page" | "picture" | null> | null = null;
  for (const [k, was] of Object.entries(prev)) {
    const ix = index.get(k);
    if (ix && readWhat(ix) === was) continue;
    next ??= { ...prev };
    if (ix) next[k] = readWhat(ix);
    else delete next[k];
  }
  return next ?? prev;
}

/** A kept thumbnail record's measurement (thumbIndexStep "adopt") put onto
 *  the sheet's entry: the same entry, source and terms (a read stays a
 *  read, with its `stray` as it was), with the record's pictures and, when
 *  given, its flag. putSheetIndex takes it as that kind of entry. */
export function adoptEntry(have: SheetIndex, step: { pictures: Rect[] | "failed"; textLayer?: boolean }): SheetIndex {
  return step.textLayer === undefined ? { ...have, pictures: step.pictures } : { ...have, pictures: step.pictures, textLayer: step.textLayer };
}

/** The gallery's cache lookups: every sheet in the set that needs a read,
 *  whichever pass indexed it (the canvas, the thumbnail pump, the walk). A
 *  lookup that hits puts the cached read in the index as OCR. */
export function keysToLookUp(allKeys: readonly string[], indexes: ReadonlyMap<string, SheetIndex>): string[] {
  return allKeys.filter((k) => needsRead(indexes.get(k)));
}

/** May the gallery ask the OCR cache? Not on a build with OCR off, and not
 *  once the probe says off or not installed; offline (error) the cache still
 *  answers, since a lookup needs no network. */
export function canLookUp(enabled: boolean, avail: string | null | undefined): boolean {
  return enabled && avail !== "disabled" && avail !== "uninstalled";
}

/** A gallery card's Read control, and what it reads. */
export type GalleryReadView = PageReadView & { what: "page" | "picture" };

/** A gallery card's Read control: the canvas's pageReadView, with "can be
 *  read" taken from the sheet's index entry (readWhat: what readPlanOf would
 *  read, a read's own entry included, so Read again reads the same), and
 *  `what` the read covers: the pictures on a hybrid, else the whole page. */
export function galleryReadView(ix: SheetIndex | undefined, avail: string | null | undefined, status: PageReadStatus | undefined): GalleryReadView {
  const what = readWhat(ix);
  return { ...pageReadView({ textless: ix ? what !== null : undefined, avail, status }), what: what ?? "page" };
}

/** The line under the search results: how many sheets search can't see
 *  into, shown only when they could be read (OCR available); when the probe
 *  couldn't reach the reader, that (the gallery adds Retry). */
export function unreadLine(count: number, avail: string | null | undefined): string | null {
  if (count > 0 && avail === "error") return UNREACHABLE;
  if (count <= 0 || avail !== "available") return null;
  return count === 1 ? "1 sheet with a scan or a picture that hasn't been read" : `${count} sheets with scans or pictures that haven't been read`;
}

/** A gallery thumbnail record's text-layer flag (thumbs.js): false for a
 *  scan (indexIsScanLike), true for a page with a text layer, once a raster
 *  of the page read its text; undefined on a record saved before the flag.
 *  `pictures`: the page's unread pictures (SheetIndex pictures), once
 *  measured under the current rule; undefined when not. */
export interface ThumbTextFlag { textLayer?: boolean; pictures?: Rect[] | "failed" }

/** A cached thumbnail that says its page is a scan, or a hybrid (a text
 *  layer and at least one unread picture), seeds that sheet's empty text
 *  entry (what pageTextIndex gives a page with no tokens; the text itself is
 *  left for a real text pass), so a reopened gallery knows the sheet needs a
 *  read without parsing its PDF. Each seed carries its record's flag (and a
 *  hybrid's its pictures), so a read placed over it carries "scan" or "not
 *  a scan" whatever the read's own line count. Nothing over an entry already
 *  there (an OCR read included), nothing for a page with text and no
 *  picture, nothing for an old record. */
export function seedFromThumb(rec: ThumbTextFlag | null | undefined, key: string, has: (key: string) => boolean): SheetIndex | null {
  if (!rec || has(key)) return null;
  if (rec.textLayer === false) return { ...buildSheetIndex(key, [], "text"), textLayer: false, seeded: true };
  if (rec.textLayer !== true || !Array.isArray(rec.pictures) || !rec.pictures.length) return null;
  return { ...buildSheetIndex(key, [], "text"), textLayer: true, pictures: rec.pictures, seeded: true };
}

/** A record saved before the flag: its page's text is read once (when its
 *  card is shown) and the record saved again with the flag. */
export function thumbTextUnknown(rec: ThumbTextFlag): boolean {
  return rec.textLayer === undefined;
}

/** What the gallery does with a kept thumbnail record for the index:
 *  - "seed" the empty text entry (a scan or a hybrid, not indexed yet);
 *  - a scan's record: nothing more (a scan has no pictures to measure);
 *  - a record with pictures: "adopt" them onto an entry (text or a read)
 *    whose measurement is weaker (none: the canvas's label loop indexed the
 *    sheet without measuring it; "failed": this session's op list failed),
 *    with the record's flag when the entry carries none (a read placed over
 *    nothing), else nothing;
 *  - a record without pictures (or, saved before the flag, without
 *    textLayer): "flag" it from the sheet's real entry, no page read, when
 *    that entry is the evidence (always for an old record; for one without
 *    pictures, once the entry is measured), and save it again — a read is
 *    evidence only through the flag it carried over, so a hybrid's read is
 *    never called a scan. Its pictures go with the flag only when measured
 *    ("failed" is this session's alone, never saved), so an entry whose op
 *    list failed flags only a record without the flag, and otherwise asks
 *    nothing more this session; else "read" the page once (text and pictures),
 *    but only from a document already loaded
 *    (`docLoaded(file)`): opening the gallery never loads a PDF for this, and
 *    the record stays as it is until the document is loaded for another
 *    reason. */
export function thumbIndexStep(rec: ThumbTextFlag, key: string, get: (key: string) => SheetIndex | undefined, docLoaded: (file: string) => boolean):
  | { kind: "seed"; ix: SheetIndex }
  | { kind: "flag"; textLayer: boolean; pictures?: Rect[] }
  | { kind: "adopt"; pictures: Rect[] | "failed"; textLayer?: boolean }
  | { kind: "read" }
  | { kind: "none" } {
  const ix = seedFromThumb(rec, key, (k) => !!get(k));
  if (ix) return { kind: "seed", ix };
  if (rec.textLayer === false) return { kind: "none" };
  const have = get(key);
  const real = have && !have.seeded ? have : undefined;
  if (rec.pictures !== undefined) {
    if (!real || measuredOf(real.pictures, rec.pictures) === real.pictures) return { kind: "none" };
    return real.textLayer === undefined && rec.textLayer !== undefined
      ? { kind: "adopt", pictures: rec.pictures, textLayer: rec.textLayer }
      : { kind: "adopt", pictures: rec.pictures };
  }
  // a read that carries no flag was placed over nothing: no evidence either
  // way (a hybrid's read must never be flagged a scan)
  const evidence = real && !(real.source === "ocr" && real.textLayer === undefined);
  if (evidence && (thumbTextUnknown(rec) || Array.isArray(real.pictures))) {
    const textLayer = real.textLayer ?? !indexIsScanLike(real);
    return Array.isArray(real.pictures) ? { kind: "flag", textLayer, pictures: real.pictures } : { kind: "flag", textLayer };
  }
  // measured this session and failed: a read would fail the same way
  if (evidence && real.pictures === "failed") return { kind: "none" };
  return docLoaded(parseSheetKey(key).file) ? { kind: "read" } : { kind: "none" };
}

/** The line beside the gallery's search box: the hit count. null with no
 *  search (the header subtitle is the one it always was). */
export function galleryCountLine(search: { hits: number } | null, total: number): string | null {
  if (!search) return null;
  return `${search.hits} of ${total} sheet${total === 1 ? "" : "s"} match${total === 1 ? "es" : ""}`;
}

/** Sheets the search walk couldn't read: a page by its key, or a file that
 *  wouldn't open as the pages it was expected to have. None of them counts
 *  as checked, so "no match" isn't claimed for text search never saw. */
export function createWalkFailures() {
  const failed = new Map<string, number>();
  const fileKey = (file: string) => `file:${file}`;
  return {
    fail(key: string) { failed.set(key, 1); },
    failFile(file: string, pages: number) { failed.set(fileKey(file), Math.max(1, pages)); },
    ok(key: string) { failed.delete(key); },
    okFile(file: string) { failed.delete(fileKey(file)); },
    count(): number { let n = 0; for (const v of failed.values()) n += v; return n; },
  };
}

/** The gallery's line for a search that missed sheets: how many couldn't be
 *  read, or that the walk stopped early (the gallery adds Retry). */
export function searchFailedLine(s: { sheets: number; incomplete: boolean }): string | null {
  if (s.sheets > 0) return `${s.sheets} sheet${s.sheets === 1 ? "" : "s"} couldn't be read for search`;
  return s.incomplete ? "Search couldn't read every sheet" : null;
}

/** Whether a new query should walk again for what the last walk missed. */
export function retryWalk(s: { sheets: number; incomplete: boolean }): boolean {
  return s.sheets > 0 || s.incomplete;
}

/** OCR words (or lines) → index input. Only the string is indexed; a blank
 *  one carries nothing, so it's dropped here rather than counted. */
export function ocrWordsToItems(words: readonly OcrWord[]): IndexedTextItem[] {
  const out: IndexedTextItem[] = [];
  for (const w of words || []) if ((w.str || "").trim()) out.push({ str: w.str });
  return out;
}

/** A page read's (or cached read's) lines → that sheet's OCR index entry,
 *  which putSheetIndex lets replace the sheet's empty text entry. */
export function ocrSheetIndex(key: string, lines: readonly OcrWord[]): SheetIndex {
  return buildSheetIndex(key, ocrWordsToItems(lines), "ocr");
}

/** Store one sheet's index entry, if it may replace what is there. Returns
 *  whether the map changed in a way search or the Read control can see, so
 *  the caller knows to re-render.
 *
 *  A text-layer entry replaces only a seeded one. The canvas re-reads the lead
 *  page's text on every render and the gallery reads it again on a thumbnail
 *  miss; the text layer of the same bytes doesn't change, and letting a
 *  repeat pass through would overwrite an OCR read with its text entry. One
 *  exception: an entry whose pictures were never measured (the canvas's
 *  label loop doesn't measure), or whose op list failed, takes a later
 *  pass's measurement (measuredOf). An OCR read replaces
 *  whatever is there: it only runs on a scan or a hybrid, or to read one
 *  again. A file whose bytes change is dropped first
 *  (planIndex.dropFileFromIndex), so a revised sheet starts from an empty
 *  slot.
 *
 *  The text layer's terms are kept in the sheet's OCR entry, whichever
 *  arrives first (mergeStrayText): a scan's stamp the read missed, and a
 *  hybrid's whole text layer, since its read covers only the pictures. The
 *  entry stays "ocr"; searchPlan badges a hit text when every term it
 *  matched is the text layer's own on a sheet with one (textLayer).
 *
 *  `textLayer` and `pictures` (#489) carry over to an entry that lacks them
 *  from the one it replaces (a read over a text entry, a seed or an earlier
 *  read; a text pass over a seed). A read that hasn't had its text pass (no
 *  `stray`: placed over a seed or nothing) takes the pass's own. Wherever
 *  two measurements meet, "failed" is the weakest (measuredOf). */
export function putSheetIndex(map: Map<string, SheetIndex>, key: string, ix: SheetIndex): boolean {
  const have = map.get(key);
  if (ix.source === "text") {
    // a text pass (a seed included) replaces only a seed; over a read it
    // adds the text-layer terms the read lacks
    // a seed replaces a seed whole: the newer record is the one that stands
    if (!isIndexed(map, key)) { map.set(key, have && !ix.seeded ? carryFields(ix, have) : ix); return true; }
    if (ix.seeded) return false;   // a seed isn't a text pass
    if (have!.source === "text") {
      const pictures = measuredOf(have!.pictures, ix.pictures);
      if (pictures === have!.pictures) return false;
      map.set(key, carryFields({ ...have!, pictures }, ix));
      return true;
    }
    // the text pass is recorded on the read (needsTextPass), whatever it adds
    const merged = mergeStrayText(have!, ix.terms);
    const first = have!.stray === undefined;
    const textLayer = first ? ix.textLayer ?? have!.textLayer : have!.textLayer ?? ix.textLayer;
    const pictures = first ? measuredOf(ix.pictures, have!.pictures) : measuredOf(have!.pictures, ix.pictures);
    const fieldsChanged = textLayer !== have!.textLayer || pictures !== have!.pictures;
    if (merged === have && !fieldsChanged) return false;
    map.set(key, withFields(merged, textLayer, pictures));
    // a recorded pass alone changes nothing search sees; new terms, the
    // flag or the pictures (the badge and the Read offer) do
    return merged.terms !== have!.terms || fieldsChanged;
  }
  // a read over a text entry has had its text pass (its terms fold in);
  // over an earlier read, that read's; over a seed or nothing, none yet
  // (needsTextPass)
  const stray = !have || have.seeded ? undefined : have.source === "text" ? have.terms : have.stray;
  map.set(key, carryFields(stray ? mergeStrayText(ix, stray) : ix, have));
  return true;
}

/** `ix` with `from`'s textLayer and pictures where `ix` has none; `ix`
 *  itself when there's nothing to carry. */
function carryFields(ix: SheetIndex, from: SheetIndex | undefined): SheetIndex {
  if (!from) return ix;
  const textLayer = ix.textLayer ?? from.textLayer, pictures = measuredOf(ix.pictures, from.pictures);
  return textLayer === ix.textLayer && pictures === ix.pictures ? ix : withFields(ix, textLayer, pictures);
}

/** The stronger of two measurements of a page's pictures: a real one (an
 *  array, empty included) over "failed" over none; between two of the same
 *  strength, `preferred`. An op list this session couldn't read says nothing
 *  against pictures a kept record (or another pass) measured on the same
 *  bytes, and never stops one that can from landing. */
function measuredOf(preferred: SheetIndex["pictures"], other: SheetIndex["pictures"]): SheetIndex["pictures"] {
  const rank = (p: SheetIndex["pictures"]) => (Array.isArray(p) ? 2 : p === "failed" ? 1 : 0);
  return rank(other) > rank(preferred) ? other : preferred;
}

/** `ix` with exactly these textLayer and pictures: an unset one is left
 *  off, not stored as undefined (entries compare by shape). */
function withFields(ix: SheetIndex, textLayer: boolean | undefined, pictures: SheetIndex["pictures"]): SheetIndex {
  const out: SheetIndex = { ...ix };
  if (textLayer === undefined) delete out.textLayer; else out.textLayer = textLayer;
  if (pictures === undefined) delete out.pictures; else out.pictures = pictures;
  return out;
}

/** An OCR entry with the text layer's terms (`stray`) folded in: each
 *  term at the larger of its two counts (both sources saw the same ink, so
 *  a sum would double it), and `stray` kept on the entry for the next read
 *  (its presence also says the text pass has happened: needsTextPass).
 *  Returns `ocr` itself when there's nothing to add and that's recorded.
 *  On a scan they are its few stray terms; on a hybrid, its whole text
 *  layer (the read covers only the pictures). */
export function mergeStrayText(ocr: SheetIndex, stray: Record<string, number>): SheetIndex {
  let terms: Record<string, number> | null = null;
  for (const [term, n] of Object.entries(stray)) {
    if ((ocr.terms[term] ?? 0) >= n) continue;
    terms ??= { ...ocr.terms };
    terms[term] = n;
  }
  if (!terms && ocr.stray) return ocr;
  return { ...ocr, terms: terms ?? ocr.terms, stray };
}

/** A sheet's key: page 1 is the bare file name, later pages `file#n`. */
const sheetKeyOf = (file: string, page: number) => (page > 1 ? `${file}#${page}` : file);

/** The gallery's indexing walk, step one: which files to open. A file is
 *  skipped only when its page count is known AND every page is indexed, so a
 *  fully indexed set loads no document. A file with no known count (or a 0,
 *  an unreadable last try) is walked expecting 0 pages; the walk learns the
 *  count from its document. `knownPages` seeds the progress total. */
export function filesToIndex(
  files: readonly string[],
  pageCount: (file: string) => number | undefined,
  has: (key: string) => boolean,
): { file: string; knownPages: number }[] {
  const out: { file: string; knownPages: number }[] = [];
  for (const file of files) {
    const n = pageCount(file) || 0;
    let missing = n === 0;
    for (let p = 1; p <= n && !missing; p++) if (!has(sheetKeyOf(file, p))) missing = true;
    if (missing) out.push({ file, knownPages: n });
  }
  return out;
}

/** Step two, once the file's document gives its page count: the sheet keys
 *  still missing from the index, in page order. */
export function pagesToIndex(file: string, numPages: number, has: (key: string) => boolean): string[] {
  const out: string[] = [];
  for (let p = 1; p <= numPages; p++) {
    const key = sheetKeyOf(file, p);
    if (!has(key)) out.push(key);
  }
  return out;
}

/** What one Esc does in the gallery once the page preview (which owns Esc
 *  while open) is out of the way: a typed search clears first; then browse or
 *  manage returns to the plan set; then the plan set exits to the canvas, if
 *  there is one behind it. null: nothing to do. */
export function galleryEscStep(s: { query: string; mode: string; canClose: boolean }): "clear-query" | "to-plan" | "exit" | null {
  if (s.query) return "clear-query";
  if (s.mode === "browse" || s.mode === "manage") return "to-plan";
  return s.canClose ? "exit" : null;
}

/** A change signal that calls its listeners at most once per frame. The
 *  canvas notifies it whenever the index map changes, and only the gallery
 *  listens, so an index write re-renders the gallery (when it's up) and never
 *  the canvas. With no listener, notify schedules nothing. A listener removed
 *  before the frame runs isn't called. */
export function createChangeSignal(schedule: (fn: () => void) => unknown = (fn) => requestAnimationFrame(fn)) {
  const listeners = new Set<() => void>();
  let pending = false;
  return {
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    notify(): void {
      if (pending || !listeners.size) return;
      pending = true;
      schedule(() => {
        pending = false;
        for (const fn of [...listeners]) fn();
      });
    },
  };
}

/** Should a text pass (the canvas's, the thumbnails', the search walk's)
 *  read this sheet's text layer? Yes when it isn't indexed or only seeded,
 *  and when it's an OCR read whose text pass hasn't happened yet (no
 *  `stray`): after a reload, a cached read lands on the thumbnail's seed,
 *  and only a text pass brings back the text-layer terms the read lacks.
 *  putSheetIndex records `stray` on every read placed over a real text
 *  entry and on every text pass over a read, so a read without it is one
 *  that replaced a seed (or nothing), and each such sheet is read once for
 *  its terms, not on every render or search. Yes too for a sheet with a text layer whose
 *  pictures haven't been measured (#489), so a pass that measures them
 *  runs — a read too, unless the flag it carried says scan (a read with
 *  none may be a hybrid's: the pass brings the flag); a scan has none to
 *  measure, and "failed" is never measured again.
 *  No otherwise. */
export function needsTextPass(ix: SheetIndex | undefined): boolean {
  if (!ix || ix.seeded) return true;
  if (ix.source === "ocr") return ix.stray === undefined || (ix.textLayer !== false && ix.pictures === undefined);
  return !isScan(ix) && ix.pictures === undefined;
}

/** Is a text pass that measured no pictures (the canvas's sheet-number and
 *  scale passes) worth building for this entry? needsTextPass also says yes
 *  to a text entry that lacks only its pictures, which such a pass can't
 *  give (putSheetIndex drops it), so here only: no real entry, a seed, or a
 *  read whose text pass hasn't happened (no `stray`) or that lacks the
 *  text-layer flag. */
export function acceptsTextPass(ix: SheetIndex | undefined): boolean {
  if (!ix || ix.seeded) return true;
  return ix.source === "ocr" && (ix.stray === undefined || ix.textLayer === undefined);
}

/** Should a pass that measured a page's pictures (pictures.ts measurePage)
 *  be offered to the index? Yes when the sheet needs a text pass at all
 *  (needsTextPass), and yes when the entry's measurement "failed" and this
 *  one is real: an op list another pass couldn't read must not keep a later
 *  real measurement out (putSheetIndex keeps the real one: measuredOf).
 *  "failed" over "failed" is nothing new. Each caller still measures a page
 *  once (the canvas records the keys it measured), so this never retries. */
export function acceptsMeasuredPass(ix: SheetIndex | undefined, pictures: Rect[] | "failed"): boolean {
  return needsTextPass(ix) || (ix?.pictures === "failed" && Array.isArray(pictures));
}

/** Has a sheet been indexed for real? A seeded entry hasn't: the canvas's
 *  text pass, the thumbnails and the search walk all still read it. */
export function isIndexed(map: ReadonlyMap<string, SheetIndex>, key: string): boolean {
  const ix = map.get(key);
  return !!ix && !ix.seeded;
}
