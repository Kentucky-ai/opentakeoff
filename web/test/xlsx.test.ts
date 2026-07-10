import { test } from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
// xlsx.js is plain JS (allowJs); the tsx loader resolves it from the .ts test.
import { escXml, colLetter, sanitizeSheetName, sheetXml, buildXlsx, reportWorkbook } from "../src/lib/xlsx.js";
import { conditionTotals, sheetTotals } from "../src/lib/totals.js";
import { CSV_PROFILE, customColProfile, specColProfile, visibleCols } from "../src/lib/reportColumns.js";
import { shapesDetail } from "../src/lib/shapesExport.js";

// ---------------------------------------------------------------------------
// helpers

// Well-formedness check for the XML we emit: every open tag closes, in order.
// Not a full parser — enough to catch an unbalanced <row>/<c>/<is> emitter bug.
function assertBalanced(xml: string) {
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1]) assert.equal(stack.pop(), m[2], `closing </${m[2]}> without matching open`);
    else if (!m[4]) stack.push(m[2]);
  }
  assert.deepEqual(stack, [], "unclosed tags remain");
  // no raw & or < may survive outside markup
  const text = xml.replace(/<[^>]*>/g, "");
  assert.ok(!/[<]/.test(text), "raw < in text content");
  assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);)/.test(text), "unescaped & in text content");
}

// fixture: two conditions — one with hostile name + waste + a material, one ×2
// multiplier linear — across two sheets
const NASTY = 'CPT & <Tile> "A"';
const conds = [
  { id: "c1", finish_tag: NASTY, color: "#112233", waste_pct: 10, materials: [{ name: "Adhesive", unit: "bucket", per: 100, basis: "area" }] },
  { id: "c2", finish_tag: "VCT-1", color: "#445566", multiplier: 2 },
];
const shapes = [
  { id: "s1", sheet_id: "plan.pdf#1", condition_id: "c1", measure_role: "floor_area", computed: { area_sf: 100, perimeter_lf: 40 } },
  { id: "s2", sheet_id: "plan.pdf#2", condition_id: "c2", measure_role: "linear", computed: { perimeter_lf: 25, area_sf: 0 } },
];
const cols = visibleCols(CSV_PROFILE, {});
const workbookArgs = () => ({
  rows: conditionTotals(conds as any, shapes as any).filter((r: any) => r.shape_count > 0),
  bySheet: sheetTotals(conds as any, shapes as any),
  shapeRows: shapesDetail(conds as any, shapes as any, (id: any) => `Sheet ${id}`),
  cols,
  ctx: null,
  sheetLabel: (id: any) => `Sheet ${id}`,
});

// ---------------------------------------------------------------------------
// unit pieces

test("escXml: the five XML specials escape; control chars strip; tab/newline survive", () => {
  assert.equal(escXml('a & b < c > d " e \' f'), "a &amp; b &lt; c &gt; d &quot; e &apos; f");
  assert.equal(escXml("x" + String.fromCharCode(0, 7, 31) + "y"), "xy");
  assert.equal(escXml("a\tb\nc"), "a\tb\nc");
});

test("colLetter: A..Z, AA rollover, ZZ→AAA", () => {
  assert.equal(colLetter(0), "A");
  assert.equal(colLetter(25), "Z");
  assert.equal(colLetter(26), "AA");
  assert.equal(colLetter(27), "AB");
  assert.equal(colLetter(701), "ZZ");
  assert.equal(colLetter(702), "AAA");
});

test("sanitizeSheetName: forbidden chars, length cap, empties, uniqueness", () => {
  const used = new Set<string>();
  assert.equal(sanitizeSheetName("By sheet", used), "By sheet");
  assert.equal(sanitizeSheetName("a[b]c:d*e?f/g\\h", used), "a_b_c_d_e_f_g_h");
  assert.equal(sanitizeSheetName("", used), "Sheet");
  assert.equal(sanitizeSheetName(null, used), "Sheet (2)"); // empty again → deduped
  const long = sanitizeSheetName("x".repeat(40), used);
  assert.equal(long.length, 31);
  const long2 = sanitizeSheetName("x".repeat(40), used); // same 31-char prefix → suffixed within 31
  assert.equal(long2.length, 31);
  assert.ok(long2.endsWith("(2)"));
  assert.equal(sanitizeSheetName("BY SHEET", used), "BY SHEET (2)"); // case-insensitive dedupe
});

