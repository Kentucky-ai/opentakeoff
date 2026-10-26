// Priced estimate — unit price × quantity, then sales tax, overhead and profit.
// Pure arithmetic over conditionTotals() rows (lib/totals.js): no DOM, no store,
// so the canvas, the Excel export, the bid proposal and the MCP server all price
// a job with the same numbers.
//
// Where the prices live (all optional, all entered by the estimator):
//   condition.pricing          { unit: "SF"|"SY"|"LF"|"EA", material, labor }
//                              material / labor are $ per pricing unit
//   condition.materials[].price  $ per that row's own unit (bag, pail, roll…)
//   project estimate settings  { tax_pct, overhead_pct, profit_pct, profit_mode }
//
// Quantity rules — the estimating convention, stated once:
//   material is priced on the ORDER quantity (waste applied: total_sf_net,
//   sy_net, lf_net); labor on the MEASURED quantity (no waste — the crew
//   installs the room, not the offcuts). EA carries no waste on either side.
//   Supporting-material rows are already whole packages (conditionTotals rounds
//   them up), so their cost is qty × price.
//
// Missing is not zero. A rate that was never entered is null and the line says
// so (status "partial" / "unpriced", listed in `unpriced`); 0 is an explicit
// price the estimator typed (labor-only or owner-furnished scope). Nothing here
// ever invents a price.
//
// Markups, in order: tax_pct on material (condition material + material rows)
// → overhead_pct on cost (material + labor + tax) → profit on cost + overhead,
// either as a markup (× (1 + p)) or as a margin (÷ (1 − p): 33.33% margin is
// ×1.5). Money rounds to cents per line and per markup step, so the lines add
// up to the printed subtotal exactly.

import { round2 } from "./num.js";
import { isMaterialLine } from "./totals.js";

export const PRICE_UNITS = ["SF", "SY", "LF", "EA"];
export const PROFIT_MODES = ["markup", "margin"];
export const DEFAULT_ESTIMATE_SETTINGS = Object.freeze({ tax_pct: 0, overhead_pct: 0, profit_pct: 0, profit_mode: "markup" });

