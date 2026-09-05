// The import merge rules (lib/importTakeoff.js): the agent-handoff seam where
// an MCP export_takeoff file lands in the canvas. The one design rule under
// test everywhere: operator state wins, and re-importing is idempotent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTakeoffImport, mergeTakeoffImport } from "../src/lib/importTakeoff.js";
import { ANN_SCHEMA } from "../src/lib/store.js";

const doc = (over: Record<string, unknown> = {}) => ({
  schema: ANN_SCHEMA,
  project_name: "Agent Run",
  sheets: [{ sheet_id: "va.pdf", units_per_px: 0.05 }],
  conditions: [{ id: "c1", finish_tag: "CPT-1", color: "#123456", fill: "solid", hatch: "", multiplier: 1, waste_pct: 10, materials: [] }],
  shapes: [{ id: "s1", sheet_id: "va.pdf", condition_id: "c1", measure_role: "floor_area", verts_norm: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]], computed: { area_sf: 100, perimeter_lf: 40 }, origin: { method: "one_click_v1", actor: "agent", reviewed: false } }],
  markups: [],
  sheet_group: [],
  last_group: [],
  sheet_tabs: ["va.pdf"],
  ...over,
});

test("parse: rejects non-JSON and wrong schemas, passes the real one", () => {
  assert.throws(() => parseTakeoffImport("{nope"), /not valid JSON/);
  assert.throws(() => parseTakeoffImport(JSON.stringify({ schema: "something.else" })), /not a takeoff export/);
  assert.throws(() => parseTakeoffImport(JSON.stringify([1, 2])), /not a takeoff export/);
  assert.equal(parseTakeoffImport(JSON.stringify(doc())).project_name, "Agent Run");
});

test("empty project: import replaces wholesale (seeded conditions are not work)", () => {
  const current = { project_name: "", conditions: [{ id: "seed1", finish_tag: "CPT-1" }], shapes: [], markups: [], sheets: [] };
  const { payload, note } = mergeTakeoffImport(current, doc());
  assert.equal(note.replaced, true);
  assert.equal(payload.project_name, "Agent Run");
  assert.equal(payload.shapes.length, 1);
  assert.equal(note.shapes_pending, 1);   // reviewed:false counts as pending
});

test("replace keeps the operator's open view when the export carries none", () => {
  // An MCP export has empty sheet_tabs/groups — adopting them would bounce
  // the operator from their open sheet to the gallery mid-import.
  const current = { shapes: [], markups: [], conditions: [], sheets: [], sheet_tabs: ["va.pdf"], sheet_group: ["va.pdf", "va.pdf#2"], last_group: ["va.pdf", "va.pdf#2"] };
  const { payload, note } = mergeTakeoffImport(current, doc({ sheet_tabs: [], sheet_group: [], last_group: [] }));
  assert.equal(note.replaced, true);
  assert.deepEqual(payload.sheet_tabs, ["va.pdf"]);
  assert.deepEqual(payload.sheet_group, ["va.pdf", "va.pdf#2"]);
  // …but a NON-empty imported view is real state and wins on replace
  const explicit = mergeTakeoffImport(current, doc({ sheet_tabs: ["va.pdf#3"] }));
  assert.deepEqual(explicit.payload.sheet_tabs, ["va.pdf#3"]);
});

test("merge: same finish tag joins the operator's condition — no duplicate, shapes remapped", () => {
  const current = {
    conditions: [{ id: "mine", finish_tag: " cpt-1 " }],   // tag match is case/space-insensitive
    shapes: [{ id: "s0", sheet_id: "va.pdf", condition_id: "mine" }],
    markups: [], sheets: [{ sheet_id: "va.pdf", units_per_px: 0.05 }],
  };
  const { payload, note } = mergeTakeoffImport(current, doc());
  assert.equal(note.replaced, false);
  assert.equal(note.conditions_merged, 1);
  assert.equal(note.conditions_added, 0);
  assert.equal(payload.conditions.length, 1);
  const added = payload.shapes.find((s: { id: string }) => s.id === "s1");
  assert.equal(added.condition_id, "mine");
  // origin provenance rides through untouched — the pencil stays pencil
  assert.equal(added.origin.reviewed, false);
});

