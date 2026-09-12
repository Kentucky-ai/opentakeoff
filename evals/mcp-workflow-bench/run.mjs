import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { scoreCandidate } from "./score.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const requireFromMcp = createRequire(resolve(root, "mcp/package.json"));
const { Client } = requireFromMcp("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = requireFromMcp("@modelcontextprotocol/sdk/client/stdio.js");

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = resolve(outAt >= 0 ? args[outAt + 1] : resolve(here, "out"));
const referenceAt = args.indexOf("--reference");
// --reference accepts an absolute path or a repo-root-relative path; default is the sibling reference.json.
const referencePath = referenceAt >= 0 ? resolve(root, args[referenceAt + 1]) : resolve(here, "reference.json");
const referenceRelPath = relative(root, referencePath);
const reference = JSON.parse(readFileSync(referencePath, "utf8"));
const plan = resolve(root, reference.source.path);
const planHash = createHash("sha256").update(readFileSync(plan)).digest("hex");
if (planHash !== reference.source.sha256) throw new Error(`fixture hash changed: expected ${reference.source.sha256}, got ${planHash}`);
// Sheet id as load_plan reports it: the bare file name unless the reference names a page beyond the first.
const sheetId = reference.source.page === undefined || reference.source.page === 1
  ? basename(reference.source.path)
  : `${basename(reference.source.path)}#${reference.source.page}`;

// "estimator-trace" references describe a real plan traced to wall faces; everything else is the synthetic analytic fixture.
const estimatorTrace = reference.profile === "estimator-trace";

if (existsSync(out)) throw new Error(`${out} already exists; choose a new --out directory`);
mkdirSync(out, { recursive: true });
const serverPath = resolve(root, "mcp/dist/server.js");
if (!existsSync(serverPath)) throw new Error("mcp/dist/server.js is missing; run npm run build --prefix mcp first");
const timeoutMs = 30_000;
const closeTimeoutMs = 5_000;

function parseResult(response) {
  if (response?.structuredContent !== undefined) return response.structuredContent;
  const text = response?.content?.find((part) => part.type === "text")?.text;
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return text; }
}

