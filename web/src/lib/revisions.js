// Revision compare — bid revisions and addenda as QUANTITY deltas.
//
// The diff is deliberately quantity-level, not geometric: shape uids don't
// survive a re-imported sheet or a deleted-and-redrawn room, so pairing shapes
// across revisions would read as noise. What an estimator actually reviews
// after Addendum 2 lands is "which finish moved, by how much, and on which
// sheet" — so both payloads are totaled with the SAME role math the report
// uses (conditionTotals) and the totals are diffed.
//
// Condition pairing: id first. Conditions that were deleted and recreated get
// fresh uids, so unmatched rows then pair by finish_tag, in order — two
// leftover "CT-1" rows on each side pair first-with-first, and the pair key
// carries an ordinal so duplicate tags can't collide in maps or React keys.
//
// "Changed" is judged at DISPLAY precision (quantities render 1 decimal, EA
// whole): sub-display drift — a 0.02 SF wobble from re-tracing the same room —
// is not a change the reviewer can even see, so it reports unchanged.

import { conditionTotals, grandTotals, materialsSummary } from "./totals.js";
import { parseSheetKey } from "./sheets";
import { M2_PER_SF, M_PER_FT, isVisibleDelta } from "./units.js";
import i18n from "../i18n/index.js";

const _t = (key, options) => i18n.t(key, { ns: "lib", ...options });

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// The condition-level fields compared. lf_net tracks the waste-adjusted linear
// quantity so a waste_pct-only edit on a linear condition shows there.  total_sf_net
// is the ordered quantity, so a waste_pct-only edit shows there and only there.
export const COND_FIELDS = ["floor_sf", "wall_sf", "border_sf", "lf", "lf_net", "ea", "total_sf", "total_sf_net"];
// Sheet-level rows carry base measured quantities (no multiplier, no waste —
// those are condition-level ordering concerns, not sheet locations).
export const SHEET_FIELDS = ["floor_sf", "wall_sf", "border_sf", "lf", "ea"];

// Display precision: 2 dp for metric m²/m, 0 dp for EA.  Imperial passes
// through unrounded (the same raw precision the report table's num() uses
// with maximumFractionDigits).
const DISP_DP = (units, field) => {
  if (field === "ea") return 0;
  return units === "metric" ? 2 : 0;
};
// Convert a raw internal-feet delta to a display-ready number at the correct
// precision.  Used by both the UI and CSV so they never diverge.
export const convertDelta = (rawVal, units, field) => {
  if (field === "ea") return rawVal;
  const isArea = /sf|border|total/i.test(field);
  if (units === "metric") {
    return +(rawVal * (isArea ? M2_PER_SF : M_PER_FT)).toFixed(DISP_DP(units, field));
  }
  // Imperial: preserve raw precision (no rounding) — the table's num() handles
  // display formatting via maximumFractionDigits.
  return rawVal;
};

// Check visibility against the RAW delta (before rounding).  Rounding to 2 dp
// can promote a sub-threshold delta past the gate (e.g. 0.049 → 0.05) or
// suppress a just-above-threshold delta to zero display.  The diff stores
// rounded deltas for display but judges "changed" on the raw figure.
function rawVisible(fields, rawDeltas, units) {
  return fields.some((f) => isVisibleDelta(f, rawDeltas[f], units));
}
function rawSubstance(fields, r, units) {
  return r.shape_count > 0 || fields.some((f) => isVisibleDelta(f, r[f] || 0, units));
}

// Compute both raw and rounded deltas.  Raw deltas drive visibility judgment;
// rounded deltas are stored for display and export.  When a condition row
// carries _raw (from conditionTotals), use those for the visibility comparison
// so sub-rounding drift never creates a false "changed" or hides a real one.
function deltasOf(fields, a, b) {
  /** @type {Record<string, number>} */
  const raw = {};
  /** @type {Record<string, number>} */
  const rounded = {};
  for (const f of fields) {
    const aRaw = a?._raw?.[f] ?? (a ? a[f] || 0 : 0);
    const bRaw = b?._raw?.[f] ?? (b ? b[f] || 0 : 0);
    const r = bRaw - aRaw;
    raw[f] = r;
    rounded[f] = round2(r);
  }
  return { raw, rounded };
}

