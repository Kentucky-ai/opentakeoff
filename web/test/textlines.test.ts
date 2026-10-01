// textlines — reading-order assembly for the Copy-text marquee. Pure math,
// node:test (the geometry/totals precedent): every case is a token list in,
// a line list out.
import { test } from "node:test";
import { assembleLines, linesToText, MAX_TILT_DEG } from "../src/lib/textlines";
import assert from "node:assert/strict";
import type { Token } from "../src/lib/scheduleParse";
import { wordsToTokens, type OcrWord } from "../src/lib/ocr/types";

// w defaults to 6px a character at h = 10 — roughly a text-layer run's width
const tok = (str: string, x: number, y: number, h = 10, ang?: number, w = str.length * 6): Token =>
  ang === undefined ? { str, x, y, h, w } : { str, x, y, h, w, ang };
const texts = (toks: Token[]) => assembleLines(toks).lines.map((l) => l.text);

test("reading order: lines top→bottom, tokens left→right", () => {
  // deliberately shuffled input; each gap is one space wide
  const toks = [
    tok("world", 46, 100), tok("second", 10, 130), tok("hello", 10, 100), tok("line", 52, 130),
  ];
  const { lines } = assembleLines(toks);
  assert.deepEqual(lines.map((l) => l.text), ["hello world", "second line"]);
  assert.ok(lines[0].y < lines[1].y);
});

test("linesToText joins with newlines, one line per visual row", () => {
  const { lines } = assembleLines([tok("a", 0, 0), tok("b", 0, 40)]);
  assert.equal(linesToText(lines), "a\nb");
});

test("same line: baseline within 0.6·h of the running average", () => {
  // dy = 5, h = 10 → 5 ≤ 6 joins
  assert.deepEqual(texts([tok("a", 0, 100), tok("b", 10, 105)]), ["a b"]);
  // dy = 7 exceeds the tolerance → two lines
  assert.deepEqual(texts([tok("a", 0, 100), tok("b", 10, 107)]), ["a", "b"]);
});

test("a tall token doesn't merge the separate small lines around it", () => {
  // the probe: a and b are two small lines 12px apart; TITLE's baseline falls
  // between them. Measured against the tall token's height all three chain
  // into one line; against the smaller height each stays its own.
  assert.deepEqual(texts([tok("a", 0, 100, 8), tok("TITLE", 100, 106, 20), tok("b", 0, 112, 8)]), ["a", "TITLE", "b"]);
});

test("notes stacked beside a title stay separate lines", () => {
  // a 20px title on the left, three 8px note lines at a 12px pitch to its right
  const toks = [
    tok("FLOOR PLAN", 0, 118, 20, undefined, 200),
    tok("NOTE 1", 300, 100, 8), tok("NOTE 2", 300, 112, 8), tok("NOTE 3", 300, 124, 8),
  ];
  assert.deepEqual(texts(toks), ["NOTE 1", "NOTE 2", "FLOOR PLAN", "NOTE 3"]);
});

test("a mark raised within 0.6·h stays on its line", () => {
  // "FT" then a 6px "2" raised 2.5px (inside 0.6·6 = 3.6); then a 12px word
  // on the same baseline
  const toks = [tok("150", 0, 100), tok("FT", 20, 100), tok("2", 33, 97.5, 6), tok("TOTAL", 40, 100, 12)];
  assert.deepEqual(texts(toks), ["150 FT 2 TOTAL"]);
});

test("known limit: a superscript raised past the tolerance gets its own line", () => {
  // "x²y": a 6px "2" raised 4px, beyond 0.6·6 = 3.6 — emitted above its line
  const toks = [tok("x", 0, 100), tok("2", 6, 96, 6, undefined, 4), tok("y", 12, 100)];
  assert.deepEqual(texts(toks), ["2", "x y"]);
});

