// Laid out in on-device (OCR) word geometry, the #483 cases made rows and
// skipped codes the text-layer read lacks; { ocr: true } turns off unglue and
// letters candidates (ocrGate483.test.ts).
// Fixtures for the marquee schedule reader's #483 work (PR A): the twin
// registry, the span-shape builder, and the changes each later slice is
// expected to make to a twin's marquee read. Not a test file: the capture
// script (capture-reader-483.ts) and reader483Goldens.test.ts both import it,
// so a golden and its assertion always read the same spans.
//
// Every fixture is synthetic — invented codes and vendors (VENDOR-A …), laid
// out at the scale the MCP serves the bundled demo sheet (text 17 px tall,
// 38 px row pitch, 8 px per character), as in sheetgraphFinish.test.ts.
//
// A "twin" is one fixture read through the reader entry points that matter
// for it: a whole-sheet twin through extractTable / readFinishTable(marquee)
// / buildSheetGraph / resolveTag (which PR A must leave byte-identical), a
// marquee twin through readScheduleSpans / parseSchedule /
// readFinishTable(marquee). Goldens are captured once, before any reader change,
// and never edited.
import { readScheduleSpans, parseSchedule } from "../../src/lib/scheduleRead.ts";
import { extractTable, readFinishTable, buildSheetGraph, resolveTag, type GraphSpan } from "../../src/lib/sheetgraph.ts";
import type { ScheduleRow } from "../../src/lib/scheduleRows.ts";
import type { RefusalReason } from "../../src/lib/scheduleRead.ts";

/** The PR A slice the reader source is at. Bumped by each slice's commit;
 * tests gate the twins a slice changes on it (no test-file edit). */
export const CURRENT_SLICE: number = 5;

// ── the builder (sheetgraphFinish.test.ts's, plus offset header spans) ──────
export const TH = 17, PITCH = 38, CW = 8;
export const sp = (str: string, x: number, y: number, h = TH): GraphSpan => ({ str, x, y, w: str.length * CW, h });
export const COLS: Record<string, number> = {
  KEY: 100, MATERIAL: 220, DESCRIPTION: 220, MANUFACTURER: 520, "MANUF.": 520, STYLE: 760, PRODUCT: 760,
  COLOR: 1000, SIZE: 1240, REMARKS: 1400, COMMENTS: 1400,
};
export type Cells = Partial<Record<string, string>>;
export type Item =
  | { t: "row"; key: string; cells: Cells }
  | { t: "head"; text: string; x?: number }
  /** a line of spans at [text, x]; one pitch down, or `dy` below the last line without advancing */
  | { t: "raw"; spans: Array<[string, number]>; dy?: number }
  | { t: "gap"; n: number }
  /** a one-cell wrapped line 19 px under the last line */
  | { t: "wrap"; col: string; text: string; dx?: number }
  /** a keyed-or-not line `dy` below the last line (not advancing): key in the key column, cells in theirs */
  | { t: "under"; dy: number; key: string; cells: Cells };

export interface BuildOpts {
  key?: string; cols: string[]; title?: string; items: Item[]; align?: "left" | "center";
  pre?: Array<Array<[string, number]>>; colX?: Record<string, number>;
  /** header spans offset from their columns: label → [dx, dy] (cells stay at the column) */
  hdrOffset?: Partial<Record<string, [number, number]>>;
}

export function build(o: BuildOpts): GraphSpan[] {
  const X = { ...COLS, ...(o.colX ?? {}) };
  const labels = [o.key ?? "CODE", ...o.cols];
  const xs = [X.KEY, ...o.cols.map((c) => X[c])];
  const colW = xs.map((x, i) => (i + 1 < xs.length ? xs[i + 1] - x : 400));
  const place = (text: string, ci: number, y: number) => (o.align === "center" ? sp(text, xs[ci] + colW[ci] / 2 - (text.length * CW) / 2, y) : sp(text, xs[ci], y));
  const line = (key: string, cells: Cells, y: number, out: GraphSpan[]) => {
    if (key) out.push(place(key, 0, y));
    o.cols.forEach((c, i) => { const v = cells[c]; if (v) out.push(place(v, i + 1, y)); });
  };
  const out: GraphSpan[] = [];
  let y = 0;
  for (const ln of o.pre ?? []) { for (const [s, x] of ln) out.push(sp(s, x, y)); y += PITCH; }
  if (o.title) { out.push(sp(o.title, xs[0], y, 24)); y += PITCH; }
  labels.forEach((l, i) => {
    const s = place(l, i, y);
    const off = o.hdrOffset?.[l];
    if (off) { s.x += off[0]; s.y += off[1]; }
    out.push(s);
  });
  let lastY = y;
  for (const it of o.items) {
    if (it.t === "gap") { y += PITCH * it.n; continue; }
    if (it.t === "wrap") { const s = place(it.text, labels.indexOf(it.col), lastY + 19); s.x += it.dx ?? 0; out.push(s); continue; }
    if (it.t === "under") { line(it.key, it.cells, lastY + it.dy, out); continue; }
    if (it.t === "raw" && it.dy != null) { for (const [s, x] of it.spans) out.push(sp(s, x, lastY + it.dy)); continue; }
    y += PITCH;
    if (it.t === "head") out.push(sp(it.text, it.x ?? xs[0], y));
    else if (it.t === "raw") for (const [s, x] of it.spans) out.push(sp(s, x, y));
    else line(it.key, it.cells, y, out);
    lastY = y;
  }
  return out;
}

/** A fixture written out as [text, x, y, width?] (sheetgraphFinish.test.ts's `fixture`). */
export const fixture = (widthless: boolean, a: Array<[string, number, number, number?]>): GraphSpan[] =>
  a.map(([str, x, y, w]) => (widthless ? { str, x, y, w: 0, h: TH } : { str, x, y, w: w ?? str.length * CW, h: TH }));

