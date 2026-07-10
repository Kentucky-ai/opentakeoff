// Bring-your-own-AI seam — the pure request plumbing (no fetch, no DOM).
// The module must also import cleanly under node (no localStorage, no
// import.meta.env) — that itself is under test here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aiConfig, isAiConfigured, aiRequestUrl, buildVisionRequest, parseVisionResponse, scaleReadPrompt,
} from "../src/lib/ai.js";
import { scaleFromLabel, STANDARD_SCALES } from "../src/lib/sheets.js";

const IMG = "data:image/jpeg;base64,QUJD"; // "ABC"

test("config is safely empty under node (no localStorage, no env)", () => {
  const c = aiConfig();
  assert.equal(c.endpoint, "");
  assert.equal(c.model, "");
  assert.equal(c.provider, "openai");
  assert.equal(isAiConfigured(), false);
});

test("aiRequestUrl appends the protocol route unless already present", () => {
  assert.equal(aiRequestUrl("http://localhost:1234", "openai"), "http://localhost:1234/v1/chat/completions");
  assert.equal(aiRequestUrl("http://localhost:1234/", "openai"), "http://localhost:1234/v1/chat/completions");
  assert.equal(aiRequestUrl("https://x.test/v1/chat/completions", "openai"), "https://x.test/v1/chat/completions");
  assert.equal(aiRequestUrl("https://x.test", "anthropic"), "https://x.test/v1/messages");
  assert.equal(aiRequestUrl("https://x.test/v1/messages", "anthropic"), "https://x.test/v1/messages");
});

test("anthropic-style request: headers, base64 stripping, image-then-text", () => {
  const cfg = { endpoint: "https://x.test", apiKey: "k1", model: "m1", provider: "anthropic" };
  const { url, headers, body } = buildVisionRequest(cfg, { imageDataUrl: IMG, prompt: "q", maxTokens: 50 }) as any;
  assert.equal(url, "https://x.test/v1/messages");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(headers["x-api-key"], "k1");
  assert.equal(body.model, "m1");
  assert.equal(body.max_tokens, 50);
  const [img, txt] = body.messages[0].content as any[];
  assert.equal(img.type, "image");
  assert.equal(img.source.media_type, "image/jpeg");
  assert.equal(img.source.data, "QUJD");           // no data: prefix
  assert.equal(txt.text, "q");
});

test("anthropic-style request: no x-api-key header without a key", () => {
  const cfg = { endpoint: "https://x.test", apiKey: "", model: "m", provider: "anthropic" };
  const { headers } = buildVisionRequest(cfg, { imageDataUrl: IMG, prompt: "q" }) as any;
  assert.ok(!("x-api-key" in headers));
});

test("openai-style request: bearer iff key, full data URL", () => {
  const withKey = buildVisionRequest({ endpoint: "http://localhost:1234", apiKey: "k", model: "m", provider: "openai" }, { imageDataUrl: IMG, prompt: "q" }) as any;
  assert.equal(withKey.headers.Authorization, "Bearer k");
  const [txt, img] = withKey.body.messages[0].content as any[];
  assert.equal(txt.type, "text");
  assert.equal(img.image_url.url, IMG);            // full data URL, prefix kept
  const noKey = buildVisionRequest({ endpoint: "http://localhost:1234", apiKey: "", model: "m", provider: "openai" }, { imageDataUrl: IMG, prompt: "q" }) as any;
  assert.ok(!("Authorization" in noKey.headers));
});

test("parseVisionResponse: both shapes, refusal, malformed", () => {
  assert.equal(parseVisionResponse("anthropic", { content: [{ type: "text", text: " 1:50 " }] }), "1:50");
  assert.equal(parseVisionResponse("anthropic", { stop_reason: "refusal", content: [{ type: "text", text: "no" }] }), null);
  assert.equal(parseVisionResponse("anthropic", { content: [] }), null);
  assert.equal(parseVisionResponse("openai", { choices: [{ message: { content: "UNKNOWN" } }] }), "UNKNOWN");
  assert.equal(parseVisionResponse("openai", { choices: [{ message: { content: [{ type: "text", text: "1/4\" = 1'-0\"" }] } }] }), "1/4\" = 1'-0\"");
  assert.equal(parseVisionResponse("openai", {}), null);
  assert.equal(parseVisionResponse("openai", null), null);
});

test("scaleReadPrompt names every label and UNKNOWN", () => {
  const labels = STANDARD_SCALES.map((s) => s.label);
  const p = scaleReadPrompt(labels);
  for (const l of labels) assert.ok(p.includes(l), `prompt missing ${l}`);
  assert.match(p, /UNKNOWN/);
});

test("scaleFromLabel: exact labels, embedded text, boundaries, ambiguity", () => {
  assert.equal(scaleFromLabel('1/4" = 1\'-0"')?.label, '1/4" = 1\'-0"');
  assert.equal(scaleFromLabel('the scale is 1:50 here')?.label, "1:50");
  assert.equal(scaleFromLabel("1:500")?.label, "1:500");     // never its 1:50 prefix
  assert.equal(scaleFromLabel("UNKNOWN"), null);
  assert.equal(scaleFromLabel(" unknown "), null);
  assert.equal(scaleFromLabel(""), null);
  assert.equal(scaleFromLabel('1/4" = 1\'-0" or 1/8" = 1\'-0"'), null);  // two hits → suggest nothing
});
