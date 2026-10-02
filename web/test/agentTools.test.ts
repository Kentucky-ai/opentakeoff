// Agent tool registry (lib/agentTools.js) — the invariants:
//   - every tool declares a well-formed schema and validateToolArgs enforces it;
//   - an unknown tool or bad args is an { error } RESULT, never a throw;
//   - propose_shapes whitelists evidence (junk keys dropped, strings truncated)
//     and rejects uncited/unmeasurable shapes;
//   - one_click PROBES: it returns the ring and never stages/commits anything;
//   - the scale gate refuses real-world-unit work on an uncalibrated sheet.
import { test } from "node:test";
import assert from "node:assert/strict";

// The One-Click gate (lib/gate.js) is UP by default; these probe tests exercise
// the engine, so lift it at runtime. gate.test.ts pins the gated surface.
(globalThis as any).__OT_ONE_CLICK = true;
import {
  AGENT_TOOL_DEFS, executeAgentTool, validateToolArgs, pickAgentEvidence,
  agentScaleGate, EVIDENCE_MAX_CHARS,
} from "../src/lib/agentTools.js";

// A canvas-shaped capability stub. Every mutation is recorded so the tests can
// assert what executed — and, for the probe tools, what did NOT.
function makeCtx(overrides: Record<string, unknown> = {}) {
  const calls: Record<string, unknown[]> = { proposeShapes: [], createCondition: [], oneClick: [] };
  const ctx = {
    listSheets: () => [{ sheet: "plan.pdf", title: "A101", width: 2000, height: 1500, scale_set: true }],
    sheetDims: (k: string) => (k === "plan.pdf" ? { w: 2000, h: 1500 } : null),
    uppFor: (k: string) => (k === "plan.pdf" ? 0.02 : null),
    detectedLabel: () => "",
    readSheetText: async () => [{ text: "RM 204", x: 0.4, y: 0.5 }],
    readSchedule: async () => ({ rows: [{ finish_tag: "CPT-1", section: "FLOORING", category: "floor", category_source: "heading", description: "CARPET", manufacturer: "", style: "", spec_color: "", size: "", remarks: "", suggested: true }] }),
    viewRegion: async () => ({ image_data_url: "data:image/png;base64,AAAA", width: 100, height: 80 }),
    oneClick: async (sheet: string, x: number, y: number) => {
      calls.oneClick.push([sheet, x, y]);
      return { verts_norm: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3], [0.1, 0.3]], area_sf: 200, perimeter_lf: 60, seed_norm: [x, y] };
    },
    getConditions: () => [{ id: "cnd-1", finish_tag: "CPT-1", hatch: "solid", waste_pct: 5 }],
    createCondition: (tag: string) => { calls.createCondition.push(tag); return { id: `cnd-${tag}`, finish_tag: tag }; },
    proposeShapes: (shapes: unknown[]) => { calls.proposeShapes.push(shapes); return { staged: shapes.length }; },
    ...overrides,
  };
  return { ctx, calls };
}

test("registry: every tool has a name, description, and object schema; names are unique", () => {
  assert.ok(AGENT_TOOL_DEFS.length >= 8);
  const names = new Set<string>();
  for (const d of AGENT_TOOL_DEFS) {
    assert.ok(d.name && typeof d.name === "string");
    assert.ok(d.description.length > 20, `${d.name} needs a real description`);
    assert.equal(d.input_schema.type, "object");
    assert.ok(Array.isArray(d.input_schema.required), `${d.name} schema needs required[]`);
    assert.ok(!names.has(d.name), `duplicate tool name ${d.name}`);
    names.add(d.name);
  }
  for (const expected of ["list_sheets", "read_sheet_text", "read_schedule", "view_region", "one_click", "get_conditions", "create_condition", "propose_shapes"]) {
    assert.ok(names.has(expected), `missing tool ${expected}`);
  }
});

test("validateToolArgs: required keys and primitive types enforced", () => {
  const schema = AGENT_TOOL_DEFS.find((d) => d.name === "one_click")!.input_schema;
  assert.equal(validateToolArgs(schema, { sheet: "plan.pdf", x: 0.5, y: 0.5 }), null);
  assert.match(validateToolArgs(schema, { x: 0.5, y: 0.5 })!, /missing required argument: sheet/);
  assert.match(validateToolArgs(schema, { sheet: "plan.pdf", x: "mid", y: 0.5 })!, /x must be a number/);
  assert.match(validateToolArgs(schema, null)!, /must be a JSON object/);
});

