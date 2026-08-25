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
//   ruleApply the batch-accept gate for correction-rule propagation (#88):
//             add semantics (created_at + id mint per shape, one undo entry
//             for the whole batch), but a DISTINCT type because the policy
//             decision differs — the caller pre-builds each origin with
//             method "rule_v1", rule_id and seed_shape_id (the propagated
//             shape must trace to its seed correction), reviewed: true
//             (the estimator saw the staged batch and clicked Apply).
//   review    the accept gate for machine proposals already IN the shapes
//             array (an imported MCP takeoff, a binder run): each named shape
//             still carrying origin.reviewed === false gets reviewed: true +
//             accepted_ts — nothing else stamps (accepting is affirmation, not
//             an edit; post-accept edits grade through geom/stampEdit as
//             usual). Shapes not pending are untouched. `restore` puts the
//             prior origin back verbatim — undo of an accept is un-accepting.
//   cutout    #137 — mints the deduct shape (add semantics: id + created_at)
//             AND patches its PARENT's verts_norm/verts_norm_holes/computed
//             together as ONE undo entry (a real polygon boolean subtract,
//             not a second independent overlay). The parent patch stamps
//             NOTHING — the reconciliation is derived from the deduct
//             gesture, not a parent edit — and nothing counts. `restore`
//             (undo of a draw, or an explicit delete of the reconciled
//             deduct) unmints the deduct and puts the parent back verbatim.
// ─────────────────────────────────────────────────────────────────────────────
import { mintUuid, nowIso, stampEdit, authorName } from "./provenance.js";
import { assignShapeLabel } from "./shapeLabels.js";

// The mint-time author field (#314): `author` = who committed the shape,
// self-declared via provenance.authorName(). Spread AFTER the caller's fields
// so an import/merge that already carries attribution is never clobbered, and
// an undeclared session adds nothing at all.
const mintAuthor = (given) => {
  const a = given.author === undefined ? authorName() : null;
  return a ? { author: a } : {};
};