test("known limit: a footnote marker raised past the tolerance gets its own line", () => {
  // NOTE¹ SEE: a 6px "1" raised 5px right after NOTE
  const toks = [tok("NOTE", 0, 100), tok("1", 24, 95, 6, undefined, 4), tok("SEE", 34, 100)];
  assert.deepEqual(texts(toks), ["1", "NOTE SEE"]);
});

test("a small line right above a big word keeps its own line", () => {
  // an 8px note whose glyphs [70,78] overlap the top of FLOOR's [76,96], same x
  assert.deepEqual(texts([tok("note", 0, 78, 8), tok("FLOOR", 0, 96, 20)]), ["note", "FLOOR"]);
});

test("a dimension string beside a room name stays on its line", () => {
  // OFFICE 12'-4": a smaller dimension 2px above the name's baseline joins on
  // the baseline tolerance
  const toks = [tok("OFFICE", 0, 100, 12, undefined, 42), tok("12'-4\"", 44, 98, 8, undefined, 30)];
  assert.deepEqual(texts(toks), ["OFFICE 12'-4\""]);
});

// A 30px title with small lines touching its right end
const TITLE30 = tok("FLOOR PLAN", 0, 100, 30, undefined, 150);

test("a two-line subtitle touching a title stays two lines", () => {
  const toks = [TITLE30, tok("SCALE 1/4", 152, 80, 8, undefined, 50), tok("NORTH", 152, 92, 8, undefined, 30)];
  assert.deepEqual(texts(toks), ["SCALE 1/4", "NORTH", "FLOOR PLAN"]);
});

test("notes at an 11px pitch touching a title stay separate lines", () => {
  // 8px notes: each baseline is more than 0.6·8 from the title's and from
  // each other's
  const toks = [TITLE30, tok("A1", 152, 84, 8), tok("A2", 152, 95, 8), tok("A3", 152, 106, 8)];
  assert.deepEqual(texts(toks), ["A1", "A2", "FLOOR PLAN", "A3"]);
});

test("the tall-token probe with notes touching the title", () => {
  // a and b right after TITLE, 6px above and below its baseline: three lines
  const toks = [tok("TITLE", 0, 106, 20, undefined, 100), tok("a", 102, 100, 8), tok("b", 102, 112, 8)];
  assert.deepEqual(texts(toks), ["a", "TITLE", "b"]);
});

test("running average, not the previous token, decides the line", () => {
  // each token 5px below the last (h = 10, tol 6). Against the previous token
  // every step joins and all four chain into one line; against the running
  // average t2 is 7.5px off (avg 102.5) and starts a new line.
  const toks = [0, 1, 2, 3].map((i) => tok(`t${i}`, 10 + i * 14, 100 + i * 5));
  assert.deepEqual(texts(toks), ["t0 t1", "t2 t3"]);
});

test("a gap wider than 2× the line height becomes a TAB", () => {
  // two columns side by side: each row stays split into its cells so a pasted
  // block lands in two spreadsheet columns. Which column is read first is a
  // known limit (rows, not columns) — only the split is asserted here.
  const toks = [tok("CPT-1", 0, 100), tok("CARPET TILE", 200, 100), tok("near", 272, 100)];
  const { lines } = assembleLines(toks);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].text.split("\t"), ["CPT-1", "CARPET TILE near"]);
  // exactly 2× (gap 20 at h = 10) is still a space
  assert.deepEqual(texts([tok("ab", 0, 100), tok("cd", 32, 100)]), ["ab cd"]);
  assert.deepEqual(texts([tok("ab", 0, 100), tok("cd", 33, 100)]), ["ab\tcd"]);
});

test("no TAB when a neighbour's width is only estimated", () => {
  // no w: the gap rests on a guessed width, which can't justify a column split
  const bare = (str: string, x: number): Token => ({ str, x, y: 100, h: 10 });
  assert.deepEqual(texts([bare("A", 0), bare("B", 40)]), ["A B"]);
  assert.deepEqual(texts([tok("A", 0, 100), bare("B", 40)]), ["A B"]);
  // exact twins without a width still read once
  assert.deepEqual(texts([bare("A", 0), bare("A", 0)]), ["A"]);
});

