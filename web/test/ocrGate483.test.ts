// #483 PR A: the marquee rules on Import from schedule's
// on-device (OCR) read (#470, readScheduleSpans(spans, { ocr: true })).
//
// The #483 cases were laid out in OCR word geometry and their reads compared
// with the vector read of the same layout. OCR word boxes were measured on
// #487's replay fixtures against the demo's own text layer (67 matched words
// per copy): about 2–3 px right, the bottom about 1 px higher, the height
// 0.62–0.71 × the text layer's (0.44–1.17 at the extremes), the width 0.95 ×.
// With those boxes a key-column wrap 19 px under a row clears the unglue gap
// (1.6 × a shorter text height), and a filled four- or five-letter code's
// cells shift between columns. Both made reads the vector read lacks: unglue
// candidates keyed new rows, and letters candidates were reported as skipped
// codes the vector read lacks. So with { ocr: true } the marquee rules take no
// unglue candidates and no letters candidates; every other rule stays — a
// code with a NOT USED tail or a qualifier word on a line pass 1 attached to
// no row, and the re-keys of today's rows.
//
// The blank-band section reset (#487) runs once on the read's final rows:
// a line the marquee rules consumed is still a line between two rows. A lone
// line they key is a row that still ends the section, as the unkeyed line did
// before: the engine can miss the heading below it, and the reset can miss
// the band, so the rows below it never come in under the heading above.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFinishMarquee, readFinishTable, type GraphSpan } from "../src/lib/sheetgraph.ts";
import { readScheduleSpans, readScheduleDebug, type ScheduleRead } from "../src/lib/scheduleRead.ts";
import { wordsToSpans, type OcrWord } from "../src/lib/ocr/types.ts";
import { build, sp, H, R, STD, COLS, FLOOR, BASE, WALLS, KEYLINE, keysOf, type Item } from "./fixtures/reader483Fixtures.ts";

/** A text-layer layout as the on-device reader returns it: each span one
 *  word box (OcrWord: y is the bottom), at the measured median offsets. */
const ocrWords = (spans: GraphSpan[]): OcrWord[] =>
  spans.map((s) => ({ str: s.str, x: s.x + 2.5, y: s.y + s.h - 1, w: s.w * 0.95, h: s.h * 0.66 }));
const asOcr = (spans: GraphSpan[]) => wordsToSpans(ocrWords(spans));
const keys = (r: ScheduleRead) => r.rows.map((x) => x.finish_tag);
const skippedOf = (r: ScheduleRead): string[] | undefined => ("skipped" in r ? r.skipped : undefined);
const sectionsOf = (r: ScheduleRead) => Object.fromEntries(r.rows.map((x) => [x.finish_tag, x.section]));
const spansOf = (items: Item[]) => build({ cols: STD, items });
const gap = (n: number): Item => ({ t: "gap", n });
const CPT1 = R("CPT-1", "BROADLOOM CARPET", "VENDOR-A", "LOOP 20", "GREY 101");
const RB1 = R("RB-1", "RUBBER WALL BASE", "VENDOR-B", "COVE", "BLACK 505", '4"');
const RB2 = R("RB-2", "RESILIENT BASE", "VENDOR-B", "STRAIGHT", "GREY 506", '6"');
const PT1 = R("PT-1", "PORCELAIN TILE", "VENDOR-F", "MATTE", "SAND 604");
const EPOX = R("EPOX", "EPOXY FLOORING", "VENDOR-L", "", "GREY 901");

/** the marquee read under { ocr: true } is today's OCR read (pass 1, with the reset), nothing skipped */
function asTodayOcr(spans: GraphSpan[], where: string) {
  const sheet = { key: "crop", spans };
  const plain = readFinishTable(sheet, { marquee: true, resetAtBlankBand: true });
  const m = readFinishMarquee(sheet, { ocr: true });
  assert.ok(plain && "table" in plain && m && m.kind === "table", where);
  assert.deepStrictEqual(m.table.rows, plain.table.rows, where);
  assert.deepStrictEqual(m.skipped, [], `${where}: nothing skipped`);
}

/** tall rows (76 px), each with a wrapped second line 19 px under it, and
 *  `text` in the key column 19 px under RB-1's wrap — a third line of RB-1
 *  (keyCell483's tall-row case) */
