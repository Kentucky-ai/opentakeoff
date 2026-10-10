// #483 rows 1 and 4: header aliases, the key column printed second, and a
// legend with no header row, read by Import from schedule's second look
// (scheduleReshape.ts). Invented codes and products only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readScheduleSpans } from "../src/lib/scheduleRead.ts";
import { reshapeBox } from "../src/lib/scheduleReshape.ts";

const span = (str: string, x: number, y: number) => ({ str, x, y, w: str.length * 7, h: 14 });
const ROWS = [
  { CODE: "FL-1", MATERIAL: "RESILIENT FLOOR", MANUFACTURER: "VENDOR-A", DESCRIPTION: "SERIES-A", REMARKS: "ZONE-A" },
  { CODE: "TL-2", MATERIAL: "CERAMIC TILE", MANUFACTURER: "VENDOR-B", DESCRIPTION: "SERIES-B", REMARKS: "ZONE-B" },
  { CODE: "RB-3", MATERIAL: "RUBBER BASE", MANUFACTURER: "VENDOR-C", DESCRIPTION: "SERIES-C", REMARKS: "ZONE-C" },
];
const ALIAS: Record<string, string> = { MFG: "MANUFACTURER", SPECIFICATION: "DESCRIPTION", NOTES: "REMARKS" };
const table = (cols: string[], title = "FINISH SCHEDULE") => [
  span(title, 40, 20),
  ...cols.map((c, i) => span(c, 40 + i * 260, 70)),
  ...ROWS.flatMap((row, j) => cols.map((c, i) => span((row as Record<string, string>)[ALIAS[c] ?? c] ?? "", 40 + i * 260, 110 + j * 42))),
];
const legend = (title: string) => [span(title, 40, 20), ...ROWS.flatMap((r, j) => [span(r.CODE, 40, 70 + j * 42), span(r.MATERIAL, 260, 70 + j * 42)])];
const fields = (spans: ReturnType<typeof table>, ocr = false) =>
  readScheduleSpans(spans, { ocr }).rows.map((r) => [r.finish_tag, r.description, r.manufacturer, r.remarks]);

const FULL = [
  ["FL-1", "RESILIENT FLOOR — SERIES-A", "VENDOR-A", "ZONE-A"],
  ["TL-2", "CERAMIC TILE — SERIES-B", "VENDOR-B", "ZONE-B"],
  ["RB-3", "RUBBER BASE — SERIES-C", "VENDOR-C", "ZONE-C"],
];

test("MFG / SPECIFICATION / NOTES headers read as manufacturer, description and remarks", () => {
  for (const ocr of [false, true]) assert.deepEqual(fields(table(["CODE", "MATERIAL", "MFG", "SPECIFICATION", "NOTES"]), ocr), FULL, `ocr=${ocr}`);
});

test("a key column printed second reads, with or without the aliases", () => {
  for (const ocr of [false, true]) {
    assert.deepEqual(fields(table(["MATERIAL", "CODE", "MANUFACTURER", "DESCRIPTION", "REMARKS"]), ocr), FULL, `canonical ocr=${ocr}`);
    assert.deepEqual(fields(table(["MATERIAL", "CODE", "MFG", "SPECIFICATION", "NOTES"]), ocr), FULL, `aliases ocr=${ocr}`);
  }
});

test("a finish legend with no header row reads as code and description", () => {
  for (const ocr of [false, true]) {
    assert.deepEqual(fields(legend("FINISH LEGEND"), ocr), [
      ["FL-1", "RESILIENT FLOOR", "", ""], ["TL-2", "CERAMIC TILE", "", ""], ["RB-3", "RUBBER BASE", "", ""],
    ], `ocr=${ocr}`);
  }
});

test("a box that already reads is never reshaped", () => {
  const canonical = table(["CODE", "MATERIAL", "MANUFACTURER", "DESCRIPTION", "REMARKS"]);
  assert.equal(reshapeBox(canonical), null, "nothing to rename or move");
  assert.deepEqual(fields(canonical), FULL);
});

