// Minimal SpreadsheetML (.xlsx) writer — hand-rolled, zipped with fflate
// (already a dependency; lazy-loaded like the ingest zip path — see #16).
// No SheetJS (stale npm package with CVEs), no exceljs (~1MB).
//
// Scope: exactly what the takeoff report needs — multiple worksheets of plain
// cells. Strings go out as inline strings (<c t="inlineStr"><is><t>…), numbers
// as plain <v>; no shared-strings table, no formulas (so pasted "=..." finish
// tags can never execute — inline strings are inert text), no column widths.
// A minimal styles.xml ships because Excel expects the part to exist.
//
// The workbook builder (reportWorkbook) reads the SAME sources as the CSV/JSON
// exports — conditionTotals rows through GETTERS, sheetTotals via roundSheetRow,
// materialsSummary, shapesDetail — so the four tabs carry the same numbers as
// the on-screen table: waste applied only to order quantities, never measured.

import { GETTERS, colGetter } from "./reportColumns.js";
import { grandTotals, materialsSummary, roundSheetRow, hasMultipliers, BY_SHEET_BASE_NOTE } from "./totals.js";

// ---------------------------------------------------------------------------
// XML plumbing

// Escape a value for XML text/attribute content. Also strips control chars
// that are illegal in XML 1.0 (condition names are user data — a pasted \x00
// must not produce a file Excel refuses to open). Keeps \t \n \r.
export function escXml(v) {
  return String(v)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // eslint-disable-line no-control-regex
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// 0 → A, 25 → Z, 26 → AA … (spreadsheet column letters)
export function colLetter(i) {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}

// Excel sheet-name rules: non-empty, ≤31 chars, no [ ] : * ? / \ , unique
// within the workbook (case-insensitive), no leading/trailing apostrophe.
// `used` is a Set of lower-cased names already taken; the returned name is
// added to it.
export function sanitizeSheetName(name, used = new Set()) {
  let s = String(name ?? "").replace(/[[\]:*?/\\]/g, "_").replace(/^'+|'+$/g, "").trim();
  if (!s) s = "Sheet";
  s = s.slice(0, 31).trim();
  let candidate = s;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    candidate = s.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

// One worksheet part from rows of cell values (array of arrays).
//   number (finite)      → <c r=… ><v>…</v></c>
//   null / undefined / "" → cell skipped entirely
//   anything else         → inline string, XML-escaped
export function sheetXml(rows) {
  const out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'];
  rows.forEach((cells, ri) => {
    out.push(`<row r="${ri + 1}">`);
    cells.forEach((v, ci) => {
      if (v === null || v === undefined || v === "") return;
      const ref = `${colLetter(ci)}${ri + 1}`;
      if (typeof v === "number" && Number.isFinite(v)) {
        out.push(`<c r="${ref}"><v>${v}</v></c>`);
      } else {
        const t = escXml(v);
        // preserve leading/trailing whitespace the way Excel expects
        const sp = /^\s|\s$/.test(String(v)) ? ' xml:space="preserve"' : "";
        out.push(`<c r="${ref}" t="inlineStr"><is><t${sp}>${t}</t></is></c>`);
      }
    });
    out.push("</row>");
  });
  out.push("</sheetData></worksheet>");
  return out.join("");
}

// The bare-minimum stylesheet — Excel treats fillId 0 (none) and 1 (gray125)
// as reserved, so both ship even though no cell references a style.
const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

// ---------------------------------------------------------------------------
// Workbook assembly

/**
 * Zip sheet definitions into an .xlsx byte array.
 * @param {Array<{name: string, rows: any[][]}>} sheets one entry per tab, in order
 * @returns {Promise<Uint8Array>} download with MIME
 *   application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
 */
export async function buildXlsx(sheets) {
  const { zipSync, strToU8 } = await import("fflate"); // lazy — same pattern as ingest.js
  const used = new Set();
  const names = sheets.map((s) => sanitizeSheetName(s.name, used));

  const contentTypes = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    ...sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
    "</Types>"].join("");

  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>";

  const workbook = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>',
    ...names.map((name, i) => `<sheet name="${escXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`),
    "</sheets></workbook>"].join("");

  const wbRels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`),
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    "</Relationships>"].join("");

  const files = {
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "xl/workbook.xml": strToU8(workbook),
    "xl/_rels/workbook.xml.rels": strToU8(wbRels),
    "xl/styles.xml": strToU8(STYLES_XML),
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s.rows)); });
  return zipSync(files);
}

// ---------------------------------------------------------------------------
// The takeoff report workbook: Conditions / By sheet / Materials / Shapes

/**
 * Map the report's data sources onto the four workbook tabs. Pure (no fflate)
 * so tests can assert the cell values directly.
 * @param {object} args
 * @param {any[]} args.rows conditionTotals() rows (shapeless conditions filtered out)
 * @param {Array<{sheet_id: any, rows: any[]}>} args.bySheet sheetTotals() result
 * @param {any[]} args.shapeRows shapesDetail() result
 * @param {Array<{key: string, header: string}>} [args.cols] visible CSV_PROFILE
 *   columns — the Conditions tab honors the same column picker the CSV uses
 * @param {{perimByCond?: Map<any, number>, attrsByCond?: Map<any, object>, specByCond?: Map<any, object>}|null}
 *   [args.ctx] handed to the getters
 * @param {((sheetId: any) => string)|null} [args.sheetLabel]
 * @returns {Array<{name: string, rows: any[][]}>}
 */
export function reportWorkbook({ rows = [], bySheet = [], shapeRows = [], cols = null, ctx = null, sheetLabel = null }) {
  const columns = cols || [];
  const label = (id) => (sheetLabel ? sheetLabel(id) : id);

  // Conditions — same columns, getters, and TOTAL row as totalsToCsv (per-
  // column get, i.e. custom columns, falls back to the shared GETTERS)
  const conditions = [columns.map((c) => c.header)];
  for (const r of rows) conditions.push(columns.map((c) => colGetter(c)?.(r, ctx)));
  const g = grandTotals(rows);
  conditions.push(columns.map((c) => {
    if (c.key === "finish") return "TOTAL";
    if (c.key === "waste_sf" || c.key === "waste_lf") return GETTERS[c.key](g);
    return g[c.key] !== undefined ? g[c.key] : "";
  }));

  // By sheet — base (unmultiplied) quantities, rounded at serialization only
  const bySheetRows = [["Sheet", "Sheet ID", "Finish", "Floor SF", "Wall SF", "Border SF", "LF", "EA"]];
  for (const gp of bySheet) {
    for (const row of gp.rows) {
      const mult = row.multiplier || 1;
      const finish = mult > 1 ? `${row.finish_tag} ×${mult}` : row.finish_tag;
      const r = roundSheetRow(row);
      bySheetRows.push([String(label(gp.sheet_id)), String(gp.sheet_id), finish, r.floor_sf, r.wall_sf, r.border_sf, r.lf, r.ea]);
    }
  }
  if (hasMultipliers(bySheet)) bySheetRows.push([], [BY_SHEET_BASE_NOTE]);

  // Materials — per condition, then the combined buy list (mirrors the CSV)
  const basisLabel = (b) => (b === "linear" ? "LF" : b === "count" ? "EA" : "SF");
  const materials = [["Finish", "Material", "Qty", "Unit", "Coverage", "Note"]];
  for (const r of rows) for (const m of (r.materials || [])) {
    materials.push([r.finish_tag, m.name, m.qty, m.unit, `1 ${m.unit || "unit"} / ${m.per} ${basisLabel(m.basis)}`, m.note || ""]);
  }
  const combined = materialsSummary(rows);
  if (combined.length) {
    materials.push([], ["Material (combined)", "Qty", "Unit"]);
    for (const s of combined) materials.push([s.name, s.qty, s.unit]);
  }

  // Shapes — measured only: no multiplier, no waste (shapesDetail semantics)
  const shapesTab = [
    ["Per-shape measured quantities — no multiplier or waste; deducts negative; LF on floor/deduct/surface rows is trace reference only (incl. openings) — linear rows alone sum to condition LF"],
    ["Shape", "Sheet", "Sheet ID", "Finish", "Role", "Area SF", "LF", "EA", "Height ft", "Height override", "Origin"],
  ];
  for (const r of shapeRows) {
    shapesTab.push([String(r.shape_id), String(r.sheet), String(r.sheet_id), r.finish, r.role,
      r.area_sf, r.lf, r.ea, r.height_ft, r.height_override ? "yes" : "", r.origin]);
  }

  return [
    { name: "Conditions", rows: conditions },
    { name: "By sheet", rows: bySheetRows },
    { name: "Materials", rows: materials },
    { name: "Shapes", rows: shapesTab },
  ];
}
