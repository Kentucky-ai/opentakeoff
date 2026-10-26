// #483 PR A: characterization goldens for the finish reader. The
// goldens (test/fixtures/reader-483/*.json) were captured from the base
// reader by test/fixtures/capture-reader-483.ts and are never edited; every
// fixture lives in test/fixtures/reader483Fixtures.ts. The invariants:
//   - a whole-sheet read (extractTable, readFinishTable with { marquee: true },
//     buildSheetGraph's tables and notes, resolveTag) never changes;
//   - readFinishTable(…, { marquee: true }) rows never change for any twin;
//   - a marquee twin's readScheduleSpans / parseSchedule read is exact until
//     a slice listed in its expectedChanges entry lands (CURRENT_SLICE);
//   - no field PR A adds appears where it isn't set: TableRow qualifier /
//     notUsed / notUsedText / keyRule and `_` internals never on these reads,
//     ScheduleRow key_rule / unticked_reason / not_used_text and the read's
//     skipped never on an unchanged twin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TableRow } from "../src/lib/sheetgraph.ts";
import type { ScheduleRead } from "../src/lib/scheduleRead.ts";
import type { ScheduleRow } from "../src/lib/scheduleRows.ts";
import {
  CURRENT_SLICE, TWINS, SHAPES, SHAPES_READ, CONTROL_ITEMS, CONTROL_SPANS, CONTROLS_GOLDEN, GOLDEN_DIR_URL,
  expectedChanges, expectedReadAt, type ExpectedRead, goldenFile, hasMarquee, hasWhole, keysOf, liveControls, liveMarquee, liveWhole, roundTrip,
  shape, build, sp, readAs, CW, TH,
} from "./fixtures/reader483Fixtures.ts";

const dir = fileURLToPath(GOLDEN_DIR_URL);
const golden = (file: string): any => JSON.parse(readFileSync(dir + file, "utf8"));

/** own-property presence on the LIVE object (a JSON round-trip would hide an undefined-valued key) */
const has = (o: object, f: string) => Object.prototype.hasOwnProperty.call(o, f);
const TABLE_ROW_ABSENT = ["qualifier", "notUsed", "notUsedText", "keyRule"];
const SCHEDULE_ROW_ABSENT = ["key_rule", "unticked_reason", "not_used_text", "read_as"];
function assertTableRowsBare(rows: TableRow[] | undefined, where: string) {
  for (const r of rows ?? []) {
    for (const f of TABLE_ROW_ABSENT) assert.ok(!has(r, f), `${where}: ${r.key} has no ${f}`);
    for (const f of Object.keys(r)) assert.ok(!f.startsWith("_"), `${where}: ${r.key} has no internal ${f}`);
  }
}
function assertReadBare(read: ScheduleRead, rows: ScheduleRow[], where: string) {
  assert.ok(!has(read, "skipped"), `${where}: no skipped`);
  for (const r of rows) for (const f of SCHEDULE_ROW_ABSENT) assert.ok(!has(r, f), `${where}: ${r.finish_tag} has no ${f}`);
}
/** a twin whose marquee read a slice at or below CURRENT_SLICE changes */
const changedNow = (name: string) => (expectedChanges[name]?.changes ?? []).some((c) => c.slice <= CURRENT_SLICE);

test("every twin has its golden, and the golden directory holds nothing else", () => {
  const want = [...TWINS.map((t) => goldenFile(t.name)), CONTROLS_GOLDEN].sort();
  assert.deepEqual(readdirSync(dir).sort(), want);
  assert.equal(new Set(TWINS.map((t) => t.name)).size, TWINS.length, "twin names are unique");
});

test("the fixtures are the spans the goldens were captured from", () => {
  for (const t of TWINS) assert.deepStrictEqual(roundTrip(t.spans), golden(goldenFile(t.name)).spans, t.name);
});