test("negative controls stay unread", () => {
  // another family by title, whatever the column order
  assert.equal(readScheduleSpans(table(["CODE", "MATERIAL", "MANUFACTURER", "DESCRIPTION", "REMARKS"], "DOOR SCHEDULE")).rows.length, 0);
  assert.equal(readScheduleSpans(table(["MATERIAL", "CODE", "MANUFACTURER", "DESCRIPTION", "REMARKS"], "DOOR SCHEDULE")).rows.length, 0);
  // a legend titled as another family
  assert.equal(readScheduleSpans(legend("EQUIPMENT LEGEND")).rows.length, 0);
  // keynotes: numbers, not finish codes
  assert.equal(readScheduleSpans([span("KEYNOTES", 40, 20), span("1", 40, 70), span("SEE DETAIL 3", 260, 70), span("2", 40, 112), span("PATCH WALL", 260, 112)]).rows.length, 0);
  // a door table with no title, MARK second, door columns
  const door = [span("WIDTH", 40, 70), span("MARK", 300, 70), span("HEIGHT", 560, 70), span("HARDWARE", 820, 70),
    span("3'-0\"", 40, 110), span("D-1", 300, 110), span("7'-0\"", 560, 110), span("HW-1", 820, 110),
    span("3'-0\"", 40, 152), span("D-2", 300, 152), span("7'-0\"", 560, 152), span("HW-2", 820, 152)];
  assert.equal(readScheduleSpans(door).rows.length, 0);
  // general notes
  assert.equal(readScheduleSpans([span("GENERAL NOTES", 40, 20), span("1. ALL FINISHES PER SPEC", 40, 70), span("2. VERIFY IN FIELD", 40, 112)]).rows.length, 0);
});

// Layouts from @knmurphy's review of #518 (invented codes and vendors).
const rowsAt = (cols: string[], xs: number[], rows: string[][], y0 = 70) => [
  ...cols.map((c, i) => span(c, xs[i], y0)),
  ...rows.flatMap((r, j) => r.map((v, i) => v && span(v, i === 0 && r.length === 1 ? 40 : xs[i], y0 + 40 + j * 30)).filter(Boolean)),
] as ReturnType<typeof span>[];
const box = (a: [string, number, number, number, number][]) => a.map(([str, x, y, w, h]) => ({ str, x, y, w, h }));

test("section headings at the left edge of a MATERIAL | CODE table keep their sections", () => {
  const spans = [span("FINISH SCHEDULE", 40, 20), ...rowsAt(["MATERIAL", "CODE", "MANUFACTURER", "COLOR"], [40, 260, 380, 600],
    [["FLOORING"], ["CARPET TILE", "CPT-1", "VENDOR-A", "GREY"], ["BASE"], ["RUBBER BASE", "RB-1", "VENDOR-B", "BLACK"], ["CEILINGS"], ["ACOUSTICAL TILE", "ACT-1", "VENDOR-D", "WHITE"]])];
  for (const ocr of [false, true]) {
    const rows = readScheduleSpans(spans, { ocr }).rows;
    assert.deepEqual(rows.map((r) => [r.finish_tag, r.section, r.suggested]), [["CPT-1", "FLOORING", true], ["RB-1", "BASE", true], ["ACT-1", "CEILINGS", false]], `ocr=${ocr}`);
  }
});

test("a header naming MARK and CODE keys on CODE", () => {
  const spans = [span("FINISH SCHEDULE", 40, 20), ...rowsAt(["MATERIAL", "MARK", "CODE", "MANUFACTURER"], [40, 260, 340, 460],
    [["CARPET TILE", "A", "CPT-1", "VENDOR-A"], ["RUBBER BASE", "B", "RB-1", "VENDOR-B"], ["PAINT", "C", "PT-1", "VENDOR-C"]])];
  assert.deepEqual(readScheduleSpans(spans).rows.map((r) => [r.finish_tag, r.manufacturer]), [["CPT-1", "VENDOR-A"], ["RB-1", "VENDOR-B"], ["PT-1", "VENDOR-C"]]);
});

