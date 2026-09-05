// Proposals (#365) — the canvas half. Pure, no React, no DOM.
//
// An agent's shapes land reviewed:false and the estimator accepts or deletes
// them. A PROPOSAL is the unit above a shape: a named batch (propose_takeoff
// on the MCP side) that every subsequent agent commit attaches to through
// origin.proposal_id. On the canvas that means ONE Accept pill per batch
// instead of one per shape — a forty-room detect run is one decision.
//
// A CONDITION-EDIT proposal is the same idea for the knobs: a diff against a
// condition (tag, waste, multiplier, height, roll setup) held pending until
// the estimator accepts it from the panel. Until then nothing on the
// condition changes; the report prints the current values with the proposed
// ones beside them.
//
// Both ride the takeoff payload as transport (`proposals`,
// `condition_edit_proposals`) — the MCP session mints them, this file only
// reads and applies them.

const tagKey = (t) => String(t ?? "").trim().toUpperCase();

/** Pending (reviewed:false) shapes grouped by the proposal they belong to.
 *  Order: batches in `proposals` order, then batches the payload never
 *  described (an older export — the id is the label), then the un-batched
 *  remainder as a final group with `proposal: null`. Empty groups are dropped. */
export function pendingByProposal(shapes, proposals = []) {
  const byId = new Map();
  for (const s of Array.isArray(shapes) ? shapes : []) {
    if (!s || s.origin?.reviewed !== false) continue;
    const key = typeof s.origin.proposal_id === "string" && s.origin.proposal_id ? s.origin.proposal_id : "";
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(s);
  }
  const out = [];
  const described = new Set();
  for (const p of Array.isArray(proposals) ? proposals : []) {
    if (!p || typeof p.id !== "string") continue;
    described.add(p.id);
    const mine = byId.get(p.id);
    if (mine?.length) out.push({ proposal: p, ids: mine.map((s) => s.id), shapes: mine });
  }
  for (const [key, mine] of byId) {
    if (!key || described.has(key)) continue;
    out.push({ proposal: { id: key, label: "Proposal", rationale: "" }, ids: mine.map((s) => s.id), shapes: mine });
  }
  const loose = byId.get("");
  if (loose?.length) out.push({ proposal: null, ids: loose.map((s) => s.id), shapes: loose });
  return out;
}

/** The knob names a condition-edit proposal may touch, in display order. */
export const CONDITION_EDIT_FIELDS = ["finish_tag", "waste_pct", "multiplier", "height_ft", "roll_setup"];

/** One human line per proposed change: { field, from, to } with display
 *  strings. `roll_setup` collapses to its material class (or "off"). */
export function describeConditionEdit(cond, proposal) {
  const cur = cond || {};
  const diff = proposal?.proposed && typeof proposal.proposed === "object" ? proposal.proposed : {};
  const rows = [];
  const roll = (v) => (v === null || v === undefined ? "off" : (v.material ? String(v.material) : "on"));
  for (const f of CONDITION_EDIT_FIELDS) {
    if (!(f in diff) || diff[f] === undefined) continue;
    if (f === "finish_tag") rows.push({ field: "tag", from: String(cur.finish_tag ?? ""), to: String(diff.finish_tag) });
    else if (f === "waste_pct") rows.push({ field: "waste", from: `${Number(cur.waste_pct) || 0}%`, to: `${Number(diff.waste_pct)}%` });
    else if (f === "multiplier") rows.push({ field: "multiplier", from: `×${Number(cur.multiplier) || 1}`, to: `×${Number(diff.multiplier)}` });
    else if (f === "height_ft") rows.push({ field: "height", from: cur.height_ft != null ? `${cur.height_ft} ft` : "—", to: `${Number(diff.height_ft)} ft` });
    else if (f === "roll_setup") rows.push({ field: "roll goods", from: roll(cur.roll_setup), to: roll(diff.roll_setup) });
  }
  return rows;
}

/** The canvas patch that applies a proposal — the SAME field semantics
 *  edit_condition / the panel editor use: `roll_setup: null` means opt out,
 *  which the canvas stores as an absent key. */
export function conditionEditPatch(proposal) {
  const diff = proposal?.proposed && typeof proposal.proposed === "object" ? proposal.proposed : {};
  const patch = {};
  if (typeof diff.finish_tag === "string" && diff.finish_tag.trim()) patch.finish_tag = diff.finish_tag.trim();
  if (Number.isFinite(diff.waste_pct) && diff.waste_pct >= 0) patch.waste_pct = diff.waste_pct;
  if (Number.isFinite(diff.multiplier) && diff.multiplier > 0) patch.multiplier = diff.multiplier;
  if (Number.isFinite(diff.height_ft) && diff.height_ft > 0) patch.height_ft = diff.height_ft;
  if ("roll_setup" in diff) patch.roll_setup = diff.roll_setup === null || diff.roll_setup === undefined ? undefined : diff.roll_setup;
  return patch;
}

/** Apply one proposal to a conditions array. Returns { conditions, error } —
 *  `error` names why nothing changed (condition gone, empty patch, or a
 *  rename onto a tag another condition carries: two conditions on one tag
 *  would make one unreachable, so it refuses exactly like the MCP side). */
export function acceptConditionEditProposal(conditions, proposal, nowIso = () => new Date().toISOString()) {
  const list = Array.isArray(conditions) ? conditions : [];
  const c = list.find((x) => x && x.id === proposal?.condition_id);
  if (!c) return { conditions: list, error: "That condition no longer exists." };
  const patch = conditionEditPatch(proposal);
  if (!Object.keys(patch).length) return { conditions: list, error: "The proposal carries nothing to apply." };
  if (patch.finish_tag !== undefined) {
    const clash = list.find((x) => x && x.id !== c.id && tagKey(x.finish_tag) === tagKey(patch.finish_tag));
    if (clash) return { conditions: list, error: `${clash.finish_tag} already carries that tag — a condition cannot be renamed onto another.` };
  }
  return { conditions: list.map((x) => (x.id === c.id ? { ...x, ...patch, updated_at: nowIso() } : x)), error: null };
}

/** The report's proposed_condition_edits rows — the same shape the MCP
 *  session emits (current beside proposed), built from canvas state. */
export function proposedConditionEditRows(conditions, proposals) {
  const list = Array.isArray(conditions) ? conditions : [];
  return (Array.isArray(proposals) ? proposals : []).flatMap((p) => {
    const c = p && list.find((x) => x && x.id === p.condition_id);
    if (!c || !p.proposed || typeof p.proposed !== "object") return [];
    return [{
      proposal_id: p.id, condition: c.finish_tag, condition_id: c.id,
      current: {
        finish_tag: c.finish_tag, waste_pct: Number(c.waste_pct) || 0, multiplier: Number(c.multiplier) || 1,
        ...(c.height_ft != null ? { height_ft: c.height_ft } : {}),
        ...(c.roll_setup ? { roll_setup: c.roll_setup } : {}),
      },
      proposed: p.proposed, rationale: p.rationale || "", proposed_at: p.proposed_at || "",
    }];
  });
}