function responseText(response) {
  return (response?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function externalizeImages(response, dir, label) {
  const safe = label.replaceAll(/[^a-zA-Z0-9_.-]+/g, "_");
  const content = (response?.content ?? []).map((part, index) => {
    if (part.type !== "image" || !part.data) return part;
    const artifact = resolve(dir, `${safe}-${index}.png`);
    writeFileSync(artifact, Buffer.from(part.data, "base64"));
    return { type: "image", mimeType: part.mimeType, artifact };
  });
  return response ? { ...response, content } : response;
}

function bounded(promise, label, milliseconds = timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function openClient(staged, dir) {
  const stderrChunks = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    env: { ...process.env, OPENTAKEOFF_ONE_CLICK: "0", OPENTAKEOFF_MCP_STAGED_TOOLS: staged ? "1" : "0" },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));
  const client = new Client({ name: "mcp-workflow-bench", version: "1.0.0" });
  const started = performance.now();
  try { await bounded(client.connect(transport), "MCP initialize"); }
  catch (error) { try { await bounded(transport.close(), "MCP transport cleanup", closeTimeoutMs); } catch {} throw error; }
  return {
    client,
    transport,
    connectedMs: performance.now() - started,
    stderrChunks,
    async close() {
      try { await bounded(client.close(), "MCP client close", closeTimeoutMs); } finally {
        try { await bounded(transport.close(), "MCP transport close", closeTimeoutMs); } catch { /* client close owns it */ }
        writeFileSync(resolve(dir, "stderr.log"), stderrChunks.join(""));
      }
    },
  };
}

function expectedProductRefusal(response, label, pattern) {
  if (response.transportError) throw new Error(`${label} transport failure was mistaken for a refusal: ${response.error}`);
  if (!response.isError) throw new Error(`${label} unexpectedly succeeded`);
  if (!pattern.test(responseText(response))) throw new Error(`${label} refusal did not contain ${pattern}: ${responseText(response)}`);
}

async function workflow(staged, dir) {
  const session = await openClient(staged, dir);
  const calls = [];
  const counts = new Map();
  const expectedRefusals = [];
  const stageOpens = [];
  let sequence = 0;
  const record = async (kind, params, action, expect = "success", refusalPattern) => {
    const started = performance.now();
    let response;
    let transportError = false;
    try { response = await bounded(action(), kind); }
    catch (error) {
      transportError = true;
      response = { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], error: error instanceof Error ? error.message : String(error) };
    }
    const elapsedMs = performance.now() - started;
    response.transportError = transportError;
    const failed = Boolean(response.isError);
    const safe = externalizeImages(response, dir, `${staged ? "staged" : "flat"}-${sequence}-${kind}`);
    const row = { kind, params, elapsed_ms: elapsedMs, isError: failed, transport_error: transportError, value: parseResult(response), response: safe };
    sequence += 1;
    calls.push(row);
    if (kind === "tools/call") {
      const name = params.name;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      if (expect === "product-refusal") expectedRefusals.push({ tool: name, reason: responseText(response) });
      if (name === "open_tool_stage") stageOpens.push(params.arguments.stage);
    }
    if (expect === "product-refusal") expectedProductRefusal(response, params.name, refusalPattern ?? /set_scale/);
    if (expect === "success" && (failed || transportError)) throw new Error(`${kind} failed: ${responseText(response)}`);
    return row;
  };
  const tool = (name, arguments_ = {}, expect = "success", refusalPattern) => record("tools/call", { name, arguments: arguments_ }, () => session.client.callTool({ name, arguments: arguments_ }, undefined, { timeout: timeoutMs }), expect, refusalPattern);
  try {
    const tools = await record("tools/list", {}, () => session.client.listTools());
    const resources = await record("resources/list", {}, () => session.client.listResources());
    const resourceRows = resources.value?.resources ?? resources.response?.resources ?? [];
    if (resourceRows[0]?.uri) await record("resources/read", { uri: resourceRows[0].uri }, () => session.client.readResource({ uri: resourceRows[0].uri }));
    if (staged) {
      const initialNames = new Set(tools.response?.tools?.map((tool) => tool.name) ?? []);
      if (initialNames.has("measure_polygon")) throw new Error("staged setup unexpectedly exposed measure_polygon");
      await tool("open_tool_stage", { stage: "measure" });
      const measuredTools = await record("tools/list", {}, () => session.client.listTools());
      if (!measuredTools.response?.tools?.some((tool) => tool.name === "measure_polygon")) throw new Error("opening measure stage did not expose measure_polygon");
    }
    const loaded = await tool("load_plan", { path: plan });
    const loadedSheetIds = (loaded.value?.sheets ?? []).map((entry) => entry.sheet);
    if (!loadedSheetIds.includes(sheetId)) throw new Error(`load_plan sheets ${JSON.stringify(loadedSheetIds)} do not include expected sheet ${sheetId}`);
    const sheet = sheetId;
    await tool("sheet_info", { sheet });
    await tool("read_sheet_text", { sheet });
    await tool("get_sheet_vectors", { sheet });
    await tool("view_sheet", { sheet, px: 1400 });
    await tool("measure_polygon", { sheet, verts: reference.rooms[0].verts_px, condition: "SYNTH-FLOOR", role: "floor_area" }, "product-refusal");
    await tool("set_scale", { sheet, upp: reference.scale.feet_per_image_px });
    await tool("propose_takeoff", estimatorTrace
      ? { label: `${reference.reference_id} known-answer run`, rationale: "Scripted conformance run of the frozen reference rings; tool/workflow conformance only, not an agent trace." }
      : { label: "Synthetic four-room wall-face areas", rationale: "Analytic inset wall faces from demo/sample-plan.pdf; scripted conformance fixture." });
    for (const room of reference.rooms) await tool("measure_polygon", { sheet, verts: room.verts_px, condition: room.finish ?? "SYNTH-FLOOR", role: "floor_area" });
    if (staged) {
      await tool("open_tool_stage", { stage: "revise" });
      await record("tools/list", {}, () => session.client.listTools());
    }
    const listed = await tool("list_shapes", { sheet });
    const shapeRows = listed.value?.shapes ?? [];
    if (shapeRows.length !== reference.rooms.length) throw new Error(`expected ${reference.rooms.length} committed shapes, got ${shapeRows.length}`);
    for (let i = 0; i < shapeRows.length; i += 1) await tool("edit_shape", { shape_id: shapeRows[i].id, label: reference.rooms[i].label });
    await tool("view_sheet", { sheet, overlay: true, px: 1400 });
    if (estimatorTrace) {
      // A real sheet renders far larger than the 1400px budget can show in one shot (St. Cloud is
      // 6048x4320 logical px), so also render a tight, reviewable crop over the traced rooms' bounding box.
      const roomVerts = reference.rooms.flatMap((room) => room.verts_px);
      const roomXs = roomVerts.map(([x]) => x);
      const roomYs = roomVerts.map(([, y]) => y);
      const cropPad = 40;
      const cropRegion = {
        x0: Math.max(0, Math.min(...roomXs) - cropPad),
        y0: Math.max(0, Math.min(...roomYs) - cropPad),
        x1: Math.max(...roomXs) + cropPad,
        y1: Math.max(...roomYs) + cropPad,
      };
      await tool("view_sheet", { sheet, region: cropRegion, overlay: true, px: 1400 });
    }
    const duplicates = await tool("scope_duplicates", { sheet });
    if ((duplicates.value?.collisions?.length ?? 0) || (duplicates.value?.duplicates?.length ?? 0) || duplicates.value?.shared_floor_sf !== 0) throw new Error("scope_duplicates reported overlap in clean fixture");
    if (staged) {
      await tool("open_tool_stage", { stage: "handoff" });
      await record("tools/list", {}, () => session.client.listTools());
    }
    await tool("takeoff_summary");
    await tool("export_report", { path: resolve(dir, "report.json"), project_name: "Synthetic MCP workflow benchmark", overwrite: true });
    await tool("export_marked_pdf", { path: resolve(dir, "marked.pdf"), project_name: "Synthetic MCP workflow benchmark", overwrite: true });
    await tool("export_takeoff", { path: resolve(dir, "export_takeoff.json"), overwrite: true });
    const exportPayload = JSON.parse(readFileSync(resolve(dir, "export_takeoff.json"), "utf8"));
    const report = JSON.parse(readFileSync(resolve(dir, "report.json"), "utf8"));
    const pdf = readFileSync(resolve(dir, "marked.pdf"));
    if (!report || Object.keys(report).length === 0) throw new Error("empty report export");
    if (pdf.length === 0 || pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("marked PDF is empty or missing PDF signature");
    if (exportPayload.shapes?.length !== reference.rooms.length) throw new Error(`editable export does not contain ${reference.rooms.length} shapes`);
    if (exportPayload.shapes.some((shape) => shape.origin?.actor !== "agent")) throw new Error("editable export has a non-agent shape");
    if (exportPayload.shapes.some((shape) => shape.origin?.reviewed !== false)) throw new Error("editable export has a non-agent-reviewed shape");
    if ((exportPayload.approvals ?? []).length !== 0) throw new Error("editable export unexpectedly contains human approvals");
    const conditionIds = new Set((exportPayload.conditions ?? []).map((condition) => condition.id));
    const proposalIds = new Set((exportPayload.proposals ?? []).map((proposal) => proposal.id));
    for (const shape of exportPayload.shapes) {
      if (!conditionIds.has(shape.condition_id)) throw new Error(`shape ${shape.id} references missing condition ${shape.condition_id}`);
      if (!proposalIds.has(shape.origin?.proposal_id)) throw new Error(`shape ${shape.id} references missing proposal ${shape.origin?.proposal_id}`);
    }
    const scored = scoreCandidate(exportPayload, reference);
    if (!scored.pass) throw new Error(`${staged ? "staged" : "flat"} export failed scorer: ${JSON.stringify(scored)}`);
    const serverVersion = session.client.getServerVersion?.() ?? null;
    const toolCalls = calls.filter((row) => row.kind === "tools/call").length;
    const nonToolRequests = calls.filter((row) => row.kind !== "tools/call").length + 1;
    return { connected_ms: session.connectedMs, protocol_requests: calls.length + 1, non_tool_requests: nonToolRequests, tool_calls: toolCalls, per_tool_counts: Object.fromEntries(counts), expected_refusals: expectedRefusals, stage_opens: stageOpens, tools: tools.response?.tools?.map((row) => row.name) ?? [], server_version: serverVersion, scorer: scored };
  } finally {
    try { await session.close(); }
    finally {
      writeFileSync(resolve(dir, "calls.json"), JSON.stringify(calls, null, 2));
      writeFileSync(resolve(dir, "timings.json"), JSON.stringify(calls.map(({ kind, params, elapsed_ms, transport_error }) => ({ kind, name: params.name, elapsed_ms, transport_error })), null, 2));
    }
  }
}

function canonicalExport(payload) {
  const strip = (value, keys) => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !keys.has(key)));
  return {
    schema: payload.schema,
    units: payload.units,
    sheets: (payload.sheets ?? []).map((sheet) => strip(sheet, new Set())).sort((a, b) => a.sheet_id.localeCompare(b.sheet_id)),
    conditions: (payload.conditions ?? []).map((condition) => strip(condition, new Set(["id", "created_at"]))).sort((a, b) => a.finish_tag.localeCompare(b.finish_tag)),
    shapes: (payload.shapes ?? []).map((shape) => ({ ...strip(shape, new Set(["id", "condition_id"])), origin: strip(shape.origin, new Set(["proposal_id", "created_at", "updated_at"])) })).sort((a, b) => a.label.localeCompare(b.label)),
    markups: payload.markups ?? [],
    proposals: (payload.proposals ?? []).map((proposal) => strip(proposal, new Set(["id", "created_at"]))).sort((a, b) => a.label.localeCompare(b.label)),
    approvals: (payload.approvals ?? []).map((approval) => strip(approval, new Set(["id", "shape_id", "created_at"]))),
  };
}

