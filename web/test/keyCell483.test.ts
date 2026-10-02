// #483 PR A: the key cell under the marquee rules. A drawn
// box reads pass 1 (today's reader), decides new rows and re-keys from pass
// 1's data, then reads pass 2:
//   - a code printed with a word after it ("FTB-01 CUT (C)") keys a row on the
//     code, the word riding as a description prefix (the qualifier split);
//   - a code whose tail says NOT USED / NIC keys on the code;
//   - a glued code today's reader keys ("P-1SAT") splits only when nothing
//     else in the read would clash with it (the collision rule);
//   - a key-column line merged into the row above is unglued into its own row
//     when it sits a full line below it (an unglue candidate), and its wrap
//     lines go with it;
//   - only lines inside the table's run count.
// Whole-sheet reads never change (reader483Goldens.test.ts pins them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFinishMarquee, readFinishTable, extractTable, type GraphSpan, type TableRow } from "../src/lib/sheetgraph.ts";
import { readScheduleSpans, type ScheduleRead } from "../src/lib/scheduleRead.ts";
import type { ScheduleRow } from "../src/lib/scheduleRows.ts";
import { build, sp, M, MMC, H, PITCH, TH, CW, COLS, TWINS, CURRENT_SLICE, type Item, type BuildOpts } from "./fixtures/reader483Fixtures.ts";

const sheet = (spans: GraphSpan[]) => ({ key: "crop", spans });
const has = (o: object, f: string) => Object.prototype.hasOwnProperty.call(o, f);
const spansOf = (items: Item[], o: Partial<BuildOpts> = {}) => build({ cols: MMC, items, ...o });
const read = (items: Item[], o: Partial<BuildOpts> = {}) => readScheduleSpans(spansOf(items, o));
const keys = (r: ScheduleRead) => r.rows.map((x) => x.finish_tag);
const rowOf = (r: ScheduleRead, k: string, n = 0): ScheduleRow => {
  const hit = r.rows.filter((x) => x.finish_tag === k)[n];
  assert.ok(hit, `row ${k}#${n} in ${JSON.stringify(keys(r))}`);
  return hit;
};
/** the marquee table's rows */
const mrows = (spans: GraphSpan[]): TableRow[] => {
  const m = readFinishMarquee(sheet(spans));
  assert.ok(m && m.kind === "table", JSON.stringify(m));
  return m.table.rows;
};
/** nothing changes: the marquee-rules table reads exactly what today's plain marquee read reads */
function unchanged(spans: GraphSpan[], where: string) {
  const plain = readFinishTable(sheet(spans), { marquee: true });
  const m = readFinishMarquee(sheet(spans));
  if (!plain) { assert.ok(!m || m.kind === "headerOnly", `${where}: no table`); return; }
  assert.ok(m && m.kind !== "headerOnly", where);
  assert.deepStrictEqual(m.table.rows, plain.table.rows, where);
  for (const r of m.table.rows) for (const f of ["qualifier", "notUsed", "notUsedText", "keyRule"]) assert.ok(!has(r, f), `${where}: ${r.key} has no ${f}`);
}

// invented rows in CODE | MATERIAL | MANUFACTURER | COLOR
const CPT1 = M("CPT-1", "BROADLOOM CARPET", "VENDOR-A", "GREY 101");
const CPT2 = M("CPT-2", "MODULAR CARPET TILE", "VENDOR-A", "BLUE 202");
const LVT1 = M("LVT-1", "LUXURY VINYL TILE", "VENDOR-B", "OAK 303");
const VCT1 = M("VCT-1", "VINYL COMPOSITION TILE", "VENDOR-C", "WHITE 404");
const RB1 = M("RB-1", "RUBBER BASE", "VENDOR-B", "BLACK 505");
const RB2 = M("RB-2", "RESILIENT BASE", "VENDOR-B", "GREY 506");
const PT1 = M("PT-1", "PAINT", "VENDOR-E", "WHITE 601");
const PT2 = M("PT-2", "PAINT", "VENDOR-E", "TAUPE 602");
const FTB = (key: string, mat = "TILE BASE") => M(key, mat, "VENDOR-F", "WHITE 603");
const CODED = [CPT1, CPT2, LVT1, VCT1, RB1, RB2, PT1, PT2];

// ── the qualifier split: eligible lines always split ─────────────────────
test("FTB-01 CUT (C) between coded rows → FTB-01, description `CUT (C) — TILE BASE`, key_rule extended", () => {
  const r = read([CPT1, FTB("FTB-01 CUT (C)"), PT1]);
  assert.deepEqual(keys(r), ["CPT-1", "FTB-01", "PT-1"]);
  const f = rowOf(r, "FTB-01");
  assert.equal(f.description, "CUT (C) — TILE BASE");
  assert.equal(f.key_rule, "extended");
  assert.equal(f.manufacturer, "VENDOR-F");
  // the row it was merged into today reads without it
  assert.equal(rowOf(r, "CPT-1").description, "BROADLOOM CARPET");
  assert.ok(!has(rowOf(r, "CPT-1"), "key_rule"));
  assert.ok(!has(rowOf(r, "PT-1"), "key_rule"));
});

test("FTB-02 COVE → FTB-02, description `COVE — TILE BASE`", () => {
  const r = read([CPT1, FTB("FTB-02 COVE"), PT1]);
  assert.deepEqual(keys(r), ["CPT-1", "FTB-02", "PT-1"]);
  assert.equal(rowOf(r, "FTB-02").description, "COVE — TILE BASE");
});

test("a 6-row FTB block between 1+1, 1+2, 2+1 and 4+4 coded rows reads all six", () => {
  const block = ["FTB-01 CUT (C)", "FTB-02 COVE", "FTB-03 CUT", "FTB-04 COVE (C)", "FTB-05 CUT", "FTB-06 COVE"].map((k) => FTB(k));
  const want = ["FTB-01", "FTB-02", "FTB-03", "FTB-04", "FTB-05", "FTB-06"];
  for (const [a, b] of [[1, 1], [1, 2], [2, 1], [4, 4]]) {
    const above = CODED.slice(0, a), below = CODED.slice(4, 4 + b);
    const r = read([...above, ...block, ...below]);
    assert.deepEqual(keys(r), [...keysOfItems(above), ...want, ...keysOfItems(below)], `${a}+${b}`);
    for (const k of want) assert.equal(rowOf(r, k).key_rule, "extended", `${a}+${b} ${k}`);
  }
});
function keysOfItems(items: Item[]) { return items.flatMap((i) => (i.t === "row" ? [i.key] : [])); }

test("2 coded rows with 2 FTB rows between → 4 rows", () => {
  const r = read([CPT1, FTB("FTB-01 CUT (C)"), FTB("FTB-02 COVE"), PT1]);
  assert.deepEqual(keys(r), ["CPT-1", "FTB-01", "FTB-02", "PT-1"]);
});