// invented finish rows: key, material, vendor, style, color, size, remarks
export const R = (key: string, mat: string, mfr: string, style = "", color = "", size = "", rem = ""): Item =>
  ({ t: "row", key, cells: { MATERIAL: mat, DESCRIPTION: mat, MANUFACTURER: mfr, "MANUF.": mfr, STYLE: style, PRODUCT: style, COLOR: color, SIZE: size, REMARKS: rem } });
export const H = (text: string, x?: number): Item => ({ t: "head", text, x });
export const keysOf = (items: Item[]) => items.flatMap((i) => (i.t === "row" ? [i.key] : []));
export const FLOOR = [R("CPT-1", "BROADLOOM CARPET", "VENDOR-A", "LOOP 20", "GREY 101"), R("CPT-2", "MODULAR CARPET TILE", "VENDOR-A", "GRID 24", "BLUE 202"), R("LVT-1", "LUXURY VINYL TILE", "VENDOR-B", "PLANK 6", "OAK 303", '6" x 36"', "ADHESIVE: VENDOR-K"), R("VCT-1", "VINYL COMPOSITION TILE", "VENDOR-C", "STANDARD", "WHITE 404", '12" x 12"', "ADHESIVE: VENDOR-K"), R("SC-1", "SEALED CONCRETE", "VENDOR-D", "CLEAR COAT", "CLEAR")];
export const BASE = [R("RB-1", "RUBBER WALL BASE", "VENDOR-B", "COVE", "BLACK 505", '4"'), R("RB-2", "RESILIENT BASE", "VENDOR-B", "STRAIGHT", "GREY 506", '6"')];
export const WALLS = [R("P-1", "PAINT", "VENDOR-E", "EGGSHELL", "WHITE 601"), R("P-2", "PAINT", "VENDOR-E", "SEMI-GLOSS", "TAUPE 602", "", "SEE NOTE 4"), R("CT-1", "CERAMIC WALL TILE", "VENDOR-F", "GLOSS", "WHITE 603", '3" x 6"', "GROUT: VENDOR-K 01 WHITE")];
export const STD = ["MATERIAL", "MANUFACTURER", "STYLE", "COLOR", "SIZE", "REMARKS"];
/** The PR A fixture column set: CODE | MATERIAL | MANUFACTURER | COLOR. */
export const MMC = ["MATERIAL", "MANUFACTURER", "COLOR"];
/** A row in the MMC columns. */
export const M = (key: string, mat: string, mfr: string, color: string): Item => ({ t: "row", key, cells: { MATERIAL: mat, MANUFACTURER: mfr, COLOR: color } });
/** A line in the key column alone, one pitch down (`C-1 NOT USED` as one span). */
export const KEYLINE = (text: string): Item => ({ t: "raw", spans: [[text, COLS.KEY]] });
const label = (key: string, cells: Cells = {}): Item => ({ t: "row", key, cells });

// ── the shape builder ───────────────────────────────────────────
export type Shape = "cell" | "legacy" | "words" | "words-legacy";
/** cell: whole cells, w = CW·len. legacy: w = 0 (what parseSchedule builds).
 *  words: each span split on /\s+/; word k at x + CW·(chars before it incl. spaces), w = CW·len.
 *  words-legacy: words, w = 0. Header spans are split too. */
export function shape(spans: GraphSpan[], s: Shape): GraphSpan[] {
  const split = s === "words" || s === "words-legacy";
  const widthless = s === "legacy" || s === "words-legacy";
  const out: GraphSpan[] = [];
  for (const t of spans) {
    const parts = split ? [...t.str.matchAll(/\S+/g)].map((m) => ({ str: m[0], at: m.index ?? 0 })) : [{ str: t.str, at: 0 }];
    for (const p of parts) out.push({ ...t, str: p.str, x: t.x + CW * p.at, w: widthless ? 0 : CW * p.str.length });
  }
  return out;
}
export const readAs = (spans: GraphSpan[], s: Shape) => readScheduleSpans(shape(spans, s));
export const legacyKeys = (spans: GraphSpan[]) =>
  parseSchedule(spans.map((t) => ({ str: t.str, x: t.x, y: t.y + t.h, h: t.h }))).map((r) => r.finish_tag);

/** The controls: each shape's plain FLOOR + BASE table, read today. */
export const CONTROL_ITEMS: Item[] = [...FLOOR, ...BASE];
export const CONTROL_SPANS = build({ cols: STD, items: CONTROL_ITEMS });
export const SHAPES: Shape[] = ["cell", "legacy", "words", "words-legacy"];
/** Shapes the reader handles today (measured); `words` / `words-legacy` are out of scope and only pinned. */
export const SHAPES_READ: Shape[] = ["cell", "legacy"];

// ── the twins ───────────────────────────────────────────────────
/** whole: whole-sheet entry points only. marquee: the marquee entry points only. both: both sets. */
export type TwinKind = "whole" | "marquee" | "both";
export interface Twin { name: string; kind: TwinKind; spans: GraphSpan[]; note: string }

/** CPT-1, the key-cell form, RB-2, PT-1 in CODE | MATERIAL | MANUFACTURER | COLOR. */
const keyCellTwin = (name: string, form: string, note: string): Twin => ({
  name, kind: "whole", note,
  spans: build({ cols: MMC, items: [
    M("CPT-1", "BROADLOOM CARPET", "VENDOR-A", "GREY 101"),
    M(form, "PORCELAIN TILE", "VENDOR-F", "WHITE 603"),
    M("RB-2", "RESILIENT BASE", "VENDOR-B", "GREY 506"),
    M("PT-1", "PORCELAIN TILE", "VENDOR-F", "SAND 604"),
  ] }),
});

