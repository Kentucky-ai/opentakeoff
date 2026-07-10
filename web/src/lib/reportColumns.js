// Column selection for the report table + CSV export: shared value getters,
// per-target column profiles, and a single visibility pref for both.
//
// conditionTotals rows are spread into an external contribution payload, so
// derived columns live HERE (getters), never as new row fields.
import { round2 } from "./num.js";
import { attrValue, columnLabel } from "./conditionColumns.js";

// key → (row, ctx) => primitive. ctx (optional):
//   { perimByCond: Map(condition_id → unrounded floor-perimeter LF) }
export const GETTERS = {
  finish: (r) => r.finish_tag,
  shapes: (r) => r.shape_count,
  multiplier: (r) => r.multiplier,
  waste_pct: (r) => r.waste_pct,
  floor_sf: (r) => r.floor_sf,
  wall_sf: (r) => r.wall_sf,
  border_sf: (r) => r.border_sf,
  total_sf: (r) => r.total_sf,
  lf: (r) => r.lf,
  ea: (r) => r.ea,
  total_sf_net: (r) => r.total_sf_net,
  lf_net: (r) => r.lf_net,
  sy_net: (r) => r.sy_net,
  // opt-in derivations: order − base (total_sf = floor+wall+border, so
  // waste_sf covers all three)
  waste_sf: (r) => round2(r.total_sf_net - r.total_sf),
  waste_lf: (r) => round2(r.lf_net - r.lf),
  // reference only: floor perimeters include door openings and shared walls —
  // never waste-adjusted, never in grand totals. ×N multiplies like every other
  // quantity (the verticalWallSf convention).
  perimeter_ref: (r, ctx) => round2((ctx?.perimByCond?.get(r.id) || 0) * (r.multiplier || 1)),
};

// Table columns: order + header + default visibility. foot(g) fills the tfoot
// cell from grandTotals(rows); undefined → blank. ref: never in the tfoot.
export const TABLE_PROFILE = [
  { key: "finish",        header: "Finish",     defaultVisible: true, locked: true },
  { key: "shapes",        header: "Shapes",     defaultVisible: true },
  { key: "floor_sf",      header: "Floor SF",   defaultVisible: true },
  { key: "wall_sf",       header: "Wall SF",    defaultVisible: true },
  { key: "border_sf",     header: "Border SF",  defaultVisible: true },
  { key: "lf",            header: "LF",         defaultVisible: true },
  { key: "ea",            header: "EA",         defaultVisible: true },
  { key: "waste_pct",     header: "Waste",      defaultVisible: true },
  { key: "total_sf_net",  header: "SF ordered", defaultVisible: true,  accent: true, foot: (g) => g.total_sf_net },
  { key: "sy_net",        header: "SY",         defaultVisible: true,  accent: true, foot: (g) => g.sy_net },
  // grandTotals output carries all four keys the waste getters read, so the
  // TOTAL cells delegate to the same formulas as the body cells
  { key: "waste_sf",      header: "Waste SF",   defaultVisible: false, foot: (g) => GETTERS.waste_sf(g) },
  { key: "waste_lf",      header: "Waste LF",   defaultVisible: false, foot: (g) => GETTERS.waste_lf(g) },
  { key: "perimeter_ref", header: "Perim LF (ref)", defaultVisible: false, ref: true },
];

// CSV columns. The first 13 are the frozen v1 export (byte-stable, golden-
// tested); opt-ins APPEND at the end — never reorder or rename the base 13.
export const CSV_PROFILE = [
  { key: "finish",       header: "Finish",              defaultVisible: true, locked: true },
  { key: "shapes",       header: "Shapes",              defaultVisible: true },
  { key: "multiplier",   header: "Multiplier",          defaultVisible: true },
  { key: "waste_pct",    header: "Waste %",             defaultVisible: true },
  { key: "floor_sf",     header: "Floor SF",            defaultVisible: true },
  { key: "wall_sf",      header: "Wall SF",             defaultVisible: true },
  { key: "border_sf",    header: "Border SF",           defaultVisible: true },
  { key: "total_sf",     header: "Total SF",            defaultVisible: true },
  { key: "lf",           header: "LF",                  defaultVisible: true },
  { key: "ea",           header: "EA",                  defaultVisible: true },
  { key: "total_sf_net", header: "Total SF (w/ waste)", defaultVisible: true },
  { key: "lf_net",       header: "LF (w/ waste)",       defaultVisible: true },
  { key: "sy_net",       header: "SY (w/ waste)",       defaultVisible: true },
  { key: "waste_sf",      header: "Waste SF", defaultVisible: false },
  { key: "waste_lf",      header: "Waste LF", defaultVisible: false },
  { key: "perimeter_ref", header: "Perimeter LF (ref, incl. openings)", defaultVisible: false },
];

