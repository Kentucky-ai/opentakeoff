// dragOut.js — the pure half of "drag a marked sheet out of the app":
// filename sanitizing, the Chromium DownloadURL triple, and the content
// signature that decides when a cached sheet PDF is stale. The blob-URL
// cache itself touches URL.createObjectURL and is exercised live in the
// browser (docs/design/sheet-drag-out-verification.md), not here.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { dragPart, dragFilename, downloadUrlEntry, sheetContentSignature } from "../src/lib/dragOut.js";

// ── dragPart: every drop target gets a safe ASCII name ─────────────────────
test("dragPart: spaces collapse to dashes, unsafe chars drop", () => {
  assert.equal(dragPart("Harlan Hotel — Level 1"), "Harlan-Hotel-Level-1");
  assert.equal(dragPart("A1.1 FINISH PLAN"), "A1.1-FINISH-PLAN");
});

test("dragPart: colons never survive (they'd split the DownloadURL triple)", () => {
  assert.equal(dragPart("plan: rev 2").includes(":"), false);
});

test("dragPart: fully-stripped input falls back, never empty", () => {
  assert.equal(dragPart("///"), "sheet");
  assert.equal(dragPart("", "takeoff"), "takeoff");
  assert.equal(dragPart(null), "sheet");
});

test("dragPart: leading/trailing dots and dashes trim (no hidden files)", () => {
  assert.equal(dragPart("...A1.1-"), "A1.1");
});

// ── dragFilename ────────────────────────────────────────────────────────────
test("dragFilename: project + sheet + -marked.pdf", () => {
  assert.equal(dragFilename("Harlan Hotel", "A1.1"), "Harlan-Hotel-A1.1-marked.pdf");
});

test("dragFilename: unnamed project reads as takeoff", () => {
  assert.equal(dragFilename("", "A1.1"), "takeoff-A1.1-marked.pdf");
});

// ── downloadUrlEntry ────────────────────────────────────────────────────────
test("downloadUrlEntry: mime:filename:url — url may carry colons", () => {
  assert.equal(
    downloadUrlEntry("a-marked.pdf", "blob:http://localhost:5173/x"),
    "application/pdf:a-marked.pdf:blob:http://localhost:5173/x",
  );
});

// ── sheetContentSignature: stale-cache detection ────────────────────────────
const K = "plan.pdf#1";
const shape = (id: string, sf: number) => ({ id, sheet_id: K, computed: { area_sf: sf, perimeter_lf: 0 } });

test("signature: ignores other sheets' content", () => {
  const a = sheetContentSignature(K, [shape("s1", 10)], [], []);
  const b = sheetContentSignature(K, [shape("s1", 10), { ...shape("s2", 99), sheet_id: "plan.pdf#2" }], [], []);
  assert.equal(a, b);
});

test("signature: an in-place geometry edit (same id, new quantity) changes it", () => {
  const a = sheetContentSignature(K, [shape("s1", 10)], [], []);
  const b = sheetContentSignature(K, [shape("s1", 12)], [], []);
  assert.notEqual(a, b);
});

test("signature: adding a markup or an approval changes it", () => {
  const base = sheetContentSignature(K, [], [], []);
  assert.notEqual(base, sheetContentSignature(K, [], [{ id: "m1", sheet_id: K, type: "cloud" }], []));
  assert.notEqual(base, sheetContentSignature(K, [], [], [{ id: "a1", sheet_id: K }]));
});
