// Bring-your-own-AI — strictly opt-in, dormant until configured.
//
// The in-canvas takeoff agent (agentLoop.js) runs on a vision model YOU
// provide. You point it at an endpoint you control: a hosted API or a local
// runtime on your own machine (most local runtimes speak the OpenAI-style
// protocol). Nothing is ever sent anywhere except the agent's requests to YOUR
// endpoint, while a run you started is going; unconfigured builds make zero AI
// network calls. No telemetry.
// The code is open so anyone can audit exactly this.
//
// Config lives per-browser (localStorage) with build-time VITE_* fallbacks for
// self-hosted team deploys. WARNING for deployers: Vite inlines VITE_AI_KEY
// into the shipped JS bundle — anyone who can load the page can read it.
// Never set it on a public deploy; it exists for private/team builds only.

import { clampHistoryTurns } from "./agentChat.js";
import { looksLikeSse, parseChatStreamText, readChatStream } from "./chatStream.js";

const KEYS = {
  endpoint: "opentakeoff_ai_endpoint",
  apiKey: "opentakeoff_ai_key",
  model: "opentakeoff_ai_model",
  provider: "opentakeoff_ai_provider",
  historyTurns: "opentakeoff_ai_history_turns",
};

const env = (name) => (import.meta.env && import.meta.env[name]) || "";

function readKey(k, envName) {
  try {
    const v = localStorage.getItem(KEYS[k]);
    if (v) return v;
  } catch { /* private mode */ }
  return env(envName);
}

/** Current config. provider: "openai" (OpenAI-style — the default; local
 *  runtimes speak it) | "anthropic" (Anthropic-style). historyTurns: how many
 *  earlier chat turns ride along with each new message (0–20, default 8 —
 *  "Conversation memory" in AI settings). */
export function aiConfig() {
  return {
    endpoint: readKey("endpoint", "VITE_AI_ENDPOINT"),
    apiKey: readKey("apiKey", "VITE_AI_KEY"),
    model: readKey("model", "VITE_AI_MODEL"),
    provider: readKey("provider", "VITE_AI_PROVIDER") || "openai",
    historyTurns: clampHistoryTurns(readKey("historyTurns", "VITE_AI_HISTORY_TURNS")),
  };
}

/** Configured = endpoint + model. A key is optional — local runtimes need none. */
export function isAiConfigured() {
  const c = aiConfig();
  return !!(c.endpoint && c.model);
}

export function saveAiConfig({ endpoint, apiKey, model, provider, historyTurns }) {
  try {
    for (const [k, v] of [["endpoint", endpoint], ["apiKey", apiKey], ["model", model], ["provider", provider]]) {
      if (v) localStorage.setItem(KEYS[k], v);
      else localStorage.removeItem(KEYS[k]);
    }
    // 0 is a real choice (no memory), so this one is stored whenever it's set;
    // blank / missing goes back to the default
    if (historyTurns === "" || historyTurns == null) localStorage.removeItem(KEYS.historyTurns);
    else localStorage.setItem(KEYS.historyTurns, String(clampHistoryTurns(historyTurns)));
  } catch { /* private mode */ }
}

// ── pure request plumbing (unit-tested; no fetch, no DOM) ───────────────────

/** Base URL → full request URL. A path that already ends in the protocol's
 *  completion route is used as-is; otherwise the standard route is appended. */
export function aiRequestUrl(endpoint, provider) {
  const base = (endpoint || "").replace(/\/+$/, "");
  if (provider === "anthropic") {
    return /\/messages$/.test(base) ? base : `${base}/v1/messages`;
  }
  return /\/chat\/completions$/.test(base) ? base : `${base}/v1/chat/completions`;
}

/** One vision request: an image + a question. Returns {url, headers, body}
 *  (body as an object — the caller JSON.stringifies). */
export function buildVisionRequest(cfg, { imageDataUrl, prompt, maxTokens = 100 }) {
  const url = aiRequestUrl(cfg.endpoint, cfg.provider);
  if (cfg.provider === "anthropic") {
    const m = /^data:(image\/\w+);base64,(.*)$/s.exec(imageDataUrl) || [];
    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      // the protocol's explicit acknowledgment that the key lives client-side —
      // which is exactly the bring-your-own-key model here
      "anthropic-dangerous-direct-browser-access": "true",
    };
    if (cfg.apiKey) headers["x-api-key"] = cfg.apiKey;
    return {
      url, headers,
      body: {
        model: cfg.model, max_tokens: maxTokens,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: m[1] || "image/jpeg", data: m[2] || "" } },
          { type: "text", text: prompt },
        ] }],
      },
    };
  }
  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  return {
    url, headers,
    body: {
      model: cfg.model, max_tokens: maxTokens,
      messages: [{ role: "user", content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ] }],
    },
  };
}

