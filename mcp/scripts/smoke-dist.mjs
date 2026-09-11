import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { TOOL_NAMES, TOOL_STAGES } from "../src/staging.ts";
import { WIKI_PAGES, WIKI_VERSION } from "../src/wiki.generated.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaSpecs = [
  ["legacy", "takeoff-canvas.v1.schema.json"], ["v1", "calibration.schema.json"],
  ["v1", "common.schema.json"], ["v1", "condition.schema.json"],
  ["v1", "document-fields.schema.json"], ["v1", "evidence.schema.json"],
  ["v1", "measurement.schema.json"], ["v1", "provenance.schema.json"],
  ["v1", "review.schema.json"], ["v1", "stitch.schema.json"],
  ["v1", "takeoff-document.schema.json"],
];
const schemaUri = ([family, name]) => `takeoff://protocol/${family}/${name}`;
const protocolDir = resolve(packageDir, "../protocol");
const schemaExpected = new Map();
for (const [family, name] of schemaSpecs) {
  const raw = readFileSync(resolve(protocolDir, family, name), "utf8");
  const text = `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
  schemaExpected.set(schemaUri([family, name]), { text, sha256: createHash("sha256").update(text).digest("hex") });
}

function send(child, message) { child.stdin.write(`${JSON.stringify(message)}\n`); }

async function runSmoke(root, staged) {
  const child = spawn(process.execPath, [resolve(root, "dist/server.js")], {
    cwd: root, env: { ...process.env, OPENTAKEOFF_MCP_STAGED_TOOLS: staged ? "1" : "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  const responses = new Map(); const waiters = new Map();
  let failureReject;
  let expectClose = false;
  const failure = new Promise((_, reject) => { failureReject = reject; });
  // Every failure path shares one rejection so pending request waits and the
  // final close wait are bounded by the same cleanup/diagnostic path.
  failure.catch(() => {});
  const fail = (error) => {
    failureReject?.(error instanceof Error ? error : new Error(String(error)));
    if (!expectClose && child.exitCode === null && !child.killed) child.kill();
  };
  const timeout = setTimeout(() => fail(new Error(`Timed out waiting for ${staged ? "staged" : "flat"} dist smoke; stderr:\n${stderr}`)), 30_000);
  child.once("error", (error) => fail(error));
  child.once("close", (code, signal) => {
    if (!expectClose) fail(new Error(`Distribution server exited before smoke completed (code ${code}, signal ${signal}); stderr:\n${stderr}`));
  });
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf("\n")) !== -1) {
      const line = stdout.slice(0, newline).replace(/\r$/, ""); stdout = stdout.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined) { responses.set(message.id, message); waiters.get(message.id)?.(); }
      } catch (error) {
        fail(new Error(`Invalid JSON-RPC stdout from distribution server: ${error instanceof Error ? error.message : String(error)}; line=${JSON.stringify(line)}`));
      }
    }
  });
  const responseFor = async (id) => {
    if (!responses.has(id)) await Promise.race([new Promise((done) => waiters.set(id, done)), failure]);
    waiters.delete(id);
    const response = responses.get(id);
    assert.ok(response, `missing response for request ${id}`);
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.error, undefined, `request ${id} failed: ${JSON.stringify(response.error)}\nstderr: ${stderr}`);
    return response.result;
  };
  try {
    send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "opentakeoff-dist-smoke", version: "0.0.0" } } });
    const initialized = await responseFor(1); assert.equal(initialized.serverInfo.name, "opentakeoff");
    send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await responseFor(2);
    const names = listed.tools.map((tool) => tool.name).sort();
    const expectedTools = staged ? [...TOOL_STAGES.setup, "open_tool_stage"].sort() : [...TOOL_NAMES];
    assert.deepEqual(names, expectedTools, `${staged ? "staged" : "flat"} tool surface`);
    send(child, { jsonrpc: "2.0", id: 3, method: "resources/list", params: {} });
    const resources = (await responseFor(3)).resources;
    assert.ok(resources.some((resource) => resource.uri === "takeoff://protocol"));
    assert.deepEqual(schemaSpecs.map(schemaUri).filter((uri) => !resources.some((resource) => resource.uri === uri)), []);
    let requestId = 4;
    for (const page of WIKI_PAGES) {
      send(child, { jsonrpc: "2.0", id: requestId, method: "resources/read", params: { uri: page.uri } });
      const read = await responseFor(requestId++);
      assert.equal(read.contents[0].mimeType, "text/markdown"); assert.ok(read.contents[0].text.includes(page.text)); assert.ok(read.contents[0].text.includes(WIKI_VERSION));
    }
    send(child, { jsonrpc: "2.0", id: requestId, method: "resources/read", params: { uri: "takeoff://protocol" } });
    const index = await responseFor(requestId++); assert.equal(index.contents[0].mimeType, "application/json");
    assert.equal(JSON.parse(index.contents[0].text).resources.length, schemaSpecs.length);
    for (const uri of schemaSpecs.map(schemaUri)) {
      send(child, { jsonrpc: "2.0", id: requestId, method: "resources/read", params: { uri } });
      const read = await responseFor(requestId++); const expected = schemaExpected.get(uri);
      assert.equal(read.contents[0].mimeType, "application/schema+json", uri); assert.equal(read.contents[0].text, expected.text, `packaged schema ${uri}`); assert.equal(createHash("sha256").update(read.contents[0].text).digest("hex"), expected.sha256);
    }
    expectClose = true;
    child.stdin.end();
    await Promise.race([once(child, "close"), failure]);
    assert.equal(child.exitCode, 0, `dist server exited; stderr:\n${stderr}`); assert.equal(stdout.trim(), "", `leftover partial stdout frame: ${JSON.stringify(stdout)}`);
    return { tools: names.length, schemas: schemaSpecs.length, wiki: WIKI_PAGES.length };
  } finally {
    clearTimeout(timeout);
    for (const waiter of waiters.values()) waiter();
    waiters.clear();
    if (child.exitCode === null && !child.killed) child.kill();
    if (!child.stdin.destroyed) child.stdin.destroy();
  }
}

const sourceDist = resolve(packageDir, "dist");
const suppliedRoot = process.argv[2] === "--root" ? resolve(process.argv[3]) : null;
const root = suppliedRoot ?? mkdtempSync(resolve(tmpdir(), "opentakeoff-dist-smoke-"));
try {
  if (!suppliedRoot) {
    cpSync(sourceDist, resolve(root, "dist"), { recursive: true }); cpSync(resolve(packageDir, "package.json"), resolve(root, "package.json"));
    symlinkSync(resolve(packageDir, "node_modules"), resolve(root, "node_modules"), "junction");
  }
  const flat = await runSmoke(root, false); const staged = await runSmoke(root, true);
  console.log(`Distribution smoke: flat ${flat.tools} tools, staged ${staged.tools} tools, ${flat.schemas} protocol schemas, ${flat.wiki} wiki pages verified over stdio from ${root}.`);
} finally { if (!suppliedRoot) rmSync(root, { recursive: true, force: true }); }
