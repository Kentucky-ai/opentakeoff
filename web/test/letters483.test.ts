// #483 PR A: four- and five-letter codes with no number.
// A drawn box reads a key-column line like `EPOX | EPOXY FLOORING | …` as a
// row when the layout says it is one: the header or a read row above it, two
// or more other columns filled, and a numbered code below it. Otherwise the
// code is reported in the read's `skipped` list — never silently merged into
// the row above, never silently dropped. Lines that are a header repeated
// mid-table, a group label, a stop-set word (TILE, WHERE, COVE …) or a room
// line are not codes at all and are never reported.
// Whole-sheet reads never change (reader483Goldens.test.ts pins them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFinishMarquee, readFinishTable, isNonFinishSchedule, FOREIGN_HDR, type GraphSpan, type TableRow } from "../src/lib/sheetgraph.ts";
import { readScheduleSpans, readScheduleDebug, FOREIGN_HDR as FOREIGN_HDR_RE_EXPORT, type ScheduleRead } from "../src/lib/scheduleRead.ts";
import type { ScheduleRow } from "../src/lib/scheduleRows.ts";
import { build, sp, M, MMC, H, PITCH, COLS, CW, TWINS, GOLDEN_DIR_URL, goldenFile, roundTrip, readAs, type Item, type BuildOpts, type Cells } from "./fixtures/reader483Fixtures.ts";

const sheet = (spans: GraphSpan[]) => ({ key: "crop", spans });
const has = (o: object, f: string) => Object.prototype.hasOwnProperty.call(o, f);
const spansOf = (items: Item[], o: Partial<BuildOpts> = {}) => build({ cols: MMC, items, ...o });
const read = (items: Item[], o: Partial<BuildOpts> = {}) => readScheduleSpans(spansOf(items, o));
const keys = (r: ScheduleRead) => r.rows.map((x) => x.finish_tag);
const skippedOf = (r: ScheduleRead): string[] | undefined => ("skipped" in r ? r.skipped : undefined);
const rowOf = (r: ScheduleRead, k: string, n = 0): ScheduleRow => {
  const hit = r.rows.filter((x) => x.finish_tag === k)[n];
  assert.ok(hit, `row ${k}#${n} in ${JSON.stringify(keys(r))}`);
  return hit;
};
/** today's plain marquee read (readFinishTable, marquee) — the pass-1 rows */
const plainRows = (spans: GraphSpan[]): TableRow[] => readFinishTable(sheet(spans), { marquee: true })!.table.rows;
const cellText = (r: TableRow) => Object.values(r.cells).map((c) => c.text).join(" | ");
/** no row and no skipped entry beyond what today's read has: the marquee read's rows are today's, and nothing is skipped */
function asToday(spans: GraphSpan[], where: string) {
  const plain = readFinishTable(sheet(spans), { marquee: true });
  const m = readFinishMarquee(sheet(spans));
  if (!plain) { assert.ok(!m || (m.kind === "headerOnly" && m.skipped.length === 0), `${where}: no table, nothing skipped`); return; }
  assert.ok(m && m.kind !== "headerOnly", where);
  assert.deepStrictEqual(m.table.rows, plain.table.rows, where);
  if (m.kind === "table") assert.deepStrictEqual(m.skipped, [], `${where}: nothing skipped`);
  assert.ok(!has(readScheduleSpans(spans), "skipped"), `${where}: the read carries no skipped`);
}
/** a table of lines at explicit y: [y, key, cells] in CODE | MATERIAL | MANUFACTURER | COLOR (header at 0) */
const at = (lines: Array<[number, string, Cells?]>, extra: GraphSpan[] = []): GraphSpan[] => {
  const out = [sp("CODE", 100, 0), sp("MATERIAL", 220, 0), sp("MANUFACTURER", 520, 0), sp("COLOR", 1000, 0)];
  for (const [y, key, cells] of lines) {
    if (key) out.push(sp(key, COLS.KEY, y));
    for (const [c, v] of Object.entries(cells ?? {})) if (v) out.push(sp(v, COLS[c], y));
  }
  return [...out, ...extra];
};

// invented rows in CODE | MATERIAL | MANUFACTURER | COLOR
const CPT1 = M("CPT-1", "BROADLOOM CARPET", "VENDOR-A", "GREY 101");
const CPT2 = M("CPT-2", "MODULAR CARPET TILE", "VENDOR-A", "BLUE 202");
const RB1 = M("RB-1", "RUBBER BASE", "VENDOR-B", "BLACK 505");
const RB2 = M("RB-2", "RESILIENT BASE", "VENDOR-B", "GREY 506");
const PT1 = M("PT-1", "PAINT", "VENDOR-E", "WHITE 601");
const PT2 = M("PT-2", "PAINT", "VENDOR-E", "TAUPE 602");
const L = (key: string, cells: Cells): Item => ({ t: "row", key, cells });
const EPOX = L("EPOX", { MATERIAL: "EPOXY FLOORING", MANUFACTURER: "VENDOR-L", COLOR: "GREY 901" });
const CONC = L("CONC", { MATERIAL: "SEALED CONCRETE", MANUFACTURER: "VENDOR-D", COLOR: "CLEAR" });
const SEAL = L("SEAL", { MATERIAL: "PENETRATING SEALER", MANUFACTURER: "VENDOR-D" });
/** a one-cell letters line: the code and its material only */
const ONE = (key: string, mat = "EPOXY FLOORING") => L(key, { MATERIAL: mat });

// ── filled rows: two or more other cells ────────────────────────────────────────────
test("EPOX, CONC, SEAL with two or more filled cells between coded rows → rows, key_rule extended; the row above loses the merged text", () => {
  const spans = spansOf([CPT1, EPOX, RB1, CONC, PT1, SEAL, PT2]);
  const plain = plainRows(spans);
  assert.match(cellText(plain[0]), /EPOX/, "today CPT-1 holds the EPOX line");
  const r = readScheduleSpans(spans);
  assert.deepEqual(keys(r), ["CPT-1", "EPOX", "RB-1", "CONC", "PT-1", "SEAL", "PT-2"]);
  for (const k of ["EPOX", "CONC", "SEAL"]) assert.equal(rowOf(r, k).key_rule, "extended", k);
  for (const k of ["CPT-1", "RB-1", "PT-1", "PT-2"]) assert.ok(!has(rowOf(r, k), "key_rule"), k);
  assert.deepEqual(rowOf(r, "EPOX"), { finish_tag: "EPOX", section: "", category: "unassigned", category_source: "none", description: "EPOXY FLOORING", manufacturer: "VENDOR-L", style: "", spec_color: "GREY 901", size: "", remarks: "", suggested: true, key_rule: "extended" });
  assert.equal(rowOf(r, "CPT-1").description, "BROADLOOM CARPET");
  assert.ok(!has(r, "skipped"));
  const m = readFinishMarquee(sheet(spans));
  assert.ok(m && m.kind === "table");
  assert.deepStrictEqual(m.skipped, []);
});

test("EPOX as the first data row → a row (the header is above it)", () => {
  assert.deepEqual(keys(read([EPOX, CPT1, RB1])), ["EPOX", "CPT-1", "RB-1"]);
});

test("EPOX right after a heading, at the top and mid-table → a row under that heading (position skips headings)", () => {
  const top = read([H("FLOORING"), EPOX, CPT1, RB1]);
  assert.deepEqual(keys(top), ["EPOX", "CPT-1", "RB-1"]);
  assert.equal(rowOf(top, "EPOX").section, "FLOORING");
  const mid = read([CPT1, CPT2, H("FLOORING"), EPOX, PT1]);
  assert.deepEqual(keys(mid), ["CPT-1", "CPT-2", "EPOX", "PT-1"]);
  assert.equal(rowOf(mid, "EPOX").section, "FLOORING");
  assert.equal(rowOf(mid, "EPOX").category, "floor");
});

test("header → EPOX → CONC → CPT-1: both rows (a letters row decided above counts for the next one's position)", () => {
  assert.deepEqual(keys(read([EPOX, CONC, CPT1])), ["EPOX", "CONC", "CPT-1"]);
});