/** Model reply JSON → trimmed text, or null when there's none to be had. */
export function parseVisionResponse(provider, json) {
  if (!json || typeof json !== "object") return null;
  if (provider === "anthropic") {
    if (json.stop_reason === "refusal") return null;
    const block = Array.isArray(json.content) ? json.content.find((b) => b && b.type === "text") : null;
    return block && typeof block.text === "string" ? block.text.trim() : null;
  }
  const content = json.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const text = content.filter((p) => p && typeof p.text === "string").map((p) => p.text).join(" ").trim();
    return text || null;
  }
  return null;
}

/** Constrained scale-reading prompt: exactly one known label, or UNKNOWN. */
export function scaleReadPrompt(labels) {
  return `This image is the title block region of a construction drawing. Find the stated drawing scale (usually after the word SCALE). Reply with exactly one of the following labels, character for character, or the single word UNKNOWN if no scale is stated. Labels: ${labels.join(" | ")}. Reply with the label only — no other words.`;
}

/** One chat-with-tools turn: system + running messages + tool declarations.
 *  Returns {url, headers, body} (body as an object — the caller stringifies).
 *  Same key/endpoint handling as buildVisionRequest; `messages` and `tools`
 *  are already in the PROVIDER's own shape (agentLoop owns that translation —
 *  Anthropic-style tools/tool_use/tool_result vs OpenAI-style function
 *  calling), so this stays pure request plumbing. */
export function buildChatRequest(cfg, { system, messages, tools, maxTokens = 4096, stream = false }) {
  const streamFlag = stream ? { stream: true } : {};
  const url = aiRequestUrl(cfg.endpoint, cfg.provider);
  if (cfg.provider === "anthropic") {
    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
    if (cfg.apiKey) headers["x-api-key"] = cfg.apiKey;
    return { url, headers, body: { model: cfg.model, max_tokens: maxTokens, ...(system ? { system } : {}), messages, ...(tools?.length ? { tools } : {}), ...streamFlag } };
  }
  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  return {
    url, headers,
    body: {
      model: cfg.model, max_tokens: maxTokens,
      messages: [...(system ? [{ role: "system", content: system }] : []), ...messages],
      ...(tools?.length ? { tools } : {}),
      ...streamFlag,
    },
  };
}

// ── the seam every AI consumer goes through ─────────────────────────────────

/** Send one vision query to the user's configured endpoint. Throws with a
 *  plain-language message on any failure. */
export async function visionQuery({ imageDataUrl, prompt, maxTokens = 100 }) {
  const cfg = aiConfig();
  if (!isAiConfigured()) throw new Error("AI isn't configured — open AI settings first.");
  const { url, headers, body } = buildVisionRequest(cfg, { imageDataUrl, prompt, maxTokens });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal });
  } catch (e) {
    throw new Error(e?.name === "AbortError"
      ? "The endpoint took more than 30 seconds — check the model is loaded."
      : "Couldn't reach the endpoint — check the URL, and that it allows browser requests (CORS).");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`AI request failed (HTTP ${res.status}).`);
  const text = parseVisionResponse(cfg.provider, await res.json().catch(() => null));
  if (text == null) throw new Error("The endpoint replied, but not with text.");
  return text;
}

// Endpoints seen NOT to stream this session (they refused `stream`, or
// answered it with plain JSON), keyed by request URL + model: later turns ask
// them for plain JSON straight away instead of paying a refused request each
// time. Memory only — a reload tries streaming again.
const noStream = new Set();
/** Forget which endpoints refused to stream (tests; a settings change). */
export function forgetStreamSupport() { noStream.clear(); }

// A runtime that doesn't understand `stream: true` typically rejects the body
// (400 / 422) or the mode (415 / 501). Those get ONE plain retry; any other
// status (401, 429, 5xx…) is the endpoint's real answer and is reported.
const STREAM_REFUSED = new Set([400, 415, 422, 501]);
const TURN_IDLE_MS = 120000;

