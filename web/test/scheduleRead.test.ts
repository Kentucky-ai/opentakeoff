// Import from schedule through the shared finish reader (scheduleRead.ts).
// Every fixture is synthetic — invented codes and vendors, laid out at the
// scale the MCP serves the bundled demo sheet (text 17 px tall, 38 px row
// pitch, ~8 px per character). The invariants:
//   - a finish table keyed CODE, TAG, MARK or SYMBOL reads its rows;
//   - category: a printed heading names it; else the row's MATERIAL /
//     DESCRIPTION words, and only item words (base, transition, wall
//     protection); else none ("No section") — and each row says which;
//   - rows start ticked, except under a printed CEILINGS or MILLWORK heading;
//   - the description is the distinct MATERIAL, DESCRIPTION and PRODUCT
//     cells joined " — "; REMARKS (else COMMENTS) is its own field;
//   - another schedule family (door, furniture, signage, plumbing, device) is
//     refused, and says why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readScheduleSpans, parseSchedule, headerRefusal, b4, type ScheduleRead } from "../src/lib/scheduleRead.ts";
import { readFinishTable, type GraphSpan } from "../src/lib/sheetgraph.ts";
import type { ScheduleRow } from "../src/lib/scheduleRows.ts";

// ── fixture builder (the sheetgraphFinish.test.ts builder) ──────────────────
const TH = 17, PITCH = 38, CW = 8;
const sp = (str: string, x: number, y: number, h = TH): GraphSpan => ({ str, x, y, w: str.length * CW, h });
const COLS: Record<string, number> = { KEY: 100, MATERIAL: 220, DESCRIPTION: 220, MANUFACTURER: 520, STYLE: 760, PRODUCT: 760, COLOR: 1000, SIZE: 1240, REMARKS: 1400, COMMENTS: 1400 };
type Cells = Partial<Record<string, string>>;
type Item = { t: "row"; key: string; cells: Cells } | { t: "head"; text: string };

function build(o: { key?: string; cols: string[]; title?: string; items: Item[]; colX?: Record<string, number> }): GraphSpan[] {
  const X = { ...COLS, ...(o.colX ?? {}) };
  const labels = [o.key ?? "CODE", ...o.cols];
  const xs = [X.KEY, ...o.cols.map((c) => X[c])];
  const out: GraphSpan[] = [];
  let y = 0;
  if (o.title) { out.push(sp(o.title, xs[0], y, 24)); y += PITCH; }
  labels.forEach((l, i) => out.push(sp(l, xs[i], y)));
  for (const it of o.items) {
    y += PITCH;
    if (it.t === "head") out.push(sp(it.text, xs[0], y));
    else { out.push(sp(it.key, xs[0], y)); o.cols.forEach((c, i) => { const v = it.cells[c]; if (v) out.push(sp(v, xs[i + 1], y)); }); }
  }
  return out;
}
// invented finish rows: key, material, vendor, style, color, size, remarks
const R = (key: string, mat: string, mfr: string, style = "", color = "", size = "", rem = ""): Item =>
  ({ t: "row", key, cells: { MATERIAL: mat, DESCRIPTION: mat, MANUFACTURER: mfr, STYLE: style, PRODUCT: style, COLOR: color, SIZE: size, REMARKS: rem, COMMENTS: rem } });
