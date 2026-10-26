// Stage the on-device OCR models for dev, CI and self-hosting (#469).
//
// Downloads PaddlePaddle's official PP-OCRv5 mobile detection and English
// recognition models into web/public/models/ocr/, so the app serves them from
// its own origin. The running app never talks to a model host; this script is
// the only place the network is involved, and it runs at build or dev time.
//
//   node scripts/stage-ocr-model.mjs
//
// Every file is checked against a SHA-256 pinned below, including a file that
// is already on disk (a corrupt one is downloaded again). A download gives up
// after FETCH_TIMEOUT_MS, or as soon as it runs past its pinned size.
// manifest.json is deleted first and written last (to a temp file, then
// renamed), so an interrupted run leaves no manifest and the app reports OCR
// as not installed rather than half-installed. It is
// rewritten on every run, even when every model came from the cache, so a
// restored CI cache never carries a stale manifest.
//
// VITE_OCR=off (in the environment or a web/.env file) stages nothing and
// removes an earlier staging, so an off build ships no models. The directory is gitignored (under public/models/); CI
// restores it from actions/cache keyed on this script's hash.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvVars } from "./lib/env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");

// Bump when the model files change. The manifest's rev adds the ORT version,
// and the browser cache is named after the rev, so either bump retires the
// old cache and shows the download notice again.
export const MODEL_REV = "ppocrv5-mobile-en-1";
const hf = (repo, commit, file) => `https://huggingface.co/${repo}/resolve/${commit}/${file}`;

// Pinned to immutable Hugging Face commits. Both model cards state
// license: apache-2.0.
export const MODEL_FILES = [
  {
    name: "det",
    file: "det.onnx",
    url: hf("PaddlePaddle/PP-OCRv5_mobile_det_onnx", "e6f4fa85f00e168c862bc462aebca69eef9b3d3d", "inference.onnx"),
    bytes: 4826518,
    sha256: "a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d",
  },
  {
    name: "rec",
    file: "rec.onnx",
    url: hf("PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx", "3fafbc3b5dcf93dd72add9f48368be8a3a2cd33b", "inference.onnx"),
    bytes: 7848423,
    sha256: "b5f833dfc5d0eb71da397b4efa06ebeee9b431b690a47d6af40d77d8eabc557f",
  },
];

// Committed alongside this script. The yml is the rec model's own config from
// the same pinned commit, kept for provenance; the dict is derived from its
// PostProcess.character_dict (see parseCharacterDict).
const REC_YML = { path: join(here, "ocr/en_PP-OCRv5_mobile_rec.inference.yml"), sha256: "27e91d0582f40168aa218303c76e184bc78fa7a5d105aad0cfbad8458b441067" };
const DICT = { path: join(here, "ocr/ppocrv5_en_dict.txt"), sha256: "c60d46e9e01d500ed6388fe8681051eac9cf6692e0d57238315be171927a0a1b" };

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;

/** The character list from a PaddleOCR inference.yml's `character_dict:`
 *  block. Entries are YAML block-sequence scalars, plain or single-quoted
 *  (`- '0'`, `- ''''` for a quote, `- ±`). */
export function parseCharacterDict(yml) {
  const lines = yml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*character_dict:\s*$/.test(l));
  if (start < 0) throw new Error("no character_dict in inference.yml");
  const chars = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^\s*- (.*)$/.exec(line);
    if (!m) break;
    const v = m[1];
    if (v.startsWith('"')) throw new Error(`double-quoted dict entry not supported: ${v}`);
    chars.push(v.length >= 2 && v.startsWith("'") && v.endsWith("'") ? v.slice(1, -1).replaceAll("''", "'") : v);
  }
  return chars;
}

function checkCommitted({ path, sha256: want }) {
  const buf = readFileSync(path);
  const got = sha256(buf);
  if (got !== want) throw new Error(`sha256 mismatch for ${path}\n  want ${want}\n  got  ${got}`);
  return buf;
}

/** Default per-file download limit. A download that hangs longer fails the
 * run, and netlify.toml then deploys without OCR. */
export const FETCH_TIMEOUT_MS = 120_000;

