// Proposals (#365) — a batch an agent can revise or withdraw as one unit, and
// a condition edit the estimator accepts rather than discovers. Session-level
// against the bundled demo plan; the wire shape is pinned in conformance.test.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Session } from "../src/session.ts";
import { importTakeoff } from "../src/importing.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";
const SQ = (x: number, y: number, w = 100): [number, number][] => [[x, y], [x + w, y], [x + w, y + w], [x, y + w]];

async function scaled() {
  const s = new Session();
  await s.loadPlan(PLAN);
  s.setScale(KEY, { upp: 1 / 36 });
  return s;
}
const pending = (s: Session, id: string) => s.shapes.filter((x) => x.origin?.proposal_id === id && x.origin?.reviewed !== true);
const journalOf = (s: Session) => (s as any).journal as { op: string }[];

test("propose_takeoff: every commit path that follows attaches to the open batch; earlier commits stay un-batched; a second proposal takes over", async () => {
  const s = await scaled();
  const loose = s.measurePolygon(KEY, SQ(0, 0), { condition: "CPT-1", role: "floor_area" }).shape_id!;
  const p = s.proposeTakeoff("Level 1 rooms", "per finish schedule row CPT-1");
  const a = s.measurePolygon(KEY, SQ(200, 0), { condition: "CPT-1", role: "floor_area" }).shape_id!;
  const b = s.measureLine(KEY, [[0, 0], [360, 0]], { condition: "RB-1" }).shape_id!;
  const c = s.placeCount(KEY, [[50, 50], [60, 60]], { condition: "TH-1" }).shape_ids;
  const cutRes = s.cutOut({ parent_shape_id: a, verts: SQ(220, 20, 20) });
  const cut = "deduct_shape_id" in cutRes ? cutRes.deduct_shape_id : "";
  const base = s.deriveBase({ source_condition: "CPT-1", condition: "RB-2" });
  const byId = new Map(s.shapes.map((x) => [x.id, x]));
  assert.equal(byId.get(loose)!.origin?.proposal_id, undefined, "a commit before the proposal is not in it");
  for (const id of [a, b, ...c, cut, ...base.rooms.map((r) => r.base_shape_id)]) assert.equal(byId.get(id)!.origin?.proposal_id, p.proposal_id, `${id} attached centrally`);
  assert.equal(pending(s, p.proposal_id).length, 1 + 1 + 2 + 1 + 2, "polygon, line, two counts, the cut receipt, two base runs (one per CPT-1 floor)");
  const q = s.proposeTakeoff("Level 2", "sheet A-102");
  const d = s.measurePolygon(KEY, SQ(400, 0), { condition: "CPT-1", role: "floor_area" }).shape_id!;
  assert.equal(s.shapes.find((x) => x.id === d)!.origin?.proposal_id, q.proposal_id, "the newest open proposal is current");
  const ledger = s.summary().proposals!;
  assert.deepEqual(ledger.map((r) => [r.label, r.pending, r.accepted, r.current ?? false]), [["Level 1 rooms", 7, 0, false], ["Level 2", 1, 0, true]]);
  assert.equal(s.listShapes().shapes.find((x) => x.id === a)!.proposal_id, p.proposal_id, "list_shapes names the batch");
});

test("propose_takeoff refuses an empty label or rationale and opens nothing", async () => {
  const s = await scaled();
  assert.throws(() => s.proposeTakeoff("  ", "why"), /label is required/);
  assert.throws(() => s.proposeTakeoff("Rooms", ""), /rationale is required/);
  assert.equal(s.proposals.length, 0);
  assert.equal(journalOf(s).length, 0, "a refusal journals nothing");
});