test("unknown tool → error RESULT, never a throw", async () => {
  const { ctx } = makeCtx();
  const out = await executeAgentTool(ctx, "summon_geometry", {});
  assert.match(out.error, /Unknown tool: summon_geometry/);
  assert.match(out.error, /list_sheets/);   // tells the model what IS available
});

test("bad args → error RESULT naming the problem", async () => {
  const { ctx } = makeCtx();
  const out = await executeAgentTool(ctx, "one_click", { sheet: "plan.pdf" });
  assert.match(out.error, /Invalid arguments for one_click/);
});

test("one_click probes without mutating anything", async () => {
  const { ctx, calls } = makeCtx();
  const out = await executeAgentTool(ctx, "one_click", { sheet: "plan.pdf", x: 0.5, y: 0.5 });
  assert.equal(out.area_sf, 200);
  assert.equal(out.verts_norm.length, 4);
  assert.deepEqual(calls.oneClick, [["plan.pdf", 0.5, 0.5]]);
  assert.equal(calls.proposeShapes.length, 0);     // a probe stages NOTHING
  assert.equal(calls.createCondition.length, 0);
});

test("one_click scale gate: uncalibrated sheet refuses with the shared gate text", async () => {
  const { ctx, calls } = makeCtx({ uppFor: () => null, detectedLabel: () => '1/8" = 1\'-0"' });
  const out = await executeAgentTool(ctx, "one_click", { sheet: "plan.pdf", x: 0.5, y: 0.5 });
  assert.equal(out.error, agentScaleGate("plan.pdf", '1/8" = 1\'-0"'));
  assert.match(out.error, /^Set the scale for plan\.pdf first — /);   // the MCP gate's opening line
  assert.match(out.error, /detected: 1\/8/);
  assert.equal(calls.oneClick.length, 0);          // the engine never even ran
});

test("propose_shapes: evidence whitelist — junk keys dropped, strings truncated, uncited rejected", async () => {
  const { ctx, calls } = makeCtx();
  const long = "X".repeat(500);
  const ring = [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3], [0.1, 0.3]];
  const out = await executeAgentTool(ctx, "propose_shapes", {
    shapes: [
      { sheet: "plan.pdf", verts_norm: ring, condition_id: "cnd-1", measure_role: "floor_area",
        evidence: { schedule_row_tag: "CPT-1", matched_text: long, seed_norm: [0.5, 0.5], prompt_text: "sneaky", room_transcript: long } },
      { sheet: "plan.pdf", verts_norm: ring, condition_id: "cnd-1", measure_role: "floor_area",
        evidence: { prompt_text: "junk only — nothing whitelisted survives" } },
    ],
  });
  assert.equal(out.staged, 1);
  assert.equal(out.rejected.length, 1);
  assert.match(out.rejected[0], /must cite evidence/);
  const staged = (calls.proposeShapes[0] as Record<string, any>[])[0];
  assert.deepEqual(Object.keys(staged.evidence).sort(), ["matched_text", "schedule_row_tag", "seed_norm"]);
  assert.equal(staged.evidence.matched_text.length, EVIDENCE_MAX_CHARS);   // truncated, hard line
  assert.equal(staged.evidence.schedule_row_tag, "CPT-1");
});

test("propose_shapes: unknown condition, bad role, degenerate ring, and unscaled sheet all reject", async () => {
  const { ctx, calls } = makeCtx({ uppFor: (k: string) => (k === "plan.pdf" ? 0.02 : null), sheetDims: (k: string) => (k === "plan.pdf" || k === "scan.pdf" ? { w: 2000, h: 1500 } : null) });
  const ev = { schedule_row_tag: "CPT-1" };
  const ring = [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3]];
  const out = await executeAgentTool(ctx, "propose_shapes", {
    shapes: [
      { sheet: "plan.pdf", verts_norm: ring, condition_id: "cnd-404", measure_role: "floor_area", evidence: ev },
      { sheet: "plan.pdf", verts_norm: ring, condition_id: "cnd-1", measure_role: "linear", evidence: ev },
      { sheet: "plan.pdf", verts_norm: [[0.1, 0.1], [0.2, 0.2]], condition_id: "cnd-1", measure_role: "floor_area", evidence: ev },
      { sheet: "scan.pdf", verts_norm: ring, condition_id: "cnd-1", measure_role: "floor_area", evidence: ev },   // no scale
      { sheet: "ghost.pdf", verts_norm: ring, condition_id: "cnd-1", measure_role: "floor_area", evidence: ev },  // not open
    ],
  });
  assert.equal(out.staged, 0);
  assert.equal(out.rejected.length, 5);
  assert.equal(calls.proposeShapes.length, 0);   // nothing valid → the canvas is never touched
  assert.match(out.rejected[3], /^Set the scale for scan\.pdf first/);
});

