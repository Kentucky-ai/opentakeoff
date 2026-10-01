// Plan search index tests — planIndex.ts is pure (no DOM, no pdf.js), so it runs
// straight under node. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTerm, splitRun, expandTerm, isCode, isSearchable, buildSheetIndex, matchTerm,
  searchPlan, dropFileFromIndex, MIN_TERM_LEN, carriesText, indexIsScanLike, SCAN_MAX_TEXT_LINES,
  type IndexedTextItem, type SheetIndex,
} from "../src/lib/planIndex.ts";

// a sheet's worth of text runs — the `str` of what extractRegionText hands back
const runs = (...strs: string[]): IndexedTextItem[] => strs.map((str) => ({ str }));

// ── normalizeTerm ───────────────────────────────────────────────────────────

test("normalizeTerm: upper-cases and strips punctuation at the ENDS only", () => {
  assert.equal(normalizeTerm("corridor"), "CORRIDOR");
  assert.equal(normalizeTerm("(CPT-1)"), "CPT-1");
  assert.equal(normalizeTerm("ROOM,"), "ROOM");
  assert.equal(normalizeTerm("…101."), "101");
});

test("normalizeTerm: interior separators survive — they ARE the plan vocabulary", () => {
  // stripping these globally would shred exactly what this index exists to find
  assert.equal(normalizeTerm("CPT-1"), "CPT-1");
  assert.equal(normalizeTerm("S1.1"), "S1.1");
  assert.equal(normalizeTerm("PT-1/PT-2"), "PT-1/PT-2");
});

test("normalizeTerm: punctuation-only and empty input yield no term", () => {
  assert.equal(normalizeTerm("—"), "");
  assert.equal(normalizeTerm("..."), "");
  assert.equal(normalizeTerm(""), "");
  assert.equal(normalizeTerm(undefined as unknown as string), "");
});

test("normalizeTerm: accented letters are letters, not end punctuation", () => {
  assert.equal(normalizeTerm("CAFÉ"), "CAFÉ");
  assert.equal(normalizeTerm("café."), "CAFÉ");
  assert.equal(normalizeTerm("«ÉTAGE»"), "ÉTAGE");
});

test("searchPlan: an accented word is findable as typed", () => {
  const ix = buildSheetIndex("A101.pdf", runs("CAFÉ SEATING"));
  const hits = searchPlan([ix], "café");
  assert.deepEqual(hits.map((h) => h.key), ["A101.pdf"]);
  assert.deepEqual(hits[0].matched, ["CAFÉ"], "the chip shows the word as drawn, not CAF");
});

// ── term classification ─────────────────────────────────────────────────────

test("isCode: finish tags, room numbers, and sheet numbers all qualify", () => {
  for (const t of ["CPT-1", "LVT3", "P-1", "ACT-2", "PT-2A"]) assert.ok(isCode(t), t);
  for (const t of ["101", "139A", "12"]) assert.ok(isCode(t), t);
  for (const t of ["A101", "A-101", "S1.1", "AF101"]) assert.ok(isCode(t), t);
  for (const t of ["CORRIDOR", "THE", "X"]) assert.equal(isCode(t), false, t);
});

test("isSearchable: codes bypass the length floor, crumbs do not", () => {
  assert.ok(isSearchable("P-1"));              // 3 chars, but a real tag
  assert.ok(isSearchable("101"));              // room number
  assert.ok(isSearchable("CORRIDOR"));
  assert.equal(isSearchable("1"), false);      // list numbering
  assert.equal(isSearchable("W"), false);      // stray dimension letter
  assert.equal("AB".length < MIN_TERM_LEN, true);
  assert.equal(isSearchable("AB"), false);
});

// ── buildSheetIndex ─────────────────────────────────────────────────────────

test("buildSheetIndex: splits multi-word runs and counts each term", () => {
  const ix = buildSheetIndex("A101.pdf", runs("PATIENT ROOM", "139A", "ROOM"));
  assert.deepEqual(ix.terms, { PATIENT: 1, ROOM: 2, "139A": 1 });
});

