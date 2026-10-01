// Which bytes an OCR read pairs with (#471): the canvas's document cache
// and the hash source its reads and lookups use. Pinned: a read's page and
// the hash it is stored under come from the same loaded document, so a
// file whose bytes changed under an open document (a cloud re-drop) never
// gets the old page's text stored under the new bytes' hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocCache, createSheetSource, readHooks, readdEffects } from "../src/lib/ocr/sheetSource.ts";
import { createPageReader, type ReadRegion } from "../src/lib/ocr/pageRead.ts";
import { createPageCache, ocrCacheKey } from "../src/lib/ocr/pageCache.ts";
import type { OcrProbe } from "../src/lib/ocr/client.ts";
import type { OcrRunResult } from "../src/lib/ocr/session.ts";

const shaHex = async (bytes: number[]) => Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).toString("hex");
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A page that says which bytes it came from. */
interface FakePage { from: number; getViewport(o: { scale: number }): { width: number; height: number } }

/** A store whose bytes per file can change; counts loads and hash asks. */
function fakeStore(initial: Record<string, number[]>) {
  const bytes = new Map(Object.entries(initial));
  const calls = { loads: 0, storeHash: 0, storeKnown: 0 };
  return {
    calls,
    set(file: string, b: number[]) { bytes.set(file, b); },
    load: async (file: string) => {
      calls.loads++;
      if (!bytes.has(file)) throw new Error(`no ${file}`);
      return new Uint8Array(bytes.get(file)!);
    },
    storeHash: async (file: string) => { calls.storeHash++; return shaHex(bytes.get(file)!); },
    storeKnown: async (_file: string): Promise<string | null> => { calls.storeKnown++; return null; },
  };
}

/** pdf.js's getDocument, faked: detaches the bytes the way pdf.js may. */
function fakeOpen(data: Uint8Array) {
  const from = data[0];
  structuredClone(data.buffer, { transfer: [data.buffer] });
  let destroyed = false;
  return {
    destroyed: () => destroyed,
    destroy() { destroyed = true; },
    promise: Promise.resolve({
      getPage: async (_n: number): Promise<FakePage> => ({ from, getViewport: ({ scale }) => ({ width: 100 * scale, height: 50 * scale }) }),
    }),
  };
}

function setup(initial: Record<string, number[]>, hashing = true) {
  const store = fakeStore(initial);
  const remembered: Promise<string | null>[] = [];
  const opened: ReturnType<typeof fakeOpen>[] = [];
  const docs = createDocCache<FakePage>({
    load: store.load,
    open: (data) => { const t = fakeOpen(data); opened.push(t); return t; },
    hashing: () => (hashing ? (h) => { remembered.push(h); } : null),
  });
  const source = createSheetSource<FakePage>({ cached: docs.cached, open: docs.open, storeHash: store.storeHash, storeKnown: (f) => store.storeKnown(f) });
  return { store, docs, source, remembered, opened };
}

test("the doc cache hashes the bytes it loaded before pdf.js can detach them, and loads once", async () => {
  const t = setup({ "a.pdf": [1, 2, 3] });
  const doc = await t.docs.doc("a.pdf");
  assert.equal((await doc.getPage(1)).from, 1);
  assert.equal(await t.docs.cached("a.pdf")!.hash, await shaHex([1, 2, 3]));
  assert.equal(await t.remembered[0], await shaHex([1, 2, 3]), "the store is told the same digest");
  await t.docs.doc("a.pdf");
  assert.equal(t.store.calls.loads, 1);
});

test("a load evicted before its bytes land reports no hash to the store", async () => {
  const t = setup({ "a.pdf": [1] });
  const p = t.docs.doc("a.pdf");
  t.docs.evict("a.pdf");
  await p;
  assert.equal(t.remembered.length, 0);
});

test("a failed load isn't kept and its hash is null", async () => {
  const t = setup({});
  const e = t.docs.open("missing.pdf");
  await assert.rejects(e.doc());
  // raced against a timer, so a hash that never settles fails here
  const hash = await Promise.race([e.hash, new Promise((r) => setTimeout(() => r("unsettled"), 50))]);
  assert.equal(hash, null, "a failed load's hash settles null");
  assert.equal(t.docs.has("missing.pdf"), false);
});