test("merge: new finish tag appends; a colliding condition id under a different tag is reminted", () => {
  const current = {
    conditions: [{ id: "c1", finish_tag: "LVT-2" }],   // same id, DIFFERENT tag
    shapes: [{ id: "s0", sheet_id: "va.pdf", condition_id: "c1" }],
    markups: [], sheets: [],
  };
  const { payload, note } = mergeTakeoffImport(current, doc());
  assert.equal(note.conditions_added, 1);
  const addedCond = payload.conditions.find((c: { finish_tag: string }) => c.finish_tag === "CPT-1");
  assert.equal(addedCond.id, "c1~2");   // deterministic escape, not a uuid
  assert.equal(payload.shapes.find((s: { id: string }) => s.id === "s1").condition_id, "c1~2");
});

test("re-import is idempotent: same-id shapes are skipped, not duplicated", () => {
  const first = mergeTakeoffImport({ shapes: [{ id: "s0", sheet_id: "va.pdf", condition_id: "x" }], markups: [], conditions: [], sheets: [] }, doc());
  const second = mergeTakeoffImport(first.payload, doc());
  assert.equal(second.note.shapes_added, 0);
  assert.equal(second.payload.shapes.length, first.payload.shapes.length);
});

test("scales: the operator's calibration wins per sheet; missing sheets adopt the import's", () => {
  const current = {
    shapes: [{ id: "s0", sheet_id: "va.pdf", condition_id: "x" }], markups: [], conditions: [],
    sheets: [{ sheet_id: "va.pdf", units_per_px: 0.05 }],
  };
  const imported = doc({ sheets: [{ sheet_id: "va.pdf", units_per_px: 0.05 }, { sheet_id: "va.pdf#2", units_per_px: 0.05 }] });
  const { payload, note } = mergeTakeoffImport(current, imported);
  assert.equal(payload.sheets.find((s: { sheet_id: string }) => s.sheet_id === "va.pdf").units_per_px, 0.05);
  assert.equal(payload.sheets.find((s: { sheet_id: string }) => s.sheet_id === "va.pdf#2").units_per_px, 0.05);
  assert.equal(note.scales_adopted, 1);
});

test("workspace fields stay the operator's on merge: name, tabs, groups", () => {
  const current = {
    project_name: "My Bid", sheet_tabs: ["va.pdf#3"], sheet_group: ["va.pdf", "va.pdf#2"],
    shapes: [{ id: "s0", sheet_id: "va.pdf", condition_id: "x" }], markups: [], conditions: [], sheets: [],
  };
  const { payload } = mergeTakeoffImport(current, doc());
  assert.equal(payload.project_name, "My Bid");
  assert.deepEqual(payload.sheet_tabs, ["va.pdf#3"]);
  assert.deepEqual(payload.sheet_group, ["va.pdf", "va.pdf#2"]);
});

test("unknown files are reported so the banner can explain an invisible import", () => {
  const current = { shapes: [{ id: "s0", sheet_id: "other.pdf", condition_id: "x" }], markups: [], conditions: [], sheets: [] };
  const { note } = mergeTakeoffImport(current, doc(), ["other.pdf"]);
  assert.deepEqual(note.unknown_files, ["va.pdf"]);
  // and silence when every referenced file is loaded
  assert.deepEqual(mergeTakeoffImport(current, doc(), ["other.pdf", "va.pdf"]).note.unknown_files, []);
});

// ── approvals (#176): transport, not minting ─────────────────────────────────
// An MCP session can now mint agent verdict marks, so the file half of the
// handoff has to carry the family — under the markup rule (append new ids,
// skip ones already here) and behind the same load gate the hydrate runs.
const agentMark = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, actor: "agent", ts: "2026-08-02T00:00:00.000Z", sheet_id: "va.pdf", at: [0.5, 0.5], ...over });

