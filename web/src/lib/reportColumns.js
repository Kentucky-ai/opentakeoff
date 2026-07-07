// Column selection for the report table + CSV export: shared value getters,
// per-target column profiles, and a single visibility pref for both.
//
// conditionTotals rows are spread into an external contribution payload, so
// derived columns live HERE (getters), never as new row fields.
import { round2 } from "./totals.js";

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
  { key: "waste_sf",      header: "Waste SF",   defaultVisible: false, foot: (g) => round2(g.total_sf_net - g.total_sf) },
  { key: "waste_lf",      header: "Waste LF",   defaultVisible: false, foot: (g) => round2(g.lf_net - g.lf) },
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
