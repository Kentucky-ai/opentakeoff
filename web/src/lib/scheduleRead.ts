// Import from schedule — the reader. A marquee around a finish/material
// schedule is read by the SAME finish reader the sheet graph indexes with
// (sheetgraph.ts readFinishTable, marquee mode), so the canvas, the in-canvas
// agent's read_schedule and the MCP's resolve_tag read one table one way.
// Import from schedule's raster read (#470) feeds it the on-device reader's
// words as spans, with opts.ocr set (readScheduleSpans).
// This module turns that table into approval-dialog rows: it refuses tables
// that are another schedule family, names each row's category, and joins the
// cells a row's description is spread over.
//
// The only schedule module that imports the sheet graph: the canvas loads it
// with import() when a marquee is read, and seeds conditions from the light
// scheduleRows.ts.
import { extractTables, readFinishTable, type Bbox, type GraphSpan, type TableRow } from "./sheetgraph.ts";
import { FINISH_SECTION_CATEGORY, type FinishSection } from "./finishSections.ts";
import type { Category, CategorySource, ScheduleRow, Token } from "./scheduleRows.ts";

/** Why a marquee gave no rows. "no-table": no finish table was read at all
 *  (an empty box, or text that holds no table). Every other reason is a table
 *  that IS there but is not a finish/material schedule — "title": its title
 *  names another family (DOOR SCHEDULE …); "equipment": the sheet graph's
 *  equipment reader reads a device schedule (a GPM, HP, MBH, NECK … column)
 *  on the table's own ink, and nothing on the table says finish;
 *  "foreign-header": a column only another family
 *  prints (QTY, CFM, MESSAGE …); "no-color-style-pattern": nothing about it
 *  says finish (no CODE key, no printed finish heading, no item +
 *  MANUFACTURER columns, and no COLOR / STYLE / PATTERN column). */
export type RefusalReason = "no-table" | "title" | "equipment" | "foreign-header" | "no-color-style-pattern";
export type ScheduleRead =
  | { rows: ScheduleRow[] }
  | { rows: []; refused: RefusalReason; title?: string };

// ── the header guard ─────────────────────────────────────────────────────────
/** Header words only a non-finish schedule carries (door / furniture /
 *  signage / device columns). */
const FOREIGN_HDR = new Set(["QTY", "QUANTITY", "MESSAGE", "WIDTH", "HEIGHT", "HARDWARE", "CFM", "VOLTS", "VOLTAGE", "WATTS", "LAMP", "LAMPS", "CATALOG", "FIXTURE", "FRAME", "GLAZING", "THICKNESS", "RATING", "LOUVER"]);
/** The FOREIGN_HDR words that never name a finish attribute (counts, devices,
 *  sign text): an item column + MANUFACTURER does not excuse them. */
const HARD_HDR = new Set(["QTY", "QUANTITY", "MESSAGE", "CFM", "VOLTS", "VOLTAGE", "WATTS", "LAMP", "LAMPS"]);
const ITEM_COL = /^(MATERIAL|DESCRIPTION|PRODUCT)$/;
const LOOK_COL = /^(COLOR|STYLE|PATTERN)$/;

/** The refusal a finish-shaped table earns, or null to read it. `words` are
 *  the header row's raw words as printed; `headers` the canonical columns
 *  (headers[0] the key column). A table says "finish" by a CODE key, a
 *  printed finish heading over any row, or naming both what the item is and
 *  who makes it — and only a table that says nothing of the kind is refused
 *  for a column word another family uses, or for having no COLOR / STYLE /
 *  PATTERN column. A count / device / sign-text column refuses even item +
 *  MANUFACTURER (a furniture schedule has both); a CODE key or a printed
 *  heading still wins. */
export function headerRefusal(headers: string[], words: string[], hasSection: boolean): RefusalReason | null {
  const code = headers[0] === "CODE";
  const named = headers.some((h) => ITEM_COL.test(h)) && headers.includes("MANUFACTURER");
  const finishy = code || hasSection || named;
  const foreign = words.filter((w) => FOREIGN_HDR.has(w));
  if (!code && !hasSection && foreign.some((w) => HARD_HDR.has(w))) return "foreign-header";
  if (foreign.length && !finishy) return "foreign-header";
  if (!finishy && !headers.some((h) => LOOK_COL.test(h))) return "no-color-style-pattern";
  return null;
}

