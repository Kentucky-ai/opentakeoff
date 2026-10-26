// #483 PR A: NOT USED / N.I.C. rows. The light helpers
// in lib/notUsed.ts, and what a drawn box reads for each printed form — in
// the key cell after the code, as a whole non-key cell, and as separate
// key-column words. A marked row starts unticked and says why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeNotUsed, notUsedKind, notUsedNote } from "../src/lib/notUsed.ts";
import { readScheduleSpans, type ScheduleRead } from "../src/lib/scheduleRead.ts";
import { readFinishTable, type GraphSpan } from "../src/lib/sheetgraph.ts";
import type { ScheduleRow } from "../src/lib/scheduleRows.ts";
import { build, sp, M, MMC, H, STD, COLS, PITCH, CW, R, KEYLINE, type Item } from "./fixtures/reader483Fixtures.ts";

const has = (o: object, f: string) => Object.prototype.hasOwnProperty.call(o, f);
const keys = (r: ScheduleRead) => r.rows.map((x) => x.finish_tag);
const rowOf = (r: ScheduleRead, k: string): ScheduleRow => {
  const hit = r.rows.find((x) => x.finish_tag === k);
  assert.ok(hit, `row ${k} in ${JSON.stringify(keys(r))}`);
  return hit;
};
const read = (items: Item[], cols = MMC) => readScheduleSpans(build({ cols, items }));
const CPT1 = M("CPT-1", "BROADLOOM CARPET", "VENDOR-A", "GREY 101");
const RB1 = M("RB-1", "RUBBER BASE", "VENDOR-B", "BLACK 505");
const PT1 = M("PT-1", "PAINT", "VENDOR-E", "WHITE 601");
function assertUnticked(r: ScheduleRow, text: string, where: string) {
  assert.equal(r.suggested, false, `${where}: suggested`);
  assert.equal(r.unticked_reason, "not-used", `${where}: unticked_reason`);
  assert.equal(r.not_used_text, text, `${where}: not_used_text`);
}
function assertTicked(r: ScheduleRow, where: string) {
  assert.equal(r.suggested, true, `${where}: suggested`);
  for (const f of ["unticked_reason", "not_used_text"]) assert.ok(!has(r, f), `${where}: no ${f}`);
}

/** every printed form → what it normalizes to, and the text kept (leading separators stripped) */
const FORMS: Array<[string, "NOT USED" | "NOT IN CONTRACT" | "NIC", string]> = [
  ["NOT USED", "NOT USED", "NOT USED"], ["(NOT USED)", "NOT USED", "(NOT USED)"], ["NOT USED.", "NOT USED", "NOT USED."],
  ["(NOT USED.)", "NOT USED", "(NOT USED.)"], ["- NOT USED", "NOT USED", "NOT USED"], ["NOT IN CONTRACT", "NOT IN CONTRACT", "NOT IN CONTRACT"],
  ["NIC", "NIC", "NIC"], ["NIC.", "NIC", "NIC."], ["N.I.C.", "NIC", "N.I.C."], ["(N.I.C.)", "NIC", "(N.I.C.)"], ["N. I. C.", "NIC", "N. I. C."],
];

// ── lib/notUsed.ts ──────────────────────────────────────────────────────────
test("normalizeNotUsed: every printed form, lower case too; prose and longer text → null", () => {
  for (const [form, want] of FORMS) {
    assert.equal(normalizeNotUsed(form), want, form);
    assert.equal(normalizeNotUsed(form.toLowerCase()), want, form.toLowerCase());
  }
  for (const no of ["", "USED", "NOT", "NOT USED IN AREA B", "SEE NOTE", "NICHE", "(NOT) USED", "NOT USED (C)", "NIC TILE", "CONTRACT"]) assert.equal(normalizeNotUsed(no), null, no);
});

test("notUsedKind: NOT USED → not-used; NOT IN CONTRACT / N.I.C. → not-in-contract; else null", () => {
  for (const [form, n] of FORMS) assert.equal(notUsedKind(form), n === "NOT USED" ? "not-used" : "not-in-contract", form);
  assert.equal(notUsedKind("CARPET"), null);
});