test("buildSheetIndex: unsearchable tokens are counted but not indexed", () => {
  const ix = buildSheetIndex("A101.pdf", runs("1. GENERAL", "W"));
  assert.deepEqual(Object.keys(ix.terms), ["GENERAL"]);
  assert.equal(ix.tokenCount, 3, "tokenCount is the honest denominator, incl. dropped");
});

test("buildSheetIndex: occurrences are counted in full, not capped", () => {
  const ix = buildSheetIndex("A101.pdf", runs(...Array.from({ length: 50 }, () => "CORRIDOR")));
  assert.equal(ix.terms.CORRIDOR, 50);
  assert.equal(ix.tokenCount, 50);
});

test("buildSheetIndex: empty/whitespace input yields an empty but valid index", () => {
  const ix = buildSheetIndex("blank.pdf", runs("", "   "));
  assert.deepEqual(ix.terms, {});
  assert.equal(ix.tokenCount, 0);
  assert.equal(ix.source, "text");
});

test("buildSheetIndex: carries only key, source, terms, tokenCount and lineCount", () => {
  const ix = buildSheetIndex("A101.pdf", runs("CPT-1"), "ocr");
  assert.deepEqual(ix, { key: "A101.pdf", source: "ocr", terms: { "CPT-1": 1 }, tokenCount: 1, lineCount: 1 });
});

// ── expandTerm: compound callouts ───────────────────────────────────────────

test("expandTerm: a '/'-joined callout is findable by EITHER half and as drawn", () => {
  assert.deepEqual(expandTerm("PT-1/PT-2"), ["PT-1/PT-2", "PT-1", "PT-2"]);
  assert.deepEqual(expandTerm("CPT-1,LVT-2"), ["CPT-1,LVT-2", "CPT-1", "LVT-2"]);
});

test("expandTerm: '-' and '.' never split — they are internal to single codes", () => {
  assert.deepEqual(expandTerm("CPT-1"), ["CPT-1"]);
  assert.deepEqual(expandTerm("S1.1"), ["S1.1"]);
  assert.deepEqual(expandTerm("A-101"), ["A-101"]);
});

test("searchPlan: the right-hand half of a compound callout is findable", () => {
  // regression: "PT-1/PT-2" used to index whole, so PT-2 silently missed a
  // sheet that plainly specifies it. Verified present on demo/sample-finish-plan.pdf.
  const ix = buildSheetIndex("A601.pdf", runs("PT-1/PT-2"));
  assert.deepEqual(searchPlan([ix], "PT-2").map((h) => h.key), ["A601.pdf"]);
  assert.deepEqual(searchPlan([ix], "PT-1").map((h) => h.key), ["A601.pdf"]);
  assert.deepEqual(searchPlan([ix], "PT-1/PT-2").map((h) => h.key), ["A601.pdf"], "still matches as drawn");
});

test("buildSheetIndex: tokenCount counts tokens as DRAWN, not expanded terms", () => {
  const ix = buildSheetIndex("x", runs("PT-1/PT-2"));
  assert.equal(ix.tokenCount, 1);
  assert.equal(Object.keys(ix.terms).length, 3);
});

// ── matchTerm ───────────────────────────────────────────────────────────────

test("matchTerm: an exact hit short-circuits the prefix sweep", () => {
  const ix = buildSheetIndex("a", runs("CPT-1 CPT-10 CPT-11"));
  assert.deepEqual(matchTerm(ix, "CPT-1"), ["CPT-1"], "exact wins alone");
  assert.deepEqual(matchTerm(ix, "CPT").sort(), ["CPT-1", "CPT-10", "CPT-11"]);
  assert.deepEqual(matchTerm(ix, "ZZZ"), []);
});

