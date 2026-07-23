// Stage the voice model for dev/CI/self-hosting (RFC #59 recognizer slice).
//
// Downloads the whisper-tiny.en ONNX artifacts into web/public/models/ so the
// app serves them SAME-ORIGIN — the client-only pledge means the running app
// never talks to a model CDN; this script is the only place the network is
// involved, and it runs at build/dev time, never in the app. The directory is
// gitignored (≈45 MB doesn't belong in git history); CI restores it from
// actions/cache keyed on MODEL_REV.
//
//   node scripts/fetch-voice-model.mjs          # skip files already present
//   node scripts/fetch-voice-model.mjs --force  # re-download everything
//
// Voice simply stays off ("Voice not installed on this deployment") when the
// files are absent — feature-absence, never breakage.
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL_ID = "onnx-community/whisper-tiny.en";
const MODEL_REV = "main"; // bump deliberately; cache keys + PR notes reference it
const FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_uint8.onnx",
];

const here = dirname(fileURLToPath(import.meta.url));
const destRoot = join(here, "..", "public", "models", MODEL_ID);
const force = process.argv.includes("--force");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

let total = 0;
for (const file of FILES) {
  const dest = join(destRoot, file);
  mkdirSync(dirname(dest), { recursive: true });
  if (!force && existsSync(dest)) {
    const buf = readFileSync(dest);
    total += buf.length;
    console.log(`  = ${file}  ${(buf.length / 1e6).toFixed(1)} MB  sha256 ${sha256(buf).slice(0, 12)}… (cached)`);
    continue;
  }
  const url = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REV}/${file}`;
  process.stdout.write(`  ↓ ${file} … `);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`FAILED ${res.status} ${res.statusText} — ${url}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  total += buf.length;
  console.log(`${(buf.length / 1e6).toFixed(1)} MB  sha256 ${sha256(buf).slice(0, 12)}…`);
}
console.log(`voice model staged: ${MODEL_ID}@${MODEL_REV} → ${destRoot} (${(total / 1e6).toFixed(1)} MB total)`);
// (The onnxruntime-web runtime itself needs no staging: the adapter imports it
// through Vite's asset pipeline with `?url`, so it ships same-origin in
// dist/assets/ automatically — dev and build alike.)
