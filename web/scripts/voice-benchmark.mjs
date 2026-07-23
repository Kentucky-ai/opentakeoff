// Voice engine benchmark (RFC #59 — "part of this RFC is picking one with
// benchmarks"). Runs the recognizer over a directory of WAVs and prints a
// markdown table: model size, cold init, decode speed, memory, and — when
// filenames follow the corpus convention (s1-quiet-p01.wav) — intent accuracy
// against the committed phrase table.
//
//   node --import tsx scripts/voice-benchmark.mjs [--dir <wav-dir>]
//
// Engine findings this table accompanies (docs/VOICE.md):
//   - transformers.js (whisper-tiny.en ONNX, q8 encoder + uint8 decoder,
//     single-thread wasm in-browser / native CPU in Node) — the shipped engine.
//   - whisper.cpp WASM — NOT browser-viable on this deployment: maintained
//     wrappers require SharedArrayBuffer, and OpenTakeoff deliberately ships
//     no COOP/COEP (adding them breaks the cross-origin font/GIS loads under
//     the current CSP). Recorded as the benchmark's decisive constraint.
//   - q4 decoder variant — evaluated and rejected: 86.7 MB vs 30.7 MB AND
//     audibly worse transcripts on the same audio.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { wavToModelPcm } from "../src/lib/stt/wav.ts";
import { createEngine } from "../src/lib/stt/recognizer.ts";
import { parseVoiceIntent } from "../src/lib/voiceIntent.ts";

const here = dirname(fileURLToPath(import.meta.url));
const modelsDir = join(here, "..", "public", "models");
const modelRoot = join(modelsDir, "onnx-community", "whisper-tiny.en");
const argDir = process.argv.indexOf("--dir");
const wavDir = argDir > -1 ? process.argv[argDir + 1] : join(here, "..", "test", "fixtures", "voice");

if (!existsSync(join(modelRoot, "onnx"))) {
  console.error("voice model not staged — run: node scripts/fetch-voice-model.mjs");
  process.exit(1);
}
const wavs = existsSync(wavDir) ? readdirSync(wavDir).filter((f) => f.endsWith(".wav")).sort() : [];
if (!wavs.length) {
  console.error(`no WAVs in ${wavDir} — record the corpus (test/fixtures/voice/RECORDING.md) or pass --dir`);
  process.exit(1);
}

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const modelBytes = walk(modelRoot).reduce((a, f) => a + statSync(f).size, 0);

const table = JSON.parse(readFileSync(join(here, "..", "test", "fixtures", "voice", "phrases.json"), "utf8"));
const HARNESS_CTX = { conditionTags: ["CPT-1", "VCT-1", "RB-1"], shapeLabels: ["Phase 1"], hasActiveCondition: true };

const engine = await createEngine("transformers-js");
const t0 = performance.now();
await engine.init({ baseUrl: modelsDir });
const initMs = performance.now() - t0;

let audioSecs = 0, decodeMs = 0, hits = 0, scored = 0;
for (const f of wavs) {
  const pcm = wavToModelPcm(new Uint8Array(readFileSync(join(wavDir, f))));
  audioSecs += pcm.length / 16000;
  const t1 = performance.now();
  const text = await engine.transcribe(pcm);
  decodeMs += performance.now() - t1;
  const m = /-(p\d\d)\.wav$/.exec(f);
  const phrase = m && table.phrases[m[1]];
  if (phrase) {
    scored++;
    const parsed = parseVoiceIntent(text, HARNESS_CTX);
    const e = phrase.expect;
    const ok = e.reject ? !parsed.ok : parsed.ok && parsed.intent.kind === e.kind;
    if (ok) hits++;
  }
}
const rssMb = process.memoryUsage().rss / 1e6;
await engine.dispose();

console.log(`\naudio source: ${wavDir} (${wavs.length} files, ${audioSecs.toFixed(1)} s)\n`);
console.log(`| engine | model size | cold init | decode speed | peak RSS | intent accuracy |`);
console.log(`|---|---|---|---|---|---|`);
console.log(
  `| transformers.js (tiny.en q8/uint8, ${typeof process !== "undefined" ? "Node native CPU" : "wasm"}) | ${(modelBytes / 1e6).toFixed(1)} MB | ${initMs.toFixed(0)} ms | ${(audioSecs / (decodeMs / 1000)).toFixed(1)}× faster than realtime | ${rssMb.toFixed(0)} MB | ${scored ? `${hits}/${scored}` : "n/a"} |`,
);
console.log(`| whisper.cpp WASM | — | — | — | — | not browser-viable here: needs SharedArrayBuffer (no COOP/COEP on this deployment) |`);