const H = (text: string): Item => ({ t: "head", text });
const FLOOR = [R("CPT-1", "BROADLOOM CARPET", "VENDOR-A", "LOOP 20", "GREY 101"), R("CPT-2", "MODULAR CARPET TILE", "VENDOR-A", "GRID 24", "BLUE 202"), R("LVT-1", "LUXURY VINYL TILE", "VENDOR-B", "PLANK 6", "OAK 303", '6" x 36"', "ADHESIVE: VENDOR-K"), R("VCT-1", "VINYL COMPOSITION TILE", "VENDOR-C", "STANDARD", "WHITE 404", '12" x 12"', "ADHESIVE: VENDOR-K"), R("SC-1", "SEALED CONCRETE", "VENDOR-D", "CLEAR COAT", "CLEAR")];
const BASE = [R("RB-1", "RUBBER WALL BASE", "VENDOR-B", "COVE", "BLACK 505", '4"'), R("RB-2", "RESILIENT BASE", "VENDOR-B", "STRAIGHT", "GREY 506", '6"')];
const WALLS = [R("P-1", "PAINT", "VENDOR-E", "EGGSHELL", "WHITE 601"), R("P-2", "PAINT", "VENDOR-E", "SEMI-GLOSS", "TAUPE 602", "", "SEE NOTE 4"), R("CT-1", "CERAMIC WALL TILE", "VENDOR-F", "GLOSS", "WHITE 603", '3" x 6"', "GROUT: VENDOR-K 01 WHITE")];
const CEIL = [R("ACT-1", "ACOUSTICAL CEILING TILE", "VENDOR-G", "FINE FISSURED", "WHITE", "2' x 2'")];
const MILL = [R("PL-1", "PLASTIC LAMINATE", "VENDOR-H", "MATTE", "MAPLE 701")];
const MISC = [R("TS-1", "TRANSITION STRIP", "VENDOR-I", "RAMP", "SATIN"), R("CG-1", "CORNER GUARDS", "VENDOR-J", "SURFACE", "ALMOND"), R("PR-1", "METAL TILE EDGE", "VENDOR-I", "SQUARE", "SATIN")];
const STD = ["MATERIAL", "MANUFACTURER", "STYLE", "COLOR", "SIZE", "REMARKS"];
const keysOf = (items: Item[]) => items.flatMap((i) => (i.t === "row" ? [i.key] : []));

const rowsOf = (r: ScheduleRead): ScheduleRow[] => {
  assert.ok(!("refused" in r), `read, not refused (${"refused" in r ? r.refused : ""})`);
  return r.rows;
};
const byKey = (rows: ScheduleRow[]) => Object.fromEntries(rows.map((r) => [r.finish_tag, r]));
/** key → [category, category_source, suggested] for every row. */
const cats = (rows: ScheduleRow[]) => Object.fromEntries(rows.map((r) => [r.finish_tag, [r.category, r.category_source, r.suggested]]));
const refusal = (r: ScheduleRead) => ("refused" in r ? r.refused : null);

// ── key columns and categories ──────────────────────────────────────────────
const NO_HEAD = [...FLOOR, ...BASE, ...WALLS, ...MISC];
/** A no-heading table: only item words name a category; the rest have none. */
const NO_HEAD_CATS = {
  "CPT-1": ["unassigned", "none", true], "CPT-2": ["unassigned", "none", true], "LVT-1": ["unassigned", "none", true],
  "VCT-1": ["unassigned", "none", true], "SC-1": ["unassigned", "none", true],
  "RB-1": ["base", "text", true], "RB-2": ["base", "text", true],
  "P-1": ["unassigned", "none", true], "P-2": ["unassigned", "none", true], "CT-1": ["unassigned", "none", true],
  "TS-1": ["transition", "text", true], "CG-1": ["wall_protection", "text", true], "PR-1": ["unassigned", "none", true],
};

for (const key of ["TAG", "MARK", "SYMBOL"]) {
  test(`a ${key}-keyed finish table reads its rows, fields and all`, () => {
    const rows = rowsOf(readScheduleSpans(build({ key, cols: STD, title: "FINISH SCHEDULE", items: NO_HEAD })));
    assert.deepEqual(rows.map((r) => r.finish_tag), keysOf(NO_HEAD));
    const by = byKey(rows);
    assert.deepEqual(
      { ...by["LVT-1"] },
      { finish_tag: "LVT-1", section: "", category: "unassigned", category_source: "none", description: "LUXURY VINYL TILE", manufacturer: "VENDOR-B",
        style: "PLANK 6", spec_color: "OAK 303", size: '6" x 36"', remarks: "ADHESIVE: VENDOR-K", suggested: true },
    );
    assert.equal(by["CT-1"].remarks, "GROUT: VENDOR-K 01 WHITE");
    assert.equal(by["RB-1"].size, '4"');
    assert.deepEqual(cats(rows), NO_HEAD_CATS);
  });
}

test("a table with no headings: every row starts ticked; only item words set a category", () => {
  const rows = rowsOf(readScheduleSpans(build({ cols: STD, items: NO_HEAD })));
  assert.deepEqual(cats(rows), NO_HEAD_CATS);
  assert.ok(rows.every((r) => r.section === ""));
});

