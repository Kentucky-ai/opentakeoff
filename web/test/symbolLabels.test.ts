// #308 — label corroboration, pure layer. The numbers in the adjacency tests
// are the measured ones from the mixed-use renovation proof: true
// beside-the-symbol pairs at ~24 px with 17 px lettering, the nearest
// impostor (a same-shaped valve circle one fixture over) at 45 px.
import { test } from "node:test";
import assert from "node:assert/strict";
import { labelTokens, labelPlacements, LABEL_ADJACENT_K } from "../src/lib/symbollabels.ts";

const span = (str: string, x0: number, y0: number, w = 32, h = 17) => ({ str, x0, y0, x1: x0 + w, y1: y0 + h });

test("labelTokens: fixture tags in, prose and bare numbers out", () => {
  const kept = labelTokens([
    span("P-7", 0, 0), span("P-6A", 0, 0), span("FD1", 0, 0), span("CO", 0, 0),
    span("WC1", 0, 0), span("WH-1", 0, 0), span("T1", 0, 0),
    span("2", 0, 0),                        // keynote number — no letter, never a tag
    span("PROVIDE", 0, 0),                  // prose word
    span("CONNECT NEW STORM", 0, 0),        // a sentence containing "CO"
    span('3/4"', 0, 0),                     // a dimension
  ]).map((s) => s.str);
  assert.deepEqual(kept, ["P-7", "P-6A", "FD1", "CO", "WC1", "WH-1", "T1"]);
});

test("adjacency: the text-height radius takes the true pair and refuses the impostor", () => {
  // one FD1 token, 17 px lettering — radius is 2.2 × 17 ≈ 37 px
  const tokens = [span("FD1", 1616, 1465)];
  const [truePair, impostor] = labelPlacements(
    [[1652, 1488], [1677, 1469]],           // measured: 24 px and 45 px from token center
    tokens, [], undefined,
  );
  assert.equal(truePair?.label, "FD1");
  assert.equal(truePair?.via, "adjacent");
  assert.ok(truePair!.distance_px <= LABEL_ADJACENT_K * 17 + 1);
  assert.equal(impostor, null, "the 45 px valve circle is NOT named — no label reached it");
});

test("adjacency: nearest token wins when two are in range", () => {
  const r = labelPlacements([[100, 100]], [span("FD", 52, 92, 24), span("CO", 108, 92, 24)], [], undefined);
  // FD center (64, 100.5) is 36 px away; CO center (120, 100.5) is 20 px away
  assert.equal(r[0]?.label, "CO", "the closer token names the placement");
});

test("leader: on a multi-pen sheet the chase follows the dark leader to the symbol", () => {
  // grey work (lum 219): a symbol at (400, 200) and one at (400, 500);
  // black leader (lum 0) from beside the token to the first symbol only.
  const segs = [
    400, 190, 410, 210,                     // grey symbol ink near placement 1
    400, 490, 410, 510,                     // grey symbol ink near placement 2
    132, 205, 260, 203,                     // leader tail: starts 4 px right of token edge
    260, 203, 385, 202,                     // leader second hop, ends at the symbol
  ];
  const lum = Uint8Array.from([219, 219, 0, 0]);
  const tokens = [span("P-7", 96, 196)];    // token right edge at x=128, mid-height ~204
  const [led, unled] = labelPlacements([[400, 200], [400, 500]], tokens, segs, lum);
  assert.equal(led?.label, "P-7");
  assert.equal(led?.via, "leader");
  assert.equal(unled, null, "no leader reaches the second symbol");
});

test("leader: a one-pen sheet never chases — a wall is not a leader", () => {
  // identical geometry, but EVERYTHING is dark: the 'leader' could as well be
  // a wall, so the chase must stay disarmed and the placement unnamed.
  const segs = [
    400, 190, 410, 210,
    132, 205, 260, 203,
    260, 203, 385, 202,
  ];
  const lum = Uint8Array.from([0, 0, 0]);
  const r = labelPlacements([[400, 200]], [span("P-7", 96, 196)], segs, lum);
  assert.equal(r[0], null, "single-pen sheet: adjacency only, and this token is not adjacent");
});

test("adjacent beats leader when both could name a placement", () => {
  const segs = [132, 205, 385, 202];        // dark leader straight to the symbol
  const lum = Uint8Array.from([0]);
  // make the sheet multi-pen by adding grey ink elsewhere
  const segs2 = [...segs, 800, 800, 1200, 800];
  const lum2 = Uint8Array.from([0, 219]);
  const tokens = [span("P-7", 96, 196), span("FD", 384, 214, 24)]; // FD written right at the symbol
  const r = labelPlacements([[400, 200]], tokens, segs2, lum2);
  assert.equal(r[0]?.via, "adjacent");
  assert.equal(r[0]?.label, "FD");
});

test("no tokens, no work: every placement comes back null", () => {
  const r = labelPlacements([[1, 1], [2, 2]], [span("PROVIDE", 0, 0)], [], undefined);
  assert.deepEqual(r, [null, null]);
});