const EPOX_CELLS: Cells = { MATERIAL: "EPOXY FLOORING", MANUFACTURER: "VENDOR-L", COLOR: "GREY 901" };
const CONC_CELLS: Cells = { MATERIAL: "SEALED CONCRETE", MANUFACTURER: "VENDOR-D", COLOR: "CLEAR" };

/** A MATERIAL-first table: the key column (CODE) is the second column. */
function materialCodeSpans(): GraphSpan[] {
  const xs = { MATERIAL: 100, CODE: 300, MANUFACTURER: 520, COLOR: 1000 };
  const out = Object.entries(xs).map(([l, x]) => sp(l, x, 0));
  const rows: Array<[string, string, string, string]> = [
    ["BRICK", "BR-1", "VENDOR-M", "RED 801"], ["CORK", "CK-1", "VENDOR-N", "NATURAL 802"],
    ["SLATE", "SL-1", "VENDOR-O", "GREY 803"], ["CARPET", "CPT-1", "VENDOR-A", "GREY 101"],
  ];
  rows.forEach(([m, c, v, col], i) => { const y = PITCH * (i + 1); out.push(sp(m, xs.MATERIAL, y), sp(c, xs.CODE, y), sp(v, xs.MANUFACTURER, y), sp(col, xs.COLOR, y)); });
  return out;
}

/** Spec-section tables of another family, a spec-section line in the key column. */
const specTwin = (name: string, cols: string[], section: string, rows: Array<[string, Cells]>, note: string): Twin => ({
  name, kind: "both", note,
  spans: build({ key: "MARK", cols, colX: { DESCRIPTION: 220, MANUFACTURER: 520, CFM: 1000, QTY: 1000, MESSAGE: 1000 }, items: [
    { t: "raw", spans: [[section, COLS.KEY]] },
    ...rows.map(([key, cells]): Item => ({ t: "row", key, cells })),
  ] }),
});

/** The far-below text of a whole-sheet read: notes, room tags and a stray code under the table. */
function farBelowSpans(): GraphSpan[] {
  const items: Item[] = [...FLOOR, ...BASE];
  const table = build({ cols: STD, items });
  const lastY = Math.max(...table.map((s) => s.y));
  const out = [...table];
  // a note row 2 pitches below the last row, a device mark 2 pitches further
  out.push(sp("WHERE", 100, lastY + 2 * PITCH), sp("SHOWN", 220, lastY + 2 * PITCH), sp("ON PLANS", 520, lastY + 2 * PITCH));
  out.push(sp("EF-1 ABOVE", 100, lastY + 4 * PITCH));
  // a room tag and a device mark 1,400 px below
  out.push(sp("B12 STORAGE", 100, lastY + 1400), sp("EF-1 ABOVE", 100, lastY + 1400 + PITCH));
  // a stray code with a finish note one pitch under it, further down
  out.push(sp("P-1", 100, lastY + 1400 + 4 * PITCH), sp("GWB-2 PAINTED", 100, lastY + 1400 + 5 * PITCH));
  return out;
}