test("printed headings name the category; CEILINGS and MILLWORK rows start unticked; MISC rows go by their words", () => {
  const items = [H("FLOORING"), ...FLOOR, H("BASE"), ...BASE, H("WALLS"), ...WALLS, H("CEILINGS"), ...CEIL, H("MILLWORK"), ...MILL, H("MISC"), ...MISC];
  const rows = rowsOf(readScheduleSpans(build({ cols: STD, items })));
  assert.deepEqual(rows.map((r) => r.finish_tag), keysOf(items));
  const c = cats(rows);
  for (const k of keysOf(FLOOR)) assert.deepEqual(c[k], ["floor", "heading", true], k);
  for (const k of keysOf(BASE)) assert.deepEqual(c[k], ["base", "heading", true], k);
  for (const k of keysOf(WALLS)) assert.deepEqual(c[k], ["wall", "heading", true], k);
  assert.deepEqual(c["ACT-1"], ["ceiling", "heading", false]);
  assert.deepEqual(c["PL-1"], ["other", "heading", false]);
  // MISC names no category — the words do, and those rows stay ticked
  assert.deepEqual(c["TS-1"], ["transition", "text", true]);
  assert.deepEqual(c["CG-1"], ["wall_protection", "text", true]);
  assert.deepEqual(c["PR-1"], ["unassigned", "none", true]);
  assert.equal(byKey(rows)["TS-1"].section, "MISC");
});

test("a WALL PROTECTION heading is its own category; WALL BASE is base", () => {
  const wp = [R("HR-1", "HANDRAIL", "VENDOR-J", "ROUND", "ALMOND"), R("CG-2", "CORNER GUARD", "VENDOR-J", "FLUSH", "ALMOND")];
  const rows = rowsOf(readScheduleSpans(build({ cols: STD, items: [H("FLOORING"), ...FLOOR, H("WALL BASE"), ...BASE, H("WALL PROTECTION"), ...wp] })));
  const c = cats(rows);
  assert.deepEqual(c["HR-1"], ["wall_protection", "heading", true]);
  assert.deepEqual(c["CG-2"], ["wall_protection", "heading", true]);
  assert.deepEqual(c["RB-1"], ["base", "heading", true]);
  assert.equal(byKey(rows)["RB-1"].section, "WALL BASE");
});

test("a heading's category beats the row's words (a TRANSITION STRIP under FLOORING is floor)", () => {
  const rows = rowsOf(readScheduleSpans(build({ cols: STD, items: [H("FLOORING"), ...FLOOR, R("TS-2", "TRANSITION STRIP", "VENDOR-I", "RAMP", "SATIN"), H("BASE"), ...BASE] })));
  assert.deepEqual(cats(rows)["TS-2"], ["floor", "heading", true]);
});

// ── description and remarks ─────────────────────────────────────────────────
test("description joins distinct DESCRIPTION and PRODUCT cells; the words that set a category never include PRODUCT", () => {
  const row = (key: string, d: string, m: string, p: string, c: string): Item => ({ t: "row", key, cells: { DESCRIPTION: d, MANUFACTURER: m, PRODUCT: p, COLOR: c } });
  const items = [
    row("RB-7", "RUBBER BASE", "VENDOR-P", "ARDENNE CONTOUR", "BLACK 11"),
    row("RB-8", "RUBBER BASE", "VENDOR-P", "RUBBER BASE", "GREY 12"),
    row("LVT-7", "LUXURY VINYL TILE", "VENDOR-P", "HARBOR BASE", "OAK 13"),
    row("CPT-7", "BROADLOOM CARPET", "VENDOR-Q", "TRANSITION SERIES", "BLUE 14"),
    row("CPT-8", "CARPET TILE", "VENDOR-Q", "MERIDIAN LOOP", "GREY 15"),
    row("HR-7", "HANDRAIL", "VENDOR-S", "CLASSIC 40", "ALMOND 16"),
    row("P-7", "PAINT", "VENDOR-R", "", "WHITE 17"),
    row("VCT-7", "VINYL COMPOSITION TILE", "VENDOR-R", "STANDARD", "WHITE 18"),
  ];
  const rows = rowsOf(readScheduleSpans(build({ key: "MARK", cols: ["DESCRIPTION", "MANUFACTURER", "PRODUCT", "COLOR"], items })));
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.finish_tag, r.description])), {
    "RB-7": "RUBBER BASE — ARDENNE CONTOUR", "RB-8": "RUBBER BASE",
    "LVT-7": "LUXURY VINYL TILE — HARBOR BASE", "CPT-7": "BROADLOOM CARPET — TRANSITION SERIES",
    "CPT-8": "CARPET TILE — MERIDIAN LOOP", "HR-7": "HANDRAIL — CLASSIC 40",
    "P-7": "PAINT", "VCT-7": "VINYL COMPOSITION TILE — STANDARD",
  });
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.finish_tag, r.category])), {
    "RB-7": "base", "RB-8": "base", "LVT-7": "unassigned", "CPT-7": "unassigned",
    "CPT-8": "unassigned", "HR-7": "wall_protection", "P-7": "unassigned", "VCT-7": "unassigned",
  });
});