test("a filled EPOX a full line under a row's own wrap line → a row (position walks walk lines, not wraps)", () => {
  const spans = at([[38, "CPT-1", { MATERIAL: "BROADLOOM CARPET", MANUFACTURER: "VENDOR-A", COLOR: "GREY 101" }], [57, "", { MATERIAL: "LOOP PILE" }],
    [95, "EPOX", { MATERIAL: "EPOXY FLOORING", MANUFACTURER: "VENDOR-L", COLOR: "GREY 901" }], [133, "RB-1", { MATERIAL: "RUBBER BASE", MANUFACTURER: "VENDOR-B" }], [171, "PT-1", { MATERIAL: "PAINT", MANUFACTURER: "VENDOR-E" }]]);
  const r = readScheduleSpans(spans);
  assert.deepEqual(keys(r), ["CPT-1", "EPOX", "RB-1", "PT-1"]);
  assert.equal(rowOf(r, "CPT-1").description, "BROADLOOM CARPET LOOP PILE", "the wrap stays on CPT-1");
});

test("a one-cell EPOX then a filled SEAL between coded rows → EPOX skipped, SEAL a row", () => {
  const r = read([CPT1, ONE("EPOX"), SEAL, RB1]);
  assert.deepEqual(keys(r), ["CPT-1", "SEAL", "RB-1"]);
  assert.deepEqual(skippedOf(r), ["EPOX"]);
  assert.equal(rowOf(r, "CPT-1").description, "BROADLOOM CARPET", "the skipped line left CPT-1");
});

test("EPOX with cells above EPOX-1 → both rows", () => {
  assert.deepEqual(keys(read([CPT1, EPOX, M("EPOX-1", "EPOXY TOPPING", "VENDOR-L", "GREY 902"), RB1])), ["CPT-1", "EPOX", "EPOX-1", "RB-1"]);
});

test("EPOX | EPOXY FLOORING | VENDOR | 09 67 23 between coded rows → a row (a spec number with no prefixed code below is a cell)", () => {
  const r = read([CPT1, L("EPOX", { MATERIAL: "EPOXY FLOORING", MANUFACTURER: "VENDOR-L", COLOR: "09 67 23" }), RB1]);
  assert.deepEqual(keys(r), ["CPT-1", "EPOX", "RB-1"]);
  assert.equal(rowOf(r, "EPOX").spec_color, "09 67 23");
});

test("TERR | 3/8\" | 1020 between coded rows → a row; SEAL | SEALER | SC-100 (one code-shaped cell) → a row", () => {
  assert.deepEqual(keys(read([CPT1, L("TERR", { MATERIAL: '3/8"', MANUFACTURER: "1020" }), RB1])), ["CPT-1", "TERR", "RB-1"]);
  assert.deepEqual(keys(read([CPT1, L("SEAL", { MATERIAL: "SEALER", MANUFACTURER: "SC-100" }), RB1])), ["CPT-1", "SEAL", "RB-1"]);
});

test("alternation CPT-1, EPOX, RB-1, CONC, PT-1 → five rows; CPT-1 and RB-1 without the merged text", () => {
  const spans = TWINS.find((t) => t.name === "mq-alternation")!.spans;
  const plain = plainRows(spans);
  assert.match(cellText(plain[0]), /EPOX/);
  assert.match(cellText(plain[1]), /CONC/);
  const r = readScheduleSpans(spans);
  assert.deepEqual(keys(r), ["CPT-1", "EPOX", "RB-1", "CONC", "PT-1"]);
  assert.equal(rowOf(r, "CPT-1").description, "BROADLOOM CARPET");
  assert.equal(rowOf(r, "RB-1").description, "RUBBER BASE");
});

test("short CPT-1, RB-1, EPOX, PT-1 → four rows, RB-1 `RUBBER BASE`", () => {
  const r = readScheduleSpans(TWINS.find((t) => t.name === "both-short-cpt-rb-epox-pt")!.spans);
  assert.deepEqual(keys(r), ["CPT-1", "RB-1", "EPOX", "PT-1"]);
  assert.equal(rowOf(r, "RB-1").description, "RUBBER BASE");
});

test("CPT-1, RB-1, EPOX + wrap RESINOUS FLOOR, PT-1 57 px below EPOX → EPOX holds the wrap, PT-1 doesn't", () => {
  const spans = at([[38, "CPT-1", { MATERIAL: "BROADLOOM CARPET", MANUFACTURER: "VENDOR-A" }], [76, "RB-1", { MATERIAL: "RUBBER BASE", MANUFACTURER: "VENDOR-B" }],
    [114, "EPOX", { MATERIAL: "EPOXY", MANUFACTURER: "VENDOR-L" }], [133, "", { MATERIAL: "RESINOUS FLOOR" }], [171, "PT-1", { MATERIAL: "PAINT", MANUFACTURER: "VENDOR-E" }]]);
  const r = readScheduleSpans(spans);
  assert.deepEqual(keys(r), ["CPT-1", "RB-1", "EPOX", "PT-1"]);
  assert.equal(rowOf(r, "EPOX").description, "EPOXY RESINOUS FLOOR");
  assert.equal(rowOf(r, "PT-1").description, "PAINT");
});

test("cell-less C + a filled EPOX 19 px under it + C-1, C-2 → the golden (EPOX is too close to C to be eligible)", () => {
  const t = TWINS.find((x) => x.name === "mq-c-epox-19-c1-c2")!;
  const g = JSON.parse(readFileSync(fileURLToPath(GOLDEN_DIR_URL) + goldenFile(t.name), "utf8"));
  assert.deepStrictEqual(roundTrip(readScheduleSpans(t.spans)), g.marquee.readScheduleSpans);
  assert.ok(!has(readScheduleSpans(t.spans), "skipped"));
});

test("ws-epox-two-cells through a drawn box: EPOX reads as a row between CPT-2 and RB-1", () => {
  const r = readScheduleSpans(TWINS.find((t) => t.name === "ws-epox-two-cells")!.spans);
  assert.deepEqual(keys(r), ["CPT-1", "CPT-2", "EPOX", "RB-1", "PT-1"]);
  assert.equal(rowOf(r, "EPOX").key_rule, "extended");
  assert.equal(rowOf(r, "CPT-2").description, "MODULAR CARPET TILE");
});

// ── (s), (g): group labels ─────────────────────────────────────────────
test("CONC | CONCRETE FINISHES above CONC-1, CONC-2 → a group label (g), consumed, not skipped", () => {
  const spans = spansOf([CPT1, L("CONC", { MATERIAL: "CONCRETE FINISHES" }), M("CONC-1", "SEALED CONCRETE", "VENDOR-D", "CLEAR"), M("CONC-2", "POLISHED CONCRETE", "VENDOR-D", "SATIN")]);
  const d = readScheduleDebug(spans);
  assert.deepEqual(keys(d.read), ["CPT-1", "CONC-1", "CONC-2"]);
  assert.ok(!has(d.read, "skipped"));
  assert.deepEqual(d.consumed.map((c) => [c.text, c.reason]), [["CONC CONCRETE FINISHES", "g"]]);
  assert.ok(!Object.values(d.rows[0].cells).some((c) => /CONC/.test(c.text)), "nothing of CONC left on CPT-1");
});

test("CONC | 03 35 00 | CONCRETE FINISHING above CONC-1 → a spec-section group label (s)", () => {
  const spans = spansOf([CPT1, L("CONC", { MATERIAL: "03 35 00", MANUFACTURER: "CONCRETE FINISHING" }), M("CONC-1", "SEALED CONCRETE", "VENDOR-D", "CLEAR")]);
  const d = readScheduleDebug(spans);
  assert.deepEqual(keys(d.read), ["CPT-1", "CONC-1"]);
  assert.ok(!has(d.read, "skipped"));
  assert.deepEqual(d.consumed.map((c) => c.reason), ["s"]);
});

