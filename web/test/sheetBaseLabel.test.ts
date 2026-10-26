// sheetBaseLabelFromKey — the pure fallback branch of the canvas's
// sheetBaseLabel closure (TakeoffCanvas.jsx), extracted so the source-caption
// text can be computed identically on the canvas AND inside markedset.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sheetBaseLabelFromKey } from "../src/lib/sheets.js";

test("sheetBaseLabelFromKey: page 1 → bare file name (no #1 suffix)", () => {
  assert.equal(sheetBaseLabelFromKey("foo.pdf#1"), "foo");
  assert.equal(sheetBaseLabelFromKey("foo.pdf"), "foo"); // no # at all — page defaults to 1
});

test("sheetBaseLabelFromKey: page > 1 → '<base>-<page>'", () => {
  assert.equal(sheetBaseLabelFromKey("foo.pdf#3"), "foo-3");
});

test("sheetBaseLabelFromKey: strips a trailing .pdf case-insensitively", () => {
  assert.equal(sheetBaseLabelFromKey("Plan.PDF#2"), "Plan-2");
});

test("sheetBaseLabelFromKey: stitch key → '' (STITCH-KEY GUARD)", () => {
  // A stitch key ("stitch:<uid>") has no '#', so parseSheetKey would otherwise
  // read the whole thing as a garbage file name ("Source: stitch:abc · p.1").
  // The canvas resolves a stitch's name via runtime state (stitchById) this
  // pure module can't see, so it must suppress instead of guessing.
  assert.equal(sheetBaseLabelFromKey("stitch:abc"), "");
});

test("sheetBaseLabelFromKey: missing/empty/non-string key → '' (never throws)", () => {
  assert.equal(sheetBaseLabelFromKey(""), "");
  assert.equal(sheetBaseLabelFromKey(undefined as unknown as string), "");
  assert.equal(sheetBaseLabelFromKey(null as unknown as string), "");
  assert.equal(sheetBaseLabelFromKey(42 as unknown as string), "");
});
