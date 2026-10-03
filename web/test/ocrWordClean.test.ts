// OCR border glyphs (#482): a table's ruling read as a glyph at the edge of a
// cell ("[P-1", "V2_", "|ACT-2") and a minus look-alike read for a hyphen
// ("PT−01") are cleaned off each read line (lib/ocr/wordClean.ts) after the
// seams join the tiles. Pinned: what is stripped, what is kept (a printed
// "[E]", a "$", an "_" inside a line), lines left with nothing, and that a
// second clean changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { cleanOcrText, repairKey } from "../src/lib/ocr/wordClean.ts";

test("cleanOcrText: a border glyph at a line's start or end is stripped", () => {
  for (const [raw, want] of [
    ["[B1", "B1"], ["[V2_", "V2"], ["[P2", "P2"], ["115_", "115"], ["|ACT-2", "ACT-2"], ["P-1]", "P-1"],
    ["[P-1 SAT", "P-1 SAT"], ["[FTB-01 CUT (C)", "FTB-01 CUT (C)"], ["||P-2__", "P-2"], ["| [B1", "B1"], [" [P-1 ", "P-1"],
  ]) assert.equal(cleanOcrText(raw), want, raw);
});

test("cleanOcrText: a minus look-alike between two letters or digits is a hyphen", () => {
  assert.equal(cleanOcrText("PT−01"), "PT-01");
  assert.equal(cleanOcrText("ST‐2"), "ST-2");
  assert.equal(cleanOcrText("ST‑2"), "ST-2");
  assert.equal(cleanOcrText("A–B"), "A-B");
  // not between two letters or digits: left as printed
  assert.equal(cleanOcrText("−5"), "−5");
  assert.equal(cleanOcrText("PAINT – EGGSHELL"), "PAINT – EGGSHELL");
});

test("cleanOcrText: printed text is kept", () => {
  for (const s of ["[E]", "$12", "$SM-1", "P-1_2", "A_B C", "CPT-1", "SEE NOTE [2]"]) assert.equal(cleanOcrText(s), s, s);
  // a leading [ whose ] comes after the first space is a border: only it goes
  assert.equal(cleanOcrText("[P-1 SEE NOTE [2]"), "P-1 SEE NOTE [2]");
});

test("cleanOcrText: a line of border glyphs only comes back empty", () => {
  for (const s of ["[", "_", "||", "__", "]", " | ", "[_"]) assert.equal(cleanOcrText(s), "", JSON.stringify(s));
});

test("cleanOcrText: cleaning twice changes nothing", () => {
  for (const s of ["[B1", "[V2_", "P-1_]", " [P-1 ", "| [B1", "[E]", "[P-1 SEE NOTE [2]", "PT−01", "A_B C", "[", "$SM-1", "|_P-3]_"]) {
    const once = cleanOcrText(s);
    assert.equal(cleanOcrText(once), once, JSON.stringify(s));
  }
});

// ── repairKey: a finish code's misread letters (#482) ────────────────────────

test("repairKey: O read for 0 and I read for 1 after a code's hyphen; readAs is the code as read", () => {
  for (const [raw, key, want, readAs] of [
    ["PT-O1", "PT-O1", "PT-01", "PT-O1"],
    ["G-O1(C)", "G-O1C", "G-01C", "G-O1(C)"],
    ["FT-O2(E)", "FT-O2E", "FT-02E", "FT-O2(E)"],
    ["FT-O2E", "FT-O2E", "FT-02E", "FT-O2E"],
    ["PT-O1A", "PT-O1A", "PT-01A", "PT-O1A"],
    ["FTB-O1 CUT (C)", "FTB-O1", "FTB-01", "FTB-O1"],
    ["pt-o1:", "PT-O1", "PT-01", "PT-O1"],
  ]) assert.deepEqual(repairKey(raw, key), { key: want, readAs }, raw);
});

test("repairKey: a $ read for an S leading a code; with an O too, both repairs and one readAs", () => {
  assert.deepEqual(repairKey("$SM-1", "SM-1"), { key: "SSM-1", readAs: "$SM-1" });
  assert.deepEqual(repairKey("$sm-1,", "SM-1"), { key: "SSM-1", readAs: "$SM-1" });
  assert.deepEqual(repairKey("$SM-O1", "SM-O1"), { key: "SSM-01", readAs: "$SM-O1" });
  // a $ with no letter after it is a price, not a code
  assert.deepEqual(repairKey("$12", "12"), { key: "12" });
});

