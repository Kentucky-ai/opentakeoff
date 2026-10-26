// scripts/check-one-ort.mjs (#469): voice (transformers.js) and on-device OCR
// (ppu-paddle-ocr) must resolve ONE onnxruntime-web, the version transformers
// pins, so the app ships a single ~24 MB runtime wasm. The fixtures mirror the
// real `npm ls onnxruntime-web --all --json` shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../scripts/check-one-ort.mjs";

const PIN = "1.26.0-dev.20260416-b7804b056c";
const tree = (ppuOrt: Record<string, unknown>, rootOrt: Record<string, unknown> = { version: PIN }) => ({
  name: "opentakeoff-web",
  dependencies: {
    "@huggingface/transformers": { version: "4.2.0", dependencies: { "onnxruntime-web": { version: PIN } } },
    "onnxruntime-web": rootOrt,
    "ppu-paddle-ocr": { version: "6.6.0", dependencies: { "onnxruntime-web": ppuOrt } },
  },
});

test("one version equal to the transformers pin passes", () => {
  const r = analyze(tree({ version: PIN }), PIN);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.versions, [PIN]);
});

test("two versions fail", () => {
  const r = analyze(tree({ version: "1.23.2" }), PIN);
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /2 versions/);
});

test("one version that differs from the pin fails", () => {
  // every copy agrees, but not with what transformers declares
  const r = analyze(tree({ version: PIN }), "1.27.0");
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /pin/);
});

test("a missing node fails", () => {
  const r = analyze(tree({ required: PIN, missing: true }), PIN);
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /missing/);
});

test("an invalid node fails", () => {
  const r = analyze(tree({ version: PIN, invalid: '"^1.23.2" from ppu-paddle-ocr' }), PIN);
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /invalid/);
});

test("no onnxruntime-web at all fails", () => {
  const r = analyze({ name: "x", dependencies: {} }, PIN);
  assert.equal(r.ok, false);
});

test("any problem npm reports fails, not only ones naming onnxruntime-web", () => {
  // problems[] is what npm found wrong in the tree it printed; any entry fails.
  const r = analyze({ ...tree({ version: PIN }), problems: ["invalid: react@17.0.0 /web/node_modules/react"] }, PIN);
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /npm: invalid: react/);
});