async function freshProcess(dir) {
  mkdirSync(dir, { recursive: true });
  const session = await openClient(false, dir);
  const calls = [];
  const request = async (name, arguments_) => {
    const started = performance.now();
    let response;
    try { response = await bounded(session.client.callTool({ name, arguments: arguments_ }, undefined, { timeout: timeoutMs }), `fresh ${name}`); }
    catch (error) { throw new Error(`fresh ${name} transport failure: ${error.message}`); }
    if (response.isError) throw new Error(`fresh ${name} failed: ${responseText(response)}`);
    calls.push({ kind: "tools/call", name, elapsed_ms: performance.now() - started, value: parseResult(response) });
    return response;
  };
  try {
    await request("load_plan", { path: plan });
    await request("import_takeoff", { path: resolve(out, "flat/export_takeoff.json") });
    await request("takeoff_summary", {});
    await request("export_takeoff", { path: resolve(dir, "export_takeoff.json"), overwrite: true });
    const original = JSON.parse(readFileSync(resolve(out, "flat/export_takeoff.json"), "utf8"));
    const roundtrip = JSON.parse(readFileSync(resolve(dir, "export_takeoff.json"), "utf8"));
    assert.deepStrictEqual(roundtrip, original, "fresh-process export changed payload fields");
    const preservation = { canonical_equal: true, exact_payload_equal: true, geometry: true, computed: true, provenance: true, review: true, scale: true, conditions: true, proposals: true, approvals: true };
    writeFileSync(resolve(out, "fresh-process.json"), JSON.stringify({ calls, preservation }, null, 2));
    return { protocol_requests: calls.length + 1, non_tool_requests: 1, tool_calls: calls.length, preservation };
  } finally { await session.close(); }
}

