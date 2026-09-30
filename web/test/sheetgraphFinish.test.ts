// The sheet graph's finish/material-schedule reader (#472):
// section headings, sparse and header-named columns, the legend beside the
// table, group-label rows, and a marquee crop. Every fixture is synthetic —
// invented codes and vendors, laid out at the scale the MCP server serves the
// bundled demo sheet (text 17 px tall, 38 px row pitch, ~8 px per character).
// The invariants:
//   - a printed section heading is consumed — it is never a row and never
//     lands in a cell — and the rows under it carry TableRow.section;
//   - a material word ("CARPET", "TILE") or a spec-section number is not a
//     section; rows under it carry none;
//   - a column the header names keeps its cells even when only one row fills it;
//   - text to the right of the table (a legend) is not read into it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTable, readFinishTable, buildSheetGraph, type GraphSpan, type ScheduleTable } from "../src/lib/sheetgraph.ts";

// ── fixture builder ─────────────────────────────────────────────────────────
const TH = 17, PITCH = 38;
let CW = 8;   // glyph width, px per character
const sp = (str: string, x: number, y: number, h = TH): GraphSpan => ({ str, x, y, w: str.length * CW, h });
const COLS: Record<string, number> = { KEY: 100, MATERIAL: 220, DESCRIPTION: 220, MANUFACTURER: 520, "MANUF.": 520, STYLE: 760, PRODUCT: 760, COLOR: 1000, SIZE: 1240, REMARKS: 1400 };
type Cells = Partial<Record<string, string>>;
type Item =
  | { t: "row"; key: string; cells: Cells }
  | { t: "head"; text: string; x?: number }
  | { t: "raw"; spans: Array<[string, number]> }
  | { t: "gap"; n: number }
  | { t: "wrap"; col: string; text: string; dx?: number };

function build(o: { key?: string; cols: string[]; title?: string; items: Item[]; align?: "left" | "center"; pre?: Array<Array<[string, number]>>; colX?: Record<string, number> }): GraphSpan[] {
  const X = { ...COLS, ...(o.colX ?? {}) };
  const labels = [o.key ?? "CODE", ...o.cols];
  const xs = [X.KEY, ...o.cols.map((c) => X[c])];
  const colW = xs.map((x, i) => (i + 1 < xs.length ? xs[i + 1] - x : 400));
  const place = (text: string, ci: number, y: number) => (o.align === "center" ? sp(text, xs[ci] + colW[ci] / 2 - (text.length * CW) / 2, y) : sp(text, xs[ci], y));
  const out: GraphSpan[] = [];
  let y = 0;
  for (const line of o.pre ?? []) { for (const [s, x] of line) out.push(sp(s, x, y)); y += PITCH; }
  if (o.title) { out.push(sp(o.title, xs[0], y, 24)); y += PITCH; }
  labels.forEach((l, i) => out.push(place(l, i, y)));
  let lastY = y;
  for (const it of o.items) {
    if (it.t === "gap") { y += PITCH * it.n; continue; }
    if (it.t === "wrap") { const s = place(it.text, labels.indexOf(it.col), lastY + 19); s.x += it.dx ?? 0; out.push(s); continue; }
    y += PITCH;
    if (it.t === "head") out.push(sp(it.text, it.x ?? xs[0], y));
    else if (it.t === "raw") for (const [s, x] of it.spans) out.push(sp(s, x, y));
    else { out.push(place(it.key, 0, y)); o.cols.forEach((c, i) => { const v = it.cells[c]; if (v) out.push(place(v, i + 1, y)); }); }
    lastY = y;
  }
  return out;
}

// invented finish rows: key, material, vendor, style, color, size, remarks
const R = (key: string, mat: string, mfr: string, style = "", color = "", size = "", rem = ""): Item =>
  ({ t: "row", key, cells: { MATERIAL: mat, DESCRIPTION: mat, MANUFACTURER: mfr, "MANUF.": mfr, STYLE: style, PRODUCT: style, COLOR: color, SIZE: size, REMARKS: rem } });
const FLOOR = [R("CPT-1", "BROADLOOM CARPET", "VENDOR-A", "LOOP 20", "GREY 101"), R("CPT-2", "MODULAR CARPET TILE", "VENDOR-A", "GRID 24", "BLUE 202"), R("LVT-1", "LUXURY VINYL TILE", "VENDOR-B", "PLANK 6", "OAK 303", '6" x 36"', "ADHESIVE: VENDOR-K"), R("VCT-1", "VINYL COMPOSITION TILE", "VENDOR-C", "STANDARD", "WHITE 404", '12" x 12"', "ADHESIVE: VENDOR-K"), R("SC-1", "SEALED CONCRETE", "VENDOR-D", "CLEAR COAT", "CLEAR")];
const BASE = [R("RB-1", "RUBBER WALL BASE", "VENDOR-B", "COVE", "BLACK 505", '4"'), R("RB-2", "RESILIENT BASE", "VENDOR-B", "STRAIGHT", "GREY 506", '6"')];
const WALLS = [R("P-1", "PAINT", "VENDOR-E", "EGGSHELL", "WHITE 601"), R("P-2", "PAINT", "VENDOR-E", "SEMI-GLOSS", "TAUPE 602", "", "SEE NOTE 4"), R("CT-1", "CERAMIC WALL TILE", "VENDOR-F", "GLOSS", "WHITE 603", '3" x 6"', "GROUT: VENDOR-K 01 WHITE")];
const CEIL = [R("ACT-1", "ACOUSTICAL CEILING TILE", "VENDOR-G", "FINE FISSURED", "WHITE", "2' x 2'")];
const MILL = [R("PL-1", "PLASTIC LAMINATE", "VENDOR-H", "MATTE", "MAPLE 701")];
const MISC = [R("TS-1", "TRANSITION STRIP", "VENDOR-I", "RAMP", "SATIN"), R("CG-1", "CORNER GUARDS", "VENDOR-J", "SURFACE", "ALMOND"), R("PR-1", "METAL TILE EDGE", "VENDOR-I", "SQUARE", "SATIN")];
const STD = ["MATERIAL", "MANUFACTURER", "STYLE", "COLOR", "SIZE", "REMARKS"];
const H = (text: string, x?: number): Item => ({ t: "head", text, x });
const keysOf = (items: Item[]) => items.flatMap((i) => (i.t === "row" ? [i.key] : []));

const read = (spans: GraphSpan[], marquee = false): ScheduleTable => {
  const t = extractTable({ key: "fx", spans }, "finish", marquee ? { marquee: true } : {});
  assert.ok(t, "a finish table is read");
  return t;
};
const keys = (t: ScheduleTable) => t.rows.map((r) => r.key);
const row = (t: ScheduleTable, k: string) => { const r = t.rows.find((x) => x.key === k); assert.ok(r, `row ${k}`); return r; };
const cell = (t: ScheduleTable, k: string, col: string) => row(t, k).cells[col]?.text;
const allCellText = (t: ScheduleTable) => t.rows.flatMap((r) => Object.values(r.cells).map((c) => c.text));
/** key → section ("" = no section) for every row. */
const sections = (t: ScheduleTable) => Object.fromEntries(t.rows.map((r) => [r.key, r.section ?? ""]));
const expectSections = (pairs: Array<[Item[], string]>) => Object.fromEntries(pairs.flatMap(([items, s]) => keysOf(items).map((k) => [k, s])));
const withCW = <T>(w: number, f: () => T): T => { const prev = CW; CW = w; try { return f(); } finally { CW = prev; } };
const noCellHas = (t: ScheduleTable, ...texts: string[]) => { for (const x of texts) assert.ok(!allCellText(t).some((c) => c.includes(x)), `"${x}" is in no cell`); };

/** none of the given rows has a cell containing any of the texts */
const noCellOf = (t: ScheduleTable, ks: string[], ...texts: string[]) => {
  for (const x of texts) assert.ok(!t.rows.filter((r) => ks.includes(r.key)).some((r) => Object.values(r.cells).some((c) => c.text.includes(x))), `"${x}" is in no cell of ${ks.join(",")}`);
};
/** the row has a cell containing the text */
const rowHas = (t: ScheduleTable, k: string, text: string) => assert.ok(Object.values(row(t, k).cells).some((c) => c.text.includes(text)), `${k} keeps "${text}"`);
/** A fuzz-found fixture: [text, x, y, width]. Tests named "fuzz-found" are
 * minimal tables from a randomized comparison of this reader against the one
 * before #472 (synthetic columns, alignments, headings, legends); each pins a
 * mechanism that keeps this reader from doing worse there. Their texts are
 * the generator's invented words, tagged Qn so no two cells read alike.
 * Width-less fixtures carry no width (legacy tokens). */
const fixture = (widthless: boolean, a: Array<[string, number, number, number?]>): GraphSpan[] =>
  a.map(([str, x, y, w]) => (widthless ? { str, x, y, w: 0, h: TH } : { str, x, y, w: w ?? str.length * CW, h: TH }));

// ── the header row and the columns ──────────────────────────────────────────
test("a general-notes line naming CODES / MATERIALS / COLORED is not taken for the header row", () => {
  const pre: Array<Array<[string, number]>> = [[["GENERAL NOTES", 100]], [["1. VERIFY ALL", 100], ["CODES AND", 400], ["MATERIALS PRIOR", 700], ["TO ORDER. COLORED", 1000]], [["2. SUBMIT SAMPLES.", 100]], [["3. SEE SPECS.", 100]], [["4. COORDINATE.", 100]]];
  const items = [...FLOOR, ...BASE];
  const t = read(build({ cols: STD, items, pre }));
  assert.deepEqual(keys(t), keysOf(items));
  assert.equal(cell(t, "CPT-1", "MATERIAL"), "BROADLOOM CARPET");
  assert.equal(cell(t, "CPT-1", "MANUFACTURER"), "VENDOR-A");
});

test("an abbreviated header (MANUF.) names its column once the row qualifies", () => {
  const items = [...FLOOR, ...BASE];
  const t = read(build({ key: "TAG", cols: ["MATERIAL", "MANUF.", "STYLE", "COLOR", "REMARKS"], items }));
  assert.deepEqual(t.headers, ["TAG", "MATERIAL", "MANUFACTURER", "STYLE", "COLOR", "REMARKS"]);
  assert.deepEqual(keys(t), keysOf(items));
  assert.equal(cell(t, "CPT-1", "MATERIAL"), "BROADLOOM CARPET");
  assert.equal(cell(t, "CPT-1", "MANUFACTURER"), "VENDOR-A");
  assert.equal(cell(t, "RB-1", "MANUFACTURER"), "VENDOR-B");
});

test("abbreviated headers name columns in finish tables only: an equipment table reads as before", () => {
  // DESCRIP. and MANUF. name no equipment column; the reading is pinned to
  // what the reader gave before finish headers learned abbreviations
  const hdr: Array<[string, number]> = [["MARK", 100], ["DESCRIP.", 220], ["MANUF.", 520], ["MODEL", 760], ["CFM", 1000], ["REMARKS", 1200]];
  const spans: GraphSpan[] = hdr.map(([l, x]) => sp(l, x, 0));
  const data = [["EF-1", "EXHAUST FAN", "VENDOR-A", "X100", "200", ""], ["EF-2", "EXHAUST FAN", "VENDOR-A", "X200", "400", "ROOF"], ["SF-1", "SUPPLY FAN", "VENDOR-B", "S10", "800", ""]];
  data.forEach((r, i) => r.forEach((v, j) => { if (v) spans.push(sp(v, hdr[j][1], PITCH * (i + 1))); }));
  const t = extractTable({ key: "fx", spans }, "equipment");
  assert.ok(t);
  assert.deepEqual(t.headers, ["MARK", "MODEL", "CFM", "REMARKS"]);
  assert.deepEqual(Object.fromEntries(t.rows.map((r) => [r.key, Object.fromEntries(Object.entries(r.cells).map(([k, c]) => [k, c.text]))])), {
    "EF-1": { MARK: "EF-1 EXHAUST FAN", MODEL: "VENDOR-A X100", CFM: "200" },
    "EF-2": { MARK: "EF-2 EXHAUST FAN", MODEL: "VENDOR-A X200", CFM: "400", REMARKS: "ROOF" },
    "SF-1": { MARK: "SF-1 SUPPLY FAN", MODEL: "VENDOR-B S10", CFM: "800" },
  });
});

test("a sparse column the header names keeps its cells (SIZE in 2 of 30 rows)", () => {
  const items: Item[] = [];
  for (let i = 1; i <= 30; i++) items.push(R(`CPT-${i}`, "CARPET TILE", "VENDOR-A", "LOOP", "GREY", i === 4 || i === 18 ? '24" x 24"' : ""));
  const t = read(build({ cols: STD, items }));
  assert.deepEqual(keys(t), keysOf(items));
  for (const k of ["CPT-4", "CPT-18"]) {
    assert.equal(cell(t, k, "SIZE"), '24" x 24"');
    assert.equal(cell(t, k, "COLOR"), "GREY");
    assert.equal(cell(t, k, "REMARKS"), undefined);
  }
});

test("a single REMARKS cell stays in REMARKS (1 of 11 rows)", () => {
  const items = [R("CPT-1", "BROADLOOM CARPET", "VENDOR-A", "LOOP 20", "GREY 101"), R("CPT-2", "MODULAR CARPET TILE", "VENDOR-A", "GRID 24", "BLUE 202"), R("VCT-1", "VINYL COMPOSITION TILE", "VENDOR-C", "STANDARD", "WHITE 404", '12" x 12"'), ...BASE, WALLS[0], WALLS[2], ...CEIL, ...MILL, MISC[0], MISC[1]];
  const t = read(build({ cols: STD, items }));
  assert.deepEqual(keys(t), keysOf(items));
  assert.equal(cell(t, "CT-1", "REMARKS"), "GROUT: VENDOR-K 01 WHITE");
  assert.equal(cell(t, "CT-1", "SIZE"), '3" x 6"');
  assert.equal(t.rows.filter((r) => r.cells.REMARKS).length, 1);
});

