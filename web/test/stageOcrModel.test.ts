// scripts/stage-ocr-model.mjs (#469): stages the OCR models same-origin under
// public/models/ocr/, verifying every byte, and writes manifest.json LAST so
// a partial run leaves nothing the app would treat as installed. Runs against
// a temp directory and a fake fetch; the network is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stage, parseCharacterDict } from "../scripts/stage-ocr-model.mjs";
import { loadEnvVars } from "../scripts/lib/env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const DET = new TextEncoder().encode("fake detection model");
const REC = new TextEncoder().encode("fake recognition model, a little longer");
const FILES = [
  { name: "det", file: "det.onnx", url: "https://models.example/det.onnx", bytes: DET.length, sha256: sha(DET) },
  { name: "rec", file: "rec.onnx", url: "https://models.example/rec.onnx", bytes: REC.length, sha256: sha(REC) },
];
const BODIES: Record<string, Uint8Array> = { "https://models.example/det.onnx": DET, "https://models.example/rec.onnx": REC };

const tempDest = () => join(mkdtempSync(join(tmpdir(), "ocr-stage-")), "models", "ocr");
function fakeFetch(overrides: Record<string, Uint8Array> = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const body = overrides[url] ?? BODIES[url];
    if (!body) return new Response("nope", { status: 404 });
    return new Response(body as unknown as BodyInit, { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const quiet = () => {};

test("stages the models, the dict and a manifest with an ort-wasm entry", async () => {
  const dest = tempDest();
  const { calls, fetchImpl } = fakeFetch();
  await stage({ dest, fetchImpl, files: FILES, env: {}, log: quiet });
  assert.deepEqual(calls.sort(), Object.keys(BODIES).sort());
  assert.deepEqual(new Uint8Array(readFileSync(join(dest, "det.onnx"))), DET);
  const manifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
  const byName = Object.fromEntries(manifest.files.map((f: { name: string }) => [f.name, f]));
  assert.deepEqual(Object.keys(byName).sort(), ["det", "dict", "ort-wasm", "rec"]);
  assert.equal(byName.det.url, "/models/ocr/det.onnx");
  assert.equal(byName.det.sha256, sha(DET));
  assert.equal(byName.dict.url, "/models/ocr/dict.txt");
  assert.equal(byName.dict.bytes, 1417);
  // the runtime wasm has no url: the app gets it from Vite's `?url` import
  assert.equal(byName["ort-wasm"].url, undefined);
  const wasm = readFileSync(join(here, "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm"));
  assert.equal(byName["ort-wasm"].bytes, wasm.length);
  assert.equal(byName["ort-wasm"].sha256, sha(wasm));
  // an ORT bump changes the rev, and with it the browser cache name
  const ortVersion = JSON.parse(readFileSync(join(here, "../node_modules/onnxruntime-web/package.json"), "utf8")).version;
  assert.ok(manifest.rev.includes(ortVersion), manifest.rev);
});

test("a sha mismatch from the network rejects and writes no manifest", async () => {
  const dest = tempDest();
  const { fetchImpl } = fakeFetch({ "https://models.example/rec.onnx": new TextEncoder().encode("tampered") });
  await assert.rejects(stage({ dest, fetchImpl, files: FILES, env: {}, log: quiet }), /sha256/i);
  assert.equal(existsSync(join(dest, "manifest.json")), false);
  assert.equal(existsSync(join(dest, "rec.onnx")), false, "a rejected file is never written");
});

test("a rerun removes an old manifest before staging, so a failed rerun leaves none", async () => {
  const dest = tempDest();
  await stage({ dest, fetchImpl: fakeFetch().fetchImpl, files: FILES, env: {}, log: quiet });
  assert.ok(existsSync(join(dest, "manifest.json")));
  const failing = FILES.map((f) => (f.name === "rec" ? { ...f, sha256: "0".repeat(64) } : f));
  await assert.rejects(stage({ dest, fetchImpl: fakeFetch().fetchImpl, files: failing, env: {}, log: quiet }));
  assert.equal(existsSync(join(dest, "manifest.json")), false);
});

// A run killed between writing the temp manifest and renaming it leaves
// manifest.json.tmp behind in public/models/ocr, where the build would ship it.
test("a leftover manifest.json.tmp from a killed run is removed, whether the rerun stages or fails", async () => {
  const dest = tempDest();
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "manifest.json.tmp"), '{"rev":"half');
  await stage({ dest, fetchImpl: fakeFetch().fetchImpl, files: FILES, env: {}, log: quiet });
  assert.equal(existsSync(join(dest, "manifest.json.tmp")), false, "after a staging run");

  writeFileSync(join(dest, "manifest.json.tmp"), '{"rev":"half');
  const failing = FILES.map((f) => (f.name === "rec" ? { ...f, sha256: "0".repeat(64) } : f));
  await assert.rejects(stage({ dest, fetchImpl: fakeFetch().fetchImpl, files: failing, env: {}, log: quiet }));
  assert.equal(existsSync(join(dest, "manifest.json.tmp")), false, "after a failed run");
});

test("a verified cached file is not fetched again", async () => {
  const dest = tempDest();
  await stage({ dest, fetchImpl: fakeFetch().fetchImpl, files: FILES, env: {}, log: quiet });
  const second = fakeFetch();
  await stage({ dest, fetchImpl: second.fetchImpl, files: FILES, env: {}, log: quiet });
  assert.deepEqual(second.calls, []);
  assert.ok(existsSync(join(dest, "manifest.json")), "the manifest is rewritten even when every file was cached");
});

test("a corrupt cached file is caught and replaced", async () => {
  const dest = tempDest();
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "det.onnx"), "bit rot");
  const { calls, fetchImpl } = fakeFetch();
  await stage({ dest, fetchImpl, files: FILES, env: {}, log: quiet });
  assert.ok(calls.includes("https://models.example/det.onnx"));
  assert.deepEqual(new Uint8Array(readFileSync(join(dest, "det.onnx"))), DET);
});

