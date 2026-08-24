// Column selection for the report table + CSV export: shared value getters,
// per-target column profiles, and a single visibility pref for both.
//
// conditionTotals rows are spread into an external contribution payload, so
// derived columns live HERE (getters), never as new row fields.
import { round2 } from "./num.js";
import { attrValue, columnLabel } from "./conditionColumns.js";
import { M_PER_FT, M2_PER_SF } from "./units";
import i18n from "../i18n/index.js";

const _t = (key) => i18n.t(key, { ns: "lib" });

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
  // waste_sf covers all three). When either operand is blank/null/undefined
  // the result is blank (not 0 or NaN) — an incomplete row has no waste figure.
  waste_sf: (r) => {
    const a = r.total_sf_net, b = r.total_sf;
    if (a == null || b == null || a === "" || b === "") return "";
    return round2(a - b);
  },
  waste_lf: (r) => {
    const a = r.lf_net, b = r.lf;
    if (a == null || b == null || a === "" || b === "") return "";
    return round2(a - b);
  },
  // reference only: floor perimeters include door openings and shared walls —
  // never waste-adjusted, never in grand totals. ×N multiplies like every other
  // quantity (the verticalWallSf convention).
  perimeter_ref: (r, ctx) => round2((ctx?.perimByCond?.get(r.id) || 0) * (r.multiplier || 1)),
};

// Table columns: order + header + default visibility. foot(g) fills the tfoot
// cell from grandTotals(rows); undefined → blank. ref: never in the tfoot.
// Getter function so headers resolve _t() at render time (language changes propagate).
export const getTableProfile = () => [
  { key: "finish",        header: _t("column.finish"),     defaultVisible: true, locked: true },
  { key: "shapes",        header: _t("column.shapes"),     defaultVisible: true },
  { key: "floor_sf",      header: _t("column.floor_sf"),   defaultVisible: true },
  { key: "wall_sf",       header: _t("column.wall_sf"),    defaultVisible: true },
  { key: "border_sf",     header: _t("column.border_sf"),  defaultVisible: true },
  { key: "total_sf",      header: _t("column.total_sf"),   defaultVisible: false, foot: (g) => g.total_sf },
  { key: "lf",            header: _t("column.lf"),         defaultVisible: true },
  { key: "ea",            header: _t("column.ea"),         defaultVisible: true },
  { key: "waste_pct",     header: _t("column.waste_pct"),  defaultVisible: true },
  { key: "total_sf_net",  header: _t("column.total_sf_net"), defaultVisible: true,  accent: true, foot: (g) => g.total_sf_net },
  { key: "sy_net",        header: _t("column.sy_net"),     defaultVisible: true,  accent: true, foot: (g) => g.sy_net },
  // grandTotals output carries all four keys the waste getters read, so the
  // TOTAL cells delegate to the same formulas as the body cells
  { key: "waste_sf",      header: _t("column.waste_sf"),   defaultVisible: false, foot: (g) => GETTERS.waste_sf(g) },
  { key: "waste_lf",      header: _t("column.waste_lf"),   defaultVisible: false, foot: (g) => GETTERS.waste_lf(g) },
  { key: "perimeter_ref", header: _t("column.perimeter_ref"), defaultVisible: false, ref: true },
];
// Legacy static export
export const TABLE_PROFILE = getTableProfile();

// CSV columns. The first 13 are the frozen v1 export (byte-stable, golden-
// tested); opt-ins APPEND at the end — never reorder or rename the base 13.
export const getCsvProfile = () => [
  { key: "finish",       header: _t("column.finish"),    defaultVisible: true, locked: true },
  { key: "shapes",       header: _t("column.shapes"),    defaultVisible: true },
  { key: "multiplier",   header: _t("column.multiplier"), defaultVisible: true },
  { key: "waste_pct",    header: _t("column.waste_pct_csv"), defaultVisible: true },
  { key: "floor_sf",     header: _t("column.floor_sf"),  defaultVisible: true },
  { key: "wall_sf",      header: _t("column.wall_sf"),   defaultVisible: true },
  { key: "border_sf",    header: _t("column.border_sf"), defaultVisible: true },
  { key: "total_sf",     header: _t("column.total_sf"),  defaultVisible: true },
  { key: "lf",           header: _t("column.lf"),        defaultVisible: true },
  { key: "ea",           header: _t("column.ea"),        defaultVisible: true },
  { key: "total_sf_net", header: _t("column.total_sf_net_csv"), defaultVisible: true },
  { key: "lf_net",       header: _t("column.lf_net"),    defaultVisible: true },
  { key: "sy_net",       header: _t("column.sy_net"),    defaultVisible: true },
  { key: "waste_sf",      header: _t("column.waste_sf"), defaultVisible: false },
  { key: "waste_lf",      header: _t("column.waste_lf"), defaultVisible: false },
  { key: "perimeter_ref", header: _t("column.perimeter_ref_csv"), defaultVisible: false },
];
// Legacy static export
export const CSV_PROFILE = getCsvProfile();

