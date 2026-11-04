// Priced estimate → Excel tabs (rows of cells for lib/xlsx.js buildXlsx).
// Pure: takes a priceEstimate() result (lib/estimate.js) and returns the same
// numbers the Estimate panel shows. Values only, never formulas (the xlsx.js
// rule: a pasted "=..." finish tag stays inert text). A rate that was never
// entered is an EMPTY cell, not 0, and the line's Status says so.
//
// The watermark is not optional. Every tab opens with the project line, closes
// with OT_WATERMARK, and carries it as the printed page footer, in every
// branding mode — there is no parameter that turns it off, and stampWorkbook
// runs last on every workbook this module returns.

import { OT_WATERMARK } from "./branding.js";
import { lineLabel } from "./estimate.js";

const MODE = { markup: "markup on cost", margin: "margin of price" };
const STATUS = { priced: "priced", partial: "partly priced", unpriced: "unpriced" };
const rate = (v) => (v === null || v === undefined ? "" : v);

/**
 * Put the OpenTakeoff line on every tab: the last row and the print footer.
 * Idempotent; exported so the guarantee is testable on its own.
 * @param {Array<{name: string, rows: any[][], footer?: string}>} sheets
 */
export function stampWorkbook(sheets) {
  return sheets.map((s) => {
    const rows = [...s.rows];
    const last = rows[rows.length - 1];
    if (!(Array.isArray(last) && last.length === 1 && last[0] === OT_WATERMARK)) rows.push([], [OT_WATERMARK]);
    return { ...s, rows, footer: OT_WATERMARK };
  });
}

/**
 * @param {{ est: ReturnType<typeof import("./estimate.js").priceEstimate>,
 *   projectName?: string, companyName?: string, clientName?: string, date?: string }} args
 * @returns {Array<{name: string, rows: any[][], footer: string}>}
 */
export function estimateWorkbook({ est, projectName = "", companyName = "", clientName = "", date = "" }) {
  const head = [
    ["Estimate", projectName || "Untitled project"],
    ...(companyName ? [["Prepared by", companyName]] : []),
    ...(clientName ? [["Prepared for", clientName]] : []),
    ...(date ? [["Date", date]] : []),
    [],
  ];
  const st = est.settings;

  const lines = [["Finish", "Status", "Unit", "Material qty", "Material $/unit", "Material $", "Labor qty", "Labor $/unit", "Labor $", "Assembly material $", "Assembly labor $", "Line total $"]];
  for (const l of est.lines) {
    lines.push([l.finish_tag, STATUS[l.status], l.unit, l.material_qty, rate(l.material_rate), l.material_cost, l.labor_qty, rate(l.labor_rate), l.labor_cost, l.materials_cost, l.materials_labor_cost || 0, l.total]);
  }
  const summary = [
    [],
    ["Material", est.material],
    ["Labor", est.labor],
    [`Sales tax on material (${st.tax_pct}%)`, est.tax],
    ["Cost", est.cost],
    [`Overhead (${st.overhead_pct}%)`, est.overhead],
    [`Profit (${st.profit_pct}% ${MODE[st.profit_mode]})`, est.profit],
    [est.complete ? "Base bid" : "Base bid (priced so far)", est.total],
  ];
  if (!est.complete) summary.push([], [`Not fully priced: ${est.unpriced.length} line${est.unpriced.length === 1 ? "" : "s"} count at $0 for what is missing (see the Unpriced tab).`]);
  for (const w of est.warnings) summary.push([w]);

  const materials = [["Finish", "Assembly item", "Order qty", "Unit", "Material $/unit", "Material $", "Labor qty", "Labor $/unit", "Labor $", "Status"]];
  for (const l of est.lines) {
    for (const m of l.materials) {
      materials.push([l.finish_tag, m.name, m.qty, m.unit, rate(m.price), m.cost, m.labor_qty ?? "", rate(m.labor_rate), m.labor_cost ?? 0, m.priced ? "priced" : "unpriced"]);
    }
  }

  const sheets = [
    { name: "Estimate", rows: [...head, ...lines, ...summary] },
    { name: "Materials", rows: [...head, ...materials] },
  ];
  if (!est.complete) {
    const unpriced = [["Finish", "Status", "Missing"]];
    for (const u of est.unpriced) unpriced.push([lineLabel(est, u), STATUS[u.status], u.missing.join("; ")]);
    sheets.push({ name: "Unpriced", rows: [...head, ...unpriced] });
  }
  return stampWorkbook(sheets);
}

export function estimateFileName(projectName) {
  const base = String(projectName || "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "OpenTakeoff";
  return `${base} - estimate.xlsx`;
}
