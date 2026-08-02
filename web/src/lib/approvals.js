// Approval seals — ink over pencil. The record of REVIEW, distinct from both
// measurement shapes and markups (and from the reusable stamp LIBRARY in
// stamps.js, which is annotation art — an approval is a verdict).
//
// Two actors, two visually unmistakable glyphs:
//   estimator  the human's APPROVED ring — placed only by the canvas's
//              Approve tool, never by an agent path or MCP tool. Ink.
//   agent      the AGENT diamond — a machine verdict. No UI tool mints one
//              and no MCP tool does yet; the data model, rendering, undo and
//              marked-set paths are fully wired so exposure can land later
//              without touching this family again.
//
// The record (rides the annotations payload as `approvals`, additive):
//   Approval = {
//     id:       "apr-" + uuid            (minted at add)
//     actor:    "estimator" | "agent"
//     ts:       ISO-8601                 (minted at add)
//     sheet_id: the sheet key it renders on
//     at:       [nx, ny]                 click point, normalized to the sheet
//                                        raster (the markup convention) — the
//                                        seal ALWAYS renders here, so a later
//                                        shape delete never orphans the glyph
//     shape_id?: string                  present when the seal targets a
//                                        committed shape (provenance: WHAT was
//                                        approved, not where it draws)
//   }
// Deliberately no condition attachment: a shape-targeted seal identifies its
// condition through the shape, and a sheet seal approves paper, not a scope —
// reusing the markup condition_id machinery would drag in the condition-delete
// unlink sweep for no data the record doesn't already carry.
//
// Mutations mirror lib/shapeCommands.js one size smaller: a pure apply the
// test runner exercises directly, every command returning the exact-restore
// inverse, so seals ride the canvas's SHARED undo/redo stacks (entries tagged
// family: "approval") — placing or lifting a seal is a real ⌘Z step.

import { mintUuid, nowIso } from "./provenance.js";

// Command type → what mints. Same contract as PROVENANCE_POLICY: an unknown
// type throws, so adding a mutation without deciding its policy is a
// structural failure, not a silent drift.
export const APPROVAL_POLICY = {
  add: "mints id (apr- + uuid) + ts per record; restore: true re-adds VERBATIM at the recorded indices (undo of a lift)",
  delete: "no stamp; inverse re-adds the removed records verbatim, original order included",
  replace: "whole-array non-edit (hydrate) — nothing mints, inverse null (never recorded)",
};

export const APPROVAL_ACTORS = ["estimator", "agent"];

// Seal radius as a fraction of sheet WIDTH (the bubble-markup convention), so
// a seal prints proportionally on any sheet size instead of screen-constant.
export const APPROVAL_R = 0.022;

// Glyph ink per actor — literal hex mirroring tokens.css (SVG attributes and
// pdf-lib can't resolve CSS vars): estimator = --c-positive, agent =
// --ink-muted (pencil-graphite, deliberately quieter than the human's ink).
// Dark values are the tokens' own dark-theme lifts, not a computed boost.
const APPROVAL_INK = {
  estimator: { light: "#1f6b4a", dark: "#55b083" },
  agent: { light: "#6c6a5e", dark: "#9d9a8c" },
};
export function approvalInk(actor, dark = false) {
  const c = APPROVAL_INK[actor] || APPROVAL_INK.agent;
  return dark ? c.dark : c.light;
}

const isPair = (p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

// Load gate (the sanitizeStampLibrary precedent): the payload field crosses
// storage and hand-edited imports, and one corrupt record must not wedge the
// canvas render loop. Contract is "safe to key on and render": id / actor /
// sheet_id / at validated, duplicates first-wins de-duped (render keys on id),
// unknown fields pass through so a valid record survives the save → load
// round-trip unchanged. Non-arrays load as [] (additive-field rule).
export function sanitizeApprovals(raw) {
  const seen = new Set();
  return (Array.isArray(raw) ? raw : []).filter((a) => {
    if (!a || typeof a !== "object" || Array.isArray(a)) return false;
    if (!(typeof a.id === "string" && a.id)) return false;
    if (!APPROVAL_ACTORS.includes(a.actor)) return false;
    if (!(typeof a.sheet_id === "string" && a.sheet_id)) return false;
    if (!isPair(a.at)) return false;
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

// Cover-tally counts for the marked set (and anything else that reports the
// ink/pencil split). Always both keys, zero-filled.
export function approvalTally(approvals) {
  const t = { estimator: 0, agent: 0 };
  for (const a of Array.isArray(approvals) ? approvals : []) {
    if (a && a.actor in t) t[a.actor] += 1;
  }
  return t;
}

// ── the pure apply ───────────────────────────────────────────────────────────
// applyApprovalCommand(approvals, cmd) → { approvals, inverse }
//   approvals  the next array (input never mutated);
//   inverse    the command that exactly restores the input array (deep-equal,
//              array order included) — null for `replace`.
/**
 * @param {any[]} approvals
 * @param {any} cmd
 * @returns {{ approvals: any[], inverse: any }}
 */
export function applyApprovalCommand(approvals, cmd) {
  if (!cmd || !(cmd.type in APPROVAL_POLICY)) {
    throw new Error(`Unknown approval command type: ${cmd && cmd.type} — add it to APPROVAL_POLICY (and decide what it mints) first.`);
  }
  switch (cmd.type) {
    case "add": {
      // restore: true = resurrection (undo of a delete) — records go back
      // VERBATIM (id/ts kept, no re-mint) at their original indices (`at`,
      // captured ascending by delete), so undo restores order too.
      const minted = cmd.restore ? cmd.approvals : cmd.approvals.map((a) => {
        const { id, ts, ...rest } = a;
        if (!APPROVAL_ACTORS.includes(rest.actor)) {
          throw new Error(`Unknown approval actor: ${rest.actor} — must be one of ${APPROVAL_ACTORS.join(", ")}.`);
        }
        return { id: id || `apr-${mintUuid()}`, ts: ts || nowIso(), ...rest };
      });
      let next;
      if (cmd.restore && Array.isArray(cmd.at) && cmd.at.length === minted.length) {
        next = approvals.slice();
        minted.forEach((a, k) => next.splice(Math.min(cmd.at[k], next.length), 0, a));
      } else {
        next = [...approvals, ...minted];
      }
      return { approvals: next, inverse: { type: "delete", ids: minted.map((a) => a.id) } };
    }
    case "delete": {
      const idSet = new Set(cmd.ids);
      const removed = [], at = [];
      approvals.forEach((a, i) => { if (idSet.has(a.id)) { removed.push(a); at.push(i); } });
      return {
        approvals: approvals.filter((a) => !idSet.has(a.id)),
        inverse: { type: "add", approvals: removed, restore: true, at },
      };
    }
    case "replace":
      // hydrate — nothing mints, nothing lands on the undo stack (the canvas
      // clears both stacks alongside, exactly like the shape `replace`).
      return { approvals: Array.isArray(cmd.approvals) ? cmd.approvals : [], inverse: null };
  }
}
