// Streamed replies (lib/chatStream.js + ai.js chatWithTools + agentLoop) and
// the Conversation memory setting (lib/agentChat clampHistoryTurns):
//   - the SSE parser survives chunk boundaries anywhere (mid-line, mid-\r\n,
//     mid-JSON), comments, multi-line data and a missing final blank line;
//   - Anthropic-style (content_block_delta text_delta / input_json_delta) and
//     OpenAI-style (delta.content / delta.tool_calls) streams give text deltas
//     in order and assemble tool calls whole, in the non-streaming JSON shape;
//   - a stream that ends early, or carries an error event, is an error;
//   - fallback: an endpoint that answers `stream: true` with JSON, refuses it
//     (HTTP 400), or streams under the wrong content type still works, and
//     later turns stop asking it to stream;
//   - Stop mid-stream: the loop reports "aborted", the body is cancelled, and
//     the partial answer stays on the turn;
//   - history length: 0..20, default 8, 0 sends nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSseParser, anthropicStreamAccumulator, openaiStreamAccumulator, parseChatStreamText, looksLikeSse,
  readChatStream, STREAM_ENDED_EARLY,
} from "../src/lib/chatStream.js";
import { chatWithTools, forgetStreamSupport, aiConfig, saveAiConfig } from "../src/lib/ai.js";
import { runAgentLoop } from "../src/lib/agentLoop.js";
import {
  newTurn, foldEvent, foldEvents, sanitizeChat, historyMessages, clampHistoryTurns, createDeltaBatcher, memoryPhrase,
  HISTORY_TURNS, HISTORY_TURNS_MAX,
} from "../src/lib/agentChat.js";

// ── fixtures ─────────────────────────────────────────────────────────────────
const aEv = (type: string, o: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
const oEv = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

/** Anthropic-style stream: "Checking." then probe({q:"A-101"}) with its JSON split in three. */
const ANTHROPIC_TOOL_STREAM = [
  aEv("message_start", { message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "m", stop_reason: null } }),
  aEv("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
  aEv("ping"),
  aEv("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Check" } }),
  aEv("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ing." } }),
  aEv("content_block_stop", { index: 0 }),
  aEv("content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "probe", input: {} } }),
  aEv("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "" } }),
  aEv("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "{\"q\": \"A-" } }),
  aEv("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "101\"}" } }),
  aEv("content_block_stop", { index: 1 }),
  aEv("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }),
  aEv("message_stop"),
].join("");

const anthropicTextStream = (pieces: string[], { end = true } = {}) => [
  aEv("message_start", { message: { id: "msg_2", type: "message", role: "assistant", content: [], stop_reason: null } }),
  aEv("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
  ...pieces.map((t) => aEv("content_block_delta", { index: 0, delta: { type: "text_delta", text: t } })),
  ...(end ? [aEv("content_block_stop", { index: 0 }), aEv("message_delta", { delta: { stop_reason: "end_turn" } }), aEv("message_stop")] : []),
].join("");

/** OpenAI-style stream: two parallel tool calls, arguments split across chunks, interleaved. */
const OPENAI_TOOL_STREAM = [
  oEv({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }),
  oEv({ choices: [{ index: 0, delta: { content: "Look" } }] }),
  oEv({ choices: [{ index: 0, delta: { content: "ing." } }] }),
  oEv({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "probe", arguments: "" } }] } }] }),
  oEv({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"q\":" } }] } }] }),
  oEv({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "look", arguments: "{}" } }] } }] }),
  oEv({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"x\"}" } }] } }] }),
  oEv({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
  "data: [DONE]\n\n",
].join("");

const openaiTextStream = (pieces: string[], { end = true } = {}) => [
  ...pieces.map((t) => oEv({ choices: [{ index: 0, delta: { content: t } }] })),
  ...(end ? [oEv({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), "data: [DONE]\n\n"] : []),
].join("");

/** Cut a string into n-byte pieces — every boundary lands somewhere awkward. */
const cut = (s: string, n: number) => { const out: string[] = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out; };

/** A real Response whose body streams `chunks` (as bytes). `hang`: after the
 *  chunks, the body never ends on its own (only a cancel ends it). */
function sseResponse(chunks: string[], { type = "text/event-stream", status = 200, hang = false, onCancel }: { type?: string; status?: number; hang?: boolean; onCancel?: () => void } = {}) {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream({
    async pull(ctl) {
      if (i < chunks.length) { ctl.enqueue(enc.encode(chunks[i++])); return; }
      if (hang) { await new Promise(() => {}); return; }
      ctl.close();
    },
    cancel() { onCancel?.(); },
  });
  return new Response(body, { status, headers: { "content-type": type } });
}
const jsonResponse = (json: unknown, status = 200) => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });

