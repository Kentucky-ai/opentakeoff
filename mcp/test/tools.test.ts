// Tool-layer tests over a real client/server pair on an in-memory transport —
// schemas, error surfaces, and the scale gate as an MCP client sees them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";

async function pair() {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildServer(new Session());
  await server.connect(st);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(ct);
  return client;
}

interface Reply { isError: boolean; data: any }
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const res: any = await client.callTool({ name, arguments: args });
  assert.ok(Array.isArray(res.content) && res.content.length === 1, `${name}: single content item`);
  assert.equal(res.content[0].type, "text");
  return { isError: !!res.isError, data: JSON.parse(res.content[0].text) };
}

async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const originalWrite = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = originalWrite;
  }
  return output;
}

// undo_last is the one tool that takes no coordinates — it addresses this
// session's own command history, not the sheet — so the coordinate contract
// would be noise in its description rather than orientation. Every other tool
// speaks image px and says so.
const NO_COORDS = new Set(["undo_last"]);

test("tools/list: all fourteen tools, each described with the coordinate contract", async () => {
  const client = await pair();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "delete_shape", "detect_rooms", "edit_shape", "export_takeoff", "load_plan", "measure_line", "measure_polygon",
    "one_click", "read_sheet_text", "set_scale", "sheet_info", "takeoff_summary", "undo_last", "view_sheet",
  ]);
  for (const t of tools) {
    if (NO_COORDS.has(t.name)) continue;
    assert.match(t.description || "", /image px at render scale 2\.0/, `${t.name} carries the coordinate contract`);
  }
});

test("load_plan: happy path returns sheets; a missing file is isError, not a crash", async () => {
  const client = await pair();
  const good = await call(client, "load_plan", { path: PLAN });
  assert.equal(good.isError, false);
  assert.equal(good.data.page_count, 1);
  assert.equal(good.data.sheets[0].sheet, KEY);

  const bad = await call(client, "load_plan", { path: "/nowhere/missing-plan.pdf" });
  assert.equal(bad.isError, true);
  assert.ok(bad.data.error, "error message present");
});

test("one_click without a scale: ok result with px quantities and the warning", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  const r = await call(client, "one_click", { sheet: KEY, x: 600, y: 1084 });
  assert.equal(r.isError, false);
  assert.ok(r.data.area_px2 > 0);
  assert.equal(r.data.area_sf, undefined);
  assert.match(r.data.warning, /No scale set .* set_scale \(detected: 1\/4" = 1'-0"\)/);
});

test("detect_rooms: batch-finds all 4 rooms via the wire, commits under one condition", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });
  const preview = await call(client, "detect_rooms", { sheet: KEY });
  assert.equal(preview.isError, false);
  assert.equal(preview.data.detected, 4);
  assert.deepEqual(preview.data.rooms.map((r: any) => r.label).sort(), ["101", "102", "103", "104"]);
  assert.ok(preview.data.rooms.every((r: any) => !r.shape_id), "no condition — nothing committed");

  const committed = await call(client, "detect_rooms", { sheet: KEY, condition: "CPT-1" });
  assert.equal(committed.isError, false);
  assert.ok(committed.data.rooms.every((r: any) => typeof r.shape_id === "string"));
  const summary = await call(client, "takeoff_summary");
  assert.equal(summary.data.conditions.length, 1);
  assert.equal(summary.data.conditions[0].shape_count, 4);
});

// Regression for FINDING-2026-07-22: on a real sheet, detect_rooms reported 48
// "rooms" — 37 of them label-bubble floods under 5 SF, plus one region claimed by
// two labels and committed twice (589 SF double-counted). Every one traced
// cleanly, so the <3-vertex guard passed them and the schema tests passed too.
// What was missing was a contract on WITHHOLDING, so that is what these assert.
test("detect_rooms withholding: floor is enforced, reported, and never silent", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });

  const normal = await call(client, "detect_rooms", { sheet: KEY, return_verts: true });
  assert.equal(normal.isError, false);
  assert.ok(normal.data.withheld, "withheld is always reported, even when nothing was withheld");
  assert.equal(typeof normal.data.withheld.total, "number");
  assert.equal(normal.data.withheld.min_area_sf, 5, "default plausibility floor");

  // No two reported rooms may share a ring — that is the double-count. Keyed on
  // real geometry: the fixture's rooms are congruent, so area would collide.
  const rings = normal.data.rooms.map((r: any) => JSON.stringify(r.verts));
  assert.ok(rings.every((v: string) => v !== undefined));
  assert.equal(new Set(rings).size, rings.length, "one region commits once");

  // Raise the floor above every room: all withheld, counted as implausible,
  // and — the part that actually matters — nothing committed.
  const strict = await call(client, "detect_rooms", { sheet: KEY, condition: "CPT-1", min_area_sf: 1e6 });
  assert.equal(strict.isError, false);
  assert.equal(strict.data.detected, 0);
  assert.equal(strict.data.rooms.length, 0);
  assert.equal(strict.data.withheld.implausible, normal.data.detected);
  assert.match(strict.data.note, /withheld/);
  const summary = await call(client, "takeoff_summary");
  assert.equal(summary.data.conditions.length, 0, "withheld rooms must not commit");
});