test("matchTerm: by default a complete code never prefix-matches a longer code", () => {
  // CPT-1 and CPT-10 are different finishes; a sheet with only CPT-10 must not
  // answer a search for CPT-1 while another sheet has CPT-1 itself
  const ix = buildSheetIndex("a", runs("CPT-10 CPT-11 A1010 1010"));
  assert.deepEqual(matchTerm(ix, "CPT-1"), []);
  assert.deepEqual(matchTerm(ix, "A101"), []);
  assert.deepEqual(matchTerm(ix, "101"), []);
});

test("matchTerm: with digit extension allowed, a code prefix-matches longer codes", () => {
  // searchPlan's fallback when no sheet has the code itself
  const ix = buildSheetIndex("a", runs("CPT-10 CPT-11 A1010 1010"));
  assert.deepEqual(matchTerm(ix, "CPT-1", true).sort(), ["CPT-10", "CPT-11"]);
  assert.deepEqual(matchTerm(ix, "A101", true), ["A1010"]);
  assert.deepEqual(matchTerm(ix, "101", true), ["1010"]);
});

test("matchTerm: a complete code still matches its letter-suffixed variants", () => {
  // CPT-1A is a variant of CPT-1, as 139A is of room 139
  const ix = buildSheetIndex("a", runs("CPT-1A CPT-1B CPT-10 139A"));
  assert.deepEqual(matchTerm(ix, "CPT-1").sort(), ["CPT-1A", "CPT-1B"]);
  assert.deepEqual(matchTerm(ix, "139"), ["139A"]);
});

// ── searchPlan ──────────────────────────────────────────────────────────────

const A = buildSheetIndex("A101.pdf", runs("CORRIDOR", "CPT-1", "CPT-1"));
const B = buildSheetIndex("A102.pdf", runs("CORRIDOR", "LVT-2"));
const C = buildSheetIndex("A103.pdf", runs("LOBBY"));

test("searchPlan: an empty or punctuation-only query matches nothing", () => {
  assert.deepEqual(searchPlan([A, B, C], ""), []);
  assert.deepEqual(searchPlan([A, B, C], "   "), []);
  assert.deepEqual(searchPlan([A, B, C], "-—-"), []);
});

test("searchPlan: multi-token queries are AND, not OR", () => {
  // OR would return the whole set for any common word, exactly at the set size
  // where narrowing is the point
  const hits = searchPlan([A, B, C], "corridor cpt-1");
  assert.deepEqual(hits.map((h) => h.key), ["A101.pdf"]);
  const none = searchPlan([A, B, C], "corridor lobby");
  assert.deepEqual(none, []);
});

test("searchPlan: query is case- and punctuation-insensitive", () => {
  assert.deepEqual(searchPlan([A, B, C], "cpt-1").map((h) => h.key), ["A101.pdf"]);
  assert.deepEqual(searchPlan([A, B, C], "(CPT-1)").map((h) => h.key), ["A101.pdf"]);
});

test("searchPlan: prefix search finds the half-typed code", () => {
  const hits = searchPlan([A, B, C], "cpt");
  assert.deepEqual(hits.map((h) => h.key), ["A101.pdf"]);
  assert.deepEqual(hits[0].matched, ["CPT-1"]);
});

test("searchPlan: a hit says what each query token matched, in query order", () => {
  const [hit] = searchPlan([A], "corr cpt");
  assert.deepEqual(hit.matched, ["CORRIDOR", "CPT-1"]);
  assert.equal(hit.source, "text");
});

test("searchPlan: a complete code does not find a sheet that only has a longer one", () => {
  const ten = buildSheetIndex("ten.pdf", runs("CPT-10 CPT-10 CPT-10"));
  const one = buildSheetIndex("one.pdf", runs("CPT-1"));
  assert.deepEqual(searchPlan([ten, one], "CPT-1").map((h) => h.key), ["one.pdf"]);
});

test("searchPlan: a letter-suffixed variant also keeps the longer code out", () => {
  const variant = buildSheetIndex("variant.pdf", runs("CPT-1A"));
  const ten = buildSheetIndex("ten.pdf", runs("CPT-10"));
  const hits = searchPlan([ten, variant], "CPT-1");
  assert.deepEqual(hits.map((h) => h.key), ["variant.pdf"]);
  assert.deepEqual(hits[0].matched, ["CPT-1A"]);
});

