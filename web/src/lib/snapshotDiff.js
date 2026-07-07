// Snapshot comparison (PR-6) — QUANTITY-LEVEL, deliberately NOT geometric.
// Shape identity doesn't survive revisions: a re-imported sheet or a
// deleted-and-redrawn room gets fresh shape uids, so pairing shapes across
// snapshots would diff as noise. What an estimator actually reviews is
// "did any condition's numbers move, and on which sheet" — so we total both
// payloads with the same role math the report uses (conditionTotals /
// sheetTotals) and diff the totals.
//
// Inputs are two annotations payloads in the autosave shape
// ({ conditions: [], shapes: [], ... }); missing/empty arrays are tolerated,
// so diffing against {} means "everything on the other side is added/removed".
//
// Condition keying: id primary, finish_tag fallback. A deleted-and-recreated
// condition gets a fresh uid and would otherwise diff as remove+add; if an
// unmatched A row and an unmatched B row share the exact finish_tag string,
// they pair up (first-come on duplicates) under key "tag:" + finish_tag.
import { conditionTotals, sheetTotals, round2 } from "./totals.js";

// The seven condition-level quantity fields compared for "changed".
// total_sf_net is waste-adjusted, so a waste_pct-only edit shows up there
// (and only there) — measured quantities stay equal, which is correct: the
// takeoff didn't change, the order quantity did.
const COND_FIELDS = ["floor_sf", "wall_sf", "border_sf", "lf", "ea", "total_sf", "total_sf_net"];
// Sheet rows carry BASE quantities only (sheetTotals semantics: the condition
// multiplier is NOT applied, and there's no waste at sheet level).
const SHEET_FIELDS = ["floor_sf", "wall_sf", "border_sf", "lf", "ea"];

// round2(b − a) per field, treating a missing side as zero. So for an
// "added" row the deltas ARE b's values, and for a "removed" row they are
// −a's values — never zero-filled: the reviewer sees the quantity that
// appeared/disappeared, not a blank.
function deltasOf(fields, a, b) {
  const d = /** @type {Record<string, number>} */ ({});
  for (const f of fields) d[f] = round2((b ? b[f] || 0 : 0) - (a ? a[f] || 0 : 0));
  return d;
}

const allZero = (d) => Object.values(d).every((v) => v === 0);

// Pair A rows with B rows: id match first, then finish_tag fallback over the
// leftovers (first-come, exact string, empty tags never pair). Returns entries
// in B order (matched + added as they appear in B) with removed-A appended in
// A order — stable and review-friendly. key = the matched id, "tag:" + tag
// for tag-matches, or the lone row's own id for added/removed.
function matchRows(rowsA, rowsB) {
  const byIdA = new Map(rowsA.map((r) => [r.id, r]));
  const idMatched = new Set();
  for (const b of rowsB) if (byIdA.has(b.id)) idMatched.add(b.id);

  const tagQueue = new Map();            // finish_tag → unmatched A rows, in A order
  for (const a of rowsA) {
    if (idMatched.has(a.id) || !a.finish_tag) continue;
    let q = tagQueue.get(a.finish_tag);
    if (!q) { q = []; tagQueue.set(a.finish_tag, q); }
    q.push(a);
  }

  const consumedA = new Set(idMatched);
  const entries = [];
  for (const b of rowsB) {
    if (idMatched.has(b.id)) { entries.push({ key: b.id, a: byIdA.get(b.id), b }); continue; }
    const q = b.finish_tag ? tagQueue.get(b.finish_tag) : null;
    const a = q && q.length ? q.shift() : null;
    if (a) { consumedA.add(a.id); entries.push({ key: "tag:" + b.finish_tag, a, b }); }
    else entries.push({ key: b.id, a: null, b });
  }
  for (const a of rowsA) if (!consumedA.has(a.id)) entries.push({ key: a.id, a, b: null });
  return entries;
}