export const PROVENANCE_POLICY = {
  add: "created_at (+ id mint) per shape; restore:true stamps nothing",
  geom: "stampEdit(editKind) once, frozen from prev; restampFrom stamps nothing",
  reassign: "stampEdit('reassign') per shape; restore stamps nothing",
  label: "no stamp (documented non-edit)",
  delete: "no stamp; counted per origin.method unless noCount",
  replace: "no stamp, no counted, no undo entry (whole-array non-edit)",
  review: "origin.reviewed → true + accepted_ts per still-pending shape; restore puts the prior origin back verbatim",
  ruleApply: "add semantics (created_at + id mint per shape, ONE undo entry per batch); caller-built rule_v1 origin carries rule_id + seed_shape_id",
  cutout: "#137 — mints the deduct (id + created_at) AND patches its parent's verts_norm/verts_norm_holes/computed as ONE undo entry; parent patch stamps nothing, nothing counts; restore unmints the deduct and reverts the parent verbatim. `runs` carries the OPEN-RUN half of the same ring — wall tile and base are polylines, so the deduct CLIPS them (patch + mint the far side of a middle cut + delete a run swallowed whole) inside this one entry, and a ring that crosses only runs mints no deduct at all",
  rollcut: "#136 — NO stamp: a manual roll-cut override (slide/resize/reorder/reset) writes LAYOUT metadata (shape.roll_layout) over the shape, never its geometry or provenance; a row without roll_layout clears the key; `prev` (grab-time rows) builds the inverse when a live preview already wrote the final state",
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

// #137 — the PARENT-shape half of a cutout: verts_norm always set (the outer
// ring), verts_norm_holes and computed presence-aware — a parent that has
// never carried a hole must come back from undo with no verts_norm_holes key
// at all, matching every other presence-aware snapshot in this file.
const cutoutSnapshot = (s) => ({
  verts_norm: s.verts_norm.map((v) => [...v]),
  ...("verts_norm_holes" in s ? { verts_norm_holes: s.verts_norm_holes.map((r) => r.map((v) => [...v])) } : {}),
  ...("computed" in s ? { computed: s.computed } : {}),
});
const withCutout = (s, patch) => {
  const out = { ...s, verts_norm: patch.verts_norm };
  if ("verts_norm_holes" in patch) out.verts_norm_holes = patch.verts_norm_holes; else delete out.verts_norm_holes;
  if ("computed" in patch) out.computed = patch.computed; else delete out.computed;
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
    // ruleApply IS an add structurally (mint id/created_at, inverse = noCount
    // delete of the batch — one undo entry); the separate type exists so the
    // PROVENANCE_POLICY table forces the policy decision to be made (and
    // documents it) rather than overloading `add` rows with a rule flag.
    case "ruleApply":
    case "add": {
      // restore: true = resurrection (undo of a delete) — the shapes go back
      // VERBATIM (created_at kept, no re-mint), at their original indices when
      // the inverse recorded them (`at`), so undo restores z-order too.
      const minted = cmd.restore ? cmd.shapes : cmd.shapes.map((s) => {
        const { id, created_at, ...rest } = s;
        // key order matches the old creation sites byte-for-byte: id and
        // created_at lead, the caller's fields follow in their given order.
        // author (#314) trails, and only when declared and not already carried
        // (an import/merge keeps its own attribution) — undeclared payloads
        // stay byte-identical.
        return { id: id || `shp-${mintUuid()}`, created_at: created_at || nowIso(), ...rest, ...mintAuthor(rest) };
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
    case "cutout": {
      // `runs` (optional, both directions) is the OPEN-RUN half of the same
      // gesture: wall tile and base are polylines, not polygons, so a deduct
      // over them CLIPS (lib/cutout.cutRunsAcross) instead of subtracting —
      // `runs.targets` patches what survives, `runs.mint` lands the far side
      // of a cut that fell in the middle of a run, `runs.deleteIds` drops a
      // run the ring swallowed whole. It rides inside this command rather
      // than beside it so one drawn ring is still one ⌘Z, and it works with
      // no deduct/parent at all — the ring that crosses only wall runs mints
      // no receipt shape, because there is no area for one to sit on.
      const runsIn = cmd.runs || null;
      if (cmd.restore) {
        const removed = cmd.deductId ? shapes.find((s) => s.id === cmd.deductId) : null;
        if (cmd.deductId && !removed) return { shapes, inverse: null };
        const unmint = new Set(runsIn?.unmintIds || []);
        const remint = unmint.size ? shapes.filter((s) => unmint.has(s.id)) : [];
        const runPrev = new Map((runsIn?.targets || []).map((t) => [t.id, t]));
        const runRedo = [];
        let redoParentNext = cmd.parentId ? null : undefined;
        let next = shapes
          .filter((s) => !(cmd.deductId && s.id === cmd.deductId) && !unmint.has(s.id))
          .map((s) => {
            if (cmd.parentId && s.id === cmd.parentId) {
              redoParentNext = cutoutSnapshot(s);
              return withCutout(s, cmd.parentPrev);
            }
            const t = runPrev.get(s.id);
            if (!t) return s;
            runRedo.push({ id: s.id, next: cutoutSnapshot(s) });
            return withCutout(s, t.prev);
          });
        if (redoParentNext === null) return { shapes, inverse: null };   // parent vanished — refuse rather than orphan the patch
        const rez = runsIn?.resurrect || { shapes: [], at: [] };
        rez.shapes.forEach((s, k) => next.splice(Math.min(rez.at[k] ?? next.length, next.length), 0, s));
        const runsBack = (runRedo.length || remint.length || rez.shapes.length)
          ? { targets: runRedo, ...(remint.length ? { mint: remint } : {}), ...(rez.shapes.length ? { deleteIds: rez.shapes.map((s) => s.id) } : {}) }
          : null;
        return { shapes: next, inverse: {
          type: "cutout",
          ...(removed ? { shape: removed, parentId: cmd.parentId, parentNext: redoParentNext } : {}),
          ...(runsBack ? { runs: runsBack } : {}),
        } };
      }
      // forward: mint the deduct shape (add semantics), patch the parent in place.
      const minted = !cmd.shape ? null : (cmd.shape.id ? cmd.shape : { id: `shp-${mintUuid()}`, created_at: nowIso(), ...cmd.shape, ...mintAuthor(cmd.shape) });
      const runNext = new Map((runsIn?.targets || []).map((t) => [t.id, t]));
      const runDel = new Set(runsIn?.deleteIds || []);
      const runPrevs = [], runRemoved = [], runAt = [];
      shapes.forEach((s, i) => { if (runDel.has(s.id)) { runRemoved.push(s); runAt.push(i); } });
      let parentPrev = cmd.parentId ? null : undefined;
      const next = shapes.filter((s) => !runDel.has(s.id)).map((s) => {
        if (cmd.parentId && s.id === cmd.parentId) {
          parentPrev = cutoutSnapshot(s);
          return withCutout(s, cmd.parentNext);
        }
        const t = runNext.get(s.id);
        if (!t) return s;
        runPrevs.push({ id: s.id, prev: cutoutSnapshot(s) });
        return withCutout(s, t.next);
      });
      if (parentPrev === null) return { shapes, inverse: null };   // parent vanished mid-gesture — refuse rather than mint an orphaned deduct
      const runMinted = (runsIn?.mint || []).map((m) => (m.id ? m : { id: `shp-${mintUuid()}`, created_at: nowIso(), ...m, ...mintAuthor(m) }));
      if (minted) next.push(minted);
      if (runMinted.length) next.push(...runMinted);
      if (!minted && !runPrevs.length && !runMinted.length && !runRemoved.length) return { shapes, inverse: null };   // nothing landed — never a phantom undo entry
      const runsBack = (runPrevs.length || runMinted.length || runRemoved.length)
        ? { targets: runPrevs, ...(runMinted.length ? { unmintIds: runMinted.map((m) => m.id) } : {}), ...(runRemoved.length ? { resurrect: { shapes: runRemoved, at: runAt } } : {}) }
        : null;
      return { shapes: next, inverse: {
        type: "cutout", restore: true,
        ...(minted ? { deductId: minted.id, parentId: cmd.parentId, parentPrev } : {}),
        ...(runsBack ? { runs: runsBack } : {}),
      } };
    }
    case "rollcut": {
      // #136 — patch shape.roll_layout across one or more shapes as ONE undo
      // entry (a drag gesture, a whole-roll reorder, a reset). Rows are
      // presence-aware like every restore in this file: a row carrying
      // roll_layout sets it; a row without clears the key (back to the
      // engine's auto layout). `prev` is the geom-command idea applied here:
      // the caller's grab-time rows build the inverse when the live drag
      // preview already wrote the final layout into the array — without it,
      // the inverse reads the CURRENT shapes (the discrete-edit path).
      const rows = cmd.rows || [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const prevRows = cmd.prev || shapes.filter((s) => byId.has(s.id))
        .map((s) => ({ id: s.id, ...("roll_layout" in s ? { roll_layout: s.roll_layout } : {}) }));
      const next = shapes.map((s) => {
        const r = byId.get(s.id);
        if (!r) return s;
        if ("roll_layout" in r && r.roll_layout != null) return { ...s, roll_layout: r.roll_layout };
        if (!("roll_layout" in s)) return s;
        const { roll_layout: _rl, ...rest } = s;   // clear = key absent, never null
        return rest;
      });
      return { shapes: next, inverse: { type: "rollcut", rows: prevRows } };
    }
    case "review": {
      if (cmd.restore) {
        // restore rows put the recorded origin back verbatim; the inverse is
        // the same shape again — restore rows of the CURRENT origins, so
        // redo-of-undo re-accepts (accepted_ts included) without re-stamping.
        const byId = new Map(cmd.restore.map((r) => [r.id, r]));
        const inverse = { type: "review", restore: shapes.filter((s) => byId.has(s.id)).map((s) => ({ id: s.id, origin: s.origin })) };
        const next = shapes.map((s) => (byId.has(s.id) ? { ...s, origin: byId.get(s.id).origin } : s));
        return { shapes: next, inverse };
      }
      const idSet = new Set(cmd.ids);
      const ts = nowIso();
      const restore = [];
      const next = shapes.map((s) => {
        if (!idSet.has(s.id) || s.origin?.reviewed !== false) return s;
        restore.push({ id: s.id, origin: s.origin });
        return { ...s, origin: { ...s.origin, reviewed: true, accepted_ts: ts } };
      });
      return { shapes: next, inverse: { type: "review", restore } };
    }
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
