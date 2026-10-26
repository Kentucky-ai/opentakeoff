// Import from schedule on an OCR read (#482): a finish code the reader saw
// with a letter for a digit (PT-O1, G-O1(C)) or a "$" for an "S" ($SM-1) is
// repaired, and the row says what was read (read_as) so the dialog can flag
// it. Synthetic spans from reader483Fixtures, read with { ocr: true }; the
// same spans read as a text layer ({ ocr: false }) are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readScheduleSpans, repairSlashSeven } from "../src/lib/scheduleRead.ts";
import type { ScheduleRow } from "../src/lib/scheduleRows.ts";
import { build, M, MMC, R, STD, FLOOR, BASE, WALLS, TWINS } from "./fixtures/reader483Fixtures.ts";
import { boxWords } from "../src/lib/ocr/boxRead.ts";
import { wordsToSpans } from "../src/lib/ocr/types.ts";
import { repairKey } from "../src/lib/ocr/wordClean.ts";
import type { SeamLine } from "../src/lib/ocr/seams.ts";

const has = (o: object, f: string) => Object.prototype.hasOwnProperty.call(o, f);
const rowsOf = (spans: ReturnType<typeof build>, ocr: boolean): ScheduleRow[] => {
  const r = readScheduleSpans(spans, { ocr });
  assert.ok(!("refused" in r), "read as a table");
  return r.rows;
};
const byTag = (rows: ScheduleRow[], tag: string) => {
  const r = rows.find((x) => x.finish_tag === tag);
  assert.ok(r, `a ${tag} row in ${rows.map((x) => x.finish_tag).join(", ")}`);
  return r;
};

const KEYS = build({
  cols: MMC,
  items: [
    M("CPT-1", "BROADLOOM CARPET", "VENDOR-A", "GREY"),
    M("PT-O1", "PAINT", "VENDOR-E", "WHITE"),
    M("G-O1(C)", "GLASS", "VENDOR-B", "CLEAR"),
    M("$SM-1", "SEALED MASONRY", "VENDOR-D", "CLEAR"),
    M("FTB-O1 CUT (C)", "FLOOR TILE BASE", "VENDOR-B", "WHITE"),
  ],
});

test("OCR read: PT-O1 imports as PT-01, read_as PT-O1", () => {
  const r = byTag(rowsOf(KEYS, true), "PT-01");
  assert.equal(r.read_as, "PT-O1");
  assert.equal(r.description, "PAINT");
});

test("OCR read: G-O1(C) imports as G-01(C), read_as G-O1(C)", () => {
  assert.equal(byTag(rowsOf(KEYS, true), "G-01(C)").read_as, "G-O1(C)");
});

test("OCR read: $SM-1 imports as SSM-1, read_as $SM-1", () => {
  assert.equal(byTag(rowsOf(KEYS, true), "SSM-1").read_as, "$SM-1");
});

test("OCR read: a repaired code keeps its qualifier; a code read right has no read_as", () => {
  const rows = rowsOf(KEYS, true);
  const ftb = byTag(rows, "FTB-01");
  assert.equal(ftb.read_as, "FTB-O1");
  assert.match(ftb.description, /^CUT \(C\)/);
  assert.ok(!has(byTag(rows, "CPT-1"), "read_as"), "no read_as key at all");
});

test("the same spans read as a text layer: no repair, no read_as", () => {
  const rows = rowsOf(KEYS, false);
  assert.deepEqual(rows.map((r) => r.finish_tag), ["CPT-1", "PT-O1", "G-O1(C)", "SM-1", "FTB-O1"]);
  for (const r of rows) assert.ok(!has(r, "read_as"), r.finish_tag);
});

// ── "/" read as "7" in an item's words ──────────────────────────────────────

test("repairSlashSeven: a lone 7 between two words, one with a letter, is a /", () => {
  assert.equal(repairSlashSeven("MOHAWK 7 HYPER EARTH BT405 7 YELLOW PYRITE"), "MOHAWK / HYPER EARTH BT405 / YELLOW PYRITE");
  // "4" has no letter: one neighbor with a letter is enough
  assert.equal(repairSlashSeven("BASE 7 4 IN 7 BLACK"), "BASE / 4 IN / BLACK");
  assert.equal(repairSlashSeven("CARPET 7 BROADLOOM 7 BLUE"), "CARPET / BROADLOOM / BLUE");
});