test("FTB-01 CUT + FTB-01 COVE, both new → two FTB-01 rows (the dialog flags the later one duplicate)", () => {
  const r = read([CPT1, FTB("FTB-01 CUT"), FTB("FTB-01 COVE"), PT1]);
  assert.deepEqual(keys(r), ["CPT-1", "FTB-01", "FTB-01", "PT-1"]);
  assert.equal(rowOf(r, "FTB-01", 0).description, "CUT — TILE BASE");
  assert.equal(rowOf(r, "FTB-01", 1).description, "COVE — TILE BASE");
});

test("FTB-01 (CUT) (C) → splits, qualifier `(CUT) (C)`", () => {
  const r = read([CPT1, FTB("FTB-01 (CUT) (C)"), PT1]);
  assert.equal(rowOf(r, "FTB-01").description, "(CUT) (C) — TILE BASE");
  const t = mrows(spansOf([CPT1, FTB("FTB-01 (CUT) (C)"), PT1]));
  assert.equal(t.find((x) => x.key === "FTB-01")!.qualifier, "(CUT) (C)");
});

test("keyed FTB lines whose cells hold header words are rows: FTB-01 CUT (C) | WALL BASE, FTB-02 COVE | BASE", () => {
  const r = read([CPT1, M("FTB-01 CUT (C)", "WALL BASE", "", ""), M("FTB-02 COVE", "BASE", "", ""), PT1]);
  assert.deepEqual(keys(r), ["CPT-1", "FTB-01", "FTB-02", "PT-1"]);
});

test("TB-1 CUT | CT-1 | G-1 (a glued code today keys) → row TB-1", () => {
  const r = read([CPT1, M("TB-1 CUT", "CT-1", "G-1", ""), PT1]);
  assert.deepEqual(keys(r), ["CPT-1", "TB-1", "PT-1"]);
  assert.ok(!has(rowOf(r, "TB-1"), "key_rule"), "a re-keyed pass-1 row carries no key_rule");
});

// ── the collision rule on pass-1 rows ───────────────────────────────
test("collision rule: a lone P-1 SAT splits to P-1 with qualifier SAT (no key_rule)", () => {
  const r = read([CPT1, M("P-1 SAT", "PAINT", "VENDOR-E", "WHITE 601"), RB1]);
  assert.deepEqual(keys(r), ["CPT-1", "P-1", "RB-1"]);
  assert.equal(rowOf(r, "P-1").description, "SAT — PAINT");
  assert.ok(!has(rowOf(r, "P-1"), "key_rule"));
});

test("collision rule: P-1 SAT + P-1 EGG keep today's P-1SAT, P-1EGG", () => {
  const r = read([CPT1, M("P-1 SAT", "PAINT", "VENDOR-E", "WHITE 601"), M("P-1 EGG", "PAINT", "VENDOR-E", "WHITE 601"), RB1]);
  assert.deepEqual(keys(r), ["CPT-1", "P-1SAT", "P-1EGG", "RB-1"]);
  assert.equal(rowOf(r, "P-1SAT").description, "PAINT");
});

test("collision rule: CPT-1 + CPT-1 ALT → CPT-1, CPT-1ALT; CPT-1 (ALT) alone → CPT-1ALT", () => {
  assert.deepEqual(keys(read([CPT1, M("CPT-1 ALT", "CARPET TILE", "VENDOR-A", "GREY"), RB1])), ["CPT-1", "CPT-1ALT", "RB-1"]);
  assert.deepEqual(keys(read([CPT2, M("CPT-1 (ALT)", "CARPET TILE", "VENDOR-A", "GREY"), RB1])), ["CPT-2", "CPT-1ALT", "RB-1"]);
});

test("collision rule: CPT-1 TYP + CPT-1 ALT → CPT-1, CPT-1ALT (ALT-blocked rows leave the twin check first)", () => {
  const r = read([M("CPT-1 TYP", "BROADLOOM CARPET", "VENDOR-A", "GREY 101"), M("CPT-1 ALT", "CARPET TILE", "VENDOR-A", "GREY"), RB1]);
  assert.deepEqual(keys(r), ["CPT-1", "CPT-1ALT", "RB-1"]);
  assert.equal(rowOf(r, "CPT-1").description, "TYP — BROADLOOM CARPET");
});

test("collision rule: RB-1 CUT alone → RB-1 + CUT; CPT-1 TYP alone → CPT-1 + TYP", () => {
  const a = read([CPT2, M("RB-1 CUT", "RUBBER BASE", "VENDOR-B", "BLACK 505"), PT1]);
  assert.deepEqual(keys(a), ["CPT-2", "RB-1", "PT-1"]);
  assert.equal(rowOf(a, "RB-1").description, "CUT — RUBBER BASE");
  const b = read([M("CPT-1 TYP", "BROADLOOM CARPET", "VENDOR-A", "GREY 101"), RB1, PT1]);
  assert.deepEqual(keys(b), ["CPT-1", "RB-1", "PT-1"]);
  assert.equal(rowOf(b, "CPT-1").description, "TYP — BROADLOOM CARPET");
});

test("collision rule: P-1 SAT beside a plain P-1 row → P-1SAT kept (the split key collides)", () => {
  const r = read([M("P-1", "PAINT", "VENDOR-E", "WHITE 601"), M("P-1 SAT", "PAINT", "VENDOR-E", "WHITE 601"), RB1]);
  assert.deepEqual(keys(r), ["P-1", "P-1SAT", "RB-1"]);
});

test("collision rule: a pass-1 FT-1 CUT beside a new FT-1 COVE (C) line → FT-1CUT kept glued, the new row FT-1", () => {
  const r = read([CPT1, M("FT-1 CUT", "TILE BASE", "VENDOR-F", "WHITE"), M("FT-1 COVE (C)", "TILE BASE", "VENDOR-F", "WHITE"), PT1]);
  assert.deepEqual(keys(r), ["CPT-1", "FT-1CUT", "FT-1", "PT-1"]);
  assert.equal(rowOf(r, "FT-1").key_rule, "extended");
  assert.ok(!has(rowOf(r, "FT-1CUT"), "key_rule"));
});

test("today's keys kept: LVT-1 A, PT-2 B, WC-2 HD, RB-1 4\", SC-1 (C)", () => {
  for (const [form, want] of [["LVT-1 A", "LVT-1A"], ["PT-2 B", "PT-2B"], ["WC-2 HD", "WC-2HD"], ['RB-1 4"', "RB-14"], ["SC-1 (C)", "SC-1C"]]) {
    const spans = spansOf([CPT1, M(form, "PORCELAIN TILE", "VENDOR-F", "WHITE 603"), PT2]);
    assert.deepEqual(keys(readScheduleSpans(spans)), ["CPT-1", want, "PT-2"], form);
    unchanged(spans, form);
  }
});