test("detect_rooms preview: the plausibility floor needs real units, so it waits for a scale", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  const preview = await call(client, "detect_rooms", { sheet: KEY, min_area_sf: 1e6 });
  assert.equal(preview.isError, false);
  assert.equal(preview.data.withheld.implausible, 0, "no scale — no SF to judge, so the floor cannot apply");
  assert.equal(preview.data.withheld.min_area_sf, undefined);
  assert.ok(preview.data.detected > 0);
});

test("measure_polygon scale gate: exact refusal text with the detected hint", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  const r = await call(client, "measure_polygon", { sheet: KEY, verts: [[0, 0], [100, 0], [100, 100]] });
  assert.equal(r.isError, true);
  assert.equal(r.data.error, `Set the scale for ${KEY} first — use set_scale (detected: 1/4" = 1'-0").`);
});

test("set_scale: zero or several modes are rejected; one mode works", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });

  const none = await call(client, "set_scale", { sheet: KEY });
  assert.equal(none.isError, true);
  assert.match(none.data.error, /exactly one of: label, upp, calibrate, use_detected/);

  const both = await call(client, "set_scale", { sheet: KEY, upp: 0.5, use_detected: true });
  assert.equal(both.isError, true);
  assert.match(both.data.error, /exactly one/);

  const one = await call(client, "set_scale", { sheet: KEY, use_detected: true });
  assert.equal(one.isError, false);
  assert.equal(one.data.source, "detected");
  assert.ok(Math.abs(one.data.upp - 1 / 36) < 1e-12);

  const badLabel = await call(client, "set_scale", { sheet: KEY, label: "3/7\" = 1'-0\"" });
  assert.equal(badLabel.isError, true);
  assert.match(badLabel.data.error, /Unknown scale label/);
});

test("tool tracing: opt-in structured metadata goes to stderr without result content", async () => {
  const client = await pair();
  const originalTrace = process.env.OPENTAKEOFF_MCP_TRACE;
  try {
    delete process.env.OPENTAKEOFF_MCP_TRACE;
    const quiet = await captureStderr(async () => {
      await call(client, "takeoff_summary");
    });
    assert.equal(quiet, "");

    process.env.OPENTAKEOFF_MCP_TRACE = "1";
    const traced = await captureStderr(async () => {
      await call(client, "measure_polygon", { sheet: KEY, verts: [[0, 0], [100, 0], [100, 100]] });
    });

    const lines = traced.trim().split("\n");
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.event, "opentakeoff_mcp_tool_call");
    assert.equal(event.tool, "measure_polygon");
    assert.equal(event.sheet, KEY);
    assert.equal(event.is_error, true);
    assert.equal(typeof event.duration_ms, "number");
    assert.ok(event.duration_ms >= 0);
    assert.equal(typeof event.result_size, "number");
    assert.ok(event.result_size > 0);
    assert.doesNotMatch(traced, /Set the scale/);
    assert.doesNotMatch(traced, /verts/);
  } finally {
    if (originalTrace === undefined) delete process.env.OPENTAKEOFF_MCP_TRACE;
    else process.env.OPENTAKEOFF_MCP_TRACE = originalTrace;
  }
});

test("delete_shape: removes a committed shape; unknown id is isError", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });
  const committed = await call(client, "one_click", { sheet: KEY, x: 600, y: 1084, condition: "CPT-1" });
  assert.ok(committed.data.shape_id);

  const del = await call(client, "delete_shape", { shape_id: committed.data.shape_id });
  assert.equal(del.isError, false);
  assert.equal(del.data.shape_count, 0);

  const gone = await call(client, "delete_shape", { shape_id: committed.data.shape_id });
  assert.equal(gone.isError, true);
  assert.match(gone.data.error, /No shape with id/);
});

