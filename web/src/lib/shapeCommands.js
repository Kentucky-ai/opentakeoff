// Shape-mutation command layer — the ONE chokepoint where shape provenance
// policy lives. Every mutation of the canvas's `shapes` array that means
// something (create / reshape / reassign / relabel / delete) is expressed as a
// command and applied by applyShapeCommand, a PURE function (no React, no DOM
// — the Node test runner exercises it directly). The canvas's dispatchShape
// wrapper feeds the result into setShapes, tallies `counted` into the deletion
// provenance counters, and records `{cmd, inverse}` on the undo stack — so
// centralizing the stamps also yields real undo/redo for free.
//
// Provenance primitives (mintUuid / nowIso / stampEdit) stay in provenance.js;
// this module is the POLICY layer deciding which command stamps what.
//
// ── PROVENANCE POLICY ────────────────────────────────────────────────────────
// Command type → what stamps. EVERY new command type MUST add a row here —
// applyShapeCommand throws on a type missing from this table, so forgetting
// the row (i.e. forgetting to DECIDE the provenance policy for a new mutation)
// is a structural failure, not a silent site-by-site drift.
//
//   add       stamps created_at once per shape (and mints `id` when absent, in
//             canvasUtil's `shp-` + uuid format); `restore: true` skips ALL
//             stamping — resurrection (undo of a delete) is not creation.
//   geom      applies geometry AND stampEdit(kind) exactly once per gesture,
//             reconstructing the shape from `prev` (the grab-time state) first
//             so stampEdit's first-edit freeze captures the TRUE pre-drag ring
//             even when a live preview already wrote the final geometry.
//             editKind ∈ vertex | edge | move | vertexDelete (vertexDelete
//             stamps "vertex" — dropping a corner is a vertex edit).
//             `restampFrom` (the undo path) skips stampEdit and restores the
//             prior updated_at/origin verbatim — undo must not leave a phantom
//             `edited` flag or a bumped edits tally behind.
//   reassign  stampEdit("reassign") per shape (stampEdit itself gives manual
//             shapes updated_at only, machine shapes the full origin stamp);
//             `restore` puts back the prior condition_id + provenance exactly.
//   label     NO stamp — label-vocabulary assignment is a documented non-edit
//             (same rule as renameShapeLabel); value semantics are exactly
//             shapeLabels.assignShapeLabel's (visible string sets, else clears).
//   delete    no stamp on the survivors; returns `counted`, the per-origin-
//             method tally the deletion counters ride (`noCount: true`
//             suppresses it — the inverse of an add must not tally a deletion).
//             Inverse re-adds the dead shapes VERBATIM at their old indices.
//   replace   NO stamp, NO counted, inverse null (never recorded): the escape
//             hatch for whole-array non-edits — hydrate, revision restore,
//             rescale's computed re-price.
// ─────────────────────────────────────────────────────────────────────────────
import { mintUuid, nowIso, stampEdit } from "./provenance.js";
import { assignShapeLabel } from "./shapeLabels.js";

export const PROVENANCE_POLICY = {
  add: "created_at (+ id mint) per shape; restore:true stamps nothing",
  geom: "stampEdit(editKind) once, frozen from prev; restampFrom stamps nothing",
  reassign: "stampEdit('reassign') per shape; restore stamps nothing",
  label: "no stamp (documented non-edit)",
  delete: "no stamp; counted per origin.method unless noCount",
  replace: "no stamp, no counted, no undo entry (whole-array non-edit)",
};

// Undo depth — one bounded gesture history, not an archive (revisions are).
export const UNDO_CAP = 100;

// vertexDelete is provenance-wise a vertex edit — the tally kinds stay the
// stampEdit four (vertex/edge/move/reassign) so origin.edits never grows a
// fifth key the corpus readers don't know.
const kindFor = (editKind) => (editKind === "vertexDelete" ? "vertex" : editKind);

// Structural verts comparison — the zero-motion guard. A drag that never
// displaced the geometry (or snapped back exactly) is NOT an edit: no command,
// no stamp. Replaces the old per-site d.stamped/gx/gy flag machinery.
export function vertsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}

// The grab-time snapshot a geom command's `prev` carries: exactly the fields a
// geom apply can touch, PRESENCE-AWARE (a shape that has never been edited has
// no updated_at key — undo must remove the key, not leave `undefined`).
// verts deep-copied (the live ring mutates during preview); computed/origin by
// reference (both are treated immutably everywhere — stampEdit copies origin,
// recompute mints new computed objects).
/**
 * @param {any} s
 * @returns {any}
 */
