// Material library — the load gate (PR #50 review follow-up). The
// `material_library` meta record is browser-global, and matLibById /
// updateLibMaterial / the Materials tab's row keys all dereference `m.id`:
// one malformed or duplicate-id item used to crash the canvas, or silently
// merge two materials, for EVERY project at once. The invariants:
//   - non-array records sanitize to [];
//   - items must be plain objects with a non-empty string `id`;
//   - duplicate ids are deduped first-wins (later entries with the same id
//     are dropped — the sanitizeConditionColumns precedent);
//   - unknown item fields pass through (the scale_source precedent), so a
//     valid library survives the save -> load round-trip unchanged;
//   - store.loadMaterialLibrary() routes through the sanitizer.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { sanitizeMaterialLibrary, libFields, matFieldOverridden, libPushPatch, libRevertPatch, libEntryPatch, matEditPatch, renameReclassified, instantiateMaterial } from "../src/lib/materials.js";
import { GROUT_DEFAULTS, groutDerivedFields, groutNote, materialKind, showsGroutCalc, showsGroutDeriveAffordance } from "../src/lib/coverage.js";
import { FLOORING_DEFAULTS } from "../src/lib/canvasConstants.js";
import { store } from "../src/lib/store.js";

beforeEach(() => {
  (globalThis as any).indexedDB = new IDBFactory();
});

// A well-formed library, shaped exactly like the canvas's promoteMaterial /
// addLibMaterial output (id, name, unit, per, basis, round, optional note).
const lib = () => [
  { id: "lib_1", name: "Adhesive", unit: "gal", per: 250, basis: "area", round: true, note: "" },
  { id: "lib_2", name: "Grout", unit: "lb", per: 25, basis: "area", round: false },
];

// ── sanitizeMaterialLibrary ──────────────────────────────────────────────────

test("round-trip: a valid library sanitizes unchanged (deep-equal)", () => {
  const saved = lib();
  assert.deepEqual(sanitizeMaterialLibrary(JSON.parse(JSON.stringify(saved))), saved);
});

test("non-array records sanitize to []", () => {
  for (const raw of [undefined, null, 42, "lib_1", {}, { id: "lib_1" }]) {
    assert.deepEqual(sanitizeMaterialLibrary(raw), [], String(raw));
  }
});

test("malformed items are dropped: plain object with a non-empty string id", () => {
  const raw = [
    ...lib(),
    null,                               // not an object
    "lib_3",                            // primitive
    7,                                   // primitive
    ["lib_4"],                          // array is not a material
    { name: "no id" },                  // missing id
    { id: 9, name: "non-string id" },   // non-string id
    { id: "", name: "empty id" },       // empty id
  ];
  assert.deepEqual(sanitizeMaterialLibrary(raw), lib());
});

test("duplicate ids: first-wins dedupe (the sanitizeConditionColumns precedent)", () => {
  const raw = [
    { id: "lib_1", name: "Adhesive", unit: "gal", per: 250, basis: "area", round: true },
    { id: "lib_1", name: "Evil twin", unit: "ea", per: 999, basis: "count", round: false },
    { id: "lib_2", name: "Grout" },
    { id: "lib_2", name: "Grout twin" },
  ];
  assert.deepEqual(sanitizeMaterialLibrary(raw), [
    { id: "lib_1", name: "Adhesive", unit: "gal", per: 250, basis: "area", round: true },
    { id: "lib_2", name: "Grout" },
  ]);
});

test("unknown item fields survive the round-trip (scale_source precedent)", () => {
  const saved = [{ id: "lib_1", name: "Thinset", future_field: { v: 1 } }];
  assert.deepEqual(sanitizeMaterialLibrary(JSON.parse(JSON.stringify(saved))), saved);
});

// ── store.loadMaterialLibrary wiring ─────────────────────────────────────────

test("loadMaterialLibrary routes the stored record through the sanitizer", async () => {
  // saveMaterialLibrary stores wholesale; the corrupt/duplicate items must be
  // gone on load
  await store.saveMaterialLibrary([...lib(), null, { name: "no id" }, { id: "lib_1", name: "dup" }]);
  assert.deepEqual(await store.loadMaterialLibrary(), lib());
});