test("sheetXml: numbers as <v>, strings as inline strings, empty cells skipped, refs correct", () => {
  const xml = sheetXml([["Finish", "SF"], [NASTY, 42.5], ["", 0]]);
  assertBalanced(xml);
  assert.ok(xml.includes('<c r="A2" t="inlineStr"><is><t>CPT &amp; &lt;Tile&gt; &quot;A&quot;</t></is></c>'));
  assert.ok(xml.includes('<c r="B2"><v>42.5</v></c>'));
  assert.ok(xml.includes('<c r="B3"><v>0</v></c>'), "numeric 0 is a real cell");
  assert.ok(!xml.includes('r="A3"'), "empty string cell is skipped");
});

test("sheetXml: leading/trailing whitespace gets xml:space=preserve", () => {
  const xml = sheetXml([[" padded "]]);
  assert.ok(xml.includes('<t xml:space="preserve"> padded </t>'));
});

// ---------------------------------------------------------------------------
// the report workbook

test("reportWorkbook: four tabs, Conditions mirrors the CSV columns and numbers", () => {
  const tabs = reportWorkbook(workbookArgs());
  assert.deepEqual(tabs.map((t: any) => t.name), ["Conditions", "By sheet", "Materials", "Shapes"]);

  const [cTab, sheetTab, matTab, shapeTab] = tabs;
  // header row = the same headers the CSV emits
  assert.deepEqual(cTab.rows[0], cols.map((c: any) => c.header));
  const idx = (h: string) => cols.findIndex((c: any) => c.header === h);
  const r1 = cTab.rows[1]; // c1: 100 SF, 10% waste
  assert.equal(r1[idx("Finish")], NASTY);
  assert.equal(r1[idx("Total SF")], 100);            // measured — no waste
  assert.equal(r1[idx("Total SF (w/ waste)")], 110); // waste only on the order qty
  const r2 = cTab.rows[2]; // c2: linear 25 LF ×2 multiplier
  assert.equal(r2[idx("LF")], 50);
  assert.equal(r2[idx("LF (w/ waste)")], 50); // 0% waste
  // TOTAL row
  const total = cTab.rows[cTab.rows.length - 1];
  assert.equal(total[0], "TOTAL");
  assert.equal(total[idx("Total SF (w/ waste)")], 110);

  // By sheet: base quantities (no ×2 on the c2 row), label + raw id + ×N tag
  assert.deepEqual(sheetTab.rows[0], ["Sheet", "Sheet ID", "Finish", "Floor SF", "Wall SF", "Border SF", "LF", "EA"]);
  const vct = sheetTab.rows.find((r: any[]) => r[1] === "plan.pdf#2");
  assert.ok(vct);
  assert.equal(vct![0], "Sheet plan.pdf#2");
  assert.equal(vct![2], "VCT-1 ×2");
  assert.equal(vct![6], 25); // base LF, multiplier NOT applied

  // Materials: per-condition row + combined section
  assert.deepEqual(matTab.rows[0], ["Finish", "Material", "Qty", "Unit", "Coverage", "Note"]);
  const adhesive = matTab.rows.find((r: any[]) => r[1] === "Adhesive");
  assert.ok(adhesive);
  assert.equal(adhesive![2], 1); // ceil(100 SF measured / 100 per) — coverage runs on the MEASURED basis, never waste-adjusted
  assert.ok(matTab.rows.some((r: any[]) => r[0] === "Material (combined)"));

  // Shapes: note row, header, one row per shape, measured only
  assert.deepEqual(shapeTab.rows[1].slice(0, 5), ["Shape", "Sheet", "Sheet ID", "Finish", "Role"]);
  assert.equal(shapeTab.rows.length, 2 + shapes.length);
  const s2 = shapeTab.rows.find((r: any[]) => r[0] === "s2");
  assert.equal(s2![6], 25); // measured LF — no multiplier
});

