// The bubble guards (2026-07-24) — pure, node-run, no pdf.js.
//
// Plans draw room numbers inside little boxes. A seed at the label floods the
// label's own bubble: fully enclosed, traces clean at label size, not a room
// (25 of 26 on the discovering sheet). These pin the two scale-free guards and
// the ladder's recovery path against a synthetic bubbled room.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMask, floodRegion, traceRegion } from "../src/lib/oneclick.ts";
import { seedLadderPx, isLabelBubblePx, BUBBLE_RATIO, BUBBLE_WIDE_RATIO, type LabelBBox } from "../src/lib/detectRooms.ts";

function squareSegs(x0: number, y0: number, x1: number, y1: number): number[] {
  return [x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0];
}

// a room with a label bubble inside it — room kept well under the leak
// guard's sheet fraction: sheet 1200×900, room (100,100)-(500,400), bubble
// around a label whose bbox is (285,235)-(315,255)
const LABEL: LabelBBox = { x0: 285, y0: 235, x1: 315, y1: 255 };
const segs = [...squareSegs(100, 100, 500, 400), ...squareSegs(280, 230, 320, 260)];
const mask = buildMask(segs, 1200, 900);

test("seedLadderPx: anchor-first, offsets scale with the label's own height", () => {
  const probes = seedLadderPx(LABEL);
  assert.equal(probes.length, 4);
  assert.deepEqual(probes[0], [300, 245], "probe one is the label center — bubble-less plans stay one-flood fast");
  const h = LABEL.y1 - LABEL.y0;
  assert.deepEqual(probes[1], [300, 245 + 2 * h], "second probe steps below by 2× label height");
  assert.deepEqual(probes[2], [300, 245 - 2 * h], "third probe steps above");
});

test("the bubble is found and rejected; the ladder recovers the real room", () => {
  // probe one: label center — floods the bubble, clean, label-sized
  const [p1, p2] = seedLadderPx(LABEL);
  const f1 = floodRegion(mask, p1[0], p1[1]);
  assert.equal(f1.status, "ok", "the bubble flood IS clean — that's the trap");
  const ring1 = traceRegion(f1 as never) as [number, number][];
  assert.ok(isLabelBubblePx(ring1, LABEL), "…and the bubble test catches it, scale-free");

  // probe two: below the label — floods the room around the bubble
  const f2 = floodRegion(mask, p2[0], p2[1]);
  assert.equal(f2.status, "ok");
  const ring2 = traceRegion(f2 as never) as [number, number][];
  assert.ok(!isLabelBubblePx(ring2, LABEL), "the room ring dwarfs the label box");
  let x0 = Infinity, x1 = -Infinity;
  for (const [x] of ring2) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  assert.ok(x1 - x0 > 300, "recovered ring spans the room, not the bubble");
});

test("isLabelBubblePx boundary: the ratio is the contract", () => {
  const b: LabelBBox = { x0: 0, y0: 0, x1: 10, y1: 10 };
  const ringAt = (s: number): [number, number][] => [[0, 0], [s, 0], [s, s], [0, s]];
  assert.ok(isLabelBubblePx(ringAt(10 * BUBBLE_RATIO), b), "at the ratio: still the label's furniture");
  assert.ok(!isLabelBubblePx(ringAt(10 * BUBBLE_RATIO + 1), b), "past it: a real (small) space");
});

// #373 — the wide tag box. Measured on the Dublin A-601 finish plan: the drawn
// number box is 108×36 px around 42×25 px of digits (width ratio 2.58, past
// the square guard by a hair), and the room-finish schedule's cells are
// 174×34 px around the same digits. Both flooded clean and committed as rooms.
test("isLabelBubblePx: a wide, text-height tag box is the label's furniture (#373)", () => {
  const b: LabelBBox = { x0: 2138.6, y0: 1929, x1: 2180.4, y1: 1954.1 };   // "110" on A-601
  const rect = (x0: number, y0: number, w: number, h: number): [number, number][] => [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]];
  assert.ok(isLabelBubblePx(rect(2106, 1927.7, 108, 36), b), "the Revit number box");
  assert.ok(isLabelBubblePx(rect(299, 824.2, 174, 34.5), b), "a schedule cell");
  assert.ok(!isLabelBubblePx(rect(2106, 1927.7, 108, 90), b), "as tall as 3.6 text heights: a real small space");
  assert.ok(!isLabelBubblePx(rect(1900, 1927.7, 42 * BUBBLE_WIDE_RATIO + 1, 36), b), "a corridor a label sits in runs past the width cap");
});