test("an 8-row SAT/EGG table → today's 8 keys", () => {
  const items = ["P-1 SAT", "P-1 EGG", "P-2 SAT", "P-2 EGG", "P-3 SAT", "P-3 EGG", "P-4 SAT", "P-4 EGG"].map((k) => M(k, "PAINT", "VENDOR-E", "WHITE"));
  const spans = spansOf(items);
  assert.deepEqual(keys(readScheduleSpans(spans)), ["P-1SAT", "P-1EGG", "P-2SAT", "P-2EGG", "P-3SAT", "P-3EGG", "P-4SAT", "P-4EGG"]);
  unchanged(spans, "SAT/EGG");
});

test("P-1 SAT + P-1 NIC → P-1SAT and a P-1 re-keyed from its NIC tail", () => {
  const r = read([CPT1, M("P-1 SAT", "PAINT", "VENDOR-E", "WHITE 601"), M("P-1 NIC", "PAINT", "VENDOR-E", "WHITE 601"), RB1]);
  assert.deepEqual(keys(r), ["CPT-1", "P-1SAT", "P-1", "RB-1"]);
});

test("tight pair (CPT-1 /, CPT-1A 18 px under it) above a lone P-1 SAT → unchanged apart from the P-1 split", () => {
  const spans = spansOf([M("CPT-1 /", "BROADLOOM CARPET", "VENDOR-A", "GREY"), { t: "under", dy: 18, key: "CPT-1A", cells: { MATERIAL: "CARPET TILE" } }, RB1, M("P-1 SAT", "PAINT", "VENDOR-E", "WHITE 601")]);
  const plain = readFinishTable(sheet(spans), { marquee: true })!.table.rows;
  const now = mrows(spans);
  assert.deepEqual(now.map((r) => r.key), ["CPT-1", "CPT-1A", "RB-1", "P-1"]);
  assert.deepStrictEqual(now.slice(0, 3), plain.slice(0, 3));
  const { key: _k, qualifier, ...restNow } = now[3];
  const { key: _p, ...restPlain } = plain[3];
  assert.equal(qualifier, "SAT");
  assert.deepStrictEqual(restNow, restPlain);
});

// ── provenance ──────────────────────────────────────────────────────────────
test("provenance: a new CT-1 COVE line above a pass-1 CT-1 floor row → the floor row has no key_rule, the new row key_rule extended", () => {
  const r = read([CPT1, M("CT-1 COVE", "CERAMIC TILE BASE", "VENDOR-F", "WHITE"), M("CT-1", "CERAMIC TILE", "VENDOR-F", "WHITE"), PT1]);
  assert.deepEqual(keys(r), ["CPT-1", "CT-1", "CT-1", "PT-1"]);
  assert.equal(rowOf(r, "CT-1", 0).key_rule, "extended");
  assert.equal(rowOf(r, "CT-1", 0).category, "base");
  assert.ok(!has(rowOf(r, "CT-1", 1), "key_rule"));
  const t = mrows(spansOf([CPT1, M("CT-1 COVE", "CERAMIC TILE BASE", "VENDOR-F", "WHITE"), M("CT-1", "CERAMIC TILE", "VENDOR-F", "WHITE"), PT1]));
  assert.equal(t[1].keyRule, "extended");
  assert.ok(!has(t[2], "keyRule"));
});

// ── unglue: what a line takes with it, and what stays merged ────────────────
test("the row above loses the unglued line: FT-01 cells hold no FTB tokens", () => {
  const t = mrows(spansOf([M("FT-01", "PORCELAIN TILE", "VENDOR-F", "WHITE"), FTB("FTB-01 CUT (C)"), PT1]));
  assert.deepEqual(t.map((x) => x.key), ["FT-01", "FTB-01", "PT-1"]);
  assert.ok(!Object.values(t[0].cells).some((c) => /FTB|TILE BASE/.test(c.text)), JSON.stringify(t[0].cells));
});

test("continuation in a short table: RB-1@38, FTB-01 CUT (C) | CERAMIC TILE@76, wrap BASE TRIM@95, PT-1@133 → FTB-01 holds the wrap", () => {
  const spans = spansOf([RB1, M("FTB-01 CUT (C)", "CERAMIC TILE", "VENDOR-F", "WHITE"), { t: "wrap", col: "MATERIAL", text: "BASE TRIM" }]);
  spans.push(sp("PT-1", COLS.KEY, 133), sp("PAINT", COLS.MATERIAL, 133), sp("VENDOR-E", COLS.MANUFACTURER, 133), sp("WHITE 601", COLS.COLOR, 133));
  const r = readScheduleSpans(spans);
  assert.deepEqual(keys(r), ["RB-1", "FTB-01", "PT-1"]);
  assert.equal(rowOf(r, "FTB-01").description, "CUT (C) — CERAMIC TILE BASE TRIM");
  assert.equal(rowOf(r, "PT-1").description, "PAINT");
  assert.equal(rowOf(r, "RB-1").description, "RUBBER BASE");
});

test("continuation in a short table, the next row 57 px below the wrap: the wrap still goes with FTB-01", () => {
  const spans = spansOf([RB1, M("FTB-01 CUT (C)", "CERAMIC TILE", "VENDOR-F", "WHITE"), { t: "wrap", col: "MATERIAL", text: "BASE TRIM" }]);
  spans.push(sp("PT-1", COLS.KEY, 95 + 57), sp("PAINT", COLS.MATERIAL, 95 + 57), sp("VENDOR-E", COLS.MANUFACTURER, 95 + 57), sp("WHITE 601", COLS.COLOR, 95 + 57));
  const r = readScheduleSpans(spans);
  assert.deepEqual(keys(r), ["RB-1", "FTB-01", "PT-1"]);
  assert.equal(rowOf(r, "FTB-01").description, "CUT (C) — CERAMIC TILE BASE TRIM");
  assert.equal(rowOf(r, "PT-1").description, "PAINT");
  assert.equal(rowOf(r, "RB-1").description, "RUBBER BASE");
});

test("attached-close negatives: PT-2 SEMIGLOSS and CPT-2 NOT USED 19 px under a row of a 38 px table stay merged", () => {
  for (const text of ["PT-2 SEMIGLOSS", "CPT-2 NOT USED", "PT-2 SATIN"]) {
    const spans = spansOf([CPT1, PT1, { t: "wrap", col: "CODE", text }, RB1, RB2]);
    assert.deepEqual(keys(readScheduleSpans(spans)), ["CPT-1", "PT-1", "RB-1", "RB-2"], text);
    unchanged(spans, text);
  }
});

