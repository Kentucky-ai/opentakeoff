// Shape-level three-way merge (#313) — the conflict resolver that replaces
// uniform remote-wins WHEN a common ancestor is known. Pure function of
// (base, local, remote): no DOM, no store, no clock reads — every input that
// varies is in the arguments, so the same three payloads merge identically on
// every machine (both sides of a conflict converge without coordinating).
//
// Policy (from the RFC, stated as the quadrants of "what happened since base"):
//   • added on either side              → union (both survive)
//   • deleted on one side, UNTOUCHED on the other → deleted
//   • deleted on one side, EDITED on the other    → the edit survives (deletion
//     of a record someone else is actively correcting loses work; keeping it
//     costs one extra visible shape the deleter can re-delete)
//   • edited on BOTH sides (differently) → deterministic winner by
//     updated_at-latest; ties and missing stamps fall to the remote side (the
//     side holding the rev — the RFC's "rev, then uid" tiebreak, which stays
//     deterministic when clocks lie). The losing record is preserved verbatim
//     on the winner under `merge_loser`, the way origin.proposed_verts_norm
//     preserves a machine trace — recoverable, never silently gone.
//
// Deliberate non-goals (RFC): no CRDT, no op-log, no realtime channel. The
// payload stays one plain JSON file; totals are DERIVED downstream and are
// never merged here.
//
// Re-import hazard: a re-imported sheet re-mints shape uids (snapshotDiff.js),
// so the same physical room can arrive as "deleted + added" on BOTH sides.
// The merge still unions (nothing is lost) but flags the sheet in
// `review_sheets` — union-plus-review, not silent duplication.

// Stable stringify (sorted object keys) so deep-equality is insensitive to key
// order — payloads that round-tripped through different machines may carry the
// same record with reordered keys.
function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
}
const eq = (a, b) => stable(a) === stable(b);

// Comparable edit stamp: updated_at first (stampEdit writes it on every real
// edit), created_at as the fallback for never-edited records. ISO-8601 UTC
// strings compare lexicographically in time order.
const stampOf = (r) => r?.updated_at || r?.created_at || "";

// Strip a record for use as a preserved loser: drop its own merge_loser so
// repeated conflicts on one uid never nest a chain of losers inside losers.
function asLoser(r) {
  if (!r || typeof r !== "object" || !("merge_loser" in r)) return r;
  const { merge_loser, ...rest } = r;
  return rest;
}

// Record equality that ignores a carried merge_loser: after a torn adopt one
// side can hold "winner + merge_loser" while the other holds the bare winner —
// that is the SAME record, and re-fighting it would drop the preserved loser.
const eqRec = (a, b) => eq(asLoser(a), asLoser(b));
// Of two equal records, keep the one still carrying its merge_loser.
const keepLoserCarrier = (a, b) => (a && typeof a === "object" && "merge_loser" in a ? a : b);

// Three-way merge of one keyed record set. Returns { records, conflicts,
// deleted } where records is the merged array (remote order is the spine,
// local-only additions appended in local order — deterministic on both
// machines), conflicts lists both-edited uids with the chosen winner, and
// deleted lists uids removed by the delete quadrant (for the re-import scan).
function mergeKeyed(baseArr, localArr, remoteArr) {
  const byId = (arr) => new Map((arr || []).map((r) => [r.id, r]));
  const B = byId(baseArr), L = byId(localArr), R = byId(remoteArr);

  const out = new Map();
  const conflicts = [];
  const deleted = [];

  // Every uid that exists anywhere, remote-then-local order (see spine note).
  const order = [];
  const seen = new Set();
  for (const r of remoteArr || []) if (!seen.has(r.id)) { seen.add(r.id); order.push(r.id); }
  for (const r of localArr || []) if (!seen.has(r.id)) { seen.add(r.id); order.push(r.id); }
  for (const r of baseArr || []) if (!seen.has(r.id)) { seen.add(r.id); order.push(r.id); }

  for (const id of order) {
    const b = B.get(id), l = L.get(id), r = R.get(id);
    if (!b) {
      // Added since base. Same uid on both sides means the same record survived
      // a copy (uids are minted once), so identical-or-conflict, never a dup.
      if (l && r) {
        if (eqRec(l, r)) { out.set(id, keepLoserCarrier(l, r)); continue; }
        const winner = stampOf(l) > stampOf(r) ? "local" : "remote";
        const w = winner === "local" ? l : r, loser = winner === "local" ? r : l;
        out.set(id, { ...w, merge_loser: asLoser(loser) });
        conflicts.push({ id, winner });
      } else out.set(id, l || r);
      continue;
    }
    // Touched-since-base also ignores merge_loser (eqRec): carrying preserved
    // bookkeeping is not an edit and must never manufacture a conflict.
    const lTouched = l ? !eqRec(l, b) : false;
    const rTouched = r ? !eqRec(r, b) : false;
    if (!l && !r) { deleted.push(id); continue; }             // deleted both sides
    if (!l || !r) {
      const survivor = l || r;
      const touched = l ? lTouched : rTouched;
      if (touched) out.set(id, survivor);                     // deleted vs edited → edit survives
      else deleted.push(id);                                  // deleted vs untouched → deleted
      continue;
    }
    if (!lTouched && !rTouched) { out.set(id, keepLoserCarrier(l, r)); continue; } // neither moved — keep any carried loser
    if (!lTouched) { out.set(id, r); continue; }              // only remote moved
    if (!rTouched) { out.set(id, l); continue; }              // only local moved
    if (eqRec(l, r)) { out.set(id, keepLoserCarrier(l, r)); continue; } // both moved to the same place
    const winner = stampOf(l) > stampOf(r) ? "local" : "remote"; // ties → remote (holds the rev)
    const w = winner === "local" ? l : r, loser = winner === "local" ? r : l;
    out.set(id, { ...w, merge_loser: asLoser(loser) });
    conflicts.push({ id, winner });
  }
  return { records: [...out.values()], conflicts, deleted };
}

