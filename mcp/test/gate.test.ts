// The TEMPORARY One-Click gate (src/gate.ts). Two facts, both directions:
//   default build → one_click / detect_rooms are NOT registered (tools/list
//                   never names them, a call gets the SDK's unknown-tool
//                   error, the initialize instructions carry the gate note and
//                   point at measure_polygon instead), and no surviving tool
//                   description tells an agent to call a verb that is not there;
//   lifted build  → both verbs register, the note is gone, the surface is
//                   ALL_TOOL_NAMES — the bench and the parity tests run on this.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.ts";
import { Session } from "../src/session.ts";
import { TOOL_NAMES, ALL_TOOL_NAMES, stagesFor, TOOL_STAGES } from "../src/staging.ts";
import { GATED_TOOLS, GATE_NOTE, oneClickEnabled, ONE_CLICK_ENV } from "../src/gate.ts";

const connect = async (opts: { oneClick?: boolean; stagedTools?: boolean } = {}) => {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await buildServer(new Session(), opts).connect(st);
  const client = new Client({ name: "gate-test", version: "0.0.0" });
  await client.connect(ct);
  return client;
};

test("gate: a default build registers TOOL_NAMES — neither gated verb exists on the wire", async () => {
  const client = await connect({ oneClick: false });
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...TOOL_NAMES]);
  for (const g of GATED_TOOLS) assert.ok(!names.includes(g), `${g} must not be listed while the gate is up`);
  assert.equal(TOOL_NAMES.length, ALL_TOOL_NAMES.length - GATED_TOOLS.length);

  // no surviving description sends an agent to a verb that is not there
  for (const t of tools) {
    for (const g of GATED_TOOLS) assert.ok(!(t.description || "").includes(g), `${t.name} description still names ${g}`);
  }

  // the instructions say so, name the move, and do not describe the gated verbs as usable
  const instructions = client.getInstructions() || "";
  assert.ok(instructions.includes(GATE_NOTE), "initialize instructions carry the gate note");
  assert.match(instructions, /measure_polygon/);
  assert.ok(!/one_click \/ detect_rooms \/ measure_polygon/.test(instructions), "standard finish no longer lists the gated verbs");

  // calling one anyway is the SDK's unknown-tool refusal, not a crash
  const res: any = await client.callTool({ name: "one_click", arguments: { sheet: "x", x: 1, y: 1 } });
  assert.ok(res.isError, "one_click is refused as unknown");
});

test("gate: the lifted build registers ALL_TOOL_NAMES and drops the note", async () => {
  const client = await connect({ oneClick: true });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...ALL_TOOL_NAMES]);
  for (const g of GATED_TOOLS) assert.ok(tools.some((t) => t.name === g), g);
  const instructions = client.getInstructions() || "";
  assert.ok(!instructions.includes(GATE_NOTE));
  assert.match(instructions, /one_click \/ detect_rooms \/ measure_polygon/);
});

test("gate: staged exposure under the gate opens measure without the gated verbs", async () => {
  const client = await connect({ oneClick: false, stagedTools: true });
  const open: any = await client.callTool({ name: "open_tool_stage", arguments: { stage: "measure" } });
  assert.ok(!open.isError);
  const enabled: string[] = JSON.parse(open.content[0].text).enabled;
  assert.deepEqual(new Set(enabled), new Set(stagesFor(false).measure));
  for (const g of GATED_TOOLS) assert.ok(!enabled.includes(g), g);
  // the full table still holds them for the lifted build
  for (const g of GATED_TOOLS) assert.ok(TOOL_STAGES.measure.includes(g), g);
});

test("gate: the env flag lifts it, an explicit option wins over the env", () => {
  const prev = process.env[ONE_CLICK_ENV];
  try {
    delete process.env[ONE_CLICK_ENV];
    assert.equal(oneClickEnabled(), false);
    process.env[ONE_CLICK_ENV] = "1";
    assert.equal(oneClickEnabled(), true);
    assert.equal(oneClickEnabled(false), false);
    delete process.env[ONE_CLICK_ENV];
    assert.equal(oneClickEnabled(true), true);
  } finally {
    if (prev === undefined) delete process.env[ONE_CLICK_ENV]; else process.env[ONE_CLICK_ENV] = prev;
  }
});
