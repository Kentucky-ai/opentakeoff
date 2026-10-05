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
// Existing reader qualifiers are words, even when parenthesized. Keep
// FTB-01 (CUT) (C) in the description and CPT-1 (ALT)'s old alternate rule.
export const FINISH_QUALIFIER_WORDS = new Set(["CUT", "COVE", "SAT", "ALT", "OPT", "OPTION", "ADD", "DEDUCT"]);
export const finishCodeOk = (p: string): boolean => !/^[A-Z]{4,}(\([A-Z0-9]{1,4}\))?$/.test(p) && CODE_RE.test(p)
  && !FINISH_QUALIFIER_WORDS.has(p.match(/\(([^()]+)\)$/)?.[1] ?? "");

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
