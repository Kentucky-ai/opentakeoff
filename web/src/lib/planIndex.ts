// Plan-set search index — "which sheet says CPT-1?" across the whole set.
//
// Pure, DOM-free, pdfjs-free (the sheets.ts / oneclick.ts / detectRooms.ts
// precedent): callers hand over text runs — extractRegionText()'s tokens, or
// OCR lines — so this runs identically under the browser canvas, the gallery
// and node:test.
//
// Why hand-rolled and not MiniSearch/FlexSearch: a plan sheet carries ~1k text
// runs (measured on demo/sample-finish-plan.pdf), so a 200-sheet set is ~200k
// tokens — three orders of magnitude below where those libraries start earning
// their keep. An inverted Map is not worth another runtime dependency.
//
import { parseSheetKey, compareSheetKeys } from "./sheetKey";
import { assembleLines } from "./textlines";

// The index is deliberately SOURCE-TAGGED. A vector sheet's text layer is
// exact; OCR text is approximate, with misreads and junk mixed in. Both are
// worth indexing, but a hit must be able to say which it came from — the same
// badge-then-verify posture raster One-Click already takes.

/** One text run. The string is what's indexed, so extractRegionText()'s
 *  Token and detectRooms' PositionedTextItem both feed this without a shim.
 *  A position, when every run has one (a page's text layer does), lets the
 *  scan rule count lines rather than runs (buildSheetIndex lineCount). */
export interface IndexedTextItem {
  str: string;
  x?: number;
  y?: number;
  h?: number;
  w?: number;
  ang?: number;
}

export type IndexSource = "text" | "ocr";

/** A sheet's built index — plain data (a Record, no Map/Set). */
export interface SheetIndex {
  key: string;
  source: IndexSource;
  /** term → how many times it occurs on the sheet, counted in full. */
  terms: Record<string, number>;
  /** total tokens seen AS DRAWN, including ones dropped as unsearchable and
   *  counting repeats — the honest denominator for "did this sheet have text at
   *  all". Not a distinct-term count, and not the size of `terms`: one token can
   *  expand into several terms (see expandTerm). Zero means a text-less sheet. */
  tokenCount: number;
  /** lines of text that carry at least one token — what the scan rule
   *  counts (indexIsScanLike). Positioned runs are assembled into lines the
   *  way Copy text assembles them (textlines assembleLines, same baseline
   *  tolerance), so a letter-spaced stamp drawn one run per letter is one
   *  line; a run rotated past textlines' tilt limit counts as a line of its
   *  own. Runs without a position (OCR lines, tests) count one line each. */
  lineCount: number;
  /** a provisional text-less entry seeded from a gallery thumbnail record
   *  (planSearch seedFromThumb), not from reading the page: any real text
   *  pass replaces it, and the indexing walks treat it as not indexed. */
  seeded?: true;
  /** on an OCR entry of a scan: the text layer's own terms (its stamp,
   *  scanner label), folded into `terms` and kept here so a later read of
   *  the same sheet folds them in again (planSearch putSheetIndex). */
  stray?: Record<string, number>;
}

/** Shortest plain word that earns a slot. Below this, tokens are list numbering
 *  ("1."), stray dimension letters, and leader-line crumbs — measured as ~13% of
 *  a real sheet's runs and never what anyone types. Room/tag-shaped tokens are
 *  admitted regardless of length by isCode(). */
export const MIN_TERM_LEN = 3;

/** Finish / spec / material tag: CPT-1, LVT3, ACT-2, P-1, PT-2A. The vocabulary
 *  estimators actually search a finish plan for. */
export const TAG_RE = /^[A-Z]{1,4}-?\d{1,2}[A-Z]?$/;
/** Room-number label — the SAME shape detectRooms.ts seeds One-Click floods on
 *  (ROOM_LABEL_RE). Kept as its own literal rather than imported: detectRooms
 *  owns a geometry contract, this owns a text one, and they are free to drift. */
