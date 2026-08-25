import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const child = spawn(process.execPath, ["dist/server.js"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
const responses = new Map();
const pending = new Map();

const timeout = setTimeout(() => {
  child.kill();
  throw new Error(`Timed out waiting for dist/server.js smoke responses. stderr:\n${stderr}`);
}, 10_000);
timeout.unref();

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  let newline;
  while ((newline = stdout.indexOf("\n")) !== -1) {
    const line = stdout.slice(0, newline).replace(/\r$/, "");
    stdout = stdout.slice(newline + 1);
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      throw new Error(`Non-JSON stdout from dist/server.js: ${JSON.stringify(line)}`, { cause: error });
    }

    if (message.id !== undefined) {
      responses.set(message.id, message);
      pending.get(message.id)?.();
    }
  }
});

child.once("exit", (code, signal) => {
  for (const resolve of pending.values()) resolve();
  if (code !== null && code !== 0) {
    throw new Error(`dist/server.js exited early with code ${code}. stderr:\n${stderr}`);
  }
  if (signal) {
    throw new Error(`dist/server.js exited early from signal ${signal}. stderr:\n${stderr}`);
  }
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function responseFor(id) {
  if (!responses.has(id)) {
    await new Promise((resolve) => pending.set(id, resolve));
    pending.delete(id);
  }
  const response = responses.get(id);
  assert.ok(response, `missing response for request ${id}`);
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.error, undefined, `request ${id} failed: ${JSON.stringify(response.error)}`);
  return response.result;
}

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "opentakeoff-dist-smoke", version: "0.0.0" },
  },
});

const initialized = await responseFor(1);
assert.equal(initialized.serverInfo.name, "opentakeoff");

send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

const listed = await responseFor(2);
const names = listed.tools.map((tool) => tool.name).sort();
assert.deepEqual(names, [
  "annotate",
  "apply_rules",
  "count_marks",
  "cut_out",
  "delete_shape",
  "delete_verdict",
  "derive_base",
  "derive_transitions",
  "detect_rooms",
  "duplicate_condition",
  "edit_condition",
  "edit_materials",
  "edit_shape", "export_dxf",
  "export_marked_pdf",
  "export_report",
  "export_takeoff",
  "find_schedule",
  "find_text",
  "import_takeoff",
  "link_annotation",
  "list_annotations",
  "list_shapes",
  "load_plan",
  "mark_verdict",
  "measure_line",
  "measure_polygon",
  "measure_surface",
  "one_click",
  "place_count",
  "read_sheet_text",
  "resolve_tag",
  "set_scale",
  "sheet_context",
  "sheet_graph",
  "sheet_info",
  "split_condition",
  "sweep_schedule_row",
  "symbol_sweep",
  "takeoff_summary",
  "undo_last",
  "view_sheet",
]);

child.stdin.end();
await once(child, "close");
clearTimeout(timeout);

assert.equal(stdout.trim(), "", `leftover partial stdout frame: ${JSON.stringify(stdout)}`);