test("loadMaterialLibrary returns [] for a missing or non-array record", async () => {
  assert.deepEqual(await store.loadMaterialLibrary(), []);
  await store.saveMaterialLibrary("not-a-list" as any);   // saveMaterialLibrary already guards
  assert.deepEqual(await store.loadMaterialLibrary(), []);
});

// ── the library-link seam: kind + grout survive every copy, deep-copied ─────
// (adversarial review findings 1/2/3/6: libFields dropped kind/grout, so a
// promoted mosaic attached elsewhere rendered 12×24 defaults, pushes left
// stale geometry, and per-field revert desynced per/note from m.grout)

const MOSAIC = { tileL: 2, tileW: 2, tileT: 0.25, joint: 0.0625, bagLbs: 25 };
const groutLine = () => ({
  id: "mat_1", name: "Grout", kind: "grout", unit: "bag", basis: "area", round: true,
  grout: { ...MOSAIC }, ...groutDerivedFields(MOSAIC),
});

test("libFields: carries kind and grout, grout deep-copied per call", () => {
  const m = groutLine();
  const L = libFields(m);
  assert.equal(L.kind, "grout");
  assert.deepEqual(L.grout, m.grout);
  assert.notEqual(L.grout, m.grout);                    // fresh object, never shared
  assert.notEqual(libFields(m).grout, L.grout);         // fresh per CALL too
  // entries without geometry don't grow grout/kind keys
  assert.ok(!("grout" in libFields({ name: "Adhesive" })));
  assert.ok(!("kind" in libFields({ name: "Adhesive" })));
});

test("library round-trip: promote → attach preserves the mosaic geometry, rate and note coherently", () => {
  const m = groutLine();
  const entry = { id: "lib_1", ...libFields(m) };                    // promoteMaterial
  const attached = { id: "mat_2", ...libFields(entry), lib_id: entry.id };   // attachLibMaterial
  assert.deepEqual(attached.grout, MOSAIC);
  assert.notEqual(attached.grout, entry.grout);
  assert.equal(attached.kind, "grout");
  // the attached line's per/note agree with its OWN geometry — the first
  // calculator keystroke re-derives from the mosaic, not from the defaults
  assert.deepEqual(groutDerivedFields(attached.grout), { per: attached.per, note: attached.note });
  // and nothing reads as overridden right after attach
  for (const f of ["name", "unit", "per", "basis", "round", "note", "grout"]) {
    assert.equal(matFieldOverridden(attached, entry, f), false, f);
  }
});

test("matFieldOverridden: grout compares structurally, and geometry drift ambers", () => {
  const entry = { id: "lib_1", ...libFields(groutLine()) };
  const line = { id: "mat_2", ...libFields(entry), lib_id: entry.id };
  const drifted = { ...line, grout: { ...line.grout!, joint: 0.125 }, ...groutDerivedFields({ ...line.grout!, joint: 0.125 }) };
  assert.equal(matFieldOverridden(drifted, entry, "grout"), true);
  assert.equal(matFieldOverridden(drifted, entry, "per"), true);
  assert.equal(matFieldOverridden(drifted, entry, "note"), true);
  // a line with no grout object vs a defaults-geometry entry: since the
  // round-2 render gate, absent-vs-present RENDER differently (derive button
  // vs calculator), so this now flags (round-3 finding 4 updates the
  // pre-round-3 "identical rendered geometry → not flagged" expectation)
  const bare = { name: "Grout", per: 512 };
  assert.equal(matFieldOverridden(bare, { id: "lib_2", name: "Grout", per: 512, grout: { ...GROUT_DEFAULTS } }, "grout"), true);
});