test("a legend block to the right of REMARKS is not read into the table", () => {
  const legend: Array<[string, string]> = [["LEGEND", ""], ["CPT", "CARPET"], ["LVT", "LUXURY VINYL"], ["VCT", "VINYL TILE"], ["RB", "RUBBER BASE"], ["P", "PAINT"], ["CT", "CERAMIC TILE"], ["ACT", "ACOUSTIC TILE"]];
  const items = [...FLOOR, ...BASE, ...WALLS];
  const spans = build({ cols: STD, items });
  legend.forEach(([a, b], i) => { spans.push(sp(a, 1680, PITCH * (i + 1))); if (b) spans.push(sp(b, 1740, PITCH * (i + 1))); });
  const t = read(spans);
  assert.deepEqual(keys(t), keysOf(items));
  assert.equal(cell(t, "CT-1", "REMARKS"), "GROUT: VENDOR-K 01 WHITE");
  assert.equal(cell(t, "P-1", "REMARKS"), undefined);
  assert.ok(!allCellText(t).some((s) => /LEGEND|ACOUSTIC TILE|LUXURY VINYL$/.test(s)), "no legend text in any cell");
  assert.ok(t.region[2] < 1680, "the region stops short of the legend");
});

test("a rotated header row qualifies on whole words too (COLORED names no column)", () => {
  const vsp = (str: string, x: number): GraphSpan => ({ str, x, y: 0, w: TH, h: str.length * CW, rot: 90 });
  const rotated = (third: string): GraphSpan[] => {
    const out = [vsp("CODE", 100), vsp("MATERIAL", 220), vsp(third, 520)];
    ["CPT-1", "CPT-2", "RB-1"].forEach((k, i) => { const y = 100 + PITCH * i; out.push(sp(k, 100, y), sp("CARPET", 220, y), sp("GREY", 520, y)); });
    return out;
  };
  const t = extractTable({ key: "fx", spans: rotated("COLOR") }, "finish");
  assert.ok(t && t.rotated_headers, "CODE / MATERIAL / COLOR reads as a rotated header");
  assert.deepEqual(keys(t), ["CPT-1", "CPT-2", "RB-1"]);
  assert.equal(extractTable({ key: "fx", spans: rotated("COLORED") }, "finish"), null);
});

test("a last column whose header is outside the vocabulary is not capped away as a legend", () => {
  // LOCATION names no column this reader knows, so its cells band into COLOR
  // beside it — as they did before the legend cap (the stated limit). The
  // header over them says they are the table's, so they are not dropped.
  const hdr: Array<[string, number]> = [["CODE", 100], ["MATERIAL", 220], ["MANUFACTURER", 520], ["COLOR", 1000], ["LOCATION", 1200]];
  const spans: GraphSpan[] = hdr.map(([l, x]) => sp(l, x, 0));
  const locs = ["CORRIDORS", "ALL OFFICES", "LOBBY", "CORRIDORS", "RESTROOMS", "BREAK ROOM", "ALL OFFICES", "STAIRS"];
  const ks = ["CPT-1", "CPT-2", "LVT-1", "VCT-1", "RB-1", "RB-2", "P-1", "P-2"];
  ks.forEach((k, i) => { const y = PITCH * (i + 1); spans.push(sp(k, 100, y), sp(`MAT ${i}`, 220, y), sp("VENDOR-A", 520, y), sp(`GREY ${i}`, 1000, y), sp(locs[i], 1200, y)); });
  const t = read(spans);
  assert.deepEqual(keys(t), ks);
  assert.deepEqual(t.headers, ["CODE", "MATERIAL", "MANUFACTURER", "COLOR"]);
  ks.forEach((k, i) => assert.equal(cell(t, k, "COLOR"), `GREY ${i} ${locs[i]}`, k));
  assert.ok(t.region[2] >= 1200 + "ALL OFFICES".length * CW, "the region reaches the LOCATION column");
});

test("narrow neighboring columns with real text widths stay apart", () => {
  // SIZE starts 70 px right of COLOR: closer than five text heights, which
  // merges width-less continuation words — never measured text
  const items = [...FLOOR, ...BASE, ...WALLS];
  const t = read(build({ cols: STD, colX: { SIZE: 1070, REMARKS: 1250 }, items }));
  assert.deepEqual(t.headers, ["CODE", ...STD]);
  assert.equal(cell(t, "LVT-1", "COLOR"), "OAK 303");
  assert.equal(cell(t, "LVT-1", "SIZE"), '6" x 36"');
});

test("a continuation sheet with no header row of its own is not capped", () => {
  // the continuation adopts the base table's columns but has no header row to
  // say whether text right of COLOR is a legend or a column — so nothing is
  // cut, and LOCATION reads into COLOR exactly as it does on the base sheet
  const hdr: Array<[string, number]> = [["CODE", 100], ["MATERIAL", 220], ["MANUFACTURER", 520], ["COLOR", 1000], ["LOCATION", 1200]];
  const rowsAt = (ks: string[], y0: number): GraphSpan[] => ks.flatMap((k, i) => { const y = y0 + PITCH * i; return [sp(k, 100, y), sp(`MAT ${k}`, 220, y), sp("VENDOR-A", 520, y), sp(`GREY ${i}`, 1000, y), sp(`ROOM ${k}`, 1200, y)]; });
  const base = [sp("MATERIAL SCHEDULE", 100, 0, 24), ...hdr.map(([l, x]) => sp(l, x, PITCH)), ...rowsAt(["CPT-1", "CPT-2", "LVT-1", "VCT-1"], 2 * PITCH)];
  const cont = [sp("MATERIAL SCHEDULE (CONT'D)", 100, 0, 24), ...rowsAt(["RB-1", "RB-2", "P-1", "P-2"], 2 * PITCH)];
  const g = buildSheetGraph([{ key: "a.pdf#1", spans: base }, { key: "a.pdf#2", spans: cont }]);
  const t = g.tables.find((x) => x.kind === "finish");
  assert.ok(t);
  assert.deepEqual(keys(t), ["CPT-1", "CPT-2", "LVT-1", "VCT-1", "RB-1", "RB-2", "P-1", "P-2"]);
  assert.equal(cell(t, "CPT-1", "COLOR"), "GREY 0 ROOM CPT-1");
  assert.equal(cell(t, "P-2", "COLOR"), "GREY 3 ROOM P-2");
});

test("width-less input: a cell's second word is not a column of its own", () => {
  // legacy text tokens carry no width, one token per word: "BROADLOOM" at the
  // column start and "CARPET" further right, in every row
  const words = (s: string, x: number, y: number): GraphSpan[] => { const out: GraphSpan[] = []; let at = x; for (const w of s.split(" ")) { out.push({ str: w, x: at, y, w: 0, h: TH }); at += (w.length + 1) * CW; } return out; };
  const spans: GraphSpan[] = [];
  ["CODE", "MATERIAL", "MANUFACTURER", "COLOR", "REMARKS"].forEach((l, i) => spans.push({ str: l, x: [100, 220, 520, 760, 1000][i], y: 0, w: 0, h: TH }));
  const data: Array<[string, string, string, string]> = [["CPT-1", "BROADLOOM CARPET", "VENDOR-A", "GREY 101"], ["CPT-2", "MODULAR CARPET TILE", "VENDOR-A", "BLUE 202"], ["LVT-1", "LUXURY VINYL TILE", "VENDOR-B", "OAK 303"], ["VCT-1", "VINYL COMPOSITION TILE", "VENDOR-C", "WHITE 404"], ["RB-1", "RUBBER WALL BASE", "VENDOR-B", "BLACK 505"], ["RB-2", "RESILIENT BASE", "VENDOR-B", "GREY 506"], ["P-1", "PAINT", "VENDOR-E", "WHITE 601"], ["CT-1", "CERAMIC WALL TILE", "VENDOR-F", "WHITE 603"]];
  data.forEach(([k, m, v, c], i) => { const y = PITCH * (i + 1); spans.push({ str: k, x: 100, y, w: 0, h: TH }, ...words(m, 220, y), ...words(v, 520, y), ...words(c, 760, y)); });
  spans.push({ str: "SEE NOTE 1", x: 1000, y: PITCH * 3, w: 0, h: TH });
  const t = read(spans);
  assert.deepEqual(keys(t), data.map((d) => d[0]));
  for (const [k, m, v, c] of data) {
    assert.equal(cell(t, k, "MATERIAL"), m, k);
    assert.equal(cell(t, k, "MANUFACTURER"), v, k);
    assert.equal(cell(t, k, "COLOR"), c, k);
  }
  assert.equal(cell(t, "LVT-1", "REMARKS"), "SEE NOTE 1");
});

test("an empty REMARKS column does not scatter a short left-set table (5 rows)", () => {
  const hdr: Array<[string, number]> = [["CODE", 100], ["MATERIAL", 220], ["MANUFACTURER", 520], ["COLOR", 760], ["REMARKS", 1000]];
  const data = [["CPT-1", "BROADLOOM CARPET", "VENDOR-A", "GREY 101"], ["CPT-2", "CARPET TILE", "VENDOR-A", "BLUE"], ["LVT-1", "LUXURY VINYL TILE", "VENDOR-B", "OAK 303"], ["VCT-1", "VCT", "VENDOR-C", "WHITE 404"], ["RB-1", "RUBBER WALL BASE", "VENDOR-B", "BLACK"]];
  const spans = hdr.map(([l, x]) => sp(l, x, 0));
  data.forEach((r, i) => r.forEach((v, j) => spans.push(sp(v, hdr[j][1], PITCH * (i + 1)))));
  const t = read(spans);
  assert.deepEqual(keys(t), data.map((d) => d[0]));
  for (const [k, m, v, c] of data) {
    assert.equal(cell(t, k, "MATERIAL"), m, k);
    assert.equal(cell(t, k, "MANUFACTURER"), v, k);
    assert.equal(cell(t, k, "COLOR"), c, k);
    assert.equal(cell(t, k, "REMARKS"), undefined, k);
  }
});

test("a two-line header over a column outside the vocabulary is not capped away as a legend", () => {
  // INSTALL / LOCATION set as two lines straddling the header row: its cells
  // band into COLOR beside them, as they did before the legend cap
  for (const twoLine of [true, false]) {
    const spans = build({ cols: ["MATERIAL", "MANUFACTURER", "COLOR"], items: [...FLOOR, ...BASE] });
    if (twoLine) spans.push(sp("INSTALL", 1250, -10), sp("LOCATION", 1250, 10)); else spans.push(sp("LOCATION", 1250, 0));
    const ks = [...keysOf(FLOOR), ...keysOf(BASE)];
    ks.forEach((k, i) => spans.push(sp(`ROOM ${k}`, 1250, PITCH * (i + 1))));
    const t = read(spans);
    assert.deepEqual(keys(t), ks);
    for (const k of ks) assert.ok(cell(t, k, "COLOR")!.endsWith(`ROOM ${k}`), `${k} keeps its LOCATION text (two-line ${twoLine})`);
  }
});

test("a column named only in the tier above the header row is not capped away as a legend", () => {
  const spans = [sp("FINISH", 400, -2 * PITCH), sp("LOCATION", 1250, -PITCH), sp("CODE", 100, 0), sp("MATERIAL", 220, 0), sp("MANUFACTURER", 520, 0), sp("COLOR", 1000, 0)];
  const ks = ["CPT-1", "CPT-2", "LVT-1", "RB-1", "P-1"];
  ks.forEach((k, i) => { const y = PITCH * (i + 1); spans.push(sp(k, 100, y), sp(`MAT ${k}`, 220, y), sp("VENDOR-A", 520, y), sp("GREY", 1000, y), sp(`ROOM ${k}`, 1250, y)); });
  const t = read(spans);
  assert.deepEqual(keys(t), ks);
  for (const k of ks) assert.equal(cell(t, k, "COLOR"), `GREY ROOM ${k}`);
});

test("a centered header outside the vocabulary heads cells that start left of it", () => {
  // LOCATION is centered over its column; its cells start at the column's
  // left edge, left of the header's text — still its column, not a legend
  const spans = [sp("CODE", 100, 0), sp("MATERIAL", 220, 0), sp("MANUFACTURER", 520, 0), sp("COLOR", 1000, 0), sp("LOCATION", 1310, 0)];
  const ks = ["CPT-1", "CPT-2", "LVT-1", "VCT-1", "RB-1", "RB-2"];
  ks.forEach((k, i) => { const y = PITCH * (i + 1); spans.push(sp(k, 100, y), sp(`MAT ${i}`, 220, y), sp("VENDOR-A", 520, y), sp(`GREY ${i}`, 1000, y), sp(`ROOM ${k}`, 1250, y)); });
  const t = read(spans);
  assert.deepEqual(keys(t), ks);
  ks.forEach((k, i) => assert.equal(cell(t, k, "COLOR"), `GREY ${i} ROOM ${k}`));
});

test("a legend's own title set just above the header row does not head the legend", () => {
  const legend: Array<[string, string]> = [["CPT", "CARPET"], ["LVT", "LUXURY VINYL"], ["VCT", "VINYL TILE"], ["RB", "RUBBER BASE"], ["P", "PAINT"], ["CT", "CERAMIC TILE"], ["ACT", "ACOUSTIC TILE"]];
  const items = [...FLOOR, ...BASE, ...WALLS];
  const spans = build({ cols: STD, items });
  spans.push(sp("ABBREVIATIONS", 1680, -20));
  legend.forEach(([a, b], i) => { spans.push(sp(a, 1680, PITCH * (i + 1))); spans.push(sp(b, 1740, PITCH * (i + 1))); });
  const t = read(spans);
  assert.deepEqual(keys(t), keysOf(items));
  assert.equal(cell(t, "CT-1", "REMARKS"), "GROUT: VENDOR-K 01 WHITE");
  noCellOf(t, keys(t), "ACOUSTIC TILE", "RUBBER BASE", "CERAMIC TILE");
});

test("width-less input: a legend beside REMARKS is not read into the table", () => {
  const legend: Array<[string, string]> = [["CPT", "CARPET"], ["LVT", "LUXURY VINYL"], ["VCT", "VINYL TILE"], ["RB", "RUBBER BASE"], ["P", "PAINT"], ["CT", "CERAMIC TILE"], ["ACT", "ACOUSTIC TILE"]];
  const items = [...FLOOR, ...BASE, ...WALLS];
  const spans = build({ cols: STD, items });
  legend.forEach(([a, b], i) => { spans.push(sp(a, 1760, PITCH * (i + 1))); spans.push(sp(b, 1820, PITCH * (i + 1))); });
  const t = read(spans.map((s) => ({ ...s, w: 0 })));
  assert.deepEqual(keys(t), keysOf(items));
  assert.equal(cell(t, "CT-1", "REMARKS"), "GROUT: VENDOR-K 01 WHITE");
  noCellOf(t, keys(t), "ACOUSTIC TILE", "RUBBER BASE", "CERAMIC TILE");
});