test("repairKey: each part of a compound code on its own; readAs the compound as read when its first word isn't the code", () => {
  assert.deepEqual(repairKey("CPT-1/VIN-1", "CPT-1/VIN-1"), { key: "CPT-1/VIN-1" });
  assert.deepEqual(repairKey("CPT-O1/VIN-1", "CPT-O1/VIN-1"), { key: "CPT-01/VIN-1", readAs: "CPT-O1/VIN-1" });
  assert.deepEqual(repairKey("CPT-O1 / VIN-1", "CPT-O1/VIN-1"), { key: "CPT-01/VIN-1", readAs: "CPT-O1/VIN-1" });
});

test("repairKey: codes that could be printed with letters are left alone, with no readAs", () => {
  // a run after the hyphen with no digit in it is letters as printed (T-II, B-OO)
  for (const k of ["CPT-1/VIN-1", "CPT-1OPT", "WD-OAK1", "PT-1L", "BO1", "CT-I", "PT-01", "P-O", "CT-IA", "SM-1", "G-OI", "T-II", "CPT-III", "WD-OO", "B-OO"]) {
    assert.deepEqual(repairKey(k, k), { key: k }, k);
  }
});

test("repairKey: a $ code with more after its first word: the $ is repaired, readAs is the first word", () => {
  assert.deepEqual(repairKey("$SM-1 (C)", "SM-1C"), { key: "SSM-1C", readAs: "$SM-1" });
  assert.deepEqual(repairKey("$SM-1 SAT", "SM-1SAT"), { key: "SSM-1SAT", readAs: "$SM-1" });
});

// ── review round 1 ──────────────────────────────────────────────────────────

test("cleanOcrText: every minus look-alike in a run converts (A−B−C)", () => {
  assert.equal(cleanOcrText("A−B−C"), "A-B-C");
  assert.equal(cleanOcrText("1–2‐3"), "1-2-3");
});

test("no web source uses a regex lookbehind (a SyntaxError at module load on Safari before 16.4)", () => {
  const root = new URL("../src/", import.meta.url);
  const files = readdirSync(root, { recursive: true }).map(String).filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f));
  assert.ok(files.length > 50, "found the sources");
  const hits = files.filter((f) => /\(\?<[=!]/.test(readFileSync(new URL(f, root), "utf8")));
  assert.deepEqual(hits, []);
});

test("cleanOcrText: brackets are balanced over the whole line, so printed brackets stay", () => {
  for (const s of ["P-1 [NOTE 2]", "[SEE NOTE 3]", "[NOTE 2] P-1", "[E]", "P-1 [E] [F]"]) assert.equal(cleanOcrText(s), s, s);
  assert.equal(cleanOcrText("[P-1 SEE NOTE [2]"), "P-1 SEE NOTE [2]");
  assert.equal(cleanOcrText("P-1]"), "P-1");
  assert.equal(cleanOcrText("[P-1"), "P-1");
  assert.equal(cleanOcrText("[NOTE 2] P-1]"), "[NOTE 2] P-1");
});

// ── review round 2 ──────────────────────────────────────────────────────────

test("cleanOcrText: ruling read on both sides of a code's cell is stripped as a pair", () => {
  for (const [raw, want] of [["[P-1 SAT]", "P-1 SAT"], ["[ P-1 ]", "P-1"], ["[P-1 ]", "P-1"], ["[P-1 CARPET SHAW]", "P-1 CARPET SHAW"], ["[ SEE NOTE 3 ]", "SEE NOTE 3"]]) {
    assert.equal(cleanOcrText(raw), want, raw);
  }
  for (const s of ["[SEE NOTE 3]", "[NOTE 2] P-1", "P-1 [NOTE 2]", "[E]", "[P-1] [P-2]"]) assert.equal(cleanOcrText(s), s, s);
});

test("repairKey: the $ repair needs the code as keyed to be the first word, or to start with it where the cell goes on", () => {
  assert.deepEqual(repairKey("$SM-1", "SM-10"), { key: "SM-10" });
  assert.deepEqual(repairKey("$S", "SM-1"), { key: "SM-1" });
  assert.deepEqual(repairKey("$S M-1", "SM-1"), { key: "SM-1" });
  assert.deepEqual(repairKey("$SM-1 (C)", "SM-1C"), { key: "SSM-1C", readAs: "$SM-1" });
  assert.deepEqual(repairKey("$SM-1 SAT", "SM-1SAT"), { key: "SSM-1SAT", readAs: "$SM-1" });
  assert.deepEqual(repairKey("$SM-1(C)", "SM-1C"), { key: "SSM-1C", readAs: "$SM-1(C)" });
});