export function geomSnapshot(s) {
  return {
    verts_norm: s.verts_norm.map((v) => [...v]),
    ...("computed" in s ? { computed: s.computed } : {}),
    ...("updated_at" in s ? { updated_at: s.updated_at } : {}),
    ...("origin" in s ? { origin: s.origin } : {}),
  };
}

// Write a snapshot's four fields back onto a shape, presence-aware.
const withGeomFields = (s, snap) => {
  const out = { ...s, verts_norm: snap.verts_norm };
  if ("computed" in snap) out.computed = snap.computed; else delete out.computed;
  if ("updated_at" in snap) out.updated_at = snap.updated_at; else delete out.updated_at;
  if ("origin" in snap) out.origin = snap.origin; else delete out.origin;
  return out;
};

// condition_id + provenance snapshot for reassign restore rows.
const assignSnapshot = (s) => ({
  id: s.id, condition_id: s.condition_id,
  ...("updated_at" in s ? { updated_at: s.updated_at } : {}),
  ...("origin" in s ? { origin: s.origin } : {}),
});

// ── the pure apply ───────────────────────────────────────────────────────────
// applyShapeCommand(shapes, cmd) → { shapes, inverse, counted? }
//   shapes   the next array (input never mutated);
//   inverse  the command that exactly restores the input array (deep-equal,
//            provenance and array order included) — null for `replace`;
//   counted  delete only: per-origin-method tally for the deletion counters.
/**
 * @param {any[]} shapes
 * @param {any} cmd
 * @returns {{ shapes: any[], inverse: any, counted?: Record<string, number> }}
 */
