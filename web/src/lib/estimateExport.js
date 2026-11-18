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

import { createExportPresentation } from "./exportPresentation.js";
import { OT_WATERMARK } from "./branding.js";
import { lineLabel } from "./estimate.js";

const MODE = { markup: "markup on cost", margin: "margin of price" };
// "optional": a bordered run's derived line nobody priced — it is carried in
// the condition's main line, so it is never on the Unpriced tab (estimate.js).
const STATUS = { priced: "priced", partial: "partly priced", unpriced: "unpriced", optional: "optional (in main line)" };
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
 *   projectName?: string, companyName?: string, clientName?: string, date?: string, localize?: (value: any) => any, language?: string }} args
 * @returns {Array<{name: string, rows: any[][], footer: string, columnWidths?: number[]}>}
 */
export function estimateWorkbook({ est, projectName = "", companyName = "", clientName = "", date = "", localize = (v) => v, language = "en" }) {
  const p = createExportPresentation({ language, localize });
  const heading = cells => cells.map(value => localize(value));
  const head = [
    [localize("Estimate"), projectName || localize("Untitled project")],
    ...(companyName ? [[localize("Prepared by"), companyName]] : []),
    ...(clientName ? [[localize("Prepared for"), clientName]] : []),
    ...(date ? [[localize("Date"), date]] : []),
    [],
  ];
  const st = est.settings;

  const lines = [heading(["Finish", "Status", "Unit", "Material qty", "Material $/unit", "Material $", "Labor qty", "Labor $/unit", "Labor $", "Assembly material $", "Assembly labor $", "Line total $"])];
  for (const l of est.lines) {
    lines.push([p.finish(l.finish_tag), localize(STATUS[l.status]), p.unit(l.unit), l.material_qty, rate(l.material_rate), l.material_cost, l.labor_qty, rate(l.labor_rate), l.labor_cost, l.materials_cost, l.materials_labor_cost || 0, l.total]);
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
  ].map(heading);
  if (!est.complete) summary.push([], [`Not fully priced: ${est.unpriced.length} line${est.unpriced.length === 1 ? "" : "s"} count at $0 for what is missing (see the Unpriced tab).`]);
  if (language === 'ru' && !est.complete) summary[summary.length - 1] = [`Не все цены заданы. Позиций без полной стоимости: ${est.unpriced.length}. Неуказанные цены учитываются как нулевые; см. лист «${localize("Unpriced")}».`];
  for (const w of est.warnings) summary.push([localize(w)]);

  const materials = [heading(["Finish", "Assembly item", "Order qty", "Unit", "Material $/unit", "Material $", "Labor qty", "Labor $/unit", "Labor $", "Status"])];
  for (const l of est.lines) {
    for (const m of l.materials) {
      materials.push([p.finish(l.finish_tag), p.material(m.name), m.qty, p.unit(m.unit), rate(m.price), m.cost, m.labor_qty ?? "", rate(m.labor_rate), m.labor_cost ?? 0, localize(m.priced ? "priced" : "unpriced")]);
    }
  }

  const sheets = [
    { name: "Estimate", rows: [...head, ...lines, ...summary] },
    { name: "Materials", rows: [...head, ...materials] },
  ];
  if (!est.complete) {
    const unpriced = [heading(["Finish", "Status", "Missing"])];
    // lineLabel's rule (estimate.js): the unit rides along only when one finish has several lines.
    const label = (u) => (lineLabel(est, u) === u.finish_tag ? p.finish(u.finish_tag) : `${p.finish(u.finish_tag)} ${p.unit(u.unit)}`);
    for (const u of est.unpriced) unpriced.push([label(u), localize(STATUS[u.status]), u.missing.map(v => v.startsWith('material row: ') ? localize('Supporting material') + ': ' + p.material(v.slice(14)) : localize(v)).join('; ')]);
    sheets.push({ name: "Unpriced", rows: [...head, ...unpriced] });
  }
  return stampWorkbook(sheets).map(sheet => ({...sheet, name: localize(sheet.name), ...(language === 'ru' ? {columnWidths: [44,26,16,24,24,20,24,24,20,30,30,24]} : {})}));
}

export function estimateFileName(projectName, language = "en") {
  const base = String(projectName || "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "OpenTakeoff";
  return `${base} - ${language === "ru" ? "смета" : "estimate"}.xlsx`;
}
