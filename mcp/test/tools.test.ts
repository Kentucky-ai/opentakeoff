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

test("tools/list: all ten tools, each described with the coordinate contract", async () => {
  const client = await pair();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "delete_shape", "export_takeoff", "load_plan", "measure_line", "measure_polygon",
    "one_click", "read_sheet_text", "set_scale", "sheet_info", "takeoff_summary",
  ]);
  for (const t of tools) assert.match(t.description || "", /image px at render scale 2\.0/, `${t.name} carries the coordinate contract`);
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

test("output contract: every tool declares outputSchema; structuredContent mirrors the text item", async () => {
  const client = await pair();
  const { tools } = await client.listTools();
  for (const t of tools) {
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
