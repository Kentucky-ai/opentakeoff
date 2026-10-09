// The Sheets tree's per-file numbers (sheetNamer.ts): offers, generations,
// saved records, and what may be written when. Fakes throughout: timers run
// when the test says, the meta store is a Map whose reads can be held open,
// and the reader returns the page text's `n`.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createSheetNamer, forgetSheetNames, nameKey, WRITE_EVERY_MS, type NameRecord } from "../src/lib/sheetNamer.ts";
import { READER_VERSION } from "../src/lib/sheetName.ts";
import { metaGet, metaPut, metaDelete } from "../src/lib/store.js";

beforeEach(() => { (globalThis as any).indexedDB = new IDBFactory(); });

function fakeTimers() {
  let q: { fn: () => void; ms: number; id: number }[] = [];
  let id = 0;
  return {
    set(fn: () => void, ms: number) { q.push({ fn, ms, id: ++id }); return id; },
    clear(h: unknown) { q = q.filter((t) => t.id !== h); },
    /** run every queued task due within `ms` (0: the readers), repeatedly */
    run(ms = 0) { for (let guard = 0; guard < 100; guard++) { const due = q.filter((t) => t.ms <= ms); if (!due.length) return; q = q.filter((t) => t.ms > ms); for (const t of due) t.fn(); } },
    pending: () => q.length,
  };
}
function fakeMeta(init: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(init));
  const puts: [string, unknown][] = [];
  let gate: Promise<void> | null = null;
  let open: () => void = () => {};
  return {
    data, puts,
    /** hold every get until release() */
    hold() { gate = new Promise((r) => { open = r; }); },
    release() { open(); gate = null; },
    async get(k: string) { if (gate) await gate; return data.get(k); },
    async put(k: string, v: unknown) { puts.push([k, structuredClone(v)]); data.set(k, structuredClone(v)); },
    async del(k: string) { data.delete(k); },
  };
}
const syncSignal = () => { const fns = new Set<() => void>(); let notes = 0; return { notes: () => notes, subscribe(fn: () => void) { fns.add(fn); return () => fns.delete(fn); }, notify() { notes++; for (const f of fns) f(); } }; };
const tick = () => new Promise((r) => setTimeout(r, 0));
const VP = { width: 1, height: 1, transform: [1, 0, 0, 1, 0, 0] };
const text = (n: string | null) => ({ items: [], n }) as any;
const rec = (pages: Record<string, string | null>, numPages: number | null = null, rv = READER_VERSION): NameRecord => ({ rv, numPages, pages });

function setup(o: { persist?: boolean; meta?: ReturnType<typeof fakeMeta> } = {}) {
  const timers = fakeTimers(), meta = o.meta ?? fakeMeta(), signal = syncSignal();
  const reads: string[] = [];
  const namer = createSheetNamer({
    scope: "local", persist: o.persist ?? true, meta, timers, signal,
    read: (tc: any) => { reads.push(String(tc.n)); return tc.n; },
  });
  namer.start();
  return { namer, timers, meta, signal, reads };
}

test("an offer is read in its own task and shows as the page's number", async () => {
  const { namer, timers } = setup();
  const g = namer.gen("a.pdf");
  await tick();                                  // record loaded (none)
  namer.offer("a.pdf", 1, g, text("A-101"), VP);
  assert.equal(namer.number("a.pdf", 1), undefined, "not read until its task runs");
  timers.run(0);
  assert.equal(namer.number("a.pdf", 1), "A-101");
  assert.equal(namer.number("a.pdf", 2), undefined, "unread stays unread");
});

test("read-with-no-number is kept apart from unread, and never read again", async () => {
  const { namer, timers, reads } = setup();
  const g = namer.gen("a.pdf");
  await tick();
  namer.offer("a.pdf", 1, g, text(null), VP);
  timers.run(0);
  assert.equal(namer.number("a.pdf", 1), null);
  namer.offer("a.pdf", 1, g, text("X"), VP);
  timers.run(0);
  assert.deepEqual(reads, ["null"], "a recorded page is not read again");
  assert.equal(namer.readCount("a.pdf"), 1);
});

test("an offer from before a forget (a re-drop mid-read) is dropped", async () => {
  const { namer, timers } = setup();
  const g = namer.gen("a.pdf");
  await tick();
  namer.offer("a.pdf", 1, g, text("OLD"), VP);   // queued
  namer.forget("a.pdf");
  timers.run(0);
  assert.equal(namer.number("a.pdf", 1), undefined);
  namer.offer("a.pdf", 1, g, text("OLD"), VP);   // captured before the forget
  timers.run(0);
  assert.equal(namer.number("a.pdf", 1), undefined);
  namer.offer("a.pdf", 1, namer.gen("a.pdf"), text("NEW"), VP);
  timers.run(0);
  assert.equal(namer.number("a.pdf", 1), "NEW");
});