let port = 7000;
/** A fresh endpoint per test: the "this endpoint doesn't stream" memo is per URL + model. */
const cfgA = () => ({ endpoint: `http://localhost:${port++}`, apiKey: "k", model: "mock", provider: "anthropic" });
const cfgO = () => ({ ...cfgA(), provider: "openai" });

const TOOLS = [
  { name: "probe", description: "probe something", input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
  { name: "look", description: "look at something", input_schema: { type: "object", properties: {}, required: [] } },
];

// ── the SSE parser ───────────────────────────────────────────────────────────
test("sse parser: events split anywhere — mid-line, mid-\\r\\n, comments, multi-line data, no final blank line", () => {
  const text = ": keep-alive\r\nevent: a\r\ndata: one\r\n\r\ndata: two\r\ndata: lines\r\n\r\nid: 7\ndata:three\n\ndata: tail";
  for (const n of [1, 2, 3, 5, 7, 64]) {
    const p = createSseParser();
    const evs: any[] = [];
    for (const c of cut(text, n)) evs.push(...p.push(c));
    evs.push(...p.flush());
    assert.deepEqual(evs, [
      { event: "a", data: "one" },
      { event: "message", data: "two\nlines" },
      { event: "message", data: "three" },
      { event: "message", data: "tail" },
    ], `chunk size ${n}`);
  }
  assert.equal(looksLikeSse(": hi\nevent: x\ndata: {}"), true);
  assert.equal(looksLikeSse("{\"content\": []}"), false);
});

// ── the two provider formats ────────────────────────────────────────────────
test("anthropic stream: text deltas in order; tool_use input assembled from split input_json_delta", async () => {
  for (const n of [1, 9, 40, 100000]) {
    const deltas: string[] = [];
    const msg: any = await readChatStream({ provider: "anthropic", body: sseResponse(cut(ANTHROPIC_TOOL_STREAM, n)).body, onTextDelta: (d: string) => deltas.push(d) });
    assert.deepEqual(deltas, ["Check", "ing."], `chunk size ${n}`);
    assert.equal(msg.stop_reason, "tool_use");
    assert.deepEqual(msg.content, [
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "toolu_1", name: "probe", input: { q: "A-101" } },
    ]);
  }
  // a no-argument tool keeps the {} from content_block_start
  const acc = anthropicStreamAccumulator();
  for (const e of [aEv("content_block_start", { index: 0, content_block: { type: "tool_use", id: "t", name: "look", input: {} } }), aEv("content_block_stop", { index: 0 }), aEv("message_stop")]) {
    acc.add(createSseParser().push(e)[0]);
  }
  assert.deepEqual(acc.result().content, [{ type: "tool_use", id: "t", name: "look", input: {} }]);
});

test("openai stream: delta.content in order; parallel tool_calls assembled by index from split arguments", async () => {
  for (const n of [1, 11, 100000]) {
    const deltas: string[] = [];
    const json: any = await readChatStream({ provider: "openai", body: sseResponse(cut(OPENAI_TOOL_STREAM, n)).body, onTextDelta: (d: string) => deltas.push(d) });
    assert.deepEqual(deltas, ["Look", "ing."], `chunk size ${n}`);
    assert.deepEqual(json.choices[0].message, {
      role: "assistant", content: "Looking.",
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "probe", arguments: "{\"q\":\"x\"}" } },
        { id: "call_b", type: "function", function: { name: "look", arguments: "{}" } },
      ],
    });
    assert.equal(json.choices[0].finish_reason, "tool_calls");
  }
  // a text-only reply has no tool_calls key at all (what non-streaming sends)
  const acc = openaiStreamAccumulator();
  for (const e of createSseParser().push(openaiTextStream(["Hi", "!"]))) acc.add(e);
  assert.deepEqual(acc.result().choices[0].message, { role: "assistant", content: "Hi!" });
});