test("wrapped CT-2 GROUT JOINTS / PT-1 EGGSHELL at 19 px stay merged", () => {
  for (const text of ["CT-2 GROUT JOINTS", "PT-1 EGGSHELL"]) {
    const spans = spansOf([CPT1, CPT2, { t: "wrap", col: "CODE", text }, RB1, RB2]);
    unchanged(spans, text);
  }
});

test("a 40 px key-column wrap in 76 px single-line rows stays merged", () => {
  const spans: GraphSpan[] = [sp("CODE", 100, 0), sp("MATERIAL", 220, 0), sp("MANUFACTURER", 520, 0), sp("COLOR", 1000, 0)];
  const ks = ["CPT-1", "CPT-2", "RB-1", "RB-2", "PT-1"];
  ks.forEach((k, i) => { const y = 76 * (i + 1); spans.push(sp(k, 100, y), sp("MAT " + i, 220, y), sp("VENDOR-A", 520, y), sp("GREY", 1000, y)); });
  spans.push(sp("PT-2 SATIN", 100, 152 + 40));
  unchanged(spans, "40 px wrap");
});

test("tall rows (pitch 76 and 95, lines 17–21 px apart) with a third-line COVE key-column wrap, and three-line rows at pitch 68: unchanged", () => {
  for (const [pitch, gap] of [[76, 17], [76, 21], [95, 19], [95, 21], [68, 19]] as const) {
    const spans: GraphSpan[] = [sp("CODE", 100, 0), sp("MATERIAL", 220, 0), sp("MANUFACTURER", 520, 0), sp("COLOR", 1000, 0)];
    ["CPT-1", "RB-1", "RB-2", "PT-1"].forEach((k, i) => {
      const y = pitch * (i + 1);
      spans.push(sp(k, 100, y), sp("MATERIAL " + i, 220, y), sp("VENDOR-B", 520, y), sp("BLACK", 1000, y));
      spans.push(sp("WRAPPED " + i, 220, y + gap));
      if (k === "RB-1" || pitch === 68) spans.push(sp("COVE", 100, y + 2 * gap));
    });
    unchanged(spans, `pitch ${pitch} gap ${gap}`);
  }
});

test("linePitch is the LOWER median: a key-column line between the lower- and upper-median thresholds is unglued", () => {
  // lines 0, 38, 98, 132, 192: gaps 38, 60, 34, 60 → lower median 38 (0.75 × = 28.5), upper 60 (45); the line's gap is 34
  const spans: GraphSpan[] = [sp("CODE", 100, 0), sp("MATERIAL", 220, 0), sp("MANUFACTURER", 520, 0), sp("COLOR", 1000, 0)];
  for (const [k, y] of [["CPT-1", 38], ["CPT-2", 98], ["RB-1", 192]] as const) spans.push(sp(k, 100, y), sp("MAT " + k, 220, y), sp("VENDOR-A", 520, y), sp("GREY", 1000, y));
  spans.push(sp("PT-2 SATIN", 100, 132), sp("PAINT", 220, 132));
  assert.deepEqual(keys(readScheduleSpans(spans)), ["CPT-1", "CPT-2", "PT-2", "RB-1"]);
});

test("a key-column line at 1.8 × h below a row is unglued (a pinned known limit)", () => {
  const spans: GraphSpan[] = [sp("CODE", 100, 0), sp("MATERIAL", 220, 0), sp("MANUFACTURER", 520, 0), sp("COLOR", 1000, 0)];
  for (const [k, y] of [["CPT-1", 38], ["CPT-2", 95], ["RB-1", 152], ["RB-2", 209]] as const) spans.push(sp(k, 100, y), sp("MAT " + k, 220, y), sp("VENDOR-A", 520, y), sp("GREY", 1000, y));
  spans.push(sp("PT-2 SATIN", 100, 95 + 1.8 * TH), sp("PAINT", 220, 95 + 1.8 * TH));
  assert.deepEqual(keys(readScheduleSpans(spans)), ["CPT-1", "CPT-2", "PT-2", "RB-1", "RB-2"]);
});

test("deny-only and long tails read as today: PT-1 BY OWNER, PT-1 SEE NOTE, PT-1 (BY OWNER), a 4-word tail, CPT-1 THRU CPT-4", () => {
  for (const form of ["PT-1 BY OWNER", "PT-1 SEE NOTE", "PT-1 (BY OWNER)", "FTB-01 CUT COVE TYP", "CPT-1 THRU CPT-4"]) {
    const spans = spansOf([CPT2, M(form, "PAINT", "VENDOR-E", "WHITE"), RB1]);
    unchanged(spans, form);
  }
});

test("other kinds are untouched: 101 OFFICE in a room-finish schedule, EF-1 CUT in an equipment schedule", () => {
  const room = [sp("ROOM", 100, 0), sp("NAME", 220, 0), sp("FLOOR", 520, 0), sp("BASE", 700, 0), sp("WALLS", 860, 0), sp("CEILING", 1000, 0)];
  [["101 OFFICE", "CPT-1"], ["102", "VCT-1"]].forEach(([k, f], i) => { const y = PITCH * (i + 1); room.push(sp(k, 100, y), sp("ROOM", 220, y), sp(f, 520, y), sp("RB-1", 700, y), sp("PT-1", 860, y), sp("ACT-1", 1000, y)); });
  const rt = extractTable(sheet(room), "room-finish");
  assert.deepEqual(rt?.rows.map((r) => r.key) ?? [], ["102"]);
  const eq = [sp("MARK", 100, 0), sp("DESCRIPTION", 220, 0), sp("CFM", 520, 0), sp("VOLTS", 700, 0)];
  [["EF-1 CUT", "FAN", "200", "120"], ["EF-2", "FAN", "400", "120"]].forEach((c, i) => { const y = PITCH * (i + 1); c.forEach((s, j) => eq.push(sp(s, [100, 220, 520, 700][j], y))); });
  assert.deepEqual(extractTable(sheet(eq), "equipment")?.rows.map((r) => r.key), ["EF-2"]);
});

// ── the table run ──────────────────────────────────────────────────────
test("run: a mid-table 3-pitch gap with FTB rows then a keyed row → kept; with a BASES heading in the gap → kept", () => {
  const a = read([CPT1, CPT2, { t: "gap", n: 2 }, FTB("FTB-01 CUT (C)"), FTB("FTB-02 COVE"), RB1]);
  assert.deepEqual(keys(a), ["CPT-1", "CPT-2", "FTB-01", "FTB-02", "RB-1"]);
  const b = read([CPT1, CPT2, { t: "gap", n: 1 }, H("BASES"), FTB("FTB-01 CUT (C)"), FTB("FTB-02 COVE"), RB1]);
  assert.deepEqual(keys(b), ["CPT-1", "CPT-2", "FTB-01", "FTB-02", "RB-1"]);
  assert.equal(rowOf(b, "FTB-01").section, "BASES");
});

