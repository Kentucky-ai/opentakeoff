// Company identity: localStorage load/save resilience + dataURL → bytes for
// pdf-lib. normalizeLogoToPng is browser-only (createImageBitmap / <canvas> /
// Image don't exist in node) — exercised in the app, deliberately NOT here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCompany, saveCompany, dataUrlToBytes, LOGO_LIMIT } from "../src/lib/identity.js";

test("loadCompany returns {} without localStorage; saveCompany reports failure", () => {
  assert.equal(typeof globalThis.localStorage, "undefined"); // node test env
  assert.deepEqual(loadCompany(), {});                        // ReferenceError swallowed
  assert.equal(saveCompany({ name: "Acme" }), false);         // can't persist, says so
});

test("loadCompany: malformed / non-object payloads collapse to {}", () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  try {
    assert.deepEqual(loadCompany(), {});                      // missing key
    store.set("opentakeoff_company", "not json {{{");
    assert.deepEqual(loadCompany(), {});                      // corrupt JSON
    store.set("opentakeoff_company", '["a","b"]');
    assert.deepEqual(loadCompany(), {});                      // array is not an object here
    store.set("opentakeoff_company", '"just a string"');
    assert.deepEqual(loadCompany(), {});                      // JSON, but not an object
    store.set("opentakeoff_company", "null");
    assert.deepEqual(loadCompany(), {});                      // null parses, still {}
    store.set("opentakeoff_company", '{"name":"Acme Floors","logo":"data:image/png;base64,AA=="}');
    assert.deepEqual(loadCompany(), { name: "Acme Floors", logo: "data:image/png;base64,AA==" });
  } finally {
    delete (globalThis as any).localStorage;
  }
});

test("saveCompany drops empty fields; nothing left removes the key", () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  try {
    assert.equal(saveCompany({ name: "Acme Floors", address: "  ", logo: "" }), true);
    assert.deepEqual(loadCompany(), { name: "Acme Floors" });  // blank address + empty logo dropped
    assert.equal(saveCompany({ name: "", address: "" }), true);
    assert.equal(store.has("opentakeoff_company"), false);     // {} → removeItem, not "{}"
    assert.deepEqual(loadCompany(), {});
  } finally {
    delete (globalThis as any).localStorage;
  }
});

test("dataUrlToBytes round-trips a known payload, null on garbage", () => {
  // "OpenTakeoff" → base64
  const b64 = Buffer.from("OpenTakeoff").toString("base64");
  const bytes = dataUrlToBytes(`data:image/png;base64,${b64}`);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(Buffer.from(bytes!).toString("utf8"), "OpenTakeoff");
  assert.equal(dataUrlToBytes("not-a-url"), null);                     // no data: scheme
  assert.equal(dataUrlToBytes("data:image/png;base64,!!!"), null);     // invalid base64
  assert.equal(dataUrlToBytes(null as any), null);                     // non-string input
  assert.equal(dataUrlToBytes("data:image/png,rawpixels"), null);      // not base64-flagged
});

test("LOGO_LIMIT is the documented cap", () => {
  assert.equal(LOGO_LIMIT, 200_000);
});
