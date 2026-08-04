// Condition twins over the wire — duplicate_condition / split_condition plus
// the family rules edit_materials now runs (variants.ts, the same
// propagate-on-write the canvas runs). Behavioral coverage for the #204/#205
// pair: mint, follow, go-local, tombstone, split, and the exact inverses
// undo_last promises. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Session } from "../src/session.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));

type Row = { id: string; name: string; per: number; origin_id?: string; inherited?: boolean };
type Cond = { id: string; finish_tag: string; family_id?: string; variant_of?: string;
              variant_label?: string; materials: Row[]; materials_dropped?: string[] };

/** A session with CPT-1 seeded: adhesive + seam tape, the two-row family root. */
async function seeded() {
  const s = new Session();
  await s.loadPlan(PLAN);
  const r = s.editMaterials("CPT-1", { add: [
    { name: "Adhesive", per: 250, unit: "gal" },
    { name: "Seam tape", per: 100, basis: "linear", unit: "roll" },
  ] }) as { materials: Row[] };
  return { s, rows: r.materials };
}

const conds = (s: Session): Cond[] => (s.exportPayload() as { conditions: Cond[] }).conditions;
const byTag = (s: Session, tag: string): Cond => {
  const c = conds(s).find((x) => x.finish_tag === tag);
  assert.ok(c, `condition ${tag} exists`);
  return c!;
};

test("duplicate_condition: twin arrives following, family stamped on both sides", async () => {
  const { s, rows } = await seeded();
  const r = s.duplicateCondition("CPT-1", "Level 2");
  assert.equal(r.condition, "CPT-1 – Level 2");
  assert.equal(r.inherited_rows, 2);
  assert.ok(r.family_id, "family minted");
  assert.match(r.note, /No takeoffs came along/);

  const parent = byTag(s, "CPT-1");
  const twin = byTag(s, "CPT-1 – Level 2");
  assert.equal(parent.family_id, r.family_id, "parent joined the same family");
  assert.equal(twin.variant_of, parent.id);
  assert.equal(twin.variant_label, "Level 2");
  assert.equal(twin.materials.length, 2);
  for (const row of twin.materials) {
    assert.equal(row.inherited, true, "every arriving row follows");
    assert.ok(rows.some((p) => p.id === row.origin_id), "origin link points at a parent row");
    assert.ok(!rows.some((p) => p.id === row.id), "twin rows carry fresh ids");
  }
});

test("duplicate_condition: unknown tag, empty label, and collisions (case-insensitive) refuse", async () => {
  const { s } = await seeded();
  assert.throws(() => s.duplicateCondition("VCT-9", "x"), /No condition "VCT-9".*Known tags: CPT-1/s);
  assert.throws(() => s.duplicateCondition("CPT-1", "  "), /label is required/);
  s.duplicateCondition("CPT-1", "Level 2");
  assert.throws(() => s.duplicateCondition("CPT-1", "Level 2"), /already called/);
  assert.throws(() => s.duplicateCondition("CPT-1", "LEVEL 2"), /already called/, "collision check is case-insensitive");
});

test("family follow: a patch on the parent reaches the twin's following row", async () => {
  const { s, rows } = await seeded();
  s.duplicateCondition("CPT-1", "Level 2");
  s.editMaterials("CPT-1", { patch: [{ id: rows[0].id, fields: { per: 300 } }] });
  const twinRow = byTag(s, "CPT-1 – Level 2").materials.find((r) => r.origin_id === rows[0].id)!;
  assert.equal(twinRow.per, 300, "the coverage change arrived");
  assert.equal(twinRow.inherited, true, "and the row still follows");
});

test("go local: a patch on the twin's row stops it following — the parent can no longer reach it", async () => {
  const { s, rows } = await seeded();
  s.duplicateCondition("CPT-1", "Level 2");
  const twinTag = "CPT-1 – Level 2";
  const tRow = byTag(s, twinTag).materials.find((r) => r.origin_id === rows[0].id)!;
  s.editMaterials(twinTag, { patch: [{ id: tRow.id, fields: { per: 175 } }] });
  const after = byTag(s, twinTag).materials.find((r) => r.id === tRow.id)!;
  assert.equal(after.per, 175);
  assert.equal(after.inherited, false, "edited row went local");

  s.editMaterials("CPT-1", { patch: [{ id: rows[0].id, fields: { per: 999 } }] });
  const still = byTag(s, twinTag).materials.find((r) => r.id === tRow.id)!;
  assert.equal(still.per, 175, "the local value held against a later family edit");
});