test("merge carries imported approvals: new ids append, same ids skip, actors ride untouched", () => {
  const current = {
    shapes: [{ id: "s0", sheet_id: "va.pdf", condition_id: "x" }], markups: [], conditions: [], sheets: [],
    approvals: [agentMark("apr-mine")],
  };
  const imported = doc({ approvals: [agentMark("apr-mine"), agentMark("apr-new", { shape_id: "s1", text: "checked" }), { id: "apr-seal", actor: "estimator", sheet_id: "va.pdf", at: [0.2, 0.2] }] });
  const { payload } = mergeTakeoffImport(current, imported);
  assert.deepEqual(payload.approvals.map((a: { id: string }) => a.id), ["apr-mine", "apr-new", "apr-seal"]);
  // an estimator seal arriving by file STAYS an estimator seal — the actor
  // field is the authority; import is transport, never a mint
  assert.equal(payload.approvals.find((a: { id: string }) => a.id === "apr-seal").actor, "estimator");
  assert.equal(payload.approvals.find((a: { id: string }) => a.id === "apr-new").text, "checked");
  // re-import is idempotent for the family too
  const again = mergeTakeoffImport(payload, imported);
  assert.equal(again.payload.approvals.length, 3);
});

test("merge gates imported approvals like the hydrate does: corrupt records drop, valid ones land", () => {
  const current = { shapes: [{ id: "s0", sheet_id: "va.pdf", condition_id: "x" }], markups: [], conditions: [], sheets: [] };
  const imported = doc({ approvals: [
    agentMark("apr-ok"),
    { id: "apr-bad-actor", actor: "robot", sheet_id: "va.pdf", at: [0.1, 0.1] },   // unknown actor
    { id: "", actor: "agent", sheet_id: "va.pdf", at: [0.1, 0.1] },                 // no id
    { id: "apr-bad-at", actor: "agent", sheet_id: "va.pdf", at: [0.1] },            // malformed anchor
  ] });
  const { payload } = mergeTakeoffImport(current, imported);
  assert.deepEqual(payload.approvals.map((a: { id: string }) => a.id), ["apr-ok"]);
  // …and a file with none leaves the payload without the key (byte-stable)
  assert.equal(mergeTakeoffImport(current, doc()).payload.approvals, undefined);
});

test("a sealed-but-untraced project MERGES instead of being replaced — a seal is operator ink", () => {
  const current = { project_name: "My Bid", shapes: [], markups: [], conditions: [], sheets: [], approvals: [{ id: "apr-seal", actor: "estimator", sheet_id: "va.pdf", at: [0.3, 0.3] }] };
  const { payload, note } = mergeTakeoffImport(current, doc());
  assert.equal(note.replaced, false, "the seal blocked the clean-replace path");
  assert.equal(payload.project_name, "My Bid");
  assert.equal(payload.approvals.length, 1, "the operator's seal survives");
  assert.equal(payload.shapes.length, 1, "the imported work still lands");
});

// ── twin lineage across an import ────────────────────────────────────────────
// variant_of is an ID, so it has to travel through condMap; and it only means anything when the
// PARENT arrived too — a twin whose parent merged into the operator's own condition would be
// following a materials list that never had its origin_ids.
test("an imported twin follows its parent through a de-collided id", () => {
  const cur = { conditions: [{ id: "cnd-1", finish_tag: "CPT-1", materials: [] }],
    shapes: [{ id: "s-mine", sheet_id: "va.pdf#1", condition_id: "cnd-1" }], sheets: [] };   // non-empty: the merge path, not clean-replace
  const imported = {
    schema: "opentakeoff.takeoff.v1",
    conditions: [
      { id: "cnd-1", finish_tag: "SV-9", family_id: "fam-1", materials: [{ id: "m1", name: "Adhesive", per: 185 }] },
      { id: "cnd-2", finish_tag: "SV-9 – Level 2", family_id: "fam-1", variant_of: "cnd-1",
        materials: [{ id: "m2", name: "Adhesive", per: 185, origin_id: "m1", inherited: true }] },
    ],
    shapes: [], sheets: [],
  };
  const { payload } = mergeTakeoffImport(cur, imported);
  const twin = payload.conditions.find((c: any) => c.finish_tag === "SV-9 – Level 2") as any;
  const parent = payload.conditions.find((c: any) => c.finish_tag === "SV-9") as any;
  assert.notEqual(parent.id, "cnd-1", "the parent's id collided with the operator's and was freed");
  assert.equal(twin.variant_of, parent.id, "the twin follows the parent's NEW id");
  assert.equal(twin.materials[0].inherited, true);
});

