// Streaming replies — the PURE half of ai.js's streamed chat transport. No
// fetch, no DOM, no React: Server-Sent Event bytes in, text deltas out through
// a callback, and at the end ONE assistant message in exactly the shape the
// non-streaming endpoint would have returned. agentLoop's parseAssistantTurn
// and its echo of the assistant turn therefore don't know (or care) whether a
// reply was streamed.
//
//   Anthropic-style (Messages API, `stream: true`):
//     message_start → content_block_start / content_block_delta (text_delta,
//     input_json_delta, thinking_delta, signature_delta) / content_block_stop
//     → message_delta (stop_reason) → message_stop; `error` events carry the
//     endpoint's own message; `ping` is ignored.
//   OpenAI-style (chat completions, `stream: true`):
//     data: {choices:[{delta:{content, tool_calls:[{index, id, function:{name,
//     arguments}}]}, finish_reason}]} … data: [DONE].
//
// Tool calls arrive as fragments; they are only ever handed on assembled
// (the loop executes nothing until the stream is complete). A stream that
// ends before the provider's own end marker is an error, never a silently
// truncated answer.

export const STREAM_ENDED_EARLY = "The reply stopped before the model finished (the stream ended early). Check the endpoint, then ask again.";

/** Incremental SSE parser (the WHATWG event-stream rules that matter here):
 *  lines end in \n, \r\n or \r — including a \r\n split across two chunks;
 *  `data:` lines join with \n; `event:` names the event; `:` lines are
 *  comments; a blank line dispatches. push(text) → completed events,
 *  flush() → the last event when the stream ended without its blank line. */
export function createSseParser() {
  let buf = "";
  let data = [];
  let event = "";
  const take = (out) => {
    if (data.length) out.push({ event: event || "message", data: data.join("\n") });
    data = [];
    event = "";
  };
  const line = (l, out) => {
    if (l === "") { take(out); return; }
    if (l[0] === ":") return;
    const i = l.indexOf(":");
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? "" : l.slice(i + 1);
    if (value[0] === " ") value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  };
  return {
    push(text) {
      buf += text;
      const out = [];
      for (;;) {
        const m = /\r\n|\n|\r/.exec(buf);
        if (!m) break;
        // a lone \r at the very end may be the first half of \r\n — wait
        if (m[0] === "\r" && m.index === buf.length - 1) break;
        line(buf.slice(0, m.index), out);
        buf = buf.slice(m.index + m[0].length);
      }
      return out;
    },
    flush() {
      const out = [];
      if (buf) { line(buf.replace(/\r$/, ""), out); buf = ""; }
      take(out);
      return out;
    },
  };
}

const parseJson = (s) => { try { return { ok: true, value: JSON.parse(s) }; } catch { return { ok: false }; } };
const endpointError = (e) => new Error(`Endpoint error: ${(e && (e.message || e.type)) || "the stream reported an error"}`);

/** Anthropic-style stream → { add(sse) → text delta | "", done(), result() }. */
export function anthropicStreamAccumulator() {
  let msg = { type: "message", role: "assistant", content: /** @type {any[]} */ ([]), stop_reason: null };
  const blocks = [];          // by index
  const partial = [];         // tool_use input JSON fragments, by index
  let complete = false;
  return {
    add(sse) {
      if (sse.data === "[DONE]") return "";
      const p = parseJson(sse.data);
      if (!p.ok || !p.value || typeof p.value !== "object") return "";
      const ev = p.value;
      const type = ev.type || sse.event;
      switch (type) {
        case "message_start":
          if (ev.message && typeof ev.message === "object") msg = { ...msg, ...ev.message, content: [] };
          return "";
        case "content_block_start": {
          const b = ev.content_block && typeof ev.content_block === "object" ? { ...ev.content_block } : { type: "text", text: "" };
          if (b.type === "tool_use") b.input = b.input && typeof b.input === "object" ? b.input : {};
          blocks[ev.index ?? blocks.length] = b;
          return "";
        }
        case "content_block_delta": {
          const i = ev.index ?? blocks.length - 1;
          const d = ev.delta || {};
          const b = blocks[i] || (blocks[i] = d.type === "input_json_delta" ? { type: "tool_use", id: "", name: "", input: {} } : { type: "text", text: "" });
          if (d.type === "text_delta" && typeof d.text === "string") { b.text = (b.text || "") + d.text; return d.text; }
          if (d.type === "input_json_delta" && typeof d.partial_json === "string") { partial[i] = (partial[i] || "") + d.partial_json; return ""; }
          if (d.type === "thinking_delta" && typeof d.thinking === "string") { b.thinking = (b.thinking || "") + d.thinking; return ""; }
          if (d.type === "signature_delta" && typeof d.signature === "string") { b.signature = (b.signature || "") + d.signature; return ""; }
          return "";
        }
        case "content_block_stop": {
          const i = ev.index ?? blocks.length - 1;
          const b = blocks[i];
          if (b && b.type === "tool_use" && partial[i] != null && partial[i].trim()) {
            const j = parseJson(partial[i]);
            if (!j.ok || !j.value || typeof j.value !== "object") throw new Error(`The model sent arguments for ${b.name || "a tool"} that aren't valid JSON.`);
            b.input = j.value;
          }
          partial[i] = null;
          return "";
        }
        case "message_delta":
          if (ev.delta && ev.delta.stop_reason) msg.stop_reason = ev.delta.stop_reason;
          return "";
        case "message_stop":
          complete = true;
          return "";
        case "error":
          throw endpointError(ev.error);
        default:
          return "";   // ping, and whatever a later protocol adds
      }
    },
    // message_stop is the end marker; a stop_reason (message_delta) means the
    // reply itself is whole even if the connection closed right after it
    done: () => complete || !!msg.stop_reason,
    result() {
      // a tool_use whose JSON never reached content_block_stop is incomplete
      for (let i = 0; i < blocks.length; i++) {
        if (partial[i] != null && String(partial[i]).trim()) {
          const j = parseJson(partial[i]);
          if (!j.ok) throw new Error(STREAM_ENDED_EARLY);
          blocks[i].input = j.value;
        }
      }
      return { ...msg, content: blocks.filter(Boolean) };
    },
  };
}

