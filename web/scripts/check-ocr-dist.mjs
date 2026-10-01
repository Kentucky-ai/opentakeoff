// Check a built dist/ for on-device OCR's shipping rules (#469).
//
//   npm run build && node scripts/check-ocr-dist.mjs
//
// It fails unless:
//   • dist/assets has exactly one ORT runtime wasm, the asyncify build that
//     voice and OCR share (vite.config.js aliases ppu's bare import to it);
//   • no chunk carries OpenCV or @napi-rs/canvas code, which ppu uses only
//     on Node (the word "opencv" alone is fine: ppu names its engines);
//   • with OCR on, the OCR worker chunk is there and loads that same wasm, so
//     the other checks can't pass on a build that has no OCR code in it (the
//     app's import of src/lib/ocr/client.ts is what builds the worker);
//   • a staged manifest's ort-wasm entry matches the wasm actually shipped,
//     byte for byte, since the worker checks the download against it;
//   • every other manifest file is a /models/ocr/ path present in dist at
//     the manifest's byte length;
//   • with VITE_OCR=off, dist has no models/ocr at all.
// No staged models is fine: the site then reports OCR as not installed.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvVars } from "./lib/env.mjs";

// Strings that only appear when the real library is bundled.
const FORBIDDEN = [
  { what: "OpenCV (opencv.js)", marker: "getBuildInformation" },
  { what: "@napi-rs/canvas", marker: "NAPI_RS_NATIVE_LIBRARY_PATH" },
  { what: "@napi-rs/canvas", marker: "@napi-rs/canvas-" },
];

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

/** Pure over a directory: { ok, errors, wasm } for a built dist. */
export function checkDist(distDir, env) {
  const errors = [];
  const files = listFiles(distDir).map((p) => relative(distDir, p).split("\\").join("/"));

  const wasms = files.filter((f) => /^assets\/ort-wasm[^/]*\.wasm$/.test(f));
  if (wasms.length !== 1) errors.push(`expected 1 ORT wasm in dist/assets, found ${wasms.length} ORT wasm files: ${wasms.join(", ") || "none"}`);
  const wasm = wasms.find((f) => f.includes(".asyncify-"));
  if (wasms.length && !wasm) errors.push(`the ORT wasm isn't the asyncify build: ${wasms.join(", ")}`);

  for (const f of files.filter((x) => /\.(m?js)$/.test(x))) {
    const text = readFileSync(join(distDir, f), "latin1");
    for (const { what, marker } of FORBIDDEN) {
      if (text.includes(marker)) errors.push(`${f} carries ${what} code (found "${marker}")`);
    }
  }

  if (env.VITE_OCR !== "off") {
    const workers = files.filter((f) => /^assets\/ocr\.worker-[^/]*\.js$/.test(f));
    if (!workers.length) errors.push("no assets/ocr.worker-*.js chunk: the build has no OCR code, so these checks prove nothing (the app's import of src/lib/ocr/client.ts builds the worker; is that import gone?)");
    for (const w of workers) {
      const text = readFileSync(join(distDir, w), "latin1");
      if (!wasm || !text.includes(wasm.slice("assets/".length))) errors.push(`${w} doesn't reference the shipped asyncify wasm${wasm ? ` (${wasm})` : ""}`);
    }
  }

  const models = files.filter((f) => f.startsWith("models/ocr/"));
  if (env.VITE_OCR === "off") {
    if (models.length) errors.push(`VITE_OCR=off but dist has ${models.length} file(s) under models/ocr/`);
  } else if (files.includes("models/ocr/manifest.json")) {
    const manifest = JSON.parse(readFileSync(join(distDir, "models/ocr/manifest.json"), "utf8"));
    // Every file with a url is served from dist, at the length the worker
    // will check it against.
    for (const e of manifest.files ?? []) {
      if (e.url === undefined) continue;
      if (typeof e.url !== "string" || !/^\/models\/ocr\/[\w-][\w.-]*$/.test(e.url)) {
        errors.push(`the manifest's ${e.name} url ${JSON.stringify(e.url)} isn't a /models/ocr/ path on this site`);
        continue;
      }
      const rel = e.url.slice(1);
      if (!files.includes(rel)) errors.push(`the manifest's ${e.name} file ${rel} is missing from dist`);
      else if (statSync(join(distDir, rel)).size !== e.bytes) errors.push(`the manifest's ${e.name} file ${rel} is ${statSync(join(distDir, rel)).size} bytes in dist, ${e.bytes} in the manifest`);
    }
    const entry = manifest.files?.find((e) => e.name === "ort-wasm");
    if (!entry) errors.push("models/ocr/manifest.json has no ort-wasm entry");
    else if (wasm) {
      const buf = readFileSync(join(distDir, wasm));
      const sha = createHash("sha256").update(buf).digest("hex");
      if (entry.bytes !== buf.length || entry.sha256 !== sha) {
        errors.push(`the manifest's ort-wasm entry (${entry.bytes} B, ${entry.sha256.slice(0, 12)}…) doesn't match ${wasm} (${buf.length} B, ${sha.slice(0, 12)}…); rerun scripts/stage-ocr-model.mjs, then build`);
      }
    }
  }
  return { ok: errors.length === 0, errors, wasm };
}

async function main() {
  const web = join(dirname(fileURLToPath(import.meta.url)), "..");
  const distDir = join(web, "dist");
  if (!existsSync(distDir)) {
    console.error("check-ocr-dist: no dist/; run npm run build first");
    process.exit(1);
  }
  const env = await loadEnvVars(web, "production");
  const r = checkDist(distDir, env);
  if (!r.ok) {
    for (const e of r.errors) console.error(`check-ocr-dist: ${e}`);
    process.exit(1);
  }
  const staged = existsSync(join(distDir, "models/ocr/manifest.json"));
  console.log(`check-ocr-dist: one ORT wasm (${r.wasm}), no Node canvas code, OCR models ${env.VITE_OCR === "off" ? "off" : staged ? "staged and matching" : "not staged"}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
