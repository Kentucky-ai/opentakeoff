// Role-aware takeoff totaling — the same rules the original commit endpoint used
// (see the reference test in the project history), reimplemented client-side:
//
//   floor_area    → adds to floor SF
//   deduct        → subtracts from floor SF
//   surface_area  → adds to wall SF (a wall trace: LF × height) — never base LF
//   linear        → adds to LF, and (if the condition has thickness) border SF
//   count         → adds to EA
//   multiplier    → × N identical units, applied to every quantity
//   waste_pct     → a flooring allowance added on top (SF + LF; never EA)
//
// `shape.computed` already holds the per-shape numbers (computed at draw time
// against that sheet's scale), so totaling is pure arithmetic — no scale here.
//
// Naming debt, kept deliberately: the `_net` suffix (total_sf_net, sy_net, …)
// means the WASTE-ADJUSTED order quantity — estimating parlance would call the
// un-adjusted measured figure "net". The names stay as-is because the CSV
// headers and the now-versioned JSON export keys (opentakeoff.report.v1) must
// remain stable.

// Import cycle note: reportColumns.js imports round2 from here. Safe because
// neither module touches the other's exports at module-eval time (only inside
// function bodies) — ESM live bindings resolve by first call.
import { GETTERS, CSV_PROFILE } from "./reportColumns.js";

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function conditionTotals(conditions, shapes) {
  return conditions.map((c) => {
    const mult = c.multiplier || 1;
    const waste = Math.max(0, Number(c.waste_pct) || 0);
    const w = 1 + waste / 100;
    const cs = shapes.filter((s) => s.condition_id === c.id);
    let floor = 0, wall = 0, border = 0, lf = 0, ea = 0;
    for (const s of cs) {
      const cp = s.computed || {};
      switch (s.measure_role) {
        case "deduct": floor -= cp.area_sf || 0; break;
        case "floor_area": floor += cp.area_sf || 0; break;
        case "surface_area": wall += cp.area_sf || 0; break;
        case "linear": lf += cp.perimeter_lf || 0; border += cp.area_sf || 0; break;
        case "count": ea += cp.count || 1; break;
        default: break;
      }
    }
    floor *= mult; wall *= mult; border *= mult; lf *= mult; ea *= mult;
    const total = floor + wall + border;
    // supporting materials: deterministic quantity = basis ÷ coverage, rounded up
    // to whole units (you buy whole buckets/bags). basis = this condition's measured
    // area (SF), linear (LF), or count (EA). Coverage comes off the product data sheet.
    const materials = (c.materials || []).filter((m) => m && m.name).map((m) => {
      const per = Math.max(0, Number(m.per) || 0);
      const basisVal = m.basis === "linear" ? lf : m.basis === "count" ? ea : total;
      let qty = per > 0 ? basisVal / per : 0;
      qty = m.round === false ? round2(qty) : Math.ceil(qty - 1e-9);
      return { name: m.name, unit: m.unit || "", per, basis: m.basis || "area", round: m.round !== false, note: m.note || "", basis_qty: round2(basisVal), qty };
    });
    return {
      id: c.id, finish_tag: c.finish_tag, color: c.color, fill: c.fill, hatch: c.hatch,
      multiplier: mult, waste_pct: waste, shape_count: cs.length,
      floor_sf: round2(floor), wall_sf: round2(wall), border_sf: round2(border),
      lf: round2(lf), ea,
      total_sf: round2(total),
      // waste-adjusted (order quantities)
      floor_sf_net: round2(floor * w), wall_sf_net: round2(wall * w),
      border_sf_net: round2(border * w), lf_net: round2(lf * w),
      total_sf_net: round2(total * w),
      sy_net: round2((total * w) / 9),
      materials,
    };
  });
}