test("a file removed and re-added under the same name gets a fresh generation", async () => {
  const { namer, timers } = setup();
  const g = namer.gen("a.pdf");
  namer.setFiles([]);
  namer.setFiles(["a.pdf"]);
  await tick();
  namer.offer("a.pdf", 1, g, text("OLD"), VP);
  timers.run(0);
  assert.equal(namer.number("a.pdf", 1), undefined);
});

test("a saved record shows without any read, and its pages aren't read again", async () => {
  const meta = fakeMeta({ [nameKey("local", "a.pdf")]: rec({ 1: "A-101", 2: null }, 2) });
  const { namer, timers, reads } = setup({ meta });
  namer.setFiles(["a.pdf"]);
  await tick();
  assert.equal(namer.number("a.pdf", 1), "A-101");
  assert.equal(namer.number("a.pdf", 2), null);
  namer.offer("a.pdf", 2, namer.gen("a.pdf"), text("X"), VP);
  timers.run(0);
  assert.deepEqual(reads, []);
});

test("a record from another reader version is ignored and rewritten", async () => {
  const meta = fakeMeta({ [nameKey("local", "a.pdf")]: rec({ 1: "OLD" }, 1, READER_VERSION + 99) });
  const { namer, timers } = setup({ meta });
  namer.setFiles(["a.pdf"]);
  await tick();
  assert.equal(namer.number("a.pdf", 1), undefined);
  namer.setNumPages("a.pdf", namer.gen("a.pdf"), 1);
  namer.offer("a.pdf", 1, namer.gen("a.pdf"), text("NEW"), VP);
  timers.run(0);
  await tick();
  assert.deepEqual(meta.data.get(nameKey("local", "a.pdf")), rec({ 1: "NEW" }, 1));
});

test("an offer before the record loads is merged into it, never written over it", async () => {
  const meta = fakeMeta({ [nameKey("local", "a.pdf")]: rec({ 1: "A-101", 2: "A-102", 3: "A-103" }, 4) });
  meta.hold();
  const { namer, timers } = setup({ meta });
  const g = namer.gen("a.pdf");
  namer.offer("a.pdf", 1, g, text("WRONG"), VP);
  namer.offer("a.pdf", 4, g, text("A-104"), VP);
  timers.run(0);
  assert.equal(meta.puts.length, 0, "nothing written while the record is loading");
  meta.release();
  await tick(); await tick();
  timers.run(WRITE_EVERY_MS);
  await tick();
  assert.equal(namer.number("a.pdf", 1), "A-101", "the record's page wins");
  assert.deepEqual(meta.data.get(nameKey("local", "a.pdf")), rec({ 1: "A-101", 2: "A-102", 3: "A-103", 4: "A-104" }, 4));
});

test("writes are coalesced: many pages, few writes; a complete file writes at once", async () => {
  const { namer, timers, meta } = setup();
  const g = namer.gen("a.pdf");
  await tick();
  namer.setNumPages("a.pdf", g, 30);
  for (let p = 1; p <= 29; p++) namer.offer("a.pdf", p, g, text(`A-${p}`), VP);
  timers.run(0);
  await tick();
  assert.equal(meta.puts.length, 0, "not yet: within the write interval");
  namer.offer("a.pdf", 30, g, text("A-30"), VP);
  timers.run(0);
  await tick();
  assert.equal(meta.puts.length, 1, "the last page completes the file: written now");
  assert.equal(Object.keys((meta.puts[0][1] as NameRecord).pages).length, 30);
});

test("one record per file: writing one file never rewrites another", async () => {
  const { namer, timers, meta } = setup();
  const ga = namer.gen("a.pdf"), gb = namer.gen("b.pdf");
  await tick();
  namer.offer("a.pdf", 1, ga, text("A-1"), VP);
  namer.offer("b.pdf", 1, gb, text("B-1"), VP);
  timers.run(WRITE_EVERY_MS);
  await tick();
  assert.deepEqual(meta.puts.map(([k]) => k).sort(), [nameKey("local", "a.pdf"), nameKey("local", "b.pdf")]);
});

