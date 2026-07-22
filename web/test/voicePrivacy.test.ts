// Privacy proof (RFC #59 recognizer slice, testing-bar bullet 6): ZERO network
// I/O during dictation — the "No telemetry" stance extended to audio. Every
// network entry point (fetch, XMLHttpRequest, WebSocket) is replaced with a
// recorder BEFORE the engine loads, and the whole cycle — engine init, model
// load, transcribe — must complete with zero calls recorded. In Node the
// model loads from disk, so even init performs no network I/O; in the browser
// init fetches same-origin /models/ once and transcribe is pure compute (the
// manual devtools-network-log run documented in docs/VOICE.md covers that
// half). Skips loudly when the model isn't staged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createEngine } from "../src/lib/stt/recognizer.ts";
import { WHISPER_SAMPLE_RATE } from "../src/lib/stt/wav.ts";

const modelsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "models");
const modelPresent = existsSync(join(modelsDir, "onnx-community", "whisper-tiny.en", "onnx"));

test("privacy: a full dictation cycle performs ZERO network calls", { skip: modelPresent ? false : "voice model not staged — run: node scripts/fetch-voice-model.mjs", timeout: 300000 }, async () => {
  const calls: string[] = [];
  const g = globalThis as Record<string, unknown>;
  const orig = { fetch: g.fetch, XMLHttpRequest: g.XMLHttpRequest, WebSocket: g.WebSocket };
  g.fetch = (...args: unknown[]) => { calls.push(`fetch ${String(args[0])}`); return Promise.reject(new Error("network blocked by privacy test")); };
  g.XMLHttpRequest = class { constructor() { calls.push("XMLHttpRequest"); throw new Error("network blocked by privacy test"); } };
  g.WebSocket = class { constructor(url: unknown) { calls.push(`WebSocket ${String(url)}`); throw new Error("network blocked by privacy test"); } };

  try {
    const engine = await createEngine("transformers-js");
    await engine.init({ baseUrl: modelsDir });                       // disk only
    const pcm = new Float32Array(WHISPER_SAMPLE_RATE * 2);           // 2 s
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 20) * 0.05; // non-silence, content irrelevant
    const text = await engine.transcribe(pcm);                        // pure compute
    assert.equal(typeof text, "string");
    await engine.dispose();
  } finally {
    g.fetch = orig.fetch;
    g.XMLHttpRequest = orig.XMLHttpRequest;
    g.WebSocket = orig.WebSocket;
  }

  assert.deepEqual(calls, [], `network was touched during dictation: ${calls.join(", ")}`);
});
