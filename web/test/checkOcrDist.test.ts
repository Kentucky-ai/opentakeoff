// scripts/check-ocr-dist.mjs (#469): after a build, dist must ship one ORT
// runtime wasm (the asyncify build voice and OCR share), no OpenCV or
// @napi-rs/canvas code from ppu's Node paths, a staged manifest that matches
// the wasm actually shipped, and no OCR models at all when VITE_OCR=off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkDist } from "../scripts/check-ocr-dist.mjs";

const WASM = Buffer.from("asyncify runtime bytes");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function dist(files: Record<string, string | Buffer>) {
  const root = mkdtempSync(join(tmpdir(), "ocr-dist-"));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}
type Entry = { name: string; url?: string; bytes: number; sha256: string };
const DET = Buffer.from("det model");
const entries = (bytes = WASM.length, hash = sha(WASM)): Entry[] => [
  { name: "det", url: "/models/ocr/det.onnx", bytes: DET.length, sha256: sha(DET) },
  { name: "ort-wasm", bytes, sha256: hash },
];
const manifestOf = (files: Entry[]) => JSON.stringify({ rev: "r", files });
const manifest = (bytes = WASM.length, hash = sha(WASM)) => manifestOf(entries(bytes, hash));
const good = () => ({
  "index.html": "<!doctype html>",
  "assets/index-abc.js": 'const engine="opencv";export{engine}',
  "assets/ort-wasm-simd-threaded.asyncify-XYZ.wasm": WASM,
  "assets/ocr.worker-W1.js": 'const w="/assets/ort-wasm-simd-threaded.asyncify-XYZ.wasm";',
  "models/ocr/det.onnx": DET,
  "models/ocr/manifest.json": manifest(),
});
const withoutModels = (files: Record<string, string | Buffer>) =>
  Object.fromEntries(Object.entries(files).filter(([p]) => !p.startsWith("models/")));

test("a dist with one asyncify wasm, no Node canvas code and a matching manifest passes", () => {
  assert.deepEqual(checkDist(dist(good()), {}).errors, []);
});

test("a second ORT wasm fails", () => {
  const r = checkDist(dist({ ...good(), "assets/ort-wasm-simd-threaded.jsep-Q.wasm": "jsep" }), {});
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /2 ORT wasm/);
});

test("a single non-asyncify ORT wasm fails", () => {
  const { ["assets/ort-wasm-simd-threaded.asyncify-XYZ.wasm"]: _w, ...rest } = good();
  const r = checkDist(dist({ ...rest, "assets/ort-wasm-simd-threaded.jsep-Q.wasm": WASM }), {});
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /asyncify/);
});

test("OpenCV code in a chunk fails (the word \"opencv\" alone does not)", () => {
  const r = checkDist(dist({ ...good(), "assets/cv-1.js": "cv.getBuildInformation=function(){}" }), {});
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /OpenCV/);
});

test("@napi-rs/canvas code in a chunk fails", () => {
  const r = checkDist(dist({ ...good(), "assets/n-1.js": "if(process.env.NAPI_RS_NATIVE_LIBRARY_PATH){}" }), {});
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /napi-rs/);
});

test("a manifest whose ort-wasm entry doesn't match the shipped wasm fails", () => {
  const r = checkDist(dist({ ...good(), "models/ocr/manifest.json": manifest(WASM.length, "0".repeat(64)) }), {});
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /manifest/);
});

test("no staged models is fine when OCR is on (the site reports it not installed)", () => {
  const { ["models/ocr/manifest.json"]: _m, ...rest } = good();
  assert.deepEqual(checkDist(dist(rest), {}).errors, []);
});

test("VITE_OCR=off: any models/ocr in dist fails, none passes", () => {
  const r = checkDist(dist(good()), { VITE_OCR: "off" });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /VITE_OCR=off/);
  assert.deepEqual(checkDist(dist(withoutModels(good())), { VITE_OCR: "off" }).errors, []);
});

test("OCR on: a dist without the OCR worker chunk fails, so the checks above can't pass vacuously", () => {
  const { ["assets/ocr.worker-W1.js"]: _w, ...rest } = good();
  const r = checkDist(dist(rest), {});
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /ocr\.worker/);
  assert.match(r.errors.join("\n"), /lib\/ocr\/client\.ts/);
  // VITE_OCR=off doesn't need it
  assert.deepEqual(checkDist(dist(withoutModels(rest)), { VITE_OCR: "off" }).errors, []);
});

test("an OCR worker that doesn't reference the shipped asyncify wasm fails", () => {
  const r = checkDist(dist({ ...good(), "assets/ocr.worker-W1.js": 'const w="/assets/ort-wasm-simd-threaded.jsep-Q.wasm";' }), {});
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /ocr\.worker.*asyncify|doesn't reference/);
});

test("a manifest without an ort-wasm entry fails", () => {
  const r = checkDist(dist({ ...good(), "models/ocr/manifest.json": manifestOf(entries().filter((e) => e.name !== "ort-wasm")) }), {});
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /ort-wasm/);
});

test("a manifest url off /models/ocr/ fails", () => {
  for (const url of ["https://cdn.example/models/ocr/det.onnx", "/assets/det.onnx"]) {
    const files = entries().map((e) => (e.name === "det" ? { ...e, url } : e));
    const r = checkDist(dist({ ...good(), "models/ocr/manifest.json": manifestOf(files) }), {});
    assert.equal(r.ok, false, url);
    assert.match(r.errors.join("\n"), /det.*\/models\/ocr\//, url);
  }
});

test("a manifest file missing from dist fails", () => {
  const { ["models/ocr/det.onnx"]: _d, ...rest } = good();
  const r = checkDist(dist(rest), {});
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /det\.onnx.*(missing|not in dist)/);
});

test("a manifest file whose length differs from dist's copy fails", () => {
  const r = checkDist(dist({ ...good(), "models/ocr/det.onnx": Buffer.from("det model, truncated?") }), {});
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /det\.onnx.*bytes/);
});

test("an app chunk may reference the worker (the app's import of the OCR client builds it)", () => {
  const r = checkDist(dist({ ...good(), "assets/index-abc.js": 'new Worker(new URL("ocr.worker-W1.js",import.meta.url),{type:"module"})' }), {});
  assert.deepEqual(r.errors, []);
});
