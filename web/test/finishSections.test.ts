// Finish-schedule section headings (lib/finishSections.ts): the one vocabulary
// the sheet graph reads heading rows against, and the heading → category map
// the Import path uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FINISH_SECTION_HEADINGS, FINISH_SECTION_CATEGORY, finishSectionOf } from "../src/lib/finishSections.ts";

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

test("every heading maps to a category; MISC and ACCESSORIES name none", () => {
  for (const h of FINISH_SECTION_HEADINGS) assert.ok(h in FINISH_SECTION_CATEGORY, h);
  assert.equal(Object.keys(FINISH_SECTION_CATEGORY).length, FINISH_SECTION_HEADINGS.length);
  assert.equal(FINISH_SECTION_CATEGORY.FLOORS, "floor");
  assert.equal(FINISH_SECTION_CATEGORY["WALL BASE"], "base");
  assert.equal(FINISH_SECTION_CATEGORY["WALL FINISHES"], "wall");
  assert.equal(FINISH_SECTION_CATEGORY["WALL PROTECTION"], "wall_protection");
  assert.equal(FINISH_SECTION_CATEGORY.TRIM, "transition");
  assert.equal(FINISH_SECTION_CATEGORY.CEILING, "ceiling");
  assert.equal(FINISH_SECTION_CATEGORY.MILLWORK, "other");
  assert.equal(FINISH_SECTION_CATEGORY.MISC, null);
  assert.equal(FINISH_SECTION_CATEGORY.ACCESSORIES, null);
});