export const TWINS: Twin[] = [
  // whole-sheet twins: key-cell forms (read today; PR A must not change a whole-sheet read)
  keyCellTwin("ws-key-ftb01-cut-c", "FTB-01 CUT (C)", "key cell FTB-01 CUT (C)"),
  keyCellTwin("ws-key-cpt2-not-used", "CPT-2 NOT USED", "key cell CPT-2 NOT USED"),
  keyCellTwin("ws-key-cpt2-nic", "CPT-2 NIC", "key cell CPT-2 NIC"),
  keyCellTwin("ws-key-p1-sat", "P-1 SAT", "key cell P-1 SAT"),
  keyCellTwin("ws-key-rb1-cut", "RB-1 CUT", "key cell RB-1 CUT"),
  keyCellTwin("ws-key-lvt1-a", "LVT-1 A", "key cell LVT-1 A"),
  keyCellTwin("ws-key-cpt1-alt", "CPT-1 ALT", "key cell CPT-1 ALT (beside a plain CPT-1)"),
  {
    name: "ws-material-not-used", kind: "whole", note: "MATERIAL cell NOT USED",
    spans: build({ cols: MMC, items: [M("CPT-1", "BROADLOOM CARPET", "VENDOR-A", "GREY 101"), { t: "row", key: "CPT-2", cells: { MATERIAL: "NOT USED" } }, M("RB-1", "RUBBER BASE", "VENDOR-B", "BLACK 505"), M("PT-1", "PORCELAIN TILE", "VENDOR-F", "SAND 604")] }),
  },
  {
    name: "ws-epox-two-cells", kind: "whole", note: "EPOX with two filled cells among coded rows",
    spans: build({ cols: MMC, items: [M("CPT-1", "BROADLOOM CARPET", "VENDOR-A", "GREY 101"), M("CPT-2", "MODULAR CARPET TILE", "VENDOR-A", "BLUE 202"), { t: "row", key: "EPOX", cells: EPOX_CELLS }, M("RB-1", "RUBBER BASE", "VENDOR-B", "BLACK 505"), M("PT-1", "PORCELAIN TILE", "VENDOR-F", "SAND 604")] }),
  },
  {
    name: "both-c-p-letter-labels", kind: "both", note: "C | CONCRETE above C-1 and P | PAINT above P-1",
    spans: build({ cols: MMC, items: [
      M("CPT-1", "BROADLOOM CARPET", "VENDOR-A", "GREY 101"),
      { t: "row", key: "C", cells: { MATERIAL: "CONCRETE" } }, M("C-1", "SEALED CONCRETE", "VENDOR-D", "CLEAR"), M("C-2", "POLISHED CONCRETE", "VENDOR-D", "SATIN"),
      { t: "row", key: "P", cells: { MATERIAL: "PAINT" } }, M("P-1", "PAINT", "VENDOR-E", "WHITE 601"), M("P-2", "PAINT", "VENDOR-E", "TAUPE 602"),
    ] }),
  },
  { name: "ws-far-below", kind: "whole", note: "B12 STORAGE, EF-1 ABOVE, WHERE | SHOWN | ON PLANS, stray P-1 + GWB-2 PAINTED far below the table", spans: farBelowSpans() },
  {
    name: "both-short-cpt-rb-epox-pt", kind: "both", note: "short table CPT-1, RB-1, EPOX, PT-1 (EPOX filled)",
    spans: build({ cols: MMC, items: [M("CPT-1", "BROADLOOM CARPET", "VENDOR-A", "GREY 101"), M("RB-1", "RUBBER BASE", "VENDOR-B", "BLACK 505"), { t: "row", key: "EPOX", cells: EPOX_CELLS }, M("PT-1", "PAINT", "VENDOR-E", "WHITE 601")] }),
  },
  { name: "both-material-code", kind: "both", note: "MATERIAL | CODE | MANUFACTURER | COLOR with BRICK, CORK, SLATE", spans: materialCodeSpans() },
  specTwin("both-spec-fans", ["DESCRIPTION", "MANUFACTURER", "CFM"], "23 34 00 HVAC FANS",
    [["EF-1", { DESCRIPTION: "EXHAUST FAN", MANUFACTURER: "VENDOR-P", CFM: "250" }], ["EF-2", { DESCRIPTION: "EXHAUST FAN", MANUFACTURER: "VENDOR-P", CFM: "400" }]],
    "spec-section fan table: 23 34 00 HVAC FANS in the key column"),
  specTwin("both-spec-furniture", ["DESCRIPTION", "MANUFACTURER", "QTY"], "12 50 00 FURNITURE",
    [["F-1", { DESCRIPTION: "LOUNGE CHAIR", MANUFACTURER: "VENDOR-Q", QTY: "12" }], ["F-2", { DESCRIPTION: "SIDE TABLE", MANUFACTURER: "VENDOR-Q", QTY: "4" }]],
    "spec-section furniture table: 12 50 00 FURNITURE in the key column"),
  specTwin("both-spec-signage", ["DESCRIPTION", "MANUFACTURER", "MESSAGE"], "10 14 00 SIGNAGE",
    [["S-1", { DESCRIPTION: "ROOM SIGN", MANUFACTURER: "VENDOR-W", MESSAGE: "OFFICE" }], ["S-2", { DESCRIPTION: "ROOM SIGN", MANUFACTURER: "VENDOR-W", MESSAGE: "STORAGE" }]],
    "spec-section signage table: 10 14 00 SIGNAGE in the key column"),

  // marquee twins: sheetgraphFinish.test.ts:595–660 fixtures, as marquee calls
  {
    name: "mq-sg595-letters-item", kind: "marquee", note: "sheetgraphFinish.test.ts:595 — letters-only codes that name an item stay rows",
    spans: build({ cols: STD, items: [R("C", "SEALED CONCRETE", "VENDOR-D", "CLEAR COAT", "CLEAR"), R("C-2", "SEALED CONCRETE", "VENDOR-D", "SATIN COAT", "CLEAR"), label("WD", { REMARKS: "SEE NOTE 2" }), ...FLOOR.slice(0, 4), R("WD-1", "WOOD FLOORING", "VENDOR-U", "PLANK", "NATURAL")] }),
  },
  {
    name: "mq-sg605-letters-style", kind: "marquee", note: "sheetgraphFinish.test.ts:605 — a letters-only row naming its item in STYLE / COLOR / SIZE",
    spans: build({ cols: ["STYLE", "COLOR", "SIZE"], items: [R("CPT-1", "", "", "LOOP 20", "GREY 101", "12' W"), R("RB", "", "", "COVE", "BLACK 505", '4"'), R("RB-1", "", "", "STRAIGHT", "GREY 506", '6"'), R("RB-2", "", "", "COVE", "GREY 507", '4"')] }),
  },
  {
    name: "mq-sg613-cpt-above-cpt1", kind: "marquee", note: "sheetgraphFinish.test.ts:613 — group label above dashless codes",
    spans: build({ key: "TAG", cols: STD, items: [label("CPT"), R("CPT1", "BROADLOOM CARPET", "VENDOR-A"), R("CPT2", "CARPET TILE", "VENDOR-A"), ...BASE] }),
  },
  {
    name: "mq-sg620-spec-label", kind: "marquee", note: "sheetgraphFinish.test.ts:620 — group label beside its spec section",
    spans: build({ cols: STD, items: [...FLOOR, ...BASE, { t: "row", key: "P", cells: { REMARKS: "09 91 23 INTERIOR PAINTING — SEE SPECIFICATIONS FOR ALL SYSTEMS AND SHEENS" } }, WALLS[0], WALLS[1]] }),
  },
  {
    name: "mq-sg633-c-comment", kind: "marquee", note: "sheetgraphFinish.test.ts:633 — C with only a comment above C-1",
    spans: (() => {
      const s = [sp("CODE", 100, 0), sp("MATERIAL", 220, 0), sp("COMMENTS", 760, 0), sp("COLOR", 1000, 0)];
      const data: Array<[string, string, string]> = [["C", "", "SEALED CONCRETE FLOOR"], ["C-1", "CONCRETE STAIN", "BROWN"], ["CPT-1", "CARPET", "GREY"]];
      data.forEach(([k, m, c], i) => { const y = PITCH * (i + 1); s.push(sp(k, 100, y), sp(c, 760, y)); if (m) s.push(sp(m, 220, y)); });
      return s;
    })(),
  },
  {
    name: "mq-sg644-spec-point", kind: "marquee", note: "sheetgraphFinish.test.ts:644 — group label beside a pointed spec section (09 30.50)",
    spans: build({ cols: STD, items: [...FLOOR, { t: "row", key: "TA", cells: { MATERIAL: "09 30.50 TRIM ACCESSORY" } }, R("TA-1", "METAL EDGE TRIM", "VENDOR-I", "SQUARE", "SATIN"), R("TA-2", "METAL TRANSITION", "VENDOR-I", "RAMP", "SATIN")] }),
  },
  {
    name: "mq-sg650-ss-above-ss3", kind: "marquee", note: "sheetgraphFinish.test.ts:650 — fuzz-found SS above SS-3",
    spans: fixture(false, [["MARK", 100, 0, 32], ["MATERIAL", 243, 0, 64], ["DESCRIPTION", 434, 0, 88], ["CEILINGS", 100, 38, 64], ["SS", 163.5, 76, 16], ["CARPET Q1", 302.5, 76, 72], ["SS-3", 155.5, 114, 32]]),
  },
  {
    name: "mq-sg658-t-above-t10", kind: "marquee", note: "sheetgraphFinish.test.ts:658 — fuzz-found T above T-10",
    spans: fixture(false, [["MARK", 139.5, 0, 32], ["SIZE", 333, 0, 32], ["DESCRIPTION", 605.5, 0, 88], ["T", 100, 38, 8], ["OAK 303 Q1", 211, 38, 80], ["T-10", 100, 76, 32]]),
  },

  // marquee twins: the forms PR A's later slices act on
  {
    name: "mq-c-above-c1-not-used", kind: "marquee", note: "cell-less C above a one-span C-1 NOT USED line, then C-2",
    spans: build({ cols: MMC, items: [M("CPT-1", "BROADLOOM CARPET", "VENDOR-A", "GREY 101"), label("C"), KEYLINE("C-1 NOT USED"), M("C-2", "SEALED CONCRETE", "VENDOR-D", "CLEAR")] }),
  },
  {
    name: "mq-c-epox-19-c1-c2", kind: "marquee", note: "cell-less C, a filled EPOX line 19 px under it, then C-1, C-2",
    spans: build({ cols: MMC, items: [M("CPT-1", "BROADLOOM CARPET", "VENDOR-A", "GREY 101"), label("C"), { t: "under", dy: 19, key: "EPOX", cells: EPOX_CELLS }, M("C-1", "SEALED CONCRETE", "VENDOR-D", "CLEAR"), M("C-2", "POLISHED CONCRETE", "VENDOR-D", "SATIN")] }),
  },
  {
    name: "mq-mark-numeric-header-only", kind: "marquee", note: "untitled MARK | MATERIAL | DESCRIPTION, numeric marks only (no finish row reads)",
    spans: build({ key: "MARK", cols: ["MATERIAL", "DESCRIPTION"], colX: { DESCRIPTION: 520 }, items: [
      { t: "row", key: "101", cells: { MATERIAL: "CARPET TILE", DESCRIPTION: "MODULAR 24 x 24" } },
      { t: "row", key: "102", cells: { MATERIAL: "RUBBER BASE", DESCRIPTION: "4 IN COVE" } },
      { t: "row", key: "103", cells: { MATERIAL: "PAINT", DESCRIPTION: "EGGSHELL" } },
    ] }),
  },
  {
    name: "mq-door-schedule-101", kind: "marquee", note: "titled DOOR SCHEDULE, MARK | MATERIAL | MANUFACTURER | COLOR, marks 101–103",
    spans: build({ key: "MARK", cols: MMC, title: "DOOR SCHEDULE", items: [M("101", "HOLLOW METAL", "VENDOR-R", "BLACK"), M("102", "WOOD", "VENDOR-S", "OAK"), M("103", "ALUMINUM", "VENDOR-T", "CLEAR")] }),
  },
  {
    name: "mq-tag-flooring-gap", kind: "marquee", note: "TAG | MATERIAL | REMARKS: T-1, then FLOORING 4 pitches below T-1, then T-2, T-3",
    spans: build({ key: "TAG", cols: ["MATERIAL", "REMARKS"], colX: { REMARKS: 760 }, items: [
      { t: "row", key: "T-1", cells: { MATERIAL: "WALK-OFF MAT", REMARKS: "RECESSED" } },
      { t: "gap", n: 3 }, H("FLOORING"),
      { t: "row", key: "T-2", cells: { MATERIAL: "CARPET TILE", REMARKS: "ASHLAR" } },
      { t: "row", key: "T-3", cells: { MATERIAL: "SHEET VINYL", REMARKS: "HEAT WELDED" } },
    ] }),
  },
  {
    name: "mq-mark-bases-ftb-only", kind: "marquee", note: "MARK | DESCRIPTION | REMARKS + BASES + only FTB-01 CUT (C) / FTB-02 COVE",
    spans: build({ key: "MARK", cols: ["DESCRIPTION", "REMARKS"], colX: { REMARKS: 760 }, items: [
      H("BASES"),
      { t: "row", key: "FTB-01 CUT (C)", cells: { DESCRIPTION: "TILE BASE", REMARKS: "VENDOR-F" } },
      { t: "row", key: "FTB-02 COVE", cells: { DESCRIPTION: "TILE BASE", REMARKS: "VENDOR-F" } },
    ] }),
  },
  {
    name: "mq-alternation", kind: "marquee", note: "alternation CPT-1, EPOX, RB-1, CONC, PT-1 (EPOX, CONC filled)",
    spans: build({ cols: MMC, items: [M("CPT-1", "BROADLOOM CARPET", "VENDOR-A", "GREY 101"), { t: "row", key: "EPOX", cells: EPOX_CELLS }, M("RB-1", "RUBBER BASE", "VENDOR-B", "BLACK 505"), { t: "row", key: "CONC", cells: CONC_CELLS }, M("PT-1", "PAINT", "VENDOR-E", "WHITE 601")] }),
  },
];