export const ROOM_RE = /^\d{2,3}[A-Z]?$/;
/** Sheet number as the title block writes it: A101, A-101, S1.1, AF101. */
export const SHEET_NO_RE = /^[A-Z]{1,3}-?\d{1,3}(\.\d{1,2})?[A-Z]?$/;

/** Is this a code an estimator would type — tag, room number, or sheet number?
 *  Codes bypass MIN_TERM_LEN: "P-1" is three chars of real signal. */
export function isCode(term: string): boolean {
  return TAG_RE.test(term) || ROOM_RE.test(term) || SHEET_NO_RE.test(term);
}

/** Worth an index slot? A word of MIN_TERM_LEN or more, or a code. */
export function isSearchable(term: string): boolean {
  return term.length >= MIN_TERM_LEN || isCode(term);
}

/** Normalize one raw token to its index form: upper-case, and strip punctuation
 *  from the ENDS only. Interior '-', '.', '/' and '#' are load-bearing on a plan
 *  ("CPT-1", "S1.1", "PT-1/PT-2"), so stripping them globally would shred the
 *  exact vocabulary this index exists to find. "Punctuation" is anything but a
 *  Unicode letter or digit, so CAFÉ keeps its É. Returns "" for a token that is
 *  nothing but punctuation. */
export function normalizeTerm(raw: string): string {
  return (raw || "")
    .toUpperCase()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "");
}

/** Split one text run into candidate terms. A single pdf.js run routinely
 *  carries a whole label ("OFFICE 101", "PATIENT ROOM"), so runs are split on
 *  whitespace — the same tokenization detectRooms' roomLabelSeeds does when it
 *  hunts a room number inside a longer run. */
export function splitRun(str: string): string[] {
  return (str || "").split(/\s+/);
}

/** One normalized token → every term it should be findable under.
 *
 *  A two-material callout is written as ONE whitespace-delimited token —
 *  "PT-1/PT-2", "CPT-1,LVT-2" — and indexing only the whole thing makes the
 *  right-hand half silently unfindable: a search for PT-2 misses a sheet that
 *  plainly specifies PT-2. So a token joined by '/' or ',' is indexed under the
 *  whole AND each part.
 *
 *  Only '/' and ',' split. '-' and '.' must NOT: they are internal to single
 *  codes ("CPT-1", "S1.1"), and splitting them would shred the vocabulary this
 *  index exists to find — the same reason normalizeTerm keeps them.
 *
 *  The whole is kept so typing the callout exactly as drawn still matches, and
 *  so a term like "AND/OR" doesn't lose its literal form. */