// Per-sheet subtotals: the same role math as conditionTotals, grouped by
// sheet_id. Returns [{ sheet_id, rows: [{ id, finish_tag, color, multiplier,
// shape_count, floor_sf, wall_sf, border_sf, lf, ea }] }].
//
//   - Sheet groups follow first appearance of the sheet_id in `shapes`; rows
//     within a group follow `conditions` order; a condition appears only on
//     sheets where it has ≥1 shape, and shapeless sheets don't appear at all.
//   - Quantities are BASE (the condition multiplier is NOT applied — it's
//     included per row so consumers can footnote "×N applies at condition
//     level") and UNROUNDED (accumulated raw; round2 at display/serialization
//     only, so per-sheet rounding never compounds against the condition row).
//   - No waste, no materials: those are condition-level order quantities, not
//     where-is-it-measured quantities.
//   - floor_sf can be negative (a deduct pasted onto a different sheet than
//     its positive area) — returned as-is, never clamped.
export function sheetTotals(conditions, shapes) {
  const order = [];                 // sheet_ids by first appearance
  const bySheet = new Map();        // sheet_id → Map(condition_id → accumulator)
  for (const s of shapes) {
    let conds = bySheet.get(s.sheet_id);
    if (!conds) { conds = new Map(); bySheet.set(s.sheet_id, conds); order.push(s.sheet_id); }
    let a = conds.get(s.condition_id);
    if (!a) { a = { n: 0, floor: 0, wall: 0, border: 0, lf: 0, ea: 0 }; conds.set(s.condition_id, a); }
    a.n += 1;
    const cp = s.computed || {};
    switch (s.measure_role) {
      case "deduct": a.floor -= cp.area_sf || 0; break;
      case "floor_area": a.floor += cp.area_sf || 0; break;
      case "surface_area": a.wall += cp.area_sf || 0; break;
      case "linear": a.lf += cp.perimeter_lf || 0; a.border += cp.area_sf || 0; break;
      case "count": a.ea += cp.count || 1; break;
      default: break;
    }
  }
  return order.map((sheet_id) => {
    const conds = bySheet.get(sheet_id);
    const rows = conditions.filter((c) => conds.has(c.id)).map((c) => {
      const a = conds.get(c.id);
      return {
        id: c.id, finish_tag: c.finish_tag, color: c.color,
        multiplier: c.multiplier || 1, shape_count: a.n,
        floor_sf: a.floor, wall_sf: a.wall, border_sf: a.border, lf: a.lf, ea: a.ea,
      };
    });
    return { sheet_id, rows };
  }).filter((g) => g.rows.length);   // orphan shapes (dead condition_id) can't render a row
}

// Kreo-style derived metric: vertical wall SF = floor-area perimeters × the
// condition's height. Display-only (never in condition rows or the CSV): a
// floor perimeter includes door openings and shared walls, so this is a
// read-it-yourself ceiling estimate, not an order quantity.
export function verticalWallSf(shapes, conditionId, heightFt, multiplier = 1) {
  const h = Number(heightFt) || 0;
  if (h <= 0) return 0;
  const perim = shapes
    .filter((s) => s.condition_id === conditionId && s.measure_role === "floor_area")
    .reduce((n, s) => n + (s.computed?.perimeter_lf || 0), 0);
  return round2(perim * h * (multiplier || 1));
}

// Combined buy list: same-named materials summed across all conditions (each
// condition is rounded first, then summed — you order per condition).
export function materialsSummary(rows) {
  const map = new Map();
  for (const r of rows) for (const m of (r.materials || [])) {
    const key = `${m.name}\x00${m.unit}`;
    const cur = map.get(key) || { name: m.name, unit: m.unit, qty: 0 };
    cur.qty += m.qty;
    map.set(key, cur);
  }
  return [...map.values()].map((x) => ({ ...x, qty: round2(x.qty) }));
}

// NB: the CSV TOTAL row emits g[key] for any column key present here — adding
// a key that collides with a CSV column key changes that row (golden-guarded).
export function grandTotals(rows) {
  const sum = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
  return {
    total_sf: round2(sum("total_sf")), total_sf_net: round2(sum("total_sf_net")),
    lf: round2(sum("lf")), lf_net: round2(sum("lf_net")),
    ea: sum("ea"), sy_net: round2(sum("sy_net")),
  };
}