// A price field: finite and ≥ 0, else null (never entered / unusable). "" is the
// empty input box, so it reads as never entered rather than as 0.
export function priceValue(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const pctValue = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * The load gate for condition.pricing: undefined when nothing usable is there,
 * otherwise only the three known keys, each valid or absent.
 * @param {any} p
 * @returns {{unit?: string, material?: number, labor?: number}|undefined}
 */
export function sanitizePricing(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return undefined;
  const out = {};
  if (PRICE_UNITS.includes(p.unit)) out.unit = p.unit;
  const m = priceValue(p.material);
  const l = priceValue(p.labor);
  if (m !== null) out.material = m;
  if (l !== null) out.labor = l;
  return Object.keys(out).length ? out : undefined;
}

/**
 * @param {any} s
 * @returns {{tax_pct: number, overhead_pct: number, profit_pct: number, profit_mode: string}}
 */
export function sanitizeEstimateSettings(s) {
  const src = s && typeof s === "object" && !Array.isArray(s) ? s : {};
  return {
    tax_pct: pctValue(src.tax_pct),
    overhead_pct: pctValue(src.overhead_pct),
    profit_pct: pctValue(src.profit_pct),
    profit_mode: PROFIT_MODES.includes(src.profit_mode) ? src.profit_mode : "markup",
  };
}

// The unit a condition prices in when the estimator hasn't picked one: what it
// was measured in. Area beats length beats count — a bordered linear condition
// carries both LF and SF and is bought by the SF.
export function defaultPriceUnit(row) {
  if ((row?.total_sf || 0) > 0) return "SF";
  if ((row?.lf || 0) > 0) return "LF";
  if ((row?.ea || 0) > 0) return "EA";
  return "SF";
}

/**
 * Material (order) and labor (measured) quantities of one conditionTotals row
 * in a pricing unit.
 * @param {any} row
 * @param {string} unit
 * @returns {{material: number, labor: number}}
 */
export function priceQuantities(row, unit) {
  switch (unit) {
    case "SY": return { material: row.sy_net || 0, labor: round2((row.total_sf || 0) / 9) };
    case "LF": return { material: row.lf_net || 0, labor: row.lf || 0 };
    case "EA": return { material: row.ea || 0, labor: row.ea || 0 };
    default: return { material: row.total_sf_net || 0, labor: row.total_sf || 0 };
  }
}

/**
 * Price a takeoff.
 * @param {{rows: any[], conditions: any[], settings?: any}} args
 *   rows — conditionTotals(conditions, shapes, ctx) output; conditions — the
 *   same conditions (their pricing and material prices are read by id).
 *   Conditions with no shapes are left out: nothing measured, nothing to price.
 */
export function priceEstimate({ rows = [], conditions = [], settings = null }) {
  const st = sanitizeEstimateSettings(settings);
  const byId = new Map(conditions.map((c) => [c.id, c]));
  const lines = [];
  for (const row of rows) {
    if (!row || !(row.shape_count > 0)) continue;
    const c = byId.get(row.id) || {};
    const pricing = sanitizePricing(c.pricing) || {};
    const unit = pricing.unit || defaultPriceUnit(row);
    const qty = priceQuantities(row, unit);
    const materialRate = pricing.material ?? null;
    const laborRate = pricing.labor ?? null;
    const materialCost = materialRate === null ? 0 : round2(qty.material * materialRate);
    const laborCost = laborRate === null ? 0 : round2(qty.labor * laborRate);
    // conditionTotals keeps exactly the rows isMaterialLine passes, in order —
    // the same predicate here lines each priced source row up with its quantity.
    const srcMaterials = (c.materials || []).filter(isMaterialLine);
    const materials = (row.materials || []).map((m, i) => {
      const price = priceValue(srcMaterials[i]?.price);
      return { name: m.name, unit: m.unit, qty: m.qty, price, cost: price === null ? 0 : round2(m.qty * price), priced: price !== null || !(m.qty > 0) };
    });
    const missing = [];
    if (materialRate === null) missing.push("material");
    if (laborRate === null) missing.push("labor");
    for (const m of materials) if (!m.priced) missing.push(`material row: ${m.name}`);
    const anyPrice = materialRate !== null || laborRate !== null || materials.some((m) => m.price !== null);
    const materialsCost = round2(materials.reduce((n, m) => n + m.cost, 0));
    lines.push({
      id: row.id, finish_tag: row.finish_tag, unit,
      material_qty: qty.material, labor_qty: qty.labor,
      material_rate: materialRate, labor_rate: laborRate,
      material_cost: materialCost, labor_cost: laborCost,
      materials, materials_cost: materialsCost,
      total: round2(materialCost + laborCost + materialsCost),
      status: !missing.length ? "priced" : anyPrice ? "partial" : "unpriced",
      missing,
    });
  }

  const material = round2(lines.reduce((n, l) => n + l.material_cost + l.materials_cost, 0));
  const labor = round2(lines.reduce((n, l) => n + l.labor_cost, 0));
  const tax = round2(material * st.tax_pct / 100);
  const cost = round2(material + labor + tax);
  const overhead = round2(cost * st.overhead_pct / 100);
  const base = round2(cost + overhead);
  const warnings = [];
  let profit;
  if (st.profit_mode === "margin") {
    if (st.profit_pct >= 100) {
      warnings.push(`A ${st.profit_pct}% margin can't be priced (it must be under 100%); profit is left at $0.`);
      profit = 0;
    } else {
      profit = round2(base / (1 - st.profit_pct / 100) - base);
    }
  } else {
    profit = round2(base * st.profit_pct / 100);
  }
  const unpriced = lines.filter((l) => l.status !== "priced").map((l) => ({ id: l.id, finish_tag: l.finish_tag, status: l.status, missing: l.missing }));
  return {
    settings: st, lines,
    material, labor, tax, cost, overhead, profit,
    total: round2(base + profit),
    unpriced, complete: unpriced.length === 0, warnings,
  };
}
