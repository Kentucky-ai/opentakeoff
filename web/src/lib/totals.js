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

import { round2 } from "./num.js";
import { csvEsc as esc } from "./csv.js";
import { GETTERS, CSV_PROFILE, colGetter, floorPerimeterLf } from "./reportColumns.js";
import { attrValue } from "./conditionColumns.js";
import { compareSheetKeys } from "./sheetKey"; // NOT ./sheets — that module imports pdfjs-dist

// Re-export so existing consumers (markedset, snapshotDiff, ReportPanel, tests)
// keep importing round2 from here; num.js is the single definition.
export { round2 } from "./num.js";

// The role → quantity mapping from the header comment, shared by
// conditionTotals and sheetTotals. Mutates acc ({ floor, wall, border, lf,
// ea }) in place with the shape's raw computed numbers — no multiplier, no
// waste, no rounding here. `cp.count || 1` is deliberate (||, not ??): a
// count shape still tallies one unit even if computed.count is 0/missing.
function accumulateRole(acc, s) {
  const cp = s.computed || {};
  switch (s.measure_role) {
    case "deduct": acc.floor -= cp.area_sf || 0; break;
    case "floor_area": acc.floor += cp.area_sf || 0; break;
    case "surface_area": acc.wall += cp.area_sf || 0; break;
    case "linear": acc.lf += cp.perimeter_lf || 0; acc.border += cp.area_sf || 0; break;
    case "count": acc.ea += cp.count || 1; break;
    default: break;
  }
}