test("notUsedNote: the label's note per kind and state", () => {
  assert.equal(notUsedNote("not-used", { pickable: true, picked: false }), " The schedule marks this row not used. Select it to create a condition anyway.");
  assert.equal(notUsedNote("not-used", { pickable: true, picked: true }), " The schedule marks this row not used.");
  assert.equal(notUsedNote("not-used", { pickable: false, picked: false }), " The schedule marks this row not used.");
  assert.equal(notUsedNote("not-in-contract", { pickable: true, picked: false }), " The schedule marks this row N.I.C. (not in contract). Select it to create a condition anyway.");
  assert.equal(notUsedNote("not-in-contract", { pickable: true, picked: true }), " The schedule marks this row N.I.C. (not in contract).");
  assert.equal(notUsedNote("not-in-contract", { pickable: false, picked: true }), " The schedule marks this row N.I.C. (not in contract).");
});

// ── the reader ──────────────────────────────────────────────────────────────
test("every form in the key cell after the code → the code, unticked, the marker as printed", () => {
  for (const [form, , text] of FORMS) {
    const r = read([CPT1, M(`CPT-2 ${form}`, "MODULAR CARPET TILE", "VENDOR-A", "BLUE 202"), RB1]);
    assert.deepEqual(keys(r), ["CPT-1", "CPT-2", "RB-1"], form);
    assertUnticked(rowOf(r, "CPT-2"), text, form);
    assert.equal(rowOf(r, "CPT-2").description, "MODULAR CARPET TILE", `${form}: the marker is not a description prefix`);
    assertTicked(rowOf(r, "CPT-1"), form);
  }
});

test("key forms CPT-2: NOT USED and CPT-2, NIC → CPT-2, unticked; side by side → both", () => {
  const a = read([CPT1, M("CPT-2: NOT USED", "CARPET", "", ""), RB1]);
  assertUnticked(rowOf(a, "CPT-2"), "NOT USED", "CPT-2: NOT USED");
  const b = read([CPT1, M("CPT-2, NIC", "CARPET", "", ""), RB1]);
  assertUnticked(rowOf(b, "CPT-2"), "NIC", "CPT-2, NIC");
  const both = read([CPT1, M("CPT-2: NOT USED", "CARPET", "", ""), M("CPT-3, NIC", "CARPET", "", ""), RB1]);
  assert.deepEqual(keys(both), ["CPT-1", "CPT-2", "CPT-3", "RB-1"]);
  assertUnticked(rowOf(both, "CPT-2"), "NOT USED", "both: CPT-2");
  assertUnticked(rowOf(both, "CPT-3"), "NIC", "both: CPT-3");
});

test("CPT-2 NIC (keyed CPT-2NIC today) → CPT-2, re-keyed in place: unticked, no key_rule", () => {
  const r = read([CPT1, M("CPT-2 NIC", "CARPET TILE", "VENDOR-A", "BLUE"), RB1]);
  assert.deepEqual(keys(r), ["CPT-1", "CPT-2", "RB-1"]);
  assertUnticked(rowOf(r, "CPT-2"), "NIC", "CPT-2 NIC");
  assert.ok(!has(rowOf(r, "CPT-2"), "key_rule"));
});

test("CPT-2 NIC with a key-column wrap (4\") COVE 19 px under it → CPT-2 (its first token), unticked", () => {
  const r = read([CPT1, M("CPT-2 NIC", "CARPET TILE", "VENDOR-A", "BLUE"), { t: "wrap", col: "CODE", text: '(4") COVE' }, RB1]);
  assert.deepEqual(keys(r), ["CPT-1", "CPT-2", "RB-1"]);
  assertUnticked(rowOf(r, "CPT-2"), "NIC", "wrap");
});

