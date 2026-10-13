// Import from schedule's "is this code on the plans?" check (#498). codeUse.ts
// is pure over the plan-search index, so it runs straight under node. Every
// code here is invented. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSheetIndex, type IndexedTextItem, type SheetIndex } from "../src/lib/planIndex.ts";
import { codeUse, codeUseLine } from "../src/lib/codeUse.ts";

// A vector sheet: its text plus filler lines, so the scan rule reads it as a
// text layer, and pictures measured (none) — fully checked.
const filler = Array.from({ length: 8 }, (_, i) => ({ str: `NOTE ${i}` }));
const sheet = (key: string, ...strs: string[]): SheetIndex => ({
  ...buildSheetIndex(key, [...strs.map((str) => ({ str })), ...filler]),
  textLayer: true, pictures: [],
});
const mapOf = (...ixs: SheetIndex[]) => new Map(ixs.map((ix) => [ix.key, ix]));
const SCHED = "set.pdf";   // the schedule's own sheet in every case below
const use = (code: string, ixs: SheetIndex[], extra: Partial<Parameters<typeof codeUse>[1]> = {}) =>
  codeUse(code, { indexes: mapOf(...ixs), keys: ixs.map((ix) => ix.key), sourceKey: SCHED, ...extra });

test("exact text occurrence on another sheet is found, badged text", () => {
  const u = use("CPT-1", [sheet(SCHED, "CPT-1"), sheet("set.pdf#2", "CPT-1")]);
  assert.equal(u.state, "found");
  assert.deepEqual(u.found, [{ key: "set.pdf#2", source: "text" }]);
});

test("a longer code by digit is similar, not an occurrence: CPT-1 vs CPT-12, P-1 vs P-110", () => {
  for (const [code, other] of [["CPT-1", "CPT-12"], ["P-1", "P-110"]]) {
    const u = use(code, [sheet(SCHED, code), sheet("plan.pdf", other)]);
    assert.equal(u.state, "not-found", code);
    assert.deepEqual(u.found, []);
    assert.deepEqual(u.similar, [other]);
  }
});

test("a letter variant is similar, never the same identity: CPT-1 vs CPT-1A", () => {
  const u = use("CPT-1", [sheet(SCHED, "CPT-1"), sheet("plan.pdf", "CPT-1A")]);
  assert.equal(u.state, "not-found");
  assert.deepEqual(u.similar, ["CPT-1A"]);
});

test("a hyphen variant is similar: P-1 vs P1", () => {
  const u = use("P-1", [sheet(SCHED, "P-1"), sheet("plan.pdf", "P1")]);
  assert.equal(u.state, "not-found");
  assert.deepEqual(u.similar, ["P1"]);
});

test("a suffixed code: another suffix on the base is similar, the same suffix written tight is found", () => {
  const other = use("G-01(C)", [sheet(SCHED, "G-01(C)"), sheet("plan.pdf", "G-01 (W)")]);
  assert.equal(other.state, "not-found");
  assert.deepEqual(other.similar, ["G-01"]);
  const tight = use("G-01(C)", [sheet(SCHED, "G-01(C)"), sheet("plan.pdf", "G-01(C)")]);
  assert.equal(tight.state, "found");
});

test("a combined callout's member is an exact occurrence: LVT-2 in CPT-1/LVT-2", () => {
  const u = use("LVT-2", [sheet(SCHED, "LVT-2"), sheet("plan.pdf", "CPT-1/LVT-2")]);
  assert.equal(u.state, "found");
  assert.deepEqual(u.found, [{ key: "plan.pdf", source: "text" }]);
});

test("a sheet not indexed yet leaves the code unchecked, never not-found", () => {
  const ixs = [sheet(SCHED, "CPT-1"), sheet("plan.pdf", "LOBBY")];
  const u = codeUse("CPT-1", { indexes: mapOf(...ixs), keys: [SCHED, "plan.pdf", "later.pdf"], sourceKey: SCHED });
  assert.equal(u.state, "unchecked");
  assert.equal(u.unchecked, 1);
  assert.equal(u.checked, 1);
});

test("a file whose page count isn't known yet counts as unchecked", () => {
  const u = use("CPT-1", [sheet(SCHED, "CPT-1"), sheet("plan.pdf", "LOBBY")], { unknownFiles: 2 });
  assert.equal(u.state, "unchecked");
  assert.equal(u.unchecked, 2);
});

test("a seeded entry is not a read: unchecked", () => {
  const seed: SheetIndex = { key: "plan.pdf", source: "text", terms: {}, tokenCount: 0, lineCount: 0, seeded: true };
  assert.equal(use("CPT-1", [sheet(SCHED, "CPT-1"), seed]).state, "unchecked");
});

test("pictures that failed to measure, or weren't measured, leave the sheet unchecked", () => {
  for (const pictures of ["failed", undefined] as const) {
    const vec: SheetIndex = { ...sheet("plan.pdf", "LOBBY"), pictures };
    const u = use("CPT-1", [sheet(SCHED, "CPT-1"), vec]);
    assert.equal(u.state, "unchecked", String(pictures));
  }
});

test("a scan with no read yet is unchecked; its read makes it checked, badged OCR", () => {
  const scan: SheetIndex = { ...buildSheetIndex("scan.pdf", [{ str: "SCANNER 01" }]), textLayer: false, pictures: [] };
  assert.equal(use("CPT-1", [sheet(SCHED, "CPT-1"), scan]).state, "unchecked");
  const read: SheetIndex = { ...buildSheetIndex("scan.pdf", [{ str: "CPT-1" }], "ocr"), textLayer: false, pictures: [] };
  const u = use("CPT-1", [sheet(SCHED, "CPT-1"), read]);
  assert.equal(u.state, "found");
  assert.deepEqual(u.found, [{ key: "scan.pdf", source: "ocr" }]);
});

