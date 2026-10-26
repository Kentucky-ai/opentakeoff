// The shipped engine options against the REAL engine (#484). Everything else
// in the OCR tests fakes ppu-paddle-ocr; this one builds ppu's own Node
// service (onnxruntime-node, the staged models) with OCR_ENGINE_OPTIONS and
// reads a synthetic finish schedule with five DESCRIPTION cells wrapped onto
// two lines (test/fixtures/ocr-engine/twoline.png, from
// scripts/make-ocr-engine-fixture.mjs). Every first line must read.
//
// Under ppu's defaults (strategy "per-line", recBatchSize 6) only 2 of the 5
// did, on macOS arm64: per-line merges a row's boxes into one crop, and
// batching garbles short standalone lines, which then fall under ppu's 0.5
// confidence floor. Per-box at batch 1 read all 5. Only the shipped options
// are asserted (no "per-line fails" case): native ORT on another platform
// may read the old options differently, and that isn't this test's question.
//
// The browser runs ppu's web build on ORT's wasm backend; Node runs its
// default build on onnxruntime-node. Same models, same options, same ppu
// pipeline; the backends' arithmetic can differ in the last bits.
//
// Needs the staged models (web/public/models/ocr). Missing, the test fails in
// CI (which stages them) and skips elsewhere.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { PaddleOcrService } from "ppu-paddle-ocr";
import { OCR_ENGINE_OPTIONS } from "../src/lib/ocr/engineOptions.ts";

const PUBLIC = new URL("../public/", import.meta.url);
const MANIFEST = new URL("models/ocr/manifest.json", PUBLIC);
const PNG = new URL("./fixtures/ocr-engine/twoline.png", import.meta.url);
const FIRST_LINES = ["BULLNOSE EDGE AT", "INSTALL WITH", "HEAT WELD ALL", "SEMI-GLOSS AT", "MONOLITHIC INSTALL"];

const staged = existsSync(MANIFEST);
if (!staged && process.env.CI) throw new Error("OCR models not staged: CI must run node scripts/stage-ocr-model.mjs before the tests");

/** A model file's bytes as an exact ArrayBuffer (ppu checks instanceof
 * ArrayBuffer; anything else makes it fetch its default models). */
function modelFile(name: string): ArrayBuffer {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { files: { name: string; url?: string }[] };
  const url = manifest.files.find((f) => f.name === name)?.url;
  if (!url) throw new Error(`manifest has no url for ${name}`);
  return new Uint8Array(readFileSync(new URL(url.replace(/^\//, ""), PUBLIC))).buffer;
}

let service: PaddleOcrService | null = null;
after(async () => { await service?.destroy(); });

test("the shipped options read the first line of every two-line cell (real engine)", { skip: staged ? false : "run node scripts/stage-ocr-model.mjs", timeout: 180_000 }, async () => {
  service = new PaddleOcrService({
    model: { detection: modelFile("det"), recognition: modelFile("rec"), charactersDictionary: modelFile("dict") },
    ...OCR_ENGINE_OPTIONS,
  } as ConstructorParameters<typeof PaddleOcrService>[0]);
  await service.initialize();
  const png = readFileSync(PNG);
  // noCache, as the worker passes: ppu caches results by image bytes
  const res = await service.recognize(new Uint8Array(png).buffer, { flatten: false, noCache: true }) as { lines?: { text?: string }[][] };
  const words = (res.lines ?? []).flat().map((c) => (c.text ?? "").trim()).filter(Boolean);
  assert.deepEqual(FIRST_LINES.filter((l) => !words.includes(l)), [], `read: ${JSON.stringify(words)}`);
});