test("searchPlan: typing a room number shows results at every keystroke", () => {
  // no sheet has 1 or 10, so those fall back to digit-extended matches
  const room = buildSheetIndex("room.pdf", runs("101"));
  for (const q of ["1", "10", "101"]) {
    assert.deepEqual(searchPlan([room], q).map((h) => h.key), ["room.pdf"], q);
  }
});

test("searchPlan: typing a sheet number shows results at every keystroke", () => {
  const sheet = buildSheetIndex("sheet.pdf", runs("A101"));
  for (const q of ["A", "A1", "A10", "A101"]) {
    assert.deepEqual(searchPlan([sheet], q).map((h) => h.key), ["sheet.pdf"], q);
  }
});

test("searchPlan: a half-typed tag falls back to the longer tag, and says so", () => {
  // on the way to CPT-12; the chip shows CPT-12, so the match isn't passed off as exact
  const twelve = buildSheetIndex("twelve.pdf", runs("CPT-12"));
  const hits = searchPlan([twelve], "CPT-1");
  assert.deepEqual(hits.map((h) => h.key), ["twelve.pdf"]);
  assert.deepEqual(hits[0].matched, ["CPT-12"]);
});

test("searchPlan: the fallback works per token inside a multi-token query", () => {
  const room = buildSheetIndex("room.pdf", runs("ROOM", "101"));
  assert.deepEqual(searchPlan([room], "room 10").map((h) => h.key), ["room.pdf"]);
});

test("searchPlan: the fallback is decided across the set, from an iterator too", () => {
  // map.values() is single-use; the set-wide pass must not exhaust it
  const map = new Map<string, SheetIndex>([
    ["ten.pdf", buildSheetIndex("ten.pdf", runs("CPT-10"))],
    ["one.pdf", buildSheetIndex("one.pdf", runs("CPT-1"))],
  ]);
  assert.deepEqual(searchPlan(map.values(), "CPT-1").map((h) => h.key), ["one.pdf"]);
  assert.deepEqual(searchPlan(new Map([...map].slice(0, 1)).values(), "CPT-1").map((h) => h.key), ["ten.pdf"]);
});

test("searchPlan: equal occurrences tie, and the tie breaks on key", () => {
  const hits = searchPlan([B, A], "corridor");
  assert.deepEqual(hits.map((h) => h.key), ["A101.pdf", "A102.pdf"]);
  assert.equal(hits[0].score, hits[1].score);
});

test("searchPlan: an EXACT term outranks a prefix-only match on another sheet", () => {
  // pins the x4 exact bonus. A prose query, since a code query drops the
  // digit-extended CPT-10 sheet outright once another sheet has CPT-1.
  const exact = buildSheetIndex("exact.pdf", runs("LOBBY"));
  const prefixOnly = buildSheetIndex("prefix.pdf", runs("LOBBYIST LOBBYING LOBBYISTS"));
  assert.deepEqual(searchPlan([prefixOnly, exact], "LOBBY").map((h) => h.key), ["exact.pdf", "prefix.pdf"]);
});

test("searchPlan: an EXACT hit outranks a prefix hit that has the code bonus", () => {
  // Exact ×4 beats a code prefix's ×2, and the exact sheet sorts after the
  // other by key, so only the score can put it first.
  const exact = buildSheetIndex("A102.pdf", runs("CPT"));
  const coded = buildSheetIndex("A101.pdf", runs("CPT-1A"));
  const hits = searchPlan([coded, exact], "cpt");
  assert.deepEqual(hits.map((h) => h.key), ["A102.pdf", "A101.pdf"]);
  assert.ok(hits[0].score > hits[1].score);
});

