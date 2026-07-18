// In-canvas takeoff agent — the PROVIDER-AGNOSTIC TOOL-USE LOOP. No React, no
// DOM: goal in, tool executions through the injected `execute`, streaming
// status out through `onEvent`, and a terminal {status} back. Transport rides
// ai.js's chatWithTools (the user's OWN key and endpoint — the BYO-AI seam),
// which both this loop and the tests reach through injectable cfg/fetchFn.
//
// Provider translation lives here and only here:
//   Anthropic-style — tools: [{name, description, input_schema}], assistant
//     turns carry tool_use content blocks, results go back as tool_result
//     blocks in ONE user message (parallel calls included);
//   OpenAI-style — tools: [{type:"function", function:{...}}], assistant turns
//     carry tool_calls, results go back as role:"tool" messages (+ a follow-up
//     user message for image results, which the tool role can't carry).
//
// Failure contract: NOTHING here throws to the caller. A transport error, a
// malformed model reply, an abort, or the iteration cap all surface as an
// onEvent + a terminal {status: "error" | "aborted" | "max_iterations"} —
// the canvas renders status, it never crashes.

import { chatWithTools } from "./ai.js";

export const MAX_AGENT_ITERATIONS = 24;

// The takeoff-agent contract. Kept in one exported function so the tests (and
// the mock server's authors) can read exactly what the model is promised.
export function agentSystemPrompt() {
  return [
    "You are the in-canvas takeoff agent inside OpenTakeoff, an open-source PDF takeoff tool for flooring estimators. An estimator gave you a goal; you aim the app's own deterministic tools to satisfy it.",
    "",
    "Hard rules:",
    "- NEVER invent geometry. Rooms are measured by the one_click flood-fill engine; propose only the rings it returns.",
    "- NEVER assume a scale. If a sheet has no scale set, report that (the tool refusal tells you) and stop work on that sheet — the estimator must calibrate it.",
    "- Every proposal MUST cite evidence: the schedule row tag and/or the exact matched text token (a room tag or schedule cell) and/or the one_click seed. propose_shapes rejects uncited shapes.",
    "- You stage proposals only. A human reviews every shape at the accept gate; nothing you do commits a takeoff.",
    "",
    "Working method: list_sheets first. Read the finish schedule (read_schedule) or the sheet text (read_sheet_text) to ground WHAT to take off; use view_region to look at scanned or ambiguous areas. Match or create conditions, measure rooms with one_click, then stage propose_shapes with evidence. Then summarize what you proposed and what you could not do, and stop. If you are blocked (no scale, sheet not open, nothing matches), say so plainly and stop rather than guessing.",
  ].join("\n");
}

// ── provider translation ─────────────────────────────────────────────────────
export function toProviderTools(provider, defs) {
  if (provider === "anthropic") {
    return defs.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  }
  return defs.map(({ name, description, input_schema }) => ({
    type: "function",
    function: { name, description, parameters: input_schema },
  }));
}

/** One assistant reply → { ok, text, toolCalls: [{id, name, args, argsError?}], raw } | { ok:false, error }.
 *  Malformed replies come back as ok:false — the loop turns that into an error
 *  status, never a throw. */
export function parseAssistantTurn(provider, json) {
  if (!json || typeof json !== "object") return { ok: false, error: "The endpoint replied, but not with a message." };
  if (provider === "anthropic") {
    if (!Array.isArray(json.content)) {
      return { ok: false, error: json.error?.message ? `Endpoint error: ${json.error.message}` : "Malformed reply: no content blocks." };
    }
    const text = json.content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim();
    const toolCalls = json.content.filter((b) => b?.type === "tool_use").map((b, i) => ({
      id: b.id || `toolu_${i}`,
      name: typeof b.name === "string" ? b.name : "",
      args: b.input && typeof b.input === "object" ? b.input : {},
    }));
    return { ok: true, text, toolCalls, raw: json };
  }
  const msg = json.choices?.[0]?.message;
  if (!msg || typeof msg !== "object") {
    return { ok: false, error: json.error?.message ? `Endpoint error: ${json.error.message}` : "Malformed reply: no choices[0].message." };
  }
  const text = typeof msg.content === "string"
    ? msg.content.trim()
    : Array.isArray(msg.content) ? msg.content.filter((p) => p && typeof p.text === "string").map((p) => p.text).join("\n").trim() : "";
  const toolCalls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).map((tc, i) => {
    const call = { id: tc.id || `call_${i}`, name: tc.function?.name || "", args: {} };
    try { call.args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; }
    catch { call.argsError = "arguments were not valid JSON"; }
    return call;
  });
  return { ok: true, text, toolCalls, raw: msg };
}

