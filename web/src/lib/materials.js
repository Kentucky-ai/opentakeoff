// Material library (browser-global `material_library` meta record, #47).
// Like the condition-template record, it's shared across every project in
// the browser, so a single corrupt item would crash the canvas for ALL
// projects at once (matLibById dereferences `m.id` on every entry, and the
// Materials tab keys its rows on it). This sanitizer is the load gate (the
// sanitizeTemplates precedent): store.loadMaterialLibrary() routes through it
// so nothing malformed ever reaches the canvas.
//
// The contract — deliberately minimal ("safe to dereference and key on", not
// a re-implementation of the canvas's defaulting): every returned item is a
// plain object with a non-empty string `id`, unique within the list (entries
// without one, or later duplicates, are dropped — first-wins, the
// sanitizeConditionColumns precedent — since matLibById, the Materials tab's
// row keys, and updateLibMaterial all match on `id`, and a duplicate breaks
// all three). Field defaulting stays libFields' / the tab's `||` fallbacks'
// job. Unknown item fields pass through (the scale_source
// precedent: stripping a future field on load would persist the loss on the
// next library save).

import { groutParamsEqual, groutNote, materialKind } from "./coverage.js";

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// ── the library-link seam (#47 copy-on-attach + the grout calculator) ───────
// Every copy between a condition material line and a library entry flows
// through libFields: attach, promote, per-field revert, and push-to-linked all
// build their copies from it, and matFieldOverridden compares against it. The
// grout tile geometry (a nested object) and the material kind ride along —
// dropping them here is exactly the desync the adversarial review found
// (attached mosaics rendering 12×24 defaults, pushes leaving stale geometry).
// grout is DEEP-COPIED at every copy point: a shared reference would alias one
// geometry object across the library and every linked line.
export const libFields = (lm) => ({
  name: lm.name || "", unit: lm.unit || "", per: lm.per || 0, basis: lm.basis || "area",
  round: lm.round !== false, note: lm.note || "",
  ...(lm.kind ? { kind: lm.kind } : {}),
  ...(lm.grout ? { grout: { ...lm.grout } } : {}),
});

// overridden = this line's field differs from its linked library entry
// (the amber tint + per-field ↺ in MaterialsEditor). "grout" compares the five
// geometry params structurally — never by reference — so geometry drift on a
// linked line ambers like any other override.
export const matFieldOverridden = (m, lm, f) => {
  if (!lm) return false;
  const L = libFields(lm);
  if (f === "per") return (Number(m.per) || 0) !== L.per;
  if (f === "round") return (m.round !== false) !== L.round;
  if (f === "basis") return (m.basis || "area") !== L.basis;   // absent basis means "area" everywhere else — don't flag it
  if (f === "grout") return !groutParamsEqual(m.grout, L.grout);
  return String(m[f] || "") !== String(L[f] || "");
};

// per + note on a grout line are DERIVED from its tile geometry, so the three
// fields must move together or the row contradicts its own calculator:
// · push replaces per/note/grout as a unit, and a library entry WITHOUT
//   geometry clears the line's — stale geometry would silently overwrite the
//   pushed rate on the next calculator keystroke. `kind` gets the SAME
//   symmetry (round-3 finding 1): libFields carries the entry's kind when it
//   has one, and an entry without one clears the line's — a renamed entry
//   whose kind was dropped by re-classification must not leave the line's
//   stale kind pinning the wrong presets under the pushed name (kind is
//   never override-checked, so nothing would ever amber or heal it);
// · reverting per, note, or the geometry row on a grout line restores all
//   three to the library values (a lone reverted per under an edited-geometry
//   note would print false provenance in the Report).
export const libPushPatch = (m, lm) => {
  const next = { ...m, ...libFields(lm) };
  if (!lm.grout) delete next.grout;
  if (!lm.kind) delete next.kind;
  return next;
};
// Per-field ↺. `kind` is name-coupled metadata on a geometry-less line (it's
// the cached classification of the name, and rename edits drop it together
// with the name — renameReclassified below), so a NAME revert restores the
// entry's kind too (round-3 finding 2): reverting "Caulk" back to
// "Ultracolor FA" must bring kind:"grout" — and its derive affordance — back,
// or the field is gone forever with zero amber anywhere. With geometry on the
// line, kind:"grout" is load-bearing (the calculator gate) and the name
// reverts alone.
export const libRevertPatch = (m, lm, f) => {
  const L = libFields(lm);
  if ((f === "per" || f === "note" || f === "grout") && (m.grout || lm.grout)) {
    return { per: L.per, note: L.note, grout: L.grout };   // L.grout is already a fresh copy (or undefined → clears the line's)
  }
  if (f === "name" && !m.grout && (L.kind || m.kind)) {
    return { name: L.name, kind: L.kind };   // L.kind may be undefined → clears the line's stale kind with the reverted name
  }
  return { [f]: L[f] };
};