export function expandTerm(term: string): string[] {
  if (!term.includes("/") && !term.includes(",")) return [term];
  const out = [term];
  for (const part of term.split(/[/,]+/)) {
    const p = normalizeTerm(part);
    if (p && p !== term && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Every token in some text runs, as the index counts them: whitespace-split
 *  and normalized, punctuation-only pieces dropped. */
function* tokensOf(items: readonly IndexedTextItem[]): Generator<string> {
  for (const it of items || []) {
    for (const raw of splitRun(it.str)) {
      const token = normalizeTerm(raw);
      if (token) yield token;
    }
  }
}

/** Does this text carry at least one token as the index counts them? Blank
 *  and punctuation-only text (a stray "-", leader dots) doesn't. A copy
 *  reader's "found anything" test; the page-level rule is indexIsScanLike. */
export function carriesText(items: readonly IndexedTextItem[]): boolean {
  return !tokensOf(items).next().done;
}

/** A page whose text layer has at most this many lines of text is a scan.
 *  A scanned page often carries a little stray text — a scanner label, a
 *  stamp, a typed title-block field — while a vector sheet carries dozens to
 *  hundreds of runs (~1k on demo/sample-finish-plan.pdf).
 *  Provenance: the 8 is borrowed, not measured on pages. The schedule-OCR
 *  prototype (STRAY_TEXT_MAX_TOKENS on claude/browser-ocr-library-f3le2q)
 *  chose it for routing a marquee REGION by its run count, and reproduced
 *  the failure there with one inserted run; no page-level corpus has tested
 *  it. If both land, one should import the other. */
export const SCAN_MAX_TEXT_LINES = 8;

/** THE scan rule (#471): a page is a scan when its text layer has at most
 *  SCAN_MAX_TEXT_LINES lines of text (lineCount; blank and punctuation-only
 *  runs not counted, so a page with no text layer at all is one too).
 *  Search's unread count and Read page text (canvas and gallery) ask this;
 *  Copy text asks it too, and also needs the page to hold an image
 *  (copyText copyIsScanLike).
 *  Lines, not runs or tokens: a stamp or a typed field is one line however
 *  many words it holds or runs it was drawn in. */
export function indexIsScanLike(ix: SheetIndex): boolean {
  return ix.lineCount <= SCAN_MAX_TEXT_LINES;
}

/** Build one sheet's index from its text runs. */
export function buildSheetIndex(
  key: string,
  items: IndexedTextItem[],
  source: IndexSource = "text",
): SheetIndex {
  const terms: Record<string, number> = {};
  let tokenCount = 0;
  const carrying: IndexedTextItem[] = [];
  for (const item of items || []) {
    let carries = false;
    for (const token of tokensOf([item])) {
      carries = true;
      tokenCount++;   // counts TOKENS as drawn, not the terms they expand into
      for (const term of expandTerm(token)) {
        if (!isSearchable(term)) continue;
        terms[term] = (terms[term] ?? 0) + 1;
      }
    }
    if (carries) carrying.push(item);
  }
  return { key, source, terms, tokenCount, lineCount: countLines(carrying) };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Lines among runs that each carry a token: assembled lines plus rotated
 *  runs when every run has a position, else one per run. */
function countLines(runs: readonly IndexedTextItem[]): number {
  if (!runs.every((t) => isNum(t.x) && isNum(t.y) && isNum(t.h))) return runs.length;
  const { lines, skipped } = assembleLines(runs as { str: string; x: number; y: number; h: number; w?: number; ang?: number }[]);
  return lines.length + skipped.length;
}

/** One sheet that matched, and what it matched on. */
export interface SheetHit {
  key: string;
  source: IndexSource;
  score: number;
  /** the index term each KEPT query token matched, in query order (not
   *  ranked) — tokens dropped as unsearchable (see searchPlan) get no entry */
  matched: string[];
}

/** Terms in `index` that match one query token: an exact hit alone, else the
 *  terms that start with it. Prefix matching is what makes a half-typed "CPT"
 *  useful. A token that is already a complete code extends only by a LETTER
 *  unless `digitExtend` is set: CPT-1 finds CPT-1A (a variant of the same
 *  finish) but not CPT-10 (a different one). searchPlan sets `digitExtend` only
 *  when no sheet in the set has the code itself, so a half-typed "CPT-1" on the
 *  way to CPT-12 still finds something. */
export function matchTerm(index: SheetIndex, token: string, digitExtend = false): string[] {
  if (index.terms[token]) return [token];
  const letterOnly = !digitExtend && isCode(token);
  const out: string[] = [];
  for (const term in index.terms) {
    if (!term.startsWith(token)) continue;
    if (letterOnly && !/\p{L}/u.test(term.charAt(token.length))) continue;
    out.push(term);
  }
  return out;
}

/** Search a plan set.
 *
 *  AND across query tokens: "cpt-1 corridor" means the sheet showing BOTH, which
 *  is how someone narrows a 200-sheet set. OR would return the whole set for any
 *  common word and make the feature useless at exactly the size it matters.
 *
 *  A token that fails isSearchable is dropped when the query has other tokens:
 *  the index never holds it, so as an AND term it could only match by prefix —
 *  "note 1" would demand a 1xx room number and lose the sheet that says
 *  "NOTE 1.". A query that is ONLY such a token is kept and matches by prefix,
 *  so the first keystroke of "101" already shows results.
 *
 *  Codes are matched in two passes, decided per query token across the whole
 *  set: if any sheet has the code exactly or with a letter suffix, only those
 *  matches count, so CPT-1 leaves out a sheet that only has CPT-10. If none
 *  does, the token falls back to longer codes by digit (see matchTerm), so
 *  results don't vanish while "101" or "CPT-12" is being typed. The chip shows
 *  the term actually matched.
 *
 *  Order: every text-layer hit before every OCR hit, whatever the scores — a
 *  text-layer match is read from the PDF, an OCR one is recognized from pixels.
 *  Within each, by score, which favours an exact term hit over a prefix one
 *  (×4), a code over prose (×2 — someone typing CPT-1 wants the finish plan,
 *  not the note that mentions it), and more occurrences on the sheet. Ties
 *  after that break on sheet key so results never reshuffle between identical
 *  searches.
 */
export function searchPlan(indexes: Iterable<SheetIndex>, query: string): SheetHit[] {
  const all = splitRun(query).map(normalizeTerm).filter(Boolean);
  const tokens = all.length > 1 ? all.filter(isSearchable) : all;
  if (!tokens.length) return [];
  const sheets = [...indexes];   // two passes; `indexes` may be a one-shot iterator
  const digitExtend = tokens.map((t) => !sheets.some((ix) => matchTerm(ix, t).length));
  const hits: SheetHit[] = [];
  for (const index of sheets) {
    let score = 0;
    const matched: string[] = [];
    let ok = true;
    for (const [i, token] of tokens.entries()) {
      const terms = matchTerm(index, token, digitExtend[i]);
      if (!terms.length) { ok = false; break; }
      let best = 0, bestTerm = terms[0];
      for (const term of terms) {
        const occurrences = index.terms[term] ?? 0;
        const s = occurrences * (term === token ? 4 : 1) * (isCode(term) ? 2 : 1);
        if (s > best) { best = s; bestTerm = term; }
      }
      score += best;
      matched.push(bestTerm);
    }
    if (!ok) continue;
    hits.push({ key: index.key, source: index.source, score, matched });
  }
  const ocr = (h: SheetHit) => (h.source === "ocr" ? 1 : 0);
  // Ties break on the repo's CANONICAL sheet order, not a raw string compare:
  // localeCompare puts "plan.pdf#10" before "plan.pdf#2", and sheetKey.ts exists
  // so every sheet-ordered surface (by-sheet totals, the report, the Marked Set
  // PDF) can never drift apart. Search results are one more such surface.
  return hits.sort((a, b) => ocr(a) - ocr(b) || b.score - a.score || compareSheetKeys(a.key, b.key));
}

/** Drop every page of one file from an index map.
 *
 *  MUST run whenever a file's BYTES change or the file goes away. store.addPdf
 *  keys IndexedDB on the file NAME, so re-adding a reissued A101.pdf overwrites
 *  the old bytes under the very same sheet key — an index entry that isn't
 *  dropped with them keeps answering with the superseded sheet's text, silently.
 *  Reissued sheets are the normal bid cycle here, not an edge case.
 *
 *  Closing a PDF has a second, louder failure if this is skipped: the stale
 *  entries stay searchable, so a hit can name a sheet that is no longer in the
 *  working set and the gallery renders a card for a sheet it cannot load.
 *
 *  Keys are snapshotted before deleting — mutating a Map while iterating its own
 *  live key view is the kind of thing that works until it doesn't. */
export function dropFileFromIndex(map: Map<string, SheetIndex>, file: string): number {
  let dropped = 0;
  for (const key of [...map.keys()]) {
    if (parseSheetKey(key).file === file) { map.delete(key); dropped++; }
  }
  return dropped;
}
