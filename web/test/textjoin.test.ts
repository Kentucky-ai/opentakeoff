import { test } from "node:test";
import assert from "node:assert/strict";
import { abuttingGroups, joinAbuttingSpans, type BoxSpan } from "../src/lib/textjoin.ts";

// A horizontal run: x0..x0+w on the line whose glyphs span y0..y0+h (y down).
const H = (str: string, x0: number, w: number, y0 = 100, h = 19.2): BoxSpan => ({ str, x0, y0, x1: x0 + w, y1: y0 + h });

test("a tag pdf.js split into three touching runs reads as one string", () => {
  // measured shape of a real split tag: "WB" | "-" | "01", gaps ≈ 0.1 px
  const out = joinAbuttingSpans([H("WB", 2282.4, 31.4), H("-", 2313.8, 6.4), H("01", 2320.3, 21.1)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].str, "WB-01");
  assert.deepEqual([out[0].x0, out[0].x1], [2282.4, 2341.4]);
});

test("ordinary word spacing never joins (a space is ≥ 0.25 × height)", () => {
  const h = 19.2;
  const out = joinAbuttingSpans([H("FLOOR", 0, 60, 100, h), H("TILE", 60 + 0.25 * h, 40, 100, h)]);
  assert.deepEqual(out.map((s) => s.str), ["FLOOR", "TILE"]);
});

test("runs on different lines, sizes or directions stay apart", () => {
  const out = joinAbuttingSpans([
    H("WB", 0, 30), H("-01", 30, 25, 100 + 19.2),   // next line down
    H("T", 100, 10), H("1", 110, 10, 100, 40),       // twice the size
    { str: "RF", x0: 200, x1: 219, y0: 100, y1: 130, rot: 90 }, H("-1", 219, 12),   // vertical meets horizontal
  ]);
  assert.equal(out.length, 6);
});

test("vertical runs join along their own axis", () => {
  // rot 90: reading downward in image space — the along-axis is y
  const v = (str: string, y0: number, len: number): BoxSpan => ({ str, x0: 500, x1: 519.2, y0, y1: y0 + len, rot: 90 });
  const out = joinAbuttingSpans([v("TL", 300, 25), v("-", 325, 6), v("3A", 331, 20)]);
  assert.deepEqual(out.map((s) => s.str), ["TL-3A"]);
  assert.deepEqual([out[0].y0, out[0].y1], [300, 351]);
});

test("a run drawn twice over itself (fake bold) is not doubled", () => {
  const out = joinAbuttingSpans([H("C-01", 0, 40), H("C-01", 0.3, 40)]);
  assert.deepEqual(out.map((s) => s.str), ["C-01", "C-01"]);
});

test("input order survives; unsplit runs come back as the same objects", () => {
  const a = H("ROOM", 0, 50, 0), b = H("WB", 0, 30, 200), c = H("-01", 30, 25, 200), d = H("101", 0, 30, 400);
  const out = joinAbuttingSpans([a, b, c, d]);
  assert.deepEqual(out.map((s) => s.str), ["ROOM", "WB-01", "101"]);
  assert.equal(out[0], a);
  assert.equal(out[2], d);
  assert.deepEqual(abuttingGroups([a, b, c, d]), [[0], [1, 2], [3]]);
});

test("extra fields ride from the chain's first run", () => {
  const out = joinAbuttingSpans([{ ...H("TR", 0, 20), ox: 1, oy: 2 }, { ...H("-01", 20, 25), ox: 9, oy: 9 }]);
  assert.equal(out[0].str, "TR-01");
  assert.deepEqual([out[0].ox, out[0].oy], [1, 2]);
});

test("skewed text is left alone", () => {
  const out = joinAbuttingSpans([{ ...H("WB", 0, 30), rot: 45 }, { ...H("-01", 30, 25), rot: 45 }]);
  assert.equal(out.length, 2);
});

test("a tag never swallows a room number the drafting overlaps or touches", () => {
  // measured on the demo plan: "VCT" "-" "1" then room "170" starting 1.6 px
  // BEFORE the "1" ends — the tag rejoins, the room number stays its own
  const out = joinAbuttingSpans([H("VCT", 2805.6, 28.3), H("-", 2833.9, 4.7), H("1", 2838.7, 7.9), H("170", 2845, 26)]);
  assert.deepEqual(out.map((s) => s.str), ["VCT-1", "170"]);
  // and touching exactly, a digit never glues to a digit
  const touch = joinAbuttingSpans([H("RF-1", 0, 30), H("101", 30, 26)]);
  assert.deepEqual(touch.map((s) => s.str), ["RF-1", "101"]);
});
