// Import an "opentakeoff.takeoff_canvas.v1" payload — the exact document the
// app autosaves and the MCP server's export_takeoff emits — into the current
// project. This is the file half of the agent handoff: an MCP session traces
// rooms (origin.reviewed:false — pencil), export_takeoff writes the JSON, and
// this module lands it in the canvas where the committed-but-unreviewed path
// renders it dashed until a human Accept turns it to ink.
//
// Pure by design (no React, no DOM, no store): TakeoffCanvas hands in the
// current payload (buildPayload()) and the parsed file, gets back the payload
// to hydrate + a note describing what happened. That keeps the merge rules
// unit-testable next to geometry/totals.
//
// The one design rule: OPERATOR STATE WINS. An import may add geometry and
// vocabulary, but it never rescales a sheet the operator calibrated, renames
// their project, reorders their tabs, or duplicates what a previous import
// already landed (same-id entries are skipped, so re-importing a file is
// idempotent — an accepted shape does not come back as a second pencil copy).

import { ANN_SCHEMA } from "./store.js";
import { sanitizeApprovals } from "./approvals.js";
import { normalizeAgentReview } from "./reviewState.js";

/** Parse + gate an import file's text. Throws with copy the message bar shows
 * verbatim — "Couldn't…" is the canvas's danger convention (isDangerMsg), so
 * these stick instead of aging out on the 6s timer. */
export function parseTakeoffImport(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("Couldn't import takeoff: that file is not valid JSON.");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || doc.schema !== ANN_SCHEMA) {
    throw new Error(`Couldn't import takeoff: not a takeoff export (expected schema "${ANN_SCHEMA}" — the file export_takeoff or the app writes).`);
  }
  return doc;
}

const arr = (v) => (Array.isArray(v) ? v : []);
const tagKey = (t) => String(t || "").trim().toUpperCase();
// Deterministic collision escape (tested, unlike a uuid): first free "~n"
// suffix. Only reachable for a condition id that exists locally under a
// DIFFERENT finish tag — same-id shapes/markups are skipped, not reminted.
const freeId = (id, taken) => {
  let n = 2, next = id;
  while (taken.has(next)) next = `${id}~${n++}`;
  return next;
};

/**
 * Merge (or, into an empty project, replace with) an imported takeoff doc.
 *
 * @param {object} current  the live payload (buildPayload())
 * @param {object} imported a doc parseTakeoffImport accepted
 * @param {string[]|null} [knownFiles] loaded PDF names; when given, imported
 *   shapes whose sheet_id names a file that isn't loaded are still added (the
 *   file may be loaded next) but reported in note.unknown_files so the banner
 *   can say why nothing visible changed.
 * @returns {{payload: Record<string, any>, note: {replaced: boolean, shapes_added: number,
 *   shapes_pending: number, conditions_merged: number, conditions_added: number,
 *   scales_adopted: number, unknown_files: string[]}}}
 */
