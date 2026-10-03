// OCR border glyphs (#482). A schedule's cell rules sit a couple of points
// from the text, and the on-device reader reads a rule beside a word as part
// of it: "[P-1", "V2_", "|ACT-2", "P-1]". A rule glued to a key cell keeps
// the code from reading ("[P-1 SAT" keys as P-1SAT, "[FTB-01 CUT (C)" is no
// row), and Copy text and search carry the glyph. Some fonts also read a
// hyphen as U+2212 MINUS ("PT−01"), which the finish reader drops, keying
// PT01.
//
// cleanOcrText cleans one read line (a seam line: a cell, which may hold
// several words) at its start and end only; an "_" or "[" inside the line is
// printed text. It runs after seams.ts has joined the tiles, never in the
// worker: seams estimates a character's width from the box's width over the
// string's length, so a glyph stripped from a box that keeps its width would
// skew the joins. Idempotent, so a cached read cleaned again is unchanged.
//
// A leaf with no imports: pageCache.ts, itself a leaf, cleans every hit.

// a dash that is the same glyph as "-" in another code point: U+2010
// HYPHEN, U+2011 NON-BREAKING HYPHEN, U+2013 EN DASH, U+2212 MINUS SIGN
// (a capture group, not a lookbehind: Safari before 16.4 rejects lookbehind
// at parse time, and this module loads with the canvas through pageCache.ts;
// the lookahead leaves the next letter unconsumed, so A−B−C all converts)
const DASH_LIKE = /([\p{L}\p{N}])[\u2010\u2011\u2013\u2212](?=[\p{L}\p{N}])/gu;

const count = (s: string, c: string) => s.split(c).length - 1;
// a "[" glued to a code: letters, an optional hyphen, a digit
const CODE_OPEN = /^\[[A-Z]{1,5}-?\d/i;

/** The line is one bracket pair around everything: its first "[" closes at
 * its last character ("[P-1] [P-2]" is two pairs). */
function outerPair(s: string): boolean {
  if (!s.startsWith("[") || !s.endsWith("]")) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "[") depth++;
    else if (s[i] === "]" && --depth === 0) return i === s.length - 1;
  }
  return false;
}

/** One pass of the edge rules; cleanOcrText repeats it until nothing
 * changes ("P-1_]": the "]" goes, then the "_" it hid). */
function cleanEdges(s: string): string {
  s = s.trim();
  // a leading "|", or a leading "[" the line has no "]" for: brackets are
  // counted over the whole line, so a printed "[E]", "[SEE NOTE 3]" or
  // "[NOTE 2] P-1" keeps them, and "[P-1 SEE NOTE [2]" loses only the first
  while (s.startsWith("|") || (s.startsWith("[") && count(s, "[") > count(s, "]"))) s = s.slice(1).trimStart();
  s = s.replace(/[_|]+$/, "").trimEnd();
  // a trailing "]" the line has no "[" for ("P-1 [NOTE 2]" keeps it)
  if (s.endsWith("]") && count(s, "]") > count(s, "[")) s = s.slice(0, -1).trimEnd();
  // ruling read on both sides of the cell balances, so it is told by its
  // shape: one pair around the whole line, glued to a code ("[P-1 SAT]") or
  // with a space just inside it ("[ P-1 ]", "[P-1 ]"). A printed "[E]" or
  // "[SEE NOTE 3]" has neither.
  if (outerPair(s) && (CODE_OPEN.test(s) || /^\[\s|\s\]$/.test(s))) s = s.slice(1, -1).trim();
  return s;
}

/** A read line with the ruling cleaned off its ends and a minus look-alike
 * between two letters or digits read as "-"; "" when nothing is left (the
 * caller drops the line). "$" is never changed here: a "$" read for an "S"
 * belongs to a finish code, and only the schedule reader knows it is one. */
export function cleanOcrText(str: string): string {
  let s = str.replace(DASH_LIKE, "$1-");
  for (let prev = ""; prev !== s;) { prev = s; s = cleanEdges(s); }
  return s;
}

// ── a finish code's misread letters ──────────────────────────────────────────
// The finish reader's code test allows letters after the hyphen, so PT-O1
// (an O read for a 0) is a code to it. On an OCR read the schedule
// reader repairs the run after the hyphen, and a "$" read for a leading "S"
// ($SM-1, which the reader keys SM-1). Each repair is reported (readAs), so
// the dialog shows the code as read beside the code imported.

/** The finish reader's key normalisation (sheetgraph.ts rowKeyOf). */
const keyNorm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9/-]/g, "");
// letters, a hyphen, a run of digits read with O and I among them, and at
// most one letter after the run (FT-O2E). Two letters or more after it are
// a word glued on (CPT-1OPT), and a letter-led run a code (WD-OAK1).
const MISREAD_PART = /^([A-Z]{1,4})-([0-9OI]+)([A-Z]?)$/;

/** One part of a code (between "/"s) with O read as 0 and I as 1 in the run
 * after the hyphen, when the run holds at least one digit: a run of letters
 * only (PT-I, T-II, B-OO) could be printed so, and is left. L is never read
 * as 1: a 1L suffix is printed (PT-1L). */
function repairPart(p: string): string {
  const m = MISREAD_PART.exec(p);
  if (!m || !/\d/.test(m[2])) return p;
  return `${m[1]}-${m[2].replace(/O/g, "0").replace(/I/g, "1")}${m[3]}`;
}

/** `key` (the row's code as the finish reader keyed it) repaired for an OCR
 * read, given the raw key cell it was read from. A "$" leading the cell's
 * first word (two characters or more once keyed) is an S when the code as
 * keyed is that word ($SM-1 keyed SM-1), or starts with it and the cell has
 * more after the word (SM-1C from "$SM-1 (C)", SM-1SAT from "$SM-1 SAT"). readAs, set only when the code
 * changed, is the cell's first word as read (uppercased, a trailing ":", ","
 * or ";" dropped) when the $ was repaired or the word is the whole code, else
 * the code as keyed ("CPT-O1 / VIN-1"). A part with no hyphen (BO1) is
 * ambiguous and left alone. */
export function repairKey(rawKeyCell: string, key: string): { key: string; readAs?: string } {
  const w1 = (rawKeyCell.trim().split(/\s/)[0] ?? "").toUpperCase().replace(/^[[|]+/, "").replace(/[:,;]+$/, "");
  const w1Key = keyNorm(w1);
  // the $ first: it is checked against the code as keyed, before any O→0.
  // The key is the first word, or starts with it and the cell goes on after
  // the word (its qualifier keyed on: "$SM-1 (C)" → SM-1C): never a key the
  // first word is only the start of ("$SM-1" against SM-10), and never a
  // one-letter word ("$S")
  const more = /\s\S/.test(rawKeyCell.trim());
  const dollar = /^\$[A-Z]/.test(w1) && w1Key.length >= 2 && (key === w1Key || (more && key.startsWith(w1Key)));
  let out = dollar ? "S" + key : key;
  out = out.split("/").map(repairPart).join("/");
  if (out === key) return { key };
  return { key: out, readAs: dollar || w1Key === key ? w1 : key };
}