test("a stream that ends early, or reports an error, is an error — never a silently short answer", async () => {
  const deltas: string[] = [];
  await assert.rejects(
    readChatStream({ provider: "anthropic", body: sseResponse([anthropicTextStream(["Half an ", "answ"], { end: false })]).body, onTextDelta: (d: string) => deltas.push(d) }),
    (e: any) => e.message === STREAM_ENDED_EARLY,
  );
  assert.deepEqual(deltas, ["Half an ", "answ"], "what did arrive was still handed on");
  await assert.rejects(readChatStream({ provider: "openai", body: sseResponse([openaiTextStream(["cut"], { end: false })]).body }), (e: any) => e.message === STREAM_ENDED_EARLY);
  // a tool call cut off mid-JSON
  const cutTool = ANTHROPIC_TOOL_STREAM.slice(0, ANTHROPIC_TOOL_STREAM.indexOf("101"));
  await assert.rejects(readChatStream({ provider: "anthropic", body: sseResponse([cutTool]).body }), (e: any) => e.message === STREAM_ENDED_EARLY);
  // the endpoint's own error event mid-stream
  await assert.rejects(
    readChatStream({ provider: "anthropic", body: sseResponse([anthropicTextStream(["x"], { end: false }), aEv("error", { error: { type: "overloaded_error", message: "Overloaded" } })]).body }),
    /Endpoint error: Overloaded/,
  );
  await assert.rejects(readChatStream({ provider: "openai", body: sseResponse([oEv({ error: { message: "model not loaded" } })]).body }), /Endpoint error: model not loaded/);
  // the loop turns it into an error status, and the turn keeps the partial text
  const fetchFn = async () => sseResponse([anthropicTextStream(["Partial ", "reply"], { end: false })]);
  const events: any[] = [];
  const res = await runAgentLoop({ cfg: cfgA(), goal: "go", tools: TOOLS, execute: () => ({}), onEvent: (ev) => events.push(ev), fetchFn: fetchFn as any });
  assert.equal(res.status, "error");
  assert.equal(res.message, STREAM_ENDED_EARLY);
  const turn = foldEvents(newTurn("go", { id: "t" }), events);
  assert.equal(turn.status, "error");
  assert.equal(turn.text, "Partial reply");
});

// ── the loop, streaming end to end ──────────────────────────────────────────
test("agentLoop streams: text_delta events, tools run with assembled args, the reply echoes back whole", async () => {
  const bodies: any[] = [];
  const replies = [cut(ANTHROPIC_TOOL_STREAM, 13), cut(anthropicTextStream(["Found ", "**A-101**", "."]), 17)];
  const fetchFn = async (_u: string, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return sseResponse(replies.shift()!); };
  const events: any[] = [];
  const calls: any[] = [];
  const res = await runAgentLoop({
    cfg: cfgA(), goal: "go", tools: TOOLS, onEvent: (ev) => events.push(ev),
    execute: (name, args) => { calls.push([name, args]); return { ok: true }; }, fetchFn: fetchFn as any,
  });
  assert.equal(res.status, "done");
  assert.equal(res.text, "Found **A-101**.");
  assert.ok(bodies.every((b) => b.stream === true), "every request asks to stream");
  assert.deepEqual(calls, [["probe", { q: "A-101" }]]);
  assert.deepEqual(bodies[1].messages[1], { role: "assistant", content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "toolu_1", name: "probe", input: { q: "A-101" } }] });
  assert.deepEqual(events.map((e) => e.type), ["text_delta", "text_delta", "text", "tool_start", "tool_end", "text_delta", "text_delta", "text_delta", "text", "done"]);
  // folded, the turn reads like the non-streaming one
  const turn = foldEvents(newTurn("go", { id: "t" }), events);
  assert.equal(turn.status, "done");
  assert.equal(turn.text, "Found **A-101**.");
  assert.deepEqual(turn.steps.map((s: any) => s.kind === "say" ? s.text : s.label), ["Checking.", "probe"]);
  assert.equal("live" in turn, false);
  // OpenAI-style, same story
  const oReplies = [cut(OPENAI_TOOL_STREAM, 23), cut(openaiTextStream(["Done", "."]), 5)];
  const oBodies: any[] = [];
  const oFetch = async (_u: string, init: { body: string }) => { oBodies.push(JSON.parse(init.body)); return sseResponse(oReplies.shift()!); };
  const oCalls: any[] = [];
  const oRes = await runAgentLoop({ cfg: cfgO(), goal: "go", tools: TOOLS, execute: (n, a) => { oCalls.push([n, a]); return {}; }, fetchFn: oFetch as any });
  assert.equal(oRes.status, "done");
  assert.equal(oRes.text, "Done.");
  assert.deepEqual(oCalls, [["probe", { q: "x" }], ["look", {}]]);
  assert.deepEqual(oBodies[1].messages.slice(2).map((m: any) => [m.role, m.tool_call_id || ""]), [["assistant", ""], ["tool", "call_a"], ["tool", "call_b"]]);
});