// The one getter-resolution rule for a column descriptor: custom columns
// carry their own get; built-ins come from GETTERS. Table (renderCell), CSV
// (totalsToCsv), and XLSX (reportWorkbook) all resolve through here so the
// three outputs can never read different values for the same column.
export const colGetter = (c) => c.get || GETTERS[c.key];

// ── Metric display (units port) ─────────────────────────────────────────────
// Unit-system conversion happens at the COLUMN DESCRIPTOR, the one seam every
// output (table, CSV, XLSX Conditions tab) already resolves values through —
// internal math stays feet (lib/units contract). In metric the SY column
// retires, headers swap SF→m² / LF→m, and each dimensioned column's getter
// (and tfoot foot) wraps in the converter; the descriptor also carries `conv`
// so the CSV/XLSX TOTAL rows (which read grandTotals by key, not through
// getters) convert the same way. Imperial passes the input through UNTOUCHED —
// identity, so the frozen v1 CSV golden and every existing caller are
// byte-identical.
const COL_DIM = {
  floor_sf: "area", wall_sf: "area", border_sf: "area", total_sf: "area",
  total_sf_net: "area", waste_sf: "area",
  lf: "len", lf_net: "len", waste_lf: "len", perimeter_ref: "len",
  "roll:order_lf": "len", "roll:seam_lf": "len",
};
export const METRIC_LABELS = { area: "m²", len: "m" };        // on-screen table
export const METRIC_CSV_LABELS = { area: "m2", len: "m" };    // CSV/XLSX (ASCII, matches the legend PDF)
export function applyUnits(cols, units, labels = METRIC_LABELS) {
  if (units !== "metric") return cols;
  return cols.filter((c) => c.key !== "sy_net").map((c) => {
    const dim = COL_DIM[c.key];
    if (!dim) return c;
    const conv = dim === "area"
      ? (v) => (v === "" || v === null || v === undefined ? "" : round2((Number(v) || 0) * M2_PER_SF))
      : (v) => (v === "" || v === null || v === undefined ? "" : round2((Number(v) || 0) * M_PER_FT));
    const base = colGetter(c);
    return {
      ...c,
      header: c.header.replace(/\bSF\b/g, labels.area).replace(/\bLF\b/g, labels.len),
      conv,
      get: (r, ctx) => conv(base(r, ctx)),
      ...(c.foot ? { foot: (g) => conv(c.foot(g)) } : {}),
    };
  });
}

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
// { manufacturer, style, color, size, description }` (all strings; the whole
// field is ABSENT when there's no spec). These are imported attributes — not a
// custom column, not in materials[] — surfaced as fixed report/CSV/XLSX columns
// so an estimator can review the specified product next to the measured
// quantities. Values reach the getters through ctx.specByCond (Map(condition_id
// → spec)), the same seam custom columns use, so conditionTotals rows never
// grow a `spec` field (they're spread wholesale into the contribution payload).
//
// The five fields, in schedule order. "Spec Color" is deliberately NOT "Color"
// — the condition's own appearance color is a different thing. `description` is
// APPENDED (never inserted) so existing spec-column order in shipped exports is
// preserved when it's added.
export const SPEC_FIELDS = [
  { field: "manufacturer", header: "Manufacturer" },
  { field: "style",        header: "Style" },
  { field: "color",        header: "Spec Color" },
  { field: "size",         header: "Size" },
  { field: "description",  header: "Description" },
];