// The one getter-resolution rule for a column descriptor: custom columns
// carry their own get; built-ins come from GETTERS. Table (renderCell), CSV
// (totalsToCsv), and XLSX (reportWorkbook) all resolve through here so the
// three outputs can never read different values for the same column.
export const colGetter = (c) => c.get || GETTERS[c.key];

// User-defined condition columns → runtime column descriptors, appended after
// either profile. Keys are "custom:<colId>" — can't collide with built-in
// keys, grandTotals keys, or colPrefs. Descriptors carry their own `get`
// (call sites fall back to GETTERS for built-ins); values arrive via
// ctx.attrsByCond (Map(condition_id → attrs)), never as new row fields —
// conditionTotals rows are spread into the contribution payload.
export function customColProfile(conditionColumns) {
  // require an array — a truthy non-array from a corrupted payload must not throw
  return (Array.isArray(conditionColumns) ? conditionColumns : []).map((cc) => ({
    key: "custom:" + cc.id,
    header: columnLabel(cc),
    defaultVisible: false,
    custom: true,
    // attrValue is the one definition of "assigned" — hydrate strips corrupt
    // values (sanitizeConditionAttrs), and this keeps table/CSV/XLSX on the
    // same rule as grouping, JSON, and the canvas UI
    get: (r, ctx) => attrValue(ctx?.attrsByCond?.get(r.id), cc.id),
  }));
}

// ── Product spec (schedule-import metadata) ─────────────────────────────────
// The schedule importer attaches an optional `condition.spec =
// { manufacturer, style, color, size }` (all strings; the whole field is
// ABSENT when there's no spec). These are READ-ONLY imported attributes — not a
// custom column, not in materials[] — surfaced as fixed report/CSV/XLSX columns
// so an estimator can review the specified product next to the measured
// quantities. Values reach the getters through ctx.specByCond (Map(condition_id
// → spec)), the same seam custom columns use, so conditionTotals rows never
// grow a `spec` field (they're spread wholesale into the contribution payload).
//
// The four fields, in schedule order. "Spec Color" is deliberately NOT "Color"
// — the condition's own appearance color is a different thing.
export const SPEC_FIELDS = [
  { field: "manufacturer", header: "Manufacturer" },
  { field: "style",        header: "Style" },
  { field: "color",        header: "Spec Color" },
  { field: "size",         header: "Size" },
];

// The one visible-string rule for a spec value — a string with visible content
// counts; a non-object spec, a missing field, an empty/whitespace-only or
// non-string value is nothing. Returned untrimmed (imported strings unmutated).
export function specValue(spec, field) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return "";
  const v = spec[field];
  return typeof v === "string" && v.trim() ? v : "";
}

// Spec fields → runtime column descriptors, appended after the custom columns.
// Data-driven like customColProfile: a field-column is emitted ONLY when at
// least one condition carries a visible value for it, so a project with no
// specs produces ZERO extra columns (byte-identical report/CSV/XLSX) and an
// all-blank field never adds a dead column. Keys are "spec:<field>" — can't
// collide with built-in keys, grandTotals keys, or custom "custom:<id>" keys.
// Default-visible (imported metadata is worth showing) but still toggleable in
// the picker; `spec: true` marks them read-only text at the render sites.
export function specColProfile(conditions) {
  const list = Array.isArray(conditions) ? conditions : [];
  return SPEC_FIELDS.filter((f) => list.some((c) => specValue(c?.spec, f.field))).map((f) => ({
    key: "spec:" + f.field,
    header: f.header,
    defaultVisible: true,
    spec: true,
    get: (r, ctx) => specValue(ctx?.specByCond?.get(r.id), f.field),
  }));
}