test("a row of abbreviation-like words under the header is not a lower header tier", () => {
  // PATTERNED / STYLED / PRODUCTS / COMMENTARY each start like a header word
  // ("PATTE…", "STYLE…"): they name columns only in a row that already
  // qualifies on whole words, and never make a row the header's lower tier
  const spans = [sp("CODE", 100, 0), sp("MATERIAL", 220, 0), sp("COLOR", 520, 0), sp("PATTERNED", 220, PITCH), sp("STYLED", 400, PITCH), sp("PRODUCTS", 520, PITCH), sp("COMMENTARY", 700, PITCH)];
  const ks = ["CPT-1", "CPT-2", "RB-1", "P-1"];
  ks.forEach((k, i) => { const y = PITCH * (i + 3); spans.push(sp(k, 100, y), sp(`MAT ${i}`, 220, y), sp(`GREY ${i}`, 520, y)); });
  const t = read(spans);
  assert.deepEqual(t.headers, ["CODE", "MATERIAL", "COLOR"]);
  assert.deepEqual(keys(t), ks);
  ks.forEach((k, i) => assert.equal(cell(t, k, "COLOR"), `GREY ${i}`));
});

test("width-less input: a room-finish table reads as before (the continuation-word rule is the finish reader's)", () => {
  // NAME's header stands right of the names' first words; the room-finish
  // reader keeps its own reading of that, word for word
  const words = (s: string, x: number, y: number): GraphSpan[] => { const out: GraphSpan[] = []; let at = x; for (const w of s.split(" ")) { out.push({ str: w, x: at, y, w: 0, h: TH }); at += (w.length + 1) * CW; } return out; };
  const spans: GraphSpan[] = [["ROOM", 100], ["NAME", 180], ["FLOOR", 400], ["BASE", 520], ["WALLS", 640], ["CEILING", 760]].map(([l, x]) => ({ str: l as string, x: x as number, y: 0, w: 0, h: TH }));
  const rooms = [["101", "OPEN OFFICE"], ["102", "CONF ROOM"], ["103", "BREAK ROOM"], ["104", "MAIN LOBBY"], ["105", "WOMEN TOILET"], ["106", "MEN TOILET"]];
  rooms.forEach(([k, n], i) => { const y = PITCH * (i + 1); spans.push({ str: k, x: 100, y, w: 0, h: TH }, ...words(n, 160, y), ...words("CPT-1", 400, y), ...words("RB-1", 520, y), ...words("P-1", 640, y), ...words("ACT-1", 760, y)); });
  const t = extractTable({ key: "fx", spans }, "room-finish");
  assert.ok(t);
  assert.deepEqual(t.rows.map((r) => r.key), rooms.map((r) => r[0]));
  assert.equal(t.rows[0].cells.NAME?.text, "OPEN");
  assert.equal(t.rows[0].cells.FLOOR?.text, "OFFICE CPT-1");
  assert.equal(t.rows[0].cells.ROOM?.text, "101");
});

test("fuzz-found: a legend beside a sparse last column is not read into it", () => {
  // DESCRIPTION prints one cell; the legend lines sit well right of it
  const t = read(fixture(false, [["CODE",100,0,32],["PRODUCT",217,0,56],["MATERIAL",488,0,64],["DESCRIPTION",652,0,88],["RB-6",100,38,32],["12 x 12 Q1",217,38,80],["VENDOR-B CO Q2",488,38,112],["TILE Q3",652,38,56],["ACT-10",100,76,48],["X1-2",100,114,32],["SHADE Z2",217,114,64],["WC-8",100,152,32],["VINYL PLANK Q4",217,152,112],["BROADLOOM CARPET Q5",488,152,152],["CPT",938,76,24],["CARPET LGA",998,76,80],["RB",938,114,16],["RESILIENT LGB",998,114,104],["P",938,152,8],["PAINT LGC",998,152,72],["LVT",938,190,24],["LUXURY LGD",998,190,80]]));
  assert.deepEqual(keys(t).filter((k) => ["RB-6","ACT-10","WC-8"].includes(k)), ["RB-6","ACT-10","WC-8"]);
  assert.equal(cell(t, "RB-6", "PRODUCT"), "12 x 12 Q1");
  assert.equal(cell(t, "RB-6", "MATERIAL"), "VENDOR-B CO Q2");
  assert.equal(cell(t, "RB-6", "DESCRIPTION"), "TILE Q3");
  assert.equal(cell(t, "WC-8", "PRODUCT"), "VINYL PLANK Q4");
  assert.equal(cell(t, "WC-8", "MATERIAL"), "BROADLOOM CARPET Q5");
  noCellOf(t, ["RB-6","ACT-10","WC-8"], "CARPET LGA", "RESILIENT LGB", "PAINT LGC", "LUXURY LGD");
});

test("fuzz-found, width-less: a last column's words past its narrow header are not a legend", () => {
  // MANUFACTURER's cells start left of its header and run on past it; the cap needs half a column pitch of clearance
  const t = read(fixture(true, [["SYMBOL",152,0],["MATERIAL",370,0],["COMMENTS",674,0],["MANUFACTURER",884.5,0],["WALL",100,38],["FINISHES",140,38],["VCT-6",100,76],["ADHESIVE:",252,76],["VENDOR-K",332,76],["Q1",404,76],["MATTE",860,76],["FINISH",908,76],["Q2",964,76],["C-2",100,114],["ADHESIVE:",252,114],["VENDOR-K",332,114],["Q3",404,114],["VENDOR-B",860,114],["CO",932,114],["Q4",956,114]]));
  assert.deepEqual(keys(t).filter((k) => ["VCT-6","C-2"].includes(k)), ["VCT-6","C-2"]);
  assert.equal(cell(t, "VCT-6", "MANUFACTURER"), "MATTE FINISH Q2");
  assert.equal(cell(t, "C-2", "MANUFACTURER"), "VENDOR-B CO Q4");
  noCellOf(t, ["VCT-6","C-2"], "WALL FINISHES");
});

test("fuzz-found, width-less: a cell's later words never start the next column", () => {
  // each cell's second and third word sits under the next header's text
  const t = read(fixture(true, [["MARK",100,0],["MANUFACTURER",208,0],["MATERIAL",483,0],["SPECIFICATION",373.5,-46],["P-5",100,46],["OAK",208,46],["303",240,46],["Q1",272,46],["GREY",483,46],["Q2",523,46],["T",100,92],["CARPET",208,92],["Q3",264,92],["12",483,92],["x",507,92],["12",523,92],["Q4",547,92]]));
  assert.deepEqual(keys(t).filter((k) => ["P-5","T"].includes(k)), ["P-5","T"]);
  assert.equal(cell(t, "P-5", "MANUFACTURER"), "OAK 303 Q1");
  assert.equal(cell(t, "P-5", "MATERIAL"), "GREY Q2");
  assert.equal(cell(t, "T", "MANUFACTURER"), "CARPET Q3");
  assert.equal(cell(t, "T", "MATERIAL"), "12 x 12 Q4");
});

test("fuzz-found: a column that prints no cell starts at its header", () => {
  // COMMENTS is empty; without a start for it the table loses its map
  const t = read(fixture(false, [["SYMBOL",129.5,0,48],["PRODUCT",337,0,56],["COMMENTS",556,0,64],["TRANSITIONS",332.5,30,88],["LVT-2",100,60,40],["VENDOR-A Q1",207,60,88],["WALLS",356.5,90,40],["C7",100,120,16],["VCT-10",100,150,48],["PT-8",100,180,32],["EGGSHELL Q2",207,180,88],["LVT-6",100,210,40],["VENDOR-A Q3",207,210,88],["C-5",100,240,24]]));
  assert.deepEqual(keys(t).filter((k) => ["LVT-2","C7","VCT-10","PT-8","LVT-6","C-5"].includes(k)), ["LVT-2","C7","VCT-10","PT-8","LVT-6","C-5"]);
  assert.equal(cell(t, "LVT-2", "PRODUCT"), "VENDOR-A Q1");
  assert.equal(cell(t, "PT-8", "PRODUCT"), "EGGSHELL Q2");
  assert.equal(cell(t, "LVT-6", "PRODUCT"), "VENDOR-A Q3");
  noCellOf(t, ["LVT-2","C7","VCT-10","PT-8","LVT-6","C-5"], "TRANSITIONS", "WALLS");
});

test("fuzz-found, width-less: a header owning only run-on words starts its column at the header", () => {
  // the headers sit over their columns' left edges (CODE over the keys)
  const t = read(fixture(true, [["CODE",156.5,0],["STYLE",408.5,0],["WIDTH",666.5,0],["REMARKS",884,0],["C",168.5,38],["CARPET",876,38],["Q1",932,38],["PT-5",156.5,76],["12",388.5,76],["x",412.5,76],["12",428.5,76],["Q2",452.5,76],["LVT-7",152.5,114],["MATTE",368.5,114],["FINISH",416.5,114],["Q3",472.5,114],["P6",164.5,152],["PAINT",396.5,152],["Q4",444.5,152],["RB-10",152.5,190],["12",388.5,190],["x",412.5,190],["12",428.5,190],["Q5",452.5,190],["VENDOR-B",856,190],["CO",928,190],["Q6",952,190],["CPT-8",152.5,228],["GREY",400.5,228],["Q7",440.5,228],["ACT-2",152.5,266],["SEE",376.5,266],["NOTE",408.5,266],["2",448.5,266],["Q8",464.5,266]]));
  assert.deepEqual(keys(t).filter((k) => ["C","PT-5","LVT-7","P6","RB-10","CPT-8","ACT-2"].includes(k)), ["C","PT-5","LVT-7","P6","RB-10","CPT-8","ACT-2"]);
  assert.equal(cell(t, "PT-5", "STYLE"), "12 x 12 Q2");
  assert.equal(cell(t, "LVT-7", "STYLE"), "MATTE FINISH Q3");
  assert.equal(cell(t, "P6", "STYLE"), "PAINT Q4");
  assert.equal(cell(t, "CPT-8", "STYLE"), "GREY Q7");
  assert.equal(cell(t, "ACT-2", "STYLE"), "SEE NOTE 2 Q8");
});

test("fuzz-found: a one-cell column is rescued and the table keeps its map", () => {
  // MANUFACTURER prints one cell; centered headings sit over it
  const t = read(fixture(false, [["SYMBOL",142.5,0,48],["MATERIAL",348.5,0,64],["MANUFACTURER",645,0,96],["WALL BASE",443,46,72],["ACT11",100,92,40],["RUBBER COVE Q1",233,92,112],["LVT11",100,138,40],["VENDOR-B CO Q2",528,138,112],["PT-3",100,184,32],["TILE Q3",233,184,56],["WALL BASE",443,230,72],["CPT-11",100,276,48],["BROADLOOM CARPET Q4",233,276,152],["LVT-1",100,322,40],["P-11",100,368,32],["PAINT Q5",233,368,64],["SS",100,414,16],["CARPET Q6",233,414,72],["CPT11",100,460,40],["GREY Q7",233,460,56]]));
  assert.deepEqual(keys(t).filter((k) => ["ACT11","LVT11","PT-3","CPT-11","LVT-1","P-11","SS","CPT11"].includes(k)), ["ACT11","LVT11","PT-3","CPT-11","LVT-1","P-11","SS","CPT11"]);
  assert.equal(cell(t, "ACT11", "MATERIAL"), "RUBBER COVE Q1");
  assert.equal(cell(t, "LVT11", "MANUFACTURER"), "VENDOR-B CO Q2");
  assert.equal(cell(t, "PT-3", "MATERIAL"), "TILE Q3");
  assert.equal(cell(t, "CPT-11", "MATERIAL"), "BROADLOOM CARPET Q4");
  assert.equal(cell(t, "P-11", "MATERIAL"), "PAINT Q5");
  assert.equal(cell(t, "SS", "MATERIAL"), "CARPET Q6");
  assert.equal(cell(t, "CPT11", "MATERIAL"), "GREY Q7");
  noCellOf(t, ["ACT11","LVT11","PT-3","CPT-11","LVT-1","P-11","SS","CPT11"], "WALL BASE", "WALL BASE");
});

test("fuzz-found: a column named only above the header row blocks the rescue", () => {
  // LOCATION heads its cells from the tier above; they band into a neighbor as they would with no map
  const t = read(fixture(false, [["SYMBOL",100,0,48],["COMMENTS",229,0,64],["LOCATION",375,-30,64],["REMARKS",595,0,56],["SPECIFICATION",538,-30,104],["VCT9",100,30,32],["BLUE 202 Q1",375,30,88],["RUBBER COVE Q2",595,30,112],["ACT-12",100,60,48],["X Q3",375,60,32],["12 x 12 Q4",595,60,80]]));
  assert.deepEqual(keys(t).filter((k) => ["VCT9","ACT-12"].includes(k)), ["VCT9","ACT-12"]);
  assert.equal(cell(t, "VCT9", "REMARKS"), "RUBBER COVE Q2");
  assert.equal(cell(t, "ACT-12", "REMARKS"), "12 x 12 Q4");
  rowHas(t, "VCT9", "BLUE 202 Q1");
  rowHas(t, "ACT-12", "X Q3");
});