test("revise_proposal: replaces ONLY the pending shapes as one step, keeps accepted ink, and one undo_last restores the previous batch exactly", async () => {
  const s = await scaled();
  const p = s.proposeTakeoff("Rooms", "schedule");
  const keep = s.measurePolygon(KEY, SQ(0, 0), { condition: "CPT-1", role: "floor_area" }).shape_id!;
  s.measurePolygon(KEY, SQ(200, 0), { condition: "CPT-1", role: "floor_area" });
  s.measurePolygon(KEY, SQ(400, 0), { condition: "CPT-1", role: "floor_area" });
  s.shapes.find((x) => x.id === keep)!.origin!.reviewed = true;   // the estimator accepted this one
  const before = structuredClone(s.exportPayload());
  const steps = journalOf(s).length;
  const r = s.reviseProposal(p.proposal_id, [
    { sheet: KEY, condition: "CPT-1", role: "floor_area", verts: SQ(600, 0, 360), label: "OFFICE 101" },
    { sheet: KEY, condition: "RB-1", role: "linear", verts: [[0, 0], [720, 0]] },
    { sheet: KEY, condition: "TH-1", role: "count", verts: [[5, 5]] },
    { sheet: KEY, condition: "WT-1", role: "surface_area", verts: [[0, 0], [360, 0]], height_ft: 8 },
  ]);
  assert.equal(r.replaced, 2, "the two pending shapes went; the accepted one is not part of the batch");
  assert.equal(r.committed, 4);
  assert.equal(journalOf(s).length, steps + 1, "ONE journal step");
  assert.ok(s.shapes.some((x) => x.id === keep && x.origin?.reviewed === true), "ink stays");
  const rows = s.listShapes().shapes.filter((x) => r.shape_ids.includes(x.id));
  assert.deepEqual(rows.map((x) => [x.condition, x.measure_role, x.area_sf, x.perimeter_lf, x.count, x.label, x.height_ft, x.proposal_id]), [
    ["CPT-1", "floor_area", 100, 40, undefined, "OFFICE 101", undefined, p.proposal_id],
    ["RB-1", "linear", 0, 20, undefined, undefined, undefined, p.proposal_id],
    ["TH-1", "count", undefined, undefined, 1, undefined, undefined, p.proposal_id],
    ["WT-1", "surface_area", 80, 10, undefined, undefined, 8, p.proposal_id],
  ], "the replacements measure exactly as fresh commits would, all attached to the batch");
  const undone = s.undoLast(1);
  assert.equal(undone.steps[0].op, "proposal_revise");
  assert.equal(undone.steps[0].shapes, 6);
  const after = s.exportPayload();
  assert.deepEqual(after.shapes, before.shapes, "the previous pending batch is back, in its recorded positions");
  assert.deepEqual(after.proposals, before.proposals);
  // conditions the revise minted on first touch stay, exactly as a measure_polygon
  // commit's undo leaves the condition it minted — undo reverses shapes, not tags
  assert.deepEqual(after.conditions.map((c) => c.finish_tag), ["CPT-1", "RB-1", "TH-1", "WT-1"]);
});

test("revise_proposal is all-or-nothing: a bad entry anywhere in the list leaves the batch untouched and names the entry", async () => {
  const s = await scaled();
  const p = s.proposeTakeoff("Rooms", "schedule");
  s.measurePolygon(KEY, SQ(0, 0), { condition: "CPT-1", role: "floor_area" });
  const before = structuredClone(s.exportPayload());
  const steps = journalOf(s).length;
  const good = { sheet: KEY, condition: "CPT-1", role: "floor_area" as const, verts: SQ(200, 0) };
  assert.throws(() => s.reviseProposal(p.proposal_id, [good, { sheet: KEY, condition: "CPT-1", role: "floor_area", verts: [[0, 0], [1, 1]] }]), /shapes\[1\].*at least 3/);
  assert.throws(() => s.reviseProposal(p.proposal_id, [good, { sheet: KEY, condition: "TH-1", role: "count", verts: [] }]), /shapes\[1\].*at least 1 vertex/);
  assert.throws(() => s.reviseProposal(p.proposal_id, [good, { sheet: KEY, condition: "WT-1", role: "surface_area", verts: [[0, 0], [10, 0]] }]), /shapes\[1\].*height/);
  assert.throws(() => s.reviseProposal(p.proposal_id, [good, { sheet: "nowhere.pdf", condition: "CPT-1", role: "floor_area", verts: SQ(0, 0) }]), /nowhere\.pdf/);
  assert.throws(() => s.reviseProposal(p.proposal_id, []), /withdraw_proposal/);
  assert.throws(() => s.reviseProposal("prop-missing", [good]), /No proposal/);
  assert.deepEqual(s.exportPayload(), before, "nothing moved");
  assert.equal(journalOf(s).length, steps, "nothing journaled");
});