// ── skipped ────────────────────────────────────────────────────
test("CONC + one cell between coded rows → skipped [CONC], its text gone from the row above", () => {
  const spans = spansOf([CPT1, ONE("CONC", "SEALED CONCRETE"), RB1]);
  assert.match(cellText(plainRows(spans)[0]), /SEALED CONCRETE/, "today CPT-1 holds the CONC line");
  const d = readScheduleDebug(spans);
  assert.deepEqual(keys(d.read), ["CPT-1", "RB-1"]);
  assert.deepEqual(skippedOf(d.read), ["CONC"]);
  assert.equal(rowOf(d.read, "CPT-1").description, "BROADLOOM CARPET");
  assert.deepEqual(d.consumed.map((c) => [c.text, c.reason, c.owner]), [["CONC SEALED CONCRETE", "skipped", "CPT-1"]]);
  assert.deepEqual(d.diag.map((x) => x.kind), ["skipped"]);
  const m = readFinishMarquee(sheet(spans));
  assert.ok(m && m.kind === "table");
  assert.deepStrictEqual(m.skipped, ["CONC"]);
});

test("a one-cell EPOX with a wrap RESINOUS → skipped, both lines gone from RB-1 (the wrap is dropped with it)", () => {
  // PT-1 a pitch further down, so pass 1 merges both lines into RB-1
  const spans = spansOf([CPT1, RB1, ONE("EPOX", "EPOXY"), { t: "wrap", col: "MATERIAL", text: "RESINOUS" }, { t: "gap", n: 1 }, PT1]);
  const rb = cellText(plainRows(spans)[1]);
  assert.ok(/EPOX/.test(rb) && /RESINOUS/.test(rb), `today RB-1 holds both lines: ${rb}`);
  const d = readScheduleDebug(spans);
  assert.deepEqual(keys(d.read), ["CPT-1", "RB-1", "PT-1"]);
  assert.deepEqual(skippedOf(d.read), ["EPOX"]);
  assert.equal(rowOf(d.read, "RB-1").description, "RUBBER BASE");
  assert.equal(rowOf(d.read, "PT-1").description, "PAINT");
  assert.deepEqual(d.consumed.map((c) => [c.text, c.reason, c.owner]), [["EPOX EPOXY", "skipped", "RB-1"], ["RESINOUS", "continuation", "RB-1"]]);
});

test("a one-cell EPOX with a wrapped FLOORING 19 px below it near the table centre → RB-1 / RB-2 keep today's sections", () => {
  // FLOORING centred on the table (x 668–732, the table spans 100–1300), hugging EPOX
  const spans = spansOf([H("BASE"), RB1, ONE("EPOX", "EPOXY"), { t: "wrap", col: "MANUFACTURER", text: "FLOORING", dx: 148 }, RB2, PT1]);
  const plain = plainRows(spans);
  const r = readScheduleSpans(spans);
  assert.deepEqual(skippedOf(r), ["EPOX"]);
  for (const k of ["RB-1", "RB-2"]) assert.equal(rowOf(r, k).section, plain.find((x) => x.key === k)!.section ?? "", k);
});

test("two one-cell EPOX lines → skipped [EPOX, EPOX]; a FLOORING heading below a skipped line still names its section", () => {
  const r = read([CPT1, ONE("EPOX"), RB1, ONE("EPOX", "EPOXY TOPPING"), PT1]);
  assert.deepEqual(keys(r), ["CPT-1", "RB-1", "PT-1"]);
  assert.deepEqual(skippedOf(r), ["EPOX", "EPOX"]);
  const h = read([CPT1, ONE("EPOX"), H("FLOORING"), CPT2, RB1]);
  assert.deepEqual(skippedOf(h), ["EPOX"]);
  assert.equal(rowOf(h, "CPT-2").section, "FLOORING");
  assert.equal(rowOf(h, "RB-1").section, "FLOORING");
});

test("a filled EPOX as the last row → skipped [EPOX] (no numbered row below it; pinned)", () => {
  const r = read([CPT1, RB1, EPOX]);
  assert.deepEqual(keys(r), ["CPT-1", "RB-1"]);
  assert.deepEqual(skippedOf(r), ["EPOX"]);
  assert.equal(rowOf(r, "RB-1").description, "RUBBER BASE");
});

test("EPOX then SEAL as the last two rows → skipped [EPOX, SEAL]", () => {
  const r = read([CPT1, RB1, EPOX, SEAL]);
  assert.deepEqual(keys(r), ["CPT-1", "RB-1"]);
  assert.deepEqual(skippedOf(r), ["EPOX", "SEAL"]);
});

test("position skips letters candidates the run did not reach : CONC reached from PT-1 reads as a row past an unreachable EPOX", () => {
  // run pitch 38 (rows 38, 76, 342, 380). EPOX 3 pitches under CPT-2: unreachable down, and 3 pitches above CONC:
  // unreachable up (pass-1 handling, not reported). CONC is reached up from PT-1; walking up from it EPOX is skipped and CPT-2 is reached.
  const spans = at([[38, "CPT-1", { MATERIAL: "BROADLOOM", MANUFACTURER: "VENDOR-A" }], [76, "CPT-2", { MATERIAL: "CARPET TILE", MANUFACTURER: "VENDOR-A" }],
    [190, "EPOX", { MATERIAL: "EPOXY FLOORING", MANUFACTURER: "VENDOR-L" }], [304, "CONC", { MATERIAL: "SEALED CONCRETE", MANUFACTURER: "VENDOR-D" }],
    [342, "PT-1", { MATERIAL: "PAINT", MANUFACTURER: "VENDOR-E" }], [380, "PT-2", { MATERIAL: "PAINT", MANUFACTURER: "VENDOR-E" }]]);
  const r = readScheduleSpans(spans);
  assert.deepEqual(keys(r), ["CPT-1", "CPT-2", "CONC", "PT-1", "PT-2"]);
  assert.ok(!has(r, "skipped"));
});

// ── (a) stop set, (h) header line, (r) room line: not codes ───────────────────────────────────────────
test("a repeated CODE | MATERIAL | MANUFACTURER line → stop set: read as today, nothing skipped", () => {
  asToday(spansOf([CPT1, L("CODE", { MATERIAL: "MATERIAL", MANUFACTURER: "MANUFACTURER" }), RB1, PT1]), "repeated CODE header");
});

test("a repeated LABEL | DESCRIPTION | MANUFACTURER line → (h): consumed, not a row, not skipped; it leaves the row it was merged into", () => {
  const spans = spansOf([CPT1, L("LABEL", { MATERIAL: "DESCRIPTION", MANUFACTURER: "MANUFACTURER" }), RB1, PT1]);
  assert.match(cellText(plainRows(spans)[0]), /LABEL/, "today CPT-1 holds the header line");
  const d = readScheduleDebug(spans);
  assert.deepEqual(keys(d.read), ["CPT-1", "RB-1", "PT-1"]);
  assert.ok(!has(d.read, "skipped"));
  assert.equal(rowOf(d.read, "CPT-1").description, "BROADLOOM CARPET");
  assert.deepEqual(d.consumed.map((c) => [c.reason, c.owner]), [["h", "CPT-1"]]);
});

test("(h) on an eligible line whose first token is a header word: a repeated MATERIAL | MANUFACTURER | COLOR line (no code) is consumed", () => {
  const spans = spansOf([CPT1, CPT2, { t: "raw", spans: [["MATERIAL", COLS.KEY], ["MANUFACTURER", COLS.MANUFACTURER], ["COLOR", COLS.COLOR]] }, RB1, PT1]);
  const d = readScheduleDebug(spans);
  assert.deepEqual(keys(d.read), ["CPT-1", "CPT-2", "RB-1", "PT-1"]);
  assert.ok(!has(d.read, "skipped"));
  assert.deepEqual(d.consumed.map((c) => c.reason), ["h"]);
  assert.ok(!d.rows.some((r) => /MANUFACTURER/.test(cellText(r))), "no row holds the header line");
});

test("DOOR | WIDTH | HEIGHT | FRAME one and three pitches below the table → no row, no skipped", () => {
  for (const gap of [0, 2]) {
    const spans = spansOf([CPT1, RB1, PT1, { t: "gap", n: gap }, { t: "raw", spans: [["DOOR", COLS.KEY], ["WIDTH", COLS.MATERIAL], ["HEIGHT", COLS.MANUFACTURER], ["FRAME", COLS.COLOR]] }]);
    asToday(spans, `DOOR line ${gap + 1} pitches below`);
  }
});

