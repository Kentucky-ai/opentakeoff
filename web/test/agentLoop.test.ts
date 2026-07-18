// Agent loop (lib/agentLoop.js) against a MOCK provider — a fake fetch scripts
// the model's turns, so these exercise the real wire building both ways:
//   - a scripted tool_use sequence executes tools and returns results in the
//     NEXT request (tool_result pairing, one user message, image blocks);
//   - abort mid-loop → {status:"aborted"}, no further requests;
//   - the iteration cap stops a model that never finishes;
//   - malformed model output → {status:"error"} + an error event, never a throw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop, parseAssistantTurn, toProviderTools, agentSystemPrompt, MAX_AGENT_ITERATIONS } from "../src/lib/agentLoop.js";

const CFG_A = { endpoint: "http://localhost:9999", apiKey: "k", model: "mock", provider: "anthropic" };
const CFG_O = { ...CFG_A, provider: "openai" };

const TOOLS = [
  { name: "probe", description: "probe something", input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
  { name: "look", description: "look at something", input_schema: { type: "object", properties: {}, required: [] } },
];

const resp = (json: unknown, status = 200) => ({ ok: status < 400, status, json: async () => json });

/** A fetch stub replaying scripted bodies and recording every request body. */
function scriptedFetch(replies: unknown[]) {
  const requests: any[] = [];
  const fn = async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body));
    if (!replies.length) throw new Error("script exhausted");
    return resp(replies.shift());
  };
  return { fn, requests };
}

const anthropicTurn = (id: string, name: string, input: unknown, text = "") => ({
  content: [...(text ? [{ type: "text", text }] : []), { type: "tool_use", id, name, input }],
  stop_reason: "tool_use",
});
const anthropicDone = (text: string) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });

test("anthropic-style: scripted tool_use → tools execute → results pair up in ONE user message → done", async () => {
  const { fn, requests } = scriptedFetch([
    { // two parallel tool calls in one turn
      content: [
        { type: "text", text: "Working." },
        { type: "tool_use", id: "toolu_1", name: "probe", input: { q: "rooms" } },
        { type: "tool_use", id: "toolu_2", name: "look", input: {} },
      ],
      stop_reason: "tool_use",
    },
    anthropicDone("All staged."),
  ]);
  const executed: Array<[string, unknown]> = [];
  const events: any[] = [];
  const res = await runAgentLoop({
    cfg: CFG_A, goal: "take off the carpet", tools: TOOLS,
    execute: (name, args) => {
      executed.push([name, args]);
      return name === "look"
        ? { image_data_url: "data:image/png;base64,QUJD", width: 10, height: 10 }
        : { found: 2 };
    },
    onEvent: (ev) => events.push(ev),
    fetchFn: fn as any,
  });
  assert.equal(res.status, "done");
  assert.equal(res.text, "All staged.");
  assert.deepEqual(executed, [["probe", { q: "rooms" }], ["look", {}]]);
  // request 1: system contract + the goal + provider-shaped tools
  assert.equal(requests[0].system, agentSystemPrompt());
  assert.deepEqual(requests[0].messages, [{ role: "user", content: "take off the carpet" }]);
  assert.deepEqual(requests[0].tools.map((t: any) => t.name), ["probe", "look"]);
  // request 2: assistant echo + BOTH results in one user message, ids paired
  const msgs = requests[1].messages;
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].role, "assistant");
  const results = msgs[2].content;
  assert.equal(msgs[2].role, "user");
  assert.deepEqual(results.map((r: any) => r.tool_use_id), ["toolu_1", "toolu_2"]);
  assert.match(results[0].content[0].text, /"found":2/);
  // the image result rides as a real image block, never serialized into text
  assert.equal(results[1].content[0].type, "image");
  assert.equal(results[1].content[0].source.data, "QUJD");
  assert.ok(!JSON.stringify(results[1].content.filter((b: any) => b.type === "text")).includes("base64"));
  // streaming status: text → tool_start/tool_end ×2 → final text → done
  assert.deepEqual(events.map((e) => e.type), ["text", "tool_start", "tool_end", "tool_start", "tool_end", "text", "done"]);
});

test("openai-style: function calling round-trip with role:tool results", async () => {
  const { fn, requests } = scriptedFetch([
    { choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "probe", arguments: '{"q":"schedule"}' } }] } }] },
    { choices: [{ message: { role: "assistant", content: "done" } }] },
  ]);
  const executed: Array<[string, unknown]> = [];
  const res = await runAgentLoop({
    cfg: CFG_O, goal: "go", tools: TOOLS,
    execute: (name, args) => { executed.push([name, args]); return { ok: 1 }; },
    fetchFn: fn as any,
  });
  assert.equal(res.status, "done");
  assert.deepEqual(executed, [["probe", { q: "schedule" }]]);
  // system prompt rides as messages[0] on this wire; tools are function-shaped
  assert.equal(requests[0].messages[0].role, "system");
  assert.equal(requests[0].tools[0].type, "function");
  assert.equal(requests[0].tools[0].function.name, "probe");
  const msgs = requests[1].messages;
  const toolMsg = msgs.find((m: any) => m.role === "tool");
  assert.equal(toolMsg.tool_call_id, "call_1");
  assert.match(toolMsg.content, /"ok":1/);
});