test("output contract: every JSON tool declares outputSchema; structuredContent mirrors the text item", async () => {
  const client = await pair();
  const { tools } = await client.listTools();
  for (const t of tools) {
    if (t.name === "view_sheet") {
      // the one image tool: replies are an image + meta text item, so there is
      // deliberately no outputSchema and no structuredContent
      assert.equal((t as any).outputSchema, undefined, "view_sheet declares no outputSchema");
      continue;
    }
    const schema: any = (t as any).outputSchema;
    assert.ok(schema && schema.type === "object", `${t.name} declares an object outputSchema`);
    assert.ok(schema.properties && Object.keys(schema.properties).length > 0, `${t.name} outputSchema has properties`);
  }
  // A structured reply validates AND byte-matches the back-compat text item.
  const res: any = await client.callTool({ name: "load_plan", arguments: { path: PLAN } });
  assert.equal(!!res.isError, false);
  assert.ok(res.structuredContent, "structuredContent present");
  assert.deepEqual(res.structuredContent, JSON.parse(res.content[0].text), "structuredContent === parsed text content");
  // Error replies stay plain isError results — no structuredContent required.
  const bad: any = await client.callTool({ name: "sheet_info", arguments: { sheet: "no-such-sheet" } });
  assert.equal(!!bad.isError, true);
  assert.equal(bad.structuredContent, undefined);
});

// ── The command algebra: the agent revises and retracts its OWN work ──────────
// Before this, the agent could only append. A proposal that overshot had to be
// deleted and re-derived from scratch; a sweep committed under the wrong
// condition meant N deletes. These are the two verbs that close that gap.

test("edit_shape: moves geometry, reassigns, flips role — and re-measures every time", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });

  const square = [[100, 100], [300, 100], [300, 300], [100, 300]];
  const made = await call(client, "measure_polygon", { sheet: KEY, verts: square, condition: "CPT-1" });
  assert.equal(made.isError, false);
  const id = made.data.shape_id;
  const area0 = made.data.area_sf;
  assert.ok(area0 > 0);

  // Geometry: half the width => half the area, recomputed server-side.
  const moved = await call(client, "edit_shape", { shape_id: id, verts: [[100, 100], [200, 100], [200, 300], [100, 300]] });
  assert.equal(moved.isError, false);
  assert.deepEqual(moved.data.changed, ["verts"]);
  assert.ok(Math.abs(moved.data.area_sf - area0 / 2) < 0.01, `half area: ${moved.data.area_sf} vs ${area0 / 2}`);
  assert.equal(moved.data.agent_edits, 1);

  // Reassign: the shape moves to a second condition, and the totals follow.
  const reassigned = await call(client, "edit_shape", { shape_id: id, condition: "VCT-2" });
  assert.equal(reassigned.isError, false);
  assert.deepEqual(reassigned.data.changed, ["condition"]);
  assert.equal(reassigned.data.agent_edits, 2);
  const summary = await call(client, "takeoff_summary");
  const byTag = Object.fromEntries(summary.data.conditions.map((c: any) => [c.finish_tag, c.shape_count]));
  assert.equal(byTag["CPT-1"], 0, "left the old condition");
  assert.equal(byTag["VCT-2"], 1, "landed on the new one");

  // Role flip alone re-measures: a closed ring read as an open polyline.
  const linear = await call(client, "edit_shape", { shape_id: id, role: "linear" });
  assert.equal(linear.isError, false);
  assert.equal(linear.data.measure_role, "linear");
  assert.equal(linear.data.area_sf, 0, "a linear shape carries no area");
  assert.ok(linear.data.perimeter_lf > 0);

  // Provenance: agent self-revision never touches the human-correction fields.
  const payload = await call(client, "export_takeoff");
  const shape = payload.data.shapes.find((s: any) => s.id === id);
  assert.equal(shape.origin.agent_edits, 3);
  assert.equal(shape.origin.edited, undefined, "agent self-revision is not a human correction");
  assert.equal(shape.origin.edits, undefined);
  assert.equal(shape.origin.proposed_verts_norm, undefined, "nothing froze — no human has reviewed this");
});