// Pair rows across revisions: id match first, finish_tag fallback for the
// leftovers (first-come within a tag, empty tags never pair). Entries come
// back in B order with removed-A rows appended — review reads top to bottom
// as "the takeoff as it stands now, then what disappeared".
function pairRows(rowsA, rowsB) {
  const aById = new Map(rowsA.map((r) => [r.id, r]));
  const matched = new Set(rowsB.filter((b) => aById.has(b.id)).map((b) => b.id));

  const tagQueues = new Map();                    // finish_tag -> unmatched A rows, A order
  for (const a of rowsA) {
    if (matched.has(a.id) || !a.finish_tag) continue;
    let q = tagQueues.get(a.finish_tag);
    if (!q) { q = []; tagQueues.set(a.finish_tag, q); }
    q.push(a);
  }

  const consumedA = new Set(matched);
  const ordinals = new Map();
  const entries = [];
  for (const b of rowsB) {
    if (matched.has(b.id)) { entries.push({ key: b.id, a: aById.get(b.id), b }); continue; }
    const q = b.finish_tag ? tagQueues.get(b.finish_tag) : null;
    const a = q && q.length ? q.shift() : null;
    if (a) {
      const n = ordinals.get(b.finish_tag) || 0;
      ordinals.set(b.finish_tag, n + 1);
      consumedA.add(a.id);
      entries.push({ key: `tag:${b.finish_tag}#${n}`, a, b });
    } else entries.push({ key: b.id, a: null, b });
  }
  for (const a of rowsA) if (!consumedA.has(a.id)) entries.push({ key: a.id, a, b: null });
  return entries;
}

// Base quantities per sheet, all conditions pooled — "which sheet moved".
// Orphan shapes (deleted condition) are skipped, matching the report's math.
// Returns _raw (unrounded) alongside rounded values so diffs can use raw
// precision for visibility/conversion.
function perSheet(conditions, shapes) {
  const live = new Set((conditions || []).map((c) => c.id));
  const acc = new Map();
  for (const s of shapes || []) {
    if (!live.has(s.condition_id) || !s.sheet_id) continue;
    let row = acc.get(s.sheet_id);
    if (!row) { row = { sheet_id: s.sheet_id, floor_sf: 0, wall_sf: 0, border_sf: 0, lf: 0, ea: 0, shape_count: 0 }; acc.set(s.sheet_id, row); }
    row.shape_count++;
    const cp = s.computed || {};
    switch (s.measure_role) {
      // #137 — reconciled deducts (cuts_shape_id set) are already netted into
      // the parent's computed.area_sf; counting them again would double-subtract.
      case "deduct": if (!s.cuts_shape_id) row.floor_sf -= cp.area_sf || 0; break;
      case "floor_area": row.floor_sf += cp.area_sf || 0; break;
      case "surface_area": row.wall_sf += cp.area_sf || 0; break;
      case "linear": row.lf += cp.perimeter_lf || 0; row.border_sf += cp.area_sf || 0; break;
      case "count": row.ea += cp.count || 1; break;
      default: break;
    }
  }
  for (const row of acc.values()) {
    // Store raw values before rounding for diff precision
    row._raw = { floor_sf: row.floor_sf, wall_sf: row.wall_sf, border_sf: row.border_sf, lf: row.lf, ea: row.ea };
    for (const f of SHEET_FIELDS) row[f] = round2(row[f]);
  }
  return acc;
}

