// Import from schedule: is an imported code on the plans at all? (#498)
//
// A misread code that still looks valid (S-1 for ST-1, P-110 for P-1) imports
// with nothing to question it. This asks the plan-search index whether the
// code is printed on any sheet other than the schedule's own, and says how
// much of the set it could check. It is information for the estimator, never
// a reason to untick a row.
//
// Pure, DOM-free, pdfjs-free, like planIndex.ts / planSearch.ts, whose index
// it reads. It does NOT go through searchPlan: gallery search is built for a
// person typing, so CPT-1 also finds CPT-1A, and finds CPT-12 when no sheet
// has CPT-1 itself. Here identities are compared exactly, and the near codes
// are reported apart as "similar", never as an occurrence.
//
// What it can and can't say:
//   found      the exact code is in some sheet's index, text layer or OCR
//              (each sheet says which, the way search badges a hit)
//   not-found  every sheet was checked and none has it: "not found in
//              checked text", never "unused" — text a reader can't see
//              (a code drawn as linework, a block attribute) isn't indexed
//   unchecked  not found so far, and some sheets haven't been checked: not
//              indexed yet, a scan or a picture not read, pictures not
//              measured, a file whose pages aren't counted yet. Also a code
//              the index can't hold at all (a one-letter C): `uncheckable`
import { isCode, isHybrid, isScan, isSearchable, normalizeTerm, type IndexSource, type SheetIndex } from "./planIndex";
import { needsRead } from "./planSearch";
import { isStitchKey } from "./stitches";

export interface CodeUseSet {
  indexes: ReadonlyMap<string, SheetIndex>;
  /** every sheet key in the plan set, in set order */
  keys: readonly string[];
  /** files whose page count isn't known yet: each holds at least one sheet
   *  nobody has checked */
  unknownFiles?: number;
  /** the schedule's own sheet. Excluded by SHEET key, not by file: the
   *  finish plan may be the next page of the same PDF. */
  sourceKey: string;
  /** the imported box's own terms, built from the same text layer the
   *  source sheet's entry was (buildSheetIndex over extractRegionText of the
   *  box). With them, an occurrence on the schedule's sheet beyond what the
   *  box holds is found there, and the rest of that sheet counts as checked:
   *  a one-sheet set whose finish plan carries its own legend. */
  boxTerms?: Readonly<Record<string, number>>;
}

export interface CodeUse {
  state: "found" | "not-found" | "unchecked";
  /** sheets printing the code itself, with where the text came from;
   *  `outsideBox` marks the schedule's own sheet (found beyond the box) */
  found: { key: string; source: IndexSource; outsideBox?: true }[];
  /** code-shaped terms on other sheets that only resemble it (a digit or
   *  letter more, no hyphen, the base of a suffixed code), sorted */
  similar: string[];
  /** sheets whose text was checked (the schedule's counts only with boxTerms) */
  checked: number;
  /** sheets that could still hold the code */
  unchecked: number;
  /** the index never keeps a term like this one (planIndex isSearchable:
   *  one- and two-letter words), so no sheet can be checked for it */
  uncheckable?: true;
}

/** The index terms that ARE this code. normalizeTerm strips end punctuation,
 *  so a tight G-01(C) on a plan is the term "G-01(C"; a spaced G-01 (C)
 *  loses its one-letter suffix to the index and can't be told from G-01 (W). */
function exactTerms(code: string): string[] {
  const t = normalizeTerm(code);
  const m = /^(.+)\(([A-Z0-9]{1,4})\)$/.exec(code);
  return m ? [...new Set([t, `${m[1]}(${m[2]}`])] : t ? [t] : [];
}

/** The code with no suffix, for "similar": G-01(C) → G-01. */
function baseOf(code: string): string {
  return code.replace(/\([A-Z0-9]{1,4}\)$/, "");
}

const flat = (s: string) => s.replace(/-/g, "");

/** A term that looks like the code without being it: same letters and digits
 *  with more after (CPT-12, CPT-1A, P-110), the same with or without a hyphen
 *  (P1), or a suffixed code's bare base (G-01). Code-shaped terms only. */