// ── fallback ─────────────────────────────────────────────────────────────────
test("fallback: plain JSON to stream:true is read as JSON, and the endpoint isn't asked to stream again", async () => {
  forgetStreamSupport();
  const cfg = cfgA();
  const bodies: any[] = [];
  const fetchFn = async (_u: string, init: { body: string }) => { bodies.push(JSON.parse(init.body)); return jsonResponse({ content: [{ type: "text", text: "Plain." }], stop_reason: "end_turn" }); };
  const deltas: string[] = [];
  const a: any = await chatWithTools({ cfg, messages: [{ role: "user", content: "hi" }], tools: [], stream: true, onTextDelta: (d: string) => deltas.push(d), fetchFn: fetchFn as any });
  assert.equal(a.content[0].text, "Plain.");
  assert.deepEqual(deltas, []);
  await chatWithTools({ cfg, messages: [{ role: "user", content: "hi" }], tools: [], stream: true, fetchFn: fetchFn as any });
  assert.deepEqual(bodies.map((b) => b.stream), [true, undefined]);
});

test("fallback: HTTP 400 on stream:true retries once without it; 401 is reported, not retried", async () => {
  forgetStreamSupport();
  const cfg = cfgO();
  const bodies: any[] = [];
  const fetchFn = async (_u: string, init: { body: string }) => {
    const b = JSON.parse(init.body); bodies.push(b);
    if (b.stream) return new Response("{\"error\":\"unknown field stream\"}", { status: 400, headers: { "content-type": "application/json" } });
    return jsonResponse({ choices: [{ message: { role: "assistant", content: "No stream here." } }] });
  };
  const res = await runAgentLoop({ cfg, goal: "go", tools: TOOLS, execute: () => ({}), fetchFn: fetchFn as any });
  assert.equal(res.status, "done");
  assert.equal(res.text, "No stream here.");
  await runAgentLoop({ cfg, goal: "again", tools: TOOLS, execute: () => ({}), fetchFn: fetchFn as any });
  assert.deepEqual(bodies.map((b) => !!b.stream), [true, false, false], "refused once, then plain for the rest of the session");

  const seen: any[] = [];
  const denied = async (_u: string, init: { body: string }) => { seen.push(JSON.parse(init.body)); return new Response("no", { status: 401 }); };
  await assert.rejects(chatWithTools({ cfg: cfgA(), messages: [], tools: [], stream: true, fetchFn: denied as any }), /HTTP 401/);
  assert.equal(seen.length, 1);
});