test("VITE_OCR=off stages nothing and removes an earlier staging", async () => {
  const dest = tempDest();
  await stage({ dest, fetchImpl: fakeFetch().fetchImpl, files: FILES, env: {}, log: quiet });
  const { calls, fetchImpl } = fakeFetch();
  const r = await stage({ dest, fetchImpl, files: FILES, env: { VITE_OCR: "off" }, log: quiet });
  assert.equal(r.skipped, true);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(dest), false);
});

test("the committed dict is the rec model's character_dict, laid out for 438 classes", () => {
  const dict = readFileSync(join(here, "../scripts/ocr/ppocrv5_en_dict.txt"), "utf8");
  const yml = readFileSync(join(here, "../scripts/ocr/en_PP-OCRv5_mobile_rec.inference.yml"), "utf8");
  const chars = parseCharacterDict(yml);
  assert.equal(chars.length, 436);
  const slots = dict.split(/\r?\n/);
  // blank (CTC class 0), the 436 characters, and a trailing slot decoded as space
  assert.equal(slots.length, 438);
  assert.equal(slots[0], "");
  assert.equal(slots[437], "");
  assert.deepEqual(slots.slice(1, 437), chars);
  // the quoting the parser must get right
  assert.ok(chars.includes("'") && chars.includes('"') && chars.includes(":") && chars.includes("#"));
});

test("a download that hangs times out, so the deploy goes on without OCR, and no manifest is written", { timeout: 3000 }, async () => {
  const dest = tempDest();
  const fetchImpl = ((url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_, reject) => {
      // like real fetch: settles only when its signal aborts
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
  const started = Date.now();
  await assert.rejects(stage({ dest, fetchImpl, files: FILES, env: {}, log: quiet, timeoutMs: 50 }), /time|abort/i);
  assert.ok(Date.now() - started < 2000);
  assert.equal(existsSync(join(dest, "manifest.json")), false);
});

test("a body longer than the pinned size stops downloading as soon as it passes it", async () => {
  const dest = tempDest();
  let pulls = 0, cancelled = false;
  const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({
    pull(ctrl) { if (++pulls > 1000) return ctrl.close(); ctrl.enqueue(new Uint8Array(16)); },
    cancel() { cancelled = true; },
  }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(stage({ dest, fetchImpl, files: FILES, env: {}, log: quiet }), /bytes/);
  assert.equal(cancelled, true, "the rest of the body isn't downloaded");
  assert.ok(pulls < 10, `stopped after ${pulls} chunks`);
  assert.equal(existsSync(join(dest, "manifest.json")), false);
});

test("a committed dict that doesn't match the yml's character_dict is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-committed-"));
  const yml = "PostProcess:\n  character_dict:\n  - a\n  - b\n";
  const dict = "\na\nc\n";
  writeFileSync(join(dir, "rec.yml"), yml);
  writeFileSync(join(dir, "dict.txt"), dict);
  const committed = {
    recYml: { path: join(dir, "rec.yml"), sha256: sha(new TextEncoder().encode(yml)) },
    dict: { path: join(dir, "dict.txt"), sha256: sha(new TextEncoder().encode(dict)) },
  };
  const dest = tempDest();
  await assert.rejects(stage({ dest, fetchImpl: fakeFetch().fetchImpl, files: FILES, env: {}, log: quiet, committed }), /does not match/);
  assert.equal(existsSync(join(dest, "manifest.json")), false);
});

test("parseCharacterDict refuses a yml without a character_dict block, or with a double-quoted entry", () => {
  assert.throws(() => parseCharacterDict("PostProcess:\n  name: CTCLabelDecode\n"), /no character_dict/);
  assert.throws(() => parseCharacterDict('PostProcess:\n  character_dict:\n  - a\n  - "b"\n'), /double-quoted/);
  assert.deepEqual(parseCharacterDict("PostProcess:\n  character_dict:\n  - a\n  - ''''\n  - '0'\n"), ["a", "'", "0"]);
});

test("build scripts read web/.env files for the mode they're given, production by default, whatever NODE_ENV says", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-env-"));
  writeFileSync(join(dir, ".env.development"), "VITE_OCR_ENV_PROBE=dev\n");
  writeFileSync(join(dir, ".env.production"), "VITE_OCR_ENV_PROBE=prod\n");
  const saved = process.env.NODE_ENV;
  assert.equal(process.env.VITE_OCR_ENV_PROBE, undefined);
  try {
    process.env.NODE_ENV = "development";
    assert.equal((await loadEnvVars(dir)).VITE_OCR_ENV_PROBE, "prod", "like vite build, the default mode is production");
    assert.equal((await loadEnvVars(dir, "development")).VITE_OCR_ENV_PROBE, "dev");
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
});
