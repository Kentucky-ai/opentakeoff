// Finish-schedule section headings — the printed band a materials / finish
// schedule sets above a group of rows ("FLOORING", "WALL BASE", "MISC.
// FINISHES"). The sheet graph reads a heading row against this vocabulary and
// stores the matched entry as TableRow.section.
//
// Only what a schedule actually prints as a section title belongs here. A
// material or surface word ("CARPET", "TILE", "PAINT") is not a section
// heading — a band reading "TILE" says nothing about whether the rows under it
// are floor or wall — so those words are not in the vocabulary, and a row
// under such a band has no section.

/** The heading entries, canonical spelling. A heading matches on its FIRST
 * word, or on a longer phrase that starts the heading ("WALL BASE" wins over
 * "WALL"). */
export const FINISH_SECTION_HEADINGS = [
  "FLOORING", "FLOORS", "FLOOR", "FLOOR FINISHES",
  "BASE", "BASES", "WALL BASE",
  "WALLS", "WALL", "WALL FINISHES",
  "WALL PROTECTION",
  "TRANSITIONS", "TRANSITION", "TRIM",
  "CEILINGS", "CEILING",
  "MILLWORK",
  "MISC", "ACCESSORIES",
] as const;
export type FinishSection = (typeof FINISH_SECTION_HEADINGS)[number];

const PHRASES = FINISH_SECTION_HEADINGS.filter((h) => h.includes(" "))
  .map((h) => ({ h, words: h.split(" ") }))
  .sort((a, b) => b.words.length - a.words.length || b.h.length - a.h.length);
const WORDS = new Set<string>(FINISH_SECTION_HEADINGS.filter((h) => !h.includes(" ")));

/** The vocabulary entry a heading's text starts with, or null. Words are
 * compared with punctuation stripped ("MISC. FINISHES" → MISC, "FLOORING
 * (SEE NOTE 2)" → FLOORING); the longest phrase wins. A first word with a
 * hyphen or a digit ("BASE-1", "BASE1") is a code, never a heading. */
export function finishSectionOf(text: string): FinishSection | null {
  const words = (text || "").trim().toUpperCase().split(/\s+/);
  if (!words[0] || /[-\d]/.test(words[0])) return null;
  const clean = words.map((w) => w.replace(/[^A-Z]/g, ""));
  for (const p of PHRASES) if (p.words.every((w, i) => clean[i] === w)) return p.h;
  return WORDS.has(clean[0]) ? (clean[0] as FinishSection) : null;
}