test("expectedChanges: marquee twins only; counts, keys and full reads agree per slice; every change is tagged and traceable", () => {
  const byName = new Map(TWINS.map((t) => [t.name, t]));
  for (const [name, e] of Object.entries(expectedChanges)) {
    const t = byName.get(name);
    assert.ok(t && hasMarquee(t), `${name} is a marquee twin`);
    assert.equal(e.counts.length, 7, `${name}: counts for slices 0–6`);
    assert.equal(e.keys.length, 7, `${name}: keys for slices 0–6`);
    const g = golden(goldenFile(name)).marquee.readScheduleSpans;
    assert.ok(!e.reads[0 as never], `${name}: slice 0 is the golden`);
    for (let s = 0; s <= 6; s++) {
      const want = expectedReadAt(e, s) ?? g;
      assert.deepEqual(e.keys[s], want.rows.map((r: { finish_tag: string }) => r.finish_tag), `${name}: keys at slice ${s}`);
      assert.equal(e.counts[s], e.keys[s].length, `${name}: count at slice ${s}`);
    }
    // a slice changes the read exactly when a change is tagged with it
    const tagged = new Set(e.changes.map((c) => c.slice));
    for (const s of [1, 2, 3, 4] as const) assert.equal(!!e.reads[s], tagged.has(s), `${name}: slice ${s} has a full read iff it has changes`);
    for (const c of e.changes) {
      assert.ok(c.clause.length > 0, `${name}: ${c.kind} has a clause`);
      const at = expectedReadAt(e, c.slice)!;
      const before = expectedReadAt(e, c.slice - 1) ?? g;
      const keysAt = at.rows.map((r) => r.finish_tag), keysBefore = before.rows.map((r: { finish_tag: string }) => r.finish_tag);
      if (c.kind === "added-row") for (const k of c.rows!) { assert.ok(keysAt.includes(k) && !keysBefore.includes(k), `${name}: ${k} is new at slice ${c.slice}`); }
      if (c.kind === "group-drop") for (const k of c.rows!) assert.ok(!keysAt.includes(k) && keysBefore.includes(k), `${name}: ${k} is dropped at slice ${c.slice}`);
      if (c.kind === "unglue") { assert.ok(c.tokens?.length, `${name}: unglue names its tokens`); for (const k of c.rows!) assert.ok(keysBefore.includes(k), `${name}: unglue source ${k} exists before slice ${c.slice}`); }
      if (c.kind === "refusal-flip") {
        const side = (r: ExpectedRead | ScheduleRead) => ("refused" in r ? r.refused : "rows");
        assert.deepEqual([side(before), side(at)], [c.fields!.from, c.fields!.to], `${name}: refusal-flip`);
      } else if (c.fields) {
        for (const k of c.rows!) {
          const r = at.rows.find((x) => x.finish_tag === k);
          assert.ok(r, `${name}: ${k} at slice ${c.slice}`);
          for (const [f, v] of Object.entries(c.fields)) assert.deepEqual((r as Record<string, unknown>)[f], v, `${name}: ${k}.${f} at slice ${c.slice}`);
        }
      }
    }
    if (!e.changes.length) assert.ok(e.reason, `${name}: an empty entry says why`);
  }
});

// ── controls ────────────────────────────────────────────────────
test("controls: each shape's plain FLOOR + BASE read is its golden; cell and legacy read every row", () => {
  const live = liveControls();
  assert.deepStrictEqual(roundTrip(live), golden(CONTROLS_GOLDEN));
  const want = keysOf(CONTROL_ITEMS);
  for (const s of SHAPES_READ) {
    const r = live.reads[s];
    assert.ok(!("refused" in r), s);
    assert.deepEqual(r.rows.map((x) => x.finish_tag), want, s);
  }
  // legacy (w = 0, what parseSchedule builds) reads exactly what cell reads
  assert.deepStrictEqual(live.reads.legacy, live.reads.cell);
  assert.deepEqual(live.legacyKeys, want);
  // words (word-split spans with widths) mis-bands the cells today: out of scope, pinned
  assert.notDeepStrictEqual(live.reads.words, live.reads.cell);
});