test("fuzz-found: a map completed by a rescue must sit under its headers", () => {
  // centered cells under left-set headers cluster by accident; the reader falls back
  const t = read(fixture(false, [["SYMBOL",100,0,48],["DESCRIPTION",196,0,88],["SIZE",347,0,32],["BASIS OF",347,-23,64],["COMMENTS",473,0,64],["PT-12",128,46,40],["CARPET Q1",374,46,72],["ADHESIVE: VENDOR-K Q2",530,46,168],["VCT-1",128,92,40],["RUBBER COVE Q3",215.5,92,112],["OAK 303 Q4",370,92,80],["EGGSHELL Q5",570,92,88],["VCT-6",128,138,40],["GREY Q6",243.5,138,56],["EGGSHELL Q8",570,138,88],["LVT-10",124,184,48],["MATTE FINISH Q9",211.5,184,120],["VENDOR-A Q10",362,184,96],["EGGSHELL Q11",566,184,96],["C",144,230,8],["TILE Q12",239.5,230,64],["TILE Q14",582,230,64],["P-5",136,276,24],["RUBBER COVE Q15",211.5,276,120],["BLUE 202 Q16",362,276,96],["VENDOR-B CO Q17",554,276,120],["SS",140,322,16],["12 x 12 Q18",227.5,322,88],["VENDOR-B CO Q19",554,322,120],["ACT-3",128,368,40],["VENDOR-A Q20",223.5,368,96],["VENDOR-A Q21",566,368,96]]));
  assert.deepEqual(keys(t).filter((k) => ["PT-12","VCT-1","VCT-6","LVT-10","C","P-5","SS","ACT-3"].includes(k)), ["PT-12","VCT-1","VCT-6","LVT-10","C","P-5","SS","ACT-3"]);
  assert.equal(cell(t, "PT-12", "SIZE"), "CARPET Q1");
  assert.equal(cell(t, "PT-12", "COMMENTS"), "ADHESIVE: VENDOR-K Q2");
  assert.equal(cell(t, "VCT-1", "DESCRIPTION"), "RUBBER COVE Q3");
  assert.equal(cell(t, "VCT-1", "SIZE"), "OAK 303 Q4");
  assert.equal(cell(t, "VCT-1", "COMMENTS"), "EGGSHELL Q5");
  assert.equal(cell(t, "VCT-6", "DESCRIPTION"), "GREY Q6");
  assert.equal(cell(t, "VCT-6", "COMMENTS"), "EGGSHELL Q8");
  assert.equal(cell(t, "LVT-10", "DESCRIPTION"), "MATTE FINISH Q9");
  assert.equal(cell(t, "LVT-10", "SIZE"), "VENDOR-A Q10");
  assert.equal(cell(t, "LVT-10", "COMMENTS"), "EGGSHELL Q11");
  assert.equal(cell(t, "C", "DESCRIPTION"), "TILE Q12");
  assert.equal(cell(t, "C", "COMMENTS"), "TILE Q14");
  assert.equal(cell(t, "P-5", "DESCRIPTION"), "RUBBER COVE Q15");
  assert.equal(cell(t, "P-5", "SIZE"), "BLUE 202 Q16");
  assert.equal(cell(t, "P-5", "COMMENTS"), "VENDOR-B CO Q17");
  assert.equal(cell(t, "SS", "DESCRIPTION"), "12 x 12 Q18");
  assert.equal(cell(t, "SS", "COMMENTS"), "VENDOR-B CO Q19");
  assert.equal(cell(t, "ACT-3", "DESCRIPTION"), "VENDOR-A Q20");
  assert.equal(cell(t, "ACT-3", "COMMENTS"), "VENDOR-A Q21");
});

test("fuzz-found: a rescued column's cells count toward the map's fit", () => {
  // MANUFACTURER prints one cell; without it on a start the map falls short of the fit and the table falls back
  const t = read(fixture(false, [["MARK",134.5,0,32],["MANUFACTURER",299,0,96],["REMARKS",578,0,56],["PT-3",100,30,32],["PAINT Q1",493,30,64],["VCT-6",100,60,40],["ACT-1",100,90,40],["X Q2",201,90,32],["LVT-3",100,120,40]]));
  assert.deepEqual(keys(t).filter((k) => ["PT-3","VCT-6","ACT-1","LVT-3"].includes(k)), ["PT-3","VCT-6","ACT-1","LVT-3"]);
  assert.equal(cell(t, "PT-3", "REMARKS"), "PAINT Q1");
  assert.equal(cell(t, "ACT-1", "MANUFACTURER"), "X Q2");
});

test("fuzz-found: a column is rescued only on the left-edge map", () => {
  // a centred cell's centre is not a column start
  const t = read(fixture(false, [["CODE",100,0,32],["MATERIAL",217,0,64],["BASIS OF",217,-23,64],["DESCRIPTION",495,0,88],["FLOORING",100,46,64],["T-8",100,92,24],["WALL FINISHES",100,138,104],["PT-1",100,184,32],["PT12",100,230,32],["VCT-10",100,276,48],["SS-2",100,322,32],["T",100,368,8],["BROADLOOM CARPET Q1",217,368,152],["VCT-6",100,414,40],["WALLS",100,460,40],["P-7",100,506,24],["CEILINGS",100,552,64],["WC-12",100,598,40],["RUBBER COVE Q2",217,598,112],["C-6",100,644,24],["CPT",830,46,24],["CARPET LGA",890,46,80],["RB",830,92,16],["RESILIENT LGB",890,92,104]]));
  assert.deepEqual(keys(t).filter((k) => ["T-8","PT-1","PT12","VCT-10","SS-2","T","VCT-6","P-7","WC-12","C-6"].includes(k)), ["T-8","PT-1","PT12","VCT-10","SS-2","T","VCT-6","P-7","WC-12","C-6"]);
  assert.equal(cell(t, "T", "MATERIAL"), "BROADLOOM CARPET Q1");
  assert.equal(cell(t, "WC-12", "MATERIAL"), "RUBBER COVE Q2");
  noCellOf(t, ["T-8","PT-1","PT12","VCT-10","SS-2","T","VCT-6","P-7","WC-12","C-6"], "FLOORING", "WALL FINISHES", "WALLS", "CEILINGS", "CARPET LGA");
});

test("fuzz-found, width-less: an empty column is not placed at its header", () => {
  // width-less, the header's extent is its left edge, and the words before it are the column to its left running on
  const t = read(fixture(true, [["CODE",163,0],["REMARKS",298,0],["DESCRIPTION",532,0],["PRODUCT",840,0],["W1-1",100,38],["SHADE",258,38],["Z0",306,38],["VCT-11",100,76],["WHITE",258,76],["Q1",306,76],["PT-1",100,114],["CARPET",258,114],["Q2",314,114]]));
  assert.deepEqual(keys(t).filter((k) => ["VCT-11","PT-1"].includes(k)), ["VCT-11","PT-1"]);
  assert.equal(cell(t, "VCT-11", "REMARKS"), "WHITE Q1");
  assert.equal(cell(t, "PT-1", "REMARKS"), "CARPET Q2");
  noCellOf(t, ["VCT-11","PT-1"], "SHADE Z0");
});

test("fuzz-found, width-less: a header starts its column only when the headers sit flush over their columns", () => {
  // TAG is centred over the keys
  const t = read(fixture(true, [["TAG",137.5,0],["MATERIAL",236,0],["COLOR",415,0],["P-2",100,38],["RUBBER",337,38],["COVE",393,38],["Q2",433,38],["VCT-12",100,76],["SEE",199,76],["NOTE",231,76],["2",271,76],["Q3",287,76],["ADHESIVE:",337,76],["VENDOR-K",417,76],["Q4",489,76],["VCT-7",100,114],["VENDOR-A",199,114],["Q5",271,114],["MATTE",337,114],["FINISH",385,114],["Q6",441,114],["CPT",543,76],["CARPET",603,76],["LGA",659,76],["RB",543,114],["RESILIENT",603,114],["LGB",683,114],["P",543,152],["PAINT",603,152],["LGC",651,152],["LVT",543,190],["LUXURY",603,190],["LGD",659,190],["ACT",543,228],["ACOUSTIC",603,228],["LGE",675,228]]));
  assert.deepEqual(keys(t).filter((k) => ["P-2","VCT-12","VCT-7"].includes(k)), ["P-2","VCT-12","VCT-7"]);
  assert.equal(cell(t, "P-2", "COLOR"), "RUBBER COVE Q2");
  noCellOf(t, ["P-2","VCT-12","VCT-7"], "CARPET LGA", "RESILIENT LGB", "PAINT LGC", "LUXURY LGD", "ACOUSTIC LGE");
});

test("fuzz-found, width-less: a header line set just under the header row heads its column", () => {
  // INSTALL on two lines straddling the header row: its cells are not a legend
  const t = read(fixture(true, [["TAG",161,0],["PRODUCT",400.5,0],["MATERIAL",669.5,0],["SIZE",856.5,0],["INSTALL",1040,-10],["INSTALL",1040,10],["C-11",100,38],["MATTE",246,38],["FINISH",294,38],["Q1",350,38],["PAINT",611,38],["Q2",659,38],["EGGSHELL",792,38],["Q3",864,38],["BLUE",953,38],["202",993,38],["Q4",1025,38],["C",100,76],["SEE",246,76],["NOTE",278,76],["2",318,76],["Q5",334,76],["SEE",611,76],["NOTE",643,76],["2",683,76],["Q6",699,76],["SEE",953,76],["NOTE",985,76],["2",1025,76],["Q7",1041,76],["LVT-5",100,114],["ADHESIVE:",611,114],["VENDOR-K",691,114],["Q8",763,114],["WC9",100,152],["GREY",246,152],["Q9",286,152],["EGGSHELL",611,152],["Q10",683,152],["P4",100,190],["VENDOR-B",246,190],["CO",318,190],["Q11",342,190],["RUBBER",792,190],["COVE",848,190],["Q12",888,190]]));
  assert.deepEqual(keys(t).filter((k) => ["C-11","C","LVT-5","WC9","P4"].includes(k)), ["C-11","C","LVT-5","WC9","P4"]);
  assert.equal(cell(t, "C-11", "PRODUCT"), "MATTE FINISH Q1");
  assert.equal(cell(t, "C-11", "MATERIAL"), "PAINT Q2");
  assert.equal(cell(t, "C-11", "SIZE"), "EGGSHELL Q3");
  assert.equal(cell(t, "C", "PRODUCT"), "SEE NOTE 2 Q5");
  assert.equal(cell(t, "C", "MATERIAL"), "SEE NOTE 2 Q6");
  assert.equal(cell(t, "LVT-5", "MATERIAL"), "ADHESIVE: VENDOR-K Q8");
  assert.equal(cell(t, "WC9", "PRODUCT"), "GREY Q9");
  assert.equal(cell(t, "WC9", "MATERIAL"), "EGGSHELL Q10");
  assert.equal(cell(t, "P4", "PRODUCT"), "VENDOR-B CO Q11");
  assert.equal(cell(t, "P4", "SIZE"), "RUBBER COVE Q12");
});

test("fuzz-found, width-less: the last column's later words are not a legend", () => {
  // PATTERN's second words start past its header
  const t = read(fixture(true, [["CODE",100,0],["PRODUCT",193,0],["PATTERN",473,0],["LVT-9",100,30],["CARPET",193,30],["Q1",249,30],["CARPET",473,30],["Q2",529,30],["CPT-2",100,60],["EGGSHELL",193,60],["Q3",265,60],["PAINT",473,60],["Q4",521,60]]));
  assert.deepEqual(keys(t).filter((k) => ["LVT-9","CPT-2"].includes(k)), ["LVT-9","CPT-2"]);
  assert.equal(cell(t, "LVT-9", "PRODUCT"), "CARPET Q1");
  assert.equal(cell(t, "LVT-9", "PATTERN"), "CARPET Q2");
  assert.equal(cell(t, "CPT-2", "PRODUCT"), "EGGSHELL Q3");
  assert.equal(cell(t, "CPT-2", "PATTERN"), "PAINT Q4");
});

test("fuzz-found, width-less: a centred header outside the vocabulary heads the cells that start left of it", () => {
  // FINISH's cells start left of the header's left edge; they band into MANUFACTURER, not out of the table
  const t = read(fixture(true, [["TAG",154,0],["MATERIAL",332.5,0],["MANUFACTURER",597,0],["FINISH",856.5,0],["VCT-12",100,46],["EGGSHELL Q1",232,46],["WHITE Q2",497,46],["TILE Q3",793,46],["WC-5",100,92],["SEE NOTE 2 Q4",232,92],["ADHESIVE: VENDOR-K Q5",497,92],["TILE Q6",793,92],["SS-12",100,138],["VINYL PLANK Q7",232,138],["TILE Q8",497,138],["GREY Q9",793,138]]));
  assert.deepEqual(keys(t).filter((k) => ["VCT-12","WC-5","SS-12"].includes(k)), ["VCT-12","WC-5","SS-12"]);
  assert.equal(cell(t, "VCT-12", "MATERIAL"), "EGGSHELL Q1");
  assert.equal(cell(t, "WC-5", "MATERIAL"), "SEE NOTE 2 Q4");
  assert.equal(cell(t, "SS-12", "MATERIAL"), "VINYL PLANK Q7");
  rowHas(t, "VCT-12", "TILE Q3");
  rowHas(t, "WC-5", "TILE Q6");
  rowHas(t, "SS-12", "GREY Q9");
});

test("fuzz-found: the header row is passed to the column map", () => {
  // a one-cell STYLE column is rescued only with its header in hand
  const t = read(fixture(false, [["TAG",152,0,24],["STYLE",355.5,0,40],["MANUFACTURER",636,0,96],["WT1-3",100,38,40],["SHADE Z0",228,38,64],["WC-5",100,76,32],["WHITE Q1",228,76,64],["VCT-3",100,114,40],["12 x 12 Q2",228,114,80],["VENDOR-B CO Q3",523,114,112]]));
  assert.deepEqual(keys(t).filter((k) => ["WC-5","VCT-3"].includes(k)), ["WC-5","VCT-3"]);
  assert.equal(cell(t, "WC-5", "STYLE"), "WHITE Q1");
  assert.equal(cell(t, "VCT-3", "STYLE"), "12 x 12 Q2");
  assert.equal(cell(t, "VCT-3", "MANUFACTURER"), "VENDOR-B CO Q3");
  noCellOf(t, ["WC-5","VCT-3"], "SHADE Z0");
});

test("the key column is never rescued: codes set right of a narrow key header keep their rows", () => {
  // TAG is narrow and left-set, the codes start right of it, and a stray note
  // line sits out left of the table: that line's edge is not the key column
  const spans = [sp("TAG", 100, 0), sp("MATERIAL", 220, 0), sp("COLOR", 520, 0)];
  const ks = ["CPT-1", "CPT-2", "RB-1", "RB-2", "P-1", "P-2"];
  ks.forEach((k, i) => { const y = PITCH * (i + 1); spans.push(sp(k, 140, y), sp(`MAT ${i}`, 220, y), sp(`GREY ${i}`, 520, y)); });
  spans.push(sp("NOTE: VERIFY", 60, PITCH * 7));
  const t = read(spans);
  assert.deepEqual(keys(t), ks);
  ks.forEach((k, i) => { assert.equal(cell(t, k, "MATERIAL"), `MAT ${i}`, k); assert.equal(cell(t, k, "COLOR"), `GREY ${i}`, k); });
});