export const hasWhole = (t: Twin) => t.kind === "whole" || t.kind === "both";
export const hasMarquee = (t: Twin) => t.kind === "marquee" || t.kind === "both";

// ── expected changes per slice ──────────────────────────────────
// How expectedChanges483.test.ts reads an entry:
//   - `reads[s]` is the COMPLETE expected readScheduleSpans value from slice
//     s on (every row in order, every field, empty strings included, and the
//     optional fields PR A adds where they are set). A slice with no `reads`
//     key inherits the nearest lower one; below the first one the read is the
//     twin's golden. Slices 5 and 6 change no reader output, so they inherit
//     slice 4. Compare with deepStrictEqual on the live value round-tripped
//     through JSON: any field not listed must be absent.
//   - `keys[s]` / `counts[s]` (s = 0…6) restate the ordered finish_tags and
//     the row count of that read — a cheap first check with a readable diff.
//   - `changes` tag each difference from the golden with its exception
//     (i)–(iv) below or read-level kind and the rule behind it, so each stays
//     traceable.
//     They are not the oracle — `reads` is. Per kind:
//       re-key            rows = [key after]; tokens = [the pass-1 key-cell text]; fields = { from: key before }
//       section-restore   rows = keys whose section is restored
//       unglue            rows = [the pass-1 row the tokens leave]; tokens = the span texts of the line(s) that leave it
//       group-drop        rows = [the dropped row's key]
//       unticked          rows = keys; fields = the NOT USED fields set (suggested, unticked_reason, not_used_text)
//       category          rows = keys; fields = { category, category_source } after
//       description-prefix rows = keys; fields = { description } after
//       added-row         rows = keys of new rows, in y order
//       skipped           fields = { skipped: [...] } (the read's skipped list)
//       refusal-flip      fields = { from: refusal or "rows", to: refusal or "rows" }
//     Where a kind carries `fields`, those fields must match the named row in
//     `reads[slice]` (the test checks it now).
//   - Twins without an entry are exact on their readScheduleSpans golden at
//     every slice, so their count and keys are the golden's.

