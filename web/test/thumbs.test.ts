// Gallery thumbnail records (thumbs.js) on fake-indexeddb: the record keeps
// whether the page has a text layer (#471), so a reopened gallery can offer
// Read page text on a scanned sheet without parsing its PDF.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { saveThumb, loadThumb } from "../src/lib/thumbs.js";
import { metaGet, metaPut } from "../src/lib/store.js";
import { PICTURE_PARAMS_HASH } from "../src/lib/pictures.ts";

beforeEach(() => { (globalThis as any).indexedDB = new IDBFactory(); });

const rec = (extra: Record<string, unknown> = {}) => ({ w: 2000, h: 1000, blob: new Blob([new Uint8Array([1, 2, 3])]), label: "A101", det: null, ...extra });

test("saveThumb keeps the text-layer flag; loadThumb gives it back", async () => {
  await saveThumb("scan.pdf", rec({ textLayer: false }));
  await saveThumb("vec.pdf", rec({ textLayer: true }));
  assert.equal((await loadThumb("scan.pdf", 1000))?.textLayer, false);
  assert.equal((await loadThumb("vec.pdf", 1000))?.textLayer, true);
});


test("a record saved without the flag loads with it undefined (an old record: its text is read once)", async () => {
  await saveThumb("old.pdf", rec());
  const got = await loadThumb("old.pdf", 1000);
  assert.ok(got);
  assert.equal(got.textLayer, undefined);
});

// ── pictures on a vector sheet (#489) ───────────────────────────────────────

const P = { x0: 640, y0: 1320, x1: 1584, y1: 1569.8 };

test("saveThumb keeps measured pictures and the rule's hash; loadThumb gives them back", async () => {
  await saveThumb("h.pdf", rec({ textLayer: true, pictures: [P] }));
  await saveThumb("v.pdf", rec({ textLayer: true, pictures: [] }));
  const h = await loadThumb("h.pdf", 1000);
  assert.deepEqual(h?.pictures, [P]);
  assert.equal(h?.pp, PICTURE_PARAMS_HASH);
  assert.deepEqual((await loadThumb("v.pdf", 1000))?.pictures, []);
});

test("an unreadable op list (\"failed\") is this session's only: saved as not measured, so the next session measures again", async () => {
  await saveThumb("f.pdf", rec({ textLayer: true, pictures: "failed" }));
  const raw = await metaGet("thumb:v3:f.pdf");
  assert.equal("pictures" in raw, false);
  assert.equal("pp" in raw, false);
  const got = await loadThumb("f.pdf", 1000);
  assert.ok(got);
  assert.equal(got.textLayer, true);
  assert.equal("pictures" in got, false);
});

test("a record without pictures saves and loads without them (not measured)", async () => {
  await saveThumb("v.pdf", rec({ textLayer: true }));
  const got = await loadThumb("v.pdf", 1000);
  assert.ok(got);
  assert.equal("pictures" in got, false);
  assert.equal("pp" in got, false);
});

test("loadThumb: pictures from another rule revision, or malformed, load as not measured; the record stands", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["old-rule", { pictures: [P], pp: "00000000" }],
    ["no-hash", { pictures: [P] }],
    ["not-array", { pictures: "lots", pp: PICTURE_PARAMS_HASH }],
    ["bad-rect", { pictures: [{ x0: 1, y0: 2, x1: "3", y1: 4 }], pp: PICTURE_PARAMS_HASH }],
    ["nan-rect", { pictures: [{ x0: 1, y0: 2, x1: NaN, y1: 4 }], pp: PICTURE_PARAMS_HASH }],
    ["null-rect", { pictures: [null], pp: PICTURE_PARAMS_HASH }],
    ["failed", { pictures: "failed", pp: PICTURE_PARAMS_HASH }],
  ];
  for (const [key, extra] of cases) {
    await metaPut(`thumb:v3:${key}`, { w: 2000, h: 1000, blob: new Blob([new Uint8Array([1])]), label: "A101", det: null, textLayer: true, ts: 1, ...extra });
    const got = await loadThumb(key, 1000);
    assert.ok(got, key);
    assert.equal(got.textLayer, true, key);
    assert.equal(got.label, "A101", key);
    assert.equal("pictures" in got, false, key);
    assert.equal("pp" in got, false, key);
  }
});