// Three-way rule for everything that is NOT a keyed record set (scalars, the
// un-id'd arrays like sheet_tabs/last_group): the side that changed since base
// wins; both changed → remote (deterministic, matches the tiebreak above).
function mergeValue(b, l, r) {
  const lTouched = !eq(l, b), rTouched = !eq(r, b);
  if (!lTouched) return r;
  if (!rTouched) return l;
  return r;
}

// An array qualifies for keyed merge when every present element is an object
// carrying a string id — true for shapes, conditions, markups; false for the
// positional UI arrays. Judged over all three inputs so a side with an empty
// array can't demote a keyed set to the scalar rule.
function isKeyed(...arrays) {
  let sawAny = false;
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    for (const el of arr) {
      sawAny = true;
      if (!el || typeof el !== "object" || typeof el.id !== "string" || !el.id) return false;
    }
  }
  return sawAny;
}

// Scan for the re-import signature on ONE keyed set: a sheet where BOTH sides
// deleted base shapes and BOTH sides added fresh uids — the same drawing
// re-traced under new ids twice. The union above already kept everything;
// this names the sheets a human should review for doubles.
function reimportSheets(baseArr, localArr, remoteArr) {
  const ids = (arr) => new Set((arr || []).map((r) => r.id));
  const bIds = ids(baseArr), lIds = ids(localArr), rIds = ids(remoteArr);
  const perSheet = new Map(); // sheet_id -> { delL, delR, addL, addR }
  const bump = (sheet, k) => {
    if (!sheet) return;
    let s = perSheet.get(sheet);
    if (!s) { s = { delL: 0, delR: 0, addL: 0, addR: 0 }; perSheet.set(sheet, s); }
    s[k]++;
  };
  for (const r of baseArr || []) {
    if (!lIds.has(r.id)) bump(r.sheet_id, "delL");
    if (!rIds.has(r.id)) bump(r.sheet_id, "delR");
  }
  for (const r of localArr || []) if (!bIds.has(r.id)) bump(r.sheet_id, "addL");
  for (const r of remoteArr || []) if (!bIds.has(r.id)) bump(r.sheet_id, "addR");
  const flagged = [];
  for (const [sheet, s] of perSheet) {
    if (s.delL && s.delR && s.addL && s.addR) flagged.push(sheet);
  }
  return flagged.sort();
}

/**
 * Merge three annotations payloads (the autosave shape — missing arrays
 * tolerated). Returns:
 *   {
 *     merged,          // the converged payload (no rev — the push stamps it)
 *     conflicts,       // [{ key, id, winner }] both-edited records, per array
 *     review_sheets,   // sheet_ids carrying the re-import signature
 *     clean,           // true when no conflicts and nothing to review
 *   }
 * `base` is the last-synced common ancestor. Callers without a trustworthy
 * base must NOT call this — the reconciler falls back to remote-wins.
 */
export function mergeAnnotations(base, local, remote) {
  const b = base || {}, l = local || {}, r = remote || {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])]
    .filter((k) => k !== "rev" && k !== "updated_at").sort();
  const merged = {};
  const conflicts = [];
  for (const k of keys) {
    const bv = b[k], lv = l[k], rv = r[k];
    if (isKeyed(bv, lv, rv)) {
      const m = mergeKeyed(bv || [], lv || [], rv || []);
      for (const c of m.conflicts) conflicts.push({ key: k, ...c });
      merged[k] = m.records;
    } else {
      merged[k] = mergeValue(bv, lv, rv);
    }
  }
  const review_sheets = reimportSheets(b.shapes, l.shapes, r.shapes);
  return { merged, conflicts, review_sheets, clean: conflicts.length === 0 && review_sheets.length === 0 };
}

// Content equality between two payloads, ignoring the sync bookkeeping keys the
// provider owns (rev) — "did the merge produce anything the remote doesn't
// already hold". Key-order insensitive.
export function samePayload(a, b) {
  const strip = ({ rev, updated_at, ...rest } = {}) => rest;
  return eq(strip(a || {}), strip(b || {}));
}