test("cloud (no records): nothing is read from or written to the store, offers apply at once", async () => {
  const meta = fakeMeta();
  let gets = 0;
  const get = meta.get; meta.get = async (k: string) => { gets++; return get(k); };
  const { namer, timers } = setup({ persist: false, meta });
  const g = namer.gen("a.pdf");
  namer.offer("a.pdf", 1, g, text("A-1"), VP);
  timers.run(WRITE_EVERY_MS);
  await namer.stop();
  assert.equal(namer.number("a.pdf", 1), "A-1");
  assert.equal(gets, 0);
  assert.equal(meta.puts.length, 0);
});

test("after a forget the file's next offers apply, not wait for a record", async () => {
  const { namer, timers } = setup();
  namer.gen("a.pdf");
  await tick();
  namer.forget("a.pdf");
  namer.offer("a.pdf", 1, namer.gen("a.pdf"), text("NEW"), VP);
  timers.run(0);
  assert.equal(namer.readCount("a.pdf"), 1);
  assert.equal(namer.number("a.pdf", 1), "NEW");
});

test("stop flushes what's unsaved, then nothing more is read or written", async () => {
  const { namer, timers, meta, reads } = setup();
  const g = namer.gen("a.pdf");
  await tick();
  namer.offer("a.pdf", 1, g, text("A-1"), VP);
  timers.run(0);
  namer.offer("a.pdf", 2, g, text("A-2"), VP);     // queued, not read
  await namer.stop();
  assert.equal(meta.puts.length, 1);
  timers.run(WRITE_EVERY_MS);
  namer.offer("a.pdf", 3, g, text("A-3"), VP);
  timers.run(0);
  assert.deepEqual(reads, ["A-1"]);
  assert.equal(meta.puts.length, 1);
  assert.equal(namer.gen("a.pdf"), undefined);
});

test("subscribers hear about new numbers", async () => {
  const { namer, timers, signal } = setup();
  const g = namer.gen("a.pdf");
  await tick();
  let heard = 0;
  namer.subscribe(() => heard++);
  namer.offer("a.pdf", 1, g, text("A-1"), VP);
  timers.run(0);
  assert.ok(heard >= 1 && signal.notes() >= 1);
});

test("forgetSheetNames deletes saved numbers with no namer running", async () => {
  const meta = fakeMeta({ [nameKey("p1", "a.pdf")]: rec({ 1: "OLD" }, 1), [nameKey("p1", "b.pdf")]: rec({ 1: "B" }, 1) });
  await forgetSheetNames(meta, "p1", ["a.pdf"]);
  assert.equal(meta.data.has(nameKey("p1", "a.pdf")), false);
  assert.equal(meta.data.has(nameKey("p1", "b.pdf")), true);
});

test("a record whose delete failed is not trusted this session", async () => {
  const meta = fakeMeta({ [nameKey("local", "a.pdf")]: rec({ 1: "OLD" }, 1) });
  const del = meta.del; meta.del = async () => { throw new Error("quota"); };
  const errors: unknown[] = [];
  await forgetSheetNames(meta, "local", ["a.pdf"], (e) => errors.push(e));
  meta.del = del;
  const { namer } = setup({ meta });
  namer.setFiles(["a.pdf"]);
  await tick();
  assert.equal(errors.length, 1);
  assert.equal(namer.number("a.pdf", 1), undefined);
});

test("on the real store, a record written before its delete stays deleted", async () => {
  const meta = { get: metaGet, put: metaPut, del: metaDelete };
  const key = nameKey("local", "a.pdf");
  const put = metaPut(key, rec({ 1: "OLD" }, 1));        // issued first
  const gone = forgetSheetNames(meta, "local", ["a.pdf"]);
  await Promise.all([put, gone]);
  assert.equal(await metaGet(key), undefined);
});

test("a forgotten file is stale (its old labels can't be trusted) until re-read", async () => {
  // its own file name: stale marks are module-wide, kept for the session
  const { namer } = setup();
  namer.gen("fresh.pdf");
  await tick();
  assert.equal(namer.stale("fresh.pdf"), false);
  namer.forget("fresh.pdf");
  assert.equal(namer.stale("fresh.pdf"), true);
});

test("a revision noted while no namer ran (Classic) still marks the file stale", async () => {
  await forgetSheetNames(fakeMeta(), "classic", ["b.pdf"]);
  const timers = fakeTimers();
  const n = createSheetNamer({ scope: "classic", persist: true, meta: fakeMeta(), timers, signal: syncSignal() });
  n.start();
  n.setFiles(["b.pdf", "c.pdf"]);
  assert.equal(n.stale("b.pdf"), true);
  assert.equal(n.stale("c.pdf"), false);
});