// ── category from the row's own words ────────────────────────────────────────
type WordCategory = "base" | "transition" | "wall_protection";
const plural = (p: string) => [p, p + "S"];
// Item-naming phrases only — never a material or surface word, never a tag
// letter. An exclusion (null) consumes its words so the BASE inside BASE
// CABINET, INTEGRAL COVE BASE or BASE BID names nothing.
const WORD_PHRASES: Array<[string, WordCategory | null]> = [
  ...["BASE CABINET", "BASE COAT", "BASE PLATE", "BASE SHEET"].flatMap(plural).map((p): [string, null] => [p, null]),
  ["BASE BID", null], ["SINK BASE", null], ["VANITY BASE", null],
  ["INTEGRAL COVE BASE", null], ["FLASH COVE BASE", null],
  ["WALL BASE", "base"], ["COVE BASE", "base"], ["RUBBER BASE", "base"], ["RESILIENT BASE", "base"], ["BASE", "base"],
  ...["TRANSITION", "TRANSITION STRIP", "THRESHOLD", "REDUCER", "STAIR NOSING", "EDGE STRIP"]
    .flatMap(plural).map((p): [string, WordCategory] => [p, "transition"]),
  ["WALL PROTECTION", "wall_protection"],
  ...["HANDRAIL", "CORNER GUARD", "CORNERGUARD", "CRASH RAIL", "PROTECTIVE RAIL", "BUMPER GUARD"]
    .flatMap(plural).map((p): [string, WordCategory] => [p, "wall_protection"]),
];
// longest phrase first, so WALL BASE is consumed before BASE is tried
const PHRASES = WORD_PHRASES.map(([p, c]) => ({ w: p.split(" "), c })).sort((a, b) => b.w.length - a.w.length);

/** The category a row's item words name, or "none". Words split on spaces,
 *  "/", ",", "(" and ")" (a hyphen compound is one word: WALL-MOUNTED) and
 *  lose the punctuation around them (BASE. / "COVE BASE" / BASE:); the " — "
 *  between two cells, all punctuation, is a word of its own, so no phrase
 *  spans two cells. A STAIR TREAD's NOSING belongs to the tread. Two
 *  categories named in one row → "none" (a guess would be a coin toss). */
export function b4(item: string): WordCategory | "none" {
  const t = item.toUpperCase().split(/[\s/,()]+/).filter(Boolean)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") || w);
  const used = t.map(() => false);
  if (t.some((w) => w === "TREAD" || w === "TREADS")) t.forEach((w, i) => { if (w === "NOSING" || w === "NOSINGS") used[i] = true; });
  const hits = new Set<WordCategory>();
  for (const p of PHRASES) {
    for (let i = 0; i + p.w.length <= t.length; i++) {
      if (!p.w.every((w, j) => !used[i + j] && t[i + j] === w)) continue;
      for (let j = 0; j < p.w.length; j++) used[i + j] = true;
      if (p.c) hits.add(p.c);
    }
  }
  return hits.size === 1 ? [...hits][0] : "none";
}

// ── rows ─────────────────────────────────────────────────────────────────────
/** Distinct non-empty cells, in the given order, joined " — ". */
const joinParts = (parts: Array<string | undefined>): string =>
  [...new Set(parts.map((p) => (p ?? "").trim()).filter(Boolean))].join(" — ");
const cellsOf = (r: TableRow, ...cols: string[]) => cols.map((c) => r.cells[c]?.text);
/** The first non-empty of the given cells. */
const firstCell = (r: TableRow, ...cols: string[]): string => {
  for (const c of cols) { const v = r.cells[c]?.text?.trim(); if (v) return v; }
  return "";
};
/** Headings whose rows start unticked: a flooring estimator rarely takes
 *  ceilings or millwork off a finish schedule, but can opt one in. */
const UNTICKED = new Set<FinishSection>(["CEILINGS", "CEILING", "MILLWORK"]);

