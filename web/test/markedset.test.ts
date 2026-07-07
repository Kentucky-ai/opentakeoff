// Marked-set WinAnsi guard: pdf-lib's standard Helvetica throws
// "WinAnsi cannot encode" on any code point outside WinAnsi, and one CJK
// character or emoji in a project name / condition tag / markup note used to
// abort the whole export. winAnsiSafe() is the single sanitizer every drawn
// string passes through — these tests pin its contract.
import { test } from "node:test";
import assert from "node:assert/strict";
// markedset.js imports lib/sheets (pdfjs-dist) at module level; pdfjs's ESM
// build loads under node (with a "use the legacy build" warning) —
// buildMarkedSetPdf itself stays untested here (pdf-lib + DOM bound), only
// the pure sanitizer.
import { winAnsiSafe } from "../src/lib/markedset.js";

test("printable ASCII and Latin-1 pass through untouched", () => {
  const s = "CT-1, honed · 546.9 SF ×2 -> 1/4\" = 1'-0\"";
  assert.equal(winAnsiSafe(s), s);
  assert.equal(winAnsiSafe("Björn & Cañón, Zürich ÀÿÞ"), "Björn & Cañón, Zürich ÀÿÞ");
});

test("the module's own typographic marks survive (ellipsis from the clamp loop)", () => {
  assert.equal(winAnsiSafe("Very Long Company Na…"), "Very Long Company Na…");
  assert.equal(
    winAnsiSafe("“quotes” ‘single’ – — •"),
    "“quotes” ‘single’ – — •",
  );
});

test("CJK and other non-WinAnsi code points become ? per code point", () => {
  assert.equal(winAnsiSafe("地板 tiles"), "?? tiles");
  assert.equal(winAnsiSafe("Проект"), "??????");
});

test("an emoji surrogate pair maps to ONE ?, never bisected", () => {
  assert.equal(winAnsiSafe("\u{1F642}"), "?");            // 2 code units → 1 replacement
  assert.equal(winAnsiSafe("plan \u{1F642}\u{1F44D} v2"), "plan ?? v2");
  assert.equal(winAnsiSafe("a\uD800b"), "a?b");           // a LONE surrogate is one ? too
});

test("thin / narrow no-break spaces (locale group separators) soften to a space", () => {
  assert.equal(winAnsiSafe("1\u202F234,5"), "1 234,5");   // narrow NBSP (fr-FR grouping)
  assert.equal(winAnsiSafe("1\u2009234"), "1 234");       // thin space
  assert.equal(winAnsiSafe("1\u00A0234"), "1\u00A0234");  // plain NBSP is Latin-1 — kept
});

test("nullish input yields the empty string; control chars are replaced", () => {
  assert.equal(winAnsiSafe(null), "");
  assert.equal(winAnsiSafe(undefined), "");
  assert.equal(winAnsiSafe("a\tb\nc"), "a?b?c");          // drawn strings are single-line by construction
});