test("every form as a whole non-key cell — MATERIAL, DESCRIPTION, REMARKS only, SIZE → unticked, the cell as printed", () => {
  for (const [form, , text] of FORMS) {
    const mat = read([CPT1, { t: "row", key: "CPT-2", cells: { MATERIAL: form } }, RB1]);
    assertUnticked(rowOf(mat, "CPT-2"), text, `MATERIAL ${form}`);
    const desc = readScheduleSpans(build({ cols: ["DESCRIPTION", "MANUFACTURER", "COLOR"], items: [
      { t: "row", key: "CPT-1", cells: { DESCRIPTION: "CARPET", MANUFACTURER: "VENDOR-A", COLOR: "GREY" } },
      { t: "row", key: "CPT-2", cells: { DESCRIPTION: form } },
      { t: "row", key: "RB-1", cells: { DESCRIPTION: "RUBBER BASE", MANUFACTURER: "VENDOR-B", COLOR: "BLACK" } },
    ] }));
    assertUnticked(rowOf(desc, "CPT-2"), text, `DESCRIPTION ${form}`);
    const rem = read([R("CPT-1", "CARPET", "VENDOR-A", "LOOP", "GREY"), { t: "row", key: "CPT-2", cells: { REMARKS: form } }, R("RB-1", "RUBBER BASE", "VENDOR-B", "COVE", "BLACK")], STD);
    assertUnticked(rowOf(rem, "CPT-2"), text, `REMARKS ${form}`);
    const size = read([R("CPT-1", "CARPET", "VENDOR-A", "LOOP", "GREY", "12'"), R("CPT-2", "CARPET TILE", "VENDOR-A", "GRID", "BLUE", form), R("RB-1", "RUBBER BASE", "VENDOR-B", "COVE", "BLACK", '4"')], STD);
    assertUnticked(rowOf(size, "CPT-2"), text, `SIZE ${form}`);
    assertTicked(rowOf(size, "CPT-1"), `SIZE ${form}`);
  }
});

test("a whole-cell marker is read on whole-sheet-shaped tables too, and the whole-sheet read keeps no flag", () => {
  const spans = build({ cols: MMC, items: [CPT1, { t: "row", key: "CPT-2", cells: { MATERIAL: "NOT USED" } }, RB1] });
  assertUnticked(rowOf(readScheduleSpans(spans), "CPT-2"), "NOT USED", "MATERIAL");
  const plain = readFinishTable({ key: "fx", spans }, { marquee: true })!.table.rows;
  for (const r of plain) for (const f of ["notUsed", "notUsedText"]) assert.ok(!has(r, f));
});

test("word-split CPT-2 | NOT | USED in the key column → CPT-2 unticked; no token moves", () => {
  const spans = build({ cols: MMC, items: [CPT1, M("CPT-2", "CARPET TILE", "VENDOR-A", "BLUE"), RB1] });
  const at = spans.findIndex((s) => s.str === "CPT-2");
  const y = spans[at].y;
  spans.splice(at, 1, sp("CPT-2", COLS.KEY, y), sp("NOT", COLS.KEY + 6 * CW, y), sp("USED", COLS.KEY + 10 * CW, y));
  const r = readScheduleSpans(spans);
  assert.deepEqual(keys(r), ["CPT-1", "CPT-2", "RB-1"]);
  assertUnticked(rowOf(r, "CPT-2"), "NOT USED", "word-split");
  assert.equal(rowOf(r, "CPT-2").description, "CARPET TILE");
  // other key-column words after the code are not a marker: today
  const other = build({ cols: MMC, items: [CPT1, M("CPT-2", "CARPET TILE", "VENDOR-A", "BLUE"), RB1] });
  const p = other.findIndex((s) => s.str === "CPT-2");
  other.splice(p, 1, sp("CPT-2", COLS.KEY, y), sp("NOT", COLS.KEY + 6 * CW, y), sp("YET", COLS.KEY + 10 * CW, y));
  assertTicked(rowOf(readScheduleSpans(other), "CPT-2"), "word-split NOT YET");
});

test("PLAM-1 NOT USED first under MILLWORK → kept, under MILLWORK, unticked", () => {
  const r = read([CPT1, H("MILLWORK"), KEYLINE("PLAM-1 NOT USED"), M("PLAM-2", "PLASTIC LAMINATE", "VENDOR-G", "WHITE")]);
  assert.deepEqual(keys(r), ["CPT-1", "PLAM-1", "PLAM-2"]);
  assert.equal(rowOf(r, "PLAM-1").section, "MILLWORK");
  assertUnticked(rowOf(r, "PLAM-1"), "NOT USED", "PLAM-1");
});

test("one coded row + four NOT USED rows (two NIC forms) → five rows", () => {
  const r = read([CPT1, KEYLINE("CPT-2 NOT USED"), KEYLINE("CPT-3 NIC"), KEYLINE("CPT-4 N.I.C."), KEYLINE("CPT-5 NOT USED")]);
  assert.deepEqual(keys(r), ["CPT-1", "CPT-2", "CPT-3", "CPT-4", "CPT-5"]);
  for (const [k, text] of [["CPT-2", "NOT USED"], ["CPT-3", "NIC"], ["CPT-4", "N.I.C."], ["CPT-5", "NOT USED"]]) assertUnticked(rowOf(r, k), text, k);
  assertTicked(rowOf(r, "CPT-1"), "CPT-1");
});