// ── row keys ────────────────────────────────────────────────────────────────
test("outdented bands left of the key column are not its start (codes set right of a left-set CODE header)", () => {
  // not headings — material words — so they are cells of their own row, and
  // their left edge is a sparse cluster left of the key header. The key
  // column is never rescued from one.
  const hdr: Array<[string, number]> = [["CODE", 100], ["DESCRIPTION", 220], ["MANUFACTURER", 520], ["COLOR", 760]];
  const spans: GraphSpan[] = hdr.map(([l, x]) => sp(l, x, 0));
  const ks: string[] = [];
  let y = 0;
  ["CARPET", "RESILIENT", "PAINT"].forEach((band, b) => {
    y += PITCH; spans.push(sp(band, 70, y));
    for (let i = 1; i <= 6; i++) { y += PITCH; const k = ["CPT", "RB", "P"][b] + "-" + i; ks.push(k); spans.push(sp(k, 120, y), sp(`MATERIAL ${i}`, 220, y), sp(`VENDOR-${i}`, 520, y), sp(`COLOR ${i}`, 760, y)); }
  });
  const t = read(spans);
  assert.deepEqual(keys(t), ks);
  assert.equal(cell(t, "RB-2", "DESCRIPTION"), "MATERIAL 2");
});

test("a bare word in the key column (4+ letters) is never a finish code", () => {
  const items = [H("FLOORS"), FLOOR[2], FLOOR[3], H("CARPET"), FLOOR[0], FLOOR[1], H("TILE"), WALLS[2], H("PAINT"), WALLS[0], WALLS[1]];
  const t = read(build({ cols: STD, items }));
  assert.deepEqual(keys(t), ["LVT-1", "VCT-1", "CPT-1", "CPT-2", "CT-1", "P-1", "P-2"]);
});

test("a material word above its rows reads into no cell (PAINT above P-1 is not \"P-1 PAINT\")", () => {
  // a schedule that groups its rows under material words, a multi-word one
  // running past the key column, each on a line of its own
  const items = [H("ACOUSTICAL CEILING TILE"), CEIL[0], H("CARPET"), FLOOR[0], FLOOR[1], H("TILE"), WALLS[2], H("PAINT"), WALLS[0], WALLS[1], H("WALLCOVERING"), R("WC-1", "VINYL WALLCOVERING", "VENDOR-L", "TYPE II", "ASH 801")];
  const t = read(build({ cols: STD, items }));
  assert.deepEqual(keys(t), ["ACT-1", "CPT-1", "CPT-2", "CT-1", "P-1", "P-2", "WC-1"]);
  for (const k of keys(t)) assert.equal(cell(t, k, "CODE"), k, `${k}: the key cell holds the key alone`);
  assert.equal(cell(t, "ACT-1", "MATERIAL"), "ACOUSTICAL CEILING TILE");
  assert.equal(cell(t, "P-1", "MATERIAL"), "PAINT");
  assert.equal(cell(t, "WC-1", "MATERIAL"), "VINYL WALLCOVERING");
  assert.ok(t.rows.every((r) => r.section === undefined), "a material word names no section");
});

test("known limit: a letters-only code of four letters is not read", () => {
  // indistinguishable from a bare word (TILE, BASE, WALL) in the key column
  const items = [...FLOOR, R("EPOX", "EPOXY FLOORING", "VENDOR-T", "BROADCAST", "GREY 31"), ...BASE];
  const t = read(build({ cols: STD, items }));
  assert.deepEqual(keys(t), keysOf(items).filter((k) => k !== "EPOX"));
});

test("a group-label row (CPT above CPT-1) is not a row", () => {
  const label = (key: string): Item => ({ t: "row", key, cells: {} });
  const items: Item[] = [label("CPT"), FLOOR[0], FLOOR[1], label("LVT"), FLOOR[2], label("RB"), ...BASE, label("P"), WALLS[0], WALLS[1]];
  const t = read(build({ key: "TAG", cols: STD, items }));
  assert.deepEqual(keys(t), ["CPT-1", "CPT-2", "LVT-1", "RB-1", "RB-2", "P-1", "P-2"]);
});

test("a group label is found within three rows of its codes", () => {
  const label = (key: string): Item => ({ t: "row", key, cells: {} });
  const items: Item[] = [label("P"), R("PT-1", "PORCELAIN TILE", "VENDOR-F"), R("P-1", "PAINT", "VENDOR-E"), R("P-2", "PAINT", "VENDOR-E"), ...BASE];
  const t = read(build({ key: "TAG", cols: STD, items }));
  assert.deepEqual(keys(t), ["PT-1", "P-1", "P-2", "RB-1", "RB-2"]);
});

test("a letters-only code that names an item, or prefixes nothing close below, stays a row", () => {
  const label = (key: string, cells: Cells = {}): Item => ({ t: "row", key, cells });
  const items: Item[] = [
    R("C", "SEALED CONCRETE", "VENDOR-D", "CLEAR COAT", "CLEAR"), R("C-2", "SEALED CONCRETE", "VENDOR-D", "SATIN COAT", "CLEAR"),
    label("WD", { REMARKS: "SEE NOTE 2" }), ...FLOOR.slice(0, 4), R("WD-1", "WOOD FLOORING", "VENDOR-U", "PLANK", "NATURAL"),
  ];
  const t = read(build({ cols: STD, items }));
  assert.deepEqual(keys(t), keysOf(items));
});

test("a letters-only row that names its item in a STYLE / COLOR / SIZE column stays a row", () => {
  // no MATERIAL column at all: the item is named by its style and color
  const items: Item[] = [R("CPT-1", "", "", "LOOP 20", "GREY 101", "12' W"), R("RB", "", "", "COVE", "BLACK 505", '4"'), R("RB-1", "", "", "STRAIGHT", "GREY 506", '6"'), R("RB-2", "", "", "COVE", "GREY 507", '4"')];
  const t = read(build({ cols: ["STYLE", "COLOR", "SIZE"], items }));
  assert.deepEqual(keys(t), ["CPT-1", "RB", "RB-1", "RB-2"]);
  assert.equal(cell(t, "RB", "COLOR"), "BLACK 505");
});

test("a group label above codes that run on without a dash (CPT above CPT1) is not a row", () => {
  const label = (key: string): Item => ({ t: "row", key, cells: {} });
  const items: Item[] = [label("CPT"), R("CPT1", "BROADLOOM CARPET", "VENDOR-A"), R("CPT2", "CARPET TILE", "VENDOR-A"), ...BASE];
  const t = read(build({ key: "TAG", cols: STD, items }));
  assert.deepEqual(keys(t), ["CPT1", "CPT2", "RB-1", "RB-2"]);
});

test("a group label beside its spec section is not a row, and leaves the region", () => {
  // the label prints the spec section it groups, and that line reaches past
  // every real cell
  const spec = "09 91 23 INTERIOR PAINTING — SEE SPECIFICATIONS FOR ALL SYSTEMS AND SHEENS";
  const items: Item[] = [...FLOOR, ...BASE, { t: "row", key: "P", cells: { REMARKS: spec } }, WALLS[0], WALLS[1]];
  const spans = build({ cols: STD, items });
  const t = read(spans);
  assert.deepEqual(keys(t), [...keysOf(FLOOR), ...keysOf(BASE), "P-1", "P-2"]);
  const kept = spans.filter((x) => x.str !== spec);
  const right = Math.max(...kept.map((x) => x.x + (x.w || 0)));
  assert.ok(t.region[2] <= right, `region right ${t.region[2]} ≤ ${right}`);
});

test("a letters-only code with only a comment beside it stays a row (C above C-1)", () => {
  const spans = [sp("CODE", 100, 0), sp("MATERIAL", 220, 0), sp("COMMENTS", 760, 0), sp("COLOR", 1000, 0)];
  const data: Array<[string, string, string]> = [["C", "", "SEALED CONCRETE FLOOR"], ["C-1", "CONCRETE STAIN", "BROWN"], ["CPT-1", "CARPET", "GREY"]];
  data.forEach(([k, m, c], i) => { const y = PITCH * (i + 1); spans.push(sp(k, 100, y), sp(c, 760, y)); if (m) spans.push(sp(m, 220, y)); });
  const t = read(spans);
  assert.deepEqual(keys(t), ["C", "C-1", "CPT-1"]);
  assert.equal(cell(t, "C", "COMMENTS"), "SEALED CONCRETE FLOOR");
  assert.equal(cell(t, "C-1", "MATERIAL"), "CONCRETE STAIN");
  assert.equal(cell(t, "CPT-1", "COMMENTS"), "GREY");
});

test("a group label beside a spec section numbered with a point (09 30.50) is not a row", () => {
  const items: Item[] = [...FLOOR, { t: "row", key: "TA", cells: { MATERIAL: "09 30.50 TRIM ACCESSORY" } }, R("TA-1", "METAL EDGE TRIM", "VENDOR-I", "SQUARE", "SATIN"), R("TA-2", "METAL TRANSITION", "VENDOR-I", "RAMP", "SATIN")];
  const t = read(build({ cols: STD, items }));
  assert.deepEqual(keys(t), [...keysOf(FLOOR), "TA-1", "TA-2"]);
});

test("fuzz-found: a letters-only code that prints its item stays a row (SS above SS-3)", () => {
  // a group label prints nothing but its key
  const t = read(fixture(false, [["MARK",100,0,32],["MATERIAL",243,0,64],["DESCRIPTION",434,0,88],["CEILINGS",100,38,64],["SS",163.5,76,16],["CARPET Q1",302.5,76,72],["SS-3",155.5,114,32]]));
  assert.deepEqual(keys(t).filter((k) => ["SS","SS-3"].includes(k)), ["SS","SS-3"]);
  assert.equal(cell(t, "SS", "MATERIAL"), "CARPET Q1");
  noCellOf(t, ["SS","SS-3"], "CEILINGS");
});

test("fuzz-found: a letters-only code whose text bands into its key cell stays a row (T above T-10)", () => {
  // no column map: T's cell is read beside the key
  const t = read(fixture(false, [["MARK",139.5,0,32],["SIZE",333,0,32],["DESCRIPTION",605.5,0,88],["T",100,38,8],["OAK 303 Q1",211,38,80],["T-10",100,76,32]]));
  assert.deepEqual(keys(t).filter((k) => ["T","T-10"].includes(k)), ["T","T-10"]);
});

test("fuzz-found, width-less: a group label is found within three rows of its codes, not further", () => {
  // SS is followed by SS-8 five rows down
  const t = read(fixture(true, [["TAG",100,0],["DESCRIPTION",221,0],["SIZE",417,0],["LOCATION",771,-38],["SPECIFICATION",628.5,-38],["WC-12",140.5,38],["VENDOR-B",899.5,38],["CO",971.5,38],["Q1",995.5,38],["SS-12",140.5,76],["EGGSHELL",911.5,76],["Q2",983.5,76],["SS",152.5,114],["12",915.5,114],["x",939.5,114],["12",955.5,114],["Q3",979.5,114],["WT1-3",140.5,152],["SHADE",287,152],["Z3",335,152],["ACT-2",140.5,190],["RB-3",144.5,228],["PAINT",923.5,228],["Q4",971.5,228],["PT-2",144.5,266],["C",156.5,304],["EGGSHELL",550,304],["Q5",622,304],["W1-1",144.5,342],["SHADE",287,342],["Z7",335,342],["SS-8",144.5,380],["RUBBER",899.5,380],["COVE",955.5,380],["Q6",995.5,380]]));
  assert.deepEqual(keys(t).filter((k) => ["WC-12","SS-12","SS","ACT-2","RB-3","PT-2","C","SS-8"].includes(k)), ["WC-12","SS-12","SS","ACT-2","RB-3","PT-2","C","SS-8"]);
  noCellOf(t, ["WC-12","SS-12","SS","ACT-2","RB-3","PT-2","C","SS-8"], "SHADE Z3", "SHADE Z7");
});

// ── section headings ────────────────────────────────────────────────────────
test("key-column headings are consumed and name the rows' section", () => {
  const items = [H("FLOORING"), ...FLOOR, H("BASE"), ...BASE, H("WALLS"), ...WALLS];
  const t = read(build({ cols: STD, items }));
  assert.deepEqual(keys(t), keysOf(items));
  assert.deepEqual(sections(t), expectSections([[FLOOR, "FLOORING"], [BASE, "BASE"], [WALLS, "WALLS"]]));
  noCellHas(t, "FLOORING", "WALLS");
});

test("a heading carries the vocabulary entry it matched — phrases and punctuation", () => {
  const wp = [R("HR-1", "HANDRAIL", "VENDOR-J", "ROUND", "ALMOND"), R("CG-2", "CORNER GUARD", "VENDOR-J", "FLUSH", "ALMOND")];
  const a = [H("FLOORING"), ...FLOOR, H("WALL BASE"), ...BASE, H("WALL PROTECTION"), ...wp];
  const ta = read(build({ cols: STD, items: a }));
  assert.deepEqual(keys(ta), keysOf(a));
  assert.deepEqual(sections(ta), expectSections([[FLOOR, "FLOORING"], [BASE, "WALL BASE"], [wp, "WALL PROTECTION"]]));
  const b = [H("FLOORING"), ...FLOOR, H("MISC. FINISHES"), ...MISC];
  const tb = read(build({ cols: STD, items: b }));
  assert.deepEqual(sections(tb), expectSections([[FLOOR, "FLOORING"], [MISC, "MISC"]]));
  noCellHas(tb, "MISC. FINISHES");
  const c = [H("FLOORING (SEE NOTE 2)"), ...FLOOR, H("BASE"), ...BASE];
  const tc = read(build({ cols: STD, items: c }));
  assert.deepEqual(sections(tc), expectSections([[FLOOR, "FLOORING"], [BASE, "BASE"]]));
  noCellHas(tc, "SEE NOTE 2");
});

test("a heading of several spans, all ending before column 2, is one heading", () => {
  const items: Item[] = [H("FLOORING"), ...FLOOR, { t: "raw", spans: [["BASE", 100], ["(NOTE 4)", 140]] }, ...BASE];
  const t = read(build({ cols: STD, items }));
  assert.deepEqual(keys(t), keysOf(items));
  assert.deepEqual(sections(t), expectSections([[FLOOR, "FLOORING"], [BASE, "BASE"]]));
  noCellHas(t, "(NOTE 4)");
});