/** Download one pinned file, stopping as soon as it runs past its size. */
async function download(f, fetchImpl, timeoutMs) {
  const res = await fetchImpl(f.url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${f.url}`);
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > f.bytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`${f.file} from ${f.url} is over its pinned ${f.bytes} bytes; stopped at ${n}`);
    }
    parts.push(value);
  }
  return Buffer.concat(parts, n);
}

/** Stage into `dest`. Throws on any failure; the caller decides the exit. */
export async function stage({
  dest = join(web, "public", "models", "ocr"),
  fetchImpl = globalThis.fetch,
  files = MODEL_FILES,
  env = process.env,
  ortDir = join(web, "node_modules", "onnxruntime-web"),
  log = console.log,
  timeoutMs = FETCH_TIMEOUT_MS,
  committed = { recYml: REC_YML, dict: DICT },
} = {}) {
  if (env.VITE_OCR === "off") {
    rmSync(dest, { recursive: true, force: true });
    log("VITE_OCR=off: on-device OCR not staged (public/models/ocr removed).");
    return { skipped: true };
  }
  mkdirSync(dest, { recursive: true });
  const manifestPath = join(dest, "manifest.json");
  // Written to a temp file and renamed (below). A run killed between the two
  // leaves the temp file, which the build would otherwise ship; drop it with
  // the old manifest.
  const tmp = `${manifestPath}.tmp`;
  rmSync(manifestPath, { force: true });
  rmSync(tmp, { force: true });

  const entries = [];
  for (const f of files) {
    const path = join(dest, f.file);
    if (existsSync(path)) {
      const buf = readFileSync(path);
      if (sha256(buf) === f.sha256) {
        log(`  = ${f.file}  ${mb(buf.length)}  sha256 ${f.sha256.slice(0, 12)}… (cached, verified)`);
        entries.push({ name: f.name, url: `/models/ocr/${f.file}`, bytes: buf.length, sha256: f.sha256 });
        continue;
      }
      log(`  ! ${f.file} on disk fails its sha256; downloading again`);
      rmSync(path);
    }
    const buf = await download(f, fetchImpl, timeoutMs);
    const got = sha256(buf);
    if (got !== f.sha256) throw new Error(`sha256 mismatch for ${f.file} from ${f.url}\n  want ${f.sha256}\n  got  ${got}`);
    writeFileSync(path, buf);
    log(`  ↓ ${f.file}  ${mb(buf.length)}  sha256 ${got.slice(0, 12)}… (verified)`);
    entries.push({ name: f.name, url: `/models/ocr/${f.file}`, bytes: buf.length, sha256: got });
  }

  const yml = checkCommitted(committed.recYml);
  const dict = checkCommitted(committed.dict);
  // The dict must be the yml's list laid out as blank + characters + space.
  const expected = "\n" + parseCharacterDict(yml.toString("utf8")).join("\n") + "\n";
  if (dict.toString("utf8") !== expected) throw new Error("ppocrv5_en_dict.txt does not match the rec model's character_dict");
  writeFileSync(join(dest, "dict.txt"), dict);
  entries.push({ name: "dict", url: "/models/ocr/dict.txt", bytes: dict.length, sha256: committed.dict.sha256 });

  // The ORT runtime wasm Vite ships (voice imports the same file with `?url`).
  // It has no url here: the worker gets the served URL from its own `?url`
  // import and checks the fetched bytes against this length and hash.
  const wasm = readFileSync(join(ortDir, "dist", "ort-wasm-simd-threaded.asyncify.wasm"));
  const ortVersion = JSON.parse(readFileSync(join(ortDir, "package.json"), "utf8")).version;
  entries.push({ name: "ort-wasm", bytes: wasm.length, sha256: sha256(wasm) });

  const manifest = { rev: `${MODEL_REV}+ort-${ortVersion}`, files: entries };
  // Written to a temp file and renamed: a run killed mid-write leaves no
  // manifest rather than a truncated one.
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(tmp, manifestPath);
  const total = entries.reduce((s, e) => s + e.bytes, 0);
  log(`On-device OCR staged: ${manifest.rev}, up to ${mb(total)} for a browser to download → ${dest}`);
  return { skipped: false, manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  stage({ env: await loadEnvVars(web, "production") }).catch((err) => {
    console.error(`stage-ocr-model: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