test("repairSlashSeven: W7 after a floor word is W/, at the cell's end too", () => {
  assert.equal(repairSlashSeven("EPOXY FLOORING W7 COVE BASE"), "EPOXY FLOORING W/ COVE BASE");
  assert.equal(repairSlashSeven("EPOXY FLOORING W7"), "EPOXY FLOORING W/");
});

test("repairSlashSeven: a 7 beside a dimension's X is a size, not a /", () => {
  for (const s of ["4 X 7 IN", "PORCELAIN 7 X 24", "TILE 3 x 7 MATTE", "PLANK 7 × 48"]) assert.equal(repairSlashSeven(s), s, JSON.stringify(s));
});

test("repairSlashSeven: anything else is left as printed, whitespace and all", () => {
  for (const s of ["SEE W7 BELOW", "7 DAYS", "12 7", "EARTH7YELLOW", "A  B", "W7", "12 7 14", " CARPET  TILE "]) assert.equal(repairSlashSeven(s), s, JSON.stringify(s));
});

// MATERIAL and DESCRIPTION at their own x (the fixture puts both at 220)
const ITEM_COLS = ["MATERIAL", "DESCRIPTION", "MANUFACTURER", "STYLE", "COLOR"];
const ITEM_X = { DESCRIPTION: 400, MANUFACTURER: 600 };
const ITEMS = build({
  cols: ITEM_COLS, colX: ITEM_X,
  items: [
    { t: "row", key: "EP-1", cells: { MATERIAL: "EPOXY FLOORING W7", DESCRIPTION: "4 IN. COVE BASE", MANUFACTURER: "VENDOR-A", COLOR: "GREY" } },
    { t: "row", key: "CPT-1", cells: { MATERIAL: "CARPET 7 BROADLOOM", DESCRIPTION: "LOOP 7 BLUE", MANUFACTURER: "VENDOR-B", STYLE: "TEXTURE 7 LOOP", COLOR: "W7 OAK" } },
    { t: "row", key: "TL-1", cells: { MATERIAL: "TILE", MANUFACTURER: "VENDOR-C", COLOR: "OAK 7 GREY" } },
  ],
});
const PRODUCTS = build({
  cols: ["MATERIAL", "MANUFACTURER", "PRODUCT", "COLOR"],
  items: [{ t: "row", key: "CPT-2", cells: { MATERIAL: "CARPET", MANUFACTURER: "VENDOR-A", PRODUCT: "HYPER 7 EARTH", COLOR: "BLUE 7 GREY" } }],
});

test("OCR read: the floor's own base, W7 in MATERIAL and the base in DESCRIPTION, is not read as a base item", () => {
  // a text layer has no 7 for /: the same words name a cove base
  assert.equal(byTag(rowsOf(ITEMS, false), "EP-1").category, "base");
  const ep = byTag(rowsOf(ITEMS, true), "EP-1");
  assert.equal(ep.description, "EPOXY FLOORING W/ — 4 IN. COVE BASE");
  assert.notEqual(ep.category, "base");
});

test("OCR read: the repair is MATERIAL, DESCRIPTION and PRODUCT only", () => {
  const rows = rowsOf(ITEMS, true);
  const cpt = byTag(rows, "CPT-1");
  assert.equal(cpt.description, "CARPET / BROADLOOM — LOOP / BLUE");
  assert.equal(cpt.style, "TEXTURE 7 LOOP");
  assert.equal(cpt.spec_color, "W7 OAK");
  assert.equal(byTag(rows, "TL-1").spec_color, "OAK 7 GREY");
  const p = byTag(rowsOf(PRODUCTS, true), "CPT-2");
  assert.equal(p.description, "CARPET — HYPER / EARTH");
  assert.equal(p.spec_color, "BLUE 7 GREY");
});

test("the item spans read as a text layer: exactly as printed, no read_as", () => {
  const rows = rowsOf(ITEMS, false);
  assert.deepEqual(rows.map((r) => [r.finish_tag, r.description, r.category, r.style, r.spec_color]), [
    ["EP-1", "EPOXY FLOORING W7 — 4 IN. COVE BASE", "base", "", "GREY"],
    ["CPT-1", "CARPET 7 BROADLOOM — LOOP 7 BLUE", "unassigned", "TEXTURE 7 LOOP", "W7 OAK"],
    ["TL-1", "TILE", "unassigned", "", "OAK 7 GREY"],
  ]);
  for (const r of rows) assert.ok(!has(r, "read_as"), r.finish_tag);
  assert.equal(byTag(rowsOf(PRODUCTS, false), "CPT-2").description, "CARPET — HYPER 7 EARTH");
});