/** OpenAI-style stream → { add(sse) → text delta | "", done(), result() }. */
export function openaiStreamAccumulator() {
  let text = "";
  let role = "assistant";
  let finish = null;
  let sawDone = false;
  const calls = [];   // by index
  return {
    add(sse) {
      if (sse.data.trim() === "[DONE]") { sawDone = true; return ""; }
      const p = parseJson(sse.data);
      if (!p.ok || !p.value || typeof p.value !== "object") return "";
      const chunk = p.value;
      if (chunk.error) throw endpointError(chunk.error);
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      if (!choice) return "";
      if (choice.finish_reason) finish = choice.finish_reason;
      const d = choice.delta || choice.message || {};
      if (typeof d.role === "string") role = d.role;
      for (const [k, tc] of (Array.isArray(d.tool_calls) ? d.tool_calls : []).entries()) {
        if (!tc || typeof tc !== "object") continue;
        const i = Number.isInteger(tc.index) ? tc.index : k;
        const c = calls[i] || (calls[i] = { id: "", type: "function", function: { name: "", arguments: "" } });
        if (typeof tc.id === "string" && tc.id) c.id = tc.id;
        const fn = tc.function || {};
        // the name normally arrives once; a runtime that repeats it is not doubled
        if (typeof fn.name === "string" && fn.name && fn.name !== c.function.name) c.function.name += fn.name;
        if (typeof fn.arguments === "string") c.function.arguments += fn.arguments;
        else if (fn.arguments && typeof fn.arguments === "object") c.function.arguments = JSON.stringify(fn.arguments);
      }
      if (typeof d.content === "string" && d.content) { text += d.content; return d.content; }
      return "";
    },
    done: () => sawDone || !!finish,
    result() {
      const tool_calls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
      return {
        choices: [{
          index: 0,
          message: { role, content: text || null, ...(tool_calls.length ? { tool_calls } : {}) },
          finish_reason: finish,
        }],
      };
    },
  };
}

const accumulatorFor = (provider) => (provider === "anthropic" ? anthropicStreamAccumulator() : openaiStreamAccumulator());

const say = (onTextDelta, d) => { if (d) { try { onTextDelta?.(d); } catch { /* a listener never breaks the stream */ } } };

/** A whole SSE body already in hand (a runtime that streamed with the wrong
 *  content type, or a test) → the assembled reply. Throws like readChatStream.
 * @param {string} provider @param {string} text
 * @param {{ onTextDelta?: (text: string) => void }} [opts] */
export function parseChatStreamText(provider, text, { onTextDelta } = {}) {
  const acc = accumulatorFor(provider);
  const parser = createSseParser();
  for (const ev of [...parser.push(String(text || "")), ...parser.flush()]) say(onTextDelta, acc.add(ev));
  if (!acc.done()) throw new Error(STREAM_ENDED_EARLY);
  return acc.result();
}

/** Does this text look like an event stream rather than a JSON body? */
export function looksLikeSse(text) {
  return /^(?:\s*(?::[^\n]*|event:[^\n]*|id:[^\n]*|retry:[^\n]*)\r?\n)*\s*data:/.test(String(text || ""));
}

const abortError = () => {
  try { return new DOMException("The operation was aborted.", "AbortError"); }
  catch { const e = new Error("The operation was aborted."); e.name = "AbortError"; return e; }
};

/** Read a streamed reply off a ReadableStream body.
 *  onTextDelta(text) fires for every piece of answer text as it arrives;
 *  onActivity() for every chunk (ai.js re-arms its idle timeout on it).
 *  Resolves the assembled assistant message (the non-streaming JSON shape).
 *  Rejects: AbortError when `signal` aborts (the body is cancelled, so the
 *  connection closes); a plain-language Error for a dropped connection, an
 *  in-stream error event, or a stream that ends early.
 * @param {{ provider: string, body: any, signal?: AbortSignal, onTextDelta?: (text: string) => void, onActivity?: () => void }} opts */
export async function readChatStream({ provider, body, signal, onTextDelta, onActivity }) {
  if (!body || typeof body.getReader !== "function") throw new Error("The endpoint said it was streaming, but sent no stream.");
  const acc = accumulatorFor(provider);
  const parser = createSseParser();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  // Stop wins even when the body doesn't watch the signal itself: cancelling
  // the reader resolves the pending read, and the abort is reported below.
  const onAbort = () => { reader.cancel().catch(() => {}); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    for (;;) {
      let step;
      try {
        step = await reader.read();
      } catch (e) {
        if (signal?.aborted || e?.name === "AbortError") throw abortError();
        throw new Error("The connection dropped in the middle of the reply. Check the endpoint, then ask again.");
      }
      if (signal?.aborted) throw abortError();
      if (step.done) break;
      try { onActivity?.(); } catch { /* timer upkeep only */ }
      const chunk = typeof step.value === "string" ? step.value : decoder.decode(step.value, { stream: true });
      for (const ev of parser.push(chunk)) say(onTextDelta, acc.add(ev));
    }
    for (const ev of [...parser.push(decoder.decode()), ...parser.flush()]) say(onTextDelta, acc.add(ev));
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
    try { reader.releaseLock(); } catch { /* already released / cancelled */ }
  }
  if (!acc.done()) throw new Error(STREAM_ENDED_EARLY);
  return acc.result();
}