test("run: a lone ST-1 SERIES 9 pitches below the last row, CPT-9 3 pitches below it → ST-1 not a row, CPT-9 today's section", () => {
  const spans = spansOf([H("FLOORING"), CPT1, CPT2, { t: "gap", n: 8 }, { t: "raw", spans: [["ST-1 SERIES", COLS.KEY]] }, { t: "gap", n: 2 }, M("CPT-9", "CARPET", "VENDOR-A", "GREY")]);
  assert.deepEqual(keys(readScheduleSpans(spans)), ["CPT-1", "CPT-2", "CPT-9"]);
  unchanged(spans, "ST-1 SERIES");
});

test("page box: notes, room tags, a stray P-1 and code-like lines far below → no new rows", () => {
  const items: Item[] = [H("FLOORING"), CPT1, CPT2, LVT1, H("BASE"), RB1, RB2];
  const spans = spansOf(items);
  const lastY = Math.max(...spans.map((s) => s.y));
  spans.push(sp("WHERE", 100, lastY + 2 * PITCH), sp("SHOWN", 220, lastY + 2 * PITCH), sp("ON PLANS", 520, lastY + 2 * PITCH));
  spans.push(sp("EF-1 ABOVE", 100, lastY + 4 * PITCH));
  spans.push(sp("B12 STORAGE", 100, lastY + 1400), sp("EF-1 ABOVE", 100, lastY + 1400 + PITCH));
  const y0 = lastY + 1400 + 4 * PITCH;
  spans.push(sp("L1 FLOORING", 100, y0), sp("PLAN", 220, y0), sp("A-601 FINISH PLAN", 100, y0 + PITCH), sp("EF-1 ABOVE", 100, y0 + 2 * PITCH));
  spans.push(sp("P-1", 100, y0 + 3 * PITCH), sp("GWB-2 PAINTED", 100, y0 + 4 * PITCH));
  unchanged(spans, "page box");
});

test("a lone FTB-01 CUT (C) under FLOORING keeps FLOORING for itself and the rows below it", () => {
  const r = read([H("FLOORING"), CPT1, { t: "raw", spans: [["FTB-01 CUT (C)", COLS.KEY]] }, CPT2, LVT1]);
  assert.deepEqual(keys(r), ["CPT-1", "FTB-01", "CPT-2", "LVT-1"]);
  for (const k of ["CPT-1", "FTB-01", "CPT-2", "LVT-1"]) assert.equal(rowOf(r, k).section, "FLOORING", k);
});

test("one-row tables with an FTB row read it", () => {
  assert.deepEqual(keys(read([CPT1, FTB("FTB-01 CUT (C)")])), ["CPT-1", "FTB-01"]);
  assert.deepEqual(keys(read([FTB("FTB-01 CUT (C)"), PT1])), ["FTB-01", "PT-1"]);
});

test("a rotated-header table with an FTB row reads it", () => {
  const vsp = (str: string, x: number): GraphSpan => ({ str, x, y: 0, w: TH, h: str.length * CW, rot: 90 });
  const spans: GraphSpan[] = [vsp("CODE", 100), vsp("MATERIAL", 220), vsp("COLOR", 520)];
  [["CPT-1", "CARPET"], ["FTB-01 CUT (C)", "TILE BASE"], ["RB-1", "RUBBER BASE"]].forEach(([k, m], i) => { const y = 100 + PITCH * i; spans.push(sp(k, 100, y), sp(m, 220, y), sp("GREY", 520, y)); });
  const r = readScheduleSpans(spans);
  assert.deepEqual(keys(r), ["CPT-1", "FTB-01", "RB-1"]);
  assert.equal(rowOf(r, "FTB-01").description, "CUT (C) — TILE BASE");
});

test("MARK | DESCRIPTION | REMARKS + BASES + only FTB rows → rows under BASES (hasSection from the consumed heading); guardRegion = the header band", () => {
  const spans = build({ key: "MARK", cols: ["DESCRIPTION", "REMARKS"], colX: { REMARKS: 760 }, items: [
    H("BASES"),
    { t: "row", key: "FTB-01 CUT (C)", cells: { DESCRIPTION: "TILE BASE", REMARKS: "VENDOR-F" } },
    { t: "row", key: "FTB-02 COVE", cells: { DESCRIPTION: "TILE BASE", REMARKS: "VENDOR-F" } },
  ] });
  const m = readFinishMarquee(sheet(spans));
  assert.ok(m && m.kind === "table", JSON.stringify(m));
  assert.equal(m.hasSection, true);
  assert.deepStrictEqual(m.guardRegion, [100, 0, 760 + 7 * CW, TH]);
  const r = readScheduleSpans(spans);
  assert.deepEqual(keys(r), ["FTB-01", "FTB-02"]);
  assert.equal(rowOf(r, "FTB-01").section, "BASES");
});

test("re-keyed pass-1 rows and whole reads: no internal field leaves readFinishMarquee", () => {
  const m = readFinishMarquee(sheet(spansOf([CPT1, FTB("FTB-01 CUT (C)"), M("P-1 SAT", "PAINT", "VENDOR-E", "WHITE"), M("CPT-2 NIC", "", "", "")])));
  assert.ok(m && m.kind === "table");
  for (const r of m.table.rows) for (const k of Object.keys(r)) assert.ok(!k.startsWith("_"), `${r.key}.${k}`);
});

// ── revision markers (attachments pinned to pass 1's) ──────────────────────────────────────────
test("a Δ2 on FTB-02's clustered row in a 1+1 short table moves to FTB-02 (pass 1 gave it to PT-1)", () => {
  const spans = spansOf([CPT1, FTB("FTB-01 CUT (C)"), FTB("FTB-02 COVE"), PT1]);
  spans.push(sp("Δ2", 60, 3 * PITCH));
  const plain = readFinishTable(sheet(spans), { marquee: true })!.table.rows;
  assert.equal(plain.find((r) => r.key === "PT-1")!.revision?.rev, "2", "today the marker lands on PT-1");
  const t = mrows(spans);
  assert.deepEqual(t.map((r) => r.key), ["CPT-1", "FTB-01", "FTB-02", "PT-1"]);
  assert.equal(t.find((r) => r.key === "FTB-02")!.revision?.rev, "2");
  assert.equal(t.find((r) => r.key === "PT-1")!.revision, undefined);
});

