// Import from schedule on real sheets: the canvas's path — page text →
// pageSpans → marquee crop → the shared finish reader (web/src/lib/
// scheduleRead.ts) — run on the bundled demo plan and tracked fixtures.
//
// The demo's material schedule (page 2) is pinned row for row: 28 keys in
// print order, the joined descriptions, each row's category and where it came
// from, which rows start ticked, and the 8 REMARKS cells. What changed from
// the old CODE-only marquee parser, on purpose: the MISC block no longer
// reads as ceilings, unticked (the old parser never recognised the
// "MISC. FINISHES" heading, so those rows stayed under CEILINGS) — its rows
// go by their own words (TS-1/TS-2 transition, HR-1/CR-1/CG-1 wall
// protection, PR-1 no section), all ticked;
// the REMARKS cells are remarks, not SIZE; and a marquee around the whole
// sheet reads the same 28 rows as one around the table. Assertions are
// vendor-neutral: no maker names.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { openPdf, type PageHandle } from "../src/pdf.ts";
import { pageSpans, spansInRect, graphSpans } from "../../web/src/lib/pageSpans.ts";
import { readScheduleSpans, type ScheduleRead } from "../../web/src/lib/scheduleRead.ts";
import { parseSchedule } from "../../web/src/lib/scheduleParse.ts";
import { extractRegionText } from "../../web/src/lib/sheets.ts";
import { RENDER_SCALE } from "../../web/src/lib/takeoffConstants.ts";
import type { ScheduleRow } from "../../web/src/lib/scheduleRows.ts";

const DEMO = fileURLToPath(new URL("../../web/public/demo/sample-finish-plan.pdf", import.meta.url));
const ANNOTATED = fileURLToPath(new URL("./fixtures/annotated-set.pdf", import.meta.url));
type Rect = { x0: number; y0: number; x1: number; y1: number };
const SHEET: Rect = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };

async function page(file: string, n: number): Promise<PageHandle> {
  return (await openPdf(file)).page(n);
}
/** The canvas's read of a marquee (at the MCP's render scale). */
const readRect = (ph: PageHandle, r: Rect): ScheduleRead =>
  readScheduleSpans(graphSpans(spansInRect(pageSpans(ph.textContent.items, ph.viewport.transform, RENDER_SCALE), r)));
const rowsOf = (r: ScheduleRead): ScheduleRow[] => {
  assert.ok(!("refused" in r), `read, not refused (${"refused" in r ? r.refused : ""})`);
  return r.rows;
};

// ── the demo's material schedule ────────────────────────────────────────────
/** A marquee around the material schedule, title included. */
const DEMO_TABLE: Rect = { x0: 2950, y0: 250, x1: 4720, y1: 1900 };