// "plan.pdf#3" -> "plan — p.3"
export function revSheetLabel(sheetId) {
  const { file, page } = parseSheetKey(sheetId);
  const stem = file.replace(/\.pdf$/i, "");
  return page > 1 ? `${stem} — p.${page}` : stem;
}

// Diff two takeoff payloads ({ conditions, shapes } — the autosave shape;
// missing arrays tolerated, so {} means "everything on the other side is new").
//
// Returns {
//   conditions: [{ key, finish_tag, color, status, a, b, deltas }],
//   sheets:     [{ sheet_id, status, a, b, deltas }],
//   materials:  [{ name, unit, a_qty, b_qty, delta, status }],
//   totals:     { a, b, deltas },   // grandTotals both sides
//   changed:    n,                  // condition rows that aren't unchanged
// }
export function diffTakeoffs(a, b, units) {
  const rowsA = conditionTotals(a?.conditions || [], a?.shapes || []);
  const rowsB = conditionTotals(b?.conditions || [], b?.shapes || []);

  const conditions = pairRows(rowsA, rowsB).map(({ key, a: ra, b: rb }) => {
    const { raw, rounded } = deltasOf(COND_FIELDS, ra, rb);
    let status;
    if (ra && rb) status = rawVisible(COND_FIELDS, raw, units) ? "changed" : "unchanged";
    else if (rb) status = rawSubstance(COND_FIELDS, rb, units) ? "added" : "unchanged";
    else status = rawSubstance(COND_FIELDS, ra, units) ? "removed" : "unchanged";
    return { key, finish_tag: (rb || ra).finish_tag, color: (rb || ra).color, status, a: ra, b: rb, deltas: rounded, _rawDeltas: raw };
  });

  const shA = perSheet(a?.conditions, a?.shapes), shB = perSheet(b?.conditions, b?.shapes);
  const sheetIds = [...new Set([...shB.keys(), ...shA.keys()])].sort((x, y) => x.localeCompare(y));
  const sheets = sheetIds.map((id) => {
    const ra = shA.get(id) || null, rb = shB.get(id) || null;
    const { raw, rounded } = deltasOf(SHEET_FIELDS, ra, rb);
    let status;
    if (ra && rb) status = rawVisible(SHEET_FIELDS, raw, units) ? "changed" : "unchanged";
    else if (rb) status = "added";
    else status = "removed";
    return { sheet_id: id, status, a: ra, b: rb, deltas: rounded, _rawDeltas: raw };
  });

  // buy-list deltas: same-named materials compared across the whole takeoff —
  // "the adhesive order went from 12 pails to 14" is the sentence this feeds.
  const matKey = (m) => `${m.name}\x00${m.unit}`;
  const matA = new Map(materialsSummary(rowsA).map((m) => [matKey(m), m]));
  const matB = new Map(materialsSummary(rowsB).map((m) => [matKey(m), m]));
  const matKeys = [...new Set([...matB.keys(), ...matA.keys()])];
  const materials = matKeys.map((k) => {
    const ma = matA.get(k), mb = matB.get(k);
    const aq = ma ? ma.qty : 0, bq = mb ? mb.qty : 0;
    const delta = round2(bq - aq);
    return {
      name: (mb || ma).name, unit: (mb || ma).unit, a_qty: aq, b_qty: bq, delta,
      status: !ma ? "added" : !mb ? "removed" : Math.abs(delta) >= 0.005 ? "changed" : "unchanged",
    };
  }).filter((m) => m.a_qty || m.b_qty);

  // Totals: sum raw deltas from conditions (not grandTotals which rounds),
  // so the totals line shows the same visible delta as the condition line.
  const TOTAL_FIELDS = ["total_sf", "total_sf_net", "lf", "lf_net", "ea", "sy_net"];
  /** @type {Record<string, number>} */
  const totalsRaw = {};
  /** @type {Record<string, number>} */
  const totalsRounded = {};
  for (const f of TOTAL_FIELDS) {
    let rawSum = 0;
    for (const c of conditions) rawSum += (c._rawDeltas?.[f] ?? c.deltas[f] ?? 0);
    totalsRaw[f] = rawSum;
    totalsRounded[f] = round2(rawSum);
  }
  const totalsA = grandTotals(rowsA), totalsB = grandTotals(rowsB);
  const totals = { a: totalsA, b: totalsB, deltas: totalsRounded, _rawDeltas: totalsRaw };
  const materialsChanged = materials.some((m) => m.status === "changed" || m.status === "added" || m.status === "removed");
  const changed = conditions.filter((c) => c.status !== "unchanged").length;
  return { conditions, sheets, materials, totals, changed, materialsChanged };
}