test("reportWorkbook: custom column in cols — header, per-row value, blank TOTAL cell", () => {
  const custom = customColProfile([{ id: "div", name: "CSI Division", values: ["09 30 00"] }]);
  const tabs = reportWorkbook({
    ...workbookArgs(),
    cols: [...cols, ...custom],
    ctx: { attrsByCond: new Map([["c1", { div: "09 30 00" }]]) },
  });
  const cTab = tabs[0];
  const ci = cols.length;                        // appended after the CSV columns
  assert.equal(cTab.rows[0][ci], "CSI Division");
  assert.equal(cTab.rows[1][ci], "09 30 00");    // c1 assigned
  assert.equal(cTab.rows[2][ci], "");            // c2 unassigned → cell skipped in the XML
  assert.equal(cTab.rows[cTab.rows.length - 1][ci], ""); // TOTAL stays blank
});

test("reportWorkbook: read-only spec columns in cols — header, per-row value, blank TOTAL cell", () => {
  const spec = specColProfile([
    { id: "c1", spec: { manufacturer: "Shaw", color: "Slate 5" } },  // both fields present
  ] as any);
  assert.deepEqual(spec.map((c: any) => c.header), ["Manufacturer", "Spec Color"]); // only populated fields
  const tabs = reportWorkbook({
    ...workbookArgs(),
    cols: [...cols, ...spec],
    ctx: { specByCond: new Map([["c1", { manufacturer: "Shaw", color: "Slate 5" }]]) },
  });
  const cTab = tabs[0];
  const mi = cols.length;          // Manufacturer appended after the CSV columns
  assert.equal(cTab.rows[0][mi], "Manufacturer");
  assert.equal(cTab.rows[0][mi + 1], "Spec Color");
  assert.equal(cTab.rows[1][mi], "Shaw");         // c1 spec'd
  assert.equal(cTab.rows[1][mi + 1], "Slate 5");
  assert.equal(cTab.rows[2][mi], "");             // c2 has no spec → cell skipped in the XML
  assert.equal(cTab.rows[cTab.rows.length - 1][mi], ""); // TOTAL stays blank
});

test("reportWorkbook: materials quantity matches conditionTotals (measured basis, whole units)", () => {
  const rows = conditionTotals(conds as any, shapes as any);
  const tabs = reportWorkbook(workbookArgs());
  const adhesive = tabs[2].rows.find((r: any[]) => r[1] === "Adhesive");
  assert.equal(adhesive![2], rows[0].materials[0].qty);
});

// ---------------------------------------------------------------------------
// the zipped package

test("buildXlsx: package parts exist, workbook lists four sheets, XML well-formed, values escaped", async () => {
  const bytes = await buildXlsx(reportWorkbook(workbookArgs()));
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0);
  // zip magic
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);

  const parts = unzipSync(bytes);
  for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml",
    "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml", "xl/worksheets/sheet4.xml"]) {
    assert.ok(parts[name], `missing ${name}`);
  }

  const wb = strFromU8(parts["xl/workbook.xml"]);
  assertBalanced(wb);
  for (const [i, name] of ["Conditions", "By sheet", "Materials", "Shapes"].entries()) {
    assert.ok(wb.includes(`<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`), `workbook missing ${name}`);
  }

  const sheet1 = strFromU8(parts["xl/worksheets/sheet1.xml"]);
  assertBalanced(sheet1);
  assert.ok(sheet1.includes("CPT &amp; &lt;Tile&gt; &quot;A&quot;"), "condition name escaped");
  assert.ok(!sheet1.includes(NASTY), "raw specials must not appear");
  assert.ok(sheet1.includes("<v>110</v>"), "numeric order quantity as a number cell");

  for (const n of [2, 3, 4]) assertBalanced(strFromU8(parts[`xl/worksheets/sheet${n}.xml`]));
  assertBalanced(strFromU8(parts["[Content_Types].xml"]));
  assertBalanced(strFromU8(parts["xl/_rels/workbook.xml.rels"]));
});

test("buildXlsx: hostile tab names are sanitized and deduped in workbook.xml", async () => {
  const bytes = await buildXlsx([
    { name: "bad[]:*?/\\name that keeps going well past thirty-one", rows: [["x"]] },
    { name: "bad[]:*?/\\name that keeps going well past thirty-one", rows: [["y"]] },
    { name: "", rows: [[1]] },
  ]);
  const wb = strFromU8(unzipSync(bytes)["xl/workbook.xml"]);
  const names = [...wb.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(names.length, 3);
  for (const n of names) {
    assert.ok(n.length >= 1 && n.length <= 31, `bad length: ${n}`);
    assert.ok(!/[[\]:*?/\\]/.test(n), `forbidden char survived: ${n}`);
  }
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, 3, "names must be unique");
});
