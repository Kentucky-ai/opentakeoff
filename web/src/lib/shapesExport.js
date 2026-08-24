// Per-shape detail export — MEASURED quantities only: no condition multiplier,
// no waste (those are condition-level report adjustments; see totals.js).
// Deduct rows carry NEGATIVE area SF so a column sum reconciles with the
// condition's floor SF. The LF column on floor_area / deduct / surface_area
// rows is the traced perimeter or run — a REFERENCE figure (floor perimeters
// include door openings and shared walls), never counted in the condition's
// LF total; only linear rows sum to it.

import { csvEsc as esc } from "./csv.js";
import { M_PER_FT, M2_PER_SF } from "./units.js";
import { round2 } from "./num.js";
import i18n from '../i18n/index.js';
const _t = (key) => i18n.t(key, { ns: 'lib' });

export function shapesDetail(conditions, shapes, sheetLabel) {
  const byId = new Map(conditions.map((c) => [c.id, c]));
  return shapes.map((s) => {
    const cond = byId.get(s.condition_id);
    const cp = s.computed || {};
    const role = s.measure_role;
    let area_sf = 0, lf = 0, ea = 0;
    switch (role) {
      case "deduct": area_sf = -(cp.area_sf || 0); lf = cp.perimeter_lf || 0; break;
      case "floor_area":
      case "surface_area":
      case "linear": area_sf = cp.area_sf || 0; lf = cp.perimeter_lf || 0; break;
      case "count": ea = cp.count || 1; break;
      default: break;
    }
    return {
      shape_id: s.id,
      sheet_id: s.sheet_id,
      sheet: sheetLabel ? sheetLabel(s.sheet_id) : s.sheet_id,
      finish: cond?.finish_tag ?? "",
      role,
      area_sf, lf, ea,
      // recomputeShape's height semantics, mirrored: an explicit override wins
      // outright (even 0); a legacy shape without its own height reports the
      // condition height its wall SF was actually computed against.
      height_ft: s.height_override === true
        ? Number(s.height_ft) || 0
        : Number(s.height_ft) || Number(cond?.height_ft) || 0,
      height_override: s.height_override === true,
      origin: s.origin?.method || "untracked",
    };
  });
}

export function shapesToCsv(rows, projectName = "", brandName = "OpenTakeoff", units = "imperial") {
  const M = units === "metric";
  // In metric mode, headers use m²/m/m for human readability; raw canonical
  // internal feet are converted to display units (like the Conditions tab).
  const AU = M ? "m²" : "SF", LU = M ? "m" : "LF", HU = M ? "m" : "ft";
  const header = [_t("shape.shape"), _t("shape.sheet"), _t("shape.sheet_id"), _t("shape.finish"), _t("shape.role"), _t("shape.area_sf").replace("SF", AU), _t("shape.lf").replace("LF", LU), _t("shape.ea"), _t("shape.height_ft").replace("ft", HU), _t("shape.height_override"), _t("shape.origin")];
  const lines = [
    M
      ? "# Per-shape measured quantities — no multiplier or waste; deducts negative; m on floor/deduct/surface rows is trace reference only (incl. openings) — linear rows alone sum to condition m"
      : "# Per-shape measured quantities — no multiplier or waste; deducts negative; LF on floor/deduct/surface rows is trace reference only (incl. openings) — linear rows alone sum to condition LF",
    header.map(esc).join(","),
  ];
  for (const r of rows) {
    lines.push([
      r.shape_id, r.sheet, r.sheet_id, r.finish, r.role,
      M ? round2((Number(r.area_sf) || 0) * M2_PER_SF) : r.area_sf,
      M ? round2((Number(r.lf) || 0) * M_PER_FT) : r.lf,
      r.ea,
      M ? round2((Number(r.height_ft) || 0) * M_PER_FT) : r.height_ft,
      r.height_override ? "yes" : "",
      r.origin,
    ].map(esc).join(","));
  }
  const title = projectName ? `# ${projectName} — ${brandName} shapes\n` : "";
  return title + lines.join("\n") + "\n";
}

export function shapesToJson(rows, projectName) {
  return {
    schema: "opentakeoff.shapes.v1",
    project_name: projectName || null,
    generated_with: "OpenTakeoff",
    shapes: rows,
  };
}