test("create_condition dedupes by tag instead of minting twins", async () => {
  const { ctx, calls } = makeCtx();
  const dup = await executeAgentTool(ctx, "create_condition", { finish_tag: "cpt-1" });
  assert.equal(dup.condition_id, "cnd-1");
  assert.equal(dup.note, "already existed");
  assert.equal(calls.createCondition.length, 0);
  const fresh = await executeAgentTool(ctx, "create_condition", { finish_tag: "LVT-2" });
  assert.equal(fresh.condition_id, "cnd-LVT-2");
  assert.deepEqual(calls.createCondition, ["LVT-2"]);
});

test("a capability throw becomes an error result (the loop must never crash)", async () => {
  const { ctx } = makeCtx({ readSheetText: async () => { throw new Error("text layer exploded"); } });
  const out = await executeAgentTool(ctx, "read_sheet_text", { sheet: "plan.pdf" });
  assert.match(out.error, /read_sheet_text failed: text layer exploded/);
});

test("pickAgentEvidence: null-safe, array-safe, whitelist-only", () => {
  assert.equal(pickAgentEvidence(null), null);
  assert.equal(pickAgentEvidence([1, 2]), null);
  assert.equal(pickAgentEvidence({ junk: 1 }), null);
  assert.deepEqual(pickAgentEvidence({ matched_text: "RM 204", junk: 1 }), { matched_text: "RM 204" });
});

test("proposals transport interior voids and refuse malformed hole rings", async () => {
  const { ctx, calls } = makeCtx();
  const hole = [[0.15,0.15],[0.2,0.15],[0.2,0.2],[0.15,0.2]];
  const shape = { sheet: "plan.pdf", condition_id: "cnd-1", measure_role: "floor_area", verts_norm: [[0.1,0.1],[0.3,0.1],[0.3,0.3],[0.1,0.3]], verts_norm_holes: [hole], evidence: { seed_norm: [0.25,0.25] } };
  assert.equal((await executeAgentTool(ctx, "propose_shapes", { shapes: [shape] })).staged, 1);
  assert.deepEqual((calls.proposeShapes[0] as any[])[0].verts_norm_holes, [hole]);
  for (const holes of [[[[NaN,0],[0,0],[1,1]]], [[[0,0],[1,1]]], "invalid"]) {
    assert.equal((await executeAgentTool(ctx, "propose_shapes", { shapes: [{ ...shape, verts_norm_holes: holes }] })).staged, 0);
  }
});

test("read_schedule: rows pass through with category_source and remarks", async () => {
  const row = { finish_tag: "RB-1", section: "", category: "base", category_source: "text", description: "RUBBER WALL BASE",
    manufacturer: "VENDOR-A", style: "", spec_color: "", size: "", remarks: "SCRIBE AT CASEWORK", suggested: true };
  const { ctx } = makeCtx({ readSchedule: async () => ({ rows: [row] }) });
  const out = await executeAgentTool(ctx, "read_schedule", { sheet: "plan.pdf", region: { x0: 0, y0: 0, x1: 0.5, y1: 0.5 } });
  assert.deepEqual(out, { rows: [row] });
});

