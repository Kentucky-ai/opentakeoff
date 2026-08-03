// Condition twins — the inheritance contract.
//
// The rule under test: a twin's material row FOLLOWS its parent until the estimator touches it,
// and never again after. Wrong in either direction is a silently wrong quantity —
//   too greedy → a family edit overwrites the other area's own primer and adhesive
//   too shy    → fixing a coverage rate on the family reaches only one area
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseTagOf, variantTag, uniqueTag, isTwin, localCount, mintTwin,
  propagateRowPatch, propagateRowAdd, propagateRowRemove, rebaseChildren,
  markRowLocal, dropRowLocal, followFamily, splitFromFamily, promoteOnDelete,
  familyView, familyDepths, type VariantCond,
} from "../src/lib/variants.ts";

let seq = 0;
const mint = (p: string) => `${p}-${String(++seq).padStart(2, "0")}`;
const nowIso = () => "2026-08-03T00:00:00.000Z";
const fresh = () => { seq = 0; };

// a parent shaped like the real thing: the field material plus what goes under it
const parent = (): VariantCond => ({
  id: "cnd-p", finish_tag: "SV-1", color: "#2f6f4f", fill: "#2f6f4f", hatch: "solid",
  multiplier: 1, waste_pct: 8, created_at: "2026-01-01T00:00:00.000Z",
  materials: [
    { id: "mat-a", name: "Substrate patch", per: 80, basis: "area", unit: "bag", round: true },
    { id: "mat-b", name: "Moisture barrier", per: 190, basis: "area", unit: "gal", round: true },
    { id: "mat-c", name: "Adhesive", per: 185, basis: "area", unit: "gal", round: true },
    { id: "mat-d", name: "Seam sealer", per: 150, basis: "linear", unit: "kit", round: true },
  ],
});
const twinOf = (p: VariantCond, label = "Level 2") =>
  mintTwin(p, { label, mintId: mint, nowIso, nextHatch: "diag" });
const rowFor = (c: VariantCond, originId: string) => (c.materials || []).find((r) => r.origin_id === originId);
const byId = (cs: VariantCond[], id: string) => cs.find((c) => c.id === id) as VariantCond;

test("a variant label composes onto the base tag, and twinning a twin does not stack suffixes", () => {
  fresh();
  assert.equal(variantTag("SV-1", "Level 2"), "SV-1 – Level 2");
  assert.equal(baseTagOf("SV-1 – Level 2"), "SV-1");
  assert.equal(variantTag("SV-1 – Level 2", "Level 3"), "SV-1 – Level 3");
  assert.equal(variantTag("SV-1", "   "), "SV-1");
});

test("uniqueTag walks the (2), (3) series against normalized tags", () => {
  const norm = (s: string) => s.trim().toUpperCase();
  const taken = new Set(["SV-1 – LEVEL 2", "SV-1 – LEVEL 2 (2)"]);
  assert.equal(uniqueTag("SV-1 – Level 2", taken, norm), "SV-1 – Level 2 (3)");
  assert.equal(uniqueTag("CPT-1", taken, norm), "CPT-1");
});

test("the twin copies the material list with FRESH ids, every row following and origin-linked", () => {
  fresh();
  const p = parent();
  const { twin, parentPatch } = twinOf(p);
  assert.equal(twin.finish_tag, "SV-1 – Level 2");
  assert.equal(twin.variant_of, "cnd-p");
  assert.equal(twin.variant_label, "Level 2");
  assert.equal(parentPatch?.family_id, twin.family_id);        // the parent joins the family it starts
  assert.equal((twin.materials || []).length, 4);
  assert.ok((twin.materials || []).every((r) => r.inherited === true));
  assert.deepEqual((twin.materials || []).map((r) => r.origin_id), ["mat-a", "mat-b", "mat-c", "mat-d"]);
  assert.equal(new Set((twin.materials || []).map((r) => r.id)).size, 4);
  assert.ok((twin.materials || []).every((r) => !(p.materials || []).some((x) => x.id === r.id)), "fresh ids");
  // the spec travels; the identity and the appearance-by-position do not
  assert.equal(twin.waste_pct, 8);
  assert.equal(twin.color, p.color, "a twin keeps the family colour");
  assert.equal(twin.hatch, "diag", "and reads distinctly by hatch");
  assert.notEqual(twin.id, p.id);
  assert.equal(twin.created_at, "2026-08-03T00:00:00.000Z", "a twin is born now, not when its parent was");
});