// Partition condition rows by one custom column's assigned value, for the
// report's grouped view → [{ value: string|null, label, rows }]. Order:
// vocabulary order first, then ad-hoc values (assigned strings missing from
// the vocabulary — the "(removed)" case) sorted, then the null/Unassigned
// group LAST. Empty groups dropped. Groups key on value: string|null so a
// vocabulary value literally named "Unassigned" can't merge with the null
// group. attrValue's shared rule folds non-strings, "" and whitespace-only
// into the null group — never an empty-labeled ad-hoc group.
export function partitionRowsBy(rows, columnDef, attrsByCond) {
  const byValue = new Map(); // assigned value → rows, in first-seen order
  const nullRows = [];
  for (const r of rows) {
    const v = attrValue(attrsByCond?.get(r.id), columnDef.id);
    if (v) {
      if (!byValue.has(v)) byValue.set(v, []);
      byValue.get(v).push(r);
    } else {
      nullRows.push(r);
    }
  }
  const groups = [];
  // vocabulary values first, in vocabulary order; delete as consumed so a
  // duplicated vocabulary entry can't emit the same group twice
  for (const v of columnDef.values || []) {
    if (!byValue.has(v)) continue; // empty group dropped
    groups.push({ value: v, label: v, rows: byValue.get(v) });
    byValue.delete(v);
  }
  // what's left is ad-hoc (assigned but not in the vocabulary), sorted
  for (const v of [...byValue.keys()].sort()) {
    groups.push({ value: v, label: v, rows: byValue.get(v) });
  }
  if (nullRows.length) groups.push({ value: null, label: "Unassigned", rows: nullRows });
  return groups;
}

// D7 force-include: a grouped report's CSV/XLSX always carries its grouping
// column, even when hidden in the picker. cols = a visibleCols() result;
// customCols = the full customColProfile() list (the descriptor to append
// lives there). groupBy values that aren't a custom column ("" / "sheet")
// pass cols through untouched. tableCols never go through this — the table
// shows the values as group headers already.
export function forceIncludeGroupCol(cols, customCols, groupBy) {
  if (!groupBy) return cols;
  const key = "custom:" + groupBy;
  if (cols.some((c) => c.key === key)) return cols; // already visible — no duplicate
  const col = customCols.find((c) => c.key === key);
  return col ? [...cols, col] : cols;
}

// One visibility pref shared by table + CSV: a JSON object of key → boolean
// OVERRIDES of defaultVisible (diffs only), so new defaults reach old prefs.
const PREFS_KEY = "opentakeoff_report_cols";

export function loadColPrefs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // private mode / SSR / corrupt JSON
  }
}

export function saveColPrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs || {}));
  } catch {
    /* private mode */
  }
}

// Group-by choice for the report table: "" (none) | "sheet" | a custom column
// id. Stored raw; ReportPanel normalizes against the current definitions on
// EVERY render — never trust the stored value (a stale colId in a React
// select whose value matches no option misrenders while still partitioning
// everything into Unassigned).
const GROUPBY_KEY = "opentakeoff_report_groupby";

export function loadGroupBy() {
  try {
    const v = localStorage.getItem(GROUPBY_KEY);
    return typeof v === "string" ? v : "";
  } catch {
    return ""; // private mode / SSR
  }
}

export function saveGroupBy(v) {
  try {
    localStorage.setItem(GROUPBY_KEY, v || "");
  } catch {
    /* private mode */
  }
}

export function visibleCols(profile, prefs) {
  // locked columns ignore prefs entirely — a hand-edited localStorage entry
  // must not hide the Finish column the tfoot/TOTAL row anchor on
  return profile.filter((c) => c.locked || (prefs?.[c.key] ?? c.defaultVisible));
}

// ctx.perimByCond source: unrounded per-condition floor-perimeter sums (the
// verticalWallSf pattern) — computed from shapes, outside conditionTotals.
export function floorPerimeterLf(shapes) {
  const map = new Map();
  for (const s of shapes) {
    if (s.measure_role !== "floor_area") continue;
    map.set(s.condition_id, (map.get(s.condition_id) || 0) + (s.computed?.perimeter_lf || 0));
  }
  return map;
}