test("NOTE: | ALL FINISHES | PER SPEC and WHERE | SHOWN | ON PLANS one pitch below the table → nothing skipped", () => {
  asToday(spansOf([CPT1, RB1, PT1, { t: "raw", spans: [["NOTE:", COLS.KEY], ["ALL FINISHES", COLS.MATERIAL], ["PER SPEC", COLS.MANUFACTURER]] }]), "NOTE:");
  asToday(spansOf([CPT1, RB1, PT1, { t: "raw", spans: [["WHERE", COLS.KEY], ["SHOWN", COLS.MATERIAL], ["ON PLANS", COLS.MANUFACTURER]] }]), "WHERE");
});

test("LOBBY | CPT-1 | RB-1 | PT-1 → a room line (r): read as today, nothing skipped", () => {
  asToday(spansOf([CPT1, RB1, L("LOBBY", { MATERIAL: "CPT-1", MANUFACTURER: "RB-1", COLOR: "PT-1" }), PT1]), "LOBBY room line");
});

test("stop set: lone PAINT above PT-1 → today; PAINT  ALL GYP. BD. — SEE SPEC → today; TILE / WOOD with cells → today", () => {
  asToday(spansOf([CPT1, { t: "raw", spans: [["PAINT", COLS.KEY]] }, PT1, PT2]), "lone PAINT");
  asToday(spansOf([CPT1, L("PAINT", { MATERIAL: "ALL GYP. BD. — SEE SPEC" }), PT1, PT2]), "PAINT ALL GYP. BD.");
  asToday(spansOf([CPT1, L("TILE", { MATERIAL: "CERAMIC", MANUFACTURER: "VENDOR-F" }), RB1, L("WOOD", { MATERIAL: "OAK", COLOR: "NATURAL" }), PT1]), "TILE / WOOD");
});

test("COVE key-column wraps (the wrap matrix) → RB-1 as today, no COVE row, nothing skipped", () => {
  const rb = (rest: Cells): Array<[number, string, Cells?]> => [[0, "RB-1", { MATERIAL: "RUBBER BASE", MANUFACTURER: "VENDOR-B", COLOR: "BLACK" }], [0, "COVE", rest]];
  const others: Array<[string, Cells]> = [["CPT-1", { MATERIAL: "CARPET", MANUFACTURER: "VENDOR-A", COLOR: "GREY" }], ["PT-1", { MATERIAL: "PAINT", MANUFACTURER: "VENDOR-E", COLOR: "WHITE" }], ["PT-2", { MATERIAL: "PAINT", MANUFACTURER: "VENDOR-E", COLOR: "TAUPE" }]];
  for (const pitch of [38, 57]) for (const dy of pitch === 57 ? [19, 38] : [19]) for (const where of [0, 1, 3]) for (const rest of [{ MATERIAL: "4 IN", MANUFACTURER: "TOE", COLOR: "BLACK" }, { MATERIAL: "4 IN" }]) {
    const lines: Array<[number, string, Cells?]> = [];
    const order = [...others];
    order.splice(where, 0, ["RB-1", {}]);
    order.forEach(([k, c], n) => {
      const y = pitch * (n + 1);
      if (k === "RB-1") { const [a, b] = rb(rest); lines.push([y, a[1], a[2]], [y + dy, b[1], b[2]]); } else lines.push([y, k, c]);
    });
    const spans = at(lines);
    const where_ = `pitch ${pitch} dy ${dy} at ${where} cells ${Object.keys(rest).length}`;
    asToday(spans, where_);
  }
});

// ── the table run / position closers ─────────────────────────────────────────────────
test("the WHERE / EF-1 bridge: WHERE | SHOWN | ON PLANS 2 pitches below the last row, EF-1 ABOVE 2 pitches further → no new rows, no skipped (stop-set lines are out of the run)", () => {
  const spans = spansOf([H("FLOORING"), CPT1, CPT2, H("BASE"), RB1, RB2]);
  const lastY = Math.max(...spans.map((s) => s.y));
  spans.push(sp("WHERE", 100, lastY + 2 * PITCH), sp("SHOWN", 220, lastY + 2 * PITCH), sp("ON PLANS", 520, lastY + 2 * PITCH));
  spans.push(sp("EF-1 ABOVE", 100, lastY + 4 * PITCH));
  asToday(spans, "WHERE / EF-1 bridge");
  // with a letters word NOT in the stop set in WHERE's place, the run does cross to EF-1 (the bridge is real): both read
  const bridged = spans.map((s) => (s.str === "WHERE" ? { ...s, str: "THERE" } : s));
  assert.deepEqual(keys(readScheduleSpans(bridged)), ["CPT-1", "CPT-2", "RB-1", "RB-2", "THERE", "EF-1"]);
});

test("a column-map-less table: EPOX at the key tokens' left edge → a row; 20 px off it → today", () => {
  const mk = (x: number) => [sp("CODE", 100, 0), sp("MATERIAL", 220, 0), sp("MANUFACTURER", 520, 0), sp("COLOR", 1000, 0),
    sp("CPT-1", 100, 38), sp("BROADLOOM", 220, 38), sp("EPOX", x, 76), sp("EPOXY", 220, 76), sp("VENDOR-L", 520, 76), sp("PT-1", 100, 114), sp("PAINT", 220, 114)];
  assert.deepEqual(keys(readScheduleSpans(mk(100))), ["CPT-1", "EPOX", "PT-1"]);
  asToday(mk(120), "20 px off the key edge");
});

test("word-split notes and an abbreviation legend 3 pitches below 2, 3 and 6 coded rows (cell box and page box) → no rows, nothing skipped", () => {
  const coded = [CPT1, CPT2, RB1, RB2, PT1, PT2];
  const words = (text: string, x: number): Array<[string, number]> => [...text.matchAll(/\S+/g)].map((m) => [m[0], x + CW * (m.index ?? 0)]);
  for (const n of [2, 3, 6]) for (const page of [false, true]) {
    const items: Item[] = [...coded.slice(0, n), { t: "gap", n: 2 },
      { t: "raw", spans: words("ABBREVIATIONS", COLS.KEY) },
      { t: "raw", spans: [["CONC", COLS.KEY], ["CONCRETE", COLS.MATERIAL]] },
      { t: "raw", spans: [["EPOX", COLS.KEY], ["EPOXY", COLS.MATERIAL]] },
      { t: "raw", spans: [["RESIL", COLS.KEY], ["RESILIENT", COLS.MATERIAL]] },
      { t: "gap", n: 1 },
      { t: "raw", spans: words("GENERAL NOTES:", COLS.KEY) },
      { t: "raw", spans: [...words("1.", COLS.KEY), ...words("ALL FINISHES TO BE INSTALLED PER MANUFACTURER", COLS.MATERIAL)] },
      { t: "raw", spans: [...words("2.", COLS.KEY), ...words("PATCH AND MATCH EXISTING WHERE DISTURBED", COLS.MATERIAL)] },
    ];
    const spans = spansOf(items, page ? { pre: [[["A-601", 1400]], [["FINISH PLAN", 1400]]] } : {});
    asToday(spans, `${n} rows, page ${page}`);
  }
});

// ── whole-letters tables and the guards ──────────────────────────────
test("an all-letters table → { rows: [], skipped: [EPOX, CONC, SEAL] } (headerOnly with skipped survives the guards)", () => {
  const spans = spansOf([EPOX, CONC, L("SEAL", { MATERIAL: "SEALER", MANUFACTURER: "VENDOR-D" })]);
  const m = readFinishMarquee(sheet(spans));
  assert.ok(m && m.kind === "headerOnly", JSON.stringify(m));
  assert.deepStrictEqual(m.skipped, ["EPOX", "CONC", "SEAL"]);
  assert.deepStrictEqual(readScheduleSpans(spans), { rows: [], skipped: ["EPOX", "CONC", "SEAL"] });
  const d = readScheduleDebug(spans);
  assert.deepEqual(d.consumed.map((c) => c.reason), ["skipped", "skipped", "skipped"]);
});

test("a titled DOOR SCHEDULE all-letters box → refused title (no skipped on a refusal)", () => {
  const spans = spansOf([EPOX, CONC], { title: "DOOR SCHEDULE" });
  assert.ok(isNonFinishSchedule("DOOR SCHEDULE"));
  assert.deepStrictEqual(readScheduleSpans(spans), { rows: [], refused: "title", title: "DOOR SCHEDULE" });
});

