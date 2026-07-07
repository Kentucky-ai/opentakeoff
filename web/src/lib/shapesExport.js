// Per-shape detail export — MEASURED quantities only: no condition multiplier,
// no waste (those are condition-level report adjustments; see totals.js).
// Deduct rows carry NEGATIVE area SF so a column sum reconciles with the
// condition's floor SF. The LF column on floor_area / deduct / surface_area
// rows is the traced perimeter or run — a REFERENCE figure (floor perimeters
// include door openings and shared walls), never counted in the condition's
// LF total; only linear rows sum to it.

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
      height_ft: Number(s.height_ft) || 0,
      height_override: s.height_override === true,
      origin: s.origin?.method || "untracked",
    };
  });
}

export function shapesToCsv(rows, projectName = "") {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["Shape", "Sheet", "Sheet ID", "Finish", "Role", "Area SF", "LF", "EA", "Height ft", "Height override", "Origin"];
  const lines = [
    "# Per-shape measured quantities — no multiplier or waste; deducts negative; LF on floor/deduct/surface rows is trace reference only (incl. openings) — linear rows alone sum to condition LF",
    header.map(esc).join(","),
  ];
  for (const r of rows) {
    lines.push([
      r.shape_id, r.sheet, r.sheet_id, r.finish, r.role,
      r.area_sf, r.lf, r.ea, r.height_ft,
      r.height_override ? "yes" : "",
      r.origin,
    ].map(esc).join(","));
  }
  const title = projectName ? `# ${projectName} — OpenTakeoff shapes\n` : "";
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