// CSV: one row per condition, with both net (measured) and waste-adjusted columns.
// Optional per-sheet section: pass a sheetTotals() result as `bySheet` (plus a
// sheetLabel(sheet_id) → display-name fn) to append a "by sheet" table after the
// existing sections. With bySheet null/empty the output is byte-identical to the
// original — old callers are untouched.
/**
 * @param {any[]} rows conditionTotals() rows (shapeless conditions filtered out)
 * @param {string} [projectName]
 * @param {Array<{sheet_id: any, rows: any[]}>|null} [bySheet] sheetTotals() result
 * @param {((sheetId: any) => string)|null} [sheetLabel] sheet_id → display label
 * @param {Array<{key: string, header: string}>|null} [cols] CSV_PROFILE-shaped
 *   column list to emit; null → the default-visible CSV_PROFILE columns
 *   (byte-identical to the frozen v1 export). Opt-ins append after the base 13.
 * @param {{perimByCond?: Map<any, number>}|null} [ctx] handed to GETTERS
 *   (perimeter_ref needs it)
 * @returns {string}
 */
export function totalsToCsv(rows, projectName = "", bySheet = null, sheetLabel = null, cols = null, ctx = null) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const columns = cols || CSV_PROFILE.filter((c) => c.defaultVisible);
  const lines = [columns.map((c) => esc(c.header)).join(",")];
  for (const r of rows) {
    lines.push(columns.map((c) => esc(GETTERS[c.key]?.(r, ctx))).join(","));
  }
  const g = grandTotals(rows);
  // TOTAL row, column-driven: "TOTAL" under the finish column, grand-total
  // values where they exist, blank otherwise (perimeter_ref stays blank —
  // reference figures never total).
  const foot = (key) => {
    if (key === "finish") return "TOTAL";
    if (key === "waste_sf") return round2(g.total_sf_net - g.total_sf);
    if (key === "waste_lf") return round2(g.lf_net - g.lf);
    return g[key] !== undefined ? g[key] : "";
  };
  lines.push(columns.map((c) => esc(foot(c.key))).join(","));

  // supporting materials — per condition, then a combined buy list
  const basisLabel = (b) => (b === "linear" ? "LF" : b === "count" ? "EA" : "SF");
  const perCond = [];
  for (const r of rows) for (const m of (r.materials || [])) perCond.push([r.finish_tag, m.name, m.qty, m.unit, `1 ${m.unit || "unit"} / ${m.per} ${basisLabel(m.basis)}`, m.note || ""]);
  if (perCond.length) {
    lines.push("");
    lines.push(["Finish", "Material", "Qty", "Unit", "Coverage", "Note"].map(esc).join(","));
    for (const row of perCond) lines.push(row.map(esc).join(","));
    lines.push("");
    lines.push(["Material (combined)", "Qty", "Unit"].map(esc).join(","));
    for (const s of materialsSummary(rows)) lines.push([s.name, s.qty, s.unit].map(esc).join(","));
  }

  // per-sheet subtotals — base (unmultiplied) quantities, rounded here at
  // serialization only. Sheet ID (the raw persistent id) always rides along
  // because display labels are session-volatile.
  if (bySheet && bySheet.length) {
    lines.push("");
    lines.push(["Sheet", "Sheet ID", "Finish", "Floor SF", "Wall SF", "Border SF", "LF", "EA"].map(esc).join(","));
    let anyMult = false;
    for (const g of bySheet) {
      const label = sheetLabel ? sheetLabel(g.sheet_id) : g.sheet_id;
      for (const r of g.rows) {
        const mult = r.multiplier || 1;
        if (mult > 1) anyMult = true;
        const finish = mult > 1 ? `${r.finish_tag} ×${mult}` : r.finish_tag;
        lines.push([label, g.sheet_id, finish, round2(r.floor_sf), round2(r.wall_sf), round2(r.border_sf), round2(r.lf), round2(r.ea)].map(esc).join(","));
      }
    }
    if (anyMult) lines.push("# By-sheet rows show measured (base) quantities; xN multipliers apply at condition level");
  }

  const title = projectName ? `# ${projectName} — OpenTakeoff report\n` : "";
  return title + lines.join("\n") + "\n";
}

export function downloadText(filename, text, type = "text/plain") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
