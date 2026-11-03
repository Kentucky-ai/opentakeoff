// Priced estimate → Excel tabs (rows of cells for lib/xlsx.js buildXlsx).
// Pure: takes a priceEstimate() result (lib/estimate.js) and returns the same
// numbers the Estimate panel shows. Values only, never formulas (the xlsx.js
// rule: a pasted "=..." finish tag stays inert text). A rate that was never
// entered is an EMPTY cell, not 0, and the line's Status says so.
//
// Every tab opens with the project line and closes with OT_WATERMARK: the
// estimate is prepared with OpenTakeoff in every branding mode.

import { OT_WATERMARK } from "./branding.js";

const MODE = { markup: "markup on cost", margin: "margin of price" };
const STATUS = { priced: "priced", partial: "partly priced", unpriced: "unpriced" };
const rate = (v) => (v === null || v === undefined ? "" : v);

/**
 * @param {{ est: ReturnType<typeof import("./estimate.js").priceEstimate>,
 *   projectName?: string, companyName?: string, clientName?: string, date?: string, localize?: (value: any) => any, language?: string }} args
 * @returns {Array<{name: string, rows: any[][]}>}
 */
export function estimateWorkbook({ est, projectName = "", companyName = "", clientName = "", date = "", localize = (v) => v, language = "en" }) {
  const head = [
    ["Estimate", projectName || localize("Untitled project")],
    ...(companyName ? [["Prepared by", companyName]] : []),
    ...(clientName ? [["Prepared for", clientName]] : []),
    ...(date ? [["Date", date]] : []),
    [],
  ];
  const foot = [[], [OT_WATERMARK]];
  const st = est.settings;

  const lines = [["Finish", "Status", "Unit", "Material qty", "Material $/unit", "Material $", "Labor qty", "Labor $/unit", "Labor $", "Material rows $", "Line total $"]];
  for (const l of est.lines) {
    lines.push([l.finish_tag, STATUS[l.status], l.unit, l.material_qty, rate(l.material_rate), l.material_cost, l.labor_qty, rate(l.labor_rate), l.labor_cost, l.materials_cost, l.total]);
  }
  const summary = [
    [],
    ["Material", est.material],
    ["Labor", est.labor],
    [`Sales tax on material (${st.tax_pct}%)`, est.tax],
    ["Cost", est.cost],
    [`Overhead (${st.overhead_pct}%)`, est.overhead],
    [`Profit (${st.profit_pct}% ${MODE[st.profit_mode]})`, est.profit],
    ["Base bid", est.total],
  ];
  if (!est.complete) summary.push([], [`Not fully priced: ${est.unpriced.length} condition${est.unpriced.length === 1 ? "" : "s"} count at $0 for what is missing (see the Unpriced tab).`]);
  if (language === 'ru' && !est.complete) summary[summary.length - 1] = [`Не все цены заданы. Позиций без полной стоимости: ${est.unpriced.length}. Неуказанные цены учитываются как нулевые; см. лист «Не заданные цены».`];
  for (const w of est.warnings) summary.push([w]);

  const materials = [["Finish", "Material", "Qty", "Unit", "$/unit", "Cost $", "Status"]];
  for (const l of est.lines) {
    for (const m of l.materials) materials.push([l.finish_tag, m.name, m.qty, m.unit, rate(m.price), m.cost, m.priced ? "priced" : "unpriced"]);
  }

  const sheets = [
    { name: "Estimate", rows: [...head, ...lines, ...summary, ...foot] },
    { name: "Materials", rows: [...head, ...materials, ...foot] },
  ];
  if (!est.complete) {
    const unpriced = [["Finish", "Status", "Missing"]];
    for (const u of est.unpriced) unpriced.push([u.finish_tag, STATUS[u.status], u.missing.map(v => v.startsWith('material row: ') ? localize('Supporting material') + ': ' + localize(v.slice(14)) : localize(v)).join('; ')]);
    sheets.push({ name: "Unpriced", rows: [...head, ...unpriced, ...foot] });
  }
  return sheets.map(sheet => ({...sheet, name: localize(sheet.name), ...(language === 'ru' ? {columnWidths: [44,26,16,24,24,20,24,24,20,30,24]} : {}), rows: sheet.rows.map((row, rowIndex) => row.map((v, colIndex) => typeof v === 'string' && !(rowIndex < head.length && colIndex > 0) ? localize(v) : v))}));
}

export function estimateFileName(projectName, language = "en") {
  const base = String(projectName || "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "OpenTakeoff";
  return `${base} - ${language === "ru" ? "смета" : "estimate"}.xlsx`;
}