/** key → [section, category, category_source, ticked, description], in print order. */
const DEMO_ROWS: Array<[string, string, string, string, boolean, string]> = [
  ["CPT-1", "FLOORING", "floor", "heading", true, "BROADLOOM CARPET"],
  ["CPT-2", "FLOORING", "floor", "heading", true, "MODULAR CARPET TILE"],
  ["VCT-1", "FLOORING", "floor", "heading", true, "VINYL COMPOSITION TILE"],
  ["PT-1", "FLOORING", "floor", "heading", true, "PORCELAIN CERAMIC TILE"],
  ["PT-2", "FLOORING", "floor", "heading", true, "PORCELAIN CERAMIC TILE"],
  ["C", "FLOORING", "floor", "heading", true, "CONCRETE SEALER"],
  ["RB-1", "BASE", "base", "heading", true, "RESILIENT BASE"],
  ["CBT-1", "BASE", "base", "heading", true, "CARPET WALL BASE"],
  ["CT-3", "BASE", "base", "heading", true, "CERAMC WALL TILE"],
  ["P-1", "WALLS", "wall", "heading", true, "PAINT"],
  ["P-2", "WALLS", "wall", "heading", true, "PAINT"],
  ["P-3", "WALLS", "wall", "heading", true, "PAINT"],
  ["CT-1", "WALLS", "wall", "heading", true, "CERAMIC WALL TILE"],
  ["CT-2", "WALLS", "wall", "heading", true, "CERAMIC WALL TILE"],
  ["CT-4", "WALLS", "wall", "heading", true, "CERAMIC WALL TILE"],
  ["SC-1", "WALLS", "wall", "heading", true, "SPECIAL COATING"],
  ["PLAM-1", "MILLWORK", "other", "heading", false, "PLASTIC LAMINATE"],
  ["PLAM-2", "MILLWORK", "other", "heading", false, "PLASTIC LAMINATE"],
  ["S-1", "MILLWORK", "other", "heading", false, "SOLID SURFACE"],
  ["S-2", "MILLWORK", "other", "heading", false, "SOLID SURFACE SINK"],
  ["ACT-1", "CEILINGS", "ceiling", "heading", false, "ACOUSTIAL CEILING TILE"],
  ["ACT-2", "CEILINGS", "ceiling", "heading", false, "ACOUSTIAL CEILING TILE"],
  ["PR-1", "MISC", "unassigned", "none", true, "METAL TILE TRIM"],
  ["TS-1", "MISC", "transition", "text", true, "METAL TRANSITION STRIP"],
  ["TS-2", "MISC", "transition", "text", true, "VINYL TRANSITION STRIP"],
  ["HR-1", "MISC", "wall_protection", "text", true, "HANDRAIL"],
  ["CR-1", "MISC", "wall_protection", "text", true, "CRASH RAIL"],
  ["CG-1", "MISC", "wall_protection", "text", true, "CORNER GUARDS"],
];
/** The 8 REMARKS cells the demo prints (grout and sheen notes). */
const DEMO_REMARKS: Record<string, RegExp> = {
  "PT-1": /^GROUT: /, "PT-2": /^GROUT: /, "CT-1": /^GROUT: /, "CT-2": /^GROUT: /, "CT-4": /^GROUT: /,
  "PLAM-1": /^60 MATTE$/, "PLAM-2": /^38 FINE VELVET$/, "S-1": /^MATTE$/,
};

function assertDemoRows(rows: ScheduleRow[]) {
  assert.deepEqual(
    rows.map((r) => [r.finish_tag, r.section, r.category, r.category_source, r.suggested, r.description]),
    DEMO_ROWS,
  );
  const withRemarks = rows.filter((r) => r.remarks);
  assert.deepEqual(withRemarks.map((r) => r.finish_tag), Object.keys(DEMO_REMARKS));
  for (const r of withRemarks) assert.match(r.remarks, DEMO_REMARKS[r.finish_tag], r.finish_tag);
  // the remarks are no longer read into SIZE
  for (const r of rows) assert.ok(!/GROUT|MATTE|VELVET/.test(r.size), `${r.finish_tag} size "${r.size}"`);
  const by = Object.fromEntries(rows.map((r) => [r.finish_tag, r]));
  assert.equal(by["PT-1"].size, '2" x 2"');
  assert.equal(by["RB-1"].size, '4"');
  assert.equal(by["CT-4"].size, '4.25" X 4.25"');
}

test("demo p2: a marquee around the material schedule reads all 28 rows, pinned", async () => {
  assertDemoRows(rowsOf(readRect(await page(DEMO, 2), DEMO_TABLE)));
});

test("demo p2: a marquee around the whole sheet reads the same 28 rows", async () => {
  // the sheet also carries a room finish schedule and legends; the finish
  // reader takes the material schedule and nothing else
  assertDemoRows(rowsOf(readRect(await page(DEMO, 2), SHEET)));
});

test("demo p2: legacy tokens (extractRegionText) read the same rows as the spans", async () => {
  const ph = await page(DEMO, 2);
  const tokens = extractRegionText(ph.textContent as never, ph.viewport as never, DEMO_TABLE);
  assert.deepEqual(parseSchedule(tokens), rowsOf(readRect(ph, DEMO_TABLE)));
});

// ── a tracked fixture that is not a finish schedule ─────────────────────────
test("annotated-set p2: the AIR DISTRIBUTION schedule (MARK | MATERIAL | DESCRIPTION) is refused", async () => {
  const ph = await page(ANNOTATED, 2);
  // nothing on it says finish: no CODE key, no printed heading, no maker, no COLOR / STYLE / PATTERN
  for (const r of [readRect(ph, { x0: 60, y0: 20, x1: 1100, y1: 320 }), readRect(ph, SHEET)]) {
    assert.deepEqual(r.rows, []);
    assert.ok("refused" in r);
    assert.equal(r.refused, "no-color-style-pattern");
    assert.equal(r.title, "AIR DISTRIBUTION SCHEDULE");
  }
});

