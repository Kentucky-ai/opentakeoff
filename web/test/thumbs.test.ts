// Gallery thumbnail records (thumbs.js) on fake-indexeddb: the record keeps
// whether the page has a text layer (#471), so a reopened gallery can offer
// Read page text on a scanned sheet without parsing its PDF.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { saveThumb, loadThumb } from "../src/lib/thumbs.js";

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