/** The four ways a drawn-box read may change a row today's read has —
 * (i)–(iv) — then the read-level changes. */
export type ChangeKind =
  | "re-key"           // (i): a pass-1 row's key re-keyed in place
  | "section-restore"  // (ii): sections restored below a surviving lone line
  | "unglue"           // (iii): a line's tokens leave the pass-1 row they were attached to
  | "group-drop"       // (iv): a row emptied by unglue dropped as a group label
  | "unticked" | "category" | "description-prefix" | "added-row" | "skipped" | "refusal-flip";
export interface ExpectedChange {
  /** the slice whose source change causes it: base guess 1, entry point and guards 2, key cell and NOT USED 3, four- and five-letter codes 4, the second look at a box that read no rows 5 (#483 rows 1 and 4, scheduleReshape.ts) */
  slice: 1 | 2 | 3 | 4 | 5;
  kind: ChangeKind;
  rows?: string[];
  tokens?: string[];
  fields?: Record<string, unknown>;
  /** the rule behind it */
  clause: string;
}
/** A ScheduleRow as PR A's slices produce it (with the optional fields PR A adds). */
export type ExpectedRow = ScheduleRow & { key_rule?: "extended"; unticked_reason?: "not-used" | "not-in-contract"; not_used_text?: string };
export type ExpectedRead = { rows: ExpectedRow[]; skipped?: string[] } | { rows: []; refused: RefusalReason; title?: string };
type Seven<T> = [T, T, T, T, T, T, T];
export interface TwinExpectation {
  /** live readScheduleSpans row count at slices 0…6 */
  counts: Seven<number>;
  /** live readScheduleSpans finish_tags, in order, at slices 0…6 */
  keys: Seven<string[]>;
  /** the complete expected read from the slice it changes at (see the comment above) */
  reads: Partial<Record<1 | 2 | 3 | 4 | 5, ExpectedRead>>;
  changes: ExpectedChange[];
  /** why, when the changes are empty but the twin is listed */
  reason?: string;
}
/** The expected read at slice s: the nearest `reads` entry at or below s (6 → 5), else null (= the golden). */
export function expectedReadAt(e: TwinExpectation, s: number): ExpectedRead | null {
  for (let k = Math.min(s, 5); k >= 1; k--) { const r = e.reads[k as 1 | 2 | 3 | 4 | 5]; if (r) return r; }
  return null;
}

/** A no-section row with no cells beyond the given ones (every ScheduleRow field present). */
const row = (finish_tag: string, o: Partial<ExpectedRow> = {}): ExpectedRow => ({
  finish_tag, section: "", category: "unassigned", category_source: "none", description: "", manufacturer: "", style: "",
  spec_color: "", size: "", remarks: "", suggested: true, ...o,
});
// rows as they read once their merged lines are gone (iii), and the new rows (a code line, a filled four- or five-letter code)
const CPT1 = row("CPT-1", { description: "BROADLOOM CARPET", manufacturer: "VENDOR-A", spec_color: "GREY 101" });
const RB1 = row("RB-1", { category: "base", category_source: "text", description: "RUBBER BASE", manufacturer: "VENDOR-B", spec_color: "BLACK 505" });
const PT1 = row("PT-1", { description: "PAINT", manufacturer: "VENDOR-E", spec_color: "WHITE 601" });
const EPOX = row("EPOX", { description: "EPOXY FLOORING", manufacturer: "VENDOR-L", spec_color: "GREY 901", key_rule: "extended" });
const CONC = row("CONC", { description: "SEALED CONCRETE", manufacturer: "VENDOR-D", spec_color: "CLEAR", key_rule: "extended" });