test("libPushPatch: pushes the library's grout (deep copy) and clears stale line geometry when the library has none", () => {
  const entry = { id: "lib_1", ...libFields(groutLine()) };
  const stale = { id: "mat_3", lib_id: "lib_1", name: "Grout", per: 144, note: "6×6×1/4″ @ 1/4″ · 25 lb", grout: { tileL: 6, tileW: 6, tileT: 0.25, joint: 0.25, bagLbs: 25 } };
  const pushed = libPushPatch(stale, entry);
  assert.deepEqual(pushed.grout, MOSAIC);
  assert.notEqual(pushed.grout, entry.grout);
  assert.deepEqual(groutDerivedFields(pushed.grout), { per: pushed.per, note: pushed.note });
  // library entry WITHOUT geometry → the line's stale grout is removed, not left contradicting per/note
  const plain = { id: "lib_2", name: "Grout", unit: "bag", per: 200, basis: "area", round: true, note: "hand rate" };
  const pushed2 = libPushPatch(stale, plain);
  assert.equal(pushed2.per, 200);
  assert.ok(!("grout" in pushed2), "stale geometry must not survive a push from a geometry-less entry");
});

test("libRevertPatch: per/note/grout revert together on a grout line; plain fields revert alone", () => {
  const entry = { id: "lib_1", ...libFields(groutLine()) };
  const g6 = { tileL: 6, tileW: 6, tileT: 0.25, joint: 0.25, bagLbs: 25 };
  const drifted = { id: "mat_4", lib_id: "lib_1", name: "Grout", grout: g6, ...groutDerivedFields(g6) };
  for (const f of ["per", "note", "grout"]) {
    const patch = libRevertPatch(drifted, entry, f);
    assert.deepEqual(patch.grout, MOSAIC);
    assert.notEqual(patch.grout, entry.grout);
    assert.deepEqual(groutDerivedFields(patch.grout!), { per: patch.per, note: patch.note });
  }
  // name reverts alone, untouched geometry
  assert.deepEqual(libRevertPatch({ ...drifted, name: "Ultracolor" }, entry, "name"), { name: "Grout" });
  // non-grout line: per reverts alone
  assert.deepEqual(libRevertPatch({ id: "m", lib_id: "l", per: 9 }, { id: "l", name: "Adhesive", per: 250 }, "per"), { per: 250 });
  // library entry without geometry: reverting per also clears the line's grout (coherence with the reverted note)
  const patch = libRevertPatch(drifted, { id: "lib_2", name: "Grout", per: 200, note: "hand rate" }, "per");
  assert.equal(patch.per, 200);
  assert.ok("grout" in patch && patch.grout === undefined);
});

test("libEntryPatch: a CHANGED per or note on a Materials-tab grout entry detaches its geometry", () => {
  const entry = { id: "lib_1", ...libFields(groutLine()) };
  assert.ok(!("grout" in libEntryPatch(entry, { per: 300 })));
  assert.ok(!("grout" in libEntryPatch(entry, { note: "custom" })));
  assert.deepEqual(libEntryPatch(entry, { name: "Ultracolor" }).grout, MOSAIC);   // other edits keep it
  // an explicit grout patch (future callers) is deep-copied in
  const g = { ...MOSAIC, joint: 0.125 };
  const next = libEntryPatch(entry, { grout: g, per: 1, note: "n" });
  assert.deepEqual(next.grout, g);
  assert.notEqual(next.grout, g);
});

// ── round-2 Defect C (data layer): no-op edits are not contradictions ───────

test("libEntryPatch: committing per/note UNCHANGED does not detach (select-all-retype of the same value)", () => {
  const entry = { id: "lib_1", ...libFields(groutLine()) };   // per 192, derived note
  const samePer = libEntryPatch(entry, { per: entry.per });
  assert.deepEqual(samePer, entry, "same-per commit is a pure no-op");
  const sameNote = libEntryPatch(entry, { note: entry.note });
  assert.deepEqual(sameNote, entry, "same-note commit is a pure no-op");
  // numeric-shape no-ops too (the input coerces "192" → 192)
  assert.deepEqual(libEntryPatch({ ...entry, per: 192 }, { per: 192.0 }), { ...entry, per: 192 });
  // but a REAL change still detaches
  assert.ok(!("grout" in libEntryPatch(entry, { per: 193 })));
});

// ── round-2 Defect B: the derived note dies with the geometry it describes ──