test("a run drawn twice (faux bold) reads once", () => {
  const toks = [tok("WORD", 10, 100), tok("WORD", 10.6, 100.2), tok("NEXT", 40, 100)];
  assert.deepEqual(texts(toks), ["WORD NEXT"]);
  // the same word twice, apart, is two words
  assert.deepEqual(texts([tok("A", 0, 100), tok("A", 12, 100)]), ["A A"]);
});

test("tilt: only near-horizontal runs are kept; the rest are skipped and reported", () => {
  const toks = [
    tok("flat", 0, 100),                    // ang absent (OCR lines) → horizontal
    tok("tilted", 0, 140, 10, 8),           // 8° — inside MAX_TILT_DEG
    tok("under", 0, 160, 10, 352),          // −8°
    tok("vert", 0, 180, 10, 90),            // vertical, reading down
    tok("up", 0, 200, 10, 270),             // vertical, reading up
    tok("angled", 0, 220, 10, 45),
    tok("flipped", 0, 260, 10, 180),        // upside down: not readable prose
    tok("edge", 0, 300, 10, MAX_TILT_DEG),  // exactly at the limit is kept
  ];
  const { lines, skipped } = assembleLines(toks);
  assert.deepEqual(lines.map((l) => l.text), ["flat", "tilted", "under", "edge"]);
  assert.deepEqual(skipped.map((s) => [s.token.str, s.ang]), [["vert", 90], ["up", 270], ["angled", 45], ["flipped", 180]]);
});

test("empty and whitespace-only inputs produce no lines", () => {
  assert.equal(assembleLines([]).lines.length, 0);
  const { lines, skipped } = assembleLines([tok("  ", 0, 0), tok("", 0, 20)]);
  assert.equal(lines.length, 0);
  assert.equal(skipped.length, 0);
});

test("OCR lines: whole-line items with widths group like text-layer runs", () => {
  // #469's engine returns one item per detected LINE, not per word: x the left
  // edge, y the bottom of the ink (a descender sits ~0.25·h below the
  // baseline), w the width. One printed line the detector split in two (a
  // wide word gap) reads back as one line; the line 1.3·h below is its own.
  const words: OcrWord[] = [
    { str: "TYPICAL", x: 118, y: 202.5, w: 60, h: 10, confidence: 0.93 },
    { str: "FLOOR FINISH", x: 10, y: 200, w: 100, h: 9 },
    { str: "ALL ROOMS UNLESS NOTED", x: 10, y: 213, w: 200, h: 10, confidence: 0.88 },
  ];
  const { lines, skipped } = assembleLines(words);
  assert.deepEqual(lines.map((l) => l.text), ["FLOOR FINISH TYPICAL", "ALL ROOMS UNLESS NOTED"]);
  assert.equal(skipped.length, 0);
  // wordsToTokens keeps w, so the same lines come back exactly
  assert.equal(linesToText(assembleLines(wordsToTokens(words)).lines), linesToText(lines));
});

test("an OCR line split by the detector joins with a space, not a TAB", () => {
  // widths measured by the engine: the gap is one word space. Estimated at
  // 0.6·h a character, the first item would end ~50px early and look like a
  // column break.
  const words: OcrWord[] = [
    { str: "GENERAL CONTRACTOR SHALL VERIFY ALL", x: 10, y: 100, w: 262, h: 10 },
    { str: "DIMENSIONS", x: 280, y: 100, w: 76, h: 10 },
  ];
  assert.equal(linesToText(assembleLines(wordsToTokens(words)).lines), "GENERAL CONTRACTOR SHALL VERIFY ALL DIMENSIONS");
});