function tallRows(text: string): GraphSpan[] {
  const out = [sp("CODE", COLS.KEY, 0), sp("MATERIAL", COLS.MATERIAL, 0), sp("MANUFACTURER", COLS.MANUFACTURER, 0), sp("COLOR", COLS.COLOR, 0)];
  ["CPT-1", "RB-1", "RB-2", "PT-1"].forEach((k, j) => {
    const y = 76 * (j + 1);
    out.push(sp(k, COLS.KEY, y), sp(`MATERIAL ${j}`, COLS.MATERIAL, y), sp("VENDOR-B", COLS.MANUFACTURER, y), sp("BLACK", COLS.COLOR, y), sp(`WRAPPED ${j}`, COLS.MATERIAL, y + 19));
    if (k === "RB-1") out.push(sp(text, COLS.KEY, y + 38));
  });
  return out;
}

test("ocr gate: a third key-column line of a tall row stays merged — no unglue candidates", () => {
  for (const text of ["PT-2 SATIN", "CPT-2 NOT USED", "CT-2 GROUT JOINTS"]) {
    const vec = tallRows(text);
    const ocr = asOcr(vec);
    // the vector read merges it: 19 px is under 1.6 × the text layer's 17 px
    assert.deepEqual(keys(readScheduleSpans(vec)), ["CPT-1", "RB-1", "RB-2", "PT-1"], `${text}: vector`);
    // OCR word boxes are shorter, so the same line clears the unglue gap — the rule, left on, keys it
    const d = readScheduleDebug(ocr);
    assert.ok(d.rows.some((r) => r._newRule && r._ungluedFrom?.[0]?.from === "RB-1"), `${text}: without the ocr option the OCR words unglue`);
    // { ocr: true }: no unglue candidate, the read is today's
    assert.deepEqual(keys(readScheduleSpans(ocr, { ocr: true })), ["CPT-1", "RB-1", "RB-2", "PT-1"], `${text}: ocr`);
    asTodayOcr(ocr, text);
  }
});

test("ocr gate: a key-column wrap 19 px under a row in a 38 px table reads as today", () => {
  for (const text of ["PT-2 SATIN", "CPT-2 NOT USED", "CT-2 GROUT JOINTS"]) {
    const ocr = asOcr(spansOf([CPT1, PT1, { t: "wrap", col: "CODE", text }, RB1, RB2]));
    assert.deepEqual(keys(readScheduleSpans(ocr, { ocr: true })), ["CPT-1", "PT-1", "RB-1", "RB-2"], text);
    asTodayOcr(ocr, text);
  }
});

test("ocr gate: a whole row pass 1 merged into the row above is a row (FTB-01 CUT (C) with its own cells, in a short table)", () => {
  // an unglue candidate in the vector read; on OCR words a qualifier line with
  // cells in two other columns on its own line is a row too, as the vector read has it
  const vec = spansOf([CPT1, R("FTB-01 CUT (C)", "CERAMIC TILE", "VENDOR-F"), PT1]);
  assert.deepEqual(keys(readScheduleSpans(vec)), ["CPT-1", "FTB-01", "PT-1"]);
  const ocr = asOcr(vec);
  assert.deepEqual(keys(readScheduleSpans(ocr, { ocr: true })), ["CPT-1", "FTB-01", "PT-1"]);
  assert.equal(readScheduleSpans(ocr, { ocr: true }).rows[1].description, "CUT (C) — CERAMIC TILE");
  // with one cell beside it the line is not a whole row, and stays merged as before
  const oneCell = asOcr(spansOf([CPT1, R("FTB-01 CUT (C)", "CERAMIC TILE", ""), PT1]));
  assert.deepEqual(keys(readScheduleSpans(oneCell, { ocr: true })), ["CPT-1", "PT-1"]);
  asTodayOcr(oneCell, "FTB-01 one cell");
});

