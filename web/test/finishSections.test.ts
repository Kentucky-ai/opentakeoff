// Finish-schedule section headings (lib/finishSections.ts): the vocabulary the
// sheet graph reads heading rows against.
import { test } from "node:test";
import assert from "node:assert/strict";
import { finishSectionOf } from "../src/lib/finishSections.ts";

test("a heading matches on its first word, punctuation stripped", () => {
  assert.equal(finishSectionOf("FLOORING"), "FLOORING");
  assert.equal(finishSectionOf("Flooring (see note 2)"), "FLOORING");
  assert.equal(finishSectionOf("MISC. FINISHES"), "MISC");
  assert.equal(finishSectionOf("FLOORS"), "FLOORS");
  assert.equal(finishSectionOf("BASE - ALL LEVELS"), "BASE");
});

test("the longest phrase wins over its first word", () => {
  assert.equal(finishSectionOf("WALL BASE"), "WALL BASE");
  assert.equal(finishSectionOf("WALL PROTECTION"), "WALL PROTECTION");
  assert.equal(finishSectionOf("WALL FINISHES"), "WALL FINISHES");
  assert.equal(finishSectionOf("FLOOR FINISHES"), "FLOOR FINISHES");
  assert.equal(finishSectionOf("WALL TILE"), "WALL");
});

test("material words, codes and spec numbers are not headings", () => {
  for (const s of ["CARPET", "TILE", "PAINT", "RESILIENT", "BASE-1", "BASE-A", "BASE-", "CPT-1", "09 65 00 RESILIENT FLOORING", "", "   "]) {
    assert.equal(finishSectionOf(s), null, JSON.stringify(s));
  }
});

test("a first word carrying a digit is a code, never a heading", () => {
  for (const s of ["BASE1", "TRIM1", "WALL2", "FLOOR1 CARPET"]) assert.equal(finishSectionOf(s), null, s);
});