function resembles(code: string, term: string): boolean {
  if (!isCode(term)) return false;
  const base = baseOf(code);
  if (base !== code && term === base) return true;
  return flat(term).startsWith(flat(base));
}

/** Is this sheet's text fully checked? Not when it is a scan or hybrid with
 *  no read (planSearch needsRead), or a text entry whose pictures were never
 *  measured or failed to measure: a picture there could print the code. */
function covered(ix: SheetIndex): boolean {
  if (ix.seeded || needsRead(ix)) return false;
  if (ix.source === "ocr") return true;
  return isScan(ix) || isHybrid(ix) || Array.isArray(ix.pictures);
}

/** Text or OCR for one found term, the way searchPlan badges a hit: a
 *  hybrid's read keeps its text layer's own terms in `stray`. */
function sourceOf(ix: SheetIndex, term: string): IndexSource {
  return ix.source === "ocr" && ix.textLayer === true && (ix.stray?.[term] ?? 0) > 0 ? "text" : ix.source;
}

export function codeUse(rawCode: string, set: CodeUseSet): CodeUse {
  const code = (rawCode || "").trim().replace(/\s+/g, " ").toUpperCase();
  const terms = exactTerms(code);
  const found: CodeUse["found"] = [];
  const similar = new Set<string>();
  let checked = 0;
  let unchecked = set.unknownFiles ?? 0;
  if (!terms.length) return { state: "unchecked", found, similar: [], checked, unchecked };
  if (!terms.some(isSearchable)) return { state: "unchecked", found, similar: [], checked, unchecked: 0, uncheckable: true };
  for (const key of set.keys) {
    if (isStitchKey(key)) continue;
    const ix = set.indexes.get(key);
    if (key === set.sourceKey) {
      // only the part of the sheet outside the box is evidence, and only
      // when the box was read from the same text layer the entry holds
      if (!ix || !set.boxTerms || ix.source !== "text" || ix.seeded || isScan(ix)) continue;
      const hit = terms.find((t) => (ix.terms[t] ?? 0) > (set.boxTerms![t] ?? 0));
      if (hit) found.push({ key, source: "text", outsideBox: true });
      else if (covered(ix)) checked++;
      continue;
    }
    if (!ix || ix.seeded) { unchecked++; continue; }
    const hit = terms.find((t) => (ix.terms[t] ?? 0) > 0);
    if (hit) { found.push({ key, source: sourceOf(ix, hit) }); continue; }
    for (const t in ix.terms) if (!terms.includes(t) && resembles(code, t)) similar.add(t);
    if (covered(ix)) checked++;
    else unchecked++;
  }
  const state = found.length ? "found" : unchecked || !checked ? "unchecked" : "not-found";
  return { state, found, similar: [...similar].sort(), checked, unchecked };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** What the dialog's row shows (`text`) and its tooltip (`title`). Sheet keys
 *  go through `labelOf` (the canvas's tab label) for the tooltip. */
export function codeUseLine(u: CodeUse, labelOf: (key: string) => string = (k) => k): { text: string; title: string } {
  if (u.uncheckable) return { text: "can't check", title: "Plan search doesn't keep one- and two-letter words, so this code can't be looked up on the plans." };
  const like = u.similar.length ? ` Similar codes on the plans: ${u.similar.slice(0, 4).join(", ")}${u.similar.length > 4 ? ", …" : ""}.` : "";
  if (u.state === "found") {
    const where = u.found.map((f) => `${labelOf(f.key)}${f.outsideBox ? " (the schedule's sheet, outside the box)" : f.source === "ocr" ? " (OCR)" : ""}`).join(", ");
    return { text: `on ${plural(u.found.length, "sheet")}`, title: `Printed on ${where}.` };
  }
  if (u.state === "not-found") {
    return { text: "not found in checked text", title: `Not in the text of ${plural(u.checked, "sheet")} checked, outside the schedule. Check the code against the schedule.${like}` };
  }
  return {
    text: u.unchecked ? `${plural(u.unchecked, "sheet")} not checked` : "nothing to check against",
    title: `Not found in ${plural(u.checked, "sheet")} checked so far.${u.unchecked ? " Sheets not opened or indexed yet, and scans or pictures not read, aren't checked." : ""}${like}`,
  };
}