test("libEntryPatch note coherence: a per-detach clears the geometry-derived note; a hand note survives; patch.note wins", () => {
  const entry = { id: "lib_1", ...libFields(groutLine()) };
  assert.equal(entry.note, groutNote(MOSAIC), "precondition: the entry carries the derivation note");
  // per hand-edit: geometry AND its note both go — a note deriving the old
  // rate under the new per is false provenance in the Report/exports
  const perEdit = libEntryPatch(entry, { per: 350 });
  assert.ok(!("grout" in perEdit));
  assert.equal(perEdit.note, "", "stale derivation note cleared with its geometry");
  // the user's own pre-existing note is NOT the derived one → untouched
  const handNoted = { ...entry, note: "vendor quote" };
  const perEdit2 = libEntryPatch(handNoted, { per: 350 });
  assert.ok(!("grout" in perEdit2));
  assert.equal(perEdit2.note, "vendor quote");
  // a note typed in the same edit always wins
  const noteEdit = libEntryPatch(entry, { note: "hand rate per bid" });
  assert.ok(!("grout" in noteEdit));
  assert.equal(noteEdit.note, "hand rate per bid");
  const both = libEntryPatch(entry, { per: 350, note: "hand rate per bid" });
  assert.equal(both.note, "hand rate per bid");
});

// ── round-2 Defect A (data layer): the state libEntryPatch's detach creates ──

test("push/attach from a kind-carrying, geometry-less entry: the pushed rate survives and no calculator is offered", () => {
  // exactly the state a Materials-tab per edit leaves behind
  const entry = libEntryPatch({ id: "lib_1", ...libFields(groutLine()) }, { per: 350 });
  assert.deepEqual({ per: entry.per, kind: entry.kind, note: entry.note }, { per: 350, kind: "grout", note: "" });
  // push to a linked line that still has old geometry
  const linked = { id: "mat_2", ...libFields(groutLine()), lib_id: "lib_1" };
  const pushed = libPushPatch(linked, entry);
  assert.equal(pushed.per, 350, "pushed rate survives");
  assert.ok(!("grout" in pushed), "no geometry lands on the line");
  assert.equal(pushed.note, "", "no stale derivation note lands either");
  assert.equal(showsGroutCalc(pushed), false, "no defaults-backfilled calculator");
  assert.equal(showsGroutDeriveAffordance(pushed), true, "the explicit derive opt-in shows instead");
  // nothing ambers right after the push — the line matches its entry
  for (const f of ["name", "unit", "per", "basis", "round", "note", "grout"]) {
    assert.equal(matFieldOverridden(pushed, entry, f), false, f);
  }
  // attach the same entry elsewhere: same contract
  const attached = { id: "mat_3", ...libFields(entry), lib_id: "lib_1" };
  assert.equal(attached.per, 350);
  assert.ok(!("grout" in attached));
  assert.equal(showsGroutCalc(attached), false);
  assert.equal(showsGroutDeriveAffordance(attached), true);
  // the explicit derive (setGrout({}) in the editor) seeds defaults AND
  // re-derives per+note in the SAME commit — never an ambient backfill
  const g = { ...GROUT_DEFAULTS, ...(attached.grout || {}) };
  const derived = { ...attached, grout: { ...g }, ...(groutDerivedFields(g) || {}) };
  assert.deepEqual(derived.grout, GROUT_DEFAULTS);
  assert.deepEqual({ per: derived.per, note: derived.note }, { per: 512, note: groutNote(GROUT_DEFAULTS) });
  assert.equal(showsGroutCalc(derived), true);
});

// ── round-2 Defect D: a stale carried kind yields to the new name ───────────