test("evict and clear destroy the documents' worker copies", async () => {
  const t = setup({ "a.pdf": [1], "b.pdf": [2], "c.pdf": [3] });
  await Promise.all([t.docs.doc("a.pdf"), t.docs.doc("b.pdf"), t.docs.doc("c.pdf")]);
  t.docs.evict("a.pdf");
  await tick();
  assert.deepEqual(t.opened.map((o) => o.destroyed()), [true, false, false]);
  t.docs.clear();
  await tick();
  assert.deepEqual(t.opened.map((o) => o.destroyed()), [true, true, true]);
  assert.equal(t.docs.has("b.pdf"), false);
});

test("hash: a loaded document's own hash; the store isn't asked", async () => {
  const t = setup({ "a.pdf": [1] });
  await t.docs.doc("a.pdf");
  t.store.set("a.pdf", [2]);   // the bytes changed under the open document
  assert.equal(await t.source.hash("a.pdf"), await shaHex([1]));
  assert.deepEqual([t.store.calls.storeHash, t.store.calls.storeKnown], [0, 0]);
});

test("hash: no document loaded, a hash the store already has; nothing loads", async () => {
  const t = setup({ "a.pdf": [1] });
  t.store.storeKnown = async () => "d".repeat(64);
  assert.equal(await t.source.hash("a.pdf"), "d".repeat(64));
  assert.equal(t.store.calls.loads, 0);
});

test("hash with known: no document and nothing known is null, and nothing loads", async () => {
  const t = setup({ "a.pdf": [1] });
  assert.equal(await t.source.hash("a.pdf", { known: true }), null);
  assert.equal(t.store.calls.loads, 0);
});

test("hash: nothing loaded or known loads the document once and takes its hash", async () => {
  const t = setup({ "a.pdf": [7] });
  assert.equal(await t.source.hash("a.pdf"), await shaHex([7]));
  await t.source.page("a.pdf", 1);
  assert.equal(t.store.calls.loads, 1);
  assert.equal(t.store.calls.storeHash, 0);
});

test("a store that doesn't hash here (local) keys on the store's hash", async () => {
  const t = setup({ "a.pdf": [1] }, false);
  await t.docs.doc("a.pdf");
  assert.equal(await t.source.hash("a.pdf"), await shaHex([1]));
  assert.equal(t.store.calls.storeHash, 1);
});

test("hash with known: a loaded document with no hash of its own asks what the store already has, hashing nothing", async () => {
  const t = setup({ "a.pdf": [1] }, false);
  await t.docs.doc("a.pdf");
  assert.equal(await t.source.hash("a.pdf", { known: true }), null);
  assert.deepEqual([t.store.calls.storeHash, t.store.calls.storeKnown], [0, 1]);
});

test("page: the page and the hash of the document it came from", async () => {
  const t = setup({ "a.pdf": [3] });
  const { page, hash } = await t.source.page("a.pdf", 1);
  assert.equal(page.from, 3);
  assert.equal(await hash, await shaHex([3]));
});

// ── through the page reader: what the cache stores ──────────────────────────

const available: OcrProbe = { state: "available", manifest: { rev: "r1", files: [] }, cached: true, downloadBytes: 0 };
const session = {
  async run<T>(task: (s?: AbortSignal) => Promise<T>, o: { signal?: AbortSignal } = {}): Promise<OcrRunResult<T>> {
    try { return { ok: true, value: await task(o.signal) }; } catch (error) { return { ok: false, reason: "failed", error }; }
  },
  availability: async () => available,
};
/** Reads one line naming the bytes the page came from. */
const readRegion: ReadRegion = async (pg) => ({ lines: [{ str: `BYTES ${(pg as unknown as FakePage).from}`, x: 1, y: 20, w: 50, h: 10 }], ms: 1, rasters: 1 });