/** Send one chat-with-tools request (the agent loop's transport). Same
 *  config/endpoint machinery as visionQuery — the user's own key, their own
 *  endpoint, nothing else; no telemetry.
 *
 *  stream: true asks the endpoint to stream (Anthropic Messages SSE /
 *  OpenAI-style `stream: true`); every piece of answer text then goes to
 *  onTextDelta as it arrives, tool calls assemble in full, and the resolved
 *  value is the SAME assistant JSON a non-streaming reply would have been.
 *  An endpoint that refuses `stream` (400/415/422/501) is retried once
 *  without it; one that answers plain JSON is simply read as JSON. Either way
 *  it's remembered for the session (forgetStreamSupport).
 *
 *  Throws with a plain-language message on any transport failure; an
 *  AbortError from the caller's signal (Stop) is re-thrown as an AbortError so
 *  the loop can tell "stopped" from "broken", mid-stream included. The 2-minute
 *  timeout is an IDLE timeout: it re-arms on every streamed chunk, so a long
 *  answer that keeps arriving is never cut off.
 *  `cfg`/`fetchFn` are injectable for tests (default: live config + fetch).
 * @param {{
 *   cfg?: { endpoint: string, apiKey?: string, model: string, provider?: string },
 *   system?: string, messages: any[], tools?: any[], maxTokens?: number,
 *   signal?: AbortSignal, fetchFn?: typeof fetch,
 *   stream?: boolean, onTextDelta?: (text: string) => void,
 * }} opts */
export async function chatWithTools({ cfg, system, messages, tools, maxTokens = 4096, signal, fetchFn, stream = false, onTextDelta }) {
  const c = cfg || aiConfig();
  if (!(c.endpoint && c.model)) throw new Error("AI isn't configured — open AI settings first.");
  const provider = c.provider === "anthropic" ? "anthropic" : "openai";
  const memo = `${aiRequestUrl(c.endpoint, c.provider)}\n${c.model}`;
  let wantStream = !!stream && !noStream.has(memo);

  // one controller per call: the caller's Stop, or the idle timer, aborts it
  const ctl = new AbortController();
  let timedOut = false;
  let timer = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; ctl.abort(); }, TURN_IDLE_MS);
  };
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const stopped = () => !!signal?.aborted;
  const abortError = () => { const e = new Error("The operation was aborted."); e.name = "AbortError"; return e; };
  const idle = () => new Error("The endpoint went quiet for more than 2 minutes — check the model is loaded.");

  const send = async (asStream) => {
    const { url, headers, body } = buildChatRequest(c, { system, messages, tools, maxTokens, stream: asStream });
    arm();
    try {
      return await (fetchFn || fetch)(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      if (stopped()) throw abortError();
      if (timedOut || e?.name === "TimeoutError") throw idle();
      if (e?.name === "AbortError") throw e;
      throw new Error("Couldn't reach the endpoint — check the URL, and that it allows browser requests (CORS).");
    }
  };

  try {
    let res = await send(wantStream);
    if (wantStream && !res.ok && STREAM_REFUSED.has(res.status)) {
      // the runtime may not know `stream` — ask again, plainly, once
      noStream.add(memo);
      wantStream = false;
      try { await res.body?.cancel?.(); } catch { /* nothing to drain */ }
      res = await send(false);
    }
    if (!res.ok) throw new Error(`AI request failed (HTTP ${res.status}).`);

    const type = typeof res.headers?.get === "function" ? String(res.headers.get("content-type") || "") : "";
    if (wantStream && /text\/event-stream/i.test(type) && res.body && typeof res.body.getReader === "function") {
      try {
        return await readChatStream({ provider, body: res.body, signal: ctl.signal, onTextDelta, onActivity: arm });
      } catch (e) {
        if (stopped()) throw abortError();
        if (timedOut) throw idle();
        throw e;
      }
    }

    // not an event stream (or streaming wasn't asked for): read the body as
    // text when the response can, so a stream sent with the wrong content
    // type is still understood; minimal fetch stubs with only json() work too
    let json = null;
    try {
      if (typeof res.text === "function") {
        const raw = await res.text();
        if (wantStream && looksLikeSse(raw)) return parseChatStreamText(provider, raw, { onTextDelta });
        try { json = JSON.parse(raw); } catch { json = null; }
      } else {
        json = await res.json().catch(() => null);
      }
    } catch (e) {
      if (stopped()) throw abortError();
      if (timedOut) throw idle();
      throw e;
    }
    if (wantStream) noStream.add(memo);   // it answered `stream: true` with plain JSON
    if (!json || typeof json !== "object") throw new Error("The endpoint replied, but not with JSON.");
    return json;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}
