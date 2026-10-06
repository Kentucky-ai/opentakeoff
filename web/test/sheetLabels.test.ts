// Sheet-number labels across a file switch (lib/sheetLabels.ts). The canvas
// resets labels when the active file changes; a file whose title block yields
// no number (an image-only PDF) must not show the previous file's number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { labelsForFile, labelsOnFileChange, withPageLabel, withFoundLabels, withoutFile, withoutFileKeys } from "../src/lib/sheetLabels.js";

const A = "demo.pdf", B = "demo-image-only.pdf";

test("a text-less file doesn't show the previous file's sheet number", () => {
  let m = withPageLabel({}, A, 1, "AF101");
  m = labelsOnFileChange(m, B);
  assert.equal(labelsForFile(m, B)[1], undefined);
});

test("the new file's own label survives the reset, in either order", () => {
  // reset first, then the new file's title block is read
  let m = labelsOnFileChange(withPageLabel({}, A, 1, "AF101"), B);
  m = withPageLabel(m, B, 1, "B201");
  assert.equal(labelsForFile(m, B)[1], "B201");
  // the new file's label lands first, then the reset
  m = withPageLabel(withPageLabel({}, A, 1, "AF101"), B, 1, "B201");
  m = labelsOnFileChange(m, B);
  assert.equal(labelsForFile(m, B)[1], "B201");
});

test("the previous file's in-flight scan can't fill the new file's pages", () => {
  let m = labelsOnFileChange(withPageLabel({}, A, 1, "AF101"), B);
  m = withFoundLabels(m, A, { 2: "AF102", 3: "AF103" });   // A's scan lands late
  assert.deepEqual({ ...labelsForFile(m, B) }, {});
  // they're A's own numbers, so they're kept under A
  assert.equal(labelsForFile(m, A)[3], "AF103");
});

test("a found label never overwrites one already read", () => {
  let m = withPageLabel({}, A, 2, "AF102");
  m = withFoundLabels(m, A, { 2: "XX", 3: "AF103" });
  assert.deepEqual({ ...labelsForFile(m, A) }, { 2: "AF102", 3: "AF103" });
});

test("an unchanged label returns the same state (no re-render)", () => {
  const m = withPageLabel({}, A, 1, "AF101");
  assert.equal(withPageLabel(m, A, 1, "AF101"), m);
});

test("no labels yet reads as a stable empty map", () => {
  assert.equal(labelsForFile({}, A), labelsForFile({}, B));
});

test("a revised file's labels go; other files' stay", () => {
  let m = withPageLabel(withPageLabel({}, A, 1, "AF101"), B, 2, "B202");
  m = withoutFile(m, A);
  assert.deepEqual(m, { [B]: { 2: "B202" } });
  assert.equal(withoutFile(m, "absent.pdf"), m, "unchanged map is returned as is");
});

test("a revised file's gallery labels go, page keys included, not a lookalike file's", () => {
  const g = { "plan.pdf": "A-1", "plan.pdf#2": "A-2", "plan.pdf#notes": "x", "plan.pdf.bak": "y", "other.pdf#2": "B-2", "plan#2.pdf": "C-1" };
  assert.deepEqual(withoutFileKeys(g, "plan.pdf"), { "plan.pdf#notes": "x", "plan.pdf.bak": "y", "other.pdf#2": "B-2", "plan#2.pdf": "C-1" });
  assert.deepEqual(withoutFileKeys(g, "plan#2.pdf"), { "plan.pdf": "A-1", "plan.pdf#2": "A-2", "plan.pdf#notes": "x", "plan.pdf.bak": "y", "other.pdf#2": "B-2" });
  assert.equal(withoutFileKeys(g, "absent.pdf"), g);
});