test("a second twin joins the SAME family and does not restart it", () => {
  fresh();
  const p = { ...parent(), family_id: "fam-01" };
  const { twin, parentPatch } = twinOf(p, "Level 3");
  assert.equal(twin.family_id, "fam-01");
  assert.equal(parentPatch, null);
});

test("a family edit reaches an untouched row and skips one the twin took over", () => {
  fresh();
  const p = parent();
  let cs: VariantCond[] = [p, twinOf(p).twin];
  // the estimator takes over the twin's adhesive
  const adh = rowFor(cs[1], "mat-c")!;
  cs = cs.map((c) => (c.id === cs[1].id
    ? markRowLocal({ ...c, materials: (c.materials || []).map((r) => (r.id === adh.id ? { ...r, name: "Deck adhesive", per: 210 } : r)) }, adh.id)
    : c));
  // now change the family's patch coverage
  cs = cs.map((c) => (c.id === "cnd-p"
    ? { ...c, materials: (c.materials || []).map((r) => (r.id === "mat-a" ? { ...r, per: 65 } : r)) } : c));
  cs = propagateRowPatch(cs, "cnd-p", "mat-a", { per: 65 });
  assert.equal(rowFor(cs[1], "mat-a")!.per, 65, "the untouched row followed");
  assert.equal(rowFor(cs[1], "mat-c")!.name, "Deck adhesive", "the local adhesive held");
  assert.equal(rowFor(cs[1], "mat-c")!.inherited, false);
  // and a later family edit to the row it took over changes nothing
  cs = propagateRowPatch(cs, "cnd-p", "mat-c", { name: "Something else" });
  assert.equal(rowFor(cs[1], "mat-c")!.name, "Deck adhesive");
});

test("propagation never rewrites the link fields", () => {
  fresh();
  const p = parent();
  let cs: VariantCond[] = [p, twinOf(p).twin];
  const before = rowFor(cs[1], "mat-a")!;
  cs = propagateRowPatch(cs, "cnd-p", "mat-a", { id: "hijack", origin_id: "hijack", inherited: false, per: 42 });
  const after = rowFor(cs[1], "mat-a")!;
  assert.equal(after.id, before.id);
  assert.equal(after.origin_id, "mat-a");
  assert.equal(after.inherited, true);
  assert.equal(after.per, 42);
});

test("a row added to the family lands on every twin", () => {
  fresh();
  const p = parent();
  let cs: VariantCond[] = [p, twinOf(p).twin];
  const row = { id: "mat-new", name: "Deck primer", per: 600, basis: "area", unit: "gal", round: true };
  cs = cs.map((c) => (c.id === "cnd-p" ? { ...c, materials: [...(c.materials || []), row] } : c));
  cs = propagateRowAdd(cs, "cnd-p", row, mint);
  const got = rowFor(cs[1], "mat-new")!;
  assert.equal(got.name, "Deck primer");
  assert.equal(got.inherited, true);
  assert.notEqual(got.id, "mat-new");
});

test("a tombstoned row stays gone — a family re-add cannot resurrect it", () => {
  fresh();
  const p = parent();
  let cs: VariantCond[] = [p, twinOf(p).twin];
  const mvb = rowFor(cs[1], "mat-b")!;
  cs = cs.map((c) => (c.id === cs[1].id ? dropRowLocal(c, mvb.id) : c));
  assert.deepEqual(cs[1].materials_dropped, ["mat-b"]);
  assert.equal(localCount(cs[1]), 1, "a tombstone counts as local");
  cs = propagateRowPatch(cs, "cnd-p", "mat-b", { per: 999 });
  assert.equal(rowFor(cs[1], "mat-b"), undefined);
  cs = propagateRowAdd(cs, "cnd-p", (p.materials || [])[1], mint);
  assert.equal(rowFor(cs[1], "mat-b"), undefined, "the estimator said no once");
});