// ── tracked fixtures read as finish tables ──────────────────────────────────
const MEP = fileURLToPath(new URL("./fixtures/mep-set.pdf", import.meta.url));
const SYMBOLS = fileURLToPath(new URL("./fixtures/symbol-set.pdf", import.meta.url));
const MULTI = fileURLToPath(new URL("./fixtures/multibuilding-set.pdf", import.meta.url));
/** key → [category, category_source, ticked, description], in print order. */
const summary = (rows: ScheduleRow[]) => rows.map((r) => [r.finish_tag, r.category, r.category_source, r.suggested, r.description]);

test("mep-set p2: the MATERIAL SCHEDULE is read though device schedules share the box", async () => {
  // the sheet also prints heater, fan and register schedules; the equipment
  // re-read judges only the finish table's own ink
  const ph = await page(MEP, 2);
  const want = [["CPT-1", "unassigned", "none", true, "CARPET TILE — 24 x 24 MODULAR"], ["RB-1", "base", "text", true, "RESILIENT BASE — 4 IN COVE"]];
  // the whole sheet, and a box that catches the register schedule's header and its SR-1 row
  for (const r of [SHEET, { x0: 100, y0: 575, x1: 1200, y1: 860 }]) assert.deepEqual(summary(rowsOf(readRect(ph, r))), want);
});

test("symbol-set p4: the transition FINISH SCHEDULE reads 3 rows — T1/T2 transition by their words, T9 no section", async () => {
  assert.deepEqual(summary(rowsOf(readRect(await page(SYMBOLS, 4), SHEET))), [
    ["T1", "transition", "text", true, "TRANSITION — EDGE STRIP RESILIENT"],
    ["T2", "transition", "text", true, "TRANSITION — EDGE STRIP METAL"],
    ["T9", "unassigned", "none", true, "JOINT COVER — NOT DRAWN ON PLANS"],
  ]);
});

test("multibuilding-set p3: the MATERIAL SCHEDULE reads 3 rows — RB-1 base by its words, the rest no section", async () => {
  assert.deepEqual(summary(rowsOf(readRect(await page(MULTI, 3), SHEET))), [
    ["CPT-1", "unassigned", "none", true, "CARPET TILE"],
    ["LVT-1", "unassigned", "none", true, "LUXURY VINYL TILE"],
    ["RB-1", "base", "text", true, "RESILIENT BASE"],
  ]);
});

// ── #483 PR A: characterization goldens for the demo and tracked fixtures ───
// Each marquee read (table box and page box) was captured from the base
// reader by fixtures/capture-reader-483-demo.ts into fixtures/reader-483/ and
// is never edited. PR A's reader changes must leave every one of these reads
// identical: no row, field or refusal changes, no skipped list, no key_rule /
// unticked_reason / not_used_text on any row, no new TableRow field.
import { readFileSync, readdirSync } from "node:fs";
import { DEMO_READS, DEMO_GOLDEN_DIR_URL, liveDemoRead, roundTrip } from "./fixtures/reader483Reads.ts";

const goldenDir483 = fileURLToPath(DEMO_GOLDEN_DIR_URL);
const own483 = (o: object, f: string) => Object.prototype.hasOwnProperty.call(o, f);

test("#483 goldens: every demo / fixture read has its golden, and nothing else is there", () => {
  assert.deepEqual(readdirSync(goldenDir483).sort(), DEMO_READS.map((d) => `${d.name}.json`).sort());
});