// The compare as a CSV record — every row with its status, deltas signed,
// grand-total delta line, then per-sheet and buy-list sections.
export function diffToCsv(diff, { aName = "baseline", bName = "current", units = "imperial", projectName = "" } = {}) {
  const M = units === "metric";
  const A = (sf) => convertDelta(sf, units, "floor_sf");
  const L = (lf) => convertDelta(lf, units, "lf");
  const AU = M ? "m²" : "SF", LU = M ? "m" : "LF";
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const row = (cells) => cells.map(esc).join(",");
  const lines = [];
  if (projectName) lines.push(`# ${projectName} — ${_t("revision.title")}`);
  lines.push(`# ${aName} -> ${bName}`);
  lines.push(row([_t("csv_header.finish"), _t("rfi.csv_header.status"), _t("revision.d_floor", { unit: AU }), _t("revision.d_wall", { unit: AU }), _t("revision.d_border", { unit: AU }), _t("revision.d_lf", { unit: LU }), _t("revision.d_lf_waste", { unit: LU }), _t("revision.d_ea"), _t("revision.d_total", { unit: AU }),
    _t("revision.ordered_name", { unit: AU, name: aName }), _t("revision.ordered_name", { unit: AU, name: bName }), _t("revision.d_ordered", { unit: AU })]));
  for (const c of diff.conditions) {
    const rd = c._rawDeltas || c.deltas;
    lines.push(row([c.finish_tag, c.status, A(rd.floor_sf), A(rd.wall_sf), A(rd.border_sf),
      L(rd.lf), L(rd.lf_net), c.deltas.ea, A(rd.total_sf),
      c.a ? A(c.a.total_sf_net) : "", c.b ? A(c.b.total_sf_net) : "", A(rd.total_sf_net)]));
  }
  const t = diff.totals;
  const trd = t._rawDeltas || t.deltas;
  lines.push(row([_t("csv_header.total"), "", "", "", "", L(trd.lf), L(trd.lf_net), t.deltas.ea, A(trd.total_sf), A(t.a.total_sf_net), A(t.b.total_sf_net), A(trd.total_sf_net)]));
  if (diff.sheets.length) {
    lines.push("");
    lines.push(row([_t("csv_header.sheet"), _t("rfi.csv_header.status"), _t("revision.d_floor", { unit: AU }), _t("revision.d_wall", { unit: AU }), _t("revision.d_border", { unit: AU }), _t("revision.d_lf", { unit: LU }), _t("revision.d_ea")]));
    for (const s of diff.sheets) {
      const srd = s._rawDeltas || s.deltas;
      lines.push(row([revSheetLabel(s.sheet_id), s.status, A(srd.floor_sf), A(srd.wall_sf), A(srd.border_sf), L(srd.lf), s.deltas.ea]));
    }
  }
  if (diff.materials.length) {
    lines.push("");
    lines.push(row([_t("csv_header.material"), _t("csv_header.unit"), `${_t("csv_header.qty")} (${aName})`, `${_t("csv_header.qty")} (${bName})`, _t("revision.d_qty")]));
    for (const m of diff.materials) lines.push(row([m.name, m.unit, m.a_qty, m.b_qty, m.delta]));
  }
  return lines.join("\n") + "\n";
}