test("description joins MATERIAL and DESCRIPTION; a phrase never spans the two cells", () => {
  const row = (key: string, a: string, d: string, m: string, c: string): Item => ({ t: "row", key, cells: { MATERIAL: a, DESCRIPTION: d, MANUFACTURER: m, COLOR: c } });
  const items = [row("RB-9", "RUBBER", "WALL BASE", "VENDOR-P", "BLACK 21"), row("TS-9", "ALUMINUM", "TRANSITION STRIP", "VENDOR-P", "SATIN 22"), row("CPT-9", "CARPET", "BROADLOOM", "VENDOR-Q", "BLUE 23"), row("CG-9", "STAINLESS STEEL", "CORNER GUARD", "VENDOR-S", "NATURAL 24"), row("P-9", "PAINT", "PAINT", "VENDOR-R", "WHITE 25"), row("LVT-9", "VINYL", "LUXURY VINYL TILE", "VENDOR-R", "OAK 26")];
  const rows = rowsOf(readScheduleSpans(build({ key: "MARK", cols: ["MATERIAL", "DESCRIPTION", "MANUFACTURER", "COLOR"], items, colX: { MATERIAL: 220, DESCRIPTION: 470, MANUFACTURER: 760, COLOR: 1000 } })));
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.finish_tag, [r.description, r.category]])), {
    "RB-9": ["RUBBER — WALL BASE", "base"], "TS-9": ["ALUMINUM — TRANSITION STRIP", "transition"],
    "CPT-9": ["CARPET — BROADLOOM", "unassigned"], "CG-9": ["STAINLESS STEEL — CORNER GUARD", "wall_protection"],
    "P-9": ["PAINT", "unassigned"], "LVT-9": ["VINYL — LUXURY VINYL TILE", "unassigned"],
  });
});

test("a MARK|DESCRIPTION|MANUFACTURER|PRODUCT|REMARKS materials table is read", () => {
  const items = [...FLOOR, ...BASE, ...WALLS];
  const rows = rowsOf(readScheduleSpans(build({ key: "MARK", cols: ["DESCRIPTION", "MANUFACTURER", "PRODUCT", "REMARKS"], items })));
  assert.deepEqual(rows.map((r) => r.finish_tag), keysOf(items));
  const by = byKey(rows);
  assert.equal(by["CPT-1"].description, "BROADLOOM CARPET — LOOP 20");
  assert.equal(by["CPT-1"].manufacturer, "VENDOR-A");
  assert.equal(by["LVT-1"].remarks, "ADHESIVE: VENDOR-K");
  assert.equal(by["LVT-1"].style, "", "PRODUCT is part of the description, not the style");
});

test("a COMMENTS column is the remarks when there is no REMARKS column", () => {
  const rows = rowsOf(readScheduleSpans(build({ cols: ["MATERIAL", "MANUFACTURER", "STYLE", "COLOR", "SIZE", "COMMENTS"], items: [H("FLOORING"), ...FLOOR, H("WALLS"), ...WALLS] })));
  const by = byKey(rows);
  assert.equal(by["LVT-1"].remarks, "ADHESIVE: VENDOR-K");
  assert.equal(by["CT-1"].remarks, "GROUT: VENDOR-K 01 WHITE");
  assert.equal(by["LVT-1"].size, '6" x 36"', "the remarks never land in SIZE");
});

// ── other schedule families are refused ─────────────────────────────────────
const eqRows = (keys: string[], cols: string[], vals: string[][]): Item[] =>
  keys.map((k, i) => ({ t: "row", key: k, cells: Object.fromEntries(cols.map((c, j) => [c, vals[i % vals.length][j]])) }));
const X6 = (cs: string[]) => Object.fromEntries(cs.map((c, i) => [c, 220 + i * 170]));
const n8 = (p: string) => Array.from({ length: 8 }, (_, i) => `${p}-${i + 1}`);
const other = (key: string, cols: string[], keys: string[], vals: string[][], title?: string) =>
  build({ key, cols, title, items: eqRows(keys, cols, vals), colX: X6(cols) });