test("MARK | DESCRIPTION | QTY | COLOR all-letters → refused foreign-header (no skipped on a refusal)", () => {
  const spans = build({ key: "MARK", cols: ["DESCRIPTION", "QTY", "COLOR"], colX: { QTY: 520 }, items: [
    L("EPOX", { DESCRIPTION: "EPOXY FLOORING", QTY: "12", COLOR: "GREY" }), L("CONC", { DESCRIPTION: "SEALED CONCRETE", QTY: "4", COLOR: "CLEAR" }),
  ] });
  assert.deepStrictEqual(readScheduleSpans(spans), { rows: [], refused: "foreign-header" });
});

test("a headerOnly box with nothing skipped is still no-table", () => {
  const spans = spansOf([{ t: "raw", spans: [["EPOX", COLS.KEY]] }]);
  assert.deepStrictEqual(readScheduleSpans(spans), { rows: [], refused: "no-table" });
});

// ── sections and revision markers ────────────────────────────────────────────────────
test("a lone CPT-2 NOT USED followed by a filled EPOX → EPOX gets FLOORING (the pass-2 section)", () => {
  const r = read([H("FLOORING"), CPT1, { t: "raw", spans: [["CPT-2 NOT USED", COLS.KEY]] }, EPOX, M("CPT-3", "CARPET TILE", "VENDOR-A", "GREY 303")]);
  assert.deepEqual(keys(r), ["CPT-1", "CPT-2", "EPOX", "CPT-3"]);
  for (const k of ["CPT-1", "CPT-2", "EPOX", "CPT-3"]) assert.equal(rowOf(r, k).section, "FLOORING", k);
});

test("a Δ3 on a consumed (h) or (g) line's clustered row leaves the row that line was merged into", () => {
  // (h): LABEL line merged into CPT-1 today, Δ3 beside it
  const h = spansOf([CPT1, L("LABEL", { MATERIAL: "DESCRIPTION", MANUFACTURER: "MANUFACTURER" }), RB1, PT1]);
  h.push({ str: "Δ3", x: 60, y: 2 * PITCH, w: 16, h: 17 });
  const ph = plainRows(h);
  assert.equal(ph[0].revision?.rev, "3", "today Δ3 lands on CPT-1");
  assert.match(cellText(ph[0]), /LABEL/);
  const dh = readScheduleDebug(h);
  assert.deepEqual(keys(dh.read), ["CPT-1", "RB-1", "PT-1"]);
  assert.ok(dh.rows.every((r) => !r.revision), JSON.stringify(dh.rows.map((r) => r.revision)));
  assert.ok(!/LABEL/.test(cellText(dh.rows[0])));
  // (g): CONC | CONCRETE FINISHES merged into CPT-1 today, Δ3 beside it
  const g = spansOf([CPT1, L("CONC", { MATERIAL: "CONCRETE FINISHES" }), M("CONC-1", "SEALED CONCRETE", "VENDOR-D", "CLEAR"), M("CONC-2", "POLISHED CONCRETE", "VENDOR-D", "SATIN")]);
  g.push({ str: "Δ3", x: 60, y: 2 * PITCH, w: 16, h: 17 });
  const pg = plainRows(g);
  assert.equal(pg[0].revision?.rev, "3", "today Δ3 lands on CPT-1");
  const dg = readScheduleDebug(g);
  assert.deepEqual(keys(dg.read), ["CPT-1", "CONC-1", "CONC-2"]);
  assert.ok(dg.rows.every((r) => !r.revision));
  assert.deepEqual(dg.consumed.map((c) => c.reason), ["g"]);
});

test("a Δ3 6 px below a consumed line (text 14 px: its own clustered row) stays on its pass-1 row", () => {
  const spans = spansOf([CPT1, L("LABEL", { MATERIAL: "DESCRIPTION", MANUFACTURER: "MANUFACTURER" }), RB1, PT1]);
  const TH14 = 14;
  assert.ok(Math.max(TH14 * 0.35, 3) < 6, "6 px is outside the clustering tolerance at this height");
  spans.push({ str: "Δ3", x: 60, y: 2 * PITCH + 6, w: 16, h: TH14 });
  const plain = plainRows(spans);
  const host = plain.find((r) => r.revision)!;
  assert.ok(host, "today Δ3 lands on a row");
  const d = readScheduleDebug(spans);
  assert.deepEqual(d.consumed.map((c) => c.reason), ["h"]);
  assert.equal(d.rows.find((r) => r.key === host.key)!.revision?.rev, "3", `Δ3 stays on ${host.key}`);
});

// ── known limits, pinned ───────────────────────────────────────────────
test("limit: one-span EPOX EPOXY FLOORING, EPOX CUT, EPOX NOT USED, and a lone EPOX with no cell → read as today, not reported", () => {
  for (const line of ["EPOX EPOXY FLOORING", "EPOX CUT", "EPOX NOT USED", "EPOX"]) asToday(spansOf([CPT1, { t: "raw", spans: [[line, COLS.KEY]] }, RB1, PT1]), line);
  // the one-span forms with cells beside them: still not a letters code (the key span is not one word)
  for (const line of ["EPOX EPOXY FLOORING", "EPOX CUT", "EPOX NOT USED"]) asToday(spansOf([CPT1, { t: "raw", spans: [[line, COLS.KEY], ["VENDOR-L", COLS.MANUFACTURER], ["GREY", COLS.COLOR]] }, RB1, PT1]), `${line} + cells`);
});

test("limit: codes of six or more letters are not read and not reported", () => {
  asToday(spansOf([CPT1, L("EPOXYF", { MATERIAL: "EPOXY FLOORING", MANUFACTURER: "VENDOR-L", COLOR: "GREY" }), RB1, PT1]), "EPOXYF");
});

test("limit: an abbreviation legend directly below the last numbered row → one false skipped entry per line", () => {
  const r = read([CPT1, RB1, PT1, L("CONC", { MATERIAL: "CONCRETE" }), L("EPOX", { MATERIAL: "EPOXY" }), L("RESIL", { MATERIAL: "RESILIENT" })]);
  assert.deepEqual(keys(r), ["CPT-1", "RB-1", "PT-1"]);
  assert.deepEqual(skippedOf(r), ["CONC", "EPOX", "RESIL"]);
});

test("limit: when 1–3-letter abbreviations already key today, a 4–5-letter legend line between them with two filled cells becomes a row", () => {
  const r = read([L("CPT", { MATERIAL: "CARPET", MANUFACTURER: "SEE SPEC" }), L("EPOX", { MATERIAL: "EPOXY", MANUFACTURER: "SEE SPEC" }), L("RB", { MATERIAL: "RUBBER BASE", MANUFACTURER: "SEE SPEC" }), CPT1, RB1]);
  assert.deepEqual(keys(r), ["CPT", "EPOX", "RB", "CPT-1", "RB-1"]);
});

test("limit: another 4–5-letter subheading with two filled cells between keyed rows keys as a row", () => {
  assert.deepEqual(keys(read([CPT1, L("SHEET", { MATERIAL: "GOODS", MANUFACTURER: "SEE SPEC" }), RB1])), ["CPT-1", "SHEET", "RB-1"]);
});

test("limit: a filled code with two code-shaped cells (EPOX | … | E-100 | C-12) → (r), not read, not counted", () => {
  asToday(spansOf([CPT1, L("EPOX", { MATERIAL: "EPOXY", MANUFACTURER: "E-100", COLOR: "C-12" }), RB1, PT1]), "EPOX two code cells");
});

test("limit: a one-span CONC  CONCRETE line is consumed as a material band, as today", () => {
  asToday(spansOf([CPT1, { t: "raw", spans: [["CONC  CONCRETE", COLS.KEY]] }, M("CONC-1", "SEALED", "VENDOR-D", "CLEAR"), RB1]), "CONC  CONCRETE");
});

// ── the stop set and the header words ───────────────────────────────────────
test("FOREIGN_HDR moved to sheetgraph and is re-exported by scheduleRead", () => {
  assert.equal(FOREIGN_HDR_RE_EXPORT, FOREIGN_HDR);
  for (const w of ["QTY", "MESSAGE", "CFM", "FRAME", "LOUVER"]) assert.ok(FOREIGN_HDR.has(w), w);
});

