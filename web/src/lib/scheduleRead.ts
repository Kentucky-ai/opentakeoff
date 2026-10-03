// Import from schedule — the reader. A marquee around a finish/material
// schedule is read by the finish reader the sheet graph indexes with, through
// its marquee entry point (sheetgraph.ts readFinishMarquee), so the canvas and
// the in-canvas agent's read_schedule read one box one way. The marquee entry
// adds rules the whole-sheet index (buildSheetGraph, the MCP's find_schedule
// and resolve_tag) doesn't run — NOT USED rows, codes with a word after them,
// code lines split from the row above, four- and five-letter codes and the
// skipped list (#483) — so a drawn box reads more forms than resolve_tag.
// Import from schedule's raster read (#470) feeds it the on-device reader's
// words as spans, with opts.ocr set (readScheduleSpans); on that read a code
// the reader misread (PT-O1, $SM-1) is repaired here, and the row says what
// was read (read_as, #482), and a "/" it read as "7" in the item's words is
// put back.
// This module turns that table into approval-dialog rows: it refuses tables
// that are another schedule family, names each row's category, and joins the
// cells a row's description is spread over.
//
// The only schedule module that imports the sheet graph: the canvas loads it
// with import() when a marquee is read, and seeds conditions from the light
// scheduleRows.ts.
import { FOREIGN_HDR, extractTables, isNonFinishSchedule, readFinishMarquee, traceFinishMarquee, type Bbox, type GraphSpan, type MarqueeRead, type TableRow } from "./sheetgraph.ts";
import { FINISH_SECTION_CATEGORY, type FinishSection } from "./finishSections.ts";
import { normalizeNotUsed } from "./notUsed.ts";
import { repairKey } from "./ocr/wordClean.ts";
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
/** `skipped`: four- or five-letter codes with no number (EPOX) the reader
 *  saw in the table's key column but did not read as rows, in y order —
 *  present only when there is one. A box whose only codes were skipped reads
 *  `{ rows: [], skipped }`. A refusal never carries it. */
export type ScheduleRead =
  | { rows: ScheduleRow[]; skipped?: string[] }
  | { rows: []; refused: RefusalReason; title?: string };

// ── the header guard ─────────────────────────────────────────────────────────
// FOREIGN_HDR — header words only a non-finish schedule carries — lives in
// sheetgraph.ts (the marquee rules read it too) and is re-exported here.
export { FOREIGN_HDR };
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
  ["INTEGRAL COVE BASE", null], ["INTEGRAL COVED BASE", null], ["INTEGRAL BASE", null],
  ["SANITARY COVE BASE", null], ["SANITARY COVED BASE", null], ["SANITARY BASE", null],
  ["FLASH COVE BASE", null], ["FLASH COVED BASE", null],
  ["WALL BASE", "base"], ["COVE BASE", "base"], ["RUBBER BASE", "base"], ["RESILIENT BASE", "base"], ["BASE", "base"],
  ...["TRANSITION", "TRANSITION STRIP", "THRESHOLD", "REDUCER", "STAIR NOSING", "EDGE STRIP"]
    .flatMap(plural).map((p): [string, WordCategory] => [p, "transition"]),
  ["WALL PROTECTION", "wall_protection"],
  ...["HANDRAIL", "CORNER GUARD", "CORNERGUARD", "CRASH RAIL", "PROTECTIVE RAIL", "BUMPER GUARD"]
    .flatMap(plural).map((p): [string, WordCategory] => [p, "wall_protection"]),
];
// A floor surface a base can be an accessory OF: "EPOXY FLOORING W/ 4 IN. COVE
// BASE" describes the floor, it does not name a base item.
const FLOOR_SURFACES = new Set(["FLOORING", "FLOOR", "EPOXY", "RESINOUS", "TERRAZZO", "CARPET", "CONCRETE", "TILE", "VINYL", "LVT", "VCT", "PORCELAIN", "CERAMIC", "LINOLEUM"]);
// longest phrase first, so WALL BASE is consumed before BASE is tried
const PHRASES = WORD_PHRASES.map(([p, c]) => ({ w: p.split(" "), c })).sort((a, b) => b.w.length - a.w.length);

/** Some word before index i is W (from W/) or WITH, and some word before that is a floor surface. */
const withFloorBefore = (t: string[], i: number): boolean => {
  return t.some((x, k) => k < i && (x === "W" || x === "WITH") && t.slice(0, k).some((f) => FLOOR_SURFACES.has(f)));
};

