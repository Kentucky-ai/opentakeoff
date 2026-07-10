// Import-from-schedule parser (the marquee → conditions feature). Invariants:
//   - positioned tokens cluster into rows, columns anchor off the header, and
//     blank cells don't steal a neighbour's text (fixed-band, not nearest-word);
//   - the schedule's own section headers drive category, and ceilings/millwork
//     come back UNCHECKED (suggested:false) so the estimator drops them for free;
//   - a code-shaped first cell under a section is a data row; "C" (concrete) is a
//     legal lone-letter code, section words are not mistaken for codes;
//   - rowToSeed applies category appearance/waste defaults and carries the
//     product spec (mfr/style/color/size) through for the canvas to attach;
//   - no header structure → [] (the caller says "no schedule here", invents nothing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSchedule, rowToSeed, type Token } from "../src/lib/scheduleParse.js";

// column left-edges mirroring a real material schedule (region-local px)
const AX = { CODE: 40, MATERIAL: 120, MANUFACTURER: 360, STYLE: 600, COLOR: 960, SIZE: 1280, REMARKS: 1440 };
const H = 14;
let Y = 0;

// place a cell's words starting at its column anchor, stepping 30px so a
// multi-word cell still lands left of the midpoint to the next column
function cell(col: keyof typeof AX, text: string, y: number): Token[] {
  const words = text.split(/\s+/).filter(Boolean);
  return words.map((w, i) => ({ str: w, x: AX[col] + i * 30, y, h: H }));
}
function dataRow(cells: Partial<Record<keyof typeof AX, string>>): Token[] {
  Y += 44;
  return (Object.entries(cells) as [keyof typeof AX, string][]).flatMap(([c, t]) => cell(c, t, Y));
}
function sectionRow(name: string): Token[] { Y += 44; return [{ str: name, x: AX.CODE, y: Y, h: H }]; }
function headerRow(): Token[] {
  Y += 44;
  return [
    ...cell("CODE", "CODE", Y), ...cell("MATERIAL", "MATERIAL/PRODUCT", Y),
    ...cell("MANUFACTURER", "MANUFACTURER", Y), ...cell("STYLE", "STYLE", Y),
    ...cell("COLOR", "COLOR", Y), ...cell("SIZE", "SIZE", Y), ...cell("REMARKS", "REMARKS", Y),
  ];
}

function sampleTokens(): Token[] {
  Y = 0;
  return [
    ...headerRow(),
    ...sectionRow("FLOORING"),
    ...dataRow({ CODE: "CPT-1", MATERIAL: "BROADLOOM CARPET", MANUFACTURER: "J+J INVISION", STYLE: "PAY DAY", COLOR: "1408 HIGH ROLLER" }),
    ...dataRow({ CODE: "VCT-1", MATERIAL: "VINYL COMPOSITION TILE", MANUFACTURER: "ARMSTRONG", STYLE: "STANDARD EXCELON IMPERIAL", COLOR: "FORTRESS WHITE 51839", SIZE: '12" x 12"' }),
    ...dataRow({ CODE: "C", MATERIAL: "CONCRETE SEALER", MANUFACTURER: "SHERWIN WILLIAMS", STYLE: "H&C DECORATIVE", COLOR: "CLEAR" }),
    ...sectionRow("BASE"),
    ...dataRow({ CODE: "RB-1", MATERIAL: "RESILIENT BASE", MANUFACTURER: "VPI FLOORING", STYLE: "RUBBER WALL BASE", COLOR: "97 FAWN", SIZE: '4"' }),
    ...sectionRow("WALLS"),
    ...dataRow({ CODE: "P-1", MATERIAL: "PAINT", MANUFACTURER: "BENJAMIN MOORE", STYLE: "ECO SPEC EGGSHELL", COLOR: "WHITE 962" }),
    ...sectionRow("CEILINGS"),
    ...dataRow({ CODE: "ACT-1", MATERIAL: "ACOUSTICAL CEILING TILE", MANUFACTURER: "USG", STYLE: "2110 RADAR", COLOR: "WHITE", SIZE: "2' x 2'" }),
    ...sectionRow("MILLWORK"),
    ...dataRow({ CODE: "PLAM-1", MATERIAL: "PLASTIC LAMINATE", MANUFACTURER: "WILSONART", STYLE: "STANDARD HPL", COLOR: "MANITOBA MAPLE" }),
  ];
}

