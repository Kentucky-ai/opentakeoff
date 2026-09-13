// markupText — notes are ink on the sheet. Pure, DOM-free. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOTE_PT, LABEL_PT, NOTE_MAX_W_PT, MIN_SCREEN_PX, LINE_PITCH,
  ptToImg, inkPx, wrapLines, layoutNote, noteBox, lineBaseline, canvasMeasure,
} from "../src/lib/markupText.js";
import { RENDER_SCALE } from "../src/lib/takeoffConstants.ts";

// a mono measure: 0.6 em per character, the JetBrains Mono advance
const mono = (px: number) => (s: string) => s.length * px * 0.6;

test("inkPx: ink is points × RENDER_SCALE at any zoom above the floor", () => {
  assert.equal(ptToImg(NOTE_PT), NOTE_PT * RENDER_SCALE);
  assert.equal(inkPx(NOTE_PT, 1), NOTE_PT * RENDER_SCALE);      // 100 %: pure ink
  assert.equal(inkPx(NOTE_PT, 3), NOTE_PT * RENDER_SCALE);      // 300 %: still ink — it grows with the sheet on screen
  assert.equal(inkPx(NOTE_PT, undefined), NOTE_PT * RENDER_SCALE);   // export: no zoom, no floor
  assert.equal(inkPx(NOTE_PT, 0), NOTE_PT * RENDER_SCALE);
});

test("inkPx: the legibility floor holds the SCREEN size, never the ink", () => {
  const z = 0.2;   // a 36×24 sheet at fit
  const px = inkPx(NOTE_PT, z);
  assert.ok(px > NOTE_PT * RENDER_SCALE, "floored above ink");
  assert.ok(Math.abs(px * z - MIN_SCREEN_PX) < 1e-9, "exactly MIN_SCREEN_PX on screen");
  // the floor is monotone: zoom in a little and the screen size only grows
  assert.ok(inkPx(NOTE_PT, 0.3) * 0.3 >= MIN_SCREEN_PX - 1e-9);
  // labels floor the same way
  assert.ok(Math.abs(inkPx(LABEL_PT, z) * z - MIN_SCREEN_PX) < 1e-9);
});

test("wrapLines: greedy word wrap at the box width, hard newlines honored", () => {
  const m = mono(10);   // 6 px per char
  assert.deepEqual(wrapLines("", 100, m), []);
  assert.deepEqual(wrapLines("   ", 100, m), []);
  assert.deepEqual(wrapLines("short", 100, m), ["short"]);
  // 16 chars = 96 px fits in 100; the next word pushes to a new line
  assert.deepEqual(wrapLines("aaaa bbbb cccc d eeee", 100, m), ["aaaa bbbb cccc d", "eeee"]);
  assert.deepEqual(wrapLines("one\ntwo", 100, m), ["one", "two"]);
  assert.deepEqual(wrapLines("one\n\ntwo", 100, m), ["one", "", "two"]);
  assert.deepEqual(wrapLines("a   b\t c", 100, m), ["a b c"]);
});

test("wrapLines: a word wider than the box breaks by character, never overflows", () => {
  const m = mono(10);
  const lines = wrapLines("xxxxxxxxxxxxxxxxxxxxxxxx tail", 60, m);   // 10 chars per line
  assert.deepEqual(lines, ["xxxxxxxxxx", "xxxxxxxxxx", "xxxx tail"]);
  for (const l of lines) assert.ok(m(l) <= 60, `${l} overflows`);
});

test("layoutNote: a long trial note becomes a paragraph block three inches wide", () => {
  const fontPx = ptToImg(NOTE_PT);
  const text = "FIRST-USE TRIAL: net flooring, RB1 solid-wall runs, finish changes. Q1-Q3 assumptions carried. EX / hatched areas excluded. Scale 1/8 checked against 78 ft and 14 ft dimensions; human review pending.";
  const L = layoutNote({ text, fontPx, measure: mono(fontPx) });
  assert.ok(L.lines.length >= 4, `wrapped into ${L.lines.length} lines`);
  assert.ok(L.w <= ptToImg(NOTE_MAX_W_PT) + 1e-9, "never wider than the wrap width");
  assert.equal(L.lineH, fontPx * LINE_PITCH);
  assert.ok(Math.abs(L.h - (L.lines.length * L.lineH + 2 * L.padY)) < 1e-9);
  // every line fits inside the box
  for (const l of L.lines) assert.ok(mono(fontPx)(l) + 2 * L.padX <= L.w + 1e-9);
});

test("layoutNote: empty text is an empty block; padding rides the floor", () => {
  const fontPx = ptToImg(NOTE_PT);
  const L0 = layoutNote({ text: "", fontPx, measure: mono(fontPx) });
  assert.deepEqual([L0.lines, L0.w, L0.h], [[], 0, 0]);
  const floored = layoutNote({ text: "x", fontPx: fontPx * 2, measure: mono(fontPx * 2) });
  const plain = layoutNote({ text: "x", fontPx, measure: mono(fontPx) });
  assert.ok(Math.abs(floored.padX - plain.padX * 2) < 1e-9, "pad scales with the font");
});

test("layoutNote: a floored (zoomed-out) note keeps its proportions — the wrap width rides the font", () => {
  const text = "FIRST-USE TRIAL: net flooring, RB1 solid-wall runs, finish changes. Q1-Q3 assumptions carried. EX / hatched areas excluded.";
  const ink = ptToImg(NOTE_PT);
  const atInk = layoutNote({ text, fontPx: ink, measure: mono(ink) });
  const floored = layoutNote({ text, fontPx: ink * 2.5, measure: mono(ink * 2.5) });   // the floor at a deep zoom-out
  assert.deepEqual(floored.lines, atInk.lines, "same line breaks at any floor");
  assert.ok(Math.abs(floored.w - atInk.w * 2.5) < 1e-6, "the block scales as one");
  assert.ok(atInk.w <= ptToImg(NOTE_MAX_W_PT) + 1e-9, "at ink size the block is three inches of page");
});

test("noteBox / lineBaseline: the anchor is baseline-left of line one, the box grows right and down", () => {
  const fontPx = ptToImg(NOTE_PT);
  const L = layoutNote({ text: "one two\nthree", fontPx, measure: mono(fontPx) });
  const b = noteBox(100, 200, L);
  assert.equal(b.x0, 100 - L.padX);
  assert.equal(b.y0, 200 - fontPx - L.padY);
  assert.ok(Math.abs((b.x1 - b.x0) - L.w) < 1e-9);
  assert.ok(Math.abs((b.y1 - b.y0) - L.h) < 1e-9);
  assert.equal(lineBaseline(200, L, 0), 200);
  assert.equal(lineBaseline(200, L, 1), 200 + L.lineH);
  assert.ok(lineBaseline(200, L, 1) + 0 < b.y1, "the last baseline sits inside the box");
});

test("canvasMeasure: with no DOM it is the mono estimate, so layout never throws in node", () => {
  const m = canvasMeasure(20);
  assert.equal(m("abcd"), 4 * 20 * 0.6);
});