test("edit_shape refusals: unknown id, empty patch, too few verts, and human ink", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });
  const made = await call(client, "measure_polygon", {
    sheet: KEY, verts: [[100, 100], [300, 100], [300, 300]], condition: "CPT-1",
  });
  const id = made.data.shape_id;

  const unknown = await call(client, "edit_shape", { shape_id: "shp-nope", verts: [[0, 0], [1, 0], [1, 1]] });
  assert.equal(unknown.isError, true);
  assert.match(unknown.data.error, /No shape with id/);

  const empty = await call(client, "edit_shape", { shape_id: id });
  assert.equal(empty.isError, true);
  assert.match(empty.data.error, /at least one of verts, condition, role/);

  const thin = await call(client, "edit_shape", { shape_id: id, verts: [[0, 0], [10, 10]] });
  assert.equal(thin.isError, true);
  assert.match(thin.data.error, /at least 3 vertices/);

  // The review gate is absolute: reviewed work is ink and no agent verb touches
  // it. This server never sets the flag, so it is set directly here — the guard
  // is the contract that makes this surface safe to port to a host that has a
  // real review gate.
  const session = new Session();
  await session.loadPlan(PLAN);
  session.setScale(KEY, { use_detected: true });
  const inkId = session.measurePolygon(KEY, [[100, 100], [300, 100], [300, 300]], { role: "floor_area", condition: "CPT-1" }).shape_id!;
  session.shapes.find((s) => s.id === inkId)!.origin!.reviewed = true;
  assert.throws(() => session.editShape(inkId, { condition: "VCT-2" }), /affirmed by a human/);
});

test("undo_last: a sweep is one step, an edit restores verbatim, a delete comes back", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });

  // A whole detect_rooms sweep undoes as ONE gesture, not four.
  const sweep = await call(client, "detect_rooms", { sheet: KEY, condition: "CPT-1" });
  assert.equal(sweep.data.detected, 4);
  const back = await call(client, "undo_last", { n: 1 });
  assert.equal(back.isError, false);
  assert.equal(back.data.undone, 1);
  assert.equal(back.data.steps[0].op, "commit");
  assert.equal(back.data.steps[0].tool, "detect_rooms");
  assert.equal(back.data.steps[0].shapes, 4, "the sweep's four rooms, one step");
  assert.equal(back.data.shape_count, 0);

  // An edit restores the pre-edit shape verbatim.
  const made = await call(client, "measure_polygon", {
    sheet: KEY, verts: [[100, 100], [300, 100], [300, 300], [100, 300]], condition: "CPT-1",
  });
  const id = made.data.shape_id;
  const area0 = made.data.area_sf;
  await call(client, "edit_shape", { shape_id: id, verts: [[100, 100], [200, 100], [200, 300], [100, 300]] });
  const undoEdit = await call(client, "undo_last", { n: 1 });
  assert.equal(undoEdit.data.steps[0].op, "edit");
  const restored = (await call(client, "export_takeoff")).data.shapes.find((s: any) => s.id === id);
  assert.ok(Math.abs(restored.computed.area_sf - area0) < 0.01, "geometry is back to the original");

  // A delete comes back where it was.
  await call(client, "delete_shape", { shape_id: id });
  assert.equal((await call(client, "takeoff_summary")).data.conditions[0].shape_count, 0);
  const undoDelete = await call(client, "undo_last", { n: 1 });
  assert.equal(undoDelete.data.steps[0].op, "delete");
  assert.equal(undoDelete.data.shape_count, 1);

  // Running past the end is honest, not an error.
  const past = await call(client, "undo_last", { n: 50 });
  assert.equal(past.isError, false);
  assert.ok(past.data.undone < 50);
  assert.match(past.data.note, /Only \d+ step/);
  assert.equal(past.data.remaining, 0);
});

test("undo_last: reads are never journaled, and load_plan clears the history", async () => {
  const client = await pair();
  await call(client, "load_plan", { path: PLAN });
  await call(client, "set_scale", { sheet: KEY, use_detected: true });
  await call(client, "measure_polygon", { sheet: KEY, verts: [[100, 100], [300, 100], [300, 300]], condition: "CPT-1" });

  // Look at the sheet, measure without committing, read text — none of it is a
  // gesture, so undo still steps over the one thing that actually changed state.
  await call(client, "read_sheet_text", { sheet: KEY });
  await call(client, "measure_polygon", { sheet: KEY, verts: [[10, 10], [20, 10], [20, 20]] });
  await call(client, "sheet_info", { sheet: KEY });
  const back = await call(client, "undo_last", { n: 1 });
  assert.equal(back.data.undone, 1);
  assert.equal(back.data.shape_count, 0, "the committed shape, not a read");
  assert.equal(back.data.remaining, 0, "the reads left no steps behind");

  // A new document invalidates every id the journal refers to.
  await call(client, "measure_polygon", { sheet: KEY, verts: [[100, 100], [300, 100], [300, 300]], condition: "CPT-1" });
  await call(client, "load_plan", { path: PLAN });
  const afterLoad = await call(client, "undo_last", { n: 1 });
  assert.equal(afterLoad.data.undone, 0, "history goes with the document it described");
  assert.equal(afterLoad.data.remaining, 0);
});
