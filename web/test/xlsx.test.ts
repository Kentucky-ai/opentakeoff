import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
// xlsx.js is plain JS (allowJs); the tsx loader resolves it from the .ts test.
import { escXml, colLetter, sanitizeSheetName, sheetXml, buildXlsx, reportWorkbook } from "../src/lib/xlsx.js";
import { conditionTotals, sheetTotals, sheetLabelGroupedRows, round2, grandTotals } from "../src/lib/totals.js";
import { CSV_PROFILE, customColProfile, specColProfile, visibleCols } from "../src/lib/reportColumns.js";
import { shapesDetail } from "../src/lib/shapesExport.js";
import i18n from "../src/i18n/index.js";

const root = path.resolve(import.meta.dirname, "..");
function loadJson(locale: string, ns: string): Record<string, unknown> {
  const p = path.join(root, "public", "locales", locale, `${ns}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

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

test("reportWorkbook: five tabs, Conditions mirrors the CSV columns and numbers", () => {
  const tabs = reportWorkbook(workbookArgs());
  assert.deepEqual(tabs.map((t: any) => t.name), ["Conditions", "By sheet", "Materials", "Shapes", "By floor × room"]);

  const [cTab, sheetTab, matTab, shapeTab] = tabs;
  // header row = the same headers the CSV emits
  assert.deepEqual(cTab.rows[0], cols.map((c: any) => c.header));
  const idx = (h: string) => cols.findIndex((c: any) => c.header === h);
  const r1 = cTab.rows[1]; // c1: 100 SF, 10% waste
  assert.equal(r1[idx("Finish")], NASTY);
  assert.equal(r1[idx("Total SF")], 100);            // measured — no waste
  assert.equal(r1[idx("Total SF w/Waste")], 110); // waste only on the w/Waste qty
  const r2 = cTab.rows[2]; // c2: linear 25 LF ×2 multiplier
  assert.equal(r2[idx("LF")], 50);
  assert.equal(r2[idx("LF w/Waste")], 50); // 0% waste
  // TOTAL row
  const total = cTab.rows[cTab.rows.length - 1];
  assert.equal(total[0], "TOTAL");
  assert.equal(total[idx("Total SF w/Waste")], 110);

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

test("reportWorkbook: metric material coverage converts canonical rates and labels", () => {
  const tabs = reportWorkbook({ ...workbookArgs(), units: "metric" });
  const materials = tabs[2].rows;
  const adhesive = materials.find((r: any[]) => r[1] === "Adhesive");
  assert.ok(adhesive);
  assert.equal(adhesive![4], "1 bucket / 9.29 m²");
});

test("reportWorkbook: pt-BR metric seam basis uses localized label (costura m, not seam m)", async () => {
  await i18n.changeLanguage("pt-br");
  const seamConds = [{ id: "c1", finish_tag: "CPT-1", materials: [{ name: "Weld rod", unit: "roll", per: 10, basis: "seam_lf" }] }];
  const seamShapes = [{ id: "s1", sheet_id: "plan.pdf#1", condition_id: "c1", measure_role: "floor_area", computed: { area_sf: 100, perimeter_lf: 40 } }];
  const tabs = reportWorkbook({
    rows: conditionTotals(seamConds as any, seamShapes as any).filter((r: any) => r.shape_count > 0),
    bySheet: sheetTotals(seamConds as any, seamShapes as any),
    shapeRows: shapesDetail(seamConds as any, seamShapes as any),
    cols: visibleCols(CSV_PROFILE, {}),
    units: "metric",
  });
  const materials = tabs[2].rows;
  const weldRod = materials.find((r: any[]) => r[1] === "Weld rod");
  assert.ok(weldRod, "Weld rod row found");
  // Coverage should say "costura m" in pt-BR metric, not "seam m"
  const coverage = String(weldRod[4]);
  assert.ok(coverage.includes("costura m"), `pt-BR metric must use "costura m": ${coverage}`);
  assert.ok(!coverage.includes("seam"), `pt-BR metric must not contain "seam": ${coverage}`);
  await i18n.changeLanguage("en");
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

// ── the floor × room tab ────────────────────────────────────────────────────
// The cross-section the other tabs each flatten one axis out of. Its whole job
// is reconciliation: a reader adding up a floor's rooms must land on the
// floor's own total, which is why an unlabeled floor still gets a roll-up row.

test("reportWorkbook: floor × room tab — one row per (floor, room, finish), ordered quantities", () => {
  const labeled = [
    { id: "s1", sheet_id: "plan.pdf#1", condition_id: "c1", label: "101", measure_role: "floor_area", computed: { area_sf: 60, perimeter_lf: 32 } },
    { id: "s2", sheet_id: "plan.pdf#1", condition_id: "c1", label: "102", measure_role: "floor_area", computed: { area_sf: 40, perimeter_lf: 26 } },
    { id: "s3", sheet_id: "plan.pdf#2", condition_id: "c2", measure_role: "linear", computed: { perimeter_lf: 25, area_sf: 0 } },
  ];
  const tabs = reportWorkbook({
    ...workbookArgs(),
    byFloorRoom: sheetLabelGroupedRows(conds as any, labeled as any, ["101", "102"]),
  });
  const tab = tabs[4];
  assert.deepEqual(tab.rows[1], ["Sheet", "Sheet ID", "Room", "Finish", "Floor SF", "Wall SF", "Border SF", "LF", "EA", "Total SF", "Total SF w/Waste"]);
  const body = tab.rows.slice(2);
  assert.deepEqual(body.map((r: any[]) => [r[1], r[2], r[3]]), [
    ["plan.pdf#1", "101", NASTY],
    ["plan.pdf#1", "102", NASTY],
    ["plan.pdf#2", "Unlabeled", "VCT-1"],   // an unlabeled floor still rolls up, so its rooms reconcile
  ]);
  assert.equal(body[0][4], 60);
  assert.equal(body[0][10], 66, "10% waste applied per slice, like the report's grouped views");
  // the two rooms add back to the floor's own by-sheet total
  assert.equal(body[0][4] + body[1][4], 100);
  assert.equal(body[2][7], 50, "×2 multiplier applied per slice — ORDERED, unlike the base By-sheet tab");
});

test("reportWorkbook: floor × room tab is always present, header-only when nothing is grouped", () => {
  const tab = reportWorkbook(workbookArgs())[4];         // workbookArgs passes no byFloorRoom
  assert.equal(tab.name, "By floor × room");
  assert.equal(tab.rows.length, 2, "note + header, no body");
});

test("buildXlsx: package parts exist, workbook lists five sheets, XML well-formed, values escaped", async () => {
  const bytes = await buildXlsx(reportWorkbook(workbookArgs()));
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0);
  // zip magic
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);

  const parts = unzipSync(bytes);
  for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml",
    "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml", "xl/worksheets/sheet4.xml", "xl/worksheets/sheet5.xml"]) {
    assert.ok(parts[name], `missing ${name}`);
  }

  const wb = strFromU8(parts["xl/workbook.xml"]);
  assertBalanced(wb);
  for (const [i, name] of ["Conditions", "By sheet", "Materials", "Shapes", "By floor × room"].entries()) {
    assert.ok(wb.includes(`<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`), `workbook missing ${name}`);
  }

  const sheet1 = strFromU8(parts["xl/worksheets/sheet1.xml"]);
  assertBalanced(sheet1);
  assert.ok(sheet1.includes("CPT &amp; &lt;Tile&gt; &quot;A&quot;"), "condition name escaped");
  assert.ok(!sheet1.includes(NASTY), "raw specials must not appear");
  assert.ok(sheet1.includes("<v>110</v>"), "numeric order quantity as a number cell");

  for (const n of [2, 3, 4, 5]) assertBalanced(strFromU8(parts[`xl/worksheets/sheet${n}.xml`]));
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

// ── locale × unit-system matrix for ALL XLSX tabs (P2 metric-export fix) ───
// Regression: metric mode must never leak SF/LF/ft into headers; imperial must
// keep them.  Tests cover Conditions, By-sheet, Shapes, and By floor×room tabs.

const LOCALES = ["en", "pt-br"] as const;
const SYSTEMS = ["imperial", "metric"] as const;

// Helper to get _t for localized tab name matching
const _tXlsx = (key: string) => i18n.t(key, { ns: "lib" });

// True when a string carries " SF ", " LF ", or " ft" (with optional trailing
// punctuation) outside interpolation variables.
const hasBareImperial = (s: string) => /\bSF\b|\bLF\b|\bft\b/.test(s);

for (const locale of LOCALES) {
  for (const system of SYSTEMS) {
    // ── Shapes tab height header ──────────────────────────────────────────
    test(`${locale}/${system} reportWorkbook shapes tab uses localized height header`, async () => {
      await i18n.changeLanguage(locale);
      const tabs = reportWorkbook({ ...workbookArgs(), units: system });
      const shapeTab = tabs.find((t: any) => t.name === _tXlsx("xlsx.tab_shapes"))
        || tabs.find((t: any) => t.name === "Shapes");
      assert.ok(shapeTab, "Shapes tab not found");
      const headerRow = shapeTab.rows[1];
      const heightCol = headerRow.find((h: string) =>
        h.includes("Height") || h.includes("Altura"));
      assert.ok(heightCol, `height column not found in shapes header: ${headerRow}`);

      if (system === "metric") {
        assert.ok(!heightCol.includes("pés"),
          `${locale}/${system} shapes height header must not contain "pés": ${heightCol}`);
        assert.ok(!heightCol.includes("ft"),
          `${locale}/${system} shapes height header must not contain "ft": ${heightCol}`);
        assert.ok(heightCol.includes("m"),
          `${locale}/${system} shapes height header must contain "m": ${heightCol}`);
      } else {
        assert.ok(heightCol.includes("ft"),
          `${locale}/${system} shapes height header must contain "ft": ${heightCol}`);
      }
    });

    // ── Conditions tab: metric headers must not leak SF/LF/ft ─────────────
    test(`${locale}/${system} reportWorkbook Conditions tab headers respect unit system`, async () => {
      await i18n.changeLanguage(locale);
      const tabs = reportWorkbook({ ...workbookArgs(), units: system });
      const cTab = tabs[0];  // Conditions is the first tab
      assert.ok(cTab, "Conditions tab not found");
      const headerRow = cTab.rows[0] as string[];
      const allHeaders = headerRow.join(" ");

      if (system === "metric") {
        assert.ok(!allHeaders.includes("SF"), `Conditions metric headers must not contain "SF": ${headerRow}`);
        assert.ok(!allHeaders.includes(" LF "), `Conditions metric headers must not contain " LF ": ${headerRow}`);
        assert.ok(allHeaders.includes("m"), `Conditions metric headers must contain "m": ${headerRow}`);
      } else {
        const sfHeaders = headerRow.filter((h: string) =>
          h.includes("Total SF") || h.includes("Floor SF") || h.includes("Wall SF") || h.includes("Border SF"));
        const lfHeaders = headerRow.filter((h: string) => /\bLF\b/.test(h));
        assert.ok(sfHeaders.length > 0, `Conditions imperial headers must contain SF: ${headerRow}`);
        assert.ok(lfHeaders.length > 0, `Conditions imperial headers must contain LF: ${headerRow}`);
      }
    });

    // ── By-sheet tab: metric headers must not leak SF/LF ──────────────────
    test(`${locale}/${system} reportWorkbook By-sheet tab headers respect unit system`, async () => {
      await i18n.changeLanguage(locale);
      const tabs = reportWorkbook({ ...workbookArgs(), units: system });
      const sheetTab = tabs.find((t: any) =>
        t.name === _tXlsx("xlsx.tab_by_sheet")) || tabs.find((t: any) => t.name === "By sheet");
      assert.ok(sheetTab, "By-sheet tab not found");
      const headerRow = sheetTab.rows[0] as string[];
      const allHeaders = headerRow.join(" ");

      if (system === "metric") {
        assert.ok(!allHeaders.includes("SF"), `By-sheet metric headers must not contain "SF": ${headerRow}`);
        assert.ok(!allHeaders.includes("LF"), `By-sheet metric headers must not contain "LF": ${headerRow}`);
        assert.ok(allHeaders.includes("m"), `By-sheet metric headers must contain "m": ${headerRow}`);
      } else {
        assert.ok(allHeaders.includes("SF"), `By-sheet imperial headers must contain "SF": ${headerRow}`);
        assert.ok(allHeaders.includes("LF"), `By-sheet imperial headers must contain "LF": ${headerRow}`);
      }
    });

    // ── Shapes tab: area/LF headers must not leak SF/LF in metric ─────────
    test(`${locale}/${system} reportWorkbook Shapes tab area/LF headers respect unit system`, async () => {
      await i18n.changeLanguage(locale);
      const tabs = reportWorkbook({ ...workbookArgs(), units: system });
      const shapeTab = tabs.find((t: any) => t.name === _tXlsx("xlsx.tab_shapes"))
        || tabs.find((t: any) => t.name === "Shapes");
      assert.ok(shapeTab, "Shapes tab not found");
      const headerRow = shapeTab.rows[1] as string[];
      const allHeaders = headerRow.join(" ");

      if (system === "metric") {
        assert.ok(!allHeaders.includes(" SF "), `Shapes metric headers must not contain " SF ": ${headerRow}`);
        assert.ok(!allHeaders.includes(" LF "), `Shapes metric headers must not contain " LF ": ${headerRow}`);
        assert.ok(!allHeaders.includes(" ft"), `Shapes metric headers must not contain " ft": ${headerRow}`);
        assert.ok(allHeaders.includes("m²") || allHeaders.includes("m2"),
          `Shapes metric headers must contain m²: ${headerRow}`);
      } else {
        assert.ok(allHeaders.includes("SF"), `Shapes imperial headers must contain "SF": ${headerRow}`);
        assert.ok(allHeaders.includes("LF") || allHeaders.includes("ft"),
          `Shapes imperial headers must contain "LF" or "ft": ${headerRow}`);
      }
    });

    // ── By floor×room tab: metric headers must not leak SF/LF ─────────────
    test(`${locale}/${system} reportWorkbook floor×room tab headers respect unit system`, async () => {
      await i18n.changeLanguage(locale);
      const labeled = [
        { id: "s1", sheet_id: "plan.pdf#1", condition_id: "c1", label: "101", measure_role: "floor_area", computed: { area_sf: 60, perimeter_lf: 32 } },
        { id: "s2", sheet_id: "plan.pdf#2", condition_id: "c2", measure_role: "linear", computed: { perimeter_lf: 25, area_sf: 0 } },
      ];
      const tabs = reportWorkbook({
        ...workbookArgs(),
        units: system,
        byFloorRoom: sheetLabelGroupedRows(conds as any, labeled as any, ["101"]),
      });
      const tab = tabs.find((t: any) =>
        t.name === _tXlsx("xlsx.tab_floor_room")) || tabs.find((t: any) => t.name === "By floor × room");
      assert.ok(tab, "Floor×room tab not found");
      const headerRow = tab.rows[1] as string[];
      const allHeaders = headerRow.join(" ");

      if (system === "metric") {
        assert.ok(!allHeaders.includes("SF"), `floor×room metric headers must not contain "SF": ${headerRow}`);
        assert.ok(!allHeaders.includes("LF"), `floor×room metric headers must not contain "LF": ${headerRow}`);
        assert.ok(allHeaders.includes("m"), `floor×room metric headers must contain "m": ${headerRow}`);
      } else {
        assert.ok(allHeaders.includes("SF"), `floor×room imperial headers must contain "SF": ${headerRow}`);
        assert.ok(allHeaders.includes("LF"), `floor×room imperial headers must contain "LF": ${headerRow}`);
      }
    });

    // ── Shapes tab data values: metric converts area/LF/height ────────────
    test(`${locale}/${system} reportWorkbook Shapes tab data values convert correctly`, async () => {
      await i18n.changeLanguage(locale);
      const tabs = reportWorkbook({ ...workbookArgs(), units: system });
      const shapeTab = tabs.find((t: any) => t.name === _tXlsx("xlsx.tab_shapes"))
        || tabs.find((t: any) => t.name === "Shapes");
      assert.ok(shapeTab, "Shapes tab not found");
      // Data rows start at index 2 (0 = note, 1 = header)
      const dataRows = shapeTab.rows.slice(2);
      assert.ok(dataRows.length > 0, "Shapes tab has data rows");

      const M2 = 0.09290304;
      const M = 0.3048;
      if (system === "metric") {
        // s1: floor_area 100 SF, perimeter_lf 40
        const s1 = dataRows.find((r: any[]) => r[0] === "s1");
        assert.ok(s1, "s1 row found");
        assert.equal(s1[5], 9.29, "metric area_sf converted (100 SF → 9.29 m²)");
        assert.equal(s1[6], round2(40 * M), "metric lf converted (40 LF → 12.19 m)");
      } else {
        // imperial: raw internal feet
        const s1 = dataRows.find((r: any[]) => r[0] === "s1");
        assert.ok(s1, "s1 row found");
        assert.equal(s1[5], 100, "imperial area_sf unchanged");
        assert.equal(s1[6], 40, "imperial lf unchanged");
      }
    });

    // ── Materials tab: metric coverage uses m² not SF ─────────────────────
    test(`${locale}/${system} reportWorkbook Materials tab uses correct unit labels`, async () => {
      await i18n.changeLanguage(locale);
      const tabs = reportWorkbook({ ...workbookArgs(), units: system });
      const matTab = tabs[2];  // Materials is the third tab
      assert.ok(matTab, "Materials tab not found");
      const adhesive = matTab.rows.find((r: any[]) => r[1] === "Adhesive");
      assert.ok(adhesive, "Adhesive row found");
      // Coverage column (index 4) contains the rate
      const coverage = String(adhesive[4]);
      if (system === "metric") {
        assert.ok(coverage.includes("m²"), `metric materials coverage must use m²: ${coverage}`);
        assert.ok(!/\bSF\b/.test(coverage), `metric materials coverage must not contain "SF": ${coverage}`);
      } else {
        assert.ok(coverage.includes("SF"), `imperial materials coverage must contain "SF": ${coverage}`);
      }
    });
  }
}

// ── en/metric value assertions: use column keys, not header text ──────────
// These verify actual converted values against M2_PER_SF/M_PER_FT constants
// for Conditions, By-sheet, and floor×room tabs, avoiding locale-fragile
// header string matching.

test("en/metric Conditions tab values convert against M2_PER_SF/M_PER_FT", async () => {
  await i18n.changeLanguage("en");
  const M2 = 0.09290304, M = 0.3048;
  const tabs = reportWorkbook({ ...workbookArgs(), units: "metric" });
  const cTab = tabs[0];
  const headerRow = cTab.rows[0] as string[];
  // Find column indices by stable English header text
  const totalSfIdx = headerRow.findIndex((h: string) => h === "Total m²");
  const totalNetIdx = headerRow.findIndex((h: string) => h === "Total m² w/Waste");
  const lfIdx = headerRow.findIndex((h: string) => h === "m");
  assert.ok(totalSfIdx >= 0, "Total m2 column found");
  assert.ok(totalNetIdx >= 0, "Total m2 w/Waste column found");
  assert.ok(lfIdx >= 0, "m column found for LF");
  // c1 row (100 SF, 10% waste)
  const r1 = cTab.rows[1] as any[];
  assert.equal(r1[totalSfIdx], round2(100 * M2), "c1 total_sf: 100 SF → m2");
  assert.equal(r1[totalNetIdx], round2(110 * M2), "c1 total_sf_net: 110 SF → m2");
  // c2 row (25 LF × 2 multiplier = 50 LF)
  const r2 = cTab.rows[2] as any[];
  assert.equal(r2[lfIdx], round2(50 * M), "c2 lf: 50 LF → m");
  // TOTAL row
  const totalRow = cTab.rows[cTab.rows.length - 1] as any[];
  const testRows = conditionTotals(conds as any, shapes as any).filter((r: any) => r.shape_count > 0);
  const g = grandTotals(testRows);
  assert.equal(totalRow[totalSfIdx], round2(g.total_sf * M2), "TOTAL total_sf converted");
  assert.equal(totalRow[lfIdx], round2(g.lf * M), "TOTAL lf converted");
});

test("en/metric By-sheet tab values convert against M2_PER_SF/M_PER_FT", async () => {
  await i18n.changeLanguage("en");
  const M2 = 0.09290304, M = 0.3048;
  const tabs = reportWorkbook({ ...workbookArgs(), units: "metric" });
  const sheetTab = tabs.find((t: any) => t.name === "By sheet");
  assert.ok(sheetTab, "By-sheet tab not found");
  const headerRow = sheetTab.rows[0] as string[];
  const floorIdx = headerRow.findIndex((h: string) => h === "Floor m²");
  const lfIdx = headerRow.findIndex((h: string) => h === "m");
  assert.ok(floorIdx >= 0, "Floor m2 column found");
  assert.ok(lfIdx >= 0, "m column found");
  // Data row for plan.pdf#1: c1 floor_area 100 SF
  const dataRows = sheetTab.rows.slice(1) as any[];
  const s1Row = dataRows.find((r: any[]) => r[1] === "plan.pdf#1");
  assert.ok(s1Row, "plan.pdf#1 row found");
  assert.equal(s1Row[floorIdx], round2(100 * M2), "s1 floor_sf: 100 SF → m2");
});

test("en/metric floor×room tab values convert against M2_PER_SF/M_PER_FT", async () => {
  await i18n.changeLanguage("en");
  const M2 = 0.09290304;
  const labeled = [
    { id: "s1", sheet_id: "plan.pdf#1", condition_id: "c1", label: "101", measure_role: "floor_area", computed: { area_sf: 60, perimeter_lf: 32 } },
  ];
  const tabs = reportWorkbook({
    ...workbookArgs(),
    units: "metric",
    byFloorRoom: sheetLabelGroupedRows(conds as any, labeled as any, ["101"]),
  });
  const tab = tabs.find((t: any) => t.name === "By floor × room");
  assert.ok(tab, "Floor×room tab not found");
  const headerRow = tab.rows[1] as string[];
  const floorIdx = headerRow.findIndex((h: string) => h === "Floor m²");
  assert.ok(floorIdx >= 0, "Floor m2 column found in floor×room");
  // Data row: c1 on plan.pdf#1, label 101, 60 SF
  const dataRow = tab.rows[2] as any[];
  assert.equal(dataRow[floorIdx], round2(60 * M2), "floor×room floor_sf: 60 SF → m2");
});

// Restore default locale
test("restore en locale after xlsx value assertions", async () => {
  await i18n.changeLanguage("en");
});