test("rename re-classification: a geometry-less material's stale kind drops when the new name disagrees", () => {
  // attached adhesive renamed to a mortar → mortar presets again (pre-seam behavior)
  const adhesive = { id: "mat_1", name: "Adhesive", kind: "adhesive", unit: "gal", per: 250, basis: "area", round: true };
  const attached = { id: "mat_2", ...libFields({ id: "lib_1", ...libFields(adhesive) }), lib_id: "lib_1" };
  const renamed = matEditPatch(attached, { name: "Thinset mortar" });
  assert.ok(!("kind" in renamed));
  assert.equal(materialKind(renamed), "mortar");
  // renamed to something unclassified → kind-less, like a hand-typed line
  assert.equal(materialKind(matEditPatch(attached, { name: "Sealer" })), "");
  // renamed within the same classification → kind stays (seeded lines unchanged)
  assert.equal(matEditPatch(attached, { name: "Adhesive (wood, SMP)" }).kind, "adhesive");
  // geometry present: kind:"grout" is load-bearing (the calculator gate) and never drops
  const g = matEditPatch(groutLine(), { name: "Ultracolor FA" });
  assert.equal(g.kind, "grout");
  assert.deepEqual(g.grout, MOSAIC);
  // non-name edits never touch kind
  assert.equal(matEditPatch(attached, { per: 300 }).kind, "adhesive");
  // the library path applies the same rule through libEntryPatch
  const libRenamed = libEntryPatch({ id: "lib_1", ...libFields(adhesive) }, { name: "Thinset mortar" });
  assert.ok(!("kind" in libRenamed));
  assert.equal(materialKind(libRenamed), "mortar");
  // and a grout ENTRY with geometry keeps kind on rename, geometry intact
  const libGrout = libEntryPatch({ id: "lib_2", ...libFields(groutLine()) }, { name: "Ultracolor FA" });
  assert.equal(libGrout.kind, "grout");
  assert.deepEqual(libGrout.grout, MOSAIC);
  // renameReclassified itself: no kind → untouched
  assert.deepEqual(renameReclassified({ name: "Whatever" }), { name: "Whatever" });
});

// ── round-2 gap 1: the PLAIN-material seam is byte-identical to pre-fix ─────
// The headline risk of moving the library seam into libFields was regressing
// the #47 contract for ordinary (non-grout) materials. These replicas are the
// pre-seam (6fdc320) implementations verbatim; every promote/attach/override/
// revert/push result must stay deep-equal to them, and no kind/grout key may
// ever appear on a plain material's copies.
const preFixLibFields = (lm: any) => ({ name: lm.name || "", unit: lm.unit || "", per: lm.per || 0, basis: lm.basis || "area", round: lm.round !== false, note: lm.note || "" });
const preFixOverridden = (m: any, lm: any, f: string) => {
  if (!lm) return false;
  const L: any = preFixLibFields(lm);
  if (f === "per") return (Number(m.per) || 0) !== L.per;
  if (f === "round") return (m.round !== false) !== L.round;
  if (f === "basis") return (m.basis || "area") !== L.basis;
  return String(m[f] || "") !== String(L[f] || "");
};

test("plain-material parity: promote/attach/override/revert/push are byte-identical to the pre-seam contract", () => {
  const line = { id: "mat_1", name: "Adhesive", unit: "gal", per: 250, basis: "area", round: true, note: "1/8 sq notch" };
  // promote
  const entry = { id: "lib_1", ...libFields(line) };
  assert.deepEqual(entry, { id: "lib_1", ...preFixLibFields(line) });
  assert.ok(!("kind" in entry) && !("grout" in entry), "promote grows no kind/grout");
  // attach
  const attached = { id: "mat_2", ...libFields(entry), lib_id: "lib_1" };
  assert.deepEqual(attached, { id: "mat_2", ...preFixLibFields(entry), lib_id: "lib_1" });
  // per-field override ambers exactly as pre-fix, and a clean attach never ambers
  for (const f of ["name", "unit", "per", "basis", "round", "note"]) {
    const drifted: any = { ...attached, [f]: f === "per" ? 300 : f === "round" ? false : f === "basis" ? "linear" : "X" };
    assert.equal(matFieldOverridden(drifted, entry, f), preFixOverridden(drifted, entry, f), `overridden(${f})`);
    assert.equal(matFieldOverridden(drifted, entry, f), true, `drift ambers (${f})`);
    assert.equal(matFieldOverridden(attached, entry, f), false, `clean attach not ambered (${f})`);
    // revert restores exactly the library value, one field at a time
    assert.deepEqual(libRevertPatch(drifted, entry, f), { [f]: (preFixLibFields(entry) as any)[f] }, `revert(${f})`);
  }
  // push replaces all six fields, nothing else
  const drifted = { ...attached, per: 999, note: "hand" };
  const pushed = libPushPatch(drifted, entry);
  assert.deepEqual(pushed, { ...drifted, ...preFixLibFields(entry) });
  assert.ok(!("kind" in pushed) && !("grout" in pushed), "push grows no kind/grout");
  // library-row edit is the plain merge it always was
  assert.deepEqual(libEntryPatch(entry, { per: 300 }), { ...entry, per: 300 });
  assert.deepEqual(libEntryPatch(entry, { note: "n2" }), { ...entry, note: "n2" });
});