test("searchPlan: a CODE outranks prose at equal occurrence count", () => {
  // pins the x2 code bonus
  const code = buildSheetIndex("code.pdf", runs("ACT-1"));
  const prose = buildSheetIndex("prose.pdf", runs("ACTUAL"));
  const hits = searchPlan([prose, code], "ACT");
  assert.deepEqual(hits.map((h) => h.key), ["code.pdf", "prose.pdf"]);
  assert.ok(hits[0].score > hits[1].score);
});

test("searchPlan: occurrence count orders equal-kind terms", () => {
  const many = buildSheetIndex("many.pdf", runs("LOBBY", "LOBBY", "LOBBY"));
  const one = buildSheetIndex("one.pdf", runs("LOBBY"));
  const hits = searchPlan([one, many], "LOBBY");
  assert.deepEqual(hits.map((h) => h.key), ["many.pdf", "one.pdf"]);
  assert.ok(hits[0].score > hits[1].score);
});

test("searchPlan: every text-layer hit ranks above every OCR hit, whatever the score", () => {
  // the OCR sheet says CORRIDOR three times, the text sheet once — the text sheet
  // still comes first, because its match is read from the PDF, not guessed
  const scanned = buildSheetIndex("A200.pdf", runs("CORRIDOR", "CORRIDOR", "CORRIDOR"), "ocr");
  const hits = searchPlan([scanned, B], "corridor");
  assert.deepEqual(hits.map((h) => h.key), ["A102.pdf", "A200.pdf"]);
  assert.ok(hits[1].score > hits[0].score, "the OCR sheet scores higher and still sorts after");
  assert.equal(hits[1].source, "ocr", "but the scan is still findable, and says so");
});

test("searchPlan: OCR hits order among themselves by score", () => {
  const ocr1 = buildSheetIndex("B1.pdf", runs("LOBBY"), "ocr");
  const ocr3 = buildSheetIndex("B2.pdf", runs("LOBBY", "LOBBY", "LOBBY"), "ocr");
  assert.deepEqual(searchPlan([ocr1, ocr3], "lobby").map((h) => h.key), ["B2.pdf", "B1.pdf"]);
});

test("searchPlan: ties break on canonical sheet order, not raw string compare", () => {
  // localeCompare would put page 10 before page 2 and drift from sheetKey.ts's
  // comparator, which every other sheet-ordered surface in the app shares
  const p2 = buildSheetIndex("plan.pdf#2", runs("LOBBY"));
  const p10 = buildSheetIndex("plan.pdf#10", runs("LOBBY"));
  assert.deepEqual(searchPlan([p10, p2], "lobby").map((h) => h.key), ["plan.pdf#2", "plan.pdf#10"]);
});

test("searchPlan: results are stable across identical searches", () => {
  const once = searchPlan([A, B, C], "corridor").map((h) => h.key);
  const twice = searchPlan([C, B, A], "corridor").map((h) => h.key);
  assert.deepEqual(once, twice, "input order must not change output order");
});

// ── short query tokens ──────────────────────────────────────────────────────

test("searchPlan: an unsearchable token in a longer query is dropped", () => {
  // "1" is never indexed (list numbering), so as an AND term it could only ever
  // match by prefix — here, through room 101 — and would drop the sheet that
  // actually says "NOTE 1."
  const plain = buildSheetIndex("plain.pdf", runs("NOTE 1."));
  const room = buildSheetIndex("room.pdf", runs("NOTE", "101"));
  const hits = searchPlan([plain, room], "note 1");
  assert.deepEqual(hits.map((h) => h.key).sort(), ["plain.pdf", "room.pdf"]);
  for (const h of hits) assert.deepEqual(h.matched, ["NOTE"], "no chip for the dropped token");
});

test("searchPlan: a query of ONLY a short token still searches, by prefix", () => {
  // the first keystroke of "101" or "CPT-1" shows live results rather than an
  // empty list; the index never holds "1" itself, so this is prefix-only
  const room = buildSheetIndex("room.pdf", runs("101"));
  const tag = buildSheetIndex("tag.pdf", runs("CPT-1"));
  assert.deepEqual(searchPlan([room, tag], "1").map((h) => h.key), ["room.pdf"]);
  assert.deepEqual(searchPlan([room, tag], "c").map((h) => h.key), ["tag.pdf"]);
});