test("read_schedule: a refused table says why, naming the title when that is the reason", async () => {
  const { ctx } = makeCtx({ readSchedule: async () => ({ rows: [], refused: "title", title: "DOOR SCHEDULE" }) });
  const out = await executeAgentTool(ctx, "read_schedule", { sheet: "plan.pdf", region: { x0: 0, y0: 0, x1: 0.5, y1: 0.5 } });
  assert.deepEqual(out.rows, []);
  assert.match(out.note, /^That's the "DOOR SCHEDULE", not a finish\/material schedule — /);
  assert.equal(Object.keys(out).sort().join(), "note,rows");

  const { ctx: ctx2 } = makeCtx({ readSchedule: async () => ({ rows: [], refused: "foreign-header" }) });
  const out2 = await executeAgentTool(ctx2, "read_schedule", { sheet: "plan.pdf", region: { x0: 0, y0: 0, x1: 0.5, y1: 0.5 } });
  assert.match(out2.note, /^That table doesn't look like a finish\/material schedule — /);
});

test("read_schedule: no table → the re-draw note names every key column", async () => {
  const { ctx } = makeCtx({ readSchedule: async () => ({ rows: [], refused: "no-table" }) });
  const out = await executeAgentTool(ctx, "read_schedule", { sheet: "plan.pdf", region: { x0: 0, y0: 0, x1: 0.5, y1: 0.5 } });
  assert.deepEqual(out.rows, []);
  assert.match(out.note, /^No schedule table found in that region/);
  for (const k of ["CODE", "TAG", "MARK", "SYMBOL"]) assert.match(out.note, new RegExp(`\\b${k}\\b`));
});

test("read_schedule: the description names the key columns and the row fields", () => {
  const d = AGENT_TOOL_DEFS.find((x) => x.name === "read_schedule")!.description;
  for (const w of ["CODE", "TAG", "MARK", "SYMBOL", "category_source", "remarks"]) assert.ok(d.includes(w), `${w} missing from: ${d}`);
});

// ── #483: skipped codes and key_rule in read_schedule ───────────────────────
const R = { sheet: "plan.pdf", region: { x0: 0, y0: 0, x1: 0.5, y1: 0.5 } };
const srow = (finish_tag: string, extra: Record<string, unknown> = {}) => ({ finish_tag, section: "", category: "floor", category_source: "heading",
  description: "X", manufacturer: "", style: "", spec_color: "", size: "", remarks: "", suggested: true, ...extra });

test("read_schedule: rows plus skipped codes → both, no note", async () => {
  const rows = [srow("CPT-1")];
  const { ctx } = makeCtx({ readSchedule: async () => ({ rows, skipped: ["EPOX"] }) });
  assert.deepEqual(await executeAgentTool(ctx, "read_schedule", R), { rows, skipped: ["EPOX"] });
  // an empty skipped list adds no key
  const { ctx: ctx2 } = makeCtx({ readSchedule: async () => ({ rows, skipped: [] }) });
  assert.deepEqual(await executeAgentTool(ctx2, "read_schedule", R), { rows });
});

test("read_schedule: { rows: [], skipped } → skipped and the exact note", async () => {
  const run = async (skipped: string[]) => {
    const { ctx } = makeCtx({ readSchedule: async () => ({ rows: [], skipped }) });
    return executeAgentTool(ctx, "read_schedule", R);
  };
  assert.deepEqual(await run(["EPOX"]), { rows: [], skipped: ["EPOX"],
    note: "No rows read. A four- or five-letter code with no number wasn't read: EPOX. Find its line with read_sheet_text, check it with view_region, then create it with create_condition if it's a finish." });
  assert.deepEqual(await run(["EPOX", "SEAL"]), { rows: [], skipped: ["EPOX", "SEAL"],
    note: "No rows read. Four- or five-letter codes with no number weren't read: EPOX, SEAL. Find their lines with read_sheet_text, check them with view_region, then create them with create_condition if they're finishes." });
  assert.deepEqual(await run(["EPOX", "EPOX"]), { rows: [], skipped: ["EPOX", "EPOX"],
    note: "No rows read. A four- or five-letter code with no number wasn't read: EPOX (2 lines). Find its lines with read_sheet_text, check it with view_region, then create it with create_condition if it's a finish." });
});

test("read_schedule: rows keep key_rule where the reader set it; other rows have no key_rule key", async () => {
  const rows = [srow("CPT-1"), srow("FTB-01", { key_rule: "extended", description: "CUT (C) — TILE BASE" }),
    srow("CPT-2", { suggested: false, unticked_reason: "not-used", not_used_text: "NOT USED" })];
  const { ctx } = makeCtx({ readSchedule: async () => ({ rows }) });
  const out = await executeAgentTool(ctx, "read_schedule", R);
  assert.equal(out.rows[1].key_rule, "extended");
  assert.ok(!("key_rule" in out.rows[0]));
  assert.ok(!("key_rule" in out.rows[2]));
  assert.equal(out.rows[2].unticked_reason, "not-used");
  assert.equal(out.rows[2].not_used_text, "NOT USED");
});

test("read_schedule: the description explains suggested, NOT USED, skipped, the drawn box and key_rule", () => {
  const d = AGENT_TOOL_DEFS.find((x) => x.name === "read_schedule")!.description;
  for (const w of ["suggested: false", "unticked_reason", "not_used_text", "skipped", "four- or five-letter", "whole-sheet index",
    "key_rule: \"extended\"", "view_region before creating it"]) assert.ok(d.includes(w), `${w} missing from: ${d}`);
  // #487's text stays
  assert.ok(d.includes("on the sheet's text layer only"));
});