test("openai-style: unparseable function arguments become an error result, not a crash", async () => {
  const { fn, requests } = scriptedFetch([
    { choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "probe", arguments: "{not json" } }] } }] },
    { choices: [{ message: { role: "assistant", content: "ok" } }] },
  ]);
  let executed = 0;
  const res = await runAgentLoop({ cfg: CFG_O, goal: "go", tools: TOOLS, execute: () => { executed++; return {}; }, fetchFn: fn as any });
  assert.equal(res.status, "done");
  assert.equal(executed, 0);   // the tool itself never ran on bad args
  const toolMsg = requests[1].messages.find((m: any) => m.role === "tool");
  assert.match(toolMsg.content, /not valid JSON/);
});

test("abort mid-loop: no further requests, {status:aborted}", async () => {
  const ctl = new AbortController();
  const { fn, requests } = scriptedFetch([
    anthropicTurn("toolu_1", "probe", { q: "x" }),
    anthropicDone("never reached"),
  ]);
  const events: any[] = [];
  const res = await runAgentLoop({
    cfg: CFG_A, goal: "go", tools: TOOLS,
    execute: () => { ctl.abort(); return { late: true }; },   // the user hits Stop while a tool runs
    onEvent: (ev) => events.push(ev),
    signal: ctl.signal,
    fetchFn: fn as any,
  });
  assert.equal(res.status, "aborted");
  assert.equal(requests.length, 1);                            // the second request never fired
  assert.equal(events.at(-1).type, "aborted");
});

test("max-iterations cap stops a model that never finishes", async () => {
  let calls = 0;
  const fn = async () => { calls++; return resp(anthropicTurn(`toolu_${calls}`, "look", {})); };
  const events: any[] = [];
  const res = await runAgentLoop({
    cfg: CFG_A, goal: "go", tools: TOOLS,
    execute: () => ({}), onEvent: (ev) => events.push(ev),
    maxIterations: 3, fetchFn: fn as any,
  });
  assert.equal(res.status, "max_iterations");
  assert.equal(calls, 3);
  assert.equal(events.at(-1).type, "max_iterations");
  assert.ok(MAX_AGENT_ITERATIONS >= 8);   // the real cap leaves room for a full schedule→measure→propose run
});

test("malformed model output → error status + event, not a crash", async () => {
  for (const bad of [{ nonsense: true }, { content: "not-an-array" }, null]) {
    const { fn } = scriptedFetch([bad]);
    const events: any[] = [];
    const res = await runAgentLoop({ cfg: CFG_A, goal: "go", tools: TOOLS, execute: () => ({}), onEvent: (ev) => events.push(ev), fetchFn: fn as any });
    assert.equal(res.status, "error");
    assert.equal(events.at(-1).type, "error");
  }
});

test("transport failure (HTTP 500) → error status with a plain-language message", async () => {
  const fn = async () => resp({ oops: 1 }, 500);
  const res = await runAgentLoop({ cfg: CFG_A, goal: "go", tools: TOOLS, execute: () => ({}), fetchFn: fn as any });
  assert.equal(res.status, "error");
  assert.match(res.message!, /HTTP 500/);
});

test("a throwing execute is contained as a tool error result", async () => {
  const { fn, requests } = scriptedFetch([
    anthropicTurn("toolu_1", "probe", { q: "x" }),
    anthropicDone("recovered"),
  ]);
  const res = await runAgentLoop({
    cfg: CFG_A, goal: "go", tools: TOOLS,
    execute: () => { throw new Error("capability blew up"); },
    fetchFn: fn as any,
  });
  assert.equal(res.status, "done");
  const result = requests[1].messages[2].content[0];
  assert.equal(result.is_error, true);                          // contained AND flagged
  assert.match(result.content[0].text, /capability blew up/);   // the message reaches the model as a correctable turn
});

test("parseAssistantTurn + toProviderTools are honest about shapes", () => {
  assert.equal(parseAssistantTurn("anthropic", { content: [] }).ok, true);
  assert.equal(parseAssistantTurn("anthropic", { error: { message: "boom" } }).ok, false);
  assert.equal(parseAssistantTurn("openai", { choices: [] }).ok, false);
  const [a] = toProviderTools("anthropic", TOOLS);
  assert.deepEqual(Object.keys(a).sort(), ["description", "input_schema", "name"]);
  const [o] = toProviderTools("openai", TOOLS);
  assert.equal(o.type, "function");
});
