// #230 — staged tool exposure, opt-in via OPENTAKEOFF_MCP_STAGED_TOOLS. The
// default (env unset) must stay exactly the flat 40; the staged mode holds
// three groups back until open_tool_stage enables them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";
import { STAGED_TOOLS_ENV, SETUP_STAGE_TOOLS, TOOL_STAGES } from "../src/toolStages.ts";

async function pair(): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildServer(new Session());
  await server.connect(st);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(ct);
  return client;
}

async function withEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env[STAGED_TOOLS_ENV];
  if (value === undefined) delete process.env[STAGED_TOOLS_ENV];
  else process.env[STAGED_TOOLS_ENV] = value;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env[STAGED_TOOLS_ENV];
    else process.env[STAGED_TOOLS_ENV] = prior;
  }
}

test("default (env unset): all forty tools present, no open_tool_stage", async () => {
  await withEnv(undefined, async () => {
    const client = await pair();
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    assert.equal(names.size, 40, `expected 40 tools, got ${names.size}`);
    assert.ok(!names.has("open_tool_stage"), "opener tool should not exist when staging is off");
    for (const stage of TOOL_STAGES) {
      for (const name of stage.tools) assert.ok(names.has(name), `${name} missing from the default (unstaged) list`);
    }
  });
});

test("staged: only setup + the opener are visible at connect", async () => {
  await withEnv("1", async () => {
    const client = await pair();
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    assert.equal(names.size, SETUP_STAGE_TOOLS.length + 1, "setup tools + open_tool_stage only");
    for (const name of SETUP_STAGE_TOOLS) assert.ok(names.has(name), `${name} should be enabled at connect`);
    assert.ok(names.has("open_tool_stage"));
    for (const stage of TOOL_STAGES) {
      for (const name of stage.tools) assert.ok(!names.has(name), `${name} should start disabled`);
    }
  });
});

test("staged: open_tool_stage enables exactly its group, idempotently", async () => {
  await withEnv("1", async () => {
    const client = await pair();
    const first = await client.callTool({ name: "open_tool_stage", arguments: { stage: "measure" } });
    const firstBody = JSON.parse((first.content as any)[0].text);
    assert.equal(firstBody.already_open, false);
    assert.deepEqual(new Set(firstBody.opened_tools), new Set(TOOL_STAGES.find((s) => s.key === "measure")!.tools));

    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    assert.ok(names.has("one_click"), "measure-stage tool should now be visible");
    assert.ok(!names.has("edit_shape"), "revise-stage tool should still be held back");

    const second = await client.callTool({ name: "open_tool_stage", arguments: { stage: "measure" } });
    const secondBody = JSON.parse((second.content as any)[0].text);
    assert.equal(secondBody.already_open, true, "re-opening an open stage is a no-op, not an error");
  });
});

test("staged: an unknown stage is refused, mints nothing", async () => {
  await withEnv("1", async () => {
    const client = await pair();
    const res = await client.callTool({ name: "open_tool_stage", arguments: { stage: "bogus" } });
    assert.equal(res.isError, true, "an out-of-enum stage must not silently no-op");
  });
});