test("ocr gate: four- and five-letter codes are neither read nor reported — no letters candidates", () => {
  const cases: Array<[string, Item[]]> = [
    ["filled EPOX between coded rows", [CPT1, EPOX, RB1, PT1]],
    ["one-cell EPOX between coded rows", [CPT1, { t: "raw", spans: [["EPOX", COLS.KEY], ["EPOXY", COLS.MATERIAL]] }, RB1, PT1]],
    ["filled EPOX as the last row", [CPT1, RB1, EPOX]],
    ["a room line", [CPT1, RB1, { t: "raw", spans: [["LOBBY", COLS.KEY], ["CPT-1", COLS.MATERIAL], ["RB-1", COLS.MANUFACTURER], ["PT-1", COLS.STYLE]] }, PT1]],
  ];
  for (const [what, items] of cases) {
    const ocr = asOcr(spansOf(items));
    const r = readScheduleSpans(ocr, { ocr: true });
    assert.ok(!("refused" in r), what);
    assert.ok(!keys(r).some((k) => /^[A-Z]{4,5}$/.test(k)), `${what}: ${keys(r)}`);
    assert.equal(skippedOf(r), undefined, `${what}: nothing skipped`);
    asTodayOcr(ocr, what);
  }
  // the vector read of the first two still reads / reports them (unchanged)
  assert.ok(keys(readScheduleSpans(spansOf(cases[0][1]))).includes("EPOX"));
  assert.deepEqual(skippedOf(readScheduleSpans(spansOf(cases[1][1]))), ["EPOX"]);
});

test("ocr gate: an all-letters table under { ocr: true } is no table, as before (no skipped codes)", () => {
  const ocr = asOcr(spansOf([EPOX, R("CONC", "SEALED CONCRETE", "VENDOR-D", "", "CLEAR"), R("SEAL", "SEALER", "VENDOR-D")]));
  assert.deepEqual(readScheduleSpans(ocr, { ocr: true }), { rows: [], refused: "no-table" });
});

test("ocr gate: every other rule stays — NOT USED and qualifier lines pass 1 left unattached, and re-keys of today's rows", () => {
  // one-pitch lines between coded rows in a regular table sit beyond the attach radius: unattached
  const vec = spansOf([
    ...FLOOR.slice(0, 3), KEYLINE("CPT-9 NOT USED"), R("FTB-01 CUT (C)", "CERAMIC TILE", "VENDOR-F"), ...BASE,
    R("CPT-2 NIC", "CARPET TILE", "VENDOR-A"), R("P-1 SAT", "PAINT", "VENDOR-E", "", "WHITE 601"), ...WALLS.slice(1),
  ]);
  const ocr = asOcr(vec);
  const r = readScheduleSpans(ocr, { ocr: true });
  assert.ok(!("refused" in r));
  assert.deepEqual(keys(r), ["CPT-1", "CPT-2", "LVT-1", "CPT-9", "FTB-01", "RB-1", "RB-2", "CPT-2", "P-1", "P-2", "CT-1"]);
  assert.deepEqual(keys(r), keys(readScheduleSpans(vec)), "the vector read of the same layout");
  const by = (k: string, n = 0) => r.rows.filter((x) => x.finish_tag === k)[n];
  assert.equal(by("CPT-9").unticked_reason, "not-used");
  assert.equal(by("CPT-9").key_rule, "extended");
  assert.match(by("FTB-01").description, /^CUT \(C\)/);
  assert.equal(by("CPT-2", 1).unticked_reason, "not-used");
  assert.equal(by("CPT-2", 1).key_rule, undefined, "a re-keyed row of today's is not a new-rule row");
  assert.match(by("P-1").description, /^SAT/);
});

// ── the blank-band reset on the marquee rules' rows ──────────────────
test("ocr reset: a lone NOT USED line keyed as a row still ends the section, as the unkeyed line did before", () => {
  // CPT-9 NOT USED sits one pitch under SC-1 (no gap), then a blank band, then RB-1
  const vec = spansOf([H("FLOORING"), ...FLOOR, KEYLINE("CPT-9 NOT USED"), gap(1), ...BASE, ...WALLS]);
  const r = readScheduleSpans(asOcr(vec), { ocr: true });
  const s = sectionsOf(r);
  for (const k of keysOf(FLOOR)) assert.equal(s[k], "FLOORING", k);
  // the row itself and every row below it: no section
  for (const k of ["CPT-9", ...keysOf(BASE), ...keysOf(WALLS)]) assert.equal(s[k], "", k);
  // the vector read: the lone line no longer ends the section, no reset
  const v = sectionsOf(readScheduleSpans(vec));
  for (const k of [...keysOf(FLOOR), "CPT-9", ...keysOf(BASE), ...keysOf(WALLS)]) assert.equal(v[k], "FLOORING", `vector ${k}`);
});