// ── round-3 finding 1: push is kind-symmetric in BOTH directions ─────────────
// `kind` is never override-checked (no amber, no per-field ↺), so a push that
// leaves a stale kind behind is unhealable: an entry renamed
// "Adhesive"→"Thinset mortar" (whose own kind was correctly dropped by
// re-classification) used to push a line that says "Thinset mortar" but keeps
// kind:"adhesive" — adhesive presets on a mortar line forever.

test("libPushPatch kind symmetry: an entry WITHOUT kind clears the line's; an entry WITH kind carries it", () => {
  // direction 1: entry lost its kind (rename re-classified) → push deletes the line's stale kind
  const advLine = { id: "mat_1", name: "Adhesive", kind: "adhesive", unit: "gal", per: 250, basis: "area", round: true, note: "" };
  const entry = libEntryPatch({ id: "lib_1", ...libFields(advLine) }, { name: "Thinset mortar" });
  assert.ok(!("kind" in entry), "precondition: the rename dropped the entry's kind");
  const linked = { id: "mat_2", ...libFields({ id: "lib_1", ...libFields(advLine) }), lib_id: "lib_1" };
  const pushed = libPushPatch(linked, entry);
  assert.ok(!("kind" in pushed), "the line's stale kind goes with the push");
  assert.equal(materialKind(pushed), "mortar", "the pushed name rules the presets again");
  // grout variant: detached grout entry renamed "Silicone caulk" → pushed line
  // must NOT offer "derive from tile geometry…" on a caulk line
  const gEntryDetached = libEntryPatch({ id: "lib_2", ...libFields(groutLine()) }, { per: 350 });
  assert.equal(gEntryDetached.kind, "grout", "precondition: detach keeps kind");
  const gEntry = libEntryPatch(gEntryDetached, { name: "Silicone caulk" });
  assert.ok(!("kind" in gEntry), "precondition: the meaning-changing rename dropped kind");
  const gPushed = libPushPatch({ id: "mat_3", ...libFields(groutLine()), lib_id: "lib_2" }, gEntry);
  assert.ok(!("kind" in gPushed) && !("grout" in gPushed));
  assert.equal(showsGroutDeriveAffordance(gPushed), false, "no grout affordance on a caulk line");
  assert.equal(showsGroutCalc(gPushed), false);
  // direction 2: entry WITH kind → the push carries it (via libFields) onto a kind-less line
  const kindLess = { id: "mat_4", name: "Grout", unit: "bag", per: 300, basis: "area", round: true, note: "", lib_id: "lib_3" };
  const kindEntry = { id: "lib_3", name: "Ultracolor FA", kind: "grout", unit: "bag", per: 350, basis: "area", round: true, note: "" };
  const pushed2 = libPushPatch(kindLess, kindEntry);
  assert.equal(pushed2.kind, "grout");
  assert.equal(showsGroutDeriveAffordance(pushed2), true, "the unclassifiable pushed name still classifies grout via kind");
  // and after either push, nothing ambers — the line matches its entry
  for (const f of ["name", "unit", "per", "basis", "round", "note", "grout"]) {
    assert.equal(matFieldOverridden(pushed, entry, f), false, `direction 1: ${f}`);
    assert.equal(matFieldOverridden(pushed2, kindEntry, f), false, `direction 2: ${f}`);
  }
});

// ── round-3 finding 2: a NAME revert restores the entry's kind ───────────────
// kind is name-coupled metadata on a geometry-less line (renames drop it with
// the name), so ↺ on the name must revert them together — before this, a
// line renamed away from grout and reverted matched its entry on every
// visible field (zero amber) while its kind:"grout", and the derive
// affordance with it, was gone forever.

