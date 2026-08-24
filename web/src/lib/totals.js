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
import { GETTERS, getCsvProfile, colGetter, floorPerimeterLf, applyUnits, METRIC_CSV_LABELS } from "./reportColumns.js";
import { M_PER_FT, M2_PER_SF } from "./units";
import { coverageRateForDisplay, groutDisplayNote } from "./coverage.js";
import { attrValue } from "./conditionColumns.js";
import { shapeLabelValue } from "./shapeLabels.js";
import { compareSheetKeys } from "./sheetKey"; // NOT ./sheets — that module imports pdfjs-dist
import i18n from '../i18n/index.js';
const _t = (key, options) => i18n.t(key, { ns: 'lib', ...options });

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
    // #137 — a deduct carrying cuts_shape_id was reconciled at commit time
    // into a REAL polygon boolean subtract against its parent (lib/cutout.js):
    // the parent's own computed.area_sf already nets the hole out, so
    // counting the deduct's own area again here would double-subtract the
    // same cut. Its area_sf stays at face value on the shape (hover label);
    // this is the ONE place that decides whether it counts toward aggregates.
    case "deduct": if (!s.cuts_shape_id) acc.floor -= cp.area_sf || 0; break;
    case "floor_area": acc.floor += cp.area_sf || 0; break;
    case "surface_area": acc.wall += cp.area_sf || 0; break;
    case "linear": acc.lf += cp.perimeter_lf || 0; acc.border += cp.area_sf || 0; break;
    case "count": acc.ea += cp.count || 1; break;
    default: break;
  }
}

/**
 * @param {{seamByShape?: Map<any, number>}|null} [ctx] the figured roll-layout
 *   seam length per SHAPE (lib/rollTakeoff.js seamLfByShape) — what a
 *   materials row with basis "seam_lf" divides against. Omitted (every caller
 *   that has no roll context) those rows read 0, which is the honest answer:
 *   a weld rod has no quantity until the layout that produces the seams is
 *   figured. Per shape, not per condition, so this function keeps slicing
 *   correctly when it is handed one sheet's or one room's shapes.
 */
