// The scan-path normalizer: turns a loosely-typed /ai/parse-schedule response
// (bring-your-own-model, so it may be partial/garbage) into the SAME validated
// ScheduleRow[] the vector parser emits. Invariants:
//   - accepts { rows: [...] } or a bare array; anything else → [];
//   - a row with no finish_tag is dropped (can't become a condition);
//   - unknown category → "other"; tags/sections upper-cased, fields trimmed;
//   - suggested honors an explicit boolean, else the category default
//     (ceiling/other start unchecked — same as the vector path);
//   - de-dupes by finish_tag (first wins), since the dialog keys on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeScanRows, SCAN_ENDPOINT } from "../src/lib/scheduleScan.js";

test("normalizes a well-formed { rows } payload", () => {
  const rows = normalizeScanRows({
    rows: [
      { finish_tag: "cpt-1", section: "flooring", category: "floor", description: "Broadloom", manufacturer: "J+J", style: "Pay Day", spec_color: "1408", size: "" },
      { finish_tag: "act-1", category: "ceiling", description: "ACT" },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].finish_tag, "CPT-1");       // upper-cased
  assert.equal(rows[0].section, "FLOORING");
  assert.equal(rows[0].category, "floor");
  assert.equal(rows[0].suggested, true);           // floor default
  assert.equal(rows[1].category, "ceiling");
  assert.equal(rows[1].suggested, false);          // ceiling starts unchecked
});

test("accepts a bare array too", () => {
  const rows = normalizeScanRows([{ finish_tag: "RB-1", category: "base" }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, "base");
  assert.equal(rows[0].suggested, true);
});

test("drops rows without a finish tag; fills missing fields with empty strings", () => {
  const rows = normalizeScanRows({ rows: [{ description: "no tag here" }, { finish_tag: "P-1" }] });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    finish_tag: "P-1", section: "", category: "other", description: "",
    manufacturer: "", style: "", spec_color: "", size: "", suggested: false,
  });
});

test("unknown category falls back to other", () => {
  const [row] = normalizeScanRows({ rows: [{ finish_tag: "X-1", category: "roofing" }] });
  assert.equal(row.category, "other");
  assert.equal(row.suggested, false);
});

test("explicit suggested boolean overrides the category default", () => {
  const [ceil] = normalizeScanRows({ rows: [{ finish_tag: "ACT-1", category: "ceiling", suggested: true }] });
  assert.equal(ceil.suggested, true);
  const [flr] = normalizeScanRows({ rows: [{ finish_tag: "CPT-1", category: "floor", suggested: false }] });
  assert.equal(flr.suggested, false);
});

test("de-dupes by finish_tag, first wins", () => {
  const rows = normalizeScanRows({ rows: [
    { finish_tag: "CPT-1", manufacturer: "First" },
    { finish_tag: "cpt-1", manufacturer: "Second" },
  ] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].manufacturer, "First");
});

test("garbage / empty shapes yield [] (nothing invented)", () => {
  assert.deepEqual(normalizeScanRows(null), []);
  assert.deepEqual(normalizeScanRows(undefined), []);
  assert.deepEqual(normalizeScanRows({}), []);
  assert.deepEqual(normalizeScanRows({ rows: "nope" }), []);
  assert.deepEqual(normalizeScanRows("string"), []);
  assert.deepEqual(normalizeScanRows({ rows: [null, 42, "x", {}] }), []);
});

test("endpoint constant is the takeoff-scoped AI route", () => {
  assert.equal(SCAN_ENDPOINT, "/ai/parse-schedule");
});