/** Marquee twins whose readScheduleSpans read a later slice changes. Twins
 * not listed are exact on their readScheduleSpans golden at every slice. */
export const expectedChanges: Record<string, TwinExpectation> = {
  "both-material-code": {
    counts: [0, 0, 0, 0, 0, 4, 4],
    keys: [[], [], [], [], [], ["BR-1", "CK-1", "SL-1", "CPT-1"], ["BR-1", "CK-1", "SL-1", "CPT-1"]],
    reads: {
      5: { rows: [
        row("BR-1", { description: "BRICK", manufacturer: "VENDOR-M", spec_color: "RED 801" }),
        row("CK-1", { description: "CORK", manufacturer: "VENDOR-N", spec_color: "NATURAL 802" }),
        row("SL-1", { description: "SLATE", manufacturer: "VENDOR-O", spec_color: "GREY 803" }),
        row("CPT-1", { description: "CARPET", manufacturer: "VENDOR-A", spec_color: "GREY 101" }),
      ] },
    },
    changes: [
      { slice: 5, kind: "refusal-flip", rows: ["BR-1", "CK-1", "SL-1", "CPT-1"], fields: { from: "no-table", to: "rows" },
        clause: "the box read no rows with CODE printed second; the second look moves the CODE band to the front and reads it (#483 row 1)" },
    ],
  },
  "mq-c-above-c1-not-used": {
    counts: [3, 3, 3, 3, 3, 3, 3],
    keys: [["CPT-1", "C", "C-2"], ["CPT-1", "C", "C-2"], ["CPT-1", "C", "C-2"], ["CPT-1", "C-1", "C-2"], ["CPT-1", "C-1", "C-2"], ["CPT-1", "C-1", "C-2"], ["CPT-1", "C-1", "C-2"]],
    reads: {
      3: { rows: [
        CPT1,
        // a NOT USED tail: key = word 1, no qualifier, no cells → description ""; NOT USED unticks it
        row("C-1", { suggested: false, unticked_reason: "not-used", not_used_text: "NOT USED", key_rule: "extended" }),
        row("C-2", { description: "SEALED CONCRETE", manufacturer: "VENDOR-D", spec_color: "CLEAR" }),
      ] },
    },
    changes: [
      { slice: 3, kind: "unglue", rows: ["C"], tokens: ["C-1 NOT USED"], clause: "(iii); an unglue candidate (gap 38 ≥ max(1.6·17, 0.75·38)), its wrap lines moving with it" },
      { slice: 3, kind: "group-drop", rows: ["C"], clause: "(iv): C's cells are all empty after (iii) and the new C-1 follows within 3 rows: a cell-less C above C-1 NOT USED is dropped, C-1 a row" },
      { slice: 3, kind: "added-row", rows: ["C-1"], clause: "a NOT USED tail → key = word 1; a new-rule row carries key_rule" },
      { slice: 3, kind: "unticked", rows: ["C-1"], fields: { suggested: false, unticked_reason: "not-used", not_used_text: "NOT USED" }, clause: "notUsed / notUsedText from the tail; toRow unticks it" },
    ],
  },
  "mq-c-epox-19-c1-c2": {
    counts: [4, 4, 4, 4, 4, 4, 4],
    keys: [["CPT-1", "C", "C-1", "C-2"], ["CPT-1", "C", "C-1", "C-2"], ["CPT-1", "C", "C-1", "C-2"], ["CPT-1", "C", "C-1", "C-2"], ["CPT-1", "C", "C-1", "C-2"], ["CPT-1", "C", "C-1", "C-2"], ["CPT-1", "C", "C-1", "C-2"]],
    reads: {},
    changes: [],
    reason: "the EPOX line is attached at pass 1 and its gap to the line above (19 px) is under max(1.6·17, 0.75·linePitch), so it is not an unglue candidate, never a letters candidate (that needs an eligible line), and stays merged into C; C keeps cells, so no (iv). A known limit: a key-column line closer than the unglue gap stays merged. The read is its golden at every slice.",
  },
  "mq-mark-bases-ftb-only": {
    counts: [0, 0, 0, 2, 2, 2, 2],
    keys: [[], [], [], ["FTB-01", "FTB-02"], ["FTB-01", "FTB-02"], ["FTB-01", "FTB-02"], ["FTB-01", "FTB-02"]],
    reads: {
      // slices 1–2: the golden { rows: [], refused: "no-table" } (headerOnly with empty skipped → no-table)
      3: { rows: [
        // description = joinParts([qualifier, DESCRIPTION]); BASES → base by heading (pass 2's section); REMARKS cell → remarks
        row("FTB-01", { section: "BASES", category: "base", category_source: "heading", description: "CUT (C) — TILE BASE", remarks: "VENDOR-F", key_rule: "extended" }),
        row("FTB-02", { section: "BASES", category: "base", category_source: "heading", description: "COVE — TILE BASE", remarks: "VENDOR-F", key_rule: "extended" }),
      ] },
    },
    changes: [
      { slice: 3, kind: "refusal-flip", fields: { from: "no-table", to: "rows" }, clause: "a table with no pass-1 rows; hasSection from the consumed BASES heading; the guards (a printed heading → no header refusal): MARK|DESCRIPTION|REMARKS + BASES + only FTB rows → rows under BASES" },
      { slice: 3, kind: "added-row", rows: ["FTB-01", "FTB-02"], clause: "pass-1-unattached lines are eligible; the qualifier split (eligible lines always split); the table run from the header; section = pass 2's curSection" },
      { slice: 3, kind: "description-prefix", rows: ["FTB-01"], fields: { description: "CUT (C) — TILE BASE" }, clause: "description = joinParts([qualifier, …]): FTB-01 → `CUT (C) — TILE BASE`" },
      { slice: 3, kind: "description-prefix", rows: ["FTB-02"], fields: { description: "COVE — TILE BASE" }, clause: "the qualifier split (COVE: 4 letters, not in DENY); description = joinParts([qualifier, …])" },
    ],
  },
  "mq-alternation": {
    counts: [3, 3, 3, 3, 5, 5, 5],
    keys: [["CPT-1", "RB-1", "PT-1"], ["CPT-1", "RB-1", "PT-1"], ["CPT-1", "RB-1", "PT-1"], ["CPT-1", "RB-1", "PT-1"], ["CPT-1", "EPOX", "RB-1", "CONC", "PT-1"], ["CPT-1", "EPOX", "RB-1", "CONC", "PT-1"], ["CPT-1", "EPOX", "RB-1", "CONC", "PT-1"]],
    reads: { 4: { rows: [CPT1, EPOX, RB1, CONC, PT1] } },
    changes: [
      { slice: 4, kind: "added-row", rows: ["EPOX", "CONC"], clause: "letters candidates; position (a read row above, numbered row below) and two or more other cells filled: alternation CPT-1, EPOX, RB-1, CONC, PT-1 → five rows" },
      { slice: 4, kind: "unglue", rows: ["CPT-1"], tokens: ["EPOX", "EPOXY FLOORING", "VENDOR-L", "GREY 901"], clause: "(iii): CPT-1 / RB-1 without the merged text" },
      { slice: 4, kind: "unglue", rows: ["RB-1"], tokens: ["CONC", "SEALED CONCRETE", "VENDOR-D", "CLEAR"], clause: "(iii)" },
    ],
  },
  "both-short-cpt-rb-epox-pt": {
    counts: [3, 3, 3, 3, 4, 4, 4],
    keys: [["CPT-1", "RB-1", "PT-1"], ["CPT-1", "RB-1", "PT-1"], ["CPT-1", "RB-1", "PT-1"], ["CPT-1", "RB-1", "PT-1"], ["CPT-1", "RB-1", "EPOX", "PT-1"], ["CPT-1", "RB-1", "EPOX", "PT-1"], ["CPT-1", "RB-1", "EPOX", "PT-1"]],
    reads: { 4: { rows: [CPT1, RB1, EPOX, PT1] } },
    changes: [
      { slice: 4, kind: "added-row", rows: ["EPOX"], clause: "a letters candidate; position and two or more other cells filled: short CPT-1, RB-1, EPOX, PT-1 → four rows" },
      { slice: 4, kind: "unglue", rows: ["RB-1"], tokens: ["EPOX", "EPOXY FLOORING", "VENDOR-L", "GREY 901"], clause: "(iii): RB-1 reads `RUBBER BASE`" },
    ],
  },
};

