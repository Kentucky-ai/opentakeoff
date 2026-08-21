import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSheetNumber } from "../src/lib/sheets.ts";

// Identity viewport: item transform [fs,0,0,fs,x,y] lands at (x,y) with glyph
// height fs. Page is 1000×800; the title-block gate is x ≥ 600, y ≥ 440.
const VP = { width: 1000, height: 800, transform: [1, 0, 0, 1, 0, 0] };
const item = (str: string, x: number, y: number, fs: number, width?: number) => ({
  str,
  transform: [fs, 0, 0, fs, x, y],
  ...(width != null ? { width } : {}),
});

test("an intact title-block number still wins", () => {
  const tc = {
    items: [
      item("A-101", 920, 760, 30),
      item("GMP-3", 880, 500, 8), // sheet-issue row: smaller, higher up
      item("SCALE: 1/8\" = 1'-0\"", 700, 700, 10),
    ],
  };
  assert.equal(extractSheetNumber(tc, VP), "A-101");
});

test("a sheet number split into glyph runs is joined and beats a lone lookalike", () => {
  // the DocuSign-flattened Johnston County set: "M-121A" arrives as three runs
  // while the sheet-issue table's "GMP-3" is one item — the bug read GMP-3
  const tc = {
    items: [
      item("M", 920, 780, 28, 18),
      item("-", 940, 780, 28, 8),
      item("121A", 950, 780, 28, 70),
      item("GMP-3", 880, 500, 8, 30),
    ],
  };
  assert.equal(extractSheetNumber(tc, VP), "M-121A");
});

test("fragments far apart on a baseline do not join", () => {
  // two tokens on one row separated by a column gap — the join must not
  // manufacture a candidate from them (and neither matches alone)
  const tc = {
    items: [
      item("121A", 700, 780, 10, 30),
      item("M", 900, 780, 10, 8), // 170px gap ≫ 1.2 × glyph height
    ],
  };
  assert.equal(extractSheetNumber(tc, VP), null);
});

test("no sheet-number-shaped text → null", () => {
  const tc = { items: [item("SECOND FLOOR", 900, 760, 20)] };
  assert.equal(extractSheetNumber(tc, VP), null);
});