test("a hybrid's read: a code on its text layer is badged text, one in its picture OCR", () => {
  const hybrid = (strs: string[], stray: Record<string, number>): SheetIndex => ({
    ...buildSheetIndex("hy.pdf", strs.map((str) => ({ str })), "ocr"), textLayer: true, pictures: [{ x0: 0, y0: 0, x1: 10, y1: 10 }], stray,
  });
  const onText = use("CPT-1", [sheet(SCHED, "CPT-1"), hybrid(["CPT-1", "LVT-2"], { "CPT-1": 1 })]);
  assert.deepEqual(onText.found, [{ key: "hy.pdf", source: "text" }]);
  const inPicture = use("LVT-2", [sheet(SCHED, "LVT-2"), hybrid(["CPT-1", "LVT-2"], { "CPT-1": 1 })]);
  assert.deepEqual(inPicture.found, [{ key: "hy.pdf", source: "ocr" }]);
});

test("the schedule's own sheet is never evidence by itself", () => {
  const u = use("CPT-1", [sheet(SCHED, "CPT-1", "CPT-1"), sheet("plan.pdf", "LOBBY")]);
  assert.equal(u.state, "not-found");
  assert.deepEqual(u.found, []);
});

test("source exclusion is by sheet key: the next page of the same PDF still counts", () => {
  const u = use("CPT-1", [sheet(SCHED, "CPT-1"), sheet("set.pdf#2", "CPT-1")]);
  assert.deepEqual(u.found.map((f) => f.key), ["set.pdf#2"]);
  // and the source's similar codes aren't reported either: CPT-12 only on the schedule
  const v = use("CPT-1", [sheet(SCHED, "CPT-1", "CPT-12"), sheet("set.pdf#2", "LOBBY")]);
  assert.deepEqual(v.similar, []);
});

test("with the box's own terms, the code elsewhere on the schedule's sheet is found there", () => {
  const src = sheet(SCHED, "CPT-1", "CPT-1", "LVT-2");
  const box = buildSheetIndex("box", [{ str: "CPT-1" }, { str: "LVT-2" }]).terms;
  const one = codeUse("CPT-1", { indexes: mapOf(src), keys: [SCHED], sourceKey: SCHED, boxTerms: box });
  assert.equal(one.state, "found");
  assert.deepEqual(one.found, [{ key: SCHED, source: "text", outsideBox: true }]);
  assert.match(codeUseLine(one).title, /schedule's sheet, outside the box/);
  // LVT-2 is only in the box: the rest of the sheet was checked and hasn't it
  const two = codeUse("LVT-2", { indexes: mapOf(src), keys: [SCHED], sourceKey: SCHED, boxTerms: box });
  assert.equal(two.state, "not-found");
  assert.equal(two.checked, 1);
});

test("with no other sheet and no box terms there is nothing to compare: unchecked", () => {
  const u = codeUse("CPT-1", { indexes: mapOf(sheet(SCHED, "CPT-1")), keys: [SCHED], sourceKey: SCHED });
  assert.equal(u.state, "unchecked");
  assert.equal(u.checked, 0);
});

test("a stitch key is never counted", () => {
  const ixs = [sheet(SCHED, "CPT-1"), sheet("plan.pdf", "LOBBY")];
  const u = codeUse("CPT-1", { indexes: mapOf(...ixs), keys: [SCHED, "plan.pdf", "stitch:abc"], sourceKey: SCHED });
  assert.equal(u.state, "not-found");
});

test("an edited code is looked up as typed: lower case and stray spaces don't matter", () => {
  assert.equal(use(" cpt-1 ", [sheet(SCHED, "CPT-1"), sheet("plan.pdf", "CPT-1")]).state, "found");
  assert.equal(use("", [sheet(SCHED, "CPT-1"), sheet("plan.pdf", "CPT-1")]).state, "unchecked");
});

test("a code the index can't hold (one letter) is uncheckable, never not-found", () => {
  const u = use("C", [sheet(SCHED, "C"), sheet("plan.pdf", "LOBBY")]);
  assert.equal(u.state, "unchecked");
  assert.equal(u.uncheckable, true);
  assert.match(codeUseLine(u).text, /can't check/);
});

test("codeUseLine: the row's words never say unused", () => {
  const notFound = codeUseLine({ state: "not-found", found: [], similar: ["CPT-12"], checked: 3, unchecked: 0 });
  assert.match(notFound.text, /not found in checked text/);
  assert.match(notFound.title, /CPT-12/);
  const unchecked = codeUseLine({ state: "unchecked", found: [], similar: [], checked: 1, unchecked: 4 });
  assert.match(unchecked.text, /4 sheets not checked/);
  const found = codeUseLine({ state: "found", found: [{ key: "a.pdf", source: "text" }, { key: "b.pdf", source: "ocr" }], similar: [], checked: 2, unchecked: 0 }, (k) => k.toUpperCase());
  assert.match(found.text, /on 2 sheets/);
  assert.match(found.title, /B\.PDF \(OCR\)/);
  for (const l of [notFound, unchecked, found]) assert.doesNotMatch(`${l.text} ${l.title}`, /unused/i);
});