for (const d of DEMO_READS) {
  test(`#483 golden ${d.name}: the marquee read and readFinishTable(marquee) rows are unchanged`, async () => {
    const g = JSON.parse(readFileSync(`${goldenDir483}${d.name}.json`, "utf8"));
    assert.deepEqual([g.page, g.rect], [d.page, d.rect]);
    const live = await liveDemoRead(d);
    assert.deepStrictEqual(roundTrip(live.readScheduleSpans), g.readScheduleSpans);
    assert.deepStrictEqual(roundTrip(live.finishRows), g.finishRows);
    assert.ok(!own483(live.readScheduleSpans, "skipped"), "no skipped");
    for (const r of live.readScheduleSpans.rows) for (const f of ["key_rule", "unticked_reason", "not_used_text"]) assert.ok(!own483(r, f), `${r.finish_tag} has no ${f}`);
    for (const r of live.finishRows?.rows ?? []) {
      for (const f of ["qualifier", "notUsed", "notUsedText", "keyRule"]) assert.ok(!own483(r, f), `${r.key} has no ${f}`);
      for (const f of Object.keys(r)) assert.ok(!f.startsWith("_"), `${r.key} has no internal ${f}`);
    }
  });
}

// ── #483 PR A: the demo table with words printed after its codes ────
// The demo's own table box, with " SAT" / " TYP" appended to key cells as
// printed text (each span widened by the words it gains): a code with a word
// after it reads as the code, the word leading the description; a letters-only
// key with a word after it ("C TYP") keys nothing.
async function demoTableSpans() {
  const d = DEMO_READS.find((x) => x.name === "demo-p2-table")!;
  const ph = await (await openPdf(d.file)).page(d.page);
  return graphSpans(spansInRect(pageSpans(ph.textContent.items, ph.viewport.transform, RENDER_SCALE), d.rect));
}
function withTail(spans: ReturnType<typeof graphSpans>, keys: (k: string) => boolean, tail: string) {
  return spans.map((s) => {
    if (!keys(s.str.trim())) return s;
    const per = s.str.length ? (s.w || 0) / s.str.length : 0;
    return { ...s, str: s.str + tail, w: (s.w || 0) + per * tail.length };
  });
}

test("#483 demo + \" SAT\" on P-1..P-3 → 28 rows, P-1..P-3 keyed on the code with SAT leading the description", async () => {
  const base = await demoTableSpans();
  const before = readScheduleSpans(base);
  const r = readScheduleSpans(withTail(base, (k) => /^P-[123]$/.test(k), " SAT"));
  assert.equal(r.rows.length, 28);
  assert.deepEqual(r.rows.map((x) => x.finish_tag), before.rows.map((x) => x.finish_tag));
  for (const k of ["P-1", "P-2", "P-3"]) {
    const hit: ScheduleRow = r.rows.find((x) => x.finish_tag === k)!;
    const was: ScheduleRow = before.rows.find((x) => x.finish_tag === k)!;
    assert.equal(hit.description, was.description ? `SAT — ${was.description}` : "SAT", k);
    assert.ok(!own483(hit, "key_rule"), `${k}: a pass-1 row re-keyed in place`);
  }
});

test("#483 demo + \" TYP\" on every coded key → 28 rows with TYP leading each; on C too → 27 (C TYP keys nothing)", async () => {
  const base = await demoTableSpans();
  const before = readScheduleSpans(base);
  const coded = new Set(before.rows.map((x) => x.finish_tag).filter((k) => /\d/.test(k)));
  const r = readScheduleSpans(withTail(base, (k) => coded.has(k), " TYP"));
  assert.deepEqual(r.rows.map((x) => x.finish_tag), before.rows.map((x) => x.finish_tag));
  for (const row of r.rows.filter((x) => coded.has(x.finish_tag))) assert.ok(row.description.startsWith("TYP"), row.finish_tag);
  const withC = readScheduleSpans(withTail(base, (k) => coded.has(k) || k === "C", " TYP"));
  assert.equal(withC.rows.length, 27);
  assert.ok(!withC.rows.some((x) => x.finish_tag === "C" || x.finish_tag === "CTYP"));
});