// ── mutation closers ──────────────────────────────────────────
test("no column map: an FTB line at the key tokens' left edge is eligible; 20 px off it reads as today", () => {
  const mk = (x: number) => [sp("CODE", 100, 0), sp("MATERIAL", 220, 0), sp("MANUFACTURER", 520, 0), sp("COLOR", 1000, 0),
    sp("CPT-1", 100, 38), sp("BROADLOOM", 220, 38), sp("FTB-01 CUT (C)", x, 76), sp("TILE BASE", 220, 76), sp("PT-1", 100, 114), sp("PAINT", 220, 114)];
  assert.deepEqual(keys(readScheduleSpans(mk(100))), ["CPT-1", "FTB-01", "PT-1"]);
  unchanged(mk(120), "20 px off the key edge");
  assert.deepEqual(keys(readScheduleSpans(mk(120))), ["CPT-1", "PT-1"]);
});

test("run pitch is the lower median of exactly two row gaps: a CT-1 line 4 pitches below the last row is not a row", () => {
  const r = read([CPT1, CPT2, FTB("FTB-01 CUT (C)"), FTB("FTB-02 COVE"), FTB("FTB-03 CUT"), RB1, { t: "gap", n: 3 }, { t: "raw", spans: [["CT-1 GROUT", COLS.KEY]] }]);
  assert.deepEqual(keys(r), ["CPT-1", "CPT-2", "FTB-01", "FTB-02", "FTB-03", "RB-1"]);
});

test("the eligibility gap is measured to the line above, not the row above: a third-line PT-2 SATIN 19 px under a wrap stays merged", () => {
  const spans: GraphSpan[] = [sp("CODE", 100, 0), sp("MATERIAL", 220, 0), sp("MANUFACTURER", 520, 0), sp("COLOR", 1000, 0)];
  ["CPT-1", "RB-1", "RB-2", "PT-1"].forEach((k, i) => {
    const y = 76 * (i + 1);
    spans.push(sp(k, 100, y), sp("MATERIAL " + i, 220, y), sp("VENDOR-B", 520, y), sp("BLACK", 1000, y), sp("WRAPPED " + i, 220, y + 19));
    if (k === "RB-1") spans.push(sp("PT-2 SATIN", 100, y + 38));
  });
  unchanged(spans, "third-line PT-2 SATIN");
});

test("continuation stops at the attach radius: a line beyond it from the new row stays where pass 1 left it", () => {
  // pitch over rows and the BASES heading is 38 (radius 22.8); WRAP sits by the heading, so pass 1 attaches it nowhere
  const spans = spansOf([CPT1, FTB("FTB-01 CUT"), { t: "gap", n: 2 }, H("BASES"), { t: "wrap", col: "MATERIAL", text: "WRAP" }, RB1, RB2]);
  const t = mrows(spans);
  assert.deepEqual(t.map((r) => r.key), ["CPT-1", "FTB-01", "RB-1", "RB-2"]);
  assert.ok(!t.some((r) => Object.values(r.cells).some((c) => /WRAP/.test(c.text))), "WRAP attaches to no row");
  assert.equal(t[1].cells.MATERIAL.text, "TILE BASE");
});

// ── the whole-sheet twins, read through a drawn box ───────────────
test("whole-sheet twins through a drawn box: the key-cell forms read by the marquee rules", () => {
  const want: Record<string, string[]> = {
    "ws-key-ftb01-cut-c": ["CPT-1", "FTB-01", "RB-2", "PT-1"],
    "ws-key-cpt2-not-used": ["CPT-1", "CPT-2", "RB-2", "PT-1"],
    "ws-key-cpt2-nic": ["CPT-1", "CPT-2", "RB-2", "PT-1"],
    "ws-key-p1-sat": ["CPT-1", "P-1", "RB-2", "PT-1"],
    "ws-key-rb1-cut": ["CPT-1", "RB-1", "RB-2", "PT-1"],
    "ws-key-lvt1-a": ["CPT-1", "LVT-1A", "RB-2", "PT-1"],
    "ws-key-cpt1-alt": ["CPT-1", "CPT-1ALT", "RB-2", "PT-1"],
    "ws-material-not-used": ["CPT-1", "CPT-2", "RB-1", "PT-1"],
    "ws-epox-two-cells": ["CPT-1", "CPT-2", "RB-1", "PT-1"],
    "ws-far-below": ["CPT-1", "CPT-2", "LVT-1", "VCT-1", "SC-1", "RB-1", "RB-2", "P-1"],
  };
  // from slice 4 the marquee rules read EPOX in ws-epox-two-cells (letters483.test.ts pins that read)
  const letters = (name: string) => CURRENT_SLICE >= 4 && name === "ws-epox-two-cells";
  for (const t of TWINS.filter((x) => x.kind === "whole")) {
    assert.ok(want[t.name], t.name);
    if (letters(t.name)) continue;
    assert.deepEqual(keys(readScheduleSpans(t.spans)), want[t.name], t.name);
  }
  const ftb = rowOf(readScheduleSpans(TWINS.find((x) => x.name === "ws-key-ftb01-cut-c")!.spans), "FTB-01");
  assert.equal(ftb.description, "CUT (C) — PORCELAIN TILE");
  assert.equal(ftb.key_rule, "extended");
  const nic = rowOf(readScheduleSpans(TWINS.find((x) => x.name === "ws-key-cpt2-nic")!.spans), "CPT-2");
  assert.ok(!has(nic, "key_rule"), "a re-keyed pass-1 row");
  for (const name of ["ws-key-lvt1-a", "ws-key-cpt1-alt", "ws-epox-two-cells", "ws-far-below"]) if (!letters(name)) unchanged(TWINS.find((x) => x.name === name)!.spans, name);
});

test("boxes with only code lines under the header: the spec-section-only box reads its FTB row and refuses no-color-style-pattern; the titled box reads rows under BASES", () => {
  const specOnly = build({ key: "MARK", cols: ["DESCRIPTION", "REMARKS"], colX: { REMARKS: 760 }, items: [
    { t: "raw", spans: [["09 65 00 RESILIENT FLOORING", 100]] },
    { t: "row", key: "FTB-01 CUT (C)", cells: { DESCRIPTION: "TILE BASE", REMARKS: "VENDOR-F" } },
  ] });
  const m = readFinishMarquee(sheet(specOnly));
  assert.ok(m && m.kind === "table", JSON.stringify(m));
  assert.equal(m.hasSection, false, "a spec-section line names no section");
  assert.deepEqual(m.table.rows.map((r) => r.key), ["FTB-01"]);
  // refusal flip (no-table → no-color-style-pattern): MARK | DESCRIPTION | REMARKS says nothing of finish
  assert.deepStrictEqual(readScheduleSpans(specOnly), { rows: [], refused: "no-color-style-pattern" });
  const titled = build({ key: "MARK", cols: ["DESCRIPTION", "REMARKS"], colX: { REMARKS: 760 }, title: "FINISH SCHEDULE", items: [
    H("BASES"),
    { t: "row", key: "FTB-01 CUT (C)", cells: { DESCRIPTION: "TILE BASE", REMARKS: "VENDOR-F" } },
    { t: "row", key: "FTB-02 COVE", cells: { DESCRIPTION: "TILE BASE", REMARKS: "VENDOR-F" } },
  ] });
  const mt = readFinishMarquee(sheet(titled));
  assert.ok(mt && mt.kind === "table");
  assert.equal(mt.table.title?.text, "FINISH SCHEDULE");
  const r = readScheduleSpans(titled);
  assert.deepEqual(keys(r), ["FTB-01", "FTB-02"]);
  assert.ok(r.rows.every((x) => x.section === "BASES" && x.key_rule === "extended"));
});