test("fallback: an event stream under the wrong content type is still read as a stream", async () => {
  const deltas: string[] = [];
  const fetchFn = async () => sseResponse([openaiTextStream(["Wrong ", "header."])], { type: "text/plain" });
  const json: any = await chatWithTools({ cfg: cfgO(), messages: [], tools: [], stream: true, onTextDelta: (d: string) => deltas.push(d), fetchFn: fetchFn as any });
  assert.equal(json.choices[0].message.content, "Wrong header.");
  assert.deepEqual(deltas, ["Wrong ", "header."]);
  assert.deepEqual((parseChatStreamText("anthropic", anthropicTextStream(["a", "b"])) as any).content, [{ type: "text", text: "ab" }]);
  // stream: false never sends the flag (the vision reads and any caller that opts out)
  const bodies: any[] = [];
  await chatWithTools({ cfg: cfgO(), messages: [], tools: [], fetchFn: (async (_u: string, i: { body: string }) => { bodies.push(JSON.parse(i.body)); return jsonResponse({ choices: [{ message: { content: "x" } }] }); }) as any });
  assert.equal(bodies[0].stream, undefined);
});

// ── Stop mid-stream ─────────────────────────────────────────────────────────
test("Stop mid-stream: aborted status, the body is cancelled, no tool runs, the partial answer stays", async () => {
  const ctl = new AbortController();
  let cancelled = false;
  let requests = 0;
  // a body that does NOT watch the fetch signal — Stop must still end the read
  const fetchFn = async () => { requests++; return sseResponse([anthropicTextStream(["Reading ", "the sheet"], { end: false })], { hang: true, onCancel: () => { cancelled = true; } }); };
  const events: any[] = [];
  let executed = 0;
  const run = runAgentLoop({
    cfg: cfgA(), goal: "go", tools: TOOLS, signal: ctl.signal, fetchFn: fetchFn as any,
    execute: () => { executed++; return {}; },
    onEvent: (ev) => { events.push(ev); if (ev.type === "text_delta" && ev.text === "the sheet") setTimeout(() => ctl.abort(), 5); },
  });
  const res = await run;
  assert.equal(res.status, "aborted");
  assert.equal(cancelled, true, "the stream was cancelled, so the connection closes");
  assert.equal(requests, 1);
  assert.equal(executed, 0);
  assert.equal(events.at(-1).type, "aborted");
  const turn = foldEvents(newTurn("go", { id: "t" }), events);
  assert.equal(turn.status, "stopped");
  assert.equal(turn.text, "Reading the sheet");
  // the stopped partial answer persists and rides along as history, marked as ended early
  const [saved] = sanitizeChat({ turns: [turn] });
  assert.equal(saved.text, "Reading the sheet");
  assert.equal("live" in saved, false);
  assert.match(historyMessages([saved])[1].content, /^Reading the sheet\n\n\[This run ended early: stopped by the estimator\.\]$/);
  // chatWithTools itself rejects with an AbortError, the loop's "stopped, not broken" signal
  const c2 = new AbortController();
  const p = chatWithTools({ cfg: cfgA(), messages: [], tools: [], stream: true, signal: c2.signal, fetchFn: (async () => sseResponse([], { hang: true })) as any });
  setTimeout(() => c2.abort(), 5);
  await assert.rejects(p, (e: any) => e.name === "AbortError");
});

// ── the fold and the batcher ────────────────────────────────────────────────
test("fold: text_delta grows the answer in place; the next reply replaces it; steps are not touched", () => {
  let t = newTurn("go", { id: "t" });
  const steps = t.steps;
  t = foldEvent(t, { type: "text_delta", text: "\n  Check" });
  t = foldEvent(t, { type: "text_delta", text: "ing." });
  assert.equal(t.text, "Checking.", "leading whitespace isn't shown");
  assert.equal(t.steps, steps, "a delta doesn't copy the step list");
  t = foldEvents(t, [{ type: "text", text: "Checking." }, { type: "tool_start", name: "list_sheets", args: {} }, { type: "tool_end", name: "list_sheets", result: { sheets: [] } }]);
  assert.equal(t.text, "Checking.");
  t = foldEvent(t, { type: "text_delta", text: " " });
  assert.equal(t.text, "Checking.", "whitespace alone doesn't blank the previous reply");
  t = foldEvent(t, { type: "text_delta", text: "Two" });
  assert.equal(t.text, "Two", "the new reply takes over as soon as it has words");
  t = foldEvent(t, { type: "done", text: "Two sheets." });
  assert.equal(t.text, "Two sheets.");
  assert.equal("live" in t, false);
  assert.equal(foldEvent(t, { type: "text_delta", text: "" }), t);
});