test("ocr reset: a lone keyed line across the blank band is the row the band ends at", () => {
  // SC-1, a blank band, RB-9 NOT USED alone, a blank band, then RB-1 …: the reset starts at RB-9
  const vec = spansOf([H("FLOORING"), ...FLOOR, gap(1), KEYLINE("RB-9 NOT USED"), gap(1), ...BASE, ...WALLS]);
  const s = sectionsOf(readScheduleSpans(asOcr(vec), { ocr: true }));
  for (const k of keysOf(FLOOR)) assert.equal(s[k], "FLOORING", k);
  for (const k of ["RB-9", ...keysOf(BASE), ...keysOf(WALLS)]) assert.equal(s[k], "", k);
});

test("ocr reset: a line the marquee rules consumed is still a line — the rows either side are not one blank band apart", () => {
  // a header repeated in the key column (MATERIAL | MANUFACTURER | COLOR) in the blank band: (h) consumes it
  const hdr: Item = { t: "raw", spans: [["MATERIAL", COLS.KEY], ["MANUFACTURER", COLS.MANUFACTURER], ["COLOR", COLS.COLOR]] };
  const withLine = asOcr(spansOf([H("FLOORING"), ...FLOOR, gap(1), hdr, ...BASE]));
  const d = readScheduleDebug(withLine, { ocr: true });
  assert.deepEqual(d.consumed.map((c) => [c.text, c.reason]), [["MATERIAL MANUFACTURER COLOR", "h"]]);
  const s = sectionsOf(d.read);
  for (const k of [...keysOf(FLOOR), ...keysOf(BASE)]) assert.equal(s[k], "FLOORING", k);
  // no line in the band: the reset fires (#487)
  const s2 = sectionsOf(readScheduleSpans(asOcr(spansOf([H("FLOORING"), ...FLOOR, gap(2), ...BASE])), { ocr: true }));
  for (const k of keysOf(BASE)) assert.equal(s2[k], "", k);
});

test("ocr reset: whole-sheet and readFinishTable reads keep #487's reset as it was (no marquee rules)", () => {
  const vec = spansOf([H("FLOORING"), ...FLOOR, gap(1), KEYLINE("RB-9 NOT USED"), gap(1), ...BASE]);
  const t = readFinishTable({ key: "crop", spans: vec }, { marquee: true, resetAtBlankBand: true });
  assert.ok(t && "table" in t);
  // pass 1: RB-9 NOT USED is not a key, so the lone line ends the section; nothing to reset below it
  assert.deepEqual(t.table.rows.map((x) => [x.key, x.section ?? ""]), [...keysOf(FLOOR).map((k) => [k, "FLOORING"]), ...keysOf(BASE).map((k) => [k, ""])]);
});

test("ocr reset: a lone SC-9 NOT USED line above a missed BASE heading in a short table → the rows below it have no section, as before; the text-layer read is unchanged", () => {
  // one FLOORING row: too few gaps for the blank-band reset, so only the lone line ends the section
  const vec = spansOf([H("FLOORING"), CPT1, KEYLINE("SC-9 NOT USED"), gap(1), RB1, RB2]);
  const ocr = asOcr(vec);
  assert.ok(readScheduleDebug(ocr, { ocr: true }).rows.some((r) => r.key === "SC-9" && r._newRule), "SC-9 is keyed by the marquee rules");
  const r = readScheduleSpans(ocr, { ocr: true });
  assert.deepEqual(r.rows.map((x) => [x.finish_tag, x.section]), [["CPT-1", "FLOORING"], ["SC-9", ""], ["RB-1", ""], ["RB-2", ""]]);
  assert.equal(r.rows[1].unticked_reason, "not-used");
  // today's OCR read (no marquee rules): the same sections for the rows it has
  const t = readFinishTable({ key: "crop", spans: ocr }, { marquee: true, resetAtBlankBand: true });
  assert.ok(t && "table" in t);
  assert.deepEqual(t.table.rows.map((x) => [x.key, x.section ?? ""]), [["CPT-1", "FLOORING"], ["RB-1", ""], ["RB-2", ""]]);
  // the text-layer read: the lone line is a row and the section runs on past it
  assert.deepEqual(readScheduleSpans(vec).rows.map((x) => [x.finish_tag, x.section]), [["CPT-1", "FLOORING"], ["SC-9", "FLOORING"], ["RB-1", "FLOORING"], ["RB-2", "FLOORING"]]);
});