test("withdraw_proposal: 40 pending shapes leave in ONE step, accepted ones stay, undo_last(1) restores all 40; a withdrawn batch takes no new commits", async () => {
  const s = await scaled();
  const p = s.proposeTakeoff("Forty rooms", "detect run");
  const keep = s.measurePolygon(KEY, SQ(0, 0), { condition: "CPT-1", role: "floor_area" }).shape_id!;
  s.shapes.find((x) => x.id === keep)!.origin!.reviewed = true;
  for (let i = 0; i < 40; i++) s.measurePolygon(KEY, SQ(10 * i, 200, 5), { condition: "CPT-1", role: "floor_area" });
  assert.equal(pending(s, p.proposal_id).length, 40);
  const before = structuredClone(s.exportPayload());
  const steps = journalOf(s).length;
  const r = s.withdrawProposal(p.proposal_id);
  assert.deepEqual([r.withdrawn, r.accepted_kept], [40, 1]);
  assert.equal(journalOf(s).length, steps + 1, "ONE journal step for forty shapes");
  assert.equal(s.shapes.length, 1);
  assert.equal(s.summary().proposals![0].withdrawn, true);
  const loose = s.measurePolygon(KEY, SQ(900, 0), { condition: "CPT-1", role: "floor_area" }).shape_id!;
  assert.equal(s.shapes.find((x) => x.id === loose)!.origin?.proposal_id, undefined, "after withdrawal nothing is current");
  assert.throws(() => s.withdrawProposal(p.proposal_id), /already withdrawn/);
  assert.throws(() => s.reviseProposal(p.proposal_id, [{ sheet: KEY, condition: "CPT-1", role: "floor_area", verts: SQ(0, 0) }]), /withdrawn/);
  s.undoLast(1);   // the loose commit
  const undone = s.undoLast(1);
  assert.deepEqual([undone.steps[0].op, undone.steps[0].shapes], ["proposal_withdraw", 40]);
  assert.deepEqual(s.exportPayload(), before, "all forty back where they were, the proposal open again");
  assert.equal(s.summary().proposals![0].current, true, "and current again");
});

test("undo walks a proposal's whole history back: open → commits → revise → withdraw, in reverse, exactly", async () => {
  const s = await scaled();
  const p = s.proposeTakeoff("Rooms", "schedule");
  s.measurePolygon(KEY, SQ(0, 0), { condition: "CPT-1", role: "floor_area" });
  s.reviseProposal(p.proposal_id, [{ sheet: KEY, condition: "CPT-1", role: "floor_area", verts: SQ(200, 0) }]);
  s.withdrawProposal(p.proposal_id);
  const ops = s.undoLast(4).steps.map((x) => x.op);
  assert.deepEqual(ops, ["proposal_withdraw", "proposal_revise", "commit", "proposal_open"]);
  assert.equal(s.shapes.length, 0);
  assert.equal(s.proposals.length, 0, "undoing the open removes the record");
  assert.equal(s.summary().proposals, undefined, "and the summary carries no ledger");
});