test("family add and remove: a new parent row reaches the twin; a parent remove takes the following copy, spares the local one", async () => {
  const { s, rows } = await seeded();
  s.duplicateCondition("CPT-1", "Level 2");
  const twinTag = "CPT-1 – Level 2";

  const addReply = s.editMaterials("CPT-1", { add: [{ name: "Primer", per: 400, unit: "gal" }] }) as { changed: { added: string[] } };
  const primerId = addReply.changed.added[0];
  const twinPrimer = byTag(s, twinTag).materials.find((r) => r.origin_id === primerId);
  assert.ok(twinPrimer, "the primer reached the twin");
  assert.equal(twinPrimer!.inherited, true);

  // take the twin's seam-tape row local, then remove both rows on the parent
  const tSeam = byTag(s, twinTag).materials.find((r) => r.origin_id === rows[1].id)!;
  s.editMaterials(twinTag, { patch: [{ id: tSeam.id, fields: { per: 90 } }] });
  s.editMaterials("CPT-1", { remove: [rows[1].id, primerId] });

  const twin = byTag(s, twinTag);
  assert.equal(twin.materials.find((r) => r.origin_id === primerId), undefined, "the following copy left with its parent row");
  const survivor = twin.materials.find((r) => r.id === tSeam.id)!;
  assert.equal(survivor.per, 90, "the local copy survived the parent's remove");
  assert.equal(survivor.origin_id, undefined, "…cut loose so nothing dangles");
});

test("tombstone: removing a following row on the twin leaves a marker a family edit cannot undo", async () => {
  const { s, rows } = await seeded();
  s.duplicateCondition("CPT-1", "Level 2");
  const twinTag = "CPT-1 – Level 2";
  const tRow = byTag(s, twinTag).materials.find((r) => r.origin_id === rows[0].id)!;
  s.editMaterials(twinTag, { remove: [tRow.id] });

  const twin = byTag(s, twinTag);
  assert.deepEqual(twin.materials_dropped, [rows[0].id], "the tombstone names the parent row");
  s.editMaterials("CPT-1", { patch: [{ id: rows[0].id, fields: { per: 999 } }] });
  assert.equal(byTag(s, twinTag).materials.find((r) => r.origin_id === rows[0].id), undefined,
    "a later family edit did not resurrect it");
});

test("split_condition: the link is CUT on the live object — no variant_of or tombstones survive into an export", async () => {
  const { s, rows } = await seeded();
  s.duplicateCondition("CPT-1", "Level 2");
  const twinTag = "CPT-1 – Level 2";
  const tRow = byTag(s, twinTag).materials.find((r) => r.origin_id === rows[0].id)!;
  s.editMaterials(twinTag, { remove: [tRow.id] });   // leave a tombstone behind too

  const r = s.splitCondition(twinTag);
  assert.equal(r.split, true);
  assert.equal(r.frozen_rows, 1, "one row was still following");

  const twin = byTag(s, twinTag);
  assert.equal(twin.variant_of, undefined, "the link is gone from the exported state");
  assert.equal(twin.materials_dropped, undefined, "tombstones are history, not inheritance");
  assert.ok(twin.family_id, "the family grouping stays");
  assert.ok(twin.materials.every((x) => x.inherited === undefined && x.origin_id === undefined), "every row froze as its own");

  s.editMaterials("CPT-1", { patch: [{ id: rows[1].id, fields: { per: 999 } }] });
  assert.ok(byTag(s, twinTag).materials.every((x) => x.per !== 999), "parent edits no longer arrive");
});

test("split_condition: a condition that is not a twin reports split:false and changes nothing", async () => {
  const { s } = await seeded();
  const r = s.splitCondition("CPT-1");
  assert.equal(r.split, false);
  assert.match(r.note!, /nothing was following/i);
});

test("undo duplicate: the twin goes whole, and a family minted by the duplicate comes off the parent", async () => {
  const { s } = await seeded();
  const before = structuredClone(byTag(s, "CPT-1"));
  s.duplicateCondition("CPT-1", "Level 2");
  const u = s.undoLast(1);
  assert.equal(u.undone, 1);
  assert.equal(u.steps[0].op, "duplicate_condition");
  assert.equal(conds(s).length, 1, "the twin is gone");
  assert.deepEqual(byTag(s, "CPT-1"), before, "the parent is byte-identical — no orphan family_id");
});