test("parses every data row and keeps them in order", () => {
  const rows = parseSchedule(sampleTokens());
  assert.deepEqual(rows.map((r) => r.finish_tag), ["CPT-1", "VCT-1", "C", "RB-1", "P-1", "ACT-1", "PLAM-1"]);
});

test("section headers drive category; ceilings + millwork start unchecked", () => {
  const rows = parseSchedule(sampleTokens());
  const by = Object.fromEntries(rows.map((r) => [r.finish_tag, r]));
  assert.equal(by["CPT-1"].category, "floor");
  assert.equal(by["RB-1"].category, "base");
  assert.equal(by["P-1"].category, "wall");
  assert.equal(by["ACT-1"].category, "ceiling");
  assert.equal(by["PLAM-1"].category, "other");
  // the ceiling ask: ACT-1 and PLAM-1 must NOT be pre-checked
  assert.equal(by["ACT-1"].suggested, false);
  assert.equal(by["PLAM-1"].suggested, false);
  assert.equal(rows.filter((r) => r.suggested).length, 5); // CPT-1, VCT-1, C, RB-1, P-1
});

test("column banding: blank SIZE cell does not steal COLOR, multi-word cells stay put", () => {
  const rows = parseSchedule(sampleTokens());
  const cpt = rows.find((r) => r.finish_tag === "CPT-1")!;
  assert.equal(cpt.description, "BROADLOOM CARPET");
  assert.equal(cpt.manufacturer, "J+J INVISION");
  assert.equal(cpt.style, "PAY DAY");
  assert.equal(cpt.spec_color, "1408 HIGH ROLLER"); // not smeared into SIZE
  assert.equal(cpt.size, "");                        // genuinely empty
  const vct = rows.find((r) => r.finish_tag === "VCT-1")!;
  assert.equal(vct.size, '12" x 12"');
  assert.equal(vct.spec_color, "FORTRESS WHITE 51839");
});

test("lone-letter code 'C' is a row; section words are never rows", () => {
  const rows = parseSchedule(sampleTokens());
  assert.ok(rows.some((r) => r.finish_tag === "C" && r.category === "floor"));
  assert.ok(!rows.some((r) => ["FLOORING", "BASE", "WALLS", "CEILINGS", "MILLWORK"].includes(r.finish_tag)));
});

test("rowToSeed applies category defaults and carries the product spec", () => {
  const rows = parseSchedule(sampleTokens());
  const palette = ["#111", "#222", "#333"];
  const p1 = rowToSeed(rows.find((r) => r.finish_tag === "P-1")!, 0, palette);
  assert.equal(p1.waste_pct, 10);      // wall default
  assert.equal(p1.hatch, "grid");
  assert.equal(p1.color, "#111");
  const act = rowToSeed(rows.find((r) => r.finish_tag === "ACT-1")!, 4, palette);
  assert.equal(act.waste_pct, 0);      // ceiling default
  assert.equal(act.color, palette[4 % palette.length]); // wraps the palette
  const vct = rowToSeed(rows.find((r) => r.finish_tag === "VCT-1")!, 1, palette);
  assert.deepEqual(vct.spec, { manufacturer: "ARMSTRONG", style: "STANDARD EXCELON IMPERIAL", color: "FORTRESS WHITE 51839", size: '12" x 12"' });
});

test("no header structure → no rows (nothing invented)", () => {
  assert.deepEqual(parseSchedule([]), []);
  const junk: Token[] = [
    { str: "GENERAL", x: 10, y: 10, h: 12 }, { str: "NOTES", x: 80, y: 10, h: 12 },
    { str: "FIELD", x: 10, y: 40, h: 12 }, { str: "VERIFY", x: 80, y: 40, h: 12 },
  ];
  assert.deepEqual(parseSchedule(junk), []);
});