test("stop set covers every other-family word, singular and plural: each as a filled letters line reads as today", () => {
  // of OTHER_FAMILY_RE's words only DOOR / DOORS have four or five letters; the rest can't be a letters candidate
  for (const w of ["DOOR", "DOORS"]) assert.ok(isNonFinishSchedule(`${w} SCHEDULE`), w);
  for (const w of ["DOOR", "DOORS"]) {
    asToday(spansOf([CPT1, L(w, { MATERIAL: "HOLLOW METAL", MANUFACTURER: "VENDOR-R" }), RB1, PT1]), w);
  }
  for (const w of ["LEGEND", "NOTE", "NOTES", "TYPE", "ITEM", "ROOM", "LEVEL", "AREA", "FIELD", "WHERE", "PATCH", "MATCH", "REFER", "STAIR", "ABOVE", "APPLY", "CAULK", "COVE", "COVED", "SPEC",
    "PAINT", "TILE", "STONE", "VINYL", "WOOD", "GLASS", "METAL", "EPOXY", "STAIN", "GROUT", "BASE", "WALLS", "TRIM", "MISC", "FLOOR", "COLOR", "STYLE", "FRAME"].filter((x) => x.length >= 4 && x.length <= 5)) {
    asToday(spansOf([CPT1, L(w, { MATERIAL: "SOMETHING", MANUFACTURER: "VENDOR-Z" }), RB1, PT1]), w);
  }
});

test("a row left empty: a cell-less C whose only merged line was a skipped CONC line is dropped as a group label once C-1 follows", () => {
  // rows 76 px apart with a wrap line between (line pitch 38): pass 1 merges CONC (38 under C, 38 over C-1) into C
  const spans = at([[38, "CPT-1", { MATERIAL: "BROADLOOM", MANUFACTURER: "VENDOR-A" }], [76, "", { MATERIAL: "CARPET" }], [114, "C", {}],
    [152, "CONC", { MATERIAL: "SEALED CONCRETE" }], [190, "C-1", { MATERIAL: "SEALED CONCRETE", MANUFACTURER: "VENDOR-D" }], [228, "", { MATERIAL: "CLEAR COAT" }],
    [266, "C-2", { MATERIAL: "POLISHED CONCRETE", MANUFACTURER: "VENDOR-D" }]]);
  const plain = plainRows(spans);
  assert.deepEqual(plain.map((r) => r.key), ["CPT-1", "C", "C-1", "C-2"], "today C holds the CONC line and stays");
  assert.match(cellText(plain[1]), /CONC/);
  const r = readScheduleSpans(spans);
  assert.deepEqual(keys(r), ["CPT-1", "C-1", "C-2"]);
  assert.deepEqual(skippedOf(r), ["CONC"]);
});

test("a skipped line's run stops at the next decided line: the second one-cell code's wrap goes with it, not with the first", () => {
  // CPT-1@38, EPOX@76 and CONC@114 (one cell each), a wrap@133, RB-1@266, PT-1@304. Pass 1 (radius 137) merges all three
  // lines into CPT-1, so the wrap is within reach of EPOX's run too; it belongs to CONC, the line it hangs under.
  const spans = at([[38, "CPT-1", { MATERIAL: "BROADLOOM", MANUFACTURER: "VENDOR-A" }], [76, "EPOX", { MATERIAL: "EPOXY" }], [114, "CONC", { MATERIAL: "SEALED" }],
    [133, "", { MATERIAL: "CONCRETE" }], [266, "RB-1", { MATERIAL: "RUBBER BASE", MANUFACTURER: "VENDOR-B" }], [304, "PT-1", { MATERIAL: "PAINT", MANUFACTURER: "VENDOR-E" }]]);
  assert.match(cellText(plainRows(spans)[0]), /EPOXY.*SEALED.*CONCRETE/, "today CPT-1 holds all three lines");
  const d = readScheduleDebug(spans);
  assert.deepEqual(skippedOf(d.read), ["EPOX", "CONC"]);
  assert.deepEqual(d.consumed.map((c) => [c.text, c.reason]), [["EPOX EPOXY", "skipped"], ["CONC SEALED", "skipped"], ["CONCRETE", "continuation"]]);
  assert.equal(rowOf(d.read, "CPT-1").description, "BROADLOOM");
});

test("a letters word with another token in the key column (word-split SEAL | COAT) is not a candidate: read as today", () => {
  asToday(spansOf([CPT1, { t: "raw", spans: [["SEAL", COLS.KEY], ["COAT", COLS.KEY + 6 * CW], ["SEALER", COLS.MATERIAL], ["VENDOR-D", COLS.MANUFACTURER]] }, RB1, PT1]), "SEAL | COAT");
});

test("an all-letters MARK | DESCRIPTION | REMARKS table under FLOORING → { rows: [], skipped } (hasSection from the heading in the run); without the heading → refused", () => {
  const mk = (head: boolean) => build({ key: "MARK", cols: ["DESCRIPTION", "REMARKS"], colX: { REMARKS: 760 }, items: [
    ...(head ? [H("FLOORING")] : []),
    L("EPOX", { DESCRIPTION: "EPOXY FLOORING", REMARKS: "VENDOR-L" }), L("CONC", { DESCRIPTION: "SEALED CONCRETE", REMARKS: "VENDOR-D" }),
  ] });
  const m = readFinishMarquee(sheet(mk(true)));
  assert.ok(m && m.kind === "headerOnly");
  assert.equal(m.hasSection, true);
  assert.deepStrictEqual(readScheduleSpans(mk(true)), { rows: [], skipped: ["EPOX", "CONC"] });
  assert.deepStrictEqual(readScheduleSpans(mk(false)), { rows: [], refused: "no-color-style-pattern" });
});

test("measured (flagged): a legend 3 pitches below that mixes abbreviations today already reads (CPT, RB) with 4–5-letter ones → the 4–5-letter lines are skipped", () => {
  // CPT and RB key rows today (unchanged); as read rows they carry the run, so CONC / EPOX are reached and, with no numbered row after them, skipped
  const leg = (k: string, v: string): Item => ({ t: "raw", spans: [[k, COLS.KEY], [v, COLS.MATERIAL]] });
  const spans = spansOf([CPT1, CPT2, RB1, { t: "gap", n: 2 }, leg("CPT", "CARPET"), leg("CONC", "CONCRETE"), leg("EPOX", "EPOXY"), leg("RB", "RUBBER BASE")]);
  assert.deepEqual(plainRows(spans).map((r) => r.key), ["CPT-1", "CPT-2", "RB-1", "CPT", "RB"], "today");
  const r = readScheduleSpans(spans);
  assert.deepEqual(keys(r), ["CPT-1", "CPT-2", "RB-1", "CPT", "RB"]);
  assert.deepEqual(skippedOf(r), ["CONC", "EPOX"]);
});

test("the legacy shape (w = 0, what parseSchedule builds) reads every letters case as the cell shape does: keys and skipped", () => {
  const cases: Array<[string, GraphSpan[]]> = [
    ["mq-alternation", TWINS.find((t) => t.name === "mq-alternation")!.spans],
    ["both-short-cpt-rb-epox-pt", TWINS.find((t) => t.name === "both-short-cpt-rb-epox-pt")!.spans],
    ["ws-epox-two-cells", TWINS.find((t) => t.name === "ws-epox-two-cells")!.spans],
    ["all-letters", spansOf([EPOX, CONC, L("SEAL", { MATERIAL: "SEALER", MANUFACTURER: "VENDOR-D" })])],
    ["CONC one cell", spansOf([CPT1, ONE("CONC", "SEALED CONCRETE"), RB1])],
    ["(g)", spansOf([CPT1, L("CONC", { MATERIAL: "CONCRETE FINISHES" }), M("CONC-1", "SEALED", "VENDOR-D", "CLEAR"), M("CONC-2", "POLISHED", "VENDOR-D", "SATIN")])],
    ["(h)", spansOf([CPT1, L("LABEL", { MATERIAL: "DESCRIPTION", MANUFACTURER: "MANUFACTURER" }), RB1, PT1])],
    ["after a heading", spansOf([CPT1, CPT2, H("FLOORING"), EPOX, PT1])],
    ["EPOX, CONC filled", spansOf([CPT1, EPOX, RB1, CONC, PT1])],
  ];
  const sum = (r: ScheduleRead) => ({ keys: keys(r), skipped: skippedOf(r), refused: "refused" in r ? r.refused : undefined });
  for (const [name, spans] of cases) assert.deepEqual(sum(readAs(spans, "legacy")), sum(readAs(spans, "cell")), name);
  assert.deepEqual(keys(readAs(TWINS.find((t) => t.name === "mq-alternation")!.spans, "legacy")), ["CPT-1", "EPOX", "RB-1", "CONC", "PT-1"]);
});

