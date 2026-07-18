// contribution.v2 wire builder (lib/contribute.js) — the privacy contract and
// the provenance triad. The invariants:
//   - the serialized payload NEVER contains sheet file names, label text,
//     units_per_px (or any scale value), or updated_at — the hard cut-lines
//     documented in docs/CONTRIBUTION_SPEC.md;
//   - the manual / clean one-click / corrected one-click triad stays
//     distinguishable on the wire (origin.method, edited, proposed_verts_norm,
//     edits);
//   - pickOrigin is a WHITELIST — unknown origin keys never ride;
//   - v1-era shapes (no id vocabulary, no created_at, no origin) still
//     serialize as valid rows with those keys simply absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContribution, pickOrigin } from "../src/lib/contribute.js";

// A workspace as the canvas would hand it over — deliberately salted with
// everything that must NOT leak: a real-looking file name in sheet_id, a shape
// label, condition color, updated_at stamps, and a units_per_px scale value.
const SHEET = "Westside Elementary - floorplan.pdf#2";
const fixture = () => {
  const conditions = [
    { id: "cnd-1", finish_tag: "LVT-9", color: "#123456", fill: "#123456", hatch: "plank", multiplier: 1, waste_pct: 10, created_at: "2026-07-18T11:00:00.000Z" },
  ];
  const shapes = [
    { // hand-traced
      id: "0f7b8f9e-0000-4000-8000-000000000001", created_at: "2026-07-18T12:00:00.000Z",
      updated_at: "2026-07-18T12:30:00.000Z", sheet_id: SHEET, condition_id: "cnd-1",
      measure_role: "floor_area", label: "Rm 204 Classroom",
      verts_norm: [[0.05, 0.05], [0.2, 0.05], [0.2, 0.2], [0.05, 0.2]],
      computed: { area_sf: 88, perimeter_lf: 40 }, origin: { method: "manual" },
    },
    { // one-click accepted verbatim
      id: "0f7b8f9e-0000-4000-8000-000000000002", created_at: "2026-07-18T12:01:00.000Z",
      sheet_id: SHEET, condition_id: "cnd-1", measure_role: "floor_area",
      verts_norm: [[0.3, 0.3], [0.45, 0.3], [0.45, 0.5], [0.3, 0.5]],
      computed: { area_sf: 120, perimeter_lf: 48 },
      origin: { method: "one_click_v1", seed_norm: [0.37, 0.4], reviewed: true },
    },
    { // one-click the estimator corrected after Create
      id: "0f7b8f9e-0000-4000-8000-000000000003", created_at: "2026-07-18T12:02:00.000Z",
      updated_at: "2026-07-18T12:40:00.000Z", sheet_id: SHEET, condition_id: "cnd-1",
      measure_role: "floor_area",
      verts_norm: [[0.6, 0.6], [0.8, 0.6], [0.8, 0.85], [0.6, 0.85]],
      computed: { area_sf: 260, perimeter_lf: 62 },
      origin: {
        method: "one_click_v1", seed_norm: [0.7, 0.7], reviewed: true, edited: true,
        edits: { vertex: 2, move: 1 },
        proposed_verts_norm: [[0.61, 0.6], [0.79, 0.6], [0.79, 0.83], [0.6, 0.84]],
      },
    },
  ];
  const scaleInfo = [{ sheet_id: SHEET, units_per_px: 0.020833, scale_source: "detected" }];
  return { conditions, shapes, scaleInfo };
};

test("privacy: the serialized payload carries no file names, label text, scale values, or edit timing", () => {
  const { conditions, shapes, scaleInfo } = fixture();
  const wire = JSON.stringify(buildContribution({
    conditions, shapes, scaleInfo, counters: { shapes_deleted: { one_click_v1: 1 } },
  }));
  for (const leak of ["Westside", "floorplan", ".pdf", "sheet_id", // file names / raw sheet keys
                      "Rm 204", "Classroom", "label",              // user label text
                      "units_per_px", "0.020833",                  // scale values
                      "updated_at",                                // edit timing beyond created_at
                      "#123456", "condition_id"]) {                // styling / internal joins
    assert.ok(!wire.includes(leak), `payload leaked ${JSON.stringify(leak)}`);
  }
  // …while the disclosed fields DO ride: opaque sheet token + scale provenance.
  const p = JSON.parse(wire);
  assert.equal(p.schema, "opentakeoff.contribution.v2");
  assert.deepEqual(p.sheets, [{ sheet: "sheet_1", scale_source: "detected" }]);
  assert.deepEqual(p.counters, { shapes_deleted: { one_click_v1: 1 } });
});

test("triad: manual / clean one-click / corrected one-click stay distinguishable on the wire", () => {
  const { conditions, shapes, scaleInfo } = fixture();
  const [manual, clean, fixed] = buildContribution({ conditions, shapes, scaleInfo }).shapes;
  assert.equal(manual.origin!.method, "manual");
  assert.equal("edited" in manual.origin!, false);
  assert.equal(clean.origin!.method, "one_click_v1");
  assert.equal("edited" in clean.origin!, false);
  assert.equal("proposed_verts_norm" in clean.origin!, false);     // accepted verbatim → no correction pair
  assert.equal(fixed.origin!.edited, true);
  assert.deepEqual(fixed.origin!.edits, { vertex: 2, move: 1 });
  assert.notDeepEqual(fixed.origin!.proposed_verts_norm, fixed.verts_norm); // the machine's trace ≠ the expert's fix
  for (const s of [manual, clean, fixed]) {
    assert.match(s.id, /^[0-9a-f-]{36}$/);
    assert.match(s.created_at, /^\d{4}-/);
  }
});