test("libRevertPatch name: restores the entry's kind on a geometry-less line (through matEditPatch, as updateMaterial applies it)", () => {
  const entry = { id: "lib_1", name: "Grout (Ultracolor)", kind: "grout", unit: "bag", per: 350, basis: "area", round: true, note: "" };
  let line: any = { id: "mat_1", ...libFields(entry), lib_id: "lib_1" };
  line = matEditPatch(line, { name: "Caulk" });                       // meaning-changing rename: grout → ""
  assert.ok(!("kind" in line), "precondition: the rename dropped the kind");
  const patch = libRevertPatch(line, entry, "name");
  assert.deepEqual(patch, { name: "Grout (Ultracolor)", kind: "grout" });
  line = matEditPatch(line, patch);                                   // ↺ routes through updateMaterial → matEditPatch
  assert.equal(line.kind, "grout", "the revert's restored kind survives re-classification");
  for (const f of ["name", "unit", "per", "basis", "round", "note", "grout"]) {
    assert.equal(matFieldOverridden(line, entry, f), false, f);
  }
  // the revert rename may ITSELF be meaning-changing ("Mortar mix" → an
  // unclassifiable entry name = mortar → ""): the explicit kind in the patch
  // is a fresh classification and must be exempt from re-classification, or
  // matEditPatch re-drops the kind the ↺ just restored (browser-caught)
  const uEntry = { id: "lib_3", name: "Ultracolor FA", kind: "grout", unit: "bag", per: 350, basis: "area", round: true, note: "" };
  let uLine: any = matEditPatch({ id: "mat_3", ...libFields(uEntry), lib_id: "lib_3" }, { name: "Mortar mix" });
  assert.ok(!("kind" in uLine), "precondition: '' → mortar rename dropped the kind");
  uLine = matEditPatch(uLine, libRevertPatch(uLine, uEntry, "name"));
  assert.equal(uLine.kind, "grout", "restored kind survives a meaning-changing revert rename");
  assert.equal(uLine.name, "Ultracolor FA");
  // entry WITHOUT kind + line with a stale one: the name revert clears it (symmetry)
  const plainEntry = { id: "lib_2", name: "Sealer", unit: "gal", per: 100, basis: "area", round: true, note: "" };
  const staleLine = { id: "mat_2", ...libFields(plainEntry), name: "Adhesive", kind: "adhesive", lib_id: "lib_2" };
  const clearPatch = libRevertPatch(staleLine, plainEntry, "name");
  assert.ok("kind" in clearPatch && clearPatch.kind === undefined, "stale kind cleared with the reverted name");
  assert.equal(clearPatch.name, "Sealer");
  // geometry on the LINE: kind is load-bearing (calculator gate) — name reverts alone
  const gLine = { ...groutLine(), name: "Renamed", lib_id: "lib_3" };
  assert.deepEqual(libRevertPatch(gLine, { id: "lib_3", ...libFields(groutLine()) }, "name"), { name: "Grout" });
  // no kind anywhere: byte-identical to the pre-round-3 patch (plain parity)
  assert.deepEqual(libRevertPatch({ id: "m", name: "X", lib_id: "l" }, { id: "l", name: "Adhesive lite" }, "name"), { name: "Adhesive lite" });
});

// ── round-3 finding 3: only meaning-CHANGING renames re-classify ─────────────
// The old predicate fired on ANY name touch while the stored kind disagreed
// with the name regex — but that disagreement is a legitimate state (it's
// exactly what kind is FOR: {name:"Ultracolor FA", kind:"grout"}), so one
// keystroke on such a name permanently dropped the classification.

