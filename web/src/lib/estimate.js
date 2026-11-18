// Priced estimate — unit price × quantity, then sales tax, overhead and profit.
// Pure arithmetic over conditionTotals() rows (lib/totals.js): no DOM, no store,
// so the canvas, the Excel export, the bid proposal and the MCP server all price
// a job with the same numbers.
//
// One LINE per quantity kind a condition actually carries. A condition is
// whatever the estimator drew under it: CPT-1 with a room (SF), a border run
// (LF) and two floor boxes (EA) is three lines — area, length, count — each
// priced on its own. The first line is the condition's MAIN line (the unit the
// estimator picked, else what was measured: area beats length beats count);
// the others follow in area → LF → EA order. The condition's assembly items
// (its supporting-material rows) price on the main line, once.
//
// Where the prices live (all optional, all entered by the estimator):
//   condition.pricing          { unit: "SF"|"SY"|"LF"|"EA", material, labor,
//                                by_unit: { SF|LF|EA: { material, labor } } }
//                              unit / material / labor are the MAIN line's
//                              ($ per unit — the shape every project written
//                              before multi-line estimates already has, so its
//                              totals never move); by_unit holds the other
//                              lines' rates, keyed by their unit. A secondary
//                              area line is priced in SF.
//   condition.materials[].price        $ per that item's own unit (bag, pail, roll…)
//   condition.materials[].labor_price  optional $ per unit of labor on the item
//   project estimate settings  { tax_pct, overhead_pct, profit_pct, profit_mode }
//
// Quantity rules — the estimating convention, stated once:
//   material is priced on the ORDER quantity (waste applied: total_sf_net,
//   sy_net, lf_net); labor on the MEASURED quantity (no waste — the crew
//   installs the room, not the offcuts). EA carries no waste on either side.
//   Assembly items order whole packages (conditionTotals applies the item's
//   rule and its own waste %, then rounds up), so their material cost is
//   qty × price; an item's labor prices its MEASURED quantity (the rule over the
//   measured basis — no waste, no round-up).
//
// Missing is not zero. A rate that was never entered is null and the line says
// so (status "partial" / "unpriced", listed in `unpriced`); 0 is an explicit
// price the estimator typed (labor-only or owner-furnished scope). An item's
// material price is required like any rate; its labor price is optional — most
// items (adhesive, grout) are installed by the condition's own labor line, so an
// empty item labor box means "no separate labor", not a missing number. Nothing
// here ever invents a price.
//
// A bordered linear run is ONE measurement carrying two numbers: its LF and
// the border SF derived from it (LF × the condition's thickness). Before
// multi-line estimates it priced as one line, in the unit picked (SF unless
// the estimator chose LF); the other number now shows as its own line too, but
// that line is OPTIONAL — priceable, never "missing": an empty rate there means
// "carried in the main line", so a project priced on its border SF reads fully
// priced exactly as it always did. Only the derived kind is optional: the LF
// line when every LF on the row is a bordered run (thickness is per
// condition, so a row with border SF has no plain runs), the area line only
// when its whole area is border (no room or wall SF rides in it). Status
// "optional" = an optional line nobody priced; it is not in `unpriced`.
//
// Markups, in order: tax_pct on material (line material + item material)
// → overhead_pct on cost (material + labor + tax) → profit on cost + overhead,
// either as a markup (× (1 + p)) or as a margin (÷ (1 − p): 33.33% margin is
// ×1.5). Money rounds to cents per line and per markup step, so the lines add
// up to the printed subtotal exactly.

import { round2 } from "./num.js";
import { isMaterialLine, itemRule } from "./totals.js";

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

const ratePair = (src) => {
  const out = {};
  const m = priceValue(src?.material);
  const l = priceValue(src?.labor);
  if (m !== null) out.material = m;
  if (l !== null) out.labor = l;
  return out;
};

/**
 * The load gate for condition.pricing: undefined when nothing usable is there,
 * otherwise only the known keys, each valid or absent. by_unit keeps only the
 * line units with a usable rate.
 * @param {any} p
 * @returns {{unit?: string, material?: number, labor?: number,
 *   by_unit?: Record<string, {material?: number, labor?: number}>}|undefined}
 */