const DOOR_COLS = ["TYPE", "MATERIAL", "MANUFACTURER", "COLOR", "REMARKS"];
const DOOR_VALS = [["A", "HM", "VENDOR-N", "GRAY", ""], ["B", "WD", "VENDOR-N", "OAK", ""]];
const FAMILIES: Array<[string, GraphSpan[], string]> = [
  ["door schedule, titled", other("MARK", DOOR_COLS, n8("D"), DOOR_VALS, "DOOR SCHEDULE"), "title"],
  ["door schedule, untitled (WIDTH / HEIGHT / HARDWARE)", other("MARK", ["WIDTH", "HEIGHT", "MATERIAL", "FINISH", "HARDWARE", "REMARKS"], n8("D"), [["3'-0\"", "7'-0\"", "HM", "PAINT", "HW-1", ""], ["3'-0\"", "7'-0\"", "WD", "STAIN", "HW-2", ""]]), "foreign-header"],
  ["furniture schedule (QTY)", other("TAG", ["DESCRIPTION", "MANUFACTURER", "MODEL", "COLOR", "QTY"], n8("CH"), [["TASK CHAIR", "VENDOR-O", "TC-2", "BLACK", "12"], ["TABLE", "VENDOR-O", "T-60", "OAK", "3"]], "FURNITURE SCHEDULE"), "foreign-header"],
  ["signage schedule (MESSAGE)", other("SYMBOL", ["TYPE", "MESSAGE", "COLOR", "SIZE"], n8("S"), [["ROOM ID", "ROOM NAME", "BLUE", "8X8"], ["EXIT", "EXIT", "RED", "6X6"]]), "foreign-header"],
  ["plumbing fixture schedule (FIXTURE)", other("MARK", ["FIXTURE", "MANUFACTURER", "MODEL", "REMARKS"], n8("WC"), [["WATER CLOSET", "VENDOR-M", "WC-100", "ADA"], ["LAVATORY", "VENDOR-M", "LV-20", ""]]), "foreign-header"],
  ["fan schedule (CFM / VOLTS)", other("MARK", ["DESCRIPTION", "MANUFACTURER", "MODEL", "CFM", "VOLTS"], n8("EF"), [["EXHAUST FAN", "VENDOR-L", "BX-80", "80", "120"], ["INLINE FAN", "VENDOR-L", "IL-200", "200", "208"]]), "equipment"],
];
for (const [name, spans, why] of FAMILIES) {
  test(`refused: ${name}`, () => {
    const r = readScheduleSpans(spans);
    assert.deepEqual(r.rows, []);
    assert.equal(refusal(r), why);
  });
}

test("a refusal by title names the title, so the caller can say what the table is", () => {
  const r = readScheduleSpans(FAMILIES[0][1]);
  assert.ok("refused" in r);
  assert.equal(r.title, "DOOR SCHEDULE");
});

test("a pump schedule is refused by the equipment re-read — the header guard alone would read it", () => {
  // GPM and HP are device columns the guard does not list, and DESCRIPTION +
  // MANUFACTURER name a materials table, so only the equipment reader's
  // device columns tell this one apart
  const cols = ["DESCRIPTION", "MANUFACTURER", "MODEL", "GPM", "HP"];
  const spans = other("MARK", cols, n8("P"), [["CIRC PUMP", "VENDOR-L", "CP-1", "40", "1"], ["BOOSTER PUMP", "VENDOR-L", "BP-2", "60", "2"]]);
  const fin = readFinishTable({ key: "crop", spans }, { marquee: true });
  assert.ok(fin && "headerWords" in fin && fin.table.rows.length === 8, "the finish reader alone takes it");
  assert.equal(headerRefusal(fin.table.headers, fin.headerWords, false), null, "the guard alone passes it");
  const r = readScheduleSpans(spans);
  assert.equal(refusal(r), "equipment");
  assert.deepEqual(r.rows, []);
});

test("a table that says nothing of finish (no CODE, heading, maker or COLOR/STYLE/PATTERN column) is refused", () => {
  const cols = ["DESCRIPTION", "SIZE", "REMARKS"];
  const r = readScheduleSpans(other("MARK", cols, n8("G"), [["LINEAR GRILLE", "24X6", "SEE PLAN"], ["SLOT DIFFUSER", "48X4", ""]]));
  assert.equal(refusal(r), "no-color-style-pattern");
});