test("pickOrigin: whitelist — unknown keys are dropped, never spread", () => {
  assert.deepEqual(
    pickOrigin({
      method: "one_click_v1", reviewed: true, edits: { vertex: 1 },
      secret_sauce: 42, note: "call the GC about the vestibule", updated_at: "2026-07-18T12:00:00.000Z",
    }),
    { method: "one_click_v1", reviewed: true, edits: { vertex: 1 } },
  );
  assert.equal(pickOrigin(null), null);
  assert.equal(pickOrigin({ someday_field: 1 }), null); // nothing whitelisted → origin omitted entirely
});

test("agent_v1 round-trip: evidence is deep-whitelisted on the wire; accept-gate timing never rides", () => {
  const { conditions, scaleInfo } = fixture();
  const shapes = [{
    id: "0f7b8f9e-0000-4000-8000-000000000004", created_at: "2026-07-18T13:00:00.000Z",
    sheet_id: SHEET, condition_id: "cnd-1", measure_role: "floor_area",
    verts_norm: [[0.1, 0.6], [0.25, 0.6], [0.25, 0.8], [0.1, 0.8]],
    computed: { area_sf: 150, perimeter_lf: 50 },
    origin: {
      method: "agent_v1", actor: "agent", reviewed: true,
      // local accept-gate provenance — MUST NOT ride (no edit timing beyond created_at)
      proposed_ts: "2026-07-18T12:59:00.000Z", accepted_ts: "2026-07-18T13:00:00.000Z",
      proposed_verts_norm: [[0.1, 0.6], [0.25, 0.6], [0.25, 0.8], [0.1, 0.8]],
      seed_norm: [0.17, 0.7],
      evidence: {
        schedule_row_tag: "LVT-9",
        matched_text: "RM 204 " + "CLASSROOM WING CORRIDOR EAST ".repeat(10),   // >80 chars — must truncate
        seed_norm: [0.17, 0.7],
        prompt_text: "the estimator's full goal text",   // junk — must drop
        sheet_transcript: "arbitrary sheet text",         // junk — must drop
      },
    },
  }];
  const wire = JSON.stringify(buildContribution({ conditions, shapes, scaleInfo }));
  for (const leak of ["proposed_ts", "accepted_ts", "prompt_text", "sheet_transcript", "estimator's full goal"]) {
    assert.ok(!wire.includes(leak), `payload leaked ${JSON.stringify(leak)}`);
  }
  const s = JSON.parse(wire).shapes[0];
  assert.equal(s.origin.method, "agent_v1");
  assert.equal(s.origin.actor, "agent");
  assert.equal(s.origin.reviewed, true);
  assert.deepEqual(s.origin.seed_norm, [0.17, 0.7]);
  assert.deepEqual(s.origin.proposed_verts_norm, shapes[0].verts_norm);
  // evidence survives as EXACTLY the whitelisted triple, matched_text truncated
  assert.deepEqual(Object.keys(s.origin.evidence).sort(), ["matched_text", "schedule_row_tag", "seed_norm"]);
  assert.equal(s.origin.evidence.schedule_row_tag, "LVT-9");
  assert.equal(s.origin.evidence.matched_text.length, 80);
  assert.deepEqual(s.origin.evidence.seed_norm, [0.17, 0.7]);
});

test("pickOrigin: evidence is deep-whitelisted, never spread; junk-only evidence is omitted", () => {
  assert.deepEqual(
    pickOrigin({ method: "agent_v1", evidence: { matched_text: "CPT-1", plan_text: "leak" } }),
    { method: "agent_v1", evidence: { matched_text: "CPT-1" } },
  );
  // nothing whitelisted inside evidence → the evidence key itself is dropped
  assert.deepEqual(
    pickOrigin({ method: "agent_v1", evidence: { plan_text: "leak" } }),
    { method: "agent_v1" },
  );
  assert.deepEqual(pickOrigin({ method: "agent_v1", evidence: "not-an-object" }), { method: "agent_v1" });
});

test("legacy v1-era shapes (no created_at, no origin) still serialize", () => {
  const { conditions } = fixture();
  const legacy = [{
    id: "shp-1700000000000-1", sheet_id: SHEET, condition_id: "cnd-1",
    measure_role: "floor_area", verts_norm: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]],
    computed: { area_sf: 50, perimeter_lf: 30 },
  }];
  const p = buildContribution({ conditions, shapes: legacy });
  assert.equal(p.shapes.length, 1);
  const s = p.shapes[0];
  assert.equal(s.role, "floor_area");
  assert.equal(s.finish, "LVT-9");
  assert.equal(s.sheet, "sheet_1");
  assert.equal("created_at" in s, false);
  assert.equal("origin" in s, false);
  assert.equal("counters" in p, false);           // nothing passed → omitted
  assert.deepEqual(p.sheets, [{ sheet: "sheet_1" }]); // no scaleInfo → provenance simply absent
});

test("counters: an all-empty tally is omitted; a real one rides", () => {
  const { conditions, shapes } = fixture();
  const empty = buildContribution({ conditions, shapes, counters: { shapes_deleted: {} } });
  assert.equal("counters" in empty, false);
  const real = buildContribution({ conditions, shapes, counters: { shapes_deleted: { manual: 2 } } });
  assert.deepEqual(real.counters, { shapes_deleted: { manual: 2 } });
});