// ── (a), (h), (s) and position, narrowed ────────────────
test("(h) needs a finish / equipment / foreign header word: PLAM | COUNTERTOP | CASEWORK between coded rows → a row", () => {
  const r = read([CPT1, L("PLAM", { MATERIAL: "COUNTERTOP", MANUFACTURER: "CASEWORK" }), RB1, PT1]);
  assert.deepEqual(keys(r), ["CPT-1", "PLAM", "RB-1", "PT-1"]);
  assert.ok(!has(r, "skipped"));
});

test("(h) needs two or more non-key tokens: SEAL | FLOOR between coded rows → skipped [SEAL]", () => {
  const r = read([CPT1, L("SEAL", { MATERIAL: "FLOOR" }), RB1, PT1]);
  assert.deepEqual(keys(r), ["CPT-1", "RB-1", "PT-1"]);
  assert.deepEqual(skippedOf(r), ["SEAL"]);
  // one non-key token that IS a finish header word (COLOR): still not (h) — reported, not consumed silently
  const c = read([CPT1, L("SEAL", { MATERIAL: "COLOR" }), RB1, PT1]);
  assert.deepEqual(keys(c), ["CPT-1", "RB-1", "PT-1"]);
  assert.deepEqual(skippedOf(c), ["SEAL"]);
});

test("(h): a word with a digit is never a header word: EPOX | COLOR 101 | SIZE 24 → a row", () => {
  const r = read([CPT1, L("EPOX", { MATERIAL: "COLOR 101", MANUFACTURER: "SIZE 24" }), RB1, PT1]);
  assert.deepEqual(keys(r), ["CPT-1", "EPOX", "RB-1", "PT-1"]);
});

test("(h) still takes a repeated LABEL | DESCRIPTION | MANUFACTURER, and DOOR | WIDTH | HEIGHT | FRAME (all FOREIGN_HDR / stop words) still reads as today", () => {
  const d = readScheduleDebug(spansOf([CPT1, L("LABEL", { MATERIAL: "DESCRIPTION", MANUFACTURER: "MANUFACTURER" }), RB1, PT1]));
  assert.deepEqual(d.consumed.map((c) => c.reason), ["h"]);
  for (const w of ["WIDTH", "HEIGHT", "FRAME"]) assert.ok(FOREIGN_HDR.has(w), w);
  for (const gap of [0, 2]) asToday(spansOf([CPT1, RB1, PT1, { t: "gap", n: gap }, { t: "raw", spans: [["DOOR", COLS.KEY], ["WIDTH", COLS.MATERIAL], ["HEIGHT", COLS.MANUFACTURER], ["FRAME", COLS.COLOR]] }]), `DOOR ${gap + 1}`);
});

test("(s) only with at most two cells: a filled EPOX | EPOXY FLOORING | VENDOR | 09 67 23 directly above EPOX-1 → a row; CONC | 03 35 00 | CONCRETE FINISHING above CONC-1 → still (s)", () => {
  const r = read([CPT1, L("EPOX", { MATERIAL: "EPOXY FLOORING", MANUFACTURER: "VENDOR-L", COLOR: "09 67 23" }), M("EPOX-1", "EPOXY TOPPING", "VENDOR-L", "09 67 23"), RB1]);
  assert.deepEqual(keys(r), ["CPT-1", "EPOX", "EPOX-1", "RB-1"]);
  const d = readScheduleDebug(spansOf([CPT1, L("CONC", { MATERIAL: "03 35 00", MANUFACTURER: "CONCRETE FINISHING" }), M("CONC-1", "SEALED CONCRETE", "VENDOR-D", "CLEAR")]));
  assert.deepEqual(d.consumed.map((c) => c.reason), ["s"]);
});

test("(a) sheens: a SATIN key-column wrap under PT-1 in evenly spaced two-line rows (30 px, ≥ 1.6 h) → PT-1 keeps its text as today, no row, no skipped", () => {
  for (const two of [false, true]) {
    const wrap: Cells = two ? { MATERIAL: "LINE 2", COLOR: "LINE 2" } : { MATERIAL: "LINE 2" };
    const spans = at([[38, "CPT-1", { MATERIAL: "CARPET", MANUFACTURER: "VENDOR-A", COLOR: "GREY" }], [68, "", { MATERIAL: "LINE 2" }],
      [106, "PT-1", { MATERIAL: "PAINT", MANUFACTURER: "VENDOR-E", COLOR: "WHITE 601" }], [136, "SATIN", wrap],
      [174, "RB-1", { MATERIAL: "RUBBER BASE", MANUFACTURER: "VENDOR-B", COLOR: "BLACK" }], [204, "", { MATERIAL: "LINE 2" }],
      [242, "PT-2", { MATERIAL: "PAINT", MANUFACTURER: "VENDOR-E", COLOR: "TAUPE" }], [272, "", { MATERIAL: "LINE 2" }]]);
    assert.match(cellText(plainRows(spans).find((x) => x.key === "PT-1")!), /SATIN/, "today PT-1 holds the wrap");
    asToday(spans, `SATIN wrap, ${two ? 2 : 1} cells`);
  }
});

test("I-1: a filled EPOX in a table keyed only by abbreviations (no numbered code below) → skipped [EPOX]", () => {
  const r = read([L("CPT", { MATERIAL: "CARPET", MANUFACTURER: "SEE SPEC" }), L("EPOX", { MATERIAL: "EPOXY", MANUFACTURER: "SEE SPEC" }), L("RB", { MATERIAL: "RUBBER BASE", MANUFACTURER: "SEE SPEC" })]);
  assert.deepEqual(keys(r), ["CPT", "RB"]);
  assert.deepEqual(skippedOf(r), ["EPOX"]);
});

test("I-2: a two-cell spec-section label CONC | 03 35 00 | … above CONC1 (word + digit, no dash) → consumed (s)", () => {
  const d = readScheduleDebug(spansOf([CPT1, L("CONC", { MATERIAL: "03 35 00", MANUFACTURER: "CONCRETE FINISHING" }), M("CONC1", "SEALED CONCRETE", "VENDOR-D", "CLEAR")]));
  assert.deepEqual(keys(d.read), ["CPT-1", "CONC1"]);
  assert.ok(!has(d.read, "skipped"));
  assert.deepEqual(d.consumed.map((c) => c.reason), ["s"]);
});

// ── (h): header words split on whitespace and "/" ──
test("(h) splits header words on \"/\" too: LABEL | DESCRIPTION | MANUFACTURER/PRODUCT and ABBR | DESCRIPTION | MFR/STYLE | COLOR → (h), no row, no skipped", () => {
  for (const [key, cells] of [["LABEL", { MATERIAL: "DESCRIPTION", MANUFACTURER: "MANUFACTURER/PRODUCT" }], ["ABBR", { MATERIAL: "DESCRIPTION", MANUFACTURER: "MFR/STYLE", COLOR: "COLOR" }]] as Array<[string, Cells]>) {
    const d = readScheduleDebug(spansOf([CPT1, L(key, cells), RB1, PT1]));
    assert.deepEqual(keys(d.read), ["CPT-1", "RB-1", "PT-1"], key);
    assert.ok(!has(d.read, "skipped"), key);
    assert.deepEqual(d.consumed.map((c) => c.reason), ["h"], key);
  }
});

// ── a key-column word on a row's own second line ────────────────────────────
// Two-line rows spaced evenly at 1.6 × the text height or more: the second
// line sits a full line below its row, as a code line would. A four- or
// five-letter word starting it (EXIST., OWNER, SHEEN) is that row's wrap when
// it sits at the same offset below its row (within 0.3 × its text height) as
// another row's own second line: it stays on its row, as today.
/** PT-1, PT-2, PT-3, CT-1, each two lines `s` px apart, `pad` px between rows;
 *  PT-2's second line starts with `word` in the key column (`dy` px off `s`)
 *  and fills one or two cells; every other row's second line fills two cells */