test("delta batcher: deltas coalesce per turn until the tick; any other event commits them first, in order", () => {
  const commits: any[] = [];
  let tick: (() => void) | null = null;
  const b = createDeltaBatcher((pairs) => commits.push(pairs), { schedule: (fn) => { tick = fn; return 1; }, cancel: () => { tick = null; } });
  b.apply("a", { type: "text_delta", text: "He" });
  b.apply("a", { type: "text_delta", text: "llo" });
  b.apply("b", { type: "text_delta", text: "x" });
  assert.equal(commits.length, 0);
  assert.equal(b.pendingText("a"), "Hello");
  tick!();
  assert.deepEqual(commits.shift(), [["a", { type: "text_delta", text: "Hello" }], ["b", { type: "text_delta", text: "x" }]]);
  b.apply("a", { type: "text_delta", text: " world" });
  b.apply("a", { type: "done", text: "Hello world" });
  assert.deepEqual(commits.shift(), [["a", { type: "text_delta", text: " world" }], ["a", { type: "done", text: "Hello world" }]]);
  b.apply("a", { type: "text_delta", text: "late" });
  b.flush();
  assert.deepEqual(commits.shift(), [["a", { type: "text_delta", text: "late" }]]);
  assert.equal(tick, null, "flush cancels the pending tick");
});

// ── Conversation memory ─────────────────────────────────────────────────────
test("history setting: 0..20, default 8; 0 sends no history; the setting persists with the AI settings", () => {
  assert.equal(HISTORY_TURNS, 8);
  assert.equal(HISTORY_TURNS_MAX, 20);
  for (const [v, want] of [[undefined, 8], [null, 8], ["", 8], ["abc", 8], [NaN, 8], [0, 0], ["0", 0], [-3, 0], [5, 5], [" 12 ", 12], [6.6, 7], [20, 20], [21, 20], [999, 20], [Infinity, 8]] as const) {
    assert.equal(clampHistoryTurns(v as any), want, `clamp(${String(v)})`);
  }
  const turns = Array.from({ length: 25 }, (_, i) => foldEvents(newTurn(`q${i}`, { id: `t${i}` }), [{ type: "done", text: `a${i}` }]));
  assert.equal(historyMessages(turns).length, 16, "default: the last 8 turns");
  assert.equal(historyMessages(turns, 0).length, 0, "0 is off, not 'everything'");
  assert.equal(historyMessages(turns, 3).length, 6);
  assert.equal(historyMessages(turns, 3)[0].content, "q22");
  assert.equal(historyMessages(turns, 50).length, 40, "capped at 20 turns");
  assert.equal(historyMessages(turns, "x" as any).length, 16);
  assert.match(memoryPhrase(8), /up to the last 8 earlier questions and answers/);
  assert.match(memoryPhrase(1), /last 1 earlier question and answer /);
  assert.match(memoryPhrase(0), /no earlier messages/);

  // persisted beside the other AI settings (localStorage in the browser)
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
  try {
    assert.equal(aiConfig().historyTurns, 8, "nothing stored → the default");
    saveAiConfig({ endpoint: "http://localhost:1", model: "m", provider: "openai", apiKey: "", historyTurns: 0 });
    assert.equal(store.get("opentakeoff_ai_history_turns"), "0", "0 is stored, not dropped as falsy");
    assert.equal(aiConfig().historyTurns, 0);
    saveAiConfig({ ...aiConfig(), historyTurns: "35" });
    assert.equal(aiConfig().historyTurns, 20);
    saveAiConfig({ endpoint: "", apiKey: "", model: "", provider: "", historyTurns: "" });   // AI settings → Clear
    assert.equal(store.has("opentakeoff_ai_history_turns"), false);
    assert.equal(aiConfig().historyTurns, 8);
  } finally {
    delete (globalThis as any).localStorage;
  }
});
