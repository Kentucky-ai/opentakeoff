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
