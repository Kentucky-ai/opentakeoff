// Recognizer M1 tests (RFC #59 recognizer slice), two tiers:
//   - wav.ts is PURE and always gated hard here (decode/encode/resample are
//     the shared front-end for BOTH the corpus harness and live capture — an
//     error here corrupts every accuracy number downstream);
//   - the engine smoke needs the staged model (web/public/models — run
//     `node scripts/fetch-voice-model.mjs`); absent, it SKIPS LOUDLY. It only
//     proves the engine initializes headlessly and decodes without throwing —
//     accuracy is the corpus harness's job, with real recorded speech.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { decodeWav, encodeWav16, resampleTo, wavToModelPcm, WHISPER_SAMPLE_RATE } from "../src/lib/stt/wav.ts";
import { createEngine } from "../src/lib/stt/recognizer.ts";

// ── wav.ts (pure, always run) ───────────────────────────────────────────────

const sine = (rate: number, secs: number, hz = 440) => {
  const out = new Float32Array(Math.round(rate * secs));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate) * 0.5;
  return out;
};

test("wav: encode16 → decode round-trips shape, rate, and content", () => {
  const pcm = sine(16000, 0.25);
  const wav = encodeWav16(pcm, 16000);
  const back = decodeWav(wav);
  assert.equal(back.sampleRate, 16000);
  assert.equal(back.samples.length, pcm.length);
  let maxErr = 0;
  for (let i = 0; i < pcm.length; i++) maxErr = Math.max(maxErr, Math.abs(back.samples[i] - pcm[i]));
  assert.ok(maxErr < 1 / 32000, `16-bit quantization error bound, got ${maxErr}`);
});

test("wav: resample 48k → 16k gives 1/3 length; same-rate is pass-through", () => {
  const pcm = sine(48000, 0.5);
  const down = resampleTo(pcm, 48000, 16000);
  assert.ok(Math.abs(down.length - pcm.length / 3) <= 2, `len ${down.length} vs ${pcm.length / 3}`);
  assert.equal(resampleTo(pcm, 48000, 48000), pcm);
});

test("wav: wavToModelPcm normalizes a 44.1k file to 16k", () => {
  const wav = encodeWav16(sine(44100, 0.2), 44100);
  const pcm = wavToModelPcm(wav);
  assert.ok(Math.abs(pcm.length - 0.2 * WHISPER_SAMPLE_RATE) <= 4, `got ${pcm.length}`);
});

test("wav: garbage and truncated files throw, never guess", () => {
  assert.throws(() => decodeWav(new Uint8Array([1, 2, 3])));
  assert.throws(() => decodeWav(new TextEncoder().encode("RIFFxxxxWAVEbut-no-chunks-here-at-all-padding")));
});

// ── engine smoke (needs staged model; skips loudly otherwise) ──────────────

const modelsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "models");
const modelPresent = existsSync(join(modelsDir, "Xenova", "whisper-tiny.en", "onnx"));

test("engine smoke: transformers-js initializes headlessly and decodes silence without throwing", { skip: modelPresent ? false : "voice model not staged — run: node scripts/fetch-voice-model.mjs" }, async () => {
  const engine = await createEngine("transformers-js");
  await engine.init({ baseUrl: modelsDir });
  const text = await engine.transcribe(new Float32Array(WHISPER_SAMPLE_RATE)); // 1 s silence
  assert.equal(typeof text, "string"); // whisper may hallucinate punctuation on silence; string-ness is the smoke bar
  await engine.dispose();
});

test("engine smoke: whisper-cpp adapter refuses loudly until wired (benchmark-only)", async () => {
  const engine = await createEngine("whisper-cpp");
  await assert.rejects(() => engine.init({ baseUrl: modelsDir }), /benchmark-only|not wired/);
});