// ── a row left empty by unglue ─────────────────────────────────────
test("a cell-less C whose only text was an unglued C-1 NOT USED line is dropped as a group label once C-1 reads", () => {
  const spans = spansOf([CPT1, { t: "row", key: "C", cells: {} }, { t: "raw", spans: [["C-1 NOT USED", COLS.KEY]] }, M("C-2", "SEALED CONCRETE", "VENDOR-D", "CLEAR")]);
  const plain = readFinishTable(sheet(spans), { marquee: true })!.table.rows;
  assert.deepEqual(plain.map((r) => r.key), ["CPT-1", "C", "C-2"], "today C holds the merged line and stays");
  assert.deepEqual(mrows(spans).map((r) => r.key), ["CPT-1", "C-1", "C-2"]);
  // a C that prints its own item is not emptied, and stays
  const kept = spansOf([CPT1, M("C", "CONCRETE", "", ""), { t: "raw", spans: [["C-1 NOT USED", COLS.KEY]] }, M("C-2", "SEALED CONCRETE", "VENDOR-D", "CLEAR")]);
  assert.deepEqual(mrows(kept).map((r) => r.key), ["CPT-1", "C", "C-1", "C-2"]);
  // an empty C with no prefixed code after it is kept: only the group-label test drops it
  const lone = spansOf([CPT1, { t: "row", key: "C", cells: {} }, { t: "raw", spans: [["P-1 NOT USED", COLS.KEY]] }, M("RB-1", "RUBBER BASE", "VENDOR-B", "BLACK")]);
  assert.deepEqual(mrows(lone).map((r) => r.key), ["CPT-1", "C", "P-1", "RB-1"]);
});

test("the pass-1-or-new window is only for rows unglue emptied: a cell-less P today keeps its place when a new P-2 follows", () => {
  const spans = spansOf([CPT1, { t: "row", key: "P", cells: {} }, RB1, { t: "raw", spans: [["P-2 NOT USED", COLS.KEY]] }, RB2]);
  assert.deepEqual(readFinishTable(sheet(spans), { marquee: true })!.table.rows.map((r) => r.key), ["CPT-1", "P", "RB-1", "RB-2"]);
  assert.deepEqual(mrows(spans).map((r) => r.key), ["CPT-1", "P", "RB-1", "P-2", "RB-2"]);
});

// ── known limits, pinned ───────────────────────────────────────────────
test("limit: a word-split key cell (FTB-01 | CUT | (C) as separate spans) gets no qualifier", () => {
  const spans = spansOf([CPT1, FTB("FTB-01"), PT1]);
  const at = spans.findIndex((s) => s.str === "FTB-01");
  const y = spans[at].y;
  spans.splice(at, 1, sp("FTB-01", COLS.KEY, y), sp("CUT", COLS.KEY + 7 * CW, y), sp("(C)", COLS.KEY + 11 * CW, y));
  const t = mrows(spans);
  assert.deepEqual(t.map((r) => r.key), ["CPT-1", "FTB-01", "PT-1"]);
  assert.ok(!has(t[1], "qualifier") && !has(t[1], "keyRule"), "today's row, no qualifier");
});

test("limit: inside the run, a lone <code> <word> line keys a row — PT-1 OPTION, L1 FLOORING, ALT-1 DEDUCT, A-601 FINISH PLAN, C101 OFFICE", () => {
  for (const [line, key] of [["PT-1 OPTION", "PT-1"], ["L1 FLOORING", "L1"], ["ALT-1 DEDUCT", "ALT-1"], ["A-601 FINISH PLAN", "A-601"], ["C101 OFFICE", "C101"]]) {
    const r = read([CPT1, { t: "raw", spans: [[line, COLS.KEY]] }, RB1]);
    assert.deepEqual(keys(r), ["CPT-1", key, "RB-1"], line);
    assert.equal(rowOf(r, key).key_rule, "extended", line);
  }
  // a one-span room line with cells: C101 OFFICE | CPT-1 | … keys C101 too
  const room = read([CPT1, M("C101 OFFICE", "CPT-1", "RB-1", "PT-1"), RB1]);
  assert.deepEqual(keys(room), ["CPT-1", "C101", "RB-1"]);
});

test("limit: centred key codes with no column map are not eligible", () => {
  // CODE | MATERIAL | MANUFACTURER | COLOR, too few cells for a column map; codes centred on x = 130
  const c = (s: string) => 130 - (s.length * CW) / 2;
  const spans = [sp("CODE", 100, 0), sp("MATERIAL", 220, 0), sp("MANUFACTURER", 520, 0), sp("COLOR", 1000, 0),
    sp("CPT-1", c("CPT-1"), 38), sp("CARPET", 220, 38), sp("FTB-01 CUT (C)", c("FTB-01 CUT (C)"), 76), sp("TILE BASE", 220, 76), sp("PT-1", c("PT-1"), 114), sp("PAINT", 220, 114)];
  unchanged(spans, "centred keys");
});

test("limit: word-split NOT USED where USED bands into the next column is not detected; while USED starts in the key column it is, width-less too", () => {
  const split = (usedX: number, widthless: boolean) => {
    const spans = build({ cols: MMC, items: [CPT1, M("CPT-2", "CARPET TILE", "VENDOR-A", "BLUE"), RB1] });
    const at = spans.findIndex((s) => s.str === "CPT-2");
    const y = spans[at].y;
    spans.splice(at, 1, sp("CPT-2", COLS.KEY, y), sp("NOT", COLS.KEY + 6 * CW, y), sp("USED", usedX, y));
    return readScheduleSpans(widthless ? spans.map((s) => ({ ...s, w: 0 })) : spans);
  };
  // USED past the key column's end (MATERIAL starts at 220): it reads into MATERIAL
  for (const widthless of [false, true]) {
    const r = split(COLS.MATERIAL, widthless);
    assert.equal(rowOf(r, "CPT-2").suggested, true, `widthless ${widthless}`);
    assert.ok(!has(rowOf(r, "CPT-2"), "unticked_reason"), `widthless ${widthless}`);
  }
  // USED inside the key column: detected with and without widths (measured)
  for (const widthless of [false, true]) assert.equal(rowOf(split(COLS.KEY + 10 * CW, widthless), "CPT-2").unticked_reason, "not-used", `widthless ${widthless}`);
});

