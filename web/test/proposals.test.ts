// Proposals (#365), canvas half: grouping pending shapes into one Accept per
// batch, applying a condition-edit proposal exactly as the panel editor
// would, the report rows beside the current values, and the transport
// through the takeoff import merge and the report JSON.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingByProposal, describeConditionEdit, conditionEditPatch, acceptConditionEditProposal, proposedConditionEditRows } from "../src/lib/proposals.js";
import { mergeTakeoffImport } from "../src/lib/importTakeoff.js";
import { reportJson, conditionTotals } from "../src/lib/totals.js";
import { ANN_SCHEMA } from "../src/lib/store.js";

const shape = (id: string, over: Record<string, unknown> = {}) => ({ id, sheet_id: "a.pdf", condition_id: "c1", measure_role: "floor_area", verts_norm: [[0, 0], [1, 0], [1, 1]], computed: { area_sf: 1, perimeter_lf: 4 }, ...over });
const pend = (pid?: string) => ({ origin: { method: "manual", actor: "agent", reviewed: false, ...(pid ? { proposal_id: pid } : {}) } });

test("pendingByProposal: one group per batch in payload order, undescribed batches by id, the loose remainder last; ink never groups", () => {
  const shapes = [
    shape("loose-1", pend()),
    shape("b-1", pend("prop-b")), shape("a-1", pend("prop-a")), shape("a-2", pend("prop-a")),
    shape("ink", { origin: { actor: "agent", reviewed: true, proposal_id: "prop-a" } }),
    shape("human"),
    shape("orphan", pend("prop-gone")),
    shape("loose-2", pend()),
  ];
  const proposals = [{ id: "prop-a", label: "Level 1", rationale: "schedule" }, { id: "prop-b", label: "Base", rationale: "derived" }, { id: "prop-empty", label: "Nothing", rationale: "" }];
  const groups = pendingByProposal(shapes, proposals);
  assert.deepEqual(groups.map((g) => [g.proposal?.id ?? null, g.proposal?.label ?? null, g.ids]), [
    ["prop-a", "Level 1", ["a-1", "a-2"]],
    ["prop-b", "Base", ["b-1"]],
    ["prop-gone", "Proposal", ["orphan"]],
    [null, null, ["loose-1", "loose-2"]],
  ]);
  assert.deepEqual(pendingByProposal([], proposals), []);
  assert.deepEqual(pendingByProposal(shapes.filter((s) => s.id === "ink"), proposals), [], "accepted shapes are outside every batch");
  assert.deepEqual(pendingByProposal(shapes.slice(0, 1), null as any), [{ proposal: null, ids: ["loose-1"], shapes: [shapes[0]] }], "no payload proposals at all is fine");
});

test("describeConditionEdit prints only the fields the proposal carries, current beside proposed", () => {
  const cond = { id: "c1", finish_tag: "CPT-1", waste_pct: 0, multiplier: 1 };
  assert.deepEqual(describeConditionEdit(cond, { proposed: { waste_pct: 10, finish_tag: "CPT-1A" } }), [
    { field: "tag", from: "CPT-1", to: "CPT-1A" },
    { field: "waste", from: "0%", to: "10%" },
  ]);
  assert.deepEqual(describeConditionEdit({ ...cond, roll_setup: { material: "carpet" } }, { proposed: { roll_setup: null, height_ft: 8, multiplier: 2 } }), [
    { field: "multiplier", from: "×1", to: "×2" },
    { field: "height", from: "—", to: "8 ft" },
    { field: "roll goods", from: "carpet", to: "off" },
  ]);
  assert.deepEqual(describeConditionEdit(cond, { proposed: {} }), []);
  assert.deepEqual(describeConditionEdit(null, null), []);
});