test("undo duplicate: a parent already in a family keeps it", async () => {
  const { s } = await seeded();
  s.duplicateCondition("CPT-1", "Level 2");
  const fam = byTag(s, "CPT-1").family_id;
  s.duplicateCondition("CPT-1", "Level 3");
  s.undoLast(1);
  assert.equal(byTag(s, "CPT-1").family_id, fam, "the family predates the undone twin");
  assert.equal(conds(s).length, 2, "only the second twin was removed");
});

test("undo split: the link and every row's following flag come back verbatim", async () => {
  const { s, rows } = await seeded();
  s.duplicateCondition("CPT-1", "Level 2");
  const twinTag = "CPT-1 – Level 2";
  const tRow = byTag(s, twinTag).materials.find((r) => r.origin_id === rows[0].id)!;
  s.editMaterials(twinTag, { remove: [tRow.id] });
  const before = structuredClone(byTag(s, twinTag));

  s.splitCondition(twinTag);
  s.undoLast(1);
  assert.deepEqual(byTag(s, twinTag), before, "variant_of, inherited flags, and the tombstone all restored");
});

test("undo a family materials edit: parent AND twin restore together", async () => {
  const { s, rows } = await seeded();
  s.duplicateCondition("CPT-1", "Level 2");
  const twinTag = "CPT-1 – Level 2";
  const parentBefore = structuredClone(byTag(s, "CPT-1"));
  const twinBefore = structuredClone(byTag(s, twinTag));

  s.editMaterials("CPT-1", { patch: [{ id: rows[0].id, fields: { per: 300 } }],
                             add: [{ name: "Primer", per: 400, unit: "gal" }] });
  assert.notDeepEqual(byTag(s, twinTag), twinBefore, "the edit reached the twin");

  s.undoLast(1);
  assert.deepEqual(byTag(s, "CPT-1"), parentBefore, "parent restored verbatim");
  assert.deepEqual(byTag(s, twinTag), twinBefore, "twin restored verbatim — the undo covered the propagation");
});

test("undo a twin-side remove: the tombstone comes back off", async () => {
  const { s, rows } = await seeded();
  s.duplicateCondition("CPT-1", "Level 2");
  const twinTag = "CPT-1 – Level 2";
  const twinBefore = structuredClone(byTag(s, twinTag));
  const tRow = byTag(s, twinTag).materials.find((r) => r.origin_id === rows[0].id)!;

  s.editMaterials(twinTag, { remove: [tRow.id] });
  assert.deepEqual(byTag(s, twinTag).materials_dropped, [rows[0].id]);
  s.undoLast(1);
  assert.deepEqual(byTag(s, twinTag), twinBefore, "row back, tombstone gone");
});

test("a patch cannot forge or shed a family link — id/origin_id/inherited are pinned", async () => {
  const { s, rows } = await seeded();
  s.duplicateCondition("CPT-1", "Level 2");
  const twinTag = "CPT-1 – Level 2";
  const tRow = byTag(s, twinTag).materials.find((r) => r.origin_id === rows[0].id)!;
  s.editMaterials(twinTag, { patch: [{ id: tRow.id, fields: { per: 175, origin_id: "mat_forged", id: "row_forged", inherited: true } as Record<string, number | string | boolean> }] });
  const after = byTag(s, twinTag).materials.find((r) => r.id === tRow.id)!;
  assert.equal(after.per, 175, "the honest field landed");
  assert.equal(after.origin_id, tRow.origin_id, "origin link unforgeable");
  assert.equal(after.inherited, false, "and the edit still took the row local");
});

test("export round-trip: the payload carries the whole family vocabulary", async () => {
  const { s } = await seeded();
  s.duplicateCondition("CPT-1", "Level 2");
  const payload = s.exportPayload() as { conditions: Cond[] };
  const parent = payload.conditions.find((c) => c.finish_tag === "CPT-1")!;
  const twin = payload.conditions.find((c) => c.finish_tag === "CPT-1 – Level 2")!;
  assert.ok(parent.family_id && parent.family_id === twin.family_id);
  assert.equal(twin.variant_of, parent.id);
  assert.equal(twin.variant_label, "Level 2");
  assert.ok(twin.materials.every((r) => r.inherited === true && !!r.origin_id),
    "the canvas will see these rows as following on import");
});
