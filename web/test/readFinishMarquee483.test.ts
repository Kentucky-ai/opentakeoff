// #483 PR A: the marquee entry point. readFinishMarquee runs the finish
// reader with the drawn-box rules switched on and says which of three things
// the box holds — a finish table, a table titled as another schedule family,
// or a header with no row read under it (headerOnly). readScheduleSpans reads
// through it; a headerOnly box with nothing skipped is still "no-table". The
// rules' own cases live in keyCell483 and letters483; here every marquee twin
// reads as its expectation (expectedChanges, else its golden).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFinishMarquee, readFinishTable, type GraphSpan } from "../src/lib/sheetgraph.ts";
import { readScheduleSpans, parseSchedule } from "../src/lib/scheduleRead.ts";
import {
  TWINS, CONTROL_SPANS, CONTROLS_GOLDEN, GOLDEN_DIR_URL, SHAPES, expectedChanges, expectedReadAt, goldenFile, hasMarquee,
  legacyTokens, readAs, roundTrip, build, sp, H, M, MMC, FLOOR, BASE, STD, CURRENT_SLICE,
} from "./fixtures/reader483Fixtures.ts";

const dir = fileURLToPath(GOLDEN_DIR_URL);
const golden = (file: string): any => JSON.parse(readFileSync(dir + file, "utf8"));
const sheet = (spans: GraphSpan[]) => ({ key: "crop", spans });
const has = (o: object, f: string) => Object.prototype.hasOwnProperty.call(o, f);
/** a twin whose marquee read a slice after 2, at or below CURRENT_SLICE, changes (expectedChanges483.test.ts checks it) */
const changedAfter2 = (name: string) => (expectedChanges[name]?.changes ?? []).some((c) => c.slice > 2 && c.slice <= CURRENT_SLICE);

/** No key starting with "_" anywhere in a value, and no field PR A adds to TableRow before its slice. */
function assertNoInternals(v: unknown, where: string, path = "$") {
  if (Array.isArray(v)) { v.forEach((x, i) => assertNoInternals(x, where, `${path}[${i}]`)); return; }
  if (!v || typeof v !== "object") return;
  for (const k of Object.keys(v)) {
    assert.ok(!k.startsWith("_"), `${where}: no internal ${path}.${k}`);
    assertNoInternals((v as Record<string, unknown>)[k], where, `${path}.${k}`);
  }
}
const MARQUEE_KEYS = {
  table: ["guardRegion", "hasSection", "headerWords", "kind", "skipped", "table"],
  "other-family": ["kind", "table"],
  headerOnly: ["hasSection", "headerWords", "headers", "kind", "region", "skipped", "title"],
};

test("slice gate: the fixtures module is at slice 2 or later", () => {
  assert.ok(CURRENT_SLICE >= 2);
});

// ── the three kinds ─────────────────────────────────────────────────────────
test("readFinishMarquee: a finish table → kind table, the plain marquee read's table and header words, guardRegion = its region, skipped []", () => {
  const spans = build({ cols: STD, items: [H("FLOORING"), ...FLOOR, H("BASE"), ...BASE] });
  const m = readFinishMarquee(sheet(spans));
  const plain = readFinishTable(sheet(spans), { marquee: true });
  assert.ok(m && m.kind === "table" && plain && !("refused" in plain));
  assert.deepEqual(Object.keys(m).sort(), MARQUEE_KEYS.table);
  assert.deepStrictEqual(m.table, plain.table);
  assert.deepStrictEqual(m.headerWords, plain.headerWords);
  assert.deepStrictEqual(m.guardRegion, plain.table.region);
  assert.equal(m.hasSection, true);
  assert.deepStrictEqual(m.skipped, []);
  assertNoInternals(m, "table");
});

test("readFinishMarquee: a table with no printed heading → hasSection false", () => {
  const spans = build({ cols: STD, items: [...FLOOR, ...BASE] });
  const m = readFinishMarquee(sheet(spans));
  assert.ok(m && m.kind === "table");
  assert.equal(m.hasSection, false);
});