test("conditionEditPatch mirrors the panel editor's semantics and drops malformed values", () => {
  assert.deepEqual(conditionEditPatch({ proposed: { finish_tag: " LVT-2 ", waste_pct: 7.5, multiplier: 3, height_ft: 9, roll_setup: null } }), { finish_tag: "LVT-2", waste_pct: 7.5, multiplier: 3, height_ft: 9, roll_setup: undefined });
  assert.deepEqual(conditionEditPatch({ proposed: { finish_tag: "  ", waste_pct: -1, multiplier: 0, height_ft: NaN } }), {});
  assert.deepEqual(conditionEditPatch({ proposed: { roll_setup: { material: "rubber", roll_width_ft: 6 } } }), { roll_setup: { material: "rubber", roll_width_ft: 6 } });
  assert.deepEqual(conditionEditPatch(null), {});
});

test("acceptConditionEditProposal applies the diff to ONE condition, refuses a rename onto a taken tag, and leaves the input untouched", () => {
  const conds = [{ id: "c1", finish_tag: "CPT-1", waste_pct: 0, multiplier: 1 }, { id: "c2", finish_tag: "LVT-2", waste_pct: 0, multiplier: 1 }];
  const before = structuredClone(conds);
  const ok = acceptConditionEditProposal(conds, { id: "p", condition_id: "c1", proposed: { waste_pct: 10, finish_tag: "CPT-1A" } }, () => "T");
  assert.equal(ok.error, null);
  assert.deepEqual(ok.conditions, [{ id: "c1", finish_tag: "CPT-1A", waste_pct: 10, multiplier: 1, updated_at: "T" }, conds[1]]);
  assert.deepEqual(conds, before, "pure");
  const clash = acceptConditionEditProposal(conds, { id: "p", condition_id: "c1", proposed: { finish_tag: " lvt-2 " } });
  assert.match(clash.error!, /LVT-2 already carries that tag/);
  assert.equal(clash.conditions, conds);
  assert.match(acceptConditionEditProposal(conds, { id: "p", condition_id: "nope", proposed: { waste_pct: 1 } }).error!, /no longer exists/);
  assert.match(acceptConditionEditProposal(conds, { id: "p", condition_id: "c1", proposed: { waste_pct: -4 } }).error!, /nothing to apply/);
});

test("proposedConditionEditRows is the report's beside-the-current-values block; a proposal for a missing condition is dropped", () => {
  const conds = [{ id: "c1", finish_tag: "CPT-1", waste_pct: 5, multiplier: 2, height_ft: 8 }];
  const rows = proposedConditionEditRows(conds, [
    { id: "p1", condition_id: "c1", proposed: { waste_pct: 10 }, rationale: "spec", proposed_at: "T" },
    { id: "p2", condition_id: "gone", proposed: { waste_pct: 10 }, rationale: "", proposed_at: "T" },
  ]);
  assert.deepEqual(rows, [{ proposal_id: "p1", condition: "CPT-1", condition_id: "c1", current: { finish_tag: "CPT-1", waste_pct: 5, multiplier: 2, height_ft: 8 }, proposed: { waste_pct: 10 }, rationale: "spec", proposed_at: "T" }]);
});

test("reportJson: proposed_condition_edits is present ONLY with content — the pinned v1 key set is untouched otherwise", () => {
  const conds = [{ id: "ct", finish_tag: "CT-1", color: "#123456", waste_pct: 10 }];
  const rows = conditionTotals(conds, [{ condition_id: "ct", sheet_id: "s", measure_role: "floor_area", computed: { area_sf: 100, perimeter_lf: 40 } }]);
  const plain = reportJson({ rows });
  assert.equal("proposed_condition_edits" in plain, false);
  assert.deepEqual(reportJson({ rows, proposedConditionEdits: [] }), plain, "an empty list is the same document, byte for byte");
  const withEdits = reportJson({ rows, proposedConditionEdits: proposedConditionEditRows(conds, [{ id: "p", condition_id: "ct", proposed: { waste_pct: 12 }, rationale: "r" }]) });
  assert.equal(withEdits.conditions[0].waste_pct, 10, "the row prints the CURRENT knob");
  assert.deepEqual(withEdits.proposed_condition_edits!.map((r: any) => [r.condition, r.current.waste_pct, r.proposed.waste_pct]), [["CT-1", 10, 12]]);
  assert.deepEqual(Object.keys(withEdits).slice(-2), ["roll_goods", "proposed_condition_edits"], "appended last");
});