function twoLineRows(word: string, cells: 1 | 2, s: number, pad: number, dy = 0): GraphSpan[] {
  const rows: Array<[number, string, Cells?]> = [];
  let y = 40;
  for (const [k, mat, mfr, color] of [["PT-1", "PAINT", "VENDOR-E", "WHITE 601"], ["PT-2", "PAINT", "VENDOR-E", "TAUPE 602"], ["PT-3", "PAINT", "VENDOR-E", "GREY 603"], ["CT-1", "CERAMIC TILE", "VENDOR-F", "WHITE 604"]]) {
    rows.push([y, k, { MATERIAL: mat, MANUFACTURER: mfr, COLOR: color }]);
    if (k === "PT-2") rows.push([y + s + dy, word, cells === 2 ? { MATERIAL: "SEMI-GLOSS", MANUFACTURER: "ACME DIV." } : { MATERIAL: "SEMI-GLOSS" }]);
    else rows.push([y + s, "", { MATERIAL: "EGGSHELL", MANUFACTURER: "ACME DIV." }]);
    y += 2 * s + pad;
  }
  return at(rows);
}

test("a 4–5-letter word starting a row's second line in evenly spaced two-line rows (≥ 1.6 h) → the row keeps its text as today: no row, nothing skipped", () => {
  for (const word of ["EXIST.", "(EXIST.)", "OWNER", "SHEEN"]) for (const cells of [1, 2] as const) for (const s of [28, 31, 34]) for (const pad of [0, 4, 6, 8, 10]) {
    const where = `${word}, ${cells} cell(s), lines ${s} px apart, ${pad} px between rows`;
    const spans = twoLineRows(word, cells, s, pad);
    const r = readScheduleSpans(spans);
    assert.deepEqual(keys(r), ["PT-1", "PT-2", "PT-3", "CT-1"], where);
    assert.match(rowOf(r, "PT-2").description, /SEMI-GLOSS/, where);
    if (cells === 2) assert.match(rowOf(r, "PT-2").manufacturer, /ACME DIV\./, where);
    asToday(spans, where);
  }
});

test("the wrap offset matches within max(1 px, 0.1 × the text height): a second line 1 px lower than the other rows' → still the row's wrap", () => {
  for (const cells of [1, 2] as const) {
    const spans = twoLineRows("OWNER", cells, 31, 6, 1);
    asToday(spans, `${cells} cell(s), 1 px off`);
    assert.match(rowOf(readScheduleSpans(spans), "PT-2").description, /SEMI-GLOSS/);
  }
});

test("the 1 px floor: in 8 px text a second line 1 px lower than the other rows' is still the row's wrap", () => {
  for (const cells of [1, 2] as const) {
    const spans = twoLineRows("OWNER", cells, 31, 6, 1).map((t) => ({ ...t, h: 8 }));
    asToday(spans, `${cells} cell(s), 8 px text, 1 px off`);
  }
});

/** CPT-1 (two lines), CPT-2 (one line), a letters line one line pitch plus `pad` under CPT-2,
 *  RB-1 (two lines), PT-1: lines `s` px apart, `pad` px between rows */
function mixedRows(cells: 1 | 2, s: number, pad: number): GraphSpan[] {
  const rows: Array<[number, string, Cells?]> = [];
  let y = 40;
  const row = (k: string, c: Cells, wrap?: Cells) => { rows.push([y, k, c]); if (wrap) { rows.push([y + s, "", wrap]); y += s; } y += s + pad; };
  row("CPT-1", { MATERIAL: "CARPET", MANUFACTURER: "VENDOR-A", COLOR: "GREY 101" }, { MATERIAL: "BROADLOOM", MANUFACTURER: "DIV. 2" });
  row("CPT-2", { MATERIAL: "CARPET", MANUFACTURER: "VENDOR-A", COLOR: "BLUE 202" });
  row("EPOX", cells === 2 ? { MATERIAL: "EPOXY FLOORING", MANUFACTURER: "VENDOR-L", COLOR: "GREY 901" } : { MATERIAL: "EPOXY FLOORING" });
  row("RB-1", { MATERIAL: "RUBBER BASE", MANUFACTURER: "VENDOR-B", COLOR: "BLACK 505" }, { MATERIAL: "COVE", MANUFACTURER: "DIV. 3" });
  row("PT-1", { MATERIAL: "PAINT", MANUFACTURER: "VENDOR-E", COLOR: "WHITE 601" });
  return at(rows);
}

test("a real EPOX under a one-line row, a few px of row padding past the wrap offset → still a row (filled) or skipped (one cell)", () => {
  for (const pad of [3, 5]) {
    const r2 = readScheduleSpans(mixedRows(2, 31, pad));
    assert.deepEqual(keys(r2), ["CPT-1", "CPT-2", "EPOX", "RB-1", "PT-1"], `pad ${pad}`);
    assert.equal(rowOf(r2, "CPT-2").description, "CARPET", `pad ${pad}`);
    assert.deepEqual(skippedOf(readScheduleSpans(mixedRows(1, 31, pad))), ["EPOX"], `pad ${pad}, one cell`);
  }
});

test("limit: a real EPOX exactly at the wrap offset (no row padding) reads as that row's second line, as today", () => {
  for (const cells of [1, 2] as const) {
    const spans = mixedRows(cells, 31, 0);
    asToday(spans, `${cells} cell(s), padding 0`);
    assert.match(rowOf(readScheduleSpans(spans), "CPT-2").description, /EPOXY FLOORING/);
  }
});

test("a filled EPOX 6 px (over 0.3 × the text height) off the table's wrap offset → still a row; one-cell → still skipped", () => {
  const r2 = readScheduleSpans(twoLineRows("EPOX", 2, 31, 6, 6));
  assert.deepEqual(keys(r2), ["PT-1", "PT-2", "EPOX", "PT-3", "CT-1"]);
  assert.equal(rowOf(r2, "EPOX").key_rule, "extended");
  assert.equal(rowOf(r2, "PT-2").description, "PAINT");
  const r1 = readScheduleSpans(twoLineRows("EPOX", 1, 31, 6, 6));
  assert.deepEqual(skippedOf(r1), ["EPOX"]);
});

test("a code line at the table's wrap offset is not a four- or five-letter word: CPT-9 NOT USED there still reads as its own row", () => {
  const r = readScheduleSpans(twoLineRows("CPT-9 NOT USED", 1, 31, 6));
  assert.deepEqual(keys(r), ["PT-1", "PT-2", "CPT-9", "PT-3", "CT-1"]);
  assert.equal(rowOf(r, "CPT-9").unticked_reason, "not-used");
});

test("a code line split out of the row above is not a wrap to measure by: short CPT-1, FTB-01 CUT (C), RB-1, EPOX, PT-1 → five rows", () => {
  const spans = spansOf([CPT1, M("FTB-01 CUT (C)", "CERAMIC TILE BASE", "VENDOR-F", "WHITE"), RB1, EPOX, PT1]);
  assert.deepEqual(plainRows(spans).map((r) => r.key), ["CPT-1", "RB-1", "PT-1"], "today both lines are merged into the row above");
  const r = readScheduleSpans(spans);
  assert.deepEqual(keys(r), ["CPT-1", "FTB-01", "RB-1", "EPOX", "PT-1"]);
  assert.ok(!has(r, "skipped"));
});

test("a repeated header line consumed out of the row above is not a wrap to measure by: short CPT-1, LABEL | DESCRIPTION | MANUFACTURER, RB-1, EPOX, PT-1 → EPOX a row", () => {
  const d = readScheduleDebug(spansOf([CPT1, L("LABEL", { MATERIAL: "DESCRIPTION", MANUFACTURER: "MANUFACTURER" }), RB1, EPOX, PT1]));
  assert.deepEqual(keys(d.read), ["CPT-1", "RB-1", "EPOX", "PT-1"]);
  assert.deepEqual(d.consumed.map((c) => [c.reason, c.owner]), [["h", "CPT-1"]]);
});