test("no column map: a heading centered on the table's text is a heading", () => {
  // too few cells for a column map, so the center is the text's own extent
  // (the header row reaches from CODE at 100 to the end of COLOR at 800)
  const at = (s: string) => 450 - (s.length * CW) / 2;
  const items: Item[] = [H("FLOORING", at("FLOORING")), R("CPT-1", "CARPET", ""), H("BASE", at("BASE")), R("RB-1", "RUBBER BASE", "")];
  const t = read(build({ cols: ["MATERIAL", "MANUFACTURER", "COLOR"], colX: { COLOR: 760 }, items }));
  assert.deepEqual(keys(t), ["CPT-1", "RB-1"]);
  assert.deepEqual(sections(t), { "CPT-1": "FLOORING", "RB-1": "BASE" });
});

test("no column map: text far below the table does not move the center a heading is measured against", () => {
  const at = (s: string) => 450 - (s.length * CW) / 2;
  const items: Item[] = [H("FLOORING", at("FLOORING")), R("CPT-1", "CARPET", ""), H("BASE", at("BASE")), R("RB-1", "RUBBER BASE", ""),
    { t: "gap", n: 14 }, { t: "raw", spans: [["SEE SHEET A-601 FOR FINISH PLAN NOTES", 900]] }];
  const t = read(build({ cols: ["MATERIAL", "MANUFACTURER", "COLOR"], colX: { COLOR: 760 }, items }));
  assert.deepEqual(keys(t), ["CPT-1", "RB-1"]);
  assert.deepEqual(sections(t), { "CPT-1": "FLOORING", "RB-1": "BASE" });
});

test("a heading that runs past the key column into column 2 is still a heading", () => {
  const items = [H("FLOORING - LEVEL ONE"), ...FLOOR, H("BASE - ALL LEVELS"), ...BASE];
  const t = read(build({ cols: STD, items }));
  assert.deepEqual(keys(t), keysOf(items));
  assert.deepEqual(sections(t), expectSections([[FLOOR, "FLOORING"], [BASE, "BASE"]]));
  noCellHas(t, "LEVEL ONE", "ALL LEVELS");
});

test("a heading set left of the key column (outdented) is a heading", () => {
  const more: Item[] = [];
  for (let i = 3; i <= 14; i++) more.push(R(`CPT-${i}`, "CARPET TILE", "VENDOR-A", "GRID", "GREY", "", i % 4 ? "" : "SEE NOTE 1"));
  const items = [H("FLOORING", 70), ...FLOOR, ...more, H("BASE", 70), ...BASE, H("WALLS", 70), ...WALLS];
  const t = read(build({ cols: STD, items }));
  assert.deepEqual(keys(t), keysOf(items));
  assert.deepEqual(sections(t), expectSections([[[...FLOOR, ...more], "FLOORING"], [BASE, "BASE"], [WALLS, "WALLS"]]));
});

test("an outdented heading joins the region", () => {
  const items = [H("FLOORING", 60), ...FLOOR, H("BASE", 60), ...BASE];
  const t = read(build({ cols: STD, items }));
  assert.deepEqual(sections(t), expectSections([[FLOOR, "FLOORING"], [BASE, "BASE"]]));
  assert.ok(t.region[0] <= 60, `region left ${t.region[0]} ≤ 60`);
});

test("a heading centered over the table is a heading, at any glyph width", () => {
  for (const w of [8, 6, 12]) withCW(w, () => {
    const mid = (100 + 1400 + 400) / 2;
    const at = (s: string) => mid - (s.length * CW) / 2;
    const items = [H("FLOORING", at("FLOORING")), ...FLOOR, H("BASE", at("BASE")), ...BASE, H("CEILINGS", at("CEILINGS")), ...CEIL];
    const t = read(build({ cols: STD, items }));
    assert.deepEqual(keys(t), keysOf(items), `glyph width ${w}`);
    assert.deepEqual(sections(t), expectSections([[FLOOR, "FLOORING"], [BASE, "BASE"], [CEIL, "CEILINGS"]]), `glyph width ${w}`);
  });
});

test("headings in a center-aligned table", () => {
  const items = [H("FLOORING"), ...FLOOR, H("BASE"), ...BASE, H("WALLS"), ...WALLS];
  const t = read(build({ cols: STD, items, align: "center" }));
  assert.deepEqual(keys(t), keysOf(items));
  assert.deepEqual(sections(t), expectSections([[FLOOR, "FLOORING"], [BASE, "BASE"], [WALLS, "WALLS"]]));
  assert.equal(cell(t, "LVT-1", "MATERIAL"), "LUXURY VINYL TILE");
  assert.equal(cell(t, "LVT-1", "SIZE"), '6" x 36"');
  assert.equal(cell(t, "CT-1", "REMARKS"), "GROUT: VENDOR-K 01 WHITE");
});

test("a long centered line that starts with a heading word is a note, not a heading", () => {
  // joined text of 24+ characters is never a heading, centered or not
  const mid = (100 + 1400 + 400) / 2;
  const note = "FLOOR PREP PER SPEC SECTION 09 05 00 TYP";
  const items = [H("BASE"), ...BASE, H(note, mid - (note.length * CW) / 2), ...FLOOR];
  const t = read(build({ cols: STD, items }));
  assert.deepEqual(keys(t), keysOf(items));
  assert.deepEqual(sections(t), expectSections([[[...BASE, ...FLOOR], "BASE"]]));
});

test("a cell's wrapped second line is not a heading, even when it is a heading word", () => {
  for (const w of [8, 6, 12]) withCW(w, () => {
    const rw = R("RB-3", "RESILIENT WALL", "VENDOR-B", "COVE", "BLACK"), ind = R("RB-4", "RESILIENT WALL", "VENDOR-B", "COVE", "GREY");
    const sw = R("P-3", "PAINT", "VENDOR-E", "FLAT", "SEE FINISH"), ac = R("ACT-2", "ACOUSTICAL", "VENDOR-G", "SQUARE", "WHITE");
    const items: Item[] = [H("FLOORING"), ...FLOOR, H("BASE"), rw, { t: "wrap", col: "MATERIAL", text: "BASE" }, ind, { t: "wrap", col: "MATERIAL", text: "BASE", dx: 10 }, BASE[0],
      H("WALLS"), sw, { t: "wrap", col: "COLOR", text: "WALL" }, WALLS[0], H("CEILINGS"), ac, { t: "wrap", col: "MATERIAL", text: "CEILING" }, CEIL[0]];
    const t = read(build({ cols: STD, items }));
    assert.deepEqual(keys(t), keysOf(items), `glyph width ${w}`);
    assert.deepEqual(sections(t), expectSections([[FLOOR, "FLOORING"], [[rw, ind, BASE[0]], "BASE"], [[sw, WALLS[0]], "WALLS"], [[ac, CEIL[0]], "CEILINGS"]]), `glyph width ${w}`);
    assert.equal(cell(t, "RB-3", "MATERIAL"), "RESILIENT WALL BASE");
    assert.equal(cell(t, "RB-4", "MATERIAL"), "RESILIENT WALL BASE");
    assert.equal(cell(t, "ACT-2", "MATERIAL"), "ACOUSTICAL CEILING");
    assert.equal(cell(t, "P-3", "COLOR"), "SEE FINISH WALL");
  });
});

test("a lone word far right of the table is not a heading", () => {
  const items = [H("FLOORING"), ...FLOOR.slice(0, 3), { t: "raw", spans: [["WALL", 1650]] } as Item, ...FLOOR.slice(3), H("BASE"), ...BASE];
  const t = read(build({ cols: STD, items }));
  assert.deepEqual(keys(t), keysOf(items));
  assert.deepEqual(sections(t), expectSections([[FLOOR, "FLOORING"], [BASE, "BASE"]]));
});

test("a material word or a spec-section number is not a section: rows under it have none", () => {
  const bare = [H("FLOORS"), FLOOR[2], FLOOR[3], H("CARPET"), FLOOR[0], FLOOR[1], H("TILE"), WALLS[2], H("PAINT"), WALLS[0], WALLS[1]];
  const tb = read(build({ cols: STD, items: bare }));
  assert.deepEqual(sections(tb), { "LVT-1": "FLOORS", "VCT-1": "FLOORS", "CPT-1": "", "CPT-2": "", "CT-1": "", "P-1": "", "P-2": "" });
  const spec: Item[] = [H("09 65 00 RESILIENT FLOORING"), FLOOR[2], FLOOR[3], ...BASE, { t: "raw", spans: [["09 68 00", 100], ["CARPETING", 220]] }, FLOOR[0], FLOOR[1], H("09 91 00 PAINTING"), ...WALLS];
  const items = [H("FLOORING"), FLOOR[4], ...spec];
  const ts = read(build({ cols: STD, items }));
  assert.deepEqual(keys(ts), keysOf(items));
  assert.deepEqual(sections(ts), { "SC-1": "FLOORING", ...expectSections([[spec, ""]]) });
  noCellHas(ts, "09 65 00", "09 68 00", "CARPETING", "09 91 00", "RESILIENT FLOORING", "PAINTING");
});

test("a spec-section heading of two spans ends the section and joins the region", () => {
  const items: Item[] = [H("FLOORING"), ...FLOOR, { t: "raw", spans: [["09 65 13", 60], ["RESILIENT ACCESSORIES", 220]] }, ...BASE];
  const t = read(build({ cols: STD, items }));
  assert.deepEqual(keys(t), keysOf(items));
  assert.deepEqual(sections(t), expectSections([[FLOOR, "FLOORING"], [BASE, ""]]));
  noCellHas(t, "09 65 13", "ACCESSORIES");
  assert.ok(t.region[0] <= 60, `region left ${t.region[0]} ≤ 60`);
});

test("any band in the key column this vocabulary does not know ends the section", () => {
  const act = [R("ACT-1", "ACOUSTICAL CEILING TILE", "VENDOR-G", "FINE FISSURED", "WHITE"), R("ACT-2", "ACOUSTICAL PANEL", "VENDOR-G", "SQUARE", "WHITE")];
  for (const band of ["ACOUSTICAL CEILING TREATMENTS", "SECTION 095113 ACOUSTICAL", "TILE/STONE"]) {
    const items = [H("WALLS"), ...WALLS, H(band), ...act];
    const t = read(build({ cols: STD, items }));
    assert.deepEqual(keys(t), keysOf(items), band);
    assert.deepEqual(sections(t), expectSections([[WALLS, "WALLS"], [act, ""]]), band);
  }
});

test("no column map: a lone word starting inside the key column but running into column 2 is not a heading", () => {
  // too few cells for a column map; "BASE" starts just left of the key
  // column's boundary and ends in the MATERIAL column
  const items: Item[] = [H("FLOORING"), R("CPT-1", "CARPET", ""), R("CPT-2", "CARPET", ""), { t: "raw", spans: [["BASE", 180]] }, R("VCT-1", "VINYL TILE", "")];
  const t = read(build({ cols: ["MATERIAL", "MANUFACTURER", "COLOR"], items }));
  assert.deepEqual(keys(t), ["CPT-1", "CPT-2", "VCT-1"]);
  assert.notEqual(row(t, "VCT-1").section, "BASE");
});

test("no column map: a long left-set heading is not read — its rows carry no section", () => {
  // the stated safe failure: with no column map, a lone span that runs out of
  // the key column is taken for a heading only when it is centered over the
  // table, and this one is set left. Its rows carry no section rather than a
  // guess (the same line centered would still be refused: 24+ characters)
  const items: Item[] = [H("FLOORING FINISHES ALL LEVELS"), R("CPT-1", "CARPET", ""), R("CPT-2", "CARPET", ""), R("VCT-1", "VINYL TILE", "")];
  const t = read(build({ cols: ["MATERIAL", "MANUFACTURER", "COLOR"], items }));
  assert.deepEqual(keys(t), ["CPT-1", "CPT-2", "VCT-1"]);
  assert.deepEqual(sections(t), { "CPT-1": "", "CPT-2": "", "VCT-1": "" });
});

test("tables with no headings carry no sections", () => {
  const items = [...FLOOR, ...BASE, ...WALLS, ...MISC];
  for (const k of ["CODE", "TAG", "MARK", "SYMBOL"]) {
    const t = read(build({ key: k, cols: STD, title: k === "CODE" ? undefined : "FINISH SCHEDULE", items }));
    assert.deepEqual(keys(t), keysOf(items), k);
    assert.ok(t.rows.every((r) => r.section === undefined), k);
    assert.equal(cell(t, "RB-1", "MATERIAL"), "RUBBER WALL BASE");
    assert.equal(cell(t, "CT-1", "REMARKS"), "GROUT: VENDOR-K 01 WHITE");
  }
});

test("a headed finish table with a TYPE / HEIGHT / WIDTH / THICKNESS / SLIP RATING column", () => {
  const items = [H("FLOORING"), ...FLOOR, H("BASE"), ...BASE, H("WALLS"), ...WALLS];
  for (const word of ["TYPE", "HEIGHT", "WIDTH", "THICKNESS", "SLIP RATING"]) {
    const spans = build({ cols: STD, items });
    const hdrY = Math.min(...spans.filter((x) => x.str === "SIZE").map((x) => x.y));
    for (const x of spans) if (x.str === "SIZE" && x.y === hdrY) { x.str = word; x.w = word.length * CW; }
    const t = read(spans);
    assert.deepEqual(keys(t), keysOf(items), word);
    assert.deepEqual(sections(t), expectSections([[FLOOR, "FLOORING"], [BASE, "BASE"], [WALLS, "WALLS"]]), word);
  }
});

