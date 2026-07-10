// Bring-your-own-AI — strictly opt-in, dormant until configured.
//
// OpenTakeoff can ask a vision model YOU provide to read things off the plan —
// starting with the drawn scale when the sheet text doesn't state one. You
// point it at an endpoint you control: a hosted API or a local runtime on your
// own machine (most local runtimes speak the OpenAI-style protocol). Nothing is
// ever sent anywhere except the single, user-initiated request to YOUR
// endpoint; unconfigured builds make zero AI network calls. No telemetry.
// The code is open so anyone can audit exactly this.
//
// Config lives per-browser (localStorage) with build-time VITE_* fallbacks for
// self-hosted team deploys. WARNING for deployers: Vite inlines VITE_AI_KEY
// into the shipped JS bundle — anyone who can load the page can read it.
// Never set it on a public deploy; it exists for private/team builds only.

const KEYS = {
  endpoint: "opentakeoff_ai_endpoint",
  apiKey: "opentakeoff_ai_key",
  model: "opentakeoff_ai_model",
  provider: "opentakeoff_ai_provider",
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
 *  runtimes speak it) | "anthropic" (Anthropic-style). */
export function aiConfig() {
  return {
    endpoint: readKey("endpoint", "VITE_AI_ENDPOINT"),
    apiKey: readKey("apiKey", "VITE_AI_KEY"),
    model: readKey("model", "VITE_AI_MODEL"),
    provider: readKey("provider", "VITE_AI_PROVIDER") || "openai",
  };
}

/** Configured = endpoint + model. A key is optional — local runtimes need none. */
export function isAiConfigured() {
  const c = aiConfig();
  return !!(c.endpoint && c.model);
}

export function saveAiConfig({ endpoint, apiKey, model, provider }) {
  try {
    for (const [k, v] of [["endpoint", endpoint], ["apiKey", apiKey], ["model", model], ["provider", provider]]) {
      if (v) localStorage.setItem(KEYS[k], v);
      else localStorage.removeItem(KEYS[k]);
    }
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