// Tool results serialize as JSON text, capped so one enormous read can't blow
// the context; image results ride as real image blocks (Anthropic) or a
// follow-up user image message (OpenAI-style function calling has no image
// slot in the tool role).
const RESULT_MAX_CHARS = 20000;
const resultText = (out) => {
  const { image_data_url: _img, ...rest } = out && typeof out === "object" ? out : { value: out };
  let s;
  try { s = JSON.stringify(rest); } catch { s = String(rest); }
  return s.length > RESULT_MAX_CHARS ? `${s.slice(0, RESULT_MAX_CHARS)}… (truncated)` : s;
};

function appendToolResults(provider, messages, results) {
  if (provider === "anthropic") {
    const blocks = results.map(({ call, out }) => {
      const content = [{ type: "text", text: resultText(out) }];
      if (out?.image_data_url) {
        const m = /^data:(image\/\w+);base64,(.*)$/s.exec(out.image_data_url) || [];
        content.unshift({ type: "image", source: { type: "base64", media_type: m[1] || "image/png", data: m[2] || "" } });
      }
      return { type: "tool_result", tool_use_id: call.id, content, ...(out?.error ? { is_error: true } : {}) };
    });
    messages.push({ role: "user", content: blocks });
    return;
  }
  const images = [];
  for (const { call, out } of results) {
    messages.push({ role: "tool", tool_call_id: call.id, content: resultText(out) });
    if (out?.image_data_url) images.push(out.image_data_url);
  }
  if (images.length) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: `The ${images.length === 1 ? "image" : "images"} from view_region:` },
        ...images.map((url) => ({ type: "image_url", image_url: { url } })),
      ],
    });
  }
}

// ── the loop ─────────────────────────────────────────────────────────────────
/**
 * @param {{
 *   cfg: { endpoint: string, apiKey?: string, model: string, provider?: string },
 *   goal: string,
 *   tools: Array<{ name: string, description: string, input_schema: any }>,
 *   execute: (name: string, args: any) => Promise<any> | any,
 *   onEvent?: (ev: Record<string, any>) => void,
 *   signal?: AbortSignal,
 *   maxIterations?: number,
 *   fetchFn?: typeof fetch,
 * }} opts
 * @returns {Promise<{ status: "done" | "aborted" | "error" | "max_iterations", text?: string, message?: string, iterations: number }>}
 */
export async function runAgentLoop({ cfg, goal, tools, execute, onEvent, signal, maxIterations = MAX_AGENT_ITERATIONS, fetchFn }) {
  const provider = cfg?.provider === "anthropic" ? "anthropic" : "openai";
  const emit = (ev) => { try { onEvent?.(ev); } catch { /* a status listener must never kill the run */ } };
  const providerTools = toProviderTools(provider, tools);
  const system = agentSystemPrompt();
  const messages = [{ role: "user", content: goal }];
  let iterations = 0;
  const aborted = () => { emit({ type: "aborted" }); return { status: /** @type {const} */ ("aborted"), iterations }; };

  for (; iterations < maxIterations; iterations++) {
    if (signal?.aborted) return aborted();
    let json;
    try {
      json = await chatWithTools({ cfg, system, messages, tools: providerTools, signal, fetchFn });
    } catch (e) {
      if (signal?.aborted || e?.name === "AbortError") return aborted();
      const message = String((e && e.message) || e);
      emit({ type: "error", message });
      return { status: "error", message, iterations };
    }
    const turn = parseAssistantTurn(provider, json);
    if (!turn.ok) {
      emit({ type: "error", message: turn.error });
      return { status: "error", message: turn.error, iterations };
    }
    if (turn.text) emit({ type: "text", text: turn.text });
    // echo the assistant turn back verbatim so tool_use ids / tool_calls pair up
    messages.push(provider === "anthropic" ? { role: "assistant", content: turn.raw.content } : turn.raw);
    if (!turn.toolCalls.length) {
      emit({ type: "done", text: turn.text });
      return { status: "done", text: turn.text, iterations: iterations + 1 };
    }
    const results = [];
    for (const call of turn.toolCalls) {
      if (signal?.aborted) return aborted();
      emit({ type: "tool_start", name: call.name, args: call.args });
      let out;
      try {
        out = call.argsError ? { error: `Invalid arguments for ${call.name}: ${call.argsError}.` } : await execute(call.name, call.args);
      } catch (e) {
        out = { error: `Tool ${call.name} failed: ${String((e && e.message) || e)}` };
      }
      if (out == null || typeof out !== "object") out = { result: out ?? null };
      emit({ type: "tool_end", name: call.name, result: out });
      results.push({ call, out });
    }
    appendToolResults(provider, messages, results);
  }
  emit({ type: "max_iterations", limit: maxIterations });
  return { status: "max_iterations", iterations };
}
