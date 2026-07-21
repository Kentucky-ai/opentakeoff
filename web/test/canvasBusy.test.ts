// The canvas defer-gate predicate (lib/canvasBusy.ts, Slice 5b). This is the guard
// that keeps a reconcile re-hydrate from clobbering in-progress work, so every
// interaction mode must count as busy — a gap here (the 4c review flagged drag /
// text-edit / scan were missing) silently reopens the clobber it exists to prevent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isCanvasBusy } from "../src/lib/canvasBusy.js";

test("idle: everything empty/false → not busy", () => {
  assert.equal(isCanvasBusy({}), false);
  assert.equal(isCanvasBusy({ poly: [], calib: [], check: [], saveState: "saved" }), false);
});

test("trace/calibration/check in progress → busy", () => {
  assert.equal(isCanvasBusy({ poly: [[0, 0]] }), true);
  assert.equal(isCanvasBusy({ calib: [[1, 1]] }), true);
  assert.equal(isCanvasBusy({ check: [[2, 2]] }), true);
});

test("One-Click review / scale guide / prev-scale prompt → busy", () => {
  assert.equal(isCanvasBusy({ proposal: { key: "x" } }), true);
  assert.equal(isCanvasBusy({ scaleGuide: { a: 1 } }), true);
  assert.equal(isCanvasBusy({ prevScale: 0.5 }), true);
});

test("a scheduled debounced save (saveState 'saving') → busy (CRITICAL-b)", () => {
  assert.equal(isCanvasBusy({ saveState: "saving" }), true);
  assert.equal(isCanvasBusy({ saveState: "idle" }), false);
});

test("the interaction modes the 4c review flagged as missing are all covered", () => {
  assert.equal(isCanvasBusy({ dragging: true }), true);   // shape/vertex/markup move or OC proposal-edit drag
  assert.equal(isCanvasBusy({ editing: true }), true);    // inline text editor open (unsaved keystrokes)
  assert.equal(isCanvasBusy({ scanning: true }), true);   // paid OCR read in flight
});

test("agent run in flight / staged agent proposals → busy (post-merge review finding)", () => {
  assert.equal(isCanvasBusy({ agentRunning: true }), true);            // mid tool-use loop: hydrate would orphan minted conditions
  assert.equal(isCanvasBusy({ agentProposals: [{ id: "p1" }] }), true); // dashed proposals await review — the agent's One-Click analog
  assert.equal(isCanvasBusy({ agentRunning: false, agentProposals: [] }), false);
});

test("prevScale === 0 counts as busy (a present prompt, not absent) — nullish check, not truthy", () => {
  // proposal/scaleGuide/prevScale use != null so a falsy-but-present value still gates.
  assert.equal(isCanvasBusy({ prevScale: 0 }), true);
});

test("any one busy signal is enough (OR of all modes)", () => {
  assert.equal(isCanvasBusy({ poly: [], calib: [], check: [], saveState: "saved", editing: true }), true);
});