const runs = {};
for (const staged of [false, true]) {
  const dir = resolve(out, staged ? "staged" : "flat");
  mkdirSync(dir);
  runs[staged ? "staged" : "flat"] = await workflow(staged, dir);
}
const fresh = await freshProcess(resolve(out, "fresh-process"));
const flatExport = JSON.parse(readFileSync(resolve(out, "flat/export_takeoff.json"), "utf8"));
const stagedExport = JSON.parse(readFileSync(resolve(out, "staged/export_takeoff.json"), "utf8"));
const crossModeEqual = JSON.stringify(canonicalExport(flatExport)) === JSON.stringify(canonicalExport(stagedExport));
if (Object.values(runs).some((run) => run.scorer?.pass !== true) || !crossModeEqual || !fresh.preservation.canonical_equal) throw new Error("benchmark acceptance checks failed");
const summary = { benchmark: "scripted MCP workflow conformance", node_version: process.version, server_path: serverPath, reference_path: referenceRelPath, reference_id: reference.reference_id, source_sha256: planHash, analytic_reference: !estimatorTrace, independently_human_reviewed: reference.review?.human_reviewed === true, boundary: estimatorTrace
    ? "real-plan estimator-trace reference traced from PDF vectors by an agent, human review pending; a scripted known-answer run proves tool/workflow conformance only, not agent accuracy"
    : "synthetic analytic fixture; no claim of real-plan accuracy or human review", cross_mode_canonical_equal: crossModeEqual, runs, fresh_process: fresh };
writeFileSync(resolve(out, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ out, summary }, null, 2));