test("rename predicate: a touch that keeps the name's classification preserves kind; a meaning-changing rename drops it", () => {
  const entry = { id: "lib_1", name: "Ultracolor FA", kind: "grout", unit: "bag", per: 350, basis: "area", round: true, note: "" };
  // typo-level touches ("" → ""): kind stays, on both edit paths
  assert.equal(libEntryPatch(entry, { name: "Ultracolor FA " }).kind, "grout", "appended space (library row)");
  assert.equal(libEntryPatch(entry, { name: "Ultracolor FAX" }).kind, "grout", "one keystroke (library row)");
  assert.equal(matEditPatch({ id: "mat_1", ...libFields(entry), lib_id: "lib_1" }, { name: "Caulk" }).kind, "grout",
    "condition line: '' → '' rename keeps the stored classification");
  // a new name that AGREES with the stored kind keeps it too
  assert.equal(libEntryPatch(entry, { name: "Ultracolor FA grout" }).kind, "grout");
  // meaning-changing renames still drop it
  const groutNamed = { ...entry, name: "Grout" };
  assert.ok(!("kind" in libEntryPatch(groutNamed, { name: "Caulk" })), "grout → '' drops");
  assert.ok(!("kind" in libEntryPatch(groutNamed, { name: "Silicone adhesive" })), "grout → adhesive drops");
  // renameReclassified directly: the meaning check is old-name vs new-name
  assert.equal(renameReclassified({ name: "Ultracolor FA ", kind: "grout" }, "Ultracolor FA").kind, "grout");
  assert.ok(!("kind" in renameReclassified({ name: "Caulk", kind: "grout" }, "Grout")));
  // geometry present: never drops, whatever the rename
  assert.equal(matEditPatch(groutLine(), { name: "Silicone caulk" }).kind, "grout");
});

// ── round-3 finding 4 (flow): derive on a linked line ambers, trio-revert heals ──

test("derive-on-linked-line: the geometry row ambers (presence mismatch) and the trio ↺ restores per/note and removes the geometry", () => {
  const entry = { id: "lib_1", name: "Grout", kind: "grout", unit: "bag", per: 350, basis: "area", round: true, note: "hand rate" };
  const line = { id: "mat_1", ...libFields(entry), lib_id: "lib_1" };
  assert.equal(matFieldOverridden(line, entry, "grout"), false, "attach from a geometry-less entry: both absent, no amber");
  // the derive affordance's click (setGrout({}) in the editor)
  const g = { ...GROUT_DEFAULTS, ...((line as any).grout || {}) };
  const derived = { ...line, grout: { ...g }, ...(groutDerivedFields(g) || {}) };
  assert.equal(matFieldOverridden(derived, entry, "grout"), true, "line present vs entry absent NOW ambers");
  assert.equal(matFieldOverridden(derived, entry, "per"), true);
  assert.equal(matFieldOverridden(derived, entry, "note"), true);
  // trio revert cleanly removes the derived geometry and restores per + note
  const patch = libRevertPatch(derived, entry, "grout");
  assert.deepEqual({ per: patch.per, note: patch.note }, { per: 350, note: "hand rate" });
  assert.ok("grout" in patch && patch.grout === undefined, "the derived geometry is removed, not zeroed");
  const reverted = { ...derived, ...patch };
  for (const f of ["per", "note", "grout"]) assert.equal(matFieldOverridden(reverted, entry, f), false, f);
  assert.equal(showsGroutCalc(reverted), false);
  assert.equal(showsGroutDeriveAffordance(reverted), true, "back to the opt-in affordance");
  // attach from a geometry-CARRYING entry: both present and equal, still no amber
  const gEntry = { id: "lib_2", ...libFields(groutLine()) };
  assert.equal(matFieldOverridden({ id: "mat_2", ...libFields(gEntry), lib_id: "lib_2" }, gEntry, "grout"), false);
});

// ── seed aliasing (finding 4): instantiation deep-copies nested grout ───────

test("instantiateMaterial: deep-copies grout so the CT-1 seed's object is never shared into live state", () => {
  const seedGrout: any = FLOORING_DEFAULTS.find((t: any) => t.finish_tag === "CT-1")!.materials.find((m: any) => m.kind === "grout")!;
  const a = instantiateMaterial(seedGrout, "mat_a");
  const b = instantiateMaterial(seedGrout, "mat_b");
  assert.deepEqual(a.grout, seedGrout.grout);
  assert.notEqual(a.grout, seedGrout.grout);   // not the module-load singleton
  assert.notEqual(a.grout, b.grout);           // not shared between instantiations
  assert.equal(a.id, "mat_a");
  assert.equal(a.round, true);
  // materials without grout don't grow a grout key
  assert.ok(!("grout" in instantiateMaterial({ name: "Adhesive", per: 250 }, "mat_c")));
});