/** The category a row's item words name, or "none". Words split on spaces,
 *  "/", ",", "(" and ")" (a hyphen compound is one word: WALL-MOUNTED) and
 *  lose the punctuation around them (BASE. / "COVE BASE" / BASE:); the " — "
 *  between two cells, all punctuation, is a word of its own, so no phrase
 *  spans two cells. A STAIR TREAD's NOSING belongs to the tread. Two
 *  categories named in one row → "none" (a guess would be a coin toss). A base
 *  phrase after "<floor surface> W/" or "… WITH" is the floor's own base, so
 *  it names nothing (consumed, like an exclusion). */
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
      if (p.c === "base" && withFloorBefore(t, i)) continue;
      if (p.c) hits.add(p.c);
    }
  }
  return hits.size === 1 ? [...hits][0] : "none";
}

// ── "/" read as "7" ──────────────────────────────────────────────────────────
const HAS_LETTER = /\p{L}/u;
// a dimension's "by" (4 X 7 IN): a 7 beside it is a size
const BY = /^[X×]$/i;
const bareWord = (w: string) => w.toUpperCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
// a word that introduces a number (TYPE 7, SERIES 7, NO. 7, # 7): the 7
// after it is that number
// (not STYLE or SIZE: "STYLE / COLOR" and "SIZE / FINISH" are common pairs)
const NUMBER_WORDS = new Set(["NO", "TYPE", "SERIES", "CLASS", "GRADE", "MODEL", "PHASE", "SECTION", "GAUGE"]);
const numbers = (w: string) => w === "#" || NUMBER_WORDS.has(bareWord(w));

/** An OCR read's item words with a "/" the reader read as "7" put back
 *  (#482). On a scan, "CARPET / BROADLOOM" reads "CARPET 7 BROADLOOM" and
 *  "EPOXY FLOORING W/" reads "… W7", which b4 then can't tell from a base
 *  item. A word that is exactly "7", with a word on each side and a letter
 *  in at least one of them ("BASE 7 4 IN"), becomes "/", unless one of them
 *  is a dimension's X ("4 X 7 IN" is a size) or the word before it
 *  introduces a number ("TYPE 7 TILE", "NO. 7"); a "W7" after a
 *  floor surface word in the same text becomes "W/", at the text's end too
 *  (its base may sit in the next cell). Nothing else: a 7 at either end, a 7
 *  glued to a word, a W7 with no floor word before it (a wall type). Text
 *  with nothing to repair comes back as given; repaired text is rejoined
 *  with single spaces. Accepted cost: a printed lone 7 between two words in
 *  these cells reads as "/". */