// ── the live values a golden pins (shared by the capture script and the test) ─
/** One sheet of the twin's spans, as the whole-sheet entry points take it. */
const sheetOf = (spans: GraphSpan[]) => ({ key: "fx", spans });
/** readFinishTable(…, { marquee: true }): the table's rows, or null (no table). */
export function finishRowsOf(spans: GraphSpan[]) {
  const r = readFinishTable(sheetOf(spans), { marquee: true });
  return r ? { otherFamily: "refused" in r, rows: r.table.rows } : null;
}
/** The legacy tokens parseSchedule takes (baseline-left origin). */
export const legacyTokens = (spans: GraphSpan[]) => spans.map((t) => ({ str: t.str, x: t.x, y: t.y + t.h, h: t.h }));
/** Whole-sheet reads: extractTable, readFinishTable(marquee) rows, the graph's tables and notes, resolveTag per key. */
export function liveWhole(spans: GraphSpan[]) {
  const graph = buildSheetGraph([sheetOf(spans)]);
  const keys = [...new Set(graph.tables.flatMap((t) => t.rows.map((r) => r.key)))];
  return {
    extractTable: extractTable(sheetOf(spans), "finish"),
    finishRows: finishRowsOf(spans),
    graphTables: graph.tables,
    graphNotes: graph.notes,
    resolve: Object.fromEntries(keys.map((k) => [k, resolveTag(graph, k)])),
  };
}
/** Marquee reads: readScheduleSpans, parseSchedule (legacy tokens), readFinishTable(marquee) rows. */
export function liveMarquee(spans: GraphSpan[]) {
  return { readScheduleSpans: readScheduleSpans(spans), parseSchedule: parseSchedule(legacyTokens(spans)), finishRows: finishRowsOf(spans) };
}
/** The controls: each shape's read of the plain FLOOR + BASE table, and legacyKeys. */
export function liveControls() {
  return { reads: Object.fromEntries(SHAPES.map((s) => [s, readAs(CONTROL_SPANS, s)])), legacyKeys: legacyKeys(CONTROL_SPANS) };
}
/** A twin's golden: its spans (so a fixture edit is caught) and its reads. */
export function liveTwin(t: Twin) {
  return {
    name: t.name, kind: t.kind, note: t.note, spans: t.spans,
    ...(hasWhole(t) ? { whole: liveWhole(t.spans) } : {}),
    ...(hasMarquee(t) ? { marquee: liveMarquee(t.spans) } : {}),
  };
}
/** The JSON round-trip a golden went through (drops undefined, -0 → 0). */
export const roundTrip = <T>(v: T): unknown => JSON.parse(JSON.stringify(v));
export const GOLDEN_DIR_URL = new URL("./reader-483/", import.meta.url);
export const CONTROLS_GOLDEN = "controls.json";
export const goldenFile = (name: string) => `${name}.json`;