function readerOver(t: ReturnType<typeof setup>) {
  const meta = new Map<string, { lines: { str: string }[] }>();
  const puts: string[] = [];
  const cache = createPageCache({ metaGet: async (k) => meta.get(k), metaPut: async (k, v) => { puts.push(k); meta.set(k, v as { lines: { str: string }[] }); } });
  const reader = createPageReader({ session, cache, readRegion, onLines: () => {} });
  // the canvas's readSheet wiring
  const read = (file: string) => {
    const h = readHooks(t.source, file, 1);
    return reader.read({ key: file, file, page: 1, rs: 1, pdfHash: h.pdfHash, getPage: h.getPage, pageHash: h.pageHash });
  };
  return { reader, read, puts, meta };
}

test("a re-added file's read never pairs the open document's page with the new bytes' hash", async () => {
  const t = setup({ "a.pdf": [1] });
  await t.docs.doc("a.pdf");                    // the canvas has the old bytes open
  t.store.set("a.pdf", [2]);                    // a cloud re-drop replaced them
  t.store.storeKnown = async () => shaHex([2]); // and the store already knows the new hash
  const r = readerOver(t);
  const out = await r.read("a.pdf");
  assert.equal(out.ok && out.lines[0].str, "BYTES 1");
  const oldKey = ocrCacheKey(await shaHex([1]), 1), newKey = ocrCacheKey(await shaHex([2]), 1);
  assert.deepEqual(r.puts, [oldKey], "the old page's text goes under the old bytes' hash");
  assert.equal(r.meta.has(newKey), false);
  // the stale document goes (evictDoc): the next read is of the new bytes
  t.docs.evict("a.pdf");
  r.reader.dropFile("a.pdf");
  const again = await r.read("a.pdf");
  assert.equal(again.ok && again.lines[0].str, "BYTES 2");
  assert.deepEqual(r.puts, [oldKey, newKey]);
  assert.equal(r.meta.get(newKey)!.lines[0].str, "BYTES 2");
});

test("a document replaced between the lookup and the page: stored under the page's document", async () => {
  const t = setup({ "a.pdf": [1] });
  await t.docs.doc("a.pdf");
  // the cache lookup (under the old document's hash) waits until the file
  // has been re-added and its old document evicted
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const puts: string[] = [];
  const cache = createPageCache({
    metaGet: async () => { await gate; return undefined; },
    metaPut: async (k) => { puts.push(k); },
  });
  const reader = createPageReader({ session, cache, readRegion, onLines: () => {} });
  const h = readHooks(t.source, "a.pdf", 1);
  const p = reader.read({ key: "a.pdf", file: "a.pdf", page: 1, rs: 1, pdfHash: h.pdfHash, getPage: h.getPage, pageHash: h.pageHash });
  await tick();
  t.docs.evict("a.pdf");
  t.store.set("a.pdf", [2]);
  release();
  const out = await p;
  assert.equal(out.ok && out.lines[0].str, "BYTES 2", "the page came from the new document");
  assert.deepEqual(puts, [ocrCacheKey(await shaHex([2]), 1)], "so its read goes under the new bytes' hash");
});

// ── what re-adding files resets ──────────────────────────────────────────────

test("re-adding: identical local bytes keep everything; a revision or a fresh add resets", () => {
  const loaded = () => true;
  assert.deepEqual(readdEffects([{ name: "same.pdf", unchanged: true }], { cloud: false, loaded }), { reset: [], evict: [] });
  assert.deepEqual(readdEffects([{ name: "rev.pdf", revised: true }], { cloud: false, loaded }), { reset: ["rev.pdf"], evict: ["rev.pdf"] });
  assert.deepEqual(readdEffects([{ name: "new.pdf" }], { cloud: false, loaded: () => false }), { reset: ["new.pdf"], evict: [] });
});

test("re-adding in the cloud: every name resets, and one with a loaded document is evicted", () => {
  const loaded = (n: string) => n === "open.pdf";
  assert.deepEqual(
    readdEffects([{ name: "open.pdf" }, { name: "closed.pdf" }], { cloud: true, loaded }),
    { reset: ["open.pdf", "closed.pdf"], evict: ["open.pdf"] },
  );
});