test("propose_condition_edit: the report and the summary do not change until accepted; acceptance is byte-for-byte a direct edit_condition", async () => {
  const s = await scaled();
  s.measurePolygon(KEY, SQ(0, 0, 360), { condition: "CPT-1", role: "floor_area" });
  const reportBefore = JSON.stringify(s.exportReport());
  const summaryBefore = JSON.stringify(s.summary());
  const p = s.proposeConditionEdit("CPT-1", { waste_pct: 10, multiplier: 2, finish_tag: "CPT-1A" }, "spec 09 68 13 calls 10% cut waste; two identical floors");
  assert.deepEqual(p.proposed, { finish_tag: "CPT-1A", waste_pct: 10, multiplier: 2 });
  const strip = (j: string) => { const o = JSON.parse(j); delete o.proposed_condition_edits; delete o.proposals; return JSON.stringify(o); };
  assert.equal(strip(JSON.stringify(s.exportReport())), reportBefore, "every number in the report is the current value");
  assert.equal(strip(JSON.stringify(s.summary())), summaryBefore);
  const beside = s.exportReport().proposed_condition_edits!;
  assert.deepEqual(beside.map((r) => [r.condition, r.current.waste_pct, r.proposed.waste_pct, r.proposed.finish_tag]), [["CPT-1", 0, 10, "CPT-1A"]], "the proposed values sit beside the current ones");
  assert.equal(s.summary().proposed_condition_edits![0].rationale, "spec 09 68 13 calls 10% cut waste; two identical floors");

  // the control: a fresh session that edited directly
  const direct = await scaled();
  direct.measurePolygon(KEY, SQ(0, 0, 360), { condition: "CPT-1", role: "floor_area" });
  direct.editCondition("CPT-1", { waste_pct: 10, multiplier: 2 });
  direct.conditions[0].finish_tag = "CPT-1A";
  const normalize = (r: unknown) => JSON.stringify(r).replace(/"(cnd|shp)-[0-9a-f-]+"/g, '"ID"');

  const acc = s.acceptConditionEdit(p.proposal_id);
  assert.equal(acc.condition, "CPT-1A");
  assert.equal(normalize(s.exportReport()), normalize(direct.exportReport()), "after acceptance the report matches a direct edit byte for byte (ids aside)");
  assert.equal(s.exportReport().proposed_condition_edits, undefined, "and nothing is pending");
  assert.equal(s.summary().conditions[0].total_sf_net, 220, "100 SF × 2 × 1.10");
  const undone = s.undoLast(1);
  assert.equal(undone.steps[0].op, "condition_proposal_accept");
  assert.equal(strip(JSON.stringify(s.exportReport())), reportBefore, "undo puts the condition back exactly");
  assert.equal(s.conditionEditProposals.length, 1, "and the proposal is pending again");
});

test("propose_condition_edit refusals: unknown tag, nothing to change, a rename onto a taken tag, an empty rationale — none journal", async () => {
  const s = await scaled();
  s.measurePolygon(KEY, SQ(0, 0), { condition: "CPT-1", role: "floor_area" });
  s.measurePolygon(KEY, SQ(200, 0), { condition: "LVT-2", role: "floor_area" });
  const steps = journalOf(s).length;
  assert.throws(() => s.proposeConditionEdit("NOPE", { waste_pct: 5 }, "r"), /No condition "NOPE"/);
  assert.throws(() => s.proposeConditionEdit("CPT-1", { waste_pct: 0, multiplier: 1 }, "r"), /Nothing to propose/);
  assert.throws(() => s.proposeConditionEdit("CPT-1", { finish_tag: " lvt-2 " }, "r"), /already carries the tag "LVT-2"/);
  assert.throws(() => s.proposeConditionEdit("CPT-1", { finish_tag: "CPT-1" }, "r"), /Nothing to propose/, "same tag is not a rename");
  assert.throws(() => s.proposeConditionEdit("CPT-1", { waste_pct: 5 }, "  "), /rationale is required/);
  assert.equal(s.conditionEditProposals.length, 0);
  assert.equal(journalOf(s).length, steps);
});