// NAME edits re-classify a geometry-less material. An explicit `kind` rides
// through the library seam (promote/attach/push carry it), but without tile
// geometry it's only a cached classification, so a rename that CHANGES THE
// NAME'S MEANING — materialKind(old name) !== materialKind(new name) — drops
// it and lets the new name rule again: keeping it would pin an attached
// "Adhesive" renamed "Thinset mortar" to adhesive presets forever (pre-seam
// behavior re-classified from the name). A touch that does NOT change the
// name's classification (round-3 finding 3: appending a space to
// "Ultracolor FA", a typo fix — both classify "") keeps the stored kind: the
// mere fact that the stored kind disagrees with the name regex is a
// legitimate state (that's exactly what kind is FOR), not evidence of a
// rename. A new name that AGREES with the stored kind also keeps it. With
// geometry present, kind:"grout" is load-bearing (it gates the calculator
// whatever the line is called) and always stays.
export const renameReclassified = (m, oldName) => {
  if (!m.kind || m.grout) return m;
  const newNameKind = materialKind({ name: m.name });
  if (newNameKind === m.kind) return m;                              // new name agrees — nothing stale
  if (materialKind({ name: oldName }) === newNameKind) return m;     // meaning unchanged — keep the classification
  const { kind: _k, ...rest } = m;
  return rest;
};

// Condition-line edit (MaterialsEditor → updateMaterial): a plain merge, plus
// the rename re-classification above when the patch touches the name. A patch
// that sets `kind` ALONGSIDE the name is asserting a fresh classification —
// libRevertPatch's name+kind revert — not carrying a stale cache, so it is
// exempt: reverting "Mortar mix" back to "Ultracolor FA" is itself a
// meaning-changing rename (mortar → "") and re-classification would re-drop
// the kind the revert just restored.
export const matEditPatch = (m, patch) => {
  const next = { ...m, ...patch };
  return "name" in patch && !("kind" in patch) ? renameReclassified(next, m.name) : next;
};

// Library-row edit (Materials tab). The tab has no grout calculator, so a
// hand edit that CHANGES per or note on an entry carrying tile geometry
// DETACHES the geometry — otherwise the entry would push/attach a grout
// object that contradicts its own per/note. Change-aware: committing a value
// equal to the current one (a select-all-retype of the same rate) is not a
// contradiction and must not detach. When per detaches the geometry and the
// entry's note is still the geometry-derived one, the note goes too — a
// derived note describing discarded geometry is false provenance in the
// Report and every export. A note the user typed themselves (patch.note)
// always wins.
export const libEntryPatch = (lm, patch) => {
  const next = { ...lm, ...patch, ...(patch.grout ? { grout: { ...patch.grout } } : {}) };
  if (next.grout && !("grout" in patch)) {
    const perChanged = "per" in patch && (Number(patch.per) || 0) !== (Number(lm.per) || 0);
    const noteChanged = "note" in patch && String(patch.note || "") !== String(lm.note || "");
    if (perChanged || noteChanged) {
      if (!("note" in patch) && String(next.note || "") === groutNote(next.grout)) next.note = "";
      delete next.grout;
    }
  }
  return "name" in patch && !("kind" in patch) ? renameReclassified(next, lm.name) : next;   // explicit kind in a patch = fresh classification, exempt (see matEditPatch)
};

// Template/seed material → live condition line. The seed's grout object (CT-1
// carries { ...GROUT_DEFAULTS } built once at module load) must not be shared
// by reference into live state — deep-copy it per instantiation.
export const instantiateMaterial = (m, id) => ({
  round: true, ...m,
  ...(m.grout ? { grout: { ...m.grout } } : {}),
  id,
});

export function sanitizeMaterialLibrary(raw) {
  if (!Array.isArray(raw)) return [];
  const seenIds = new Set();
  return raw.filter((m) => {
    if (!(isPlainObject(m) && typeof m.id === "string" && m.id)) return false;
    if (seenIds.has(m.id)) return false;
    seenIds.add(m.id);
    return true;
  });
}
