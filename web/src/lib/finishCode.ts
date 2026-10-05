// The finish reader's code test (sheetgraph.ts), in a leaf of its own so a
// light module (scheduleRoute.ts, which the canvas loads up front) can ask
// it without loading the sheet graph. sheetgraph.ts imports it from here and
// re-exports it; this is the one copy.

// A finish code: scheduleParse's pattern.
export const CODE_RE = /^[A-Z]{1,4}(-?[A-Z0-9]{1,4})?(\([A-Z0-9]{1,4}\))?$/;
// A letters-only key of four or more letters is a word, not a finish code:
// a section heading or a material word set in the key column (FLOORING,
// BASE, TILE, PAINT). Known cost: a real four-letter code with no digit
// ("EPOX") is not read either — in the sheet graph's whole-sheet index. A
// drawn box (readFinishMarquee) reads a four- or five-letter code as a row
// when the table's layout says it is one, and reports it as skipped when it
// can't tell (#483, bandDataRows).
// A parenthesized word of three or more letters is a qualifier, not a code
// suffix: CPT-1 (TYP) is CPT-1 with a note, FTB-01 (CUT) (C) keeps CUT in the
// description, and CPT-1 (ALT) keeps its old alternate rule. A suffix of one
// or two letters, or one with a digit, belongs to the code: G-01(C), FT-02(E),
// ACT-1(2X2) (USER_GUIDE "Codes with a word after them").
const QUALIFIER_SUFFIX_RE = /\([A-Z]{3,}\)$/;
export const finishCodeOk = (p: string): boolean => !/^[A-Z]{4,}(\([A-Z0-9]{1,4}\))?$/.test(p) && CODE_RE.test(p)
  && !QUALIFIER_SUFFIX_RE.test(p);

/** A finish key cell's text the way the reader keys it, upper-cased in:
 * a parenthesized qualifier word unwraps and glues on as it did before #499
 * (PT-1 (CUT) → PT-1CUT, CPT-1 (TYP) → CPT-1TYP), and a parenthesis with no
 * partner is dropped, as it was before #499 (FT-0B(C → FT-0BC), so the row
 * keeps its own code instead of folding into the row above. Code suffixes
 * keep their parentheses. Spaces stay for the caller to strip. */
export function finishKeyText(upper: string): string {
  // a trailing period is an abbreviation's (TYP.), still a word
  return upper.replace(/\(\s*([A-Z]{3,})\.?\s*\)/g, "$1").split("/").map((part) => {
    const open = (part.match(/\(/g) || []).length, close = (part.match(/\)/g) || []).length;
    return open === close ? part : part.replace(/[()]/g, "");
  }).join("/");
}

/** Identity for an edited/imported tag. Only a complete finish code's
 * parenthesized suffix loses spacing; custom condition names keep their
 * spaces. G-01(C) and G-01C remain distinct identities. */
export function normalizeFinishTag(raw: string): string {
  const tag = (raw || "").trim().replace(/\s+/g, " ").toUpperCase();
  return tag.split("/").map((part) => {
    const compact = part.trim().replace(/\s*\(\s*([A-Z0-9]{1,4})\s*\)$/, "($1)");
    return compact.includes("(") && finishCodeOk(compact) ? compact : part;
  }).join("/");
}

/** A possible pre-#499 import, not an identity alias: the old reader removed
 * parentheses. Only the incoming parenthesized form checks its flattened
 * spelling. Callers must ask for review, never rename or merge the existing
 * condition: it may legitimately be a different code. */
export function legacyFinishTag(raw: string, existing: Iterable<string>): string | undefined {
  const tag = normalizeFinishTag(raw);
  if (!tag.includes("(") || !tag.split("/").every(finishCodeOk)) return;
  const flat = tag.replace(/[()]/g, "");
  for (const candidate of existing) if (normalizeFinishTag(candidate) === flat) return candidate;
}