test("pinned attachments: a line pass 1 attached to the row below stays there when a new row is as near and continuation doesn't take it", () => {
  // CPT-1@38, FTB-01 CUT@76 (new), WRAP@114 (pass 1: on PT-1, 38 below vs 76 above), PT-1@152.
  // In pass 2 WRAP is 38 from FTB-01 and 38 from PT-1: no nearer the last line taken, so it stays on PT-1.
  const spans = spansOf([CPT1, FTB("FTB-01 CUT"), { t: "raw", spans: [["WRAP", COLS.MATERIAL]] }, PT1]);
  const plain = readFinishTable(sheet(spans), { marquee: true })!.table.rows;
  assert.equal(plain.find((r) => r.key === "PT-1")!.cells.MATERIAL.text, "PAINT WRAP", "pass 1 puts WRAP on PT-1");
  const t = mrows(spans);
  assert.deepEqual(t.map((r) => r.key), ["CPT-1", "FTB-01", "PT-1"]);
  assert.equal(t.find((r) => r.key === "PT-1")!.cells.MATERIAL.text, "PAINT WRAP");
  assert.equal(t.find((r) => r.key === "FTB-01")!.cells.MATERIAL.text, "TILE BASE");
});

// ── the guards read pass 1; the run's no-row fallback pitch ──
test("guards read pass-1 sections: FLOORING, a lone FTB-01 CUT (C), RB-1, RB-2 under MARK | DESCRIPTION | REMARKS refuses as today", () => {
  const spans = build({ key: "MARK", cols: ["DESCRIPTION", "REMARKS"], colX: { REMARKS: 760 }, items: [
    H("FLOORING"),
    { t: "raw", spans: [["FTB-01 CUT (C)", COLS.KEY]] },
    { t: "row", key: "RB-1", cells: { DESCRIPTION: "TILE BASE", REMARKS: "VENDOR-F" } },
    { t: "row", key: "RB-2", cells: { DESCRIPTION: "TILE BASE", REMARKS: "VENDOR-F" } },
  ] });
  const m = readFinishMarquee(sheet(spans));
  assert.ok(m && m.kind === "table", JSON.stringify(m));
  // pass 2 restores FLOORING below the surviving lone line, but the guard reads pass 1 (no section)
  assert.ok(m.table.rows.every((r) => r.section === "FLOORING"), "the final rows carry FLOORING");
  assert.equal(m.hasSection, false);
  assert.deepStrictEqual(readScheduleSpans(spans), { rows: [], refused: "no-color-style-pattern" });
});

test("guards read the pass-1 region: a new row below today's rows widens the table's region, not guardRegion", () => {
  const spans = spansOf([CPT1, RB1]);
  spans.push(sp("FTB-01 CUT (C)", COLS.KEY, 3 * PITCH), sp("TILE BASE", COLS.MATERIAL, 3 * PITCH), sp("VENDOR-F", COLS.MANUFACTURER, 3 * PITCH), sp("WHITE 603 SEE DETAIL 4", COLS.COLOR, 3 * PITCH));
  const plain = readFinishTable(sheet(spans), { marquee: true })!;
  assert.deepEqual(plain.table.rows.map((r) => r.key), ["CPT-1", "RB-1"], "today the FTB line is attached to nothing");
  const m = readFinishMarquee(sheet(spans));
  assert.ok(m && m.kind === "table");
  assert.deepEqual(m.table.rows.map((r) => r.key), ["CPT-1", "RB-1", "FTB-01"]);
  assert.notDeepStrictEqual(m.table.region, plain.table.region, "the final region reaches the new row");
  assert.deepStrictEqual(m.guardRegion, plain.table.region);
});

test("no pass-1 rows: the run pitch is the LOWER median line gap — FTB lines at gaps 38, 38, 120, 120 read 2 rows", () => {
  const spans: GraphSpan[] = [sp("MARK", 100, 0), sp("DESCRIPTION", 220, 0), sp("REMARKS", 760, 0), sp("BASES", 100, 38)];
  let y = 38;
  ["FTB-01 CUT", "FTB-02 COVE", "FTB-03 CUT", "FTB-04 COVE"].forEach((k, i) => { y += [38, 38, 120, 120][i]; spans.push(sp(k, 100, y), sp("TILE BASE", 220, y), sp("VENDOR-F", 760, y)); });
  // in-band lines BASES@38, FTB@76, 114, 234, 354: gaps 38, 38, 120, 120 → lower median 38 (reach 95), upper 120 (reach 300)
  const r = readScheduleSpans(spans);
  assert.deepEqual(keys(r), ["FTB-01", "FTB-02"]);
});

// ── provenance: key and the evaluateTags verdict ─────
// The same table as above, its read rows fed through evaluateTags with the
// dialog's rank (NOT USED 0, key_rule 1, else 2 — ImportSchedulePanel.jsx):
// the today-read floor CT-1 keeps the code, the new CT-1 COVE row is duplicate.
import { evaluateTags } from "../src/lib/scheduleEdit.ts";
test("provenance: the CT-1 COVE row is keyed CT-1 with key_rule extended; the floor CT-1 has no key_rule key and is ok under the dialog's rank", () => {
  const all: ScheduleRow[] = read([CPT1, M("CT-1 COVE", "CERAMIC TILE BASE", "VENDOR-F", "WHITE"), M("CT-1", "CERAMIC TILE", "VENDOR-F", "WHITE"), PT1]).rows;
  const cove = all.find((x) => x.description.includes("CERAMIC TILE BASE"))!;
  const floor = all.find((x) => x.description === "CERAMIC TILE")!;
  assert.equal(cove.finish_tag, "CT-1");
  assert.equal(cove.key_rule, "extended");
  assert.equal(floor.finish_tag, "CT-1");
  assert.ok(!("key_rule" in floor));
  const rows = all.map((row, i) => ({ key: `r${i}`, row }));
  const byKey = new Map(rows.map(({ key, row }) => [key, row]));
  const rank = (key: string) => { const x = byKey.get(key)!; return x.unticked_reason ? 0 : x.key_rule ? 1 : 2; };
  const st = evaluateTags(rows.map(({ key, row }) => ({ key, tag: row.finish_tag })), new Set(), rank);
  assert.equal(st.get(`r${all.indexOf(cove)}`)?.status, "duplicate");
  assert.equal(st.get(`r${all.indexOf(floor)}`)?.status, "ok");
});