export function conditionTotals(conditions, shapes) {
  return conditions.map((c) => {
    const mult = c.multiplier || 1;
    const waste = Math.max(0, Number(c.waste_pct) || 0);
    const w = 1 + waste / 100;
    const cs = shapes.filter((s) => s.condition_id === c.id);
    const acc = { floor: 0, wall: 0, border: 0, lf: 0, ea: 0 };
    for (const s of cs) accumulateRole(acc, s);
    let { floor, wall, border, lf, ea } = acc;
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
//   - Sheet groups sort by file name (localeCompare) then page number — the
//     `file#page` sheet_id convention via parseSheetKey, the SAME order
//     exportMarkedSet gives the PDF — so report/CSV/JSON and the Marked Set
//     agree, and delete-and-redraw can't reorder a re-export (first-appearance
//     draw order used to leak through). Rows within a group follow
//     `conditions` order; a condition appears only on sheets where it has
//     ≥1 shape, and shapeless sheets don't appear at all.
//   - Quantities are BASE (the condition multiplier is NOT applied — it's
//     included per row so consumers can footnote "×N applies at condition
//     level") and UNROUNDED (accumulated raw; round2 at display/serialization
//     only, so per-sheet rounding never compounds against the condition row).
//   - HAZARD: these rows reuse condition-row keys (floor_sf, wall_sf,
//     border_sf, lf, ea) but with the base-only semantics above, so passing
//     them to grandTotals() type-matches silently and yields base
//     (unmultiplied) figures — do NOT do it. (Renaming the keys base_* would
//     make the misuse impossible, but the by_sheet row keys are frozen
//     opentakeoff.report.v1 schema, so the rename is deferred.)
//   - No waste, no materials: those are condition-level order quantities, not
//     where-is-it-measured quantities.
//   - floor_sf can be negative (a deduct pasted onto a different sheet than
//     its positive area) — returned as-is, never clamped.
export function sheetTotals(conditions, shapes) {
  const bySheet = new Map();        // sheet_id → Map(condition_id → accumulator)
  for (const s of shapes) {
    let conds = bySheet.get(s.sheet_id);
    if (!conds) { conds = new Map(); bySheet.set(s.sheet_id, conds); }
    let a = conds.get(s.condition_id);
    if (!a) { a = { n: 0, floor: 0, wall: 0, border: 0, lf: 0, ea: 0 }; conds.set(s.condition_id, a); }
    a.n += 1;
    accumulateRole(a, s);
  }
  // canonical sheet order — shared comparator, same as exportMarkedSet
  const order = [...bySheet.keys()].sort((ka, kb) => compareSheetKeys(String(ka), String(kb)));
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

// Sheet-grouped ORDERED quantities for the report's group-by-sheet view —
// deliberately different from sheetTotals above (base quantities): each
// group's rows are conditionTotals restricted to that sheet's shapes, so
// waste % and ×N apply per slice and every column keeps its ungrouped
// meaning. Returns [{ sheet_id, rows, perimByCond }] in the same canonical
// file→page order as sheetTotals; a condition traced on N sheets appears in
// N groups. perimByCond is per-sheet (floorPerimeterLf over that sheet's
// shapes) — the global map would show whole-project perimeter next to
// per-slice quantities.
//   - Rows carry per-slice materials with per-slice ceil — tbody display
//     only, never aggregate (summing per-slice ceils overstates the buy).
//   - Negative slices (a deduct on a different sheet than its positive area)
//     are returned as-is — rendered with a bare minus in v1, unlike the
//     by-sheet section's red-paren style.
//   - Empty groups dropped: orphan shapes (dead condition_id) can make a
//     sheet all-orphan, mirroring the sheetTotals guard.
export function sheetGroupedRows(conditions, shapes) {
  const bySheet = new Map();        // sheet_id → that sheet's shapes
  for (const s of shapes) {
    let arr = bySheet.get(s.sheet_id);
    if (!arr) { arr = []; bySheet.set(s.sheet_id, arr); }
    arr.push(s);
  }
  // canonical sheet order — shared comparator, same as sheetTotals
  const order = [...bySheet.keys()].sort((ka, kb) => compareSheetKeys(String(ka), String(kb)));
  return order.map((sheet_id) => {
    const sheetShapes = bySheet.get(sheet_id);
    return {
      sheet_id,
      rows: conditionTotals(conditions, sheetShapes).filter((r) => r.shape_count > 0),
      perimByCond: floorPerimeterLf(sheetShapes),
    };
  }).filter((g) => g.rows.length);
}

// The one base-quantities footnote, shared by CSV ("# " prefix, golden-
// pinned), the Marked Set PDF legend, and the report panel (which appends
// its own screen-only reconcile clause). Bare sentence, ASCII "xN" —
// changing a character here changes the CSV golden.
export const BY_SHEET_BASE_NOTE =
  "By-sheet rows show measured (base) quantities; xN multipliers apply at condition level";

// Gate for that footnote: does any by-sheet row carry a ×N > 1?
export function hasMultipliers(bySheet) {
  return (bySheet || []).some((g) => g.rows.some((r) => (r.multiplier || 1) > 1));
}

// Serialization-time rounding for a sheetTotals row: round2 the five quantity
// fields, spread-preserving so the pinned v1 key order survives untouched.
// sheetTotals OUTPUT stays unrounded (the condition-row reconciliation and
// snapshotDiff both need raw rows) — call this only where a row leaves the
// app (CSV, report JSON, Marked Set PDF legend). Rounding `ea` is observable
// only for hand-edited fractional counts (drawn count shapes always carry
// computed.count === 1); that aligns the JSON/PDF with the CSV, which already
// rounded ea.
export function roundSheetRow(r) {
  return {
    ...r,
    floor_sf: round2(r.floor_sf), wall_sf: round2(r.wall_sf),
    border_sf: round2(r.border_sf), lf: round2(r.lf), ea: round2(r.ea),
  };
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
 *   (byte-identical to the frozen v1 export). Opt-ins append after the base 13;
 *   custom columns (customColProfile) carry their own `get` and append after.
 * @param {{perimByCond?: Map<any, number>, attrsByCond?: Map<any, object>, specByCond?: Map<any, object>}|null}
 *   [ctx] handed to the getters (perimeter_ref / custom / spec columns need it)
 * @returns {string}
 */
export function totalsToCsv(rows, projectName = "", bySheet = null, sheetLabel = null, cols = null, ctx = null) {
  const columns = cols || CSV_PROFILE.filter((c) => c.defaultVisible);
  const lines = [columns.map((c) => esc(c.header)).join(",")];
  for (const r of rows) {
    lines.push(columns.map((c) => esc(colGetter(c)?.(r, ctx))).join(","));
  }
  const g = grandTotals(rows);
  // TOTAL row, column-driven: "TOTAL" under the finish column, grand-total
  // values where they exist, blank otherwise (perimeter_ref stays blank —
  // reference figures never total).
  const foot = (key) => {
    if (key === "finish") return "TOTAL";
    // derived waste feet: same getter as the body cells (g carries all four inputs)
    if (key === "waste_sf" || key === "waste_lf") return GETTERS[key](g);
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
    for (const g of bySheet) {
      const label = sheetLabel ? sheetLabel(g.sheet_id) : g.sheet_id;
      for (const row of g.rows) {
        const mult = row.multiplier || 1;
        const finish = mult > 1 ? `${row.finish_tag} ×${mult}` : row.finish_tag;
        const r = roundSheetRow(row);
        lines.push([label, g.sheet_id, finish, r.floor_sf, r.wall_sf, r.border_sf, r.lf, r.ea].map(esc).join(","));
      }
    }
    if (hasMultipliers(bySheet)) lines.push("# " + BY_SHEET_BASE_NOTE);
  }

  const title = projectName ? `# ${projectName} — OpenTakeoff report\n` : "";
  return title + lines.join("\n") + "\n";
}

// Report JSON envelope — schema opentakeoff.report.v1. Extracted pure so the
// key set is testable (test/totals.test.ts pins it; schema drift fails there).
// v1 is additive-only: new keys APPEND after the existing ones (see markups'
// id/rfi_id, row `columns`, top-level `condition_columns`) and are always
// emitted — empty arrays, never conditionally absent — so the shape stays
// deterministic for downstream parsers.
//   - sheets[] carries scale provenance under `scale_source` — the SAME key the
//     persisted payload uses ("unknown" when unrecorded).
//   - sheets[] deliberately omits units_per_px: that figure is feet per
//     internal baseline-raster pixel (RENDER_SCALE-coupled), uninterpretable
//     outside the app. It stays in the persisted payload only.
/**
 * @param {{projectName?: string, rows?: any[], bySheet?: any[],
 *   scaleInfo?: Array<{sheet_id: any, source?: string, [k: string]: any}>, markups?: any[],
 *   rfis?: any[], sheetLabel?: ((sheetId: any) => string)|null,
 *   conditionColumns?: Array<{id: string, name: string, values: string[]}>,
 *   attrsByCond?: Map<any, object>|null}} args
 */
export function reportJson({ projectName = "", rows = [], bySheet = [], scaleInfo = [], markups = [], rfis = [], sheetLabel = null, conditionColumns = [], attrsByCond = null }) {
  const label = (id) => (sheetLabel ? sheetLabel(id) : id);
  // destructuring defaults don't apply to an explicit null, and both values can
  // trace back to a corrupted payload — coerce (and drop malformed items) so
  // the export can't throw
  const colDefs = (Array.isArray(conditionColumns) ? conditionColumns : []).filter((cc) => cc && typeof cc === "object" && typeof cc.id === "string");
  const attrs = attrsByCond instanceof Map ? attrsByCond : new Map();
  return {
    schema: "opentakeoff.report.v1",
    project_name: projectName || null,
    generated_with: "OpenTakeoff",
    sheets: scaleInfo.map((si) => ({ sheet_id: si.sheet_id, sheet: label(si.sheet_id), scale_source: si.scale_source ?? si.source ?? "unknown" })),
    // custom-column values APPEND after materials (row key order otherwise
    // untouched). Iterating the DEFINED columns — never raw attrs — naturally
    // drops orphaned colIds; attrValue (the shared assigned-value rule) keeps
    // corrupted and empty values out of the export.
    conditions: rows.map((r) => ({
      ...r,
      columns: colDefs.flatMap((cc) => {
        const v = attrValue(attrs.get(r.id), cc.id);   // the shared assigned-value rule
        return v ? [{ id: cc.id, name: cc.name, value: v }] : [];
      }),
    })),
    by_sheet: bySheet.map((gp) => ({
      sheet_id: gp.sheet_id,
      sheet: label(gp.sheet_id),
      rows: gp.rows.map(roundSheetRow),
    })),
    totals: grandTotals(rows),
    materials: materialsSummary(rows),
    // id + rfi_id APPEND after the original four keys (the additive-only v1
    // convention — see scale_source above): a cloud with empty text was fully
    // anonymous in the export. Legacy markups: id → null, rfi_id → "".
    markups: markups.map((m) => ({ type: m.type, sheet_id: m.sheet_id, sheet: label(m.sheet_id), text: m.text || "", id: m.id ?? null, rfi_id: m.rfi_id || "" })),
    // rfis APPENDS after markups (additive-only v1 — old exports had no RFI
    // register). linked_markups/linked_sheets are DERIVED from markup.rfi_id,
    // never a second store of the link.
    rfis: (rfis || []).map((r) => {
      const linked = (markups || []).filter((m) => m.rfi_id === r.id);
      return {
        id: r.id ?? null,
        number: r.number || "",
        subject: r.subject || "",
        question: r.question || "",
        status: r.status || "open",
        to: r.to || "",
        priority: r.priority || "",
        cost_impact: !!r.cost_impact,
        schedule_impact: !!r.schedule_impact,
        date: r.date || "",
        response: r.response || "",
        response_date: r.response_date || "",
        sheet_id: r.sheet_id ?? null,
        sheet: r.sheet_id != null ? label(r.sheet_id) : null,
        linked_markups: linked.length,
        linked_sheets: [...new Set(linked.map((m) => label(m.sheet_id)))],
      };
    }),
    // the custom-column definitions themselves, so row `columns` values can be
    // read against the project vocabulary
    condition_columns: colDefs.map(({ id, name, values }) => ({ id, name, values: Array.isArray(values) ? values : [] })),
  };
}

export function downloadText(filename, text, type = "text/plain") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
