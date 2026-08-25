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

test("staging: default build is the flat forty-two — no opener, nothing disabled", async () => {
  const names = await toolNames(await connect(false));
  assert.equal(names.size, 42);
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

  // open the rest: the full forty-two, nothing ever closes
  await client.callTool({ name: "open_tool_stage", arguments: { stage: "revise" } });
  await client.callTool({ name: "open_tool_stage", arguments: { stage: "handoff" } });
  const all = await toolNames(client);
  assert.equal(all.size, 43);

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

// A REFUSAL NAMES THE NEXT MOVE — the rule this server keeps everywhere else,
// and the one place staging used to break it. The bare SDK string
// ("Tool one_click disabled") tells a model nothing it can act on: no stage, no
// opener. A model that got the tool name from the docs rather than tools/list
// has nowhere to go, and it reads as a broken product.
test("staging: a closed tool's refusal names its stage and the call that opens it", async () => {
  const client = await connect(true);

  for (const [tool, stage] of [["one_click", "measure"], ["edit_shape", "revise"], ["export_marked_pdf", "handoff"]] as const) {
    const r = await client.callTool({ name: tool, arguments: {} }) as { isError?: boolean; content: { text: string }[] };
    assert.ok(r.isError, `${tool} must refuse while ${stage} is closed`);
    const text = r.content[0].text;
    assert.match(text, new RegExp(`"${stage}"`), `${tool}: the refusal must name its stage`);
    assert.match(text, /open_tool_stage/, `${tool}: the refusal must name the opener`);
    assert.match(text, new RegExp(tool), `${tool}: the refusal must name the tool to retry`);
  }

  // ...and nothing else is rewritten. An unknown tool is still unknown, and an
  // OPEN tool's own validation refusal is its own.
  const unknown = await client.callTool({ name: "no_such_tool", arguments: {} }) as { content: { text: string }[] };
  assert.match(unknown.content[0].text, /not found/);
  assert.doesNotMatch(unknown.content[0].text, /open_tool_stage/);

  const setupTool = await client.callTool({ name: "load_plan", arguments: {} }) as { content: { text: string }[] };
  assert.doesNotMatch(setupTool.content[0].text, /open_tool_stage/, "an enabled tool's refusal is untouched");

  // once the stage is open the tool runs and answers for itself
  await client.callTool({ name: "open_tool_stage", arguments: { stage: "measure" } });
  const after = await client.callTool({ name: "one_click", arguments: { sheet: KEY, x: 600, y: 1084 } }) as { content: { text: string }[] };
  assert.doesNotMatch(after.content[0].text, /not open yet/, "the tool must actually work after its stage opens");
});

// The flat build has no stages, so nothing may be rewritten there either.
test("staging: the flat build's refusals are untouched", async () => {
  const client = await connect(false);
  const r = await client.callTool({ name: "one_click", arguments: {} }) as { content: { text: string }[] };
  assert.doesNotMatch(r.content[0].text, /open_tool_stage/);
});