// Diff two takeoff payloads at the condition-quantity level.
//
// Returns {
//   conditions: [{ key, finish_tag, status, a, b, deltas }]
//     - a / b are conditionTotals rows — WITHOUT the shape_count > 0 filter
//       the report applies: a zero-shape condition still exists, and one that
//       is shapeless on both sides stays "unchanged" with zero deltas (it is
//       never fabricated into an added/removed pair);
//     - status: "added" (B only) | "removed" (A only) | "changed" | "unchanged";
//     - deltas: the seven COND_FIELDS, round2(b − a); added rows carry b's
//       values, removed rows −a's values (see deltasOf).
//   by_sheet: [{ sheet_id, rows }] — sheetTotals on both payloads, diffed per
//     sheet_id with the same condition keying; sheets present in either side;
//     sheets where every row is "unchanged" are dropped. Deltas are BASE
//     quantities (multiplier NOT applied — mirroring sheetTotals), with
//     multiplier_a / multiplier_b on each row so the UI can flag ×N changes.
//     NB: a multiplier change with identical bases is invisible here by
//     design — the condition-level diff catches it (conditionTotals applies
//     the multiplier, so total_sf moves).
//   identical: true iff every condition status is "unchanged" AND by_sheet is
//     empty — a shape moved between sheets keeps condition totals equal but
//     is still a difference.
// }
export function diffSnapshots(payloadA, payloadB) {
  const condsA = (payloadA && payloadA.conditions) || [];
  const shapesA = (payloadA && payloadA.shapes) || [];
  const condsB = (payloadB && payloadB.conditions) || [];
  const shapesB = (payloadB && payloadB.shapes) || [];

  // ── condition level ────────────────────────────────────────────────────
  const rowsA = conditionTotals(condsA, shapesA);
  const rowsB = conditionTotals(condsB, shapesB);
  const matched = matchRows(rowsA, rowsB);

  const conditions = matched.map(({ key, a, b }) => {
    const deltas = deltasOf(COND_FIELDS, a, b);
    const status = !a ? "added" : !b ? "removed" : allZero(deltas) ? "unchanged" : "changed";
    return { key, finish_tag: b ? b.finish_tag : a.finish_tag, status, a, b, deltas };
  });

  // condition id → matched key, per side (sheet rows are keyed by condition id)
  const keyByAId = new Map();
  const keyByBId = new Map();
  for (const { key, a, b } of matched) {
    if (a) keyByAId.set(a.id, key);
    if (b) keyByBId.set(b.id, key);
  }

  // ── sheet level ────────────────────────────────────────────────────────
  const sheetsA = sheetTotals(condsA, shapesA);
  const sheetsB = sheetTotals(condsB, shapesB);
  const groupA = new Map(sheetsA.map((g) => [g.sheet_id, g]));
  const groupB = new Map(sheetsB.map((g) => [g.sheet_id, g]));
  const sheetIds = sheetsB.map((g) => g.sheet_id);
  for (const g of sheetsA) if (!groupB.has(g.sheet_id)) sheetIds.push(g.sheet_id);

  const by_sheet = [];
  for (const sheet_id of sheetIds) {
    const aByKey = new Map(
      ((groupA.get(sheet_id) || {}).rows || []).map((r) => [keyByAId.get(r.id), r])
    );
    const rows = [];
    const seen = new Set();
    for (const b of (groupB.get(sheet_id) || {}).rows || []) {
      const key = keyByBId.get(b.id);
      seen.add(key);
      const a = aByKey.get(key) || null;
      const deltas = deltasOf(SHEET_FIELDS, a, b);
      const status = !a ? "added" : allZero(deltas) ? "unchanged" : "changed";
      rows.push({
        key, finish_tag: b.finish_tag, status, a, b, deltas,
        multiplier_a: a ? a.multiplier : null, multiplier_b: b.multiplier,
      });
    }
    for (const [key, a] of aByKey) {
      if (seen.has(key)) continue;
      rows.push({
        key, finish_tag: a.finish_tag, status: "removed", a, b: null,
        deltas: deltasOf(SHEET_FIELDS, a, null),
        multiplier_a: a.multiplier, multiplier_b: null,
      });
    }
    if (rows.some((r) => r.status !== "unchanged")) by_sheet.push({ sheet_id, rows });
  }

  const identical =
    conditions.every((e) => e.status === "unchanged") && by_sheet.length === 0;

  return { conditions, by_sheet, identical };
}
