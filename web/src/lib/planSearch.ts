// Plan-set search as the gallery shows it — a thin layer over planIndex.ts.
//
// Pure, DOM-free, pdfjs-free, like planIndex: the gallery hands over its index
// map and the sheet keys currently in the plan set, and gets back what it
// renders. Ranking is planIndex.searchPlan's alone (text before OCR, then
// score, then canonical sheet order); nothing here re-sorts.
import { buildSheetIndex, indexIsScanLike, searchPlan, type IndexedTextItem, type SheetHit, type SheetIndex } from "./planIndex";
import type { OcrWord } from "./ocr/types";
import { parseSheetKey } from "./sheetKey";
import { pageReadView, UNREACHABLE, type PageReadStatus, type PageReadView } from "./ocr/pageRead";

export interface PlanSearchResult {
  /** matching sheets in the set, in searchPlan's order */
  hits: SheetHit[];
  /** key → the distinct index terms it matched on, in query order */
  chipsByKey: Record<string, string[]>;
  /** hit keys whose match came from OCR text, not the PDF's text layer */
  ocrKeys: Set<string>;
  /** sheets in the set that have been checked, are scans (planIndex
   *  indexIsScanLike: little or no text layer), and have no OCR entry —
   *  "a scan, not read yet" */
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

/** A sheet the text pass checked and found to be a scan (indexIsScanLike:
 *  no text layer, or a few stray runs), with no OCR entry yet: "a scan, not
 *  read". Its stray runs stay searchable until the read replaces them. Not
 *  indexed yet is unknown, not unread. */
export function needsRead(ix: SheetIndex | undefined): boolean {
  return !!ix && ix.source === "text" && indexIsScanLike(ix);
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

/** A gallery card's Read control: the canvas's pageReadView, with "a scan"
 *  taken from the sheet's index entry (an OCR entry is a scan that has been
 *  read). */
export function galleryReadView(ix: SheetIndex | undefined, avail: string | null | undefined, status: PageReadStatus | undefined): PageReadView {
  const textless = ix ? ix.source === "ocr" || indexIsScanLike(ix) : undefined;
  return pageReadView({ textless, avail, status });
}

/** The line under the search results: how many sheets search can't see
 *  into, shown only when they could be read (OCR available); when the probe
 *  couldn't reach the reader, that (the gallery adds Retry). */
export function unreadLine(count: number, avail: string | null | undefined): string | null {
  if (count > 0 && avail === "error") return UNREACHABLE;
  if (count <= 0 || avail !== "available") return null;
  return count === 1 ? "1 sheet has little or no text layer and hasn't been read" : `${count} sheets have little or no text layer and haven't been read`;
}

/** A gallery thumbnail record's text-layer flag (thumbs.js): false for a
 *  scan (indexIsScanLike), true for a page with a text layer, once a raster
 *  of the page read its text; undefined on a record saved before the flag. */
export interface ThumbTextFlag { textLayer?: boolean }

/** A cached thumbnail that says its page is a scan seeds that sheet's empty
 *  text entry (what pageTextIndex gives a page with no tokens; a scan's few
 *  stray runs are left for the walk's real read), so a reopened gallery
 *  knows the sheet needs a read without parsing its PDF. Nothing over an
 *  entry already there (an OCR read included), nothing for a page with
 *  text, nothing for an old record. */
export function seedFromThumb(rec: ThumbTextFlag | null | undefined, key: string, has: (key: string) => boolean): SheetIndex | null {
  if (!rec || rec.textLayer !== false || has(key)) return null;
  return { ...buildSheetIndex(key, [], "text"), seeded: true };
}

/** A record saved before the flag: its page's text is read once (when its
 *  card is shown) and the record saved again with the flag. */
export function thumbTextUnknown(rec: ThumbTextFlag): boolean {
  return rec.textLayer === undefined;
}

/** What the gallery does with a kept thumbnail record for the index:
 *  "seed" the empty text entry (a scan, not indexed yet); for an old record
 *  with no flag, "flag" it from the sheet's real entry if it has one (an
 *  OCR entry means a scan) and save it again, no page read, else
 *  "read" the page's text once, but only from a document already loaded
 *  (`docLoaded(file)`): opening the gallery never loads a PDF for this, and
 *  the flag stays unknown until the document is loaded for another reason;
 *  otherwise nothing. */
export function thumbIndexStep(rec: ThumbTextFlag, key: string, get: (key: string) => SheetIndex | undefined, docLoaded: (file: string) => boolean):
  { kind: "seed"; ix: SheetIndex } | { kind: "flag"; textLayer: boolean } | { kind: "read" } | { kind: "none" } {
  const ix = seedFromThumb(rec, key, (k) => !!get(k));
  if (ix) return { kind: "seed", ix };
  if (!thumbTextUnknown(rec)) return { kind: "none" };
  const have = get(key);
  if (have && !have.seeded) return { kind: "flag", textLayer: have.source === "text" && !indexIsScanLike(have) };
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
 *  whether the map changed, so the caller knows to re-render.
 *
 *  A text-layer entry replaces only a seeded one. The canvas re-reads the lead
 *  page's text on every render and the gallery reads it again on a thumbnail
 *  miss; the text layer of the same bytes doesn't change, and letting a
 *  repeat pass through would overwrite an OCR read of a scan with its text
 *  entry. An OCR read replaces whatever is there: it only runs on a scan, or
 *  to read one again. A file whose bytes change is dropped first
 *  (planIndex.dropFileFromIndex), so a revised sheet starts from an empty
 *  slot.
 *
 *  A scan's stray text-layer terms (a stamp, a scanner label) are kept in its
 *  OCR entry, whichever arrives first, so a read that missed the stamp
 *  doesn't drop it from search (mergeStrayText). The entry stays "ocr": its
 *  hits rank, and are badged, as OCR, the conservative label for a sheet
 *  that is mostly read text. */
export function putSheetIndex(map: Map<string, SheetIndex>, key: string, ix: SheetIndex): boolean {
  const have = map.get(key);
  if (ix.source === "text") {
    // a text pass (a seed included) replaces only a seed; over a read of a
    // scan it adds the stray terms the read lacks
    if (!isIndexed(map, key)) { map.set(key, ix); return true; }
    if (have!.source !== "ocr" || ix.seeded) return false;   // a seed isn't a text pass
    // the text pass is recorded on the read (needsTextPass), whatever it adds
    const merged = mergeStrayText(have!, indexIsScanLike(ix) ? ix.terms : {});
    if (merged === have) return false;
    map.set(key, merged);
    return merged.terms !== have!.terms;   // only new terms change what search sees
  }
  // a read over a text entry has had its text pass (a scan's terms fold
  // in; a sheet with a text layer gives none); over an earlier read, that
  // read's; over a seed or nothing, none yet (needsTextPass)
  const stray = !have || have.seeded ? undefined
    : have.source === "text" ? (indexIsScanLike(have) ? have.terms : {})
    : have.stray;
  map.set(key, stray ? mergeStrayText(ix, stray) : ix);
  return true;
}

/** An OCR entry with a scan's text-layer terms (`stray`) folded in: each
 *  term at the larger of its two counts (both sources saw the same ink, so
 *  a sum would double it), and `stray` kept on the entry for the next read
 *  (its presence also says the text pass has happened: needsTextPass).
 *  Returns `ocr` itself when there's nothing to add and that's recorded.
 *  Only a scan's text terms are passed ({} for a sheet with a text layer,
 *  which keeps its read as it is). */
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
 *  and only a text pass brings back the stamp terms the read missed.
 *  putSheetIndex records `stray` on every read placed over a real text
 *  entry and on every text pass over a read, so a read without it is one
 *  that replaced a seed — a sheet whose thumbnail said scan — and each such
 *  sheet is read once, not on every render or search. No otherwise. */
export function needsTextPass(ix: SheetIndex | undefined): boolean {
  if (!ix || ix.seeded) return true;
  return ix.source === "ocr" && ix.stray === undefined;
}

/** Has a sheet been indexed for real? A seeded entry hasn't: the canvas's
 *  text pass, the thumbnails and the search walk all still read it. */
export function isIndexed(map: ReadonlyMap<string, SheetIndex>, key: string): boolean {
  const ix = map.get(key);
  return !!ix && !ix.seeded;
}