test("readFinishMarquee: a table titled as another family → kind other-family, the plain read's table", () => {
  const spans = build({ cols: MMC, title: "DOOR SCHEDULE", items: [M("D-1", "HOLLOW METAL", "VENDOR-R", "BLACK"), M("D-2", "WOOD", "VENDOR-S", "OAK")] });
  const m = readFinishMarquee(sheet(spans));
  const plain = readFinishTable(sheet(spans), { marquee: true });
  assert.ok(m && m.kind === "other-family" && plain && "refused" in plain);
  assert.deepEqual(Object.keys(m).sort(), MARQUEE_KEYS["other-family"]);
  assert.deepStrictEqual(m.table, plain.table);
  assertNoInternals(m, "other-family");
  assert.deepEqual(readScheduleSpans(spans), { rows: [], refused: "title", title: "DOOR SCHEDULE" });
});

test("readFinishMarquee: no header → null", () => {
  assert.equal(readFinishMarquee(sheet([sp("CPT-1", 100, 0), sp("CARPET", 220, 0)])), null);
  assert.equal(readFinishMarquee(sheet([])), null);
});

// ── byte-identical through the new entry point ──────────────────────────────
test("every marquee twin: readScheduleSpans and parseSchedule are their slice-2 expectation (golden unless an entry ≤ 2 says otherwise)", () => {
  for (const t of TWINS.filter(hasMarquee)) {
    if (changedAfter2(t.name)) continue;
    const g = golden(goldenFile(t.name)).marquee;
    const e = expectedChanges[t.name];
    const want = (e && expectedReadAt(e, 2)) ?? g.readScheduleSpans;
    assert.deepStrictEqual(roundTrip(readScheduleSpans(t.spans)), roundTrip(want), `${t.name} readScheduleSpans`);
    if (!e || !expectedReadAt(e, 2)) assert.deepStrictEqual(roundTrip(parseSchedule(legacyTokens(t.spans))), g.parseSchedule, `${t.name} parseSchedule`);
  }
});

test("controls: every shape's readScheduleSpans is its golden", () => {
  const g = golden(CONTROLS_GOLDEN);
  for (const s of SHAPES) assert.deepStrictEqual(roundTrip(readAs(CONTROL_SPANS, s)), g.reads[s], s);
});

test("every twin: a table / other-family readFinishMarquee carries exactly the plain marquee read's table; guardRegion = its region; nothing internal leaks", () => {
  for (const t of TWINS) {
    // from slice 3 the marquee rules read key-cell forms in the whole-sheet twins too (keyCell483.test.ts pins those reads)
    if (changedAfter2(t.name) || (CURRENT_SLICE > 2 && !hasMarquee(t))) continue;
    const m = readFinishMarquee(sheet(t.spans));
    const plain = readFinishTable(sheet(t.spans), { marquee: true });
    if (!m) { assert.equal(plain, null, t.name); continue; }
    assertNoInternals(m, t.name);
    assert.deepEqual(Object.keys(m).sort(), MARQUEE_KEYS[m.kind], t.name);
    if (m.kind === "headerOnly") { assert.equal(plain, null, t.name); continue; }
    assert.ok(plain, t.name);
    assert.equal(m.kind === "other-family", "refused" in plain, t.name);
    assert.deepStrictEqual(m.table, plain.table, t.name);
    for (const r of m.table.rows) for (const f of ["qualifier", "notUsed", "notUsedText", "keyRule"]) assert.ok(!has(r, f), `${t.name}: ${r.key} has no ${f}`);
    if (m.kind === "table" && !("refused" in plain)) {
      assert.deepStrictEqual(m.headerWords, plain.headerWords, t.name);
      assert.deepStrictEqual(m.guardRegion, plain.table.region, t.name);
      assert.equal(m.hasSection, plain.table.rows.some((x) => x.section), t.name);
    }
  }
});