test("a lone CPT-2 NOT USED under FLOORING: it and the rows below it stay FLOORING", () => {
  const r = read([H("FLOORING"), CPT1, KEYLINE("CPT-2 NOT USED"), M("CPT-3", "CARPET TILE", "VENDOR-A", "BLUE"), M("LVT-1", "LUXURY VINYL TILE", "VENDOR-B", "OAK")]);
  assert.deepEqual(keys(r), ["CPT-1", "CPT-2", "CPT-3", "LVT-1"]);
  for (const k of keys(r)) assert.equal(rowOf(r, k).section, "FLOORING", k);
  const plain = readFinishTable({ key: "fx", spans: build({ cols: MMC, items: [H("FLOORING"), CPT1, KEYLINE("CPT-2 NOT USED"), M("CPT-3", "CARPET TILE", "VENDOR-A", "BLUE")] }) }, { marquee: true })!.table.rows;
  assert.equal(plain.find((x) => x.key === "CPT-3")!.section, undefined, "today the lone line ends the section");
});

test("CPT-4 NOT USED as the last row: a GENERAL NOTES block 600 px below, or a note 4 pitches below, never joins it", () => {
  const items: Item[] = [CPT1, M("CPT-2", "CARPET TILE", "VENDOR-A", "BLUE"), M("CPT-3", "CARPET TILE", "VENDOR-A", "GREEN"), M("CPT-4 NOT USED", "CARPET TILE", "VENDOR-A", "RED")];
  const far = build({ cols: MMC, items });
  const lastY = Math.max(...far.map((s) => s.y));
  far.push(sp("GENERAL NOTES", COLS.KEY, lastY + 600), sp("1. ALL FINISHES PER SPEC", COLS.KEY, lastY + 600 + PITCH), sp("2. SEE A-601", COLS.KEY, lastY + 600 + 2 * PITCH));
  const near = build({ cols: MMC, items });
  near.push(sp("SEE NOTE 3", COLS.MATERIAL, lastY + 4 * PITCH));
  for (const [name, spans] of [["notes 600 px below", far], ["a note 4 pitches below", near]] as Array<[string, GraphSpan[]]>) {
    const r = readScheduleSpans(spans);
    assert.deepEqual(keys(r), ["CPT-1", "CPT-2", "CPT-3", "CPT-4"], name);
    assert.equal(rowOf(r, "CPT-4").description, "CARPET TILE", name);
    assertUnticked(rowOf(r, "CPT-4"), "NOT USED", name);
  }
});

test("prose and longer tails read as today: CPT-2 NOT USED IN AREA B (key cell), NOT USED IN AREA B (cell)", () => {
  const key = read([CPT1, M("CPT-2 NOT USED IN AREA B", "CARPET", "", ""), RB1]);
  assert.deepEqual(keys(key), ["CPT-1", "RB-1"]);
  for (const r of key.rows) assertTicked(r, "key prose");
  const cell = read([CPT1, { t: "row", key: "CPT-2", cells: { MATERIAL: "NOT USED IN AREA B" } }, RB1]);
  assertTicked(rowOf(cell, "CPT-2"), "cell prose");
});

test("normal rows: suggested true, no unticked_reason / not_used_text", () => {
  const r = read([CPT1, RB1, PT1]);
  for (const x of r.rows) assertTicked(x, x.finish_tag);
});

test("the whole-sheet twin with MATERIAL NOT USED, through a drawn box: CPT-2 unticked; legacy (w = 0) tokens read the same", async () => {
  const { TWINS, legacyTokens } = await import("./fixtures/reader483Fixtures.ts");
  const { parseSchedule } = await import("../src/lib/scheduleRead.ts");
  const t = TWINS.find((x) => x.name === "ws-material-not-used")!;
  assertUnticked(rowOf(readScheduleSpans(t.spans), "CPT-2"), "NOT USED", t.name);
  const legacy = parseSchedule(legacyTokens(t.spans));
  assertUnticked(legacy.find((x) => x.finish_tag === "CPT-2")!, "NOT USED", `${t.name} legacy`);
  const keyTail = parseSchedule(legacyTokens(build({ cols: MMC, items: [CPT1, M("CPT-2 (N.I.C.)", "CARPET", "", ""), RB1] })));
  assertUnticked(keyTail.find((x) => x.finish_tag === "CPT-2")!, "(N.I.C.)", "legacy key tail");
});