export function conditionTotals(conditions, shapes, ctx = null) {
  const seamByShape = ctx?.seamByShape instanceof Map ? ctx.seamByShape : null;
  return conditions.map((c) => {
    const mult = c.multiplier || 1;
    const waste = Math.max(0, Number(c.waste_pct) || 0);
    const w = 1 + waste / 100;
    const cs = shapes.filter((s) => s.condition_id === c.id);
    const acc = { floor: 0, wall: 0, border: 0, lf: 0, ea: 0 };
    for (const s of cs) accumulateRole(acc, s);
    let { floor, wall, border, lf, ea } = acc;
    // Seams are a property of the CUT LAYOUT, not of a role — they come in
    // pre-figured per shape and are summed here, then multiplied like every
    // other quantity: N identical units are N cuttings of the same layout.
    let seam = seamByShape ? cs.reduce((n, s) => n + (seamByShape.get(s.id) || 0), 0) : 0;
    floor *= mult; wall *= mult; border *= mult; lf *= mult; ea *= mult; seam *= mult;
    const total = floor + wall + border;
    // supporting materials: deterministic quantity = basis ÷ coverage, rounded up
    // to whole units (you buy whole buckets/bags). basis = this condition's measured
    // area (SF), linear (LF), count (EA), or figured seam length (LF — weld rod,
    // seam tape). Coverage comes off the product data sheet.
    const materials = (c.materials || []).filter((m) => m && m.name).map((m) => {
      const per = Math.max(0, Number(m.per) || 0);
      const basisVal = m.basis === "linear" ? lf : m.basis === "count" ? ea : m.basis === "seam_lf" ? seam : total;
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
/** @param {{seamByShape?: Map<any, number>}|null} [ctx] passed straight to conditionTotals */
export function sheetGroupedRows(conditions, shapes, ctx = null) {
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
      rows: conditionTotals(conditions, sheetShapes, ctx).filter((r) => r.shape_count > 0),
      perimByCond: floorPerimeterLf(sheetShapes),
    };
  }).filter((g) => g.rows.length);
}

// Label-grouped ORDERED quantities for the report's group-by-label view (#112) —
// the shape-level analogue of sheetGroupedRows: bucket shapes by shape.label
// (absent → the "Unlabeled" bucket), then conditionTotals per bucket so waste %
// and ×N apply per slice and every column keeps its ungrouped meaning. A
// condition that spans labels appears in each of its buckets — the slice math
// splits it for free, and the per-bucket sums reconcile to the ungrouped row.
// Returns [{ value, label, rows, perimByCond }] ordered vocabulary-first (in the
// project's stored order) → ad-hoc values (sorted) → Unlabeled last (value
// null, so the header renders italic like a custom column's Unassigned),
// mirroring partitionRowsBy. Same per-slice materials caveat as
// sheetGroupedRows: per-bucket ceils overstate the buy — tbody display only,
// never aggregate (the combined materials summary stays computed ungrouped).
// Empty buckets dropped.
/**
 * @param {string[]} [shapeLabels] the project's label vocabulary, for ordering
 * @param {{seamByShape?: Map<any, number>}|null} [ctx] passed straight to conditionTotals
 */
export function labelGroupedRows(conditions, shapes, shapeLabels = [], ctx = null) {
  const byLabel = new Map();        // label value → that bucket's shapes ("" key = Unlabeled)
  for (const s of shapes) {
    const v = shapeLabelValue(s);   // "" when unassigned
    let arr = byLabel.get(v);
    if (!arr) { arr = []; byLabel.set(v, arr); }
    arr.push(s);
  }
  const vocab = (Array.isArray(shapeLabels) ? shapeLabels : []).filter((v) => byLabel.has(v));
  const adhoc = [...byLabel.keys()].filter((v) => v && !vocab.includes(v)).sort();
  const order = [...vocab, ...adhoc, ...(byLabel.has("") ? [""] : [])];   // Unlabeled always last
  return order.map((v) => {
    const bucketShapes = byLabel.get(v);
    return {
      value: v || null,               // null = Unlabeled
      label: v || _t("csv_header.unlabeled"),
      rows: conditionTotals(conditions, bucketShapes, ctx).filter((r) => r.shape_count > 0),
      perimByCond: floorPerimeterLf(bucketShapes),
    };
  }).filter((g) => g.rows.length);
}

// Sheet × label grouping — the FLOOR × ROOM cross-section, and the shape an
// estimator actually hands a superintendent: what goes down in room 112 on the
// second floor, not what goes down in room 112 anywhere in the building.
// sheetGroupedRows and labelGroupedRows each collapse one of the two axes; this
// keeps both, running the same conditionTotals over each (sheet, label) cell so
// every column keeps its ungrouped meaning (waste % and ×N applied per slice).
//
//   - Sheets in the canonical file→page order (compareSheetKeys, the same order
//     the by-sheet section and the Marked Set use); within a sheet, labels in
//     labelGroupedRows' order — vocabulary first, then ad-hoc sorted, then the
//     unlabeled bucket last.
//   - A sheet with shapes but NO labeled ones still appears, as a single
//     unlabeled group. That is what makes the tab reconcile: every shape the
//     by-sheet section counted is somewhere in here, so a reader adding up a
//     floor's rooms lands on the floor's total rather than short of it.
//   - Same per-slice materials caveat as the other two: per-cell coverage
//     ceils are display, never a buy list (summing them overstates the order).
// Returns [{ sheet_id, groups: [{ value, label, rows, perimByCond }] }];
// cells with no rows (orphan shapes on a dead condition_id) are dropped, and a
// sheet left with no groups drops with them.
/**
 * @param {string[]} [shapeLabels] the project's label vocabulary, for ordering
 * @param {{seamByShape?: Map<any, number>}|null} [ctx] passed straight to conditionTotals
 */
export function sheetLabelGroupedRows(conditions, shapes, shapeLabels = [], ctx = null) {
  const bySheet = new Map();
  for (const s of shapes) {
    let arr = bySheet.get(s.sheet_id);
    if (!arr) { arr = []; bySheet.set(s.sheet_id, arr); }
    arr.push(s);
  }
  const order = [...bySheet.keys()].sort((ka, kb) => compareSheetKeys(String(ka), String(kb)));
  return order.map((sheet_id) => ({
    sheet_id,
    groups: labelGroupedRows(conditions, bySheet.get(sheet_id), shapeLabels, ctx),
  })).filter((g) => g.groups.length);
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
 * @param {Array<{value: string|null, rows: any[]}>|null} [byLabel] labelGroupedRows()
 *   result — appends a "by label" section (ordered per-bucket quantities); null/empty
 *   omits it, so a label-less project's CSV is byte-identical to the frozen v1 export.
 * @param {string} [brandName]
 * @param {"imperial"|"metric"} [units] display units — "metric" converts every
 *   dimensioned column/section to m²/m and RETIRES the SY column (upstream's
 *   metric contract); coverage rates in the materials section stay as entered
 *   (SF/LF-based). "imperial" (default) is byte-identical to the frozen export.
 * @returns {string}
 */
export function totalsToCsv(rows, projectName = "", bySheet = null, sheetLabel = null, cols = null, ctx = null, byLabel = null, brandName = "OpenTakeoff", units = "imperial") {
  // the caller passes RAW descriptors; conversion happens here (one site per
  // output) through the same applyUnits seam the report table uses
  const columns = applyUnits(cols || getCsvProfile().filter((c) => c.defaultVisible), units, METRIC_CSV_LABELS);
  const M = units === "metric";
  const AU = M ? "m2" : "SF", LU = M ? "m" : "LF";
  const A = (v) => (M ? round2((Number(v) || 0) * M2_PER_SF) : v);
  const L = (v) => (M ? round2((Number(v) || 0) * M_PER_FT) : v);
  const lines = [columns.map((c) => esc(c.header)).join(",")];
  for (const r of rows) {
    lines.push(columns.map((c) => esc(colGetter(c)?.(r, ctx))).join(","));
  }
  const g = grandTotals(rows);
  // TOTAL row, column-driven: "TOTAL" under the finish column, grand-total
  // values where they exist, blank otherwise (perimeter_ref stays blank —
  // reference figures never total). A metric descriptor carries `conv` so the
  // by-key reads convert exactly like the body cells.
  const foot = (c) => {
    if (c.key === "finish") return _t("csv_header.total");
    // derived waste feet: same getter as the body cells (g carries all four inputs)
    const v = (c.key === "waste_sf" || c.key === "waste_lf") ? GETTERS[c.key](g) : (g[c.key] !== undefined ? g[c.key] : "");
    return c.conv && v !== "" ? c.conv(v) : v;
  };
  lines.push(columns.map((c) => esc(foot(c))).join(","));

  // supporting materials — per condition, then a combined buy list. Coverage
  // rates deliberately stay as entered (SF/LF-based) in metric mode — the
  // upstream metric contract; the report panel carries the footnote.
  const basisLabel = (b) => (b === "linear" ? (M ? "m" : _t("basis.lf")) : b === "count" ? _t("basis.ea") : b === "seam_lf" ? (M ? "seam m" : _t("basis.seam_lf")) : (M ? "m²" : _t("basis.sf")));
  const perCond = [];
  for (const r of rows) for (const m of (r.materials || [])) {
    const per = M ? round2(coverageRateForDisplay(m.per, m.basis, units)) : m.per;
    perCond.push([r.finish_tag, m.name, m.qty, m.unit, `1 ${m.unit || _t("basis.unit")} / ${per} ${basisLabel(m.basis)}`, groutDisplayNote(m, units)]);
  }
  if (perCond.length) {
    lines.push("");
    lines.push([_t("csv_header.finish"), _t("csv_header.material"), _t("csv_header.qty"), _t("csv_header.unit"), _t("csv_header.coverage"), _t("csv_header.note")].map(esc).join(","));
    for (const row of perCond) lines.push(row.map(esc).join(","));
    lines.push("");
    lines.push([_t("csv_header.material_combined"), _t("csv_header.qty"), _t("csv_header.unit")].map(esc).join(","));
    for (const s of materialsSummary(rows)) lines.push([s.name, s.qty, s.unit].map(esc).join(","));
  }

  // per-sheet subtotals — base (unmultiplied) quantities, rounded here at
  // serialization only. Sheet ID (the raw persistent id) always rides along
  // because display labels are session-volatile.
  if (bySheet && bySheet.length) {
    lines.push("");
    lines.push([_t("csv_header.sheet"), _t("csv_header.sheet_id"), _t("csv_header.finish"), `${_t("column.floor_sf").replace("SF", AU)}`, `${_t("column.wall_sf").replace("SF", AU)}`, `${_t("column.border_sf").replace("SF", AU)}`, LU, _t("column.ea")].map(esc).join(","));
    for (const g of bySheet) {
      const label = sheetLabel ? sheetLabel(g.sheet_id) : g.sheet_id;
      for (const row of g.rows) {
        const mult = row.multiplier || 1;
        const finish = mult > 1 ? `${row.finish_tag} ×${mult}` : row.finish_tag;
        const r = roundSheetRow(row);
        lines.push([label, g.sheet_id, finish, A(r.floor_sf), A(r.wall_sf), A(r.border_sf), L(r.lf), r.ea].map(esc).join(","));
      }
    }
    if (hasMultipliers(bySheet)) lines.push("# " + _t("markedset.by_sheet_base_note"));
  }

  // per-label subtotals (#112) — ORDERED quantities (waste/×N applied per
  // bucket), matching the report's group-by-label view; only emitted when a
  // byLabel result is passed (some shape is labeled), so a label-less project's
  // CSV stays byte-identical.
  if (byLabel && byLabel.length) {
    lines.push("");
    lines.push([_t("csv_header.label"), _t("csv_header.finish"), `${_t("column.floor_sf").replace("SF", AU)}`, `${_t("column.wall_sf").replace("SF", AU)}`, `${_t("column.border_sf").replace("SF", AU)}`, LU, _t("column.ea")].map(esc).join(","));
    for (const g of byLabel) {
      const name = g.value || _t("csv_header.unlabeled");
      for (const row of g.rows) lines.push([name, row.finish_tag, A(row.floor_sf), A(row.wall_sf), A(row.border_sf), L(row.lf), row.ea].map(esc).join(","));
    }
  }

  const title = projectName ? `# ${projectName} — ${brandName} report\n` : "";
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
 *   attrsByCond?: Map<any, object>|null, shapeLabels?: string[],
 *   byLabel?: Array<{value: string|null, rows: any[]}>, displayUnits?: string,
 *   rollGoods?: any[]}} args
 */
export function reportJson({ projectName = "", rows = [], bySheet = [], scaleInfo = [], markups = [], rfis = [], sheetLabel = null, conditionColumns = [], attrsByCond = null, shapeLabels = [], byLabel = [], displayUnits = "imperial", rollGoods = [] }) {
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
    // scale_confirmed (scale gate): false = an agent set this sheet's scale and
    // no human confirmed it — the report's consumer should treat those sheets'
    // quantities as standing on an unverified number. Absent input = true
    // (human-era payloads predate the flag).
    sheets: scaleInfo.map((si) => ({ sheet_id: si.sheet_id, sheet: label(si.sheet_id), scale_source: si.scale_source ?? si.source ?? "unknown", scale_confirmed: si.scale_confirmed !== false })),
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
    // condition_id + condition APPEND again, same rule. condition is the
    // resolved finish_tag rather than only the id, so a reader of the export
    // can see WHICH scope an annotation is about without joining two arrays;
    // the id stays authoritative. Unattached markups: "" for both.
    markups: markups.map((m) => {
      const c = m.condition_id ? (rows || []).find((r) => r.id === m.condition_id) : null;
      return { type: m.type, sheet_id: m.sheet_id, sheet: label(m.sheet_id), text: m.text || "", id: m.id ?? null, rfi_id: m.rfi_id || "", condition_id: m.condition_id || "", condition: c?.finish_tag || "" };
    }),
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
    // shape-level phase/area labels (#112) APPEND after condition_columns and
    // are always emitted (empty when unused) per the additive-only v1 rule:
    // shape_labels is the project vocabulary; by_label is the group-by-label
    // breakdown — ORDERED per-bucket quantities (waste/×N applied), matching the
    // report's interactive view, unlike the BASE by_sheet reference above.
    shape_labels: (Array.isArray(shapeLabels) ? shapeLabels : []).filter((v) => typeof v === "string" && v.trim()),
    by_label: (Array.isArray(byLabel) ? byLabel : []).map((gp) => ({
      label: gp.value ?? null,   // null = Unlabeled
      rows: (gp.rows || []).map((r) => ({ id: r.id, finish_tag: r.finish_tag, floor_sf: r.floor_sf, wall_sf: r.wall_sf, border_sf: r.border_sf, lf: r.lf, ea: r.ea, total_sf: r.total_sf, total_sf_net: r.total_sf_net })),
    })),
    // units metadata APPENDS last (additive-only v1): every quantity above is
    // RAW internal feet (SF/LF/SY keys, uninterpretable otherwise); this is
    // the display system the exporting user was reading — the units port's
    // "JSON stays raw, but says so" contract.
    units: "imperial (SF/LF — raw internal values)",
    display_units: displayUnits === "metric" ? "metric" : "imperial",
    // roll_goods APPENDS last (additive-only v1, #136): one row per roll-goods
    // condition — the figured order (order_lf / rolls / order_qty in the
    // condition's sell unit, ×N applied like every reported quantity) beside
    // the measured quantities the conditions[] rows already carry. Always
    // emitted; empty for projects with no roll-goods conditions, so every
    // pre-#136 export round-trips byte-identically except this one key.
    roll_goods: Array.isArray(rollGoods) ? rollGoods : [],
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