test("a sparse REMARKS column under headings (1 of 9 rows)", () => {
  const fl = [R("CPT-1", "BROADLOOM CARPET", "VENDOR-A", "LOOP 20", "GREY 101"), R("CPT-2", "MODULAR CARPET TILE", "VENDOR-A", "GRID 24", "BLUE 202"), R("LVT-1", "LUXURY VINYL TILE", "VENDOR-B", "PLANK 6", "OAK 303", '6" x 36"', "ADHESIVE: VENDOR-K"), R("VCT-1", "VINYL COMPOSITION TILE", "VENDOR-C", "STANDARD", "WHITE 404", '12" x 12"'), FLOOR[4]];
  const wp = [R("HR-1", "HANDRAIL", "VENDOR-J", "ROUND", "ALMOND"), R("CG-2", "CORNER GUARD", "VENDOR-J", "FLUSH", "ALMOND")];
  const items = [H("FLOORING"), ...fl, H("WALL BASE"), ...BASE, H("WALL PROTECTION"), ...wp];
  const t = read(build({ cols: STD, items }));
  assert.deepEqual(keys(t), keysOf(items));
  assert.deepEqual(sections(t), expectSections([[fl, "FLOORING"], [BASE, "WALL BASE"], [wp, "WALL PROTECTION"]]));
  assert.equal(cell(t, "LVT-1", "REMARKS"), "ADHESIVE: VENDOR-K");
});

// A heading is a lone span, so a column of them has a left edge of its own.
// It must never be taken for a column start: not the key column's, and not a
// sparse column's the rescue would otherwise hand it.
const headedTable = (o: { heads: Array<[string, number]>; codeX: number; hdr: Array<[string, number]>; cell: (k: string, i: number) => Array<[string, number]>; n: number; widthless?: boolean }): GraphSpan[] => {
  const mk = (str: string, x: number, y: number): GraphSpan => (o.widthless ? { str, x, y, w: 0, h: TH } : sp(str, x, y));
  const out: GraphSpan[] = o.hdr.map(([l, x]) => mk(l, x, 0));
  let y = 0;
  o.heads.forEach(([head, hx], h) => {
    y += PITCH; out.push(mk(head, hx, y));
    for (let i = 1; i <= o.n; i++) { y += PITCH; const k = ["CPT", "RB", "P"][h] + "-" + i; out.push(mk(k, o.codeX, y), ...o.cell(k, i).map(([s, x]) => mk(s, x, y))); }
  });
  return out;
};
const HEADS3 = ["FLOORING", "BASE", "WALLS"];
const KEYS3 = (n: number) => ["CPT", "RB", "P"].flatMap((p) => Array.from({ length: n }, (_, i) => `${p}-${i + 1}`));

test("outdented headings are not the key column's start (codes set right of a left-set CODE header)", () => {
  const hdr: Array<[string, number]> = [["CODE", 100], ["DESCRIPTION", 220], ["MANUFACTURER", 520], ["COLOR", 760]];
  const cells = (_k: string, i: number): Array<[string, number]> => [[`MATERIAL ${i}`, 220], [`VENDOR-${i}`, 520], [`COLOR ${i}`, 760]];
  for (const n of [6, 10]) {
    const t = read(headedTable({ heads: HEADS3.map((h) => [h, 70]), codeX: 120, hdr, cell: cells, n }));
    assert.deepEqual(keys(t), KEYS3(n), `n=${n}`);
    assert.equal(cell(t, "CPT-1", "DESCRIPTION"), "MATERIAL 1");
    assert.deepEqual([...new Set(t.rows.map((r) => r.section))], ["FLOORING", "BASE", "WALLS"]);
  }
});

test("width-less input: outdented headings are not the key column's start (codes indented 4 px)", () => {
  const hdr: Array<[string, number]> = [["CODE", 100], ["DESCRIPTION", 220], ["MANUFACTURER", 520], ["COLOR", 760]];
  const cells = (_k: string, i: number): Array<[string, number]> => [[`MATERIAL`, 220], [`VENDOR-${i}`, 520], [`GREY`, 760]];
  for (const hx of [70, 88]) for (const n of [6, 10]) {
    const t = read(headedTable({ heads: HEADS3.map((h) => [h, hx]), codeX: 104, hdr, cell: cells, n, widthless: true }));
    assert.deepEqual(keys(t), KEYS3(n), `heading x=${hx}, n=${n}`);
    assert.equal(cell(t, "RB-2", "MANUFACTURER"), "VENDOR-2");
    assert.deepEqual([...new Set(t.rows.map((r) => r.section))], ["FLOORING", "BASE", "WALLS"]);
  }
});

test("centered headings are not rescued as a sparse column's start", () => {
  // COLOR's cells sit 30 px right of its header; the headings, centered over
  // the table, have their left edges between MATERIAL and COLOR
  const hdr: Array<[string, number]> = [["CODE", 100], ["MATERIAL", 220], ["COLOR", 400]];
  const cells = (_k: string, i: number): Array<[string, number]> => [[`MATERIAL ${i}`, 220], [`GREY ${i}`, 430]];
  const t = read(headedTable({ heads: HEADS3.map((h) => [h, 330 - (h.length * CW) / 2]), codeX: 100, hdr, cell: cells, n: 6 }));
  assert.deepEqual(keys(t), KEYS3(6));
  assert.equal(t.rows.filter((r) => r.cells.COLOR).length, 18, "every row keeps its COLOR");
  assert.equal(cell(t, "CPT-1", "COLOR"), "GREY 1");
  assert.equal(cell(t, "CPT-1", "MATERIAL"), "MATERIAL 1");
  assert.deepEqual([...new Set(t.rows.map((r) => r.section))], ["FLOORING", "BASE", "WALLS"]);
});

test("a heading-word line far below the table does not stretch its region", () => {
  const items: Item[] = [H("FLOORING"), ...FLOOR, H("BASE"), ...BASE, { t: "gap", n: 14 }, H("BASE DETAIL")];
  const spans = build({ cols: STD, items });
  const lastRowBottom = Math.max(...spans.filter((s) => s.str === "RB-2").map((s) => s.y + s.h));
  const t = read(spans);
  assert.deepEqual(keys(t), keysOf(items));
  assert.deepEqual(sections(t), expectSections([[FLOOR, "FLOORING"], [BASE, "BASE"]]));
  assert.ok(t.region[3] <= lastRowBottom + 2, `region bottom ${t.region[3]} ≤ ${lastRowBottom + 2}`);
});

test("fuzz-found, width-less: no column is rescued", () => {
  // a sparse column's first word cannot be told from a later word of the cell before it
  const t = read(fixture(true, [["SYMBOL",100,0],["COLOR",222,0],["STYLE",527,0],["MISC.",100,30],["FINISHES",148,30],["SS",100,60],["SS2",100,90],["VENDOR-A",222,90],["Q1",294,90],["WALLS",100,120],["VCT-2",100,150]]));
  assert.deepEqual(keys(t).filter((k) => ["SS2","VCT-2"].includes(k)), ["SS2","VCT-2"]);
  assert.equal(cell(t, "SS2", "COLOR"), "VENDOR-A Q1");
  noCellOf(t, ["SS2","VCT-2"], "MISC. FINISHES", "WALLS");
});

test("fuzz-found: a heading in the key column is consumed, never a cell", () => {
  // CEILINGS over a three-row table
  const t = read(fixture(false, [["TAG",100,0,24],["MATERIAL",245,0,64],["PRODUCT",483,0,56],["MANUFACTURER",789,0,96],["CEILINGS",100,38,64],["CPT-12",100,76,48],["12 x 12 Q1",789,76,80],["X1-2",100,114,32],["SHADE Z1",245,114,64],["PT-7",100,152,32],["OAK 303 Q2",245,152,80],["ADHESIVE: VENDOR-K Q3",789,152,168]]));
  assert.deepEqual(keys(t).filter((k) => ["CPT-12","PT-7"].includes(k)), ["CPT-12","PT-7"]);
  assert.equal(cell(t, "CPT-12", "MANUFACTURER"), "12 x 12 Q1");
  assert.equal(cell(t, "PT-7", "MATERIAL"), "OAK 303 Q2");
  assert.equal(cell(t, "PT-7", "MANUFACTURER"), "ADHESIVE: VENDOR-K Q3");
  noCellOf(t, ["CPT-12","PT-7"], "CEILINGS");
});

test("fuzz-found: heading-word lines read as no heading still count toward the row pitch", () => {
  // the headings are centered on a column the table's extent cannot place; without them the repair radius doubles and they land in cells
  const t = read(fixture(false, [["SYMBOL",100,0,48],["PRODUCT",211,0,56],["MANUFACTURER",398,0,96],["SPECIFICATION",411,-38,104],["WALLS",387.5,38,40],["T",100,76,8],["ADHESIVE: VENDOR-K Q1",398,76,168],["FLOORING",375.5,114,64],["SS-4",100,152,32],["MATTE FINISH Q2",398,152,120],["SS-11",100,190,40]]));
  assert.deepEqual(keys(t).filter((k) => ["T","SS-4","SS-11"].includes(k)), ["T","SS-4","SS-11"]);
  assert.equal(cell(t, "T", "MANUFACTURER"), "ADHESIVE: VENDOR-K Q1");
  assert.equal(cell(t, "SS-4", "MANUFACTURER"), "MATTE FINISH Q2");
  noCellOf(t, ["T","SS-4","SS-11"], "WALLS", "FLOORING");
});

test("fuzz-found: one-row sections keep the repair radius tight (an unkeyed row joins no row)", () => {
  // consumed headings count toward the pitch; without them W1-1 joins T-10
  const t = read(fixture(false, [["CODE",100,0,32],["STYLE",193,0,40],["MATERIAL",477,0,64],["BASE",100,30,32],["W1-1",100,60,32],["SHADE Z0",193,60,64],["T-10",100,90,32],["WHITE Q1",193,90,64],["EGGSHELL Q2",477,90,88],["CEILINGS",100,120,64],["LVT-2",100,150,40]]));
  assert.deepEqual(keys(t).filter((k) => ["T-10","LVT-2"].includes(k)), ["T-10","LVT-2"]);
  assert.equal(cell(t, "T-10", "STYLE"), "WHITE Q1");
  assert.equal(cell(t, "T-10", "MATERIAL"), "EGGSHELL Q2");
  noCellOf(t, ["T-10","LVT-2"], "BASE", "SHADE Z0", "CEILINGS");
});

test("fuzz-found, width-less: headings in or left of the key column cast no column vote", () => {
  // their edges would join the key cluster and lift the keep floor over the sparse columns
  const t = read(fixture(true, [["MARK",142,0],["COLOR",323.5,0],["SPEC",323.5,-15],["DESCRIPTION",497,0],["MILLWORK",70,30],["C",154,60],["TILE",513,60],["Q1",553,60],["CPT-3",138,90],["X",327.5,90],["Q2",343.5,90],["VENDOR-B",485,90],["CO",557,90],["Q3",581,90],["ACT5",142,120],["OAK",303.5,120],["303",335.5,120],["Q4",367.5,120],["TILE",513,120],["Q5",553,120],["WALLS",70,150],["RB-8",142,180],["BLUE",299.5,180],["202",339.5,180],["Q6",371.5,180],["BLUE",497,180],["202",537,180],["Q7",569,180],["ACT-5",138,210],["12",303.5,210],["x",327.5,210],["12",343.5,210],["Q8",367.5,210],["CPT",687,60],["CARPET",747,60],["LGA",803,60],["RB",687,90],["RESILIENT",747,90],["LGB",827,90],["P",687,120],["PAINT",747,120],["LGC",795,120],["LVT",687,150],["LUXURY",747,150],["LGD",803,150]]));
  assert.deepEqual(keys(t).filter((k) => ["C","CPT-3","ACT5","RB-8","ACT-5"].includes(k)), ["C","CPT-3","ACT5","RB-8","ACT-5"]);
  assert.equal(cell(t, "C", "DESCRIPTION"), "TILE Q1");
  assert.equal(cell(t, "ACT5", "COLOR"), "OAK 303 Q4");
  assert.equal(cell(t, "ACT5", "DESCRIPTION"), "TILE Q5");
  assert.equal(cell(t, "RB-8", "COLOR"), "BLUE 202 Q6");
  assert.equal(cell(t, "RB-8", "DESCRIPTION"), "BLUE 202 Q7");
  assert.equal(cell(t, "ACT-5", "COLOR"), "12 x 12 Q8");
  noCellOf(t, ["C","CPT-3","ACT5","RB-8","ACT-5"], "MILLWORK", "WALLS", "CARPET LGA", "RESILIENT LGB", "PAINT LGC", "LUXURY LGD");
});

test("fuzz-found: a heading that shares its row with a legend line casts no column vote", () => {
  // its edge would start a key column left of the keys
  const t = read(fixture(false, [["CODE",100,0,32],["COLOR",258,0,40],["MATERIAL",495,0,64],["COMMENTS",820,0,64],["BASIS OF",820,-23,64],["MILLWORK",100,46,64],["P",175,92,8],["P-4",167,138,24],["BLUE 202 Q1",332.5,138,88],["GREY Q2",629.5,138,56],["WALL FINISHES",100,184,104],["T",175,230,8],["VENDOR-A Q3",332.5,230,88],["MATTE FINISH Q4",597.5,230,120],["CPT-10",155,276,48],["RUBBER COVE Q5",320.5,276,112],["OAK 303 Q6",617.5,276,80],["CARPET Q7",853.5,276,72],["SS",171,322,16],["VENDOR-A Q8",332.5,322,88],["X Q9",641.5,322,32],["CPT",999,46,24],["CARPET LGA",1059,46,80],["RB",999,92,16],["RESILIENT LGB",1059,92,104],["P",999,138,8],["PAINT LGC",1059,138,72],["LVT",999,184,24],["LUXURY LGD",1059,184,80],["ACT",999,230,24],["ACOUSTIC LGE",1059,230,96]]));
  assert.deepEqual(keys(t).filter((k) => ["P-4","T","CPT-10","SS"].includes(k)), ["P-4","T","CPT-10","SS"]);
  assert.equal(cell(t, "P-4", "COLOR"), "BLUE 202 Q1");
  assert.equal(cell(t, "P-4", "MATERIAL"), "GREY Q2");
  assert.equal(cell(t, "T", "COLOR"), "VENDOR-A Q3");
  assert.equal(cell(t, "T", "MATERIAL"), "MATTE FINISH Q4");
  assert.equal(cell(t, "CPT-10", "COLOR"), "RUBBER COVE Q5");
  assert.equal(cell(t, "CPT-10", "MATERIAL"), "OAK 303 Q6");
  assert.equal(cell(t, "CPT-10", "COMMENTS"), "CARPET Q7");
  assert.equal(cell(t, "SS", "COLOR"), "VENDOR-A Q8");
  assert.equal(cell(t, "SS", "MATERIAL"), "X Q9");
  noCellOf(t, ["P-4","T","CPT-10","SS"], "MILLWORK", "WALL FINISHES", "CARPET LGA", "RESILIENT LGB", "LUXURY LGD");
});