export function repairSlashSeven(text: string): string {
  const t = text.trim().split(/\s+/);
  let changed = false;
  const out = t.map((w, i) => {
    const [a, b] = [t[i - 1], t[i + 1]];
    if (w === "7" && a !== undefined && b !== undefined && !BY.test(a) && !BY.test(b) && !numbers(a) && (HAS_LETTER.test(a) || HAS_LETTER.test(b))) { changed = true; return "/"; }
    if (/^W7$/i.test(w) && t.slice(0, i).some((f) => FLOOR_SURFACES.has(bareWord(f)))) { changed = true; return w[0] + "/"; }
    return w;
  });
  return changed ? out.join(" ") : text;
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

/** The cells repairSlashSeven reads: what the item is, never its look. */
const SLASH_COLS = ["MATERIAL", "DESCRIPTION", "PRODUCT"];

/** `keyCol`: the table's key column (its first header). `ocr`: the row was
 *  read from the on-device reader's words, so its item cells get their "/"
 *  back (repairSlashSeven) before the category and description read them;
 *  a copy, never the reader's row. */
function toRow(r: TableRow, keyCol: string, { ocr = false }: { ocr?: boolean } = {}): ScheduleRow {
  if (ocr) {
    const cells = { ...r.cells };
    for (const c of SLASH_COLS) if (c !== keyCol && cells[c]) cells[c] = { ...cells[c], text: repairSlashSeven(cells[c].text) };
    r = { ...r, cells };
  }
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
  const row: ScheduleRow = {
    finish_tag: r.key,
    section: section ?? "",
    category,
    category_source: source,
    // a key-cell qualifier ("CUT (C)" of "FTB-01 CUT (C)") leads the
    // description; it never names the category
    description: joinParts([r.qualifier, ...cellsOf(r, "MATERIAL", "DESCRIPTION", "PRODUCT")]),
    manufacturer: firstCell(r, "MANUFACTURER"),
    style: firstCell(r, "STYLE"),
    spec_color: firstCell(r, "COLOR"),
    size: firstCell(r, "SIZE"),
    remarks: firstCell(r, "REMARKS", "COMMENTS"),
    suggested: !(source === "heading" && section && UNTICKED.has(section)),
  };
  // the schedule marks the row NOT USED / N.I.C. — after its code in the key
  // cell, or as the whole of another cell: it starts unticked, and says why
  const marker = r.notUsed ? r.notUsedText ?? "" : notUsedCell(r, keyCol);
  if (marker != null) { row.suggested = false; row.unticked_reason = "not-used"; row.not_used_text = marker; }
  if (r.keyRule) row.key_rule = r.keyRule;
  return row;
}

/** A non-key cell whose whole text is a NOT USED / N.I.C. marker, as printed
 * (leading separators stripped); null when there is none. */
function notUsedCell(r: TableRow, keyCol: string): string | null {
  for (const [col, c] of Object.entries(r.cells)) {
    if (col !== keyCol && normalizeNotUsed(c.text)) return c.text.trim().replace(/^[-–—:,\s]+/, "");
  }
  return null;
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
  return readOf(readFinishMarquee({ key: "crop", spans }, { ocr: !!opts?.ocr }), spans, !!opts?.ocr);
}

/** @internal Tests only: readScheduleSpans
 * plus how the marquee rules got there — the table's rows with their
 * provenance kept (`_y`, `_pass1`, `_pass1Key`, `_newRule`, `_ungluedFrom`),
 * the lines they consumed, and the per-line decisions. */
export function readScheduleDebug(spans: GraphSpan[], opts?: { ocr?: boolean }): { read: ScheduleRead } & Omit<ReturnType<typeof traceFinishMarquee>, "read"> {
  const t = traceFinishMarquee({ key: "crop", spans }, { ocr: !!opts?.ocr });
  return { read: readOf(t.read, spans, !!opts?.ocr), rows: t.rows, consumed: t.consumed, diag: t.diag };
}

/** `ocr`: the spans are the on-device reader's words, so a code it misread
 *  (PT-O1, $SM-1) is repaired, and the row keeps what it read (read_as); its
 *  item words get their "/" back (toRow). */
function readOf(r: MarqueeRead | null, spans: GraphSpan[], ocr: boolean): ScheduleRead {
  if (!r) return { rows: [], refused: "no-table" };
  if (r.kind === "headerOnly") {
    // a header with no row read under it, and nothing the reader saw but
    // skipped: no table, as before. With skipped codes it is a table whose
    // codes were all skipped — guarded like any table, then read as no rows.
    if (!r.skipped.length) return { rows: [], refused: "no-table" };
    const title = r.title?.text;
    if (title && isNonFinishSchedule(title)) return { rows: [], refused: "title", title };
    const why = refusalOf(title, r.headers, r.headerWords, r.hasSection, r.region, spans);
    if (why) return { rows: [], refused: why, ...(title ? { title } : {}) };
    return { rows: [], skipped: [...r.skipped] };
  }
  if (!r.table.rows.length) return { rows: [], refused: "no-table" };
  const t = r.table;
  const title = t.title?.text;
  if (r.kind === "other-family") return { rows: [], refused: "title", ...(title ? { title } : {}) };
  const why = refusalOf(title, t.headers, r.headerWords, r.hasSection, r.guardRegion, spans);
  if (why) return { rows: [], refused: why, ...(title ? { title } : {}) };
  const rows = t.rows.map((x) => {
    const row = toRow(x, t.headers[0], { ocr });
    if (ocr) {
      const fix = repairKey(x.cells[t.headers[0]]?.text ?? "", row.finish_tag);
      row.finish_tag = fix.key;
      if (fix.readAs) row.read_as = fix.readAs;
      const box = x.cells[t.headers[0]]?.bbox;
      const checks = box ? spans.filter((s) => s.codeAlternate !== undefined
        && s.x + s.w / 2 >= box[0] && s.x + s.w / 2 <= box[2]
        && s.y + s.h / 2 >= box[1] && s.y + s.h / 2 <= box[3])
        .map((s) => ({ first: s.str, second: s.codeAlternate! })) : [];
      if (checks.length) { row.code_checks = checks; row.suggested = false; }
    }
    return row;
  });
  return r.skipped.length ? { rows, skipped: [...r.skipped] } : { rows };
}

/** The refusal a finish-shaped read earns (other than its title), or null.
 *  `region`: the table's own ink as the guards see it (a table's pass-1
 *  region, a headerOnly read's header band). */
function refusalOf(title: string | undefined, headers: string[], headerWords: string[], hasSection: boolean, region: Bbox, spans: GraphSpan[]): RefusalReason | null {
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
  const saysFinish = headers[0] === "CODE" || hasSection || /\b(FINISH|MATERIAL)/.test((title ?? "").toUpperCase());
  if (!saysFinish) {
    const eq = extractTables({ key: "crop", spans }, "equipment", { buildings: new Set() });
    if (eq.some((e) => overlapFrac(region, e.region) >= 0.5 || overlapFrac(e.region, region) >= 0.5)) return "equipment";
  }
  return headerRefusal(headers, headerWords, hasSection);
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