function toRow(r: TableRow): ScheduleRow {
  const section = r.section;
  const heading = section ? FINISH_SECTION_CATEGORY[section] : null;
  let category: Category = "unassigned", source: CategorySource = "none";
  if (heading) { category = heading; source = "heading"; }
  else {
    // no printed heading names one (none printed, or MISC / ACCESSORIES):
    // the row's item words decide — MATERIAL and DESCRIPTION only, never
    // PRODUCT, style or remarks (a product line called STYLE-A BASE is a floor)
    const w = b4(joinParts(cellsOf(r, "MATERIAL", "DESCRIPTION")));
    if (w !== "none") { category = w; source = "text"; }
  }
  return {
    finish_tag: r.key,
    section: section ?? "",
    category,
    category_source: source,
    description: joinParts(cellsOf(r, "MATERIAL", "DESCRIPTION", "PRODUCT")),
    manufacturer: firstCell(r, "MANUFACTURER"),
    style: firstCell(r, "STYLE"),
    spec_color: firstCell(r, "COLOR"),
    size: firstCell(r, "SIZE"),
    remarks: firstCell(r, "REMARKS", "COMMENTS"),
    suggested: !(source === "heading" && section && UNTICKED.has(section)),
  };
}

/** The share of a's area that b covers (sheetgraph.ts's overlapFrac). */
const overlapFrac = (a: Bbox, b: Bbox): number => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(1, (a[2] - a[0]) * (a[3] - a[1]));
};

/** Read the spans inside a marquee (image px, the graph's span shape) as one
 *  finish/material schedule, or say why not. opts.ocr: the spans are the
 *  on-device reader's words, so a blank band between two code groups ends the
 *  section (sheetgraph.ts ExtractOpts.resetAtBlankBand); the vector read
 *  never sets it. */
export function readScheduleSpans(spans: GraphSpan[], opts?: { ocr?: boolean }): ScheduleRead {
  const r = readFinishTable({ key: "crop", spans }, { marquee: true, resetAtBlankBand: !!opts?.ocr });
  if (!r || !r.table.rows.length) return { rows: [], refused: "no-table" };
  const t = r.table;
  const title = t.title?.text;
  if ("refused" in r) return { rows: [], refused: "title", ...(title ? { title } : {}) };
  // A device schedule shares MARK / DESCRIPTION / MANUFACTURER with a
  // materials table, so the finish reader takes it too; the equipment reader's
  // device columns (GPM, HP, MBH, NECK, LUMENS …) are the proof it is not one.
  // The header guard below does not list those words — this re-read does.
  // Only a device table on the finish table's own ink counts (the sheet
  // graph's rule, buildSheetGraph: half the finish region overlapped → it is
  // the equipment table): a heater schedule elsewhere in the box says nothing
  // about this one. Both ways round: a marquee read keeps every keyed row in
  // the box, so it can run on into a device table printed below and take its
  // rows — then the device table lies mostly inside the finish region. And a table that says finish itself — a CODE key, a
  // printed finish heading, a title naming FINISH or MATERIAL — is not
  // refused for one column a device schedule also prints (WASTE, MOUNTING).
  // Item + MANUFACTURER is not that evidence: a pump schedule has both.
  const hasSection = t.rows.some((x) => x.section);
  const saysFinish = t.headers[0] === "CODE" || hasSection || /\b(FINISH|MATERIAL)/.test((title ?? "").toUpperCase());
  if (!saysFinish) {
    const eq = extractTables({ key: "crop", spans }, "equipment", { buildings: new Set() });
    if (eq.some((e) => overlapFrac(t.region, e.region) >= 0.5 || overlapFrac(e.region, t.region) >= 0.5)) return { rows: [], refused: "equipment", ...(title ? { title } : {}) };
  }
  const why = headerRefusal(t.headers, r.headerWords, hasSection);
  if (why) return { rows: [], refused: why, ...(title ? { title } : {}) };
  return { rows: t.rows.map(toRow) };
}

/**
 * Legacy entry: positioned tokens (baseline-left origin, as extractRegionText
 * emits them) already cropped to the marquee. Each becomes a width-less span
 * (a token's optional w and ang are not read); a refusal reads as no rows. [] when nothing is found — the
 * caller says "no schedule here" rather than inventing rows.
 */
export function parseSchedule(tokens: Token[]): ScheduleRow[] {
  const spans = tokens.map((t) => ({ str: t.str, x: t.x, y: t.y - t.h, w: 0, h: t.h }));
  return readScheduleSpans(spans).rows;
}