test("searchPlan: two short tokens with nothing searchable keep neither", () => {
  // only a LONE short token is kept; "a b" has no searchable term to narrow on
  const ix = buildSheetIndex("x.pdf", runs("ABOUT BOARD"));
  assert.deepEqual(searchPlan([ix], "a b"), []);
});

// ── dropFileFromIndex (index invalidation) ──────────────────────────────────

test("dropFileFromIndex: drops every page of the named file, leaves others", () => {
  const map = new Map<string, SheetIndex>();
  for (const k of ["A101.pdf", "A101.pdf#2", "A101.pdf#3", "A102.pdf", "A102.pdf#2"]) {
    map.set(k, buildSheetIndex(k, runs("CORRIDOR")));
  }
  assert.equal(dropFileFromIndex(map, "A101.pdf"), 3);
  assert.deepEqual([...map.keys()], ["A102.pdf", "A102.pdf#2"]);
});

test("dropFileFromIndex: a file name that happens to contain '#' is not mis-split", () => {
  // parseSheetKey only splits on a trailing NUMERIC tail, so this is one file
  const map = new Map<string, SheetIndex>();
  map.set("plan #4 rev.pdf", buildSheetIndex("plan #4 rev.pdf", runs("LOBBY")));
  map.set("plan #4 rev.pdf#2", buildSheetIndex("plan #4 rev.pdf#2", runs("LOBBY")));
  assert.equal(dropFileFromIndex(map, "plan #4 rev.pdf"), 2);
  assert.equal(map.size, 0);
});

test("dropFileFromIndex: dropping an unknown file is a no-op, not a throw", () => {
  const map = new Map<string, SheetIndex>([["A101.pdf", buildSheetIndex("A101.pdf", runs("X"))]]);
  assert.equal(dropFileFromIndex(map, "nope.pdf"), 0);
  assert.equal(map.size, 1);
});

test("dropFileFromIndex: a reissued sheet stops answering with the old text", () => {
  // the bug this exists to prevent: store.addPdf keys on NAME, so a revised
  // A101.pdf overwrites the bytes under the same sheet key
  const map = new Map<string, SheetIndex>();
  map.set("A101.pdf", buildSheetIndex("A101.pdf", runs("CARPET DEMO")));
  assert.deepEqual(searchPlan(map.values(), "carpet").map((h) => h.key), ["A101.pdf"]);
  dropFileFromIndex(map, "A101.pdf");
  map.set("A101.pdf", buildSheetIndex("A101.pdf", runs("TERRAZZO")));
  assert.deepEqual(searchPlan(map.values(), "carpet"), [], "superseded text is gone");
  assert.deepEqual(searchPlan(map.values(), "terrazzo").map((h) => h.key), ["A101.pdf"]);
});

test("splitRun: a run carrying a whole label splits into its words", () => {
  assert.deepEqual(splitRun("OFFICE 101"), ["OFFICE", "101"]);
});

// ── the one text-layer rule (#471) ───────────────────────────────────────────
// A page has a text layer when its text carries at least one token as search
// counts them. Punctuation-only text (a stray "-", leader dots) doesn't: such a
// page is text-less to search's unread count, to Read page text and to Copy.

test("carriesText: a token counts; blank or punctuation-only text doesn't", () => {
  assert.equal(carriesText([]), false);
  assert.equal(carriesText([{ str: "  " }, { str: "" }]), false);
  assert.equal(carriesText([{ str: "-" }, { str: "... —" }, { str: "( )" }]), false);
  assert.equal(carriesText([{ str: "." }, { str: "A" }]), true);
  assert.equal(carriesText([{ str: "- 1 -" }]), true);
  assert.equal(carriesText([{ str: "CAFÉ" }]), true);
});

// ── the scan rule: a page with at most SCAN_MAX_TEXT_LINES text runs is a scan ──