test("a legend with a note beside some lines keeps every row, the note as remarks", () => {
  const L5: [string, string][] = [["CPT-1", "CARPET TILE"], ["LVT-1", "LUXURY VINYL TILE"], ["RB-1", "RUBBER BASE"], ["PT-1", "PAINT EGGSHELL"], ["CT-1", "CERAMIC TILE"]];
  const spans = [span("FINISH LEGEND", 40, 20), ...L5.flatMap(([c, d], j) => [span(c, 40, 70 + j * 30), span(d, 130, 70 + j * 30)]),
    span("NOTE: ALL FLOORING BY OWNER", 330, 70), span("SEE SPECIFICATIONS", 330, 100)];
  for (const ocr of [false, true]) {
    const rows = readScheduleSpans(spans, { ocr }).rows;
    assert.deepEqual(rows.map((r) => r.finish_tag), ["CPT-1", "LVT-1", "RB-1", "PT-1", "CT-1"], `ocr=${ocr}`);
    assert.equal(rows[0].description, "CARPET TILE");
    assert.equal(rows[0].remarks, "NOTE: ALL FLOORING BY OWNER");
  }
});

test("ambiguous boxes read nothing rather than rows in the wrong fields", () => {
  // a headed table with too few known header words isn't a legend
  const threeCol = [span("FINISH SCHEDULE", 40, 20), span("CODE", 40, 70), span("SECTION", 110, 70), span("DESCRIPTION", 190, 70), span("FLOORS", 40, 100),
    ...[["CPT-1", "09 68 13", "CARPET TILE"], ["LVT-1", "09 65 19", "LUXURY VINYL TILE"], ["RB-1", "09 65 13", "RUBBER BASE"]].flatMap((r, j) => r.map((v, i) => span(v, [40, 110, 190][i], 130 + j * 30)))];
  // OCR read the CODE and MFG headers as one box
  const oneBox = box([["FINISH SCHEDULE", 42, 42, 104, 5], ["MATERIAL", 41, 76, 55, 5], ["CODE MFG", 165, 75, 61, 7], ["SPECIFICATION", 280, 76, 90, 5], ["NOTES", 385, 76, 34, 5],
    ["RESILIENT FLOOR", 42, 102, 106, 5], ["FL-1", 164, 102, 26, 6], ["VENDOR-A", 207, 102, 56, 6], ["SERIES-A", 279, 102, 54, 6], ["ZONE-A", 388, 102, 39, 7],
    ["CERAMIC TILE", 42, 124, 83, 5], ["TL-2", 164, 123, 27, 7], ["VENDOR-B SERIES-B", 207, 124, 126, 6], ["ZONE-B", 388, 124, 39, 7],
    ["RUBBER BASE", 42, 146, 74, 6], ["RB-3", 164, 146, 37, 7], ["VENDOR-C SERIES-C", 206, 146, 126, 6], ["ZONE-C", 388, 146, 39, 7]]);
  // OCR glued two codes to their vendors: a read of FL-1 alone would hide two rows
  const glued = box([["MATERIAL", 42, 93, 72, 7], ["CODE", 207, 92, 35, 10], ["MFG", 246, 91, 42, 11], ["SPECIFICATION", 361, 93, 122, 7], ["NOTES", 500, 93, 44, 8],
    ["RESILIENT FLOOR", 43, 127, 141, 7], ["FL-1", 203, 126, 36, 9], ["VENDOR-A", 262, 127, 73, 8], ["SERIES-A", 359, 127, 72, 7], ["ZONE-A", 504, 127, 52, 10],
    ["CERAMIC TILE", 44, 157, 108, 8], ["TL-2 VENDOR-B", 207, 156, 129, 10], ["SERIES-B", 360, 157, 70, 8], ["ZONE-B", 505, 157, 50, 11],
    ["RUBBER BASE", 43, 185, 100, 7], ["RB-3 VENDOR-C", 206, 184, 130, 10], ["SERIES-C", 358, 185, 73, 7], ["ZONE-C", 504, 184, 51, 13]]);
  for (const ocr of [false, true]) assert.equal(readScheduleSpans(threeCol, { ocr }).rows.length, 0, `threeCol ocr=${ocr}`);
  assert.equal(readScheduleSpans(oneBox, { ocr: true }).rows.length, 0, "one header box");
  assert.equal(readScheduleSpans(glued, { ocr: true }).rows.length, 0, "glued codes");
});