// i18n key mapping for spec column headers — resolved at profile-generation
// time so the active locale is respected. The static `.header` on SPEC_FIELDS
// remains the English canonical reference (tests, golden CSV byte-stability).
const SPEC_HEADER_I18N = {
  manufacturer: "column.spec_manufacturer",
  style:        "column.spec_style",
  color:        "column.spec_color",
  size:         "column.spec_size",
  description:  "column.spec_description",
};

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
// Header resolves through i18n so localized exports follow the active locale.
export function specColProfile(conditions) {
  const list = Array.isArray(conditions) ? conditions : [];
  return SPEC_FIELDS.filter((f) => list.some((c) => specValue(c?.spec, f.field))).map((f) => ({
    key: "spec:" + f.field,
    header: _t(SPEC_HEADER_I18N[f.field] || f.header),
    defaultVisible: true,
    spec: true,
    get: (r, ctx) => specValue(ctx?.specByCond?.get(r.id), f.field),
  }));
}

// ── Labor & subfloor type (typed directly on the condition) ────────────────
// Free-text `condition.laborType` / `condition.subfloorType` — filled in by
// hand in the Supporting Materials panel, no import, no vocabulary. Same
// treatment as spec above: values reach the getters through ctx.laborByCond
// (Map(condition_id → { laborType, subfloorType })), never as new
// conditionTotals row fields, and a field-column is emitted only when at
// least one condition carries a visible value — a project that never uses
// them produces zero extra columns.
export const LABOR_FIELDS = [
  { field: "laborType", header: "Labor Type" },
  { field: "subfloorType", header: "Subfloor Type" },
];

// i18n key mapping for labor/subfloor column headers (same pattern as spec).
const LABOR_HEADER_I18N = {
  laborType:   "column.labor_type",
  subfloorType: "column.subfloor_type",
};

export function laborValue(labor, field) {
  if (!labor || typeof labor !== "object" || Array.isArray(labor)) return "";
  const v = labor[field];
  return typeof v === "string" && v.trim() ? v : "";
}

export function laborColProfile(conditions) {
  const list = Array.isArray(conditions) ? conditions : [];
  return LABOR_FIELDS.filter((f) => list.some((c) => laborValue(c, f.field))).map((f) => ({
    key: "labor:" + f.field,
    header: _t(LABOR_HEADER_I18N[f.field] || f.header),
    defaultVisible: true,
    labor: true,
    get: (r, ctx) => laborValue(ctx?.laborByCond?.get(r.id), f.field),
  }));
}

// ── Roll goods (#136) ───────────────────────────────────────────────────────
// The figured order beside the measured quantities: order footage down the
// roll (side-by-side cuts share length — NOT a sum of cut lengths) and the
// physical roll count. Values arrive via ctx.rollByCond (Map(condition_id →
// computeRollTakeoff summary)), the spec/labor seam — never as row fields.
// Emitted only when at least one condition actually figures a roll layout, so
// a project without roll goods is byte-identical (frozen 13 → built-in
// opt-ins → custom → spec → labor → roll). ×N applies like every quantity —
// N identical units are N cuttings of the same layout.
export const ROLL_FIELDS = [
  { key: "roll:order_lf", header: "Roll Order LF", get: (ri, mult) => round2(ri.orderFt * mult) },
  { key: "roll:rolls", header: "Rolls", get: (ri, mult) => ri.rollCount * mult },
  // The figured weld-rod / seam-tape length — where two cuts meet on the
  // floor, read off the layout rather than guessed as a share of perimeter.
  // 0 is a real answer: a layout whose rooms each take one strip has nothing
  // to weld. Appended last, so the two pre-existing roll columns keep their
  // order in every export that already carried them.
  { key: "roll:seam_lf", header: "Seam LF", get: (ri, mult) => round2((ri.seamLf || 0) * mult) },
];

// i18n key mapping for roll-goods column headers (same pattern as spec/labor).
const ROLL_HEADER_I18N = {
  "roll:order_lf": "column.roll_order_lf",
  "roll:rolls":    "column.rolls",
  "roll:seam_lf":  "column.seam_lf",
};

export function rollColProfile(rollByCond) {
  if (!(rollByCond instanceof Map) || !rollByCond.size) return [];
  return ROLL_FIELDS.map((f) => ({
    key: f.key,
    header: _t(ROLL_HEADER_I18N[f.key] || f.header),
    defaultVisible: true,
    roll: true,
    get: (r, ctx) => {
      const ri = ctx?.rollByCond?.get(r.id);
      return ri ? f.get(ri, r.multiplier || 1) : "";
    },
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