export function applyShapeCommand(shapes, cmd) {
  if (!cmd || !(cmd.type in PROVENANCE_POLICY)) {
    throw new Error(`Unknown shape command type: ${cmd && cmd.type} — add it to PROVENANCE_POLICY (and decide what it stamps) first.`);
  }
  switch (cmd.type) {
    case "add": {
      // restore: true = resurrection (undo of a delete) — the shapes go back
      // VERBATIM (created_at kept, no re-mint), at their original indices when
      // the inverse recorded them (`at`), so undo restores z-order too.
      const minted = cmd.restore ? cmd.shapes : cmd.shapes.map((s) => {
        const { id, created_at, ...rest } = s;
        // key order matches the old creation sites byte-for-byte: id and
        // created_at lead, the caller's fields follow in their given order.
        return { id: id || `shp-${mintUuid()}`, created_at: created_at || nowIso(), ...rest };
      });
      let next;
      if (cmd.restore && Array.isArray(cmd.at) && cmd.at.length === minted.length) {
        next = shapes.slice();
        // `at` is captured ascending by delete — splicing in order re-creates
        // the original interleaving exactly.
        minted.forEach((s, k) => next.splice(Math.min(cmd.at[k], next.length), 0, s));
      } else {
        next = [...shapes, ...minted];
      }
      return { shapes: next, inverse: { type: "delete", ids: minted.map((s) => s.id), noCount: true } };
    }
    case "geom": {
      let inverse = null;
      const next = shapes.map((s) => {
        if (s.id !== cmd.id) return s;
        if (cmd.restampFrom) {
          // undo path: put back geometry + the EXACT prior provenance; no stamp.
          const out = { ...s, verts_norm: cmd.verts_norm };
          if (cmd.computed !== undefined) out.computed = cmd.computed;
          if ("updated_at" in cmd.restampFrom) out.updated_at = cmd.restampFrom.updated_at; else delete out.updated_at;
          if ("origin" in cmd.restampFrom) out.origin = cmd.restampFrom.origin; else delete out.origin;
          inverse = geomInverse(cmd.id, cmd.editKind, geomSnapshot(s));   // redo-of-undo restores the current (stamped) state verbatim
          return out;
        }
        // forward path: reconstruct the grab-time shape from `prev` FIRST, so
        // the stamp — and stampEdit's first-edit proposed_verts_norm freeze —
        // reads the true pre-gesture ring even though the live preview may
        // already have written the final geometry into the array. Falls back
        // to the current state when the caller didn't preview (discrete edits).
        const prev = cmd.prev || geomSnapshot(s);
        const stamped = stampEdit(withGeomFields(s, prev), kindFor(cmd.editKind));
        const out = { ...stamped, verts_norm: cmd.verts_norm };
        if (cmd.computed !== undefined) out.computed = cmd.computed;   // move gestures omit computed — translation never re-prices
        inverse = geomInverse(cmd.id, cmd.editKind, prev);
        return out;
      });
      return { shapes: next, inverse };
    }
    case "reassign": {
      if (cmd.restore) {
        const byId = new Map(cmd.restore.map((r) => [r.id, r]));
        const inverse = { type: "reassign", restore: shapes.filter((s) => byId.has(s.id)).map(assignSnapshot) };
        const next = shapes.map((s) => {
          const r = byId.get(s.id);
          if (!r) return s;
          const out = { ...s, condition_id: r.condition_id };
          if ("updated_at" in r) out.updated_at = r.updated_at; else delete out.updated_at;
          if ("origin" in r) out.origin = r.origin; else delete out.origin;
          return out;
        });
        return { shapes: next, inverse };
      }
      const idSet = new Set(cmd.ids);
      const restore = [];
      const next = shapes.map((s) => {
        if (!idSet.has(s.id)) return s;
        restore.push(assignSnapshot(s));
        // stampEdit's own split does the policy work: manual shapes get a bare
        // updated_at, machine shapes the full edited/edits/freeze stamp.
        return { ...stampEdit(s, "reassign"), condition_id: cmd.condition_id };
      });
      return { shapes: next, inverse: { type: "reassign", restore } };
    }
    case "label": {
      // Deliberately NO provenance stamp — same contract as the vocabulary
      // renames. Assignment semantics are assignShapeLabel's, unchanged.
      const affected = cmd.restore ? new Set(cmd.restore.map((r) => r.id)) : new Set(cmd.ids);
      const inverse = {
        type: "label",
        restore: shapes.filter((s) => affected.has(s.id))
          .map((s) => ({ id: s.id, ...("label" in s ? { label: s.label } : {}) })),
      };
      let next;
      if (cmd.restore) {
        const byId = new Map(cmd.restore.map((r) => [r.id, r]));
        next = shapes.map((s) => {
          const r = byId.get(s.id);
          if (!r) return s;
          if ("label" in r) return { ...s, label: r.label };
          if (!("label" in s)) return s;
          const { label: _label, ...rest } = s;   // restore to unlabeled = key absent, never ""
          return rest;
        });
      } else {
        next = shapes;
        for (const id of cmd.ids) next = assignShapeLabel(next, id, cmd.value);
      }
      return { shapes: next, inverse };
    }
    case "delete": {
      const idSet = new Set(cmd.ids);
      const removed = [], at = [];
      shapes.forEach((s, i) => { if (idSet.has(s.id)) { removed.push(s); at.push(i); } });
      const next = shapes.filter((s) => !idSet.has(s.id));
      const res = { shapes: next, inverse: { type: "add", shapes: removed, restore: true, at } };
      if (!cmd.noCount && removed.length) {
        const counted = {};
        for (const s of removed) { const k = s.origin?.method || "manual"; counted[k] = (counted[k] || 0) + 1; }
        res.counted = counted;
      }
      return res;
    }
    case "replace":
      // Whole-array non-edit (hydrate / revision restore / rescale re-price):
      // nothing stamps, nothing counts, nothing lands on the undo stack — the
      // canvas clears both stacks alongside (a restored timeline starts fresh,
      // and a rescale invalidates every recorded `computed`).
      return { shapes: Array.isArray(cmd.shapes) ? cmd.shapes : [], inverse: null };
  }
}

// The restore-shaped geom command that puts a snapshot back exactly.
const geomInverse = (id, editKind, snap) => ({
  type: "geom", id, editKind,
  verts_norm: snap.verts_norm,
  ...("computed" in snap ? { computed: snap.computed } : {}),
  restampFrom: {
    ...("updated_at" in snap ? { updated_at: snap.updated_at } : {}),
    ...("origin" in snap ? { origin: snap.origin } : {}),
  },
});

// ── undo-stack bookkeeping (pure — the canvas holds the arrays in refs) ──────
// A NEW command caps the undo stack at `cap` (oldest falls off) and clears the
// redo stack — the standard branch-discard: once you edit past an undo point,
// the redone future is gone.
/**
 * @param {any[]} undo
 * @param {any} entry
 * @param {number} [cap]
 * @returns {{ undo: any[], redo: any[] }}
 */
export function recordCommand(undo, entry, cap = UNDO_CAP) {
  const next = [...undo, entry];
  return { undo: next.length > cap ? next.slice(next.length - cap) : next, redo: [] };
}
