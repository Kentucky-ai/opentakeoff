// The OCR manifest parser (#469). The manifest names what the worker fetches
// and how much the notice says will download, so anything outside the shape
// the stage script writes is refused: unknown or repeated names, sizes that
// aren't positive whole bytes, fingerprints that aren't SHA-256 hex, model
// URLs off /models/ocr/, and a URL on the runtime entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { asManifest } from "../src/lib/ocr/manifest.ts";

const H = "a".repeat(64);
const good = () => ({
  rev: "ppocrv5-mobile-en-1+ort-1.26.0",
  files: [
    { name: "det", url: "/models/ocr/det.onnx", bytes: 4_826_518, sha256: H },
    { name: "rec", url: "/models/ocr/rec.onnx", bytes: 7_848_423, sha256: H },
    { name: "dict", url: "/models/ocr/dict.txt", bytes: 1_417, sha256: H },
    { name: "ort-wasm", bytes: 23_567_050, sha256: H },
  ],
});
type F = Record<string, unknown>;
const withFile = (i: number, patch: F) => {
  const m = good();
  (m.files as F[])[i] = { ...m.files[i], ...patch };
  return m;
};

test("the manifest the stage script writes is accepted", () => {
  assert.deepEqual(asManifest(good()), good());
});

test("an unknown file name is refused", () => {
  assert.equal(asManifest(withFile(0, { name: "cls" })), null);
});

test("a repeated name is refused", () => {
  const m = good();
  m.files.push({ ...m.files[0] });
  assert.equal(asManifest(m), null);
  assert.equal(asManifest(withFile(1, { name: "det" })), null);
});

test("a manifest missing one of the four files is refused", () => {
  for (const name of ["det", "rec", "dict", "ort-wasm"]) {
    const m = good();
    m.files = m.files.filter((f) => f.name !== name);
    assert.equal(asManifest(m), null, name);
  }
});

test("bytes must be a positive safe integer no larger than 256 MB", () => {
  for (const bytes of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 53, 256 * 2 ** 20 + 1, "100"]) {
    assert.equal(asManifest(withFile(0, { bytes })), null, String(bytes));
  }
  assert.ok(asManifest(withFile(0, { bytes: 256 * 2 ** 20 })));
});

test("sha256 must be 64 lowercase hex characters", () => {
  for (const sha256 of ["a", "A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65), 42]) {
    assert.equal(asManifest(withFile(0, { sha256 })), null, String(sha256));
  }
});

test("a model url must be a plain /models/ocr/ path on this site", () => {
  for (const url of [
    "https://evil.example/models/ocr/det.onnx",
    "//evil.example/models/ocr/det.onnx",
    "/models/ocr/../../det.onnx",
    "/models/ocr/..",
    "/models/ocr/.hidden",
    "/models/ocr/sub/det.onnx",
    "/models/ocr/det.onnx?x=1",
    "/other/det.onnx",
    "models/ocr/det.onnx",
    undefined,
  ]) {
    assert.equal(asManifest(withFile(0, { url })), null, String(url));
  }
});

test("the runtime entry must not carry a url", () => {
  assert.equal(asManifest(withFile(3, { url: "/models/ocr/ort.wasm" })), null);
});