const doc = (over: Record<string, unknown> = {}) => ({
  schema: ANN_SCHEMA, project_name: "Agent Run",
  sheets: [{ sheet_id: "va.pdf", units_per_px: 0.05 }],
  conditions: [{ id: "c1", finish_tag: "CPT-1", color: "#123456", fill: "solid", hatch: "", multiplier: 1, waste_pct: 10, materials: [] }],
  shapes: [{ id: "s1", sheet_id: "va.pdf", condition_id: "c1", measure_role: "floor_area", verts_norm: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]], computed: { area_sf: 100, perimeter_lf: 40 }, origin: { method: "manual", actor: "agent", reviewed: false, proposal_id: "prop-1" } }],
  proposals: [{ id: "prop-1", label: "Rooms", rationale: "schedule", created_at: "T" }],
  condition_edit_proposals: [{ id: "cp-1", condition_id: "c1", proposed: { waste_pct: 12 }, rationale: "spec", proposed_at: "T" }],
  markups: [], sheet_group: [], last_group: [], sheet_tabs: ["va.pdf"],
  ...over,
});

test("import merge: proposals ride into an empty project wholesale, and into a working project by id with the diff re-pointed through the tag-identity rule", () => {
  const fresh = mergeTakeoffImport({ conditions: [], shapes: [], markups: [], sheets: [] }, doc());
  assert.equal(fresh.note.replaced, true);
  assert.deepEqual(fresh.payload.proposals.map((p: any) => p.id), ["prop-1"]);
  assert.deepEqual(fresh.payload.condition_edit_proposals.map((p: any) => p.id), ["cp-1"]);

  const current = {
    conditions: [{ id: "mine", finish_tag: "cpt-1", waste_pct: 0 }],   // same tag, different id → the import's CPT-1 merges onto it
    shapes: [{ id: "s0", sheet_id: "va.pdf", condition_id: "mine" }], markups: [],
    sheets: [{ sheet_id: "va.pdf", units_per_px: 0.05 }],
    proposals: [{ id: "prop-0", label: "Mine", rationale: "", created_at: "T" }],
  };
  const merged = mergeTakeoffImport(current, doc());
  assert.deepEqual(merged.payload.proposals.map((p: any) => p.id), ["prop-0", "prop-1"], "appended, never replaced");
  assert.equal(merged.payload.shapes.find((s: any) => s.id === "s1").origin.proposal_id, "prop-1", "the shape keeps its batch");
  assert.deepEqual(merged.payload.condition_edit_proposals.map((p: any) => [p.id, p.condition_id]), [["cp-1", "mine"]], "the diff follows its condition onto the operator's own");
  const again = mergeTakeoffImport(merged.payload, doc());
  assert.deepEqual(again.payload.proposals.map((p: any) => p.id), ["prop-0", "prop-1"], "re-import is idempotent");
  assert.equal(again.payload.condition_edit_proposals.length, 1);
});

test("import merge: a diff onto a tag the operator already uses, or onto a condition that never arrived, is dropped rather than staged as a collision; a payload without proposals adds no key", () => {
  const current = { conditions: [{ id: "a", finish_tag: "CPT-1" }, { id: "b", finish_tag: "LVT-2" }], shapes: [{ id: "s0", sheet_id: "va.pdf", condition_id: "a" }], markups: [], sheets: [] };
  const r = mergeTakeoffImport(current, doc({ condition_edit_proposals: [
    { id: "rename", condition_id: "c1", proposed: { finish_tag: "lvt-2" }, rationale: "", proposed_at: "T" },
    { id: "ghost", condition_id: "nowhere", proposed: { waste_pct: 3 }, rationale: "", proposed_at: "T" },
    { id: "fine", condition_id: "c1", proposed: { waste_pct: 3 }, rationale: "", proposed_at: "T" },
  ] }));
  assert.deepEqual(r.payload.condition_edit_proposals.map((p: any) => p.id), ["fine"]);
  const bare = mergeTakeoffImport(current, doc({ proposals: undefined, condition_edit_proposals: undefined, shapes: [] }));
  assert.equal("proposals" in bare.payload, false);
  assert.equal("condition_edit_proposals" in bare.payload, false);
});