test("a CODE key or a printed heading wins over a door-schedule column word", () => {
  const items = [H("FLOORING"), ...FLOOR, H("BASE"), ...BASE];
  // HEIGHT at the SIZE position, in a CODE-keyed headed finish table
  const spans = build({ cols: ["MATERIAL", "MANUFACTURER", "STYLE", "COLOR", "HEIGHT", "REMARKS"], items, colX: { HEIGHT: 1240 } });
  assert.deepEqual(rowsOf(readScheduleSpans(spans)).map((r) => r.finish_tag), keysOf(items));
});

test("known limit: an untitled door schedule that prints MATERIAL, MANUFACTURER and COLOR is read", () => {
  // nothing on it says door: no title, no WIDTH / HEIGHT / HARDWARE column
  const r = readScheduleSpans(other("MARK", DOOR_COLS, n8("D"), DOOR_VALS));
  assert.equal(r.rows.length, 8);
});

test("no finish table in the box → refused as no-table (the caller may try the scan reader)", () => {
  assert.equal(refusal(readScheduleSpans([])), "no-table");
  assert.equal(refusal(readScheduleSpans([sp("GENERAL NOTES", 10, 10), sp("FIELD VERIFY", 10, 48)])), "no-table");
});

test("legacy tokens (baseline y, no width) read through the same reader; a refusal reads as no rows", () => {
  const toTokens = (s: GraphSpan[]) => s.map((t) => ({ str: t.str, x: t.x, y: t.y + t.h, h: t.h }));
  const items = [H("FLOORING"), ...FLOOR, H("BASE"), ...BASE];
  assert.deepEqual(parseSchedule(toTokens(build({ cols: STD, items }))).map((r) => r.finish_tag), keysOf(items));
  assert.deepEqual(parseSchedule(toTokens(FAMILIES[0][1])), []);
});

// ── the item-word list ──────────────────────────────────────────────────────
test("item words: base, transition and wall protection phrases; exclusions; two categories → none", () => {
  const TABLE: Array<[string, string]> = [
    ["RUBBER WALL BASE", "base"], ["CARPET WALL BASE", "base"], ["CERAMIC WALL TILE", "none"], ["ACOUSTICAL CEILING TILE", "none"],
    ["BROADLOOM CARPET", "none"], ["WALL-MOUNTED HANDRAIL", "wall_protection"], ["PLASTIC LAMINATE BASE CABINETS", "none"],
    ["WOOD TRIM", "none"], ["TRANSITION STRIP", "transition"], ["PAINT", "none"], ["METAL TILE TRIM", "none"],
    ["METAL TRANSITION STRIP", "transition"], ["HANDRAIL", "wall_protection"], ["CRASH RAIL", "wall_protection"],
    ["CORNER GUARDS", "wall_protection"], ["EPOXY FLOORING W/ INTEGRAL COVE BASE", "none"], ["RUBBER STAIR TREADS W/ NOSING", "none"],
    ["CORNER GUARD, BASE", "none"], ["WATER-BASED SEALER", "none"], ["RESILIENT BASE", "base"], ["CERAMC WALL TILE", "none"],
  ];
  assert.equal(TABLE.length, 21);
  for (const [text, want] of TABLE) assert.equal(b4(text), want, text);
});

test("item words: the other exclusions and the plural and phrase forms", () => {
  for (const t of ["BASE COAT", "BASE PLATE", "BASE SHEET", "SINK BASE", "VANITY BASE", "FLASH COVE BASE", "BASE CABINET"]) assert.equal(b4(t), "none", t);
  for (const t of ["COVE BASE", "RUBBER BASE (4\")", "WALL BASE/COVE"]) assert.equal(b4(t), "base", t);
  for (const t of ["THRESHOLDS", "REDUCER", "STAIR NOSINGS", "EDGE STRIP", "TRANSITIONS"]) assert.equal(b4(t), "transition", t);
  for (const t of ["WALL PROTECTION", "CORNERGUARD", "PROTECTIVE RAILS", "BUMPER GUARD"]) assert.equal(b4(t), "wall_protection", t);
  // the " — " between two cells is a word of its own: RUBBER | BASE is not RUBBER BASE, but BASE alone still is base
  assert.equal(b4("RUBBER — BASE"), "base");
  assert.equal(b4("TRANSITION — HANDRAIL"), "none");
});