test("shape builder: words split each span at CW per character, headers included; legacy drops widths", () => {
  const spans = [sp("CODE", 100, 0), sp("FTB-01 CUT (C)", 100, 38)];
  assert.deepStrictEqual(shape(spans, "words"), [
    { str: "CODE", x: 100, y: 0, w: 4 * CW, h: TH },
    { str: "FTB-01", x: 100, y: 38, w: 6 * CW, h: TH }, { str: "CUT", x: 100 + 7 * CW, y: 38, w: 3 * CW, h: TH }, { str: "(C)", x: 100 + 11 * CW, y: 38, w: 3 * CW, h: TH },
  ]);
  assert.ok(shape(spans, "words-legacy").every((s) => s.w === 0));
  assert.deepStrictEqual(shape(spans, "legacy").map((s) => [s.str, s.w]), [["CODE", 0], ["FTB-01 CUT (C)", 0]]);
  assert.deepStrictEqual(shape(spans, "cell"), spans);
  for (const s of SHAPES) assert.ok(readAs(CONTROL_SPANS, s));
});

test("builder: a header span can sit offset from its column; its cells stay at the column", () => {
  const base = build({ cols: ["MATERIAL"], items: [{ t: "row", key: "CPT-1", cells: { MATERIAL: "CARPET" } }] });
  const off = build({ cols: ["MATERIAL"], items: [{ t: "row", key: "CPT-1", cells: { MATERIAL: "CARPET" } }], hdrOffset: { MATERIAL: [12, -6] } });
  assert.deepEqual(off.find((s) => s.str === "MATERIAL"), { ...base.find((s) => s.str === "MATERIAL")!, x: 232, y: -6 });
  assert.deepEqual(off.find((s) => s.str === "CARPET"), base.find((s) => s.str === "CARPET"));
});

// ── whole-sheet twins: exact, at every slice ────────────────────────────────
for (const t of TWINS.filter(hasWhole)) {
  test(`whole-sheet twin ${t.name}: extractTable, readFinishTable(marquee), graph tables/notes, resolveTag are the golden`, () => {
    const live = liveWhole(t.spans);
    assert.deepStrictEqual(roundTrip(live), golden(goldenFile(t.name)).whole);
    assertTableRowsBare(live.extractTable?.rows, `${t.name} extractTable`);
    assertTableRowsBare(live.finishRows?.rows, `${t.name} readFinishTable`);
    for (const tb of live.graphTables) assertTableRowsBare(tb.rows, `${t.name} graph`);
  });
}

// ── marquee twins ───────────────────────────────────────────────────────────
for (const t of TWINS.filter(hasMarquee)) {
  test(`marquee twin ${t.name}: readFinishTable(marquee) rows are the golden${changedNow(t.name) ? "" : "; readScheduleSpans and parseSchedule too"}`, () => {
    const live = liveMarquee(t.spans);
    const g = golden(goldenFile(t.name)).marquee;
    // the plain { marquee: true } read is byte-identical at every slice
    assert.deepStrictEqual(roundTrip(live.finishRows), g.finishRows);
    assertTableRowsBare(live.finishRows?.rows, `${t.name} readFinishTable`);
    // the marquee read changes only at a slice its expectedChanges entry names
    // (expectedChanges483.test.ts checks those entries)
    if (changedNow(t.name)) return;
    assert.deepStrictEqual(roundTrip(live.readScheduleSpans), g.readScheduleSpans);
    assert.deepStrictEqual(roundTrip(live.parseSchedule), g.parseSchedule);
    assertReadBare(live.readScheduleSpans, live.readScheduleSpans.rows, `${t.name} readScheduleSpans`);
    for (const r of live.parseSchedule) for (const f of SCHEDULE_ROW_ABSENT) assert.ok(!has(r, f), `${t.name} parseSchedule: ${r.finish_tag} has no ${f}`);
  });
}