test("a twin whose parent merged into the operator's own condition keeps its materials and stops being a twin", () => {
  const cur = { conditions: [{ id: "cnd-mine", finish_tag: "SV-9", materials: [{ id: "mine-1", name: "My adhesive", per: 200 }] }],
    shapes: [{ id: "s-mine", sheet_id: "va.pdf#1", condition_id: "cnd-mine" }], sheets: [] };
  const imported = {
    schema: "opentakeoff.takeoff.v1",
    conditions: [
      { id: "cnd-a", finish_tag: "SV-9", family_id: "fam-1", materials: [{ id: "m1", name: "Adhesive", per: 185 }] },
      { id: "cnd-b", finish_tag: "SV-9 – Level 2", family_id: "fam-1", variant_of: "cnd-a",
        materials: [{ id: "m2", name: "Adhesive", per: 185, origin_id: "m1", inherited: true }] },
    ],
    shapes: [], sheets: [],
  };
  const { payload } = mergeTakeoffImport(cur, imported);
  const twin = payload.conditions.find((c: any) => c.finish_tag === "SV-9 – Level 2") as any;
  assert.equal(twin.variant_of, undefined, "nothing to follow — the parent is the operator's condition");
  assert.equal(twin.family_id, "fam-1", "grouping is cosmetic and rides along");
  assert.equal(twin.materials.length, 1);
  assert.equal(twin.materials[0].per, 185, "it keeps the numbers the file carried");
  assert.equal(twin.materials[0].origin_id, undefined);
  assert.equal(twin.materials[0].inherited, undefined);
});

test("conflicting scale refuses imports atomically, including into an untraced project", () => {
  for (const shapes of [[], [{ id: "existing", sheet_id: "va.pdf" }]]) {
    const current = doc({ shapes, sheets: [{ sheet_id: "va.pdf", units_per_px: 0.025 }] });
    const before = structuredClone(current);
    assert.throws(() => mergeTakeoffImport(current, doc()), /scale conflict on va.pdf/);
    assert.deepEqual(current, before);
    assert.throws(() => mergeTakeoffImport(current, doc({ sheets: [] })), /imported missing/);
  }
});

test("counts and duplicate IDs do not cause scale conflicts", () => {
  const current = doc({ sheets: [{ sheet_id: "va.pdf", units_per_px: 0.025, scale_confirmed: true }] });
  assert.equal(mergeTakeoffImport(current, doc()).note.shapes_added, 0);
  const incoming = doc({ shapes: [{ ...doc().shapes[0], id: "count-1", measure_role: "count", computed: { count: 1 } }] });
  const result = mergeTakeoffImport(current, incoming);
  assert.equal(result.note.shapes_added, 1);
  assert.equal(result.payload.sheets[0].units_per_px, 0.025);
});

test("legacy agent traces are pending on replace and merge; explicit approval survives", () => {
  const legacy = { ...doc().shapes[0], origin: { actor: "agent", method: "manual" } };
  const approved = { ...legacy, id: "approved", origin: { ...legacy.origin, reviewed: true } };
  for (const current of [{}, { shapes: [{ id: "existing", sheet_id: "va.pdf" }] }]) {
    const result = mergeTakeoffImport(current, doc({ shapes: [legacy, approved] }));
    assert.equal(result.note.shapes_pending, 1);
    assert.equal(result.payload.shapes.find((s: any) => s.id === legacy.id).origin.reviewed, false);
    assert.equal(result.payload.shapes.find((s: any) => s.id === approved.id).origin.reviewed, true);
    assert.equal((legacy.origin as any).reviewed, undefined);
  }
});