export function mergeTakeoffImport(current, imported, knownFiles = null) {
  const cur = current && typeof current === "object" ? current : {};
  const impShapes = arr(imported.shapes).filter((s) => s && typeof s === "object" && typeof s.sheet_id === "string" && typeof s.id === "string").map(normalizeAgentReview);
  const impConds = arr(imported.conditions).filter((c) => c && typeof c === "object" && typeof c.id === "string");
  const localScales = new Map(arr(cur.sheets).filter((s) => typeof s?.sheet_id === "string").map((s) => [s.sheet_id, s.units_per_px]));
  const incomingScales = new Map(arr(imported.sheets).filter((s) => typeof s?.sheet_id === "string").map((s) => [s.sheet_id, s.units_per_px]));
  const existingIds = new Set(arr(cur.shapes).map((s) => s.id));
  // Refuse before adoption: retaining local calibration while appending the
  // source's computed quantities would silently mix two measurement systems.
  for (const s of impShapes) {
    if (existingIds.has(s.id) || s.measure_role === "count") continue;
    const local = localScales.get(s.sheet_id), incoming = incomingScales.get(s.sheet_id);
    if (local > 0 && (!(incoming > 0) || !Number.isFinite(incoming) || Math.abs(local - incoming) > Math.max(local, incoming) * 1e-9)) {
      throw new Error(`Couldn't import takeoff: scale conflict on ${s.sheet_id} (current ${local} ft/px; imported ${incoming ?? "missing"}). Align the sheet calibration and re-export before importing measurements. Nothing was imported.`);
    }
  }

  const unknownFiles = (added) => {
    if (!Array.isArray(knownFiles)) return [];
    const known = new Set(knownFiles);
    return [...new Set(added.map((s) => String(s.sheet_id).split("#")[0]).filter((f) => !known.has(f)))];
  };
  const pendingCount = (shapes) => shapes.filter((s) => s.origin?.reviewed === false).length;

  // Nothing measured or marked up yet → the import IS the project. Seeded
  // default conditions and an untouched tab list are not user work, so they
  // don't block the clean-replace path. An existing calibration and approval seals
  // DO block it (#176): a seal is ink someone placed — operator state wins,
  // so a sealed-but-untraced project merges instead of being replaced.
  if (!arr(cur.shapes).length && !arr(cur.markups).length && !arr(cur.approvals).length && !arr(cur.sheets).some((s) => s?.units_per_px > 0)) {
    // …except the VIEW. An MCP export typically carries empty tab/group
    // state (the session has no such concept), and adopting an empty list
    // would close the operator's open sheet and bounce them to the gallery
    // mid-import — the shapes land on a sheet they're no longer looking at.
    // Empty carries no intent; a NON-empty imported view is real state and wins.
    const payload = {
      ...imported,
      shapes: impShapes,
      ...(arr(imported.sheet_tabs).length ? {} : { sheet_tabs: arr(cur.sheet_tabs) }),
      ...(arr(imported.sheet_group).length ? {} : { sheet_group: arr(cur.sheet_group) }),
      ...(arr(imported.last_group).length ? {} : { last_group: arr(cur.last_group) }),
    };
    return {
      payload,
      note: { replaced: true, shapes_added: impShapes.length, shapes_pending: pendingCount(impShapes), conditions_merged: 0, conditions_added: impConds.length, scales_adopted: arr(imported.sheets).length, unknown_files: unknownFiles(impShapes) },
    };
  }

  // ── conditions: finish tag is the identity that matters ──────────────────
  // Same tag (case/space-insensitive) → the imported geometry joins the
  // operator's condition (their color, waste %, materials). New tags append.
  const conditions = [...arr(cur.conditions)];
  const byTag = new Map(conditions.map((c) => [tagKey(c.finish_tag), c.id]));
  const condIds = new Set(conditions.map((c) => c.id));
  const condMap = new Map();   // imported cond id -> id in the merged doc
  const addedCondIds = new Set();   // ids the import CREATED (vs merged onto an operator's own)
  let condMerged = 0, condAdded = 0;
  for (const c of impConds) {
    const hit = byTag.get(tagKey(c.finish_tag));
    if (hit) { condMap.set(c.id, hit); condMerged++; continue; }
    const id = condIds.has(c.id) ? freeId(c.id, condIds) : c.id;
    const next = id === c.id ? c : { ...c, id };
    conditions.push(next); condIds.add(id); byTag.set(tagKey(c.finish_tag), id); condMap.set(c.id, id);
    addedCondIds.add(id); condAdded++;
  }
  // ── twin lineage: re-point it, or cut it, never leave it dangling ─────────
  // A twin's `variant_of` is an id, so an added twin has to follow its parent through condMap
  // (a de-collided id would otherwise point at a stranger). And lineage only survives when the
  // PARENT also arrived as a new condition: if the parent merged into the operator's own
  // condition, the twin's rows carry origin_ids into a materials list that never had them, so
  // following it would mean following nothing. In that case the twin keeps its materials as its
  // own — the numbers the file actually carried — and simply stops being a twin. Grouping
  // (`family_id`) is a cosmetic string and rides along either way.
  for (let i = 0; i < conditions.length; i++) {
    const c = conditions[i];
    if (!c?.variant_of || !addedCondIds.has(c.id)) continue;   // operator conditions stay untouched
    const mapped = condMap.get(c.variant_of);
    const parentArrived = !!mapped && addedCondIds.has(mapped);
    if (parentArrived && mapped !== c.variant_of) {
      conditions[i] = { ...c, variant_of: mapped };
    } else if (!parentArrived) {
      const next = { ...c, materials: (c.materials || []).map(({ origin_id: _o, inherited: _i, ...m }) => m) };
      delete next.variant_of;
      delete next.materials_dropped;
      conditions[i] = next;
    }
  }

  // ── shapes / markups: append new ids, skip ones already here ─────────────
  const shapeIds = new Set(arr(cur.shapes).map((s) => s.id));
  const addedShapes = impShapes
    .filter((s) => !shapeIds.has(s.id))
    .map((s) => (condMap.has(s.condition_id) && condMap.get(s.condition_id) !== s.condition_id ? { ...s, condition_id: condMap.get(s.condition_id) } : s));
  const markupIds = new Set(arr(cur.markups).map((m) => m?.id).filter(Boolean));
  const addedMarkups = arr(imported.markups).filter((m) => m && typeof m === "object" && (!m.id || !markupIds.has(m.id)));
  const rfiIds = new Set(arr(cur.rfis).map((r) => r?.id).filter(Boolean));
  const addedRfis = arr(imported.rfis).filter((r) => r && typeof r === "object" && r.id && !rfiIds.has(r.id));
  // ── approvals (#176): transport, not minting ──────────────────────────────
  // The markup rule (append new ids, skip ones already here) behind the same
  // load gate the canvas hydrate runs — an estimator seal arriving by file
  // stays an estimator seal (the actor field is the authority), and a corrupt
  // record is dropped here rather than wedging the render loop later.
  const approvalIds = new Set(arr(cur.approvals).map((a) => a?.id).filter(Boolean));
  const addedApprovals = sanitizeApprovals(imported.approvals).filter((a) => !approvalIds.has(a.id));

  // ── scales: the operator's calibration wins per sheet ────────────────────
  const sheets = [...arr(cur.sheets)];
  const scaled = new Set(sheets.map((s) => s?.sheet_id));
  let scalesAdopted = 0;
  for (const s of arr(imported.sheets)) {
    if (s && typeof s === "object" && s.sheet_id && s.units_per_px && !scaled.has(s.sheet_id)) { sheets.push(s); scaled.add(s.sheet_id); scalesAdopted++; }
  }

  // Everything else is the operator's workspace, not import cargo: name, tabs,
  // grouping, levels, columns, labels, palette, client info, rules, counters
  // all stay current (rules never ride the MCP export by RFC scope anyway).
  const payload = {
    ...cur,
    conditions,
    shapes: [...arr(cur.shapes), ...addedShapes],
    markups: [...arr(cur.markups), ...addedMarkups],
    ...(addedRfis.length ? { rfis: [...arr(cur.rfis), ...addedRfis] } : {}),
    ...(addedApprovals.length ? { approvals: [...arr(cur.approvals), ...addedApprovals] } : {}),
    sheets,
  };
  return {
    payload,
    note: { replaced: false, shapes_added: addedShapes.length, shapes_pending: pendingCount(addedShapes), conditions_merged: condMerged, conditions_added: condAdded, scales_adopted: scalesAdopted, unknown_files: unknownFiles(addedShapes) },
  };
}