// ── end to end: a bordered OCR read to the dialog's rows ────────────────────
// The words a box read gets, as the engine posts them: each cell one word box
// with y its bottom (build()'s spans have y at the top), at the offsets
// measured against the demo's text layer (ocrGate483.test.ts), and the key
// cells carrying the cell's left rule as "[" or a trailing "_". The layout is
// ocrGate483's regular table, where an OCR read keys a code with a word after
// it (in a short table the marquee rules leave that line merged on OCR, by
// design). Through boxWords, wordsToSpans and the OCR read, "[P-1 SAT" is
// P-1 with its qualifier and "[FTB-01 CUT (C)" a row of its own; without the
// cleaning the first keys P-1SAT and the second is no row.
test("end to end: bordered key cells read through boxWords as their codes", () => {
  const BORDER: Record<string, string> = { "P-1 SAT": "[P-1 SAT", "FTB-01 CUT (C)": "[FTB-01 CUT (C)", "RB-2": "RB-2_" };
  const spans = build({
    cols: STD,
    items: [
      ...FLOOR.slice(0, 3), R("FTB-01 CUT (C)", "CERAMIC TILE", "VENDOR-F"), ...BASE,
      R("P-1 SAT", "PAINT", "VENDOR-E", "", "WHITE 601"), ...WALLS.slice(1),
    ],
  });
  const lines: SeamLine[] = spans.map((sp) => ({ str: BORDER[sp.str] ?? sp.str, x: sp.x + 2.5, y: sp.y + sp.h - 1, w: sp.w * 0.95, h: sp.h * 0.66 }));
  assert.equal(lines.filter((l) => /^\[|_$/.test(l.str)).length, 3, "fixture: three bordered key cells");
  const rows = rowsOf(wordsToSpans(boxWords(lines)), true);
  assert.deepEqual(rows.map((r) => r.finish_tag), ["CPT-1", "CPT-2", "LVT-1", "FTB-01", "RB-1", "RB-2", "P-1", "P-2", "CT-1"]);
  assert.match(byTag(rows, "P-1").description, /^SAT — PAINT/);
  assert.match(byTag(rows, "FTB-01").description, /^CUT \(C\) — CERAMIC TILE/);
  for (const r of rows) assert.ok(!has(r, "read_as"), r.finish_tag);
});

// ── the #483 twins: nothing to repair, so nothing repaired ──────────────────
// No twin prints a code with O or I after its hyphen, a "$", a lone 7 or a W7
// (their VENDOR-O and VENDOR-I are vendor names, which no repair reads), so
// both repairs are identity on every span, and an OCR read of any twin says
// nothing was repaired.
const keyNorm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9/-]/g, "");
test("twins: repairKey and repairSlashSeven are identity on every twin span", () => {
  for (const t of TWINS) for (const sp of t.spans) {
    assert.equal(repairSlashSeven(sp.str), sp.str, `${t.name}: ${sp.str}`);
    const key = keyNorm(sp.str.trim().split(/\s/)[0] ?? "");
    assert.deepEqual(repairKey(sp.str, key), { key }, `${t.name}: ${sp.str}`);
  }
});

test("twins: an OCR read of every twin has no read_as", () => {
  for (const t of TWINS) {
    const r = readScheduleSpans(t.spans, { ocr: true });
    for (const row of r.rows) assert.ok(!has(row, "read_as"), `${t.name}: ${row.finish_tag}`);
  }
});

test("repairSlashSeven: a 7 after a word that introduces a number is the number", () => {
  for (const s of ["TYPE 7 TILE", "SERIES 7 PLANK", "NO. 7 FINISH", "CLASS 7 FIRE", "# 7 GRADE", "GRADE 7 OAK", "MODEL 7 BASE", "PHASE 7 AREA", "SECTION 7 NOTE", "GAUGE 7 STEEL", "No 7 BLUE"]) {
    assert.equal(repairSlashSeven(s), s, s);
  }
  // the other repairs are unchanged
  assert.equal(repairSlashSeven("CARPET 7 BROADLOOM 7 BLUE"), "CARPET / BROADLOOM / BLUE");
  assert.equal(repairSlashSeven("TILE 7 TYPE 7 GREY"), "TILE / TYPE 7 GREY");
  // STYLE and SIZE often head a "/" pair (STYLE / COLOR): not number words
  assert.equal(repairSlashSeven("STYLE 7 COLOR"), "STYLE / COLOR");
  assert.equal(repairSlashSeven("SIZE 7 FINISH"), "SIZE / FINISH");
});
