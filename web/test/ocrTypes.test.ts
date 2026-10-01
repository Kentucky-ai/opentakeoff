// OCR words → the sheet graph's spans (lib/ocr/types.ts wordsToSpans), so an
// on-device read of a raster box feeds the same reader as the text layer.
// Pinned: the y flip (a word's y is its bottom, a span's its top); words with
// no letter or digit (empty, leader dots, rules) are dropped; and every span
// reads left to right (rot 0) — a word's box carries no reading direction,
// so the reader's vertical-text guess (a 4+ character run more than twice as
// tall as wide) must never turn a tall, narrow word sideways.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wordsToSpans, type OcrWord } from "../src/lib/ocr/types.ts";
import { readScheduleSpans } from "../src/lib/scheduleRead.ts";
import type { GraphSpan } from "../src/lib/sheetgraph.ts";

test("a word's bottom-edge y becomes the span's top edge; x, w, h and str carry over", () => {
  const words: OcrWord[] = [
    { str: "CPT-1", x: 100, y: 220, w: 60, h: 20, confidence: 0.98 },
    { str: "CARPET", x: 200.5, y: 221.25, w: 80, h: 18.5 },
  ];
  assert.deepEqual(wordsToSpans(words), [
    { str: "CPT-1", x: 100, y: 200, w: 60, h: 20, rot: 0 },
    { str: "CARPET", x: 200.5, y: 202.75, w: 80, h: 18.5, rot: 0 },
  ]);
});

test("empty and punctuation-only words are dropped; a word with one letter or digit stays", () => {
  const w = (str: string): OcrWord => ({ str, x: 0, y: 10, w: 5, h: 10 });
  const spans = wordsToSpans([w(""), w("  "), w("....."), w("—"), w("|"), w("A"), w("7"), w("(1)"), w("É")]);
  assert.deepEqual(spans.map((s) => s.str), ["A", "7", "(1)", "É"]);
});

test("a tall, narrow word stays horizontal", () => {
  // 4+ characters and h > 2w: without a reading direction the sheet graph
  // would guess vertical text and set it aside
  const tall: OcrWord = { str: "VCT-1", x: 10, y: 114, w: 12, h: 40 };
  const [s] = wordsToSpans([tall]);
  assert.equal(s.rot, 0);
  // and the reader keeps it in its row: the table still reads the code,
  // which the same spans without rot lose (checked below)
  const row = (str: string, x: number, y: number, w = 60): OcrWord => ({ str, x, y, w, h: 12 });
  const words: OcrWord[] = [
    row("FINISH", 10, 20), row("SCHEDULE", 80, 20, 90),
    row("CODE", 10, 60), row("MATERIAL", 120, 60, 90), row("MANUFACTURER", 260, 60, 120), row("COLOR", 420, 60),
    tall, row("VINYL", 120, 100), row("VENDOR-A", 260, 100, 90), row("GRAY", 420, 100),
    row("CPT-1", 10, 140), row("CARPET", 120, 140), row("VENDOR-B", 260, 140, 90), row("BLUE", 420, 140),
  ];
  const tags = (spans: GraphSpan[]) => readScheduleSpans(spans).rows.map((r) => r.finish_tag);
  assert.deepEqual(tags(wordsToSpans(words)), ["VCT-1", "CPT-1"]);
  assert.deepEqual(tags(wordsToSpans(words).map(({ rot: _rot, ...rest }) => rest)), ["CPT-1"], "the guess this guards against");
});
