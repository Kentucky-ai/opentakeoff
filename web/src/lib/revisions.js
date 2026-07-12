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

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// The condition-level fields compared. total_sf_net is the ordered quantity,
// so a waste_pct-only edit shows there and only there — the takeoff didn't
// change, the order did, and the diff says exactly that.
export const COND_FIELDS = ["floor_sf", "wall_sf", "border_sf", "lf", "ea", "total_sf", "total_sf_net"];
// Sheet-level rows carry base measured quantities (no multiplier, no waste —
// those are condition-level ordering concerns, not sheet locations).
export const SHEET_FIELDS = ["floor_sf", "wall_sf", "border_sf", "lf", "ea"];

const visible = (f, d) => Math.abs(d) >= (f === "ea" ? 0.5 : 0.05);

function deltasOf(fields, a, b) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const f of fields) out[f] = round2((b ? b[f] || 0 : 0) - (a ? a[f] || 0 : 0));
  return out;
}
const anyVisible = (fields, deltas) => fields.some((f) => visible(f, deltas[f]));

// A lone-side row only counts as added/removed if there is anything on it —
// a shapeless seeded condition that exists in one revision and not the other
// diffs as unchanged, never as a fabricated add/remove.
const hasSubstance = (fields, r) => r.shape_count > 0 || fields.some((f) => visible(f, r[f] || 0));

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
      case "deduct": row.floor_sf -= cp.area_sf || 0; break;
      case "floor_area": row.floor_sf += cp.area_sf || 0; break;
      case "surface_area": row.wall_sf += cp.area_sf || 0; break;
      case "linear": row.lf += cp.perimeter_lf || 0; row.border_sf += cp.area_sf || 0; break;
      case "count": row.ea += cp.count || 1; break;
      default: break;
    }
  }
  for (const row of acc.values()) for (const f of SHEET_FIELDS) row[f] = round2(row[f]);
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
export function diffTakeoffs(a, b) {
  const rowsA = conditionTotals(a?.conditions || [], a?.shapes || []);
  const rowsB = conditionTotals(b?.conditions || [], b?.shapes || []);

  const conditions = pairRows(rowsA, rowsB).map(({ key, a: ra, b: rb }) => {
    const deltas = deltasOf(COND_FIELDS, ra, rb);
    let status;
    if (ra && rb) status = anyVisible(COND_FIELDS, deltas) ? "changed" : "unchanged";
    else if (rb) status = hasSubstance(COND_FIELDS, rb) ? "added" : "unchanged";
    else status = hasSubstance(COND_FIELDS, ra) ? "removed" : "unchanged";
    return { key, finish_tag: (rb || ra).finish_tag, color: (rb || ra).color, status, a: ra, b: rb, deltas };
  });

  const shA = perSheet(a?.conditions, a?.shapes), shB = perSheet(b?.conditions, b?.shapes);
  const sheetIds = [...new Set([...shB.keys(), ...shA.keys()])].sort((x, y) => x.localeCompare(y));
  const sheets = sheetIds.map((id) => {
    const ra = shA.get(id) || null, rb = shB.get(id) || null;
    const deltas = deltasOf(SHEET_FIELDS, ra, rb);
    let status;
    if (ra && rb) status = anyVisible(SHEET_FIELDS, deltas) ? "changed" : "unchanged";
    else if (rb) status = "added";
    else status = "removed";
    return { sheet_id: id, status, a: ra, b: rb, deltas };
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

  const totals = { a: grandTotals(rowsA), b: grandTotals(rowsB), deltas: deltasOf(["total_sf", "total_sf_net", "lf", "lf_net", "ea", "sy_net"], grandTotals(rowsA), grandTotals(rowsB)) };
  const changed = conditions.filter((c) => c.status !== "unchanged").length;
  return { conditions, sheets, materials, totals, changed };
}

// The compare as a CSV record — every row with its status, deltas signed,
// grand-total delta line, then per-sheet and buy-list sections.
export function diffToCsv(diff, { aName = "baseline", bName = "current", units = "imperial", projectName = "" } = {}) {
  const M = units === "metric";
  const A = (sf) => (M ? +(sf * 0.09290304).toFixed(2) : sf);
  const L = (lf) => (M ? +(lf * 0.3048).toFixed(2) : lf);
  const AU = M ? "m2" : "SF", LU = M ? "m" : "LF";
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const row = (cells) => cells.map(esc).join(",");
  const lines = [];
  if (projectName) lines.push(`# ${projectName} — OpenTakeoff revision compare`);
  lines.push(`# ${aName} -> ${bName}`);
  lines.push(row(["Finish", "Status", `d Floor ${AU}`, `d Wall ${AU}`, `d Border ${AU}`, `d ${LU}`, "d EA", `d Total ${AU}`,
    `${AU} ordered (${aName})`, `${AU} ordered (${bName})`, `d ${AU} ordered`]));
  for (const c of diff.conditions) {
    lines.push(row([c.finish_tag, c.status, A(c.deltas.floor_sf), A(c.deltas.wall_sf), A(c.deltas.border_sf),
      L(c.deltas.lf), c.deltas.ea, A(c.deltas.total_sf),
      c.a ? A(c.a.total_sf_net) : "", c.b ? A(c.b.total_sf_net) : "", A(c.deltas.total_sf_net)]));
  }
  const t = diff.totals;
  lines.push(row(["TOTAL", "", "", "", "", L(t.deltas.lf), t.deltas.ea, A(t.deltas.total_sf), A(t.a.total_sf_net), A(t.b.total_sf_net), A(t.deltas.total_sf_net)]));
  if (diff.sheets.length) {
    lines.push("");
    lines.push(row(["Sheet", "Status", `d Floor ${AU}`, `d Wall ${AU}`, `d Border ${AU}`, `d ${LU}`, "d EA"]));
    for (const s of diff.sheets) {
      lines.push(row([revSheetLabel(s.sheet_id), s.status, A(s.deltas.floor_sf), A(s.deltas.wall_sf), A(s.deltas.border_sf), L(s.deltas.lf), s.deltas.ea]));
    }
  }
  if (diff.materials.length) {
    lines.push("");
    lines.push(row(["Material", "Unit", `Qty (${aName})`, `Qty (${bName})`, "d Qty"]));
    for (const m of diff.materials) lines.push(row([m.name, m.unit, m.a_qty, m.b_qty, m.delta]));
  }
  return lines.join("\n") + "\n";
}
