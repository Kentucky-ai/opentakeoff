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