export function sanitizePricing(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return undefined;
  const out = {};
  if (PRICE_UNITS.includes(p.unit)) out.unit = p.unit;
  Object.assign(out, ratePair(p));
  if (p.by_unit && typeof p.by_unit === "object" && !Array.isArray(p.by_unit)) {
    const by = {};
    for (const u of PRICE_UNITS) {
      const r = ratePair(p.by_unit[u]);
      if (Object.keys(r).length) by[u] = r;
    }
    if (Object.keys(by).length) out.by_unit = by;
  }
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

// The unit a condition's MAIN line prices in when the estimator hasn't picked
// one: what it was measured in. Area beats length beats count — a bordered
// linear condition carries both LF and SF and is bought by the SF.
export function defaultPriceUnit(row) {
  if ((row?.total_sf || 0) > 0) return "SF";
  if ((row?.lf || 0) > 0) return "LF";
  if ((row?.ea || 0) > 0) return "EA";
  return "SF";
}

const KIND = { SF: "area", SY: "area", LF: "length", EA: "count" };

/**
 * The units of a condition's estimate lines, main line first: the main unit,
 * then every OTHER quantity kind the row actually carries (area in SF, then LF,
 * then EA). A row that measured nothing still prices its main line.
 * @param {any} row a conditionTotals row
 * @param {string} [mainUnit] the condition's pricing.unit, if picked
 * @returns {string[]}
 */
export function lineUnits(row, mainUnit) {
  const main = PRICE_UNITS.includes(mainUnit) ? mainUnit : defaultPriceUnit(row);
  const out = [main];
  const present = [["area", "SF", (row?.total_sf || 0) > 0], ["length", "LF", (row?.lf || 0) > 0], ["count", "EA", (row?.ea || 0) > 0]];
  for (const [kind, unit, has] of present) if (has && kind !== KIND[main]) out.push(unit);
  return out;
}

/**
 * Whether a NON-main line is the derived half of a bordered linear run (see
 * the header): shown and priceable, but an empty rate there is not missing.
 * @param {any} row a conditionTotals row
 * @param {string} unit the line's unit
 * @param {boolean} main whether it is the condition's main line
 * @returns {boolean}
 */
export function isOptionalLine(row, unit, main) {
  if (main || !((row?.border_sf || 0) > 0)) return false;
  if (unit === "LF") return true;
  if (KIND[unit] === "area") return !((row.floor_sf || 0) > 0) && !((row.wall_sf || 0) > 0);
  return false;
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
    const units = lineUnits(row, pricing.unit);
    // conditionTotals keeps exactly the rows isMaterialLine passes, in order —
    // the same predicate here lines each priced source row up with its quantity.
    const srcMaterials = (c.materials || []).filter(isMaterialLine);
    units.forEach((unit, li) => {
      const main = li === 0;
      const rates = main ? pricing : (pricing.by_unit?.[unit] || {});
      const qty = priceQuantities(row, unit);
      const materialRate = rates.material ?? null;
      const laborRate = rates.labor ?? null;
      const materialCost = materialRate === null ? 0 : round2(qty.material * materialRate);
      const laborCost = laborRate === null ? 0 : round2(qty.labor * laborRate);
      // assembly items price once, on the main line
      const materials = !main ? [] : (row.materials || []).map((m, i) => {
        const src = srcMaterials[i] || {};
        const price = priceValue(src.price);
        const labor = priceValue(src.labor_price);
        const per = Number(m.per) || 0;
        // measured quantity: the item's rule over the measured basis — no item waste, no round-up
        const laborQty = per > 0 ? round2(itemRule(m) === "each" ? m.basis_qty * per : m.basis_qty / per) : 0;
        return {
          name: m.name, unit: m.unit, qty: m.qty, price, cost: price === null ? 0 : round2(m.qty * price),
          labor_qty: laborQty, labor_rate: labor, labor_cost: labor === null ? 0 : round2(laborQty * labor),
          ...(m.waste_pct > 0 ? { waste_pct: m.waste_pct } : {}),
          priced: price !== null || !(m.qty > 0),
        };
      });
      const optional = isOptionalLine(row, unit, main);
      const missing = [];
      if (materialRate === null && !optional) missing.push("material");
      if (laborRate === null && !optional) missing.push("labor");
      for (const m of materials) if (!m.priced) missing.push(`material row: ${m.name}`);
      const anyPrice = materialRate !== null || laborRate !== null || materials.some((m) => m.price !== null || m.labor_rate !== null);
      const materialsCost = round2(materials.reduce((n, m) => n + m.cost, 0));
      const materialsLabor = round2(materials.reduce((n, m) => n + m.labor_cost, 0));
      lines.push({
        id: row.id, key: `${row.id}:${unit}`, finish_tag: row.finish_tag, unit, main, optional,
        material_qty: qty.material, labor_qty: qty.labor,
        material_rate: materialRate, labor_rate: laborRate,
        material_cost: materialCost, labor_cost: laborCost,
        materials, materials_cost: materialsCost, materials_labor_cost: materialsLabor,
        total: round2(materialCost + laborCost + materialsCost + materialsLabor),
        status: missing.length ? (anyPrice ? "partial" : "unpriced") : optional && !anyPrice ? "optional" : "priced",
        missing,
      });
    });
  }

  const material = round2(lines.reduce((n, l) => n + l.material_cost + l.materials_cost, 0));
  const labor = round2(lines.reduce((n, l) => n + l.labor_cost + l.materials_labor_cost, 0));
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
  const unpriced = lines.filter((l) => l.missing.length > 0).map((l) => ({ id: l.id, key: l.key, finish_tag: l.finish_tag, unit: l.unit, status: l.status, missing: l.missing }));
  return {
    settings: st, lines,
    material, labor, tax, cost, overhead, profit,
    total: round2(base + profit),
    unpriced, complete: unpriced.length === 0, warnings,
  };
}

// "CPT-1" for a one-line condition, "CPT-1 LF" when the condition has several
// lines — how a line is named wherever it is listed (unpriced notes, the Excel
// Unpriced tab).
export function lineLabel(est, l) {
  const many = est.lines.some((o) => o.id === l.id && o.key !== l.key);
  return many ? `${l.finish_tag} ${l.unit}` : l.finish_tag;
}
