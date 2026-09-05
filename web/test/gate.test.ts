// The TEMPORARY One-Click gate on the browser surfaces (src/lib/gate.js).
// Default: the in-app agent's tool list has no one_click, propose_shapes stops
// describing engine rings, executing one_click refuses with the shared
// sentence, the system prompt carries the gate. Lifted at runtime through
// globalThis.__OT_ONE_CLICK: the full registry comes back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { oneClickEnabled, ONE_CLICK_GATE_MESSAGE, commandBoxEnabled } from "../src/lib/gate.js";
import { AGENT_TOOL_DEFS, agentToolDefs, executeAgentTool } from "../src/lib/agentTools.js";
import { agentSystemPrompt } from "../src/lib/agentLoop.js";

const withGate = async (up: boolean, fn: () => Promise<void> | void) => {
  const prev = (globalThis as any).__OT_ONE_CLICK;
  (globalThis as any).__OT_ONE_CLICK = up ? undefined : true;
  try { await fn(); } finally { (globalThis as any).__OT_ONE_CLICK = prev; }
};

test("gate: up by default outside Vite — no env, no global", async () => {
  await withGate(true, () => { assert.equal(oneClickEnabled(), false); });
  await withGate(false, () => { assert.equal(oneClickEnabled(), true); });
});

test("gate up: the agent surface has no one_click and does not describe its rings", async () => {
  await withGate(true, () => {
    const defs = agentToolDefs();
    assert.ok(!defs.some((d) => d.name === "one_click"));
    assert.equal(defs.length, AGENT_TOOL_DEFS.length - 1);
    for (const d of defs) assert.ok(!/one_click/.test(d.description), `${d.name} still names one_click`);
    assert.match(agentSystemPrompt(), /temporarily gated/);
    assert.ok(!/measure rooms with one_click/.test(agentSystemPrompt()));
  });
});

test("gate up: executing one_click refuses with the shared sentence, nothing else changes", async () => {
  await withGate(true, async () => {
    const out: any = await executeAgentTool({} as any, "one_click", { sheet: "plan.pdf", x: 0.5, y: 0.5 });
    assert.equal(out.error, ONE_CLICK_GATE_MESSAGE);
    const unknown: any = await executeAgentTool({} as any, "nope", {});
    assert.ok(!/one_click/.test(unknown.error), "the available-tools list does not advertise the gated verb");
  });
});

test("gate lifted: the full registry and the engine prompt come back", async () => {
  await withGate(false, () => {
    assert.deepEqual(agentToolDefs(), AGENT_TOOL_DEFS);
    assert.match(agentSystemPrompt(), /measure rooms with one_click/);
  });
});

test("command box / voice gate: off by default, runtime global lifts it", () => {
  const prev = (globalThis as any).__OT_COMMAND_BOX;
  try {
    (globalThis as any).__OT_COMMAND_BOX = undefined;
    assert.equal(commandBoxEnabled(), false);
    (globalThis as any).__OT_COMMAND_BOX = true;
    assert.equal(commandBoxEnabled(), true);
  } finally { (globalThis as any).__OT_COMMAND_BOX = prev; }
});