test("follow family restores an overridden row AND a tombstoned one", () => {
  fresh();
  const p = parent();
  let cs: VariantCond[] = [p, twinOf(p).twin];
  const adh = rowFor(cs[1], "mat-c")!;
  cs = cs.map((c) => (c.id === cs[1].id
    ? markRowLocal({ ...c, materials: (c.materials || []).map((r) => (r.id === adh.id ? { ...r, name: "Deck adhesive" } : r)) }, adh.id)
    : c));
  cs = followFamily(cs, cs[1].id, "mat-c", mint);
  assert.equal(rowFor(cs[1], "mat-c")!.name, "Adhesive");
  assert.equal(rowFor(cs[1], "mat-c")!.inherited, true);
  const mvb = rowFor(cs[1], "mat-b")!;
  cs = cs.map((c) => (c.id === cs[1].id ? dropRowLocal(c, mvb.id) : c));
  cs = followFamily(cs, cs[1].id, "mat-b", mint);
  assert.equal(rowFor(cs[1], "mat-b")!.name, "Moisture barrier");
  assert.equal(cs[1].materials_dropped, undefined);
  assert.equal(localCount(cs[1]), 0, "back to fully following the family");
});

test("a family row delete clears following copies but never a twin's own spec", () => {
  fresh();
  const p = parent();
  let cs: VariantCond[] = [p, twinOf(p).twin];
  const adh = rowFor(cs[1], "mat-c")!;
  cs = cs.map((c) => (c.id === cs[1].id
    ? markRowLocal({ ...c, materials: (c.materials || []).map((r) => (r.id === adh.id ? { ...r, name: "Deck adhesive" } : r)) }, adh.id)
    : c));
  cs = propagateRowRemove(cs, "cnd-p", "mat-a");
  assert.equal(rowFor(cs[1], "mat-a"), undefined);
  cs = propagateRowRemove(cs, "cnd-p", "mat-c");
  const kept = (cs[1].materials || []).find((r) => r.name === "Deck adhesive");
  assert.ok(kept, "the local adhesive survives its parent");
  assert.equal(kept!.origin_id, undefined, "and is cut loose, not left dangling");
});

test("a wholesale replace on the family re-bases its twins and spares their local rows", () => {
  fresh();
  const p = parent();
  let cs: VariantCond[] = [p, twinOf(p).twin];
  const adh = rowFor(cs[1], "mat-c")!, mvb = rowFor(cs[1], "mat-b")!;
  cs = cs.map((c) => (c.id === cs[1].id
    ? markRowLocal({ ...c, materials: (c.materials || []).map((r) => (r.id === adh.id ? { ...r, name: "Deck adhesive" } : r)) }, adh.id)
    : c));
  cs = cs.map((c) => (c.id === cs[1].id ? dropRowLocal(c, mvb.id) : c));
  // a template applied onto the parent: every id is new
  cs = cs.map((c) => (c.id !== "cnd-p" ? c : {
    ...c,
    materials: [{ id: "mat-n1", name: "Substrate patch", per: 70, basis: "area", unit: "bag" },
                { id: "mat-n2", name: "Deck primer", per: 600, basis: "area", unit: "gal" }],
  }));
  cs = rebaseChildren(cs, "cnd-p", mint);
  assert.ok((cs[1].materials || []).find((r) => r.name === "Deck adhesive"), "the local row survives a re-base");
  assert.equal(rowFor(cs[1], "mat-a"), undefined, "orphaned following rows are dropped");
  assert.equal(rowFor(cs[1], "mat-n1")!.per, 70, "and the new family rows arrive");
  assert.equal(rowFor(cs[1], "mat-n2")!.name, "Deck primer");
  // the tombstone still holds if the parent re-seeds that same id
  cs = cs.map((c) => (c.id !== "cnd-p" ? c
    : { ...c, materials: [...(c.materials || []), { id: "mat-b", name: "Moisture barrier", per: 190 }] }));
  cs = rebaseChildren(cs, "cnd-p", mint);
  assert.equal(rowFor(cs[1], "mat-b"), undefined);
});