test("a header box OCR glued over two columns (MATERIAL CODE) splits when the cells under it sit inside it in two groups", () => {
  // invented: material words printed on a group's first row only, codes beside them, both under the one box
  const glued = (ocr: boolean) => {
    const spans = [span("FINISH KEY", 40, 20), span("MATERIAL CODE", 40, 70), span("MFG", 400, 70), span("SPECIFICATION", 660, 70), span("NOTES", 920, 70),
      ...[["Floor", "FL-1", "VENDOR-A", "SERIES-A", "ZONE-A"], ["", "TL-2", "VENDOR-B", "SERIES-B", "ZONE-B"], ["Base", "RB-3", "VENDOR-C", "SERIES-C", "ZONE-C"]]
        .flatMap((r, j) => [r[0] && span(r[0], 40, 110 + j * 42), span(r[1], 100, 110 + j * 42), span(r[2], 400, 110 + j * 42), span(r[3], 660, 110 + j * 42), span(r[4], 920, 110 + j * 42)])
        .filter((s): s is ReturnType<typeof span> => !!s)];
    return readScheduleSpans(spans, { ocr }).rows.map((r) => [r.finish_tag, r.description, r.manufacturer, r.remarks]);
  };
  for (const ocr of [false, true]) assert.deepEqual(glued(ocr), [
    ["FL-1", "Floor — SERIES-A", "VENDOR-A", "ZONE-A"],
    ["TL-2", "SERIES-B", "VENDOR-B", "ZONE-B"],
    ["RB-3", "Base — SERIES-C", "VENDOR-C", "ZONE-C"],
  ], `ocr=${ocr}`);
});

test("a glued header box stays unsplit when a cell under it runs past its edge, or its key group holds no codes", () => {
  const base = (codeX: number, codes: string[], hdr = "MATERIAL CODE") => [span("FINISH KEY", 40, 20), span(hdr, 40, 70), span("MFG", 400, 70), span("SPECIFICATION", 660, 70), span("NOTES", 920, 70),
    ...codes.flatMap((c, j) => [span("Floor", 40, 110 + j * 42), span(c, codeX, 110 + j * 42), span("VENDOR-A", 400, 110 + j * 42), span("SERIES-A", 660, 110 + j * 42)])];
  // the box runs x 40–131; FL-100000 at x = 100 runs to 163, past its right edge
  for (const ocr of [false, true]) assert.equal(readScheduleSpans(base(100, ["FL-100000", "TL-200000"]), { ocr }).rows.length, 0, `overhang ocr=${ocr}`);
  // the same box splits with codes that fit under it
  for (const ocr of [false, true]) assert.equal(readScheduleSpans(base(100, ["FL-1", "TL-2"]), { ocr }).rows.length, 2, `fits ocr=${ocr}`);
  // words, not codes, in the right-hand group
  for (const ocr of [false, true]) assert.equal(readScheduleSpans(base(100, ["TILE", "WOOD"]), { ocr }).rows.length, 0, `no codes ocr=${ocr}`);
});

test("a headerless legend led by a four-letter code (CONC) reports it as skipped on a text-layer read, instead of dropping it", () => {
  const spans = [span("FLOOR FINISH KEY", 40, 20),
    ...[["CONC", "SEALED CONCRETE"], ["FL-1", "RESILIENT FLOOR"], ["TL-2", "CERAMIC TILE"]].flatMap((r, j) => [span(r[0], 40, 70 + j * 42), span(r[1], 260, 70 + j * 42)])];
  const r = readScheduleSpans(spans);
  assert.deepEqual(r.rows.map((x) => x.finish_tag), ["FL-1", "TL-2"]);
  assert.deepEqual("skipped" in r ? r.skipped : undefined, ["CONC"]);
  // on-device words take no letters candidates (ocrGate483): the rows read, nothing is reported
  assert.deepEqual(readScheduleSpans(spans, { ocr: true }).rows.map((x) => x.finish_tag), ["FL-1", "TL-2"]);
});
