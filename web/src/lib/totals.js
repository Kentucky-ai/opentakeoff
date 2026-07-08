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

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

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

export function grandTotals(rows) {
  const sum = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
  return {
    total_sf: round2(sum("total_sf")), total_sf_net: round2(sum("total_sf_net")),
    lf: round2(sum("lf")), lf_net: round2(sum("lf_net")),
    ea: sum("ea"), sy_net: round2(sum("sy_net")),
  };
}

// CSV: one row per condition, with both net (measured) and waste-adjusted columns.
// units: "imperial" (SF/LF/SY) or "metric" (m²/m — SY column drops; supporting-
// material coverage stays as entered, SF/LF-based).
export function totalsToCsv(rows, projectName = "", units = "imperial") {
  const M = units === "metric";
  const A = (sf) => (M ? +(sf * 0.09290304).toFixed(2) : sf);
  const L = (lf) => (M ? +(lf * 0.3048).toFixed(2) : lf);
  const AU = M ? "m2" : "SF", LU = M ? "m" : "LF";
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    "Finish", "Shapes", "Multiplier", "Waste %",
    `Floor ${AU}`, `Wall ${AU}`, `Border ${AU}`, `Total ${AU}`, LU, "EA",
    `Total ${AU} (w/ waste)`, `${LU} (w/ waste)`, ...(M ? [] : ["SY (w/ waste)"]),
  ];
  const lines = [header.map(esc).join(",")];
  for (const r of rows) {
    lines.push([
      r.finish_tag, r.shape_count, r.multiplier, r.waste_pct,
      A(r.floor_sf), A(r.wall_sf), A(r.border_sf), A(r.total_sf), L(r.lf), r.ea,
      A(r.total_sf_net), L(r.lf_net), ...(M ? [] : [r.sy_net]),
    ].map(esc).join(","));
  }
  const g = grandTotals(rows);
  lines.push(["TOTAL", "", "", "", "", "", "", A(g.total_sf), L(g.lf), g.ea, A(g.total_sf_net), L(g.lf_net), ...(M ? [] : [g.sy_net])].map(esc).join(","));

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
