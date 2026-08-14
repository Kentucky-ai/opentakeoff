// Staged tool exposure (#230). Default builds keep the flat forty with no
// open_tool_stage; staged builds start at setup + the opener and grow a stage
// at a time. The stage table itself must partition the registered set exactly,
// so a new tool that skips the table fails here instead of landing stageless.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";
import { TOOL_STAGES } from "../src/staging.ts";

const PLAN = fileURLToPath(new URL("../../demo/sample-plan.pdf", import.meta.url));
const KEY = "sample-plan.pdf";

const connect = async (staged: boolean) => {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer(new Session(), { stagedTools: staged }).connect(st);
  const client = new Client({ name: "staging-test", version: "0.0.0" });
  await client.connect(ct);
  return client;
};

const toolNames = async (client: Client) =>
  new Set((await client.listTools()).tools.map((t) => t.name));

test("staging: default build is the flat forty — no opener, nothing disabled", async () => {
  const names = await toolNames(await connect(false));
  assert.equal(names.size, 40);
  assert.ok(!names.has("open_tool_stage"));
  for (const stage of Object.values(TOOL_STAGES)) for (const n of stage) assert.ok(names.has(n), n);
});

test("staging: the stage table partitions the registered set exactly", async () => {
  const flat = Object.values(TOOL_STAGES).flat();
  assert.equal(flat.length, new Set(flat).size, "no tool sits in two stages");
  const names = await toolNames(await connect(false));
  assert.deepEqual(new Set(flat), names, "every registered tool has a stage, and no stage names a ghost");
});

test("staging: setup-only at start, open_tool_stage grows the surface, idempotent", async () => {
  const client = await connect(true);

  const initial = await toolNames(client);
  assert.deepEqual(initial, new Set([...TOOL_STAGES.setup, "open_tool_stage"]));

  // setup tools work before any stage is opened
  const loaded: any = await client.callTool({ name: "load_plan", arguments: { path: PLAN } });
  assert.ok(!loaded.isError, "setup stage is live at start");

  // a closed stage's tool is refused
  const closed: any = await client.callTool({ name: "one_click", arguments: { sheet: KEY, x: 600, y: 1084 } });
  assert.ok(closed.isError, "measure is closed until opened");

  // open measure: the reply names what appeared, and the tool now lists + runs
  const open: any = await client.callTool({ name: "open_tool_stage", arguments: { stage: "measure" } });
  assert.ok(!open.isError);
  const opened = JSON.parse(open.content[0].text);
  assert.deepEqual(new Set(opened.enabled), new Set(TOOL_STAGES.measure));
  assert.deepEqual(opened.open_stages, ["setup", "measure"]);
  assert.deepEqual(opened.closed_stages, ["revise", "handoff"]);
  const afterMeasure = await toolNames(client);
  assert.deepEqual(afterMeasure, new Set([...TOOL_STAGES.setup, ...TOOL_STAGES.measure, "open_tool_stage"]));

  // re-open is a no-op, not an error
  const again: any = await client.callTool({ name: "open_tool_stage", arguments: { stage: "measure" } });
  assert.ok(!again.isError);
  assert.deepEqual(JSON.parse(again.content[0].text).enabled, []);

  // open the rest: the full forty-one, nothing ever closes
  await client.callTool({ name: "open_tool_stage", arguments: { stage: "revise" } });
  await client.callTool({ name: "open_tool_stage", arguments: { stage: "handoff" } });
  const all = await toolNames(client);
  assert.equal(all.size, 41);

  // an unknown stage is a validation refusal, not a crash
  const bad: any = await client.callTool({ name: "open_tool_stage", arguments: { stage: "cleanup" } });
  assert.ok(bad.isError);
});

test("staging: staged instructions ride initialize only when the flag is on", async () => {
  const flat = await connect(false);
  const staged = await connect(true);
  assert.ok(!flat.getInstructions()?.includes("TOOL EXPOSURE IS STAGED"));
  assert.ok(staged.getInstructions()?.includes("TOOL EXPOSURE IS STAGED"));
});