// n runs of three words each: tokenCount is 3n while the run count is n, so a
// rule that counted index tokens instead of runs would put the boundary at 2
const wordyRuns = (n: number): IndexedTextItem[] => Array.from({ length: n }, (_, i) => ({ str: `SCANNED BY OP${i}` }));

test("indexIsScanLike: no text, or a few stray runs (a stamp, a scanner label), is a scan", () => {
  assert.equal(SCAN_MAX_TEXT_LINES, 8);
  assert.equal(indexIsScanLike(buildSheetIndex("k", [])), true);
  assert.equal(indexIsScanLike(buildSheetIndex("k", wordyRuns(3))), true, "3 runs");
});

test("indexIsScanLike: the boundary sits between 8 and 9 lines (an unpositioned run is one line), not tokens", () => {
  assert.equal(buildSheetIndex("k", wordyRuns(8)).tokenCount, 24);
  assert.equal(indexIsScanLike(buildSheetIndex("k", wordyRuns(8))), true, "8 runs (24 tokens) is a scan");
  assert.equal(indexIsScanLike(buildSheetIndex("k", wordyRuns(9))), false, "9 runs is a text layer");
});

test("indexIsScanLike: blank and punctuation-only runs don't count toward the 8 lines", () => {
  const junk = runs("-", "...", "  ", "( )", "", "--", "—", ".", "/");
  assert.equal(indexIsScanLike(buildSheetIndex("k", [...wordyRuns(8), ...junk])), true);
  assert.equal(indexIsScanLike(buildSheetIndex("k", junk)), true);
});

test("indexIsScanLike: a vector sheet's hundreds of runs is not a scan", () => {
  const sheet = Array.from({ length: 300 }, (_, i) => ({ str: i % 3 ? `ROOM ${100 + i}` : "CPT-1" }));
  assert.equal(indexIsScanLike(buildSheetIndex("k", sheet)), false);
});

// positioned runs, as extractRegionText hands them over (image px, y down)
const at = (str: string, x: number, y: number, ang = 0) => ({ str, x, y, h: 20, w: 16 * str.length, ang });

test("lineCount: a letter-spaced stamp (one run per letter) is one line, so the page is still a scan", () => {
  const stamp = [..."RECEIVEDBY"].map((c, i) => at(c, 100 + 24 * i, 300));
  assert.ok(stamp.length >= 9);
  const ix = buildSheetIndex("k", stamp);
  assert.equal(ix.lineCount, 1);
  assert.equal(indexIsScanLike(ix), true);
});

test("lineCount: nine runs on nine separate lines is a text layer; the same nine runs on three lines is a scan", () => {
  const nineLines = Array.from({ length: 9 }, (_, i) => at(`NOTE${i}`, 100, 100 + 60 * i));
  assert.equal(buildSheetIndex("k", nineLines).lineCount, 9);
  assert.equal(indexIsScanLike(buildSheetIndex("k", nineLines)), false);
  const threeLines = Array.from({ length: 9 }, (_, i) => at(`NOTE${i}`, 100 + 200 * (i % 3), 100 + 60 * Math.floor(i / 3)));
  assert.equal(buildSheetIndex("k", threeLines).lineCount, 3);
  assert.equal(indexIsScanLike(buildSheetIndex("k", threeLines)), true);
});

test("lineCount: a rotated run counts as a line of its own (textlines leaves it out of the horizontal lines)", () => {
  const rotated = Array.from({ length: 9 }, (_, i) => at(`12'-${i}"`, 100 + 30 * i, 300, 90));
  assert.equal(buildSheetIndex("k", rotated).lineCount, 9);
});

test("buildSheetIndex: lineCount counts runs that carry a token, as carriesText judges each", () => {
  const items = runs("CPT-1 LVT-2", "-", "ROOM 101", "  ", "a");
  assert.equal(buildSheetIndex("k", items).lineCount, items.filter((it) => carriesText([it])).length);
  assert.equal(buildSheetIndex("k", items).lineCount, 3);
});