test("split freezes every following row at its current values and stops the flow", () => {
  fresh();
  const p = parent();
  let cs: VariantCond[] = [p, twinOf(p).twin];
  cs = cs.map((c) => (c.id === "cnd-p"
    ? { ...c, materials: (c.materials || []).map((r) => (r.id === "mat-a" ? { ...r, per: 65 } : r)) } : c));
  cs = propagateRowPatch(cs, "cnd-p", "mat-a", { per: 65 });
  const famBefore = cs[1].family_id;
  cs = splitFromFamily(cs, cs[1].id);
  const twin = cs[1];
  assert.equal(twin.variant_of, undefined);
  assert.equal(twin.family_id, famBefore, "still groups and subtotals with its siblings");
  assert.equal((twin.materials || []).length, 4);
  assert.equal((twin.materials || []).find((r) => r.name === "Substrate patch")!.per, 65, "frozen at the current value");
  assert.ok((twin.materials || []).every((r) => r.inherited === undefined && r.origin_id === undefined));
  assert.equal(isTwin(twin), false);
  cs = propagateRowPatch(cs, "cnd-p", "mat-a", { per: 1 });
  assert.equal((cs[1].materials || []).find((r) => r.name === "Substrate patch")!.per, 65);
});

test("inheritance runs down a chain: family → twin → twin of the twin", () => {
  fresh();
  const p = parent();
  const a = twinOf(p, "Level 2").twin;
  const b = mintTwin(a, { label: "Level 3", mintId: mint, nowIso }).twin;
  let cs: VariantCond[] = [p, a, b];
  cs = propagateRowPatch(cs, "cnd-p", "mat-a", { per: 55 });
  assert.equal(rowFor(byId(cs, a.id), "mat-a")!.per, 55);
  const mid = rowFor(byId(cs, a.id), "mat-a")!;
  assert.equal((byId(cs, b.id).materials || []).find((r) => r.origin_id === mid.id)!.per, 55,
    "the grandchild followed through its own parent's row id");
  assert.equal(b.finish_tag, "SV-1 – Level 3");
});

test("deleting a family parent promotes the eldest twin and re-points its siblings", () => {
  fresh();
  const p = parent();
  const a = twinOf(p, "Level 2").twin;
  const b = mintTwin({ ...p, family_id: a.family_id }, { label: "Level 3", mintId: mint, nowIso }).twin;
  let cs = promoteOnDelete([p, a, b], new Set(["cnd-p"]));
  cs = cs.filter((c) => c.id !== "cnd-p");
  const heir = byId(cs, a.id), sib = byId(cs, b.id);
  assert.equal(heir.variant_of, undefined, "the heir is a root now");
  assert.ok((heir.materials || []).every((r) => r.origin_id === undefined && r.inherited === undefined));
  assert.equal((heir.materials || []).length, 4, "with every row materialized");
  assert.equal(sib.variant_of, heir.id, "the sibling follows the heir");
  const heirPatch = (heir.materials || []).find((r) => r.name === "Substrate patch")!;
  cs = propagateRowPatch(cs, heir.id, heirPatch.id, { per: 44 });
  assert.equal((byId(cs, sib.id).materials || []).find((r) => r.origin_id === heirPatch.id)!.per, 44);
});

test("familyView nests twins under their parent, keeps root order, and never drops an orphan", () => {
  fresh();
  const p = parent();
  const a = twinOf(p, "Level 2").twin;
  const other: VariantCond = { id: "cnd-x", finish_tag: "CPT-1", materials: [] };
  assert.deepEqual(familyView([p, other, a]).map((v) => [v.cond.id, v.depth]),
    [["cnd-p", 0], [a.id, 1], ["cnd-x", 0]]);
  assert.equal(familyDepths([p, other, a]).get(a.id), 1);
  const orphan: VariantCond = { id: "cnd-o", finish_tag: "SV-1 – Level 9", variant_of: "cnd-gone", materials: [] };
  assert.deepEqual(familyView([orphan]).map((v) => [v.cond.id, v.depth]), [["cnd-o", 0]]);
});

test("a cycle in a hand-edited payload cannot hang propagation", () => {
  const a: VariantCond = { id: "c1", finish_tag: "A", variant_of: "c2", materials: [{ id: "r1", origin_id: "r2", inherited: true }] };
  const b: VariantCond = { id: "c2", finish_tag: "B", variant_of: "c1", materials: [{ id: "r2", origin_id: "r1", inherited: true }] };
  assert.equal(propagateRowPatch([a, b], "c1", "r1", { name: "y" }).length, 2);
});