test("fuzz-found: an unkeyed line nearer a heading than a row joins no row", () => {
  // X1-2 sits between TRANSITIONS and T-11
  const t = read(fixture(false, [["TAG",147,0,24],["MATERIAL",275,0,64],["PATTERN",507,0,56],["COLOR",741.5,0,40],["TRANSITIONS",100,38,88],["X1-2",100,76,32],["SHADE Z0",218,76,64],["T-11",100,114,32],["RUBBER COVE Q1",218,114,112],["BLUE 202 Q2",674,114,88],["C-11",100,152,32],["EGGSHELL Q3",218,152,88]]));
  assert.deepEqual(keys(t).filter((k) => ["T-11","C-11"].includes(k)), ["T-11","C-11"]);
  assert.equal(cell(t, "T-11", "MATERIAL"), "RUBBER COVE Q1");
  assert.equal(cell(t, "T-11", "COLOR"), "BLUE 202 Q2");
  assert.equal(cell(t, "C-11", "MATERIAL"), "EGGSHELL Q3");
  noCellOf(t, ["T-11","C-11"], "TRANSITIONS", "SHADE Z0");
});

test("fuzz-found, width-less: a heading over the columns votes where a cell would", () => {
  // MISC. FINISHES and BASE sit over STYLE
  const t = read(fixture(true, [["CODE",146,0],["STYLE",269,0],["SPEC",269,-15],["DESCRIPTION",475.5,0],["MISC.",336.5,30],["FINISHES",384.5,30],["T2",100,60],["VENDOR-A",224,60],["Q1",296,60],["SS-2",100,90],["BASE",376.5,120],["P1",100,150],["OAK",224,150],["303",256,150],["Q3",288,150]]));
  assert.deepEqual(keys(t).filter((k) => ["T2","SS-2","P1"].includes(k)), ["T2","SS-2","P1"]);
  assert.equal(cell(t, "T2", "STYLE"), "VENDOR-A Q1");
  assert.equal(cell(t, "P1", "STYLE"), "OAK 303 Q3");
  noCellOf(t, ["T2","SS-2","P1"], "MISC. FINISHES", "BASE");
});

test("fuzz-found, width-less: a heading at the key column casts no column vote", () => {
  // WALL FINISHES at the keys' left edge
  const t = read(fixture(true, [["TAG",141.5,0],["SIZE",262,0],["DESCRIPTION",473.5,0],["SPECIFICATION",394.5,-38],["WALL FINISHES",100,38],["ACT-10",100,76],["CARPET Q1",349,76],["C-1",100,114],["CARPET Q2",349,114],["WALL BASE",100,152],["WC-12",100,190],["VENDOR-B CO Q3",349,190],["WC-9",100,228],["RUBBER COVE Q4",349,228],["VCT-2",100,266],["MATTE FINISH Q5",207,266],["BLUE 202 Q6",349,266],["P-3",100,304],["VENDOR-A Q7",349,304],["PT-6",100,342],["PAINT Q8",207,342],["PAINT Q9",349,342]]));
  assert.deepEqual(keys(t).filter((k) => ["ACT-10","C-1","WC-12","WC-9","VCT-2","P-3","PT-6"].includes(k)), ["ACT-10","C-1","WC-12","WC-9","VCT-2","P-3","PT-6"]);
  assert.equal(cell(t, "ACT-10", "DESCRIPTION"), "CARPET Q1");
  assert.equal(cell(t, "C-1", "DESCRIPTION"), "CARPET Q2");
  assert.equal(cell(t, "WC-12", "DESCRIPTION"), "VENDOR-B CO Q3");
  assert.equal(cell(t, "WC-9", "DESCRIPTION"), "RUBBER COVE Q4");
  assert.equal(cell(t, "VCT-2", "SIZE"), "MATTE FINISH Q5");
  assert.equal(cell(t, "VCT-2", "DESCRIPTION"), "BLUE 202 Q6");
  assert.equal(cell(t, "P-3", "DESCRIPTION"), "VENDOR-A Q7");
  assert.equal(cell(t, "PT-6", "SIZE"), "PAINT Q8");
  assert.equal(cell(t, "PT-6", "DESCRIPTION"), "PAINT Q9");
  noCellOf(t, ["ACT-10","C-1","WC-12","WC-9","VCT-2","P-3","PT-6"], "WALL FINISHES", "WALL BASE");
});

test("fuzz-found: a heading-word line that shares its row with a legend line still counts toward the pitch", () => {
  // WALL FINISHES beside the legend's first line
  const t = read(fixture(false, [["TAG",136.5,0,24],["COMMENTS",228.5,0,64],["INSTALL",370.5,-10,56],["LOCATION",366.5,10,64],["PATTERN",545.5,0,56],["WALL FINISHES",335,38,104],["T",144.5,76,8],["BLUE 202 Q1",216.5,76,88],["GREY Q2",370.5,76,56],["ADHESIVE: VENDOR-K Q3",489.5,76,168],["RB-2",132.5,114,32],["X Q4",244.5,114,32],["CARPET Q5",362.5,114,72],["X1-2",132.5,152,32],["SHADE Z2",228.5,152,64],["P-5",136.5,190,24],["PAINT Q6",366.5,190,64],["CPT",722,38,24],["CARPET LGA",782,38,80],["RB",722,76,16],["RESILIENT LGB",782,76,104]]));
  assert.deepEqual(keys(t).filter((k) => ["T","RB-2","P-5"].includes(k)), ["T","RB-2","P-5"]);
  assert.equal(cell(t, "T", "COMMENTS"), "BLUE 202 Q1");
  assert.equal(cell(t, "RB-2", "COMMENTS"), "X Q4");
  rowHas(t, "T", "GREY Q2");
  rowHas(t, "RB-2", "CARPET Q5");
  rowHas(t, "P-5", "PAINT Q6");
  noCellOf(t, ["T","RB-2","P-5"], "WALL FINISHES", "SHADE Z2", "CARPET LGA", "RESILIENT LGB");
});

test("a cell's wrapped word that is a heading word joins its row, in a table whose rows all wrap", () => {
  // every row prints a second line, so the table's line pitch is the wrap's:
  // RT-3's second line (FLOORING) does not hug its row, and is still its row's
  const spans = [sp("CODE", 100, 0), sp("MATERIAL", 220, 0), sp("COLOR", 520, 0)];
  const ks = ["RT-1", "RT-2", "RT-3", "RB-1", "RB-2", "CT-1"];
  ks.forEach((k, i) => { const y = PITCH * (i + 1); spans.push(sp(k, 100, y), sp("RESILIENT TILE", 220, y), sp(`GREY ${i}`, 520, y), sp(i === 2 ? "FLOORING" : `SEE NOTE ${"ABCDEF"[i]}`, 220, y + 19)); });
  const t = read(spans);
  assert.deepEqual(keys(t), ks);
  assert.equal(cell(t, "RT-3", "MATERIAL"), "RESILIENT TILE FLOORING");
  assert.equal(cell(t, "RT-1", "MATERIAL"), "RESILIENT TILE SEE NOTE A");
});

test("a heading word wrapped tight under its cell is not a table line: a remark line below it still joins the row", () => {
  // BASE hugs RUBBER WALL (8 px under it); CONTINUED sits 16 px under the row,
  // nearer the row than the next one. BASE is the cell's own word, not a line
  // of the table, so it does not take CONTINUED away from the row
  const spans = [sp("CODE", 100, 0), sp("MATERIAL", 220, 0), sp("COLOR", 520, 0), sp("REMARKS", 760, 0)];
  const ks = ["CPT-1", "CPT-2", "RB-1", "RB-2", "P-1", "P-2", "CT-1", "ACT-1"];
  ks.forEach((k, i) => { const y = PITCH * (i + 1); spans.push(sp(k, 100, y), sp("RUBBER WALL", 220, y), sp(`GREY ${i}`, 520, y), sp(`NOTE ${i}`, 760, y)); if (k === "RB-1") spans.push(sp("BASE", 220, y + 8), sp("CONTINUED", 760, y + 16)); });
  const t = read(spans);
  assert.deepEqual(keys(t), ks);
  assert.equal(cell(t, "RB-1", "MATERIAL"), "RUBBER WALL BASE");
  assert.equal(cell(t, "RB-1", "REMARKS"), "NOTE 2 CONTINUED");
});

test("a heading a little off the middle of a narrow table is still centered (three text heights)", () => {
  // the table is 420 px wide, so a tenth of it is under three text heights
  const spans = [sp("CODE", 100, 0), sp("MATERIAL", 220, 0), sp("COLOR", 400, 0)];
  let y = 0;
  const rowsOf = (ks: string[]) => ks.forEach((k, i) => { y += PITCH; spans.push(sp(k, 100, y), sp(`MAT ${i}`, 220, y), sp(`GREY ${i}`, 400, y)); });
  y += PITCH; spans.push(sp("WALLS", 270, y)); rowsOf(["P-1", "P-2", "P-3", "P-4"]);
  y += PITCH; spans.push(sp("BASE", 274, y)); rowsOf(["RB-1", "RB-2", "RB-3", "RB-4"]);
  const t = read(spans);
  assert.deepEqual(sections(t), { "P-1": "WALLS", "P-2": "WALLS", "P-3": "WALLS", "P-4": "WALLS", "RB-1": "BASE", "RB-2": "BASE", "RB-3": "BASE", "RB-4": "BASE" });
});

test("no column map: a heading is centered on the table's text, cells and all, not on its header row", () => {
  // a long remark runs well past the header row; the heading is centered on
  // the text the table actually prints
  const rem = "SEE SPECIFICATION SECTION 09 65 00 FOR ADHESIVES";
  const mid = (100 + 400 + rem.length * CW) / 2;
  const spans = [sp("CODE", 100, 0), sp("MATERIAL", 220, 0), sp("REMARKS", 400, 0), sp("FLOORING", mid - 32, PITCH), sp("CPT-1", 100, 2 * PITCH), sp("CARPET", 220, 2 * PITCH), sp(rem, 400, 2 * PITCH), sp("CPT-2", 100, 3 * PITCH), sp("CARPET TILE", 220, 3 * PITCH)];
  const t = read(spans);
  assert.deepEqual(sections(t), { "CPT-1": "FLOORING", "CPT-2": "FLOORING" });
  noCellHas(t, "FLOORING");
});

// ── a marquee crop ──────────────────────────────────────────────────────────
test("a marquee crop is the table: a gap of more than 8 row pitches does not end it", () => {
  const more: Item[] = [];
  for (let i = 1; i <= 8; i++) more.push(R(`LVT-${i + 10}`, "LUXURY VINYL TILE", "VENDOR-B", "PLANK", "OAK"));
  const first = [H("FLOORING"), ...FLOOR, ...BASE, ...WALLS, ...CEIL];
  const spans = build({ cols: STD, items: [...first, { t: "gap", n: 10 }, ...more] });
  // the whole sheet: rows far below are something else keyed the same way
  assert.deepEqual(keys(read(spans)), keysOf(first));
  // a marquee the user drew around the table: every row in it is the table's
  assert.deepEqual(keys(read(spans, true)), [...keysOf(first), ...keysOf(more)]);
});

// ── readFinishTable: the one finish reader ──────────────────────────────────
test("readFinishTable returns the table and every word of its header row", () => {
  const items = [H("FLOORING"), ...FLOOR, H("BASE"), ...BASE];
  const r = readFinishTable({ key: "fx", spans: build({ key: "TAG", cols: ["MATERIAL", "MANUF.", "COLOR", "REMARKS"], title: "FINISH SCHEDULE", items }) }, { marquee: true });
  assert.ok(r && !("refused" in r));
  assert.deepEqual(keys(r.table), keysOf(items));
  assert.equal(r.table.title?.text, "FINISH SCHEDULE");
  // the raw header words — MANUF. as printed, not the column it names
  assert.deepEqual(r.headerWords, ["TAG", "MATERIAL", "MANUF", "COLOR", "REMARKS"]);
  assert.ok(!("headerWords" in r.table), "the table itself is unchanged");
});

test("readFinishTable refuses a table titled as another schedule family, and names it", () => {
  const rows = ["D-1", "D-2", "D-3"].map((k) => R(k, "HOLLOW METAL", "VENDOR-N", "", "GRAY"));
  const door = build({ key: "MARK", cols: ["MATERIAL", "MANUFACTURER", "COLOR"], title: "DOOR SCHEDULE", items: rows });
  const r = readFinishTable({ key: "fx", spans: door });
  assert.ok(r && "refused" in r);
  assert.equal(r.refused, "other-family");
  assert.equal(r.table.title?.text, "DOOR SCHEDULE");
  const kept = readFinishTable({ key: "fx", spans: build({ key: "MARK", cols: ["MATERIAL", "MANUFACTURER", "COLOR"], title: "DOOR FINISH SCHEDULE", items: rows }) });
  assert.ok(kept && !("refused" in kept), "a title that also says FINISH is kept");
  assert.equal(readFinishTable({ key: "fx", spans: [sp("GENERAL NOTES", 100, 0), sp("1. VERIFY ALL DIMENSIONS", 100, 38)] }), null);
  // the sheet graph drops the same table and names it
  const g = buildSheetGraph([{ key: "door.pdf#1", spans: door }]);
  assert.equal(g.tables.filter((t) => t.kind === "finish").length, 0);
  assert.ok(g.notes.some((n) => n.includes('"DOOR SCHEDULE" names another schedule family') && n.includes("its 3 rows are NOT indexed")), g.notes.join(" | "));
});

test("the sheet graph indexes finish rows with their sections", () => {
  const items = [H("FLOORING"), ...FLOOR, H("BASE"), ...BASE, H("WALLS"), ...WALLS];
  const g = buildSheetGraph([{ key: "mat.pdf#1", spans: build({ cols: STD, title: "MATERIAL SCHEDULE", items }) }]);
  const t = g.tables.find((x) => x.kind === "finish");
  assert.ok(t);
  assert.deepEqual(keys(t), keysOf(items));
  assert.deepEqual(sections(t), expectSections([[FLOOR, "FLOORING"], [BASE, "BASE"], [WALLS, "WALLS"]]));
});