test("one pending diff per condition: proposing again replaces it, withdraw drops it, and undo restores each in turn", async () => {
  const s = await scaled();
  s.measurePolygon(KEY, SQ(0, 0), { condition: "CPT-1", role: "floor_area" });
  const first = s.proposeConditionEdit("CPT-1", { waste_pct: 5 }, "first");
  const second = s.proposeConditionEdit("CPT-1", { waste_pct: 12 }, "second");
  assert.equal(second.replaced_proposal_id, first.proposal_id);
  assert.deepEqual(s.conditionEditProposals.map((p) => p.id), [second.proposal_id], "one per condition");
  const w = s.withdrawConditionEdit(second.proposal_id);
  assert.deepEqual(w, { proposal_id: second.proposal_id, condition: "CPT-1", withdrawn: true });
  assert.equal(s.conditionEditProposals.length, 0);
  assert.throws(() => s.withdrawConditionEdit(second.proposal_id), /No condition-edit proposal/);
  assert.equal(s.undoLast(1).steps[0].op, "condition_proposal_withdraw");
  assert.deepEqual(s.conditionEditProposals.map((p) => p.proposed.waste_pct), [12]);
  assert.equal(s.undoLast(1).steps[0].op, "condition_proposal");
  assert.deepEqual(s.conditionEditProposals.map((p) => p.proposed.waste_pct), [5], "the replaced proposal is back");
  assert.equal(s.undoLast(1).steps[0].op, "condition_proposal");
  assert.equal(s.conditionEditProposals.length, 0);
  assert.equal(s.conditions[0].waste_pct, 0, "the condition was never touched");
});

test("export_takeoff carries proposals only when any exist, and import_takeoff transports them with their shapes", async () => {
  const s = await scaled();
  s.measurePolygon(KEY, SQ(0, 0), { condition: "CPT-1", role: "floor_area" });
  const bare = s.exportPayload() as Record<string, unknown>;
  assert.equal("proposals" in bare, false);
  assert.equal("condition_edit_proposals" in bare, false);
  const p = s.proposeTakeoff("Rooms", "schedule");
  const a = s.measurePolygon(KEY, SQ(200, 0), { condition: "CPT-1", role: "floor_area" }).shape_id!;
  const ce = s.proposeConditionEdit("CPT-1", { waste_pct: 8 }, "spec");
  const payload = s.exportPayload() as Record<string, unknown>;
  assert.equal((payload.proposals as unknown[]).length, 1);
  assert.equal((payload.condition_edit_proposals as unknown[]).length, 1);
  const dir = await mkdtemp(path.join(tmpdir(), "ot-prop-"));
  const file = path.join(dir, "takeoff.json");
  await writeFile(file, JSON.stringify(payload));

  const t = new Session();
  await t.loadPlan(PLAN);
  const r = await importTakeoff(t, file);
  assert.equal(r.replaced, true);
  assert.deepEqual(t.proposals.map((x) => x.id), [p.proposal_id]);
  assert.deepEqual(t.conditionEditProposals.map((x) => x.id), [ce.proposal_id]);
  assert.equal(t.shapes.find((x) => x.id === a)!.origin?.proposal_id, p.proposal_id);
  assert.equal(t.summary().proposals![0].current, undefined, "an imported batch is history, not the session's current proposal");
  const loose = t.measurePolygon(KEY, SQ(500, 0), { condition: "CPT-1", role: "floor_area" }).shape_id!;
  assert.equal(t.shapes.find((x) => x.id === loose)!.origin?.proposal_id, undefined);
  // the imported batch is still actionable: withdraw removes its pending shapes here too
  assert.equal(t.withdrawProposal(p.proposal_id).withdrawn, 1);
  assert.equal(t.acceptConditionEdit(ce.proposal_id).condition, "CPT-1");
  assert.equal(t.conditions.find((c) => c.finish_tag === "CPT-1")!.waste_pct, 8);
});

test("load_plan without merge clears proposals with everything else", async () => {
  const s = await scaled();
  s.proposeTakeoff("Rooms", "schedule");
  s.measurePolygon(KEY, SQ(0, 0), { condition: "CPT-1", role: "floor_area" });
  s.proposeConditionEdit("CPT-1", { waste_pct: 3 }, "r");
  await s.loadPlan(PLAN);
  assert.equal(s.proposals.length, 0);
  assert.equal(s.conditionEditProposals.length, 0);
  s.setScale(KEY, { upp: 1 / 36 });
  const id = s.measurePolygon(KEY, SQ(0, 0), { condition: "CPT-1", role: "floor_area" }).shape_id!;
  assert.equal(s.shapes.find((x) => x.id === id)!.origin?.proposal_id, undefined, "no stale current proposal survives a reload");
});