// ── #483 PR A: the tracked fixture reader483-set.pdf ────────────────────────
// scripts/make-reader483-fixture.mjs — invented codes and vendors. Each sheet
// is a CODE | MATERIAL | MANUFACTURER | COLOR table; the page box reads the
// same as a box around the table.
const R483 = fileURLToPath(new URL("./fixtures/reader483-set.pdf", import.meta.url));
/** key → [section, category, category_source, ticked, description, key_rule, unticked_reason, not_used_text]. */
const full483 = (rows: ScheduleRow[]) => rows.map((r) => [r.finish_tag, r.section, r.category, r.category_source, r.suggested, r.description, r.key_rule ?? null, r.unticked_reason ?? null, r.not_used_text ?? null]);
const boxes483: Record<number, Rect> = {
  1: { x0: 80, y0: 60, x1: 1150, y1: 940 },
  2: { x0: 80, y0: 60, x1: 1150, y1: 330 },
  3: { x0: 80, y0: 60, x1: 1150, y1: 370 },
};
async function reads483(n: number): Promise<ScheduleRead[]> {
  const ph = await page(R483, n);
  return [readRect(ph, boxes483[n]), readRect(ph, SHEET)];
}

test("reader483-set p1: NOT USED rows, codes with a word after them, a filled EPOX row and a skipped SEAL line", async () => {
  for (const r of await reads483(1)) {
    assert.deepEqual(full483(rowsOf(r)), [
      ["CPT-1", "FLOORING", "floor", "heading", true, "BROADLOOM CARPET", null, null, null],
      // NOT USED in the key cell: the code alone, unticked, the words kept
      ["CPT-2", "FLOORING", "floor", "heading", false, "MODULAR CARPET TILE", "extended", "not-used", "NOT USED"],
      // two rows would share CPT-3, so both keep the codes they read as before
      ["CPT-3SAT", "FLOORING", "floor", "heading", true, "CARPET TILE", null, null, null],
      ["CPT-3EGG", "FLOORING", "floor", "heading", true, "CARPET TILE", null, null, null],
      // a four-letter code that fills the other columns, between coded rows
      ["EPOX", "FLOORING", "floor", "heading", true, "EPOXY FLOORING", "extended", null, null],
      ["LVT-1", "FLOORING", "floor", "heading", true, "LUXURY VINYL TILE", null, null, null],
      // SEAL (one cell) is not a row and its text is not in LVT-1's
      ["VCT-1", "FLOORING", "floor", "heading", true, "VINYL COMPOSITION TILE", null, null, null],
      ["FTB-01", "BASE", "base", "heading", true, "CUT (C) — CERAMIC TILE BASE", "extended", null, null],
      ["FTB-02", "BASE", "base", "heading", true, "COVE — CERAMIC TILE BASE", "extended", null, null],
      ["RB-1", "BASE", "base", "heading", true, "RUBBER BASE", null, null, null],
      // a lone P-1 SAT: no other row reads P-1, so the code splits off
      ["P-1", "WALLS", "wall", "heading", true, "SAT — PAINT", null, null, null],
      ["P-2", "WALLS", "wall", "heading", true, "PAINT", null, null, null],
      ["TS-1", "MISC", "transition", "text", false, "METAL TRANSITION STRIP", "extended", "not-used", "NOT USED"],
      ["CG-1", "MISC", "wall_protection", "text", true, "CORNER GUARDS", null, null, null],
    ]);
    assert.deepEqual("skipped" in r ? r.skipped : undefined, ["SEAL"]);
    assert.ok(!r.rows.some((x) => /SEALER/.test(x.description)), "SEAL's cell is in no row");
  }
});

test("reader483-set p2: a table whose codes are all four-letter reads no rows and reports all three", async () => {
  for (const r of await reads483(2)) assert.deepStrictEqual(r, { rows: [], skipped: ["EPOX", "CONC", "SEAL"] });
});

test("reader483-set p3: the short table CPT-1, RB-1, EPOX, PT-1 reads each code's own line", async () => {
  for (const r of await reads483(3)) {
    assert.deepEqual(full483(rowsOf(r)), [
      ["CPT-1", "", "unassigned", "none", true, "BROADLOOM CARPET", null, null, null],
      ["RB-1", "", "base", "text", true, "RUBBER BASE", null, null, null],
      ["EPOX", "", "unassigned", "none", true, "EPOXY FLOORING", "extended", null, null],
      ["PT-1", "", "unassigned", "none", true, "PAINT", null, null, null],
    ]);
    assert.ok(!("skipped" in r), "nothing skipped");
  }
});
