// Reading a whole text-less page on-device (#471): the page read controller
// the canvas's Read page text (and the gallery's) go through. A fake session
// stands in for consent and the engine, a fake readRegion for the tiled
// read; the cache is the real pageCache over a Map. Pinned: the cache is
// asked first (with the probed rev) and a hit never opens the page or asks
// for consent; a miss reads the full page at rs through session.run and
// stores it; every outcome maps to one typed status; one read per page at a
// time (a second request joins); Cancel shows Stopping… until the read
// settles; a file dropped mid-read leaves no trace.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPageReader, readPageText, pageReadView, progressText, readSignature, backgroundRows, createReadRenderGate,
  type PageReadStatus, type ReadRegion, type ActiveRead,
} from "../src/lib/ocr/pageRead.ts";
import { createPageCache } from "../src/lib/ocr/pageCache.ts";
import { ocrCacheKey, OCR_CACHE_OPTS, STALE_OK_OPTS } from "../src/lib/ocr/pageCache.ts";
import type { OcrProbe } from "../src/lib/ocr/client.ts";
import type { OcrRunResult } from "../src/lib/ocr/session.ts";
import type { SeamLine, SeamProgress } from "../src/lib/ocr/seams.ts";

const HASH = "a".repeat(64);

/** console.warn, recorded and silenced. */
function captureWarn() {
  const orig = console.warn;
  const calls: unknown[][] = [];
  console.warn = (...a: unknown[]) => { calls.push(a); };
  return { calls, restore: () => { console.warn = orig; } };
}
const RS = 2;
const tick = () => new Promise((r) => setTimeout(r, 0));

const availableRev = (rev: string): OcrProbe => ({ state: "available", manifest: { rev, files: [] }, cached: true, downloadBytes: 0 });

/** A session like the real one, minus consent: runs the task with the
 * caller's signal unless `outcome` says otherwise. */
function fakeSession(opts: { outcome?: OcrRunResult<never>; avail?: OcrProbe; consent?: Promise<void> } = {}) {
  let runs = 0;
  let avail = opts.avail ?? availableRev("r2");
  return {
    runs: () => runs,
    setAvail(a: OcrProbe) { avail = a; },
    session: {
      async run<T>(task: (s?: AbortSignal) => Promise<T>, o: { signal?: AbortSignal } = {}): Promise<OcrRunResult<T>> {
        runs++;
        if (opts.consent) await opts.consent;   // the notice is up until this settles
        if (opts.outcome) return opts.outcome;
        if (o.signal?.aborted) return { ok: false, reason: "aborted" };
        try { return { ok: true, value: await task(o.signal) }; }
        catch (error) { return o.signal?.aborted ? { ok: false, reason: "aborted" } : { ok: false, reason: "failed", error }; }
      },
      availability: async () => avail,
    },
  };
}

/** A meta store over a Map, with every get and put recorded. */
function metaMap() {
  const m = new Map<string, unknown>();
  const gets: string[] = [], puts: string[] = [];
  return {
    m, gets, puts,
    deps: {
      metaGet: async (k: string) => { gets.push(k); return m.get(k); },
      metaPut: async (k: string, v: unknown) => { puts.push(k); m.set(k, v); },
    },
  };
}

const LINES: SeamLine[] = [
  { str: "ROOM 101", x: 10, y: 40, w: 80, h: 12, confidence: 0.9 },
  { str: "CPT-1 CARPET TILE THROUGHOUT", x: 200, y: 400, w: 900, h: 14, clipped: true },
];

/** A page whose viewport at scale s is 100s × 50s, counting opens. */
function page() {
  let opens = 0;
  const p = { getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 50 * scale }) };
  return { opens: () => opens, getPage: async () => { opens++; return p; }, p };
}

/** A readRegion the test settles; records every call. */
function deferredRegion() {
  const calls: { page: unknown; rs: number; rect: unknown; signal?: AbortSignal; onProgress?: (p: SeamProgress) => void; resolve: (v: { lines: SeamLine[]; ms: number; rasters: number }) => void; reject: (e: unknown) => void }[] = [];
  const readRegion: ReadRegion = (pg, rs, rect, o) => new Promise((resolve, reject) => {
    calls.push({ page: pg, rs, rect, signal: o?.signal, onProgress: o?.onProgress, resolve, reject });
    o?.signal?.addEventListener("abort", () => reject(new DOMException("The OCR read was cancelled.", "AbortError")), { once: true });
  });
  return { calls, readRegion };
}
const instantRegion = (lines = LINES): ReadRegion => async () => ({ lines, ms: 4200, rasters: 6 });

function setup(o: { outcome?: OcrRunResult<never>; avail?: OcrProbe; readRegion?: ReadRegion; idle?: () => Promise<void> } = {}) {
  const s = fakeSession(o);
  const meta = metaMap();
  const cache = createPageCache(meta.deps);
  const indexed: { key: string; lines: unknown[] }[] = [];
  const reader = createPageReader({ session: s.session, cache, readRegion: o.readRegion ?? instantRegion(), idle: o.idle, onLines: (key, lines) => indexed.push({ key, lines }) });
  const pg = page();
  const req = (key = "A.pdf", extra: Record<string, unknown> = {}) => {
    const hashed = /#(\d+)$/.exec(key);
    return { key, file: key.replace(/#\d+$/, ""), page: hashed ? Number(hashed[1]) : 1, rs: RS, getPage: pg.getPage, pdfHash: async () => HASH, ...extra };
  };
  return { s, meta, cache, reader, indexed, pg, req };
}

// ── readPageText: one read ───────────────────────────────────────────────────

test("a miss reads the full page at rs through session.run and stores it", async () => {
  const s = fakeSession();
  const meta = metaMap();
  const cache = createPageCache(meta.deps);
  const pg = page();
  const calls: unknown[][] = [];
  const readRegion: ReadRegion = async (p, rs, rect) => { calls.push([p, rs, rect]); return { lines: LINES, ms: 4200, rasters: 6 }; };
  const r = await readPageText({ page: 3, rs: RS, getPage: pg.getPage, pdfHash: async () => HASH, session: s.session, cache, readRegion });
  assert.equal(s.runs(), 1);
  assert.deepEqual(calls, [[pg.p, RS, { x0: 0, y0: 0, x1: 200, y1: 100 }]]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual({ ms: r.ms, rasters: r.rasters, source: r.source, stale: r.stale, cached: r.cached }, { ms: 4200, rasters: 6, source: "ocr", stale: false, cached: false });
  assert.deepEqual(r.lines.map((l) => l.str), LINES.map((l) => l.str));
  assert.deepEqual(meta.puts, [ocrCacheKey(HASH, 3)]);
  const hit = await cache.get(HASH, 3, { rs: RS, rev: "r2" });
  assert.ok(hit, "the stored read is a valid cache entry");
  assert.equal(hit.rev, "r2");
  assert.equal(hit.stale, false);
  assert.deepEqual(hit.lines, [
    { str: "ROOM 101", x: 10, y: 40, w: 80, h: 12, confidence: 0.9 },
    { str: "CPT-1 CARPET TILE THROUGHOUT", x: 200, y: 400, w: 900, h: 14, clipped: true },
  ]);
});

test("the cache is asked first with the probed rev; a hit opens no page and asks no consent", async () => {
  const s = fakeSession({ avail: availableRev("r2") });
  const meta = metaMap();
  const cache = createPageCache(meta.deps);
  await cache.put(HASH, 1, { rev: "r1", rs: 1, lines: [{ str: "OLD", x: 1, y: 2, w: 3, h: 4 }], ms: 900, rasters: 2 });
  const pg = page();
  const r = await readPageText({ page: 1, rs: RS, getPage: pg.getPage, pdfHash: async () => HASH, session: s.session, cache, readRegion: instantRegion() });
  assert.equal(s.runs(), 0);
  assert.equal(pg.opens(), 0);
  assert.deepEqual(r, { ok: true, lines: [{ str: "OLD", x: 2, y: 4, w: 6, h: 8 }], ms: 900, rasters: 2, source: "ocr", stale: true, cached: true, rev: "r1" });
});

test("with the rev unknown (probe not available) a hit is not stale", async () => {
  const s = fakeSession({ avail: { state: "error", message: "offline" } });
  const meta = metaMap();
  const cache = createPageCache(meta.deps);
  await cache.put(HASH, 1, { rev: "r1", rs: RS, lines: [], ms: 1, rasters: 1 });
  const r = await readPageText({ page: 1, rs: RS, getPage: page().getPage, pdfHash: async () => HASH, session: s.session, cache, readRegion: instantRegion() });
  assert.equal(r.ok && r.stale, false);
  assert.equal(r.ok && r.cached, true);
});

test("a read saved by an earlier engine (stale-ok) comes back stale, no engine run, the rev known or not; Read again saves it fresh", async () => {
  // NOW stands in for the current engine's opts, so this holds whatever the
  // shipped hash is
  const NOW = "0000beef";
  for (const avail of [availableRev("r2"), { state: "error", message: "offline" } as OcrProbe]) {
    const s = fakeSession({ avail });
    const meta = metaMap();
    await createPageCache(meta.deps, { opts: STALE_OK_OPTS[0] }).put(HASH, 1, { rev: "r2", rs: RS, lines: [{ str: "OLD", x: 1, y: 2, w: 3, h: 4 }], ms: 900, rasters: 2 });
    const cache = createPageCache(meta.deps, { opts: NOW });
    const pg = page();
    const r = await readPageText({ page: 1, rs: RS, getPage: pg.getPage, pdfHash: async () => HASH, session: s.session, cache, readRegion: instantRegion() });
    assert.equal(s.runs(), 0, avail.state);
    assert.equal(pg.opens(), 0, avail.state);
    assert.deepEqual(r, { ok: true, lines: [{ str: "OLD", x: 1, y: 2, w: 3, h: 4 }], ms: 900, rasters: 2, source: "ocr", stale: true, cached: true, rev: "r2" }, avail.state);
  }
  const s = fakeSession();
  const meta = metaMap();
  await createPageCache(meta.deps, { opts: STALE_OK_OPTS[0] }).put(HASH, 1, { rev: "r2", rs: RS, lines: [], ms: 1, rasters: 1 });
  const cache = createPageCache(meta.deps, { opts: NOW });
  const again = await readPageText({ page: 1, rs: RS, getPage: page().getPage, pdfHash: async () => HASH, session: s.session, cache, readRegion: instantRegion(), force: true });
  assert.equal(again.ok && again.cached, false);
  const hit = await cache.get(HASH, 1, { rs: RS, rev: "r2" });
  assert.equal(hit?.stale, false, "Read again replaced it with a fresh read");
  assert.equal(hit?.lines.length, LINES.length);
});

test("force (Read again) skips the cache lookup and reads", async () => {
  const s = fakeSession();
  const meta = metaMap();
  const cache = createPageCache(meta.deps);
  await cache.put(HASH, 1, { rev: "r1", rs: RS, lines: [], ms: 1, rasters: 1 });
  meta.gets.length = 0;
  const r = await readPageText({ page: 1, rs: RS, getPage: page().getPage, pdfHash: async () => HASH, session: s.session, cache, readRegion: instantRegion(), force: true });
  assert.equal(meta.gets.length, 0);
  assert.equal(s.runs(), 1);
  assert.equal(r.ok && r.cached, false);
  const hit = await cache.get(HASH, 1, { rs: RS, rev: "r2" });
  assert.equal(hit?.rev, "r2", "the new read replaced the old one");
});

test("no hash: no cache lookup, no store, the read still runs", async () => {
  const s = fakeSession();
  const meta = metaMap();
  const r = await readPageText({ page: 1, rs: RS, getPage: page().getPage, pdfHash: async () => null, session: s.session, cache: createPageCache(meta.deps), readRegion: instantRegion() });
  assert.equal(r.ok, true);
  assert.deepEqual([meta.gets, meta.puts], [[], []]);
});

test("a hash that throws counts as no hash", async () => {
  const s = fakeSession();
  const meta = metaMap();
  const r = await readPageText({ page: 1, rs: RS, getPage: page().getPage, pdfHash: async () => { throw new Error("gone"); }, session: s.session, cache: createPageCache(meta.deps), readRegion: instantRegion() });
  assert.equal(r.ok, true);
  assert.deepEqual(meta.puts, []);
});

test("a store that refuses the write doesn't fail the read, says it wasn't saved, and warns", async () => {
  const s = fakeSession();
  const cache = createPageCache({ metaGet: async () => undefined, metaPut: async () => { throw new Error("quota"); } });
  const warned = captureWarn();
  try {
    const r = await readPageText({ page: 1, rs: RS, getPage: page().getPage, pdfHash: async () => HASH, session: s.session, cache, readRegion: instantRegion() });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.saved, false);
    assert.match(String(warned.calls[0]?.[0]), /OCR cache: couldn't save page read/);
  } finally { warned.restore(); }
  const ok = await readPageText({ page: 1, rs: RS, getPage: page().getPage, pdfHash: async () => HASH, session: s.session, cache: createPageCache(metaMap().deps), readRegion: instantRegion() });
  assert.equal(ok.ok && "saved" in ok, false, "a saved read carries no flag");
});

test("a lookup that throws is a miss", async () => {
  const s = fakeSession();
  const cache = createPageCache({ metaGet: async () => { throw new Error("idb"); }, metaPut: async () => {} });
  const r = await readPageText({ page: 1, rs: RS, getPage: page().getPage, pdfHash: async () => HASH, session: s.session, cache, readRegion: instantRegion() });
  assert.equal(r.ok && r.cached, false);
  assert.equal(s.runs(), 1);
});

test("with the rev unknown after the read, nothing is stored", async () => {
  const s = fakeSession({ avail: { state: "error", message: "offline" } });
  const meta = metaMap();
  const r = await readPageText({ page: 1, rs: RS, getPage: page().getPage, pdfHash: async () => HASH, session: s.session, cache: createPageCache(meta.deps), readRegion: instantRegion() });
  assert.equal(r.ok, true);
  assert.deepEqual(meta.puts, []);
});

test("every session outcome maps to one typed status", async () => {
  const cases: [OcrRunResult<never>, { status: string; message?: string }][] = [
    [{ ok: false, reason: "declined" }, { status: "declined" }],
    [{ ok: false, reason: "aborted" }, { status: "aborted" }],
    [{ ok: false, reason: "disabled" }, { status: "disabled" }],
    [{ ok: false, reason: "uninstalled" }, { status: "uninstalled" }],
    [{ ok: false, reason: "error", message: "worker died" }, { status: "error", message: "worker died" }],
    [{ ok: false, reason: "failed", error: new Error("render failed") }, { status: "failed", message: "render failed" }],
    [{ ok: false, reason: "failed", error: new DOMException("The page was closed during the read.", "AbortError") }, { status: "page-closed", message: "The page was closed during the read." }],
    [{ ok: false, reason: "failed", error: "odd" }, { status: "failed", message: "odd" }],
  ];
  for (const [outcome, want] of cases) {
    const s = fakeSession({ outcome });
    const meta = metaMap();
    const r = await readPageText({ page: 1, rs: RS, getPage: page().getPage, pdfHash: async () => HASH, session: s.session, cache: createPageCache(meta.deps), readRegion: instantRegion() });
    assert.deepEqual(r, { ok: false, ...want }, JSON.stringify(outcome));
    assert.deepEqual(meta.puts, []);
  }
});

test("an abort before the read starts ends it as aborted without a run", async () => {
  const s = fakeSession();
  const ac = new AbortController();
  ac.abort();
  const r = await readPageText({ page: 1, rs: RS, getPage: page().getPage, pdfHash: async () => HASH, session: s.session, cache: createPageCache(metaMap().deps), readRegion: instantRegion(), signal: ac.signal });
  assert.deepEqual(r, { ok: false, status: "aborted" });
  assert.equal(s.runs(), 0);
});

// ── the controller ───────────────────────────────────────────────────────────

test("a finished read goes to onLines and shows done", async () => {
  const t = setup();
  const r = await t.reader.read(t.req("A.pdf#2"));
  assert.equal(r.ok, true);
  assert.deepEqual(t.indexed.map((x) => x.key), ["A.pdf#2"]);
  assert.deepEqual(t.indexed[0].lines.map((l) => (l as SeamLine).str), LINES.map((l) => l.str));
  assert.deepEqual(t.reader.status("A.pdf#2"), { state: "done", ms: 4200, rasters: 6, stale: false, cached: false });
});

test("a second request for the same page joins the running read", async () => {
  const d = deferredRegion();
  const t = setup({ readRegion: d.readRegion });
  const a = t.reader.read(t.req("A.pdf"));
  const b = t.reader.read(t.req("A.pdf"));
  assert.equal(a, b, "the same promise");
  await tick(); await tick();
  assert.equal(d.calls.length, 1);
  assert.equal(t.s.runs(), 1);
  d.calls[0].resolve({ lines: LINES, ms: 10, rasters: 1 });
  await a;
  assert.equal(t.indexed.length, 1, "indexed once");
  // settled: the next request is a new read (forced past the cache here)
  const c = t.reader.read(t.req("A.pdf", { force: true }));
  assert.notEqual(c, a);
  await tick(); await tick();
  assert.equal(d.calls.length, 2);
  d.calls[1].resolve({ lines: LINES, ms: 10, rasters: 1 });
  await c;
});

test("reads of different pages run one at a time, in order", async () => {
  const d = deferredRegion();
  const t = setup({ readRegion: d.readRegion });
  const a = t.reader.read(t.req("A.pdf"));
  const b = t.reader.read(t.req("A.pdf#2"));
  const c = t.reader.read(t.req("B.pdf"));
  assert.notEqual(a, b);
  await tick(); await tick();
  assert.equal(d.calls.length, 1, "only the first is reading");
  assert.deepEqual(t.reader.status("A.pdf#2"), { state: "reading", progress: null }, "the queued one shows as starting");
  d.calls[0].resolve({ lines: [], ms: 1, rasters: 1 });
  await a; await tick(); await tick();
  assert.equal(d.calls.length, 2);
  d.calls[1].resolve({ lines: [], ms: 1, rasters: 1 });
  await b; await tick(); await tick();
  assert.equal(d.calls.length, 3);
  d.calls[2].resolve({ lines: [], ms: 1, rasters: 1 });
  await c;
});

test("a cache hit doesn't wait behind a running read", async () => {
  const d = deferredRegion();
  const t = setup({ readRegion: d.readRegion });
  await t.cache.put(HASH, 2, { rev: "r2", rs: RS, lines: [], ms: 5, rasters: 1 });
  const a = t.reader.read(t.req("A.pdf"));
  await tick(); await tick();
  const b = await t.reader.read(t.req("A.pdf#2"));
  assert.equal(b.ok && b.cached, true);
  d.calls[0].resolve({ lines: [], ms: 1, rasters: 1 });
  await a;
});

test("a queued read cancelled before its turn ends aborted, never reads, and doesn't hold up the next", async () => {
  const d = deferredRegion();
  const t = setup({ readRegion: d.readRegion });
  const a = t.reader.read(t.req("A.pdf"));
  const b = t.reader.read(t.req("B.pdf"));
  const c = t.reader.read(t.req("C.pdf"));
  await tick(); await tick();
  t.reader.cancel("B.pdf");
  assert.deepEqual(await b, { ok: false, status: "aborted" });
  assert.equal(d.calls.length, 1, "C still waits for A");
  d.calls[0].resolve({ lines: [], ms: 1, rasters: 1 });
  await a; await tick(); await tick();
  assert.equal(d.calls.length, 2, "C reads next; B never did");
  d.calls[1].resolve({ lines: [], ms: 1, rasters: 1 });
  await c;
});

test("on a miss the page opens before consent (its size decides if it can be read); the read waits for consent", async () => {
  let consent!: () => void;
  const s = fakeSession({ consent: new Promise<void>((r) => { consent = r; }) });
  const pg = page();
  const d = deferredRegion();
  const reader = createPageReader({ session: s.session, cache: createPageCache(metaMap().deps), readRegion: d.readRegion, onLines: () => {} });
  const r = reader.read({ key: "A.pdf", file: "A.pdf", page: 1, rs: RS, getPage: pg.getPage, pdfHash: async () => HASH });
  await tick(); await tick();
  assert.equal(pg.opens(), 1);
  assert.equal(d.calls.length, 0, "nothing read while the notice is up");
  consent();
  await tick(); await tick();
  assert.equal(d.calls.length, 1);
  d.calls[0].resolve({ lines: [], ms: 1, rasters: 1 });
  await r;
  assert.equal(pg.opens(), 1);
});

test("cancel then Read at once: the next read's first raster waits for the worker's late reply", async () => {
  // A read regionRead would give: rejects at the abort, while the worker is
  // still on its tile until `lateReply` (the client's whenIdle).
  let lateReply!: () => void;
  let busy = false;
  const idleWaiters: (() => void)[] = [];
  const idle = () => new Promise<void>((res) => { if (!busy) res(); else idleWaiters.push(res); });
  const rasterized: string[] = [];
  const readRegion: ReadRegion = (_p, _rs, _rect, o) => new Promise((res, rej) => {
    const who = rasterized.length === 0 ? "A" : "B";
    rasterized.push(who);
    busy = true;
    lateReply = () => { busy = false; for (const w of idleWaiters.splice(0)) w(); };
    if (who === "B") { busy = false; res({ lines: [], ms: 1, rasters: 1 }); return; }
    o?.signal?.addEventListener("abort", () => rej(new DOMException("The OCR read was cancelled.", "AbortError")), { once: true });
  });
  const t = setup({ readRegion, idle });
  const a = t.reader.read(t.req("A.pdf"));
  await tick(); await tick();
  assert.deepEqual(rasterized, ["A"]);
  t.reader.cancel("A.pdf");
  const b = t.reader.read(t.req("B.pdf"));
  assert.deepEqual(await a, { ok: false, status: "aborted" });
  await tick(); await tick(); await tick();
  assert.deepEqual(rasterized, ["A"], "B hasn't rendered: the worker is still on A's tile");
  assert.deepEqual(t.reader.status("A.pdf"), { state: "stopping" }, "Stopping… until the worker is idle");
  lateReply();
  await b;
  assert.deepEqual(rasterized, ["A", "B"]);
  assert.deepEqual(t.reader.status("A.pdf"), { state: "aborted" });
});

test("progress shows as reading, and reaches the caller", async () => {
  const d = deferredRegion();
  const t = setup({ readRegion: d.readRegion });
  const seen: SeamProgress[] = [];
  const r = t.reader.read(t.req("A.pdf", { onProgress: (p: SeamProgress) => seen.push(p) }));
  assert.deepEqual(t.reader.status("A.pdf"), { state: "reading", progress: null });
  await tick(); await tick();
  const p: SeamProgress = { phase: "tiles", done: 2, total: 6, rastersDone: 2, rastersPlanned: 6 };
  d.calls[0].onProgress?.(p);
  assert.deepEqual(t.reader.status("A.pdf"), { state: "reading", progress: p });
  assert.deepEqual(seen, [p]);
  d.calls[0].resolve({ lines: [], ms: 1, rasters: 6 });
  await r;
});

test("cancel shows Stopping… until the read settles, then aborted", async () => {
  const s = fakeSession();
  let release!: () => void;
  // A task that ends only when the test says, even after the abort: the
  // "tile still in the worker" case.
  const readRegion: ReadRegion = (_p, _rs, _rect, o) => new Promise((_res, rej) => {
    release = () => rej(new DOMException("The OCR read was cancelled.", "AbortError"));
    void o;
  });
  const reader = createPageReader({ session: s.session, cache: createPageCache(metaMap().deps), readRegion, onLines: () => {} });
  const pg = page();
  const r = reader.read({ key: "A.pdf", file: "A.pdf", page: 1, rs: RS, getPage: pg.getPage, pdfHash: async () => HASH });
  await tick(); await tick();
  reader.cancel("A.pdf");
  assert.deepEqual(reader.status("A.pdf"), { state: "stopping" });
  await tick();
  assert.deepEqual(reader.status("A.pdf"), { state: "stopping" }, "still stopping while the task runs");
  release();
  assert.deepEqual(await r, { ok: false, status: "aborted" });
  assert.deepEqual(reader.status("A.pdf"), { state: "aborted" });
});

test("cancel aborts the signal the task was given", async () => {
  const d = deferredRegion();
  const t = setup({ readRegion: d.readRegion });
  const r = t.reader.read(t.req("A.pdf"));
  await tick(); await tick();
  t.reader.cancel("A.pdf");
  assert.equal(d.calls[0].signal?.aborted, true);
  assert.deepEqual(await r, { ok: false, status: "aborted" });
});

test("the caller's own signal aborts the read too", async () => {
  const d = deferredRegion();
  const t = setup({ readRegion: d.readRegion });
  const ac = new AbortController();
  const r = t.reader.read(t.req("A.pdf", { signal: ac.signal }));
  await tick(); await tick();
  ac.abort();
  assert.deepEqual(await r, { ok: false, status: "aborted" });
});

test("cancel of a page with no read running changes nothing", () => {
  const t = setup();
  t.reader.cancel("nope.pdf");
  assert.equal(t.reader.status("nope.pdf"), undefined);
});

test("a failure is kept as the page's status", async () => {
  const t = setup({ outcome: { ok: false, reason: "failed", error: new DOMException("The page was closed during the read.", "AbortError") } });
  await t.reader.read(t.req("A.pdf"));
  assert.deepEqual(t.reader.status("A.pdf"), { state: "page-closed", message: "The page was closed during the read." });
});

test("subscribers hear every status change", async () => {
  const t = setup();
  let n = 0;
  const off = t.reader.subscribe(() => { n++; });
  await t.reader.read(t.req("A.pdf"));
  assert.ok(n >= 2, `reading then done (heard ${n})`);
  off();
  const before = n;
  await t.reader.read(t.req("A.pdf#2"));
  assert.equal(n, before);
});

test("dropFile aborts the file's reads and a late result leaves no trace", async () => {
  const s = fakeSession();
  let finish!: () => void;
  // ignores the abort: its result lands after the drop
  const readRegion: ReadRegion = () => new Promise((res) => { finish = () => res({ lines: LINES, ms: 1, rasters: 1 }); });
  const indexed: string[] = [];
  const reader = createPageReader({ session: s.session, cache: createPageCache(metaMap().deps), readRegion, onLines: (k) => indexed.push(k) });
  const r = reader.read({ key: "A.pdf#2", file: "A.pdf", page: 2, rs: RS, getPage: page().getPage, pdfHash: async () => HASH });
  await tick(); await tick();
  reader.dropFile("A.pdf");
  assert.equal(reader.status("A.pdf#2"), undefined, "status cleared at once");
  finish();
  await r;
  assert.deepEqual(indexed, [], "nothing indexed for the dropped bytes");
  assert.equal(reader.status("A.pdf#2"), undefined);
});

test("dropFile leaves other files alone, and matches names with '#' exactly", async () => {
  const t = setup();
  await t.reader.read(t.req("B.pdf"));
  await t.reader.read(t.req("A.pdf#1x.pdf"));
  t.reader.dropFile("A.pdf");
  assert.equal(t.reader.status("B.pdf")?.state, "done");
  assert.equal(t.reader.status("A.pdf#1x.pdf")?.state, "done");
});

test("dropFile aborts a running read's signal", async () => {
  const d = deferredRegion();
  const t = setup({ readRegion: d.readRegion });
  const r = t.reader.read(t.req("A.pdf"));
  await tick(); await tick();
  t.reader.dropFile("A.pdf");
  assert.equal(d.calls[0].signal?.aborted, true);
  await r;
  assert.equal(t.reader.status("A.pdf"), undefined);
});

test("dispose aborts every read, running or queued", async () => {
  const d = deferredRegion();
  const t = setup({ readRegion: d.readRegion });
  const a = t.reader.read(t.req("A.pdf"));
  const b = t.reader.read(t.req("B.pdf"));
  await tick(); await tick();
  t.reader.dispose();
  assert.deepEqual(d.calls.map((c) => c.signal?.aborted), [true]);
  assert.deepEqual(await Promise.all([a, b]), [{ ok: false, status: "aborted" }, { ok: false, status: "aborted" }]);
  assert.equal(d.calls.length, 1, "the queued one never read");
});

// ── lookup: the cache alone ──────────────────────────────────────────────────

test("lookup loads a cached read into the index silently: no run, no page", async () => {
  const t = setup();
  await t.cache.put(HASH, 2, { rev: "r2", rs: RS, lines: [{ str: "LOBBY", x: 1, y: 1, w: 1, h: 1 }], ms: 3000, rasters: 4 });
  const hit = await t.reader.lookup(t.req("A.pdf#2"));
  assert.equal(hit?.lines[0].str, "LOBBY");
  assert.equal(t.s.runs(), 0);
  assert.equal(t.pg.opens(), 0);
  assert.deepEqual(t.indexed.map((x) => x.key), ["A.pdf#2"]);
  assert.deepEqual(t.reader.status("A.pdf#2"), { state: "done", ms: 3000, rasters: 4, stale: false, cached: true });
});

test("lookup of a stale-ok read with the rev unknown: indexed, shown done and stale, so Read again shows once OCR is available", async () => {
  const s = fakeSession({ avail: { state: "error", message: "offline" } });
  const meta = metaMap();
  await createPageCache(meta.deps, { opts: STALE_OK_OPTS[0] }).put(HASH, 2, { rev: "r1", rs: RS, lines: [{ str: "LOBBY", x: 1, y: 1, w: 1, h: 1 }], ms: 3000, rasters: 4 });
  const indexed: string[] = [];
  const reader = createPageReader({ session: s.session, cache: createPageCache(meta.deps, { opts: "0000beef" }), readRegion: instantRegion(), onLines: (key) => indexed.push(key) });
  const hit = await reader.lookup({ key: "A.pdf#2", file: "A.pdf", page: 2, rs: RS, pdfHash: async () => HASH });
  assert.equal(hit?.lines[0].str, "LOBBY");
  assert.equal(s.runs(), 0);
  assert.deepEqual(indexed, ["A.pdf#2"], "still in search and Copy");
  const status = reader.status("A.pdf#2");
  assert.deepEqual(status, { state: "done", ms: 3000, rasters: 4, stale: true, cached: true });
  assert.deepEqual(pageReadView({ textless: true, avail: "error", status }), { kind: "done", text: "Read in 3.0 s · OCR", readAgain: false });
  assert.deepEqual(pageReadView({ textless: true, avail: "available", status }), { kind: "done", text: "Read in 3.0 s · OCR", readAgain: true });
});

test("lookup shows checking while it runs, and clears it on a miss", async () => {
  const t = setup();
  const p = t.reader.lookup(t.req("A.pdf"));
  assert.deepEqual(t.reader.status("A.pdf"), { state: "checking" });
  assert.equal(await p, null);
  assert.equal(t.reader.status("A.pdf"), undefined);
  assert.deepEqual(t.indexed, []);
});

test("lookup asks the store once per page; a finished read is its answer; a drop forgets", async () => {
  const t = setup();
  await t.reader.lookup(t.req("A.pdf"));
  await t.reader.lookup(t.req("A.pdf"));
  assert.equal(t.meta.gets.length, 1);
  await t.reader.read(t.req("A.pdf", { force: true }));
  const gets = t.meta.gets.length;
  const hit = await t.reader.lookup(t.req("A.pdf"));
  assert.equal(t.meta.gets.length, gets, "no store read: the finished read is the answer");
  assert.deepEqual(hit && { rev: hit.rev, rs: hit.rs, ms: hit.ms, rasters: hit.rasters, stale: hit.stale, n: hit.lines.length }, { rev: "r2", rs: RS, ms: 4200, rasters: 6, stale: false, n: LINES.length });
  t.reader.dropFile("A.pdf");
  const before = t.meta.gets.length;
  await t.reader.lookup(t.req("A.pdf"));
  assert.equal(t.meta.gets.length, before + 1);
});

test("lookup while a read runs leaves it alone", async () => {
  const d = deferredRegion();
  const t = setup({ readRegion: d.readRegion });
  const r = t.reader.read(t.req("A.pdf", { force: true }));
  assert.equal(await t.reader.lookup(t.req("A.pdf")), null);
  assert.equal(t.reader.status("A.pdf")?.state, "reading");
  await tick(); await tick();
  d.calls[0].resolve({ lines: [], ms: 1, rasters: 1 });
  await r;
});

test("a lookup that lands after its file was dropped indexes nothing", async () => {
  let release!: (v: unknown) => void;
  const s = fakeSession();
  const cache = createPageCache({ metaGet: () => new Promise((res) => { release = res; }), metaPut: async () => {} });
  const indexed: string[] = [];
  const reader = createPageReader({ session: s.session, cache, readRegion: instantRegion(), onLines: (k) => indexed.push(k) });
  const p = reader.lookup({ key: "A.pdf", file: "A.pdf", page: 1, rs: RS, pdfHash: async () => HASH });
  await tick(); await tick();
  reader.dropFile("A.pdf");
  release({ v: 1, rev: "r2", opts: OCR_CACHE_OPTS, rs: RS, lines: [], ms: 1, rasters: 1, at: 1 });
  await p;
  assert.deepEqual(indexed, []);
  assert.equal(reader.status("A.pdf"), undefined);
});

// ── the Read control's face ──────────────────────────────────────────────────

test("progressText names the phase and its count", () => {
  assert.equal(progressText({ phase: "tiles", done: 2, total: 6, rastersDone: 2, rastersPlanned: 6 }), "Reading tiles 2/6");
  assert.equal(progressText({ phase: "seams", done: 1, total: 3, rastersDone: 7, rastersPlanned: 9 }), "Joining seams 1/3");
  assert.equal(progressText(null), "Starting…");
});

test("pageReadView: hidden unless the page has no text layer and OCR is available", () => {
  const st: PageReadStatus | undefined = undefined;
  assert.deepEqual(pageReadView({ textless: false, avail: "available", status: st }), { kind: "hidden" });
  assert.deepEqual(pageReadView({ textless: undefined, avail: "available", status: st }), { kind: "hidden" });
  for (const avail of [null, "disabled", "uninstalled"] as const) {
    assert.deepEqual(pageReadView({ textless: true, avail, status: st }), { kind: "hidden" }, String(avail));
  }
  assert.deepEqual(pageReadView({ textless: true, avail: "available", status: st }), { kind: "read" });
  assert.deepEqual(pageReadView({ textless: true, avail: "available", status: { state: "checking" } }), { kind: "hidden" });
});

test("pageReadView: reading, stopping, done, read again", () => {
  const v = (status: PageReadStatus) => pageReadView({ textless: true, avail: "available", status });
  assert.deepEqual(v({ state: "reading", progress: { phase: "seams", done: 1, total: 2, rastersDone: 7, rastersPlanned: 8 } }), { kind: "reading", text: "Joining seams 1/2" });
  assert.deepEqual(v({ state: "stopping" }), { kind: "stopping", text: "Stopping…" });
  assert.deepEqual(v({ state: "done", ms: 12_340, rasters: 6, stale: false, cached: false }), { kind: "done", text: "Read in 12.3 s · OCR", readAgain: false });
  assert.deepEqual(v({ state: "done", ms: 950, rasters: 6, stale: true, cached: true }), { kind: "done", text: "Read in 1.0 s · OCR", readAgain: true });
});

test("pageReadView: a read stays labelled, and a running one cancellable, unless OCR is off or not installed", () => {
  const done = { state: "done", ms: 2000, rasters: 1, stale: true, cached: true } as const;
  const reading = { state: "reading", progress: null } as const;
  for (const avail of ["disabled", "uninstalled"] as const) {
    assert.deepEqual(pageReadView({ textless: true, avail, status: done }), { kind: "hidden" }, avail);
    assert.deepEqual(pageReadView({ textless: true, avail, status: reading }), { kind: "hidden" }, avail);
  }
  // not probed yet, or the probe failed (offline): the cached read still
  // shows as OCR, but Read again needs the probe
  for (const avail of [null, "error"] as const) {
    assert.deepEqual(pageReadView({ textless: true, avail, status: done }), { kind: "done", text: "Read in 2.0 s · OCR", readAgain: false }, String(avail));
    assert.deepEqual(pageReadView({ textless: true, avail, status: reading }), { kind: "reading", text: "Starting…" }, String(avail));
    assert.deepEqual(pageReadView({ textless: true, avail, status: { state: "stopping" } }), { kind: "stopping", text: "Stopping…" }, String(avail));
    if (avail === null) assert.deepEqual(pageReadView({ textless: true, avail, status: { state: "failed", message: "x" } }), { kind: "hidden" });
  }
  assert.deepEqual(pageReadView({ textless: false, avail: "available", status: done }), { kind: "hidden" });
});

test("pageReadView: after a failure Read shows again, with what happened", () => {
  const v = (status: PageReadStatus) => pageReadView({ textless: true, avail: "available", status });
  assert.deepEqual(v({ state: "declined" }), { kind: "read" });
  assert.deepEqual(v({ state: "aborted" }), { kind: "read" });
  assert.deepEqual(v({ state: "page-closed", message: "The page was closed during the read." }), { kind: "read", note: "The page was closed during the read." });
  assert.deepEqual(v({ state: "failed", message: "boom" }), { kind: "read", note: "Couldn't read this page: boom" });
  assert.deepEqual(v({ state: "error", message: "worker" }), { kind: "read", note: "The on-device text reader (OCR) didn't start: worker" });
  assert.deepEqual(v({ state: "disabled" }), { kind: "hidden" });
  assert.deepEqual(v({ state: "uninstalled" }), { kind: "hidden" });
});

// ── what re-renders the canvas, and reads off screen ─────────────────────────

test("active lists the reads running or stopping, with their files", async () => {
  const d = deferredRegion();
  const t = setup({ readRegion: d.readRegion });
  const a = t.reader.read(t.req("A.pdf#2"));
  const b = t.reader.read(t.req("B.pdf"));
  await tick(); await tick();
  t.reader.cancel("B.pdf");
  assert.deepEqual(t.reader.active(), [
    { key: "A.pdf#2", status: { state: "reading", progress: null } },
    { key: "B.pdf", status: { state: "stopping" } },
  ]);
  d.calls[0].resolve({ lines: [], ms: 1, rasters: 1 });
  await Promise.all([a, b]);
  await tick();
  assert.deepEqual(t.reader.active(), []);
});

test("readSignature: changes for a shown sheet's status; off screen only when a read starts, stops or stops being cancellable", () => {
  const statuses = new Map<string, PageReadStatus>();
  const active = (): ActiveRead[] => [...statuses].flatMap(([key, status]) => (status.state === "reading" || status.state === "stopping" ? [{ key, status }] : []));
  const sig = () => readSignature(["A.pdf"], (k) => statuses.get(k), active());
  const s0 = sig();
  statuses.set("A.pdf", { state: "reading", progress: { phase: "tiles", done: 1, total: 4, rastersDone: 1, rastersPlanned: 4 } });
  const s1 = sig();
  assert.notEqual(s1, s0);
  statuses.set("A.pdf", { state: "reading", progress: { phase: "tiles", done: 2, total: 4, rastersDone: 2, rastersPlanned: 4 } });
  assert.notEqual(sig(), s1, "shown progress re-renders");
  const s2 = sig();
  statuses.set("Z.pdf", { state: "checking" });
  assert.equal(sig(), s2, "an off-screen lookup doesn't");
  statuses.set("Z.pdf", { state: "done", ms: 1, rasters: 1, stale: false, cached: true });
  assert.equal(sig(), s2, "nor an off-screen cache hit");
  statuses.set("Y.pdf", { state: "reading", progress: null });
  const s3 = sig();
  assert.notEqual(s3, s2, "an off-screen read starting does (its Cancel row)");
  statuses.set("Y.pdf", { state: "reading", progress: { phase: "tiles", done: 3, total: 9, rastersDone: 3, rastersPlanned: 9 } });
  assert.equal(sig(), s3, "its progress doesn't");
  statuses.set("Y.pdf", { state: "stopping" });
  const s4 = sig();
  assert.notEqual(s4, s3, "its Stopping… does");
  statuses.set("Y.pdf", { state: "aborted" });
  assert.notEqual(sig(), s4, "its end does");
});

test("backgroundRows: a Cancel row for each read whose sheet isn't on screen", () => {
  const rows = backgroundRows(
    [
      { key: "A.pdf", status: { state: "reading", progress: null } },
      { key: "B.pdf#3", status: { state: "reading", progress: { phase: "seams", done: 1, total: 2, rastersDone: 5, rastersPlanned: 6 } } },
      { key: "C.pdf", status: { state: "stopping" } },
    ],
    ["A.pdf"],
    (k) => `L:${k}`,
  );
  assert.deepEqual(rows, [
    { key: "B.pdf#3", label: "L:B.pdf#3", view: { kind: "reading", text: "Reading L:B.pdf#3…" } },
    { key: "C.pdf", label: "L:C.pdf", view: { kind: "stopping", text: "Stopping L:C.pdf…" } },
  ]);
});

// ── readBox: the copy tool's on-device box read ──────────────────────────────

const BOXR = { x0: 20, y0: 10, x1: 120, y1: 60 };
const boxReq = (t: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) =>
  ({ file: "A.pdf", rs: RS, rect: BOXR, getPage: t.pg.getPage, ...extra });

test("readBox reads the rect at rs through session.run: no cache, no status, no index", async () => {
  const calls: unknown[][] = [];
  const t = setup({ readRegion: async (p, rs, rect) => { calls.push([p, rs, rect]); return { lines: LINES, ms: 900, rasters: 2 }; } });
  const r = await t.reader.readBox(boxReq(t));
  assert.deepEqual(calls, [[t.pg.p, RS, BOXR]]);
  assert.equal(t.s.runs(), 1);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.lines.map((l) => l.str), LINES.map((l) => l.str));
  assert.deepEqual(t.meta.gets, [], "a box read never asks the cache");
  assert.deepEqual(t.meta.puts, [], "and never stores");
  assert.deepEqual(t.indexed, [], "a box's lines never reach the search index");
  assert.equal(t.reader.status("A.pdf"), undefined, "and it shows no page status");
  assert.equal(t.reader.lines("A.pdf"), undefined);
});

test("readBox waits its turn behind a running page read", async () => {
  const d = deferredRegion();
  const t = setup({ readRegion: d.readRegion });
  const a = t.reader.read(t.req("A.pdf"));
  const b = t.reader.readBox(boxReq(t));
  await tick(); await tick();
  assert.equal(d.calls.length, 1, "the box waits for the page read");
  d.calls[0].resolve({ lines: [], ms: 1, rasters: 1 });
  await a; await tick(); await tick();
  assert.equal(d.calls.length, 2);
  assert.deepEqual(d.calls[1].rect, BOXR);
  d.calls[1].resolve({ lines: LINES, ms: 1, rasters: 1 });
  assert.equal((await b).ok, true);
});

test("a page read queued behind a box read waits for it", async () => {
  const d = deferredRegion();
  const t = setup({ readRegion: d.readRegion });
  const b = t.reader.readBox(boxReq(t));
  const a = t.reader.read(t.req("A.pdf#2"));
  await tick(); await tick();
  assert.equal(d.calls.length, 1, "only the box is reading");
  assert.deepEqual(d.calls[0].rect, BOXR);
  d.calls[0].resolve({ lines: [], ms: 1, rasters: 1 });
  await b; await tick(); await tick();
  assert.equal(d.calls.length, 2);
  d.calls[1].resolve({ lines: [], ms: 1, rasters: 1 });
  await a;
});

test("readBox: the caller's abort ends it aborted; declined and disabled come back typed", async () => {
  const d = deferredRegion();
  const t = setup({ readRegion: d.readRegion });
  const ac = new AbortController();
  const r = t.reader.readBox(boxReq(t, { signal: ac.signal }));
  await tick(); await tick();
  ac.abort();
  assert.deepEqual(await r, { ok: false, status: "aborted" });
  for (const reason of ["declined", "disabled", "uninstalled"] as const) {
    const u = setup({ outcome: { ok: false, reason } });
    assert.deepEqual(await u.reader.readBox(boxReq(u)), { ok: false, status: reason });
  }
});

test("dropFile aborts a running box read", async () => {
  const d = deferredRegion();
  const t = setup({ readRegion: d.readRegion });
  const r = t.reader.readBox(boxReq(t));
  await tick(); await tick();
  t.reader.dropFile("A.pdf");
  assert.equal(d.calls[0].signal?.aborted, true);
  const out = await r;
  assert.equal(!out.ok && out.status, "page-closed", "the file went away: not the caller's cancel");
  assert.equal(!out.ok && out.message, "The page was closed during the read.");
});

// ── lines: a finished read's lines, synchronously ────────────────────────────

test("lines(key): a finished read's or cache hit's lines at once; gone with its file", async () => {
  const t = setup();
  assert.equal(t.reader.lines("A.pdf"), undefined);
  await t.reader.read(t.req("A.pdf"));
  assert.deepEqual(t.reader.lines("A.pdf")?.map((l) => l.str), LINES.map((l) => l.str));
  await t.cache.put(HASH, 2, { rev: "r2", rs: RS, lines: [LINES[0]], ms: 5, rasters: 1 });
  await t.reader.lookup(t.req("A.pdf#2"));
  assert.deepEqual(t.reader.lines("A.pdf#2")?.map((l) => l.str), ["ROOM 101"]);
  t.reader.dropFile("A.pdf");
  assert.equal(t.reader.lines("A.pdf"), undefined);
  assert.equal(t.reader.lines("A.pdf#2"), undefined);
});

// ── one hash per file, quiet lookups, the box read's phases (review) ─────────

test("N page lookups and reads of one file ask for its hash once; a drop asks again", async () => {
  const t = setup();
  let asks = 0;
  const pdfHash = async () => { asks++; return HASH; };
  await Promise.all([1, 2, 3, 4, 5].map((n) => t.reader.lookup(t.req(n > 1 ? `A.pdf#${n}` : "A.pdf", { pdfHash }))));
  await t.reader.read(t.req("A.pdf#6", { pdfHash }));
  assert.equal(asks, 1, "one hash for the file, shared by every page's lookup and read");
  await t.reader.lookup(t.req("B.pdf", { pdfHash }));
  assert.equal(asks, 2, "another file asks for its own");
  t.reader.dropFile("A.pdf");
  await t.reader.lookup(t.req("A.pdf#7", { pdfHash }));
  assert.equal(asks, 3, "a dropped file's bytes may have changed: asked again");
});

test("a hash that fails or is null isn't kept: the next page asks again", async () => {
  const t = setup();
  let asks = 0;
  const flaky = async () => { asks++; if (asks === 1) throw new Error("idb"); return asks === 2 ? null : HASH; };
  await t.reader.lookup(t.req("A.pdf", { pdfHash: flaky }));
  await t.reader.lookup(t.req("A.pdf#2", { pdfHash: flaky }));
  await t.reader.lookup(t.req("A.pdf#3", { pdfHash: flaky }));
  await t.reader.lookup(t.req("A.pdf#4", { pdfHash: flaky }));
  assert.equal(asks, 3);
});

test("a lookup notifies checking and then its miss, and leaves no status (the Read control can show again)", async () => {
  const t = setup();
  const heard: (PageReadStatus | undefined)[] = [];
  t.reader.subscribe(() => { heard.push(t.reader.status("A.pdf")); });
  const hit = await t.reader.lookup(t.req("A.pdf"));
  assert.equal(hit, null);
  assert.deepEqual(heard, [{ state: "checking" }, undefined], "both transitions reach the subscribers");
  assert.equal(t.reader.status("A.pdf"), undefined);
});

// The canvas's re-render decision: a notify re-renders iff the signature of
// what is on screen differs from the one the LAST RENDER used.
test("render gate: a miss after a quiet checking and an incidental render re-renders", () => {
  const statuses = new Map<string, PageReadStatus>();
  const shown = ["A.pdf"];
  const sig = () => readSignature(shown, (k) => statuses.get(k), []);
  const gate = createReadRenderGate();
  // notify with no status: re-render, and the render records what it used
  assert.equal(gate.changed(sig()), true);
  gate.rendered(sig());
  // "checking" lands without a notify of its own; something else re-renders
  // the canvas (the probe's state), and that render hides the control
  statuses.set("A.pdf", { state: "checking" });
  gate.rendered(sig());
  // the miss clears it and notifies: the control must come back
  statuses.delete("A.pdf");
  assert.equal(gate.changed(sig()), true, "the render showed checking; now there's no status");
});

test("render gate: lookups of off-screen sheets never re-render the canvas", () => {
  const statuses = new Map<string, PageReadStatus>();
  const sig = () => readSignature(["A.pdf"], (k) => statuses.get(k), []);
  const gate = createReadRenderGate();
  gate.rendered(sig());
  for (const k of ["Z.pdf", "Z.pdf#2", "Y.pdf"]) {
    statuses.set(k, { state: "checking" });
    assert.equal(gate.changed(sig()), false);
    statuses.delete(k);
    assert.equal(gate.changed(sig()), false);
  }
  statuses.set("Z.pdf", { state: "done", ms: 1, rasters: 1, stale: false, cached: true });
  assert.equal(gate.changed(sig()), false, "nor an off-screen cache hit");
});

test("readSignature names the shown sheets: two sheets with no status aren't the same screen", () => {
  const none = () => undefined;
  assert.notEqual(readSignature(["A.pdf"], none, []), readSignature(["B.pdf"], none, []));
  assert.notEqual(readSignature(["A.pdf", "B.pdf"], none, []), readSignature(["B.pdf", "A.pdf"], none, []));
});

test("readBox phases: nothing while consent is pending, waiting until its turn, then reading", async () => {
  let consent!: () => void;
  const d = deferredRegion();
  const s = fakeSession({ consent: new Promise<void>((r) => { consent = r; }) });
  const reader = createPageReader({ session: s.session, cache: createPageCache(metaMap().deps), readRegion: d.readRegion, onLines: () => {} });
  const pg = page();
  const phases: string[] = [];
  const b = reader.readBox({ file: "A.pdf", rs: RS, rect: BOXR, getPage: pg.getPage, onPhase: (p) => phases.push(p) });
  await tick(); await tick();
  assert.deepEqual(phases, [], "the notice is up: no phase yet");
  consent();
  await tick(); await tick();
  assert.deepEqual(phases, ["waiting", "reading"]);
  d.calls[0].resolve({ lines: [], ms: 1, rasters: 1 });
  await b;
});

test("readBox phases: behind a running page read it stays waiting until that read settles", async () => {
  const d = deferredRegion();
  const t = setup({ readRegion: d.readRegion });
  const a = t.reader.read(t.req("A.pdf"));
  const phases: string[] = [];
  const b = t.reader.readBox(boxReq(t, { onPhase: (p: string) => phases.push(p) }));
  await tick(); await tick();
  assert.deepEqual(phases, ["waiting"]);
  d.calls[0].resolve({ lines: [], ms: 1, rasters: 1 });
  await a; await tick(); await tick();
  assert.deepEqual(phases, ["waiting", "reading"]);
  d.calls[1].resolve({ lines: [], ms: 1, rasters: 1 });
  await b;
});

// ── background lookups that never download ───────────────────────────────────

test("a known-only lookup with no known hash is a quiet miss: no download, no checking, no status, nothing memoized", async () => {
  const t = setup();
  let downloads = 0, knownAsks = 0;
  const pdfHash = async () => { downloads++; return HASH; };
  const pdfHashIfKnown = async () => { knownAsks++; return null; };
  let heard = 0;
  t.reader.subscribe(() => { heard++; });
  assert.equal(await t.reader.lookup(t.req("A.pdf", { pdfHash, pdfHashIfKnown }), { known: true }), null);
  assert.equal(downloads, 0, "the downloading hash is never asked");
  assert.equal(knownAsks, 1);
  assert.equal(heard, 0, "no checking state");
  assert.equal(t.reader.status("A.pdf"), undefined, "the card keeps Read page text");
  assert.deepEqual(t.meta.gets, []);
  // not memoized: a later full lookup (a search) asks the store
  await t.reader.lookup(t.req("A.pdf", { pdfHash, pdfHashIfKnown }));
  assert.equal(downloads, 1);
  assert.equal(t.meta.gets.length, 1);
});

test("a known-only lookup with a known hash looks the cache up as usual", async () => {
  const t = setup();
  await t.cache.put(HASH, 2, { rev: "r2", rs: RS, lines: [LINES[0]], ms: 5, rasters: 1 });
  let downloads = 0;
  const hit = await t.reader.lookup(t.req("A.pdf#2", { pdfHash: async () => { downloads++; return HASH; }, pdfHashIfKnown: async () => HASH }), { known: true });
  assert.equal(hit?.lines[0].str, "ROOM 101");
  assert.equal(downloads, 0);
  assert.equal(t.reader.status("A.pdf#2")?.state, "done");
});

test("Read after a quiet miss uses the saved read: the full hash finds it, no second OCR read", async () => {
  const t = setup();
  await t.cache.put(HASH, 1, { rev: "r2", rs: RS, lines: [LINES[0]], ms: 5, rasters: 1 });
  const req = t.req("A.pdf", { pdfHashIfKnown: async () => null });
  assert.equal(await t.reader.lookup(req, { known: true }), null);
  const r = await t.reader.read(req);
  assert.equal(r.ok && r.cached, true);
  assert.equal(t.s.runs(), 0, "no session run, no OCR");
  assert.equal(t.pg.opens(), 0);
});

// ── the tile cap: refused before consent ─────────────────────────────────────

/** A page of w × h points. */
const sizedPage = (wPt: number, hPt: number) => {
  const p = { getViewport: ({ scale }: { scale: number }) => ({ width: wPt * scale, height: hPt * scale }) };
  return async () => p;
};

test("a page too large to read is refused with no consent asked and nothing stored", async () => {
  const s = fakeSession();
  const meta = metaMap();
  const r = await readPageText({ page: 1, rs: RS, getPage: sizedPage(200000, 200000), pdfHash: async () => HASH, session: s.session, cache: createPageCache(meta.deps), readRegion: instantRegion() });
  assert.deepEqual(r, { ok: false, status: "too-large", message: "This page is too large for the on-device text reader (OCR)." });
  assert.equal(s.runs(), 0, "no consent notice for a read that can't happen");
  assert.deepEqual(meta.puts, []);
});

test("a 42 × 30 in sheet is read as usual", async () => {
  const s = fakeSession();
  const r = await readPageText({ page: 1, rs: RS, getPage: sizedPage(42 * 72, 30 * 72), pdfHash: async () => HASH, session: s.session, cache: createPageCache(metaMap().deps), readRegion: instantRegion() });
  assert.equal(r.ok, true);
  assert.equal(s.runs(), 1);
});

test("readBox: a box too large to read is refused with no consent asked", async () => {
  const t = setup();
  const r = await t.reader.readBox({ file: "A.pdf", rs: RS, rect: { x0: 0, y0: 0, x1: 200000 * RS, y1: 200000 * RS }, getPage: t.pg.getPage });
  assert.deepEqual(r, { ok: false, status: "too-large", message: "This page is too large for the on-device text reader (OCR)." });
  assert.equal(t.s.runs(), 0);
});

test("a too-large page shows why, and offers no Read", () => {
  assert.deepEqual(
    pageReadView({ textless: true, avail: "available", status: { state: "too-large", message: "This page is too large for the on-device text reader (OCR)." } }),
    { kind: "unreadable", text: "This page is too large for the on-device text reader (OCR)." },
  );
});

test("dispose aborts a running box read", async () => {
  const d = deferredRegion();
  const t = setup({ readRegion: d.readRegion });
  const r = t.reader.readBox(boxReq(t));
  await tick(); await tick();
  t.reader.dispose();
  assert.equal(d.calls[0].signal?.aborted, true);
  assert.equal((await r).ok, false);
});

// ── which hash a read is stored under ────────────────────────────────────────

const OLD_HASH = "b".repeat(64);
const NEW_HASH = "c".repeat(64);

test("a read is stored under the hash of the document its page came from, not the lookup's", async () => {
  const s = fakeSession();
  const meta = metaMap();
  const r = await readPageText({
    page: 1, rs: RS, getPage: page().getPage, pageHash: async () => OLD_HASH,
    pdfHash: async () => NEW_HASH, session: s.session, cache: createPageCache(meta.deps), readRegion: instantRegion(),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(meta.puts, [ocrCacheKey(OLD_HASH, 1)]);
});

test("a page whose document has no hash is read but never stored", async () => {
  const s = fakeSession();
  const meta = metaMap();
  const r = await readPageText({
    page: 1, rs: RS, getPage: page().getPage, pageHash: async () => null,
    pdfHash: async () => NEW_HASH, session: s.session, cache: createPageCache(meta.deps), readRegion: instantRegion(),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(meta.puts, []);
});

test("the page's document has a saved read under its own hash: that read, no consent", async () => {
  const s = fakeSession();
  const meta = metaMap();
  const cache = createPageCache(meta.deps);
  await cache.put(OLD_HASH, 1, { rev: "r2", rs: RS, lines: [{ str: "SAVED", x: 1, y: 2, w: 3, h: 4 }], ms: 9, rasters: 1 });
  const r = await readPageText({
    page: 1, rs: RS, getPage: page().getPage, pageHash: async () => OLD_HASH,
    pdfHash: async () => NEW_HASH, session: s.session, cache, readRegion: instantRegion(),
  });
  assert.equal(r.ok && r.cached, true);
  assert.equal(s.runs(), 0);
});

test("a read the region reader refuses as too large is too-large, not failed", async () => {
  const s = fakeSession();
  const readRegion: ReadRegion = async () => { throw Object.assign(new Error("more than 64 tiles"), { name: "PageTooLargeError" }); };
  const r = await readPageText({ page: 1, rs: RS, getPage: page().getPage, pdfHash: async () => HASH, session: s.session, cache: createPageCache(metaMap().deps), readRegion, tooLarge: () => false });
  assert.deepEqual(r, { ok: false, status: "too-large", message: "This page is too large for the on-device text reader (OCR)." });
});

test("a size check that fails (the reader's code didn't load) is a failed read, and later reads still run", async () => {
  let throws = true;
  const s = fakeSession();
  const reader = createPageReader({
    session: s.session, cache: createPageCache(metaMap().deps), readRegion: instantRegion(), onLines: () => {},
    tooLarge: () => { if (throws) throw new Error("Failed to fetch dynamically imported module"); return false; },
  });
  const pg = page();
  const first = await reader.read({ key: "A.pdf", file: "A.pdf", page: 1, rs: RS, getPage: pg.getPage, pdfHash: async () => HASH });
  assert.equal(first.ok === false && first.status, "failed");
  assert.equal(reader.status("A.pdf")?.state, "failed");
  const box = await reader.readBox({ file: "A.pdf", rs: RS, rect: BOXR, getPage: pg.getPage });
  assert.equal(box.ok === false && box.status, "failed", "a box read's failed check never rejects");
  throws = false;
  const next = reader.read({ key: "B.pdf", file: "B.pdf", page: 1, rs: RS, getPage: pg.getPage, pdfHash: async () => HASH });
  const done = await Promise.race([next, new Promise((r) => setTimeout(() => r("stuck"), 200))]);
  assert.equal((done as { ok?: boolean }).ok, true, "the next read gets its turn");
  const box2 = await Promise.race([reader.readBox({ file: "A.pdf", rs: RS, rect: BOXR, getPage: pg.getPage }), new Promise((r) => setTimeout(() => r("stuck"), 200))]);
  assert.equal((box2 as { ok?: boolean }).ok, true, "and so does a box read");
});

test("a read whose session rejects outright is failed, and the next read still gets its turn", async () => {
  const s = fakeSession();
  let broke = false;
  const once = { ...s.session, run: ((task, o) => { if (!broke) { broke = true; return Promise.reject(new Error("session broke")); } return s.session.run(task, o); }) as typeof s.session.run };
  const reader = createPageReader({ session: once, cache: createPageCache(metaMap().deps), readRegion: instantRegion(), onLines: () => {}, tooLarge: () => false });
  const r1 = await reader.read({ key: "A.pdf", file: "A.pdf", page: 1, rs: RS, getPage: page().getPage, pdfHash: async () => HASH });
  assert.deepEqual(r1, { ok: false, status: "failed", message: "session broke" });
  assert.equal(reader.status("A.pdf")?.state, "failed");
  const next = reader.read({ key: "B.pdf", file: "B.pdf", page: 1, rs: RS, getPage: page().getPage, pdfHash: async () => HASH });
  const done = await Promise.race([next, new Promise((r) => setTimeout(() => r("stuck"), 200))]);
  assert.equal((done as { ok?: boolean }).ok, true);
});

test("pageReadView: a probe that couldn't reach the reader says so, with Retry, where Read would be", () => {
  const unreachable = { kind: "unreachable", text: "The on-device text reader (OCR) couldn't be reached" };
  assert.deepEqual(pageReadView({ textless: true, avail: "error", status: undefined }), unreachable);
  assert.deepEqual(pageReadView({ textless: true, avail: "error", status: { state: "failed", message: "x" } }), unreachable);
  assert.deepEqual(pageReadView({ textless: false, avail: "error", status: undefined }), { kind: "hidden" }, "a vector sheet: nothing");
  assert.equal(pageReadView({ textless: true, avail: "error", status: { state: "done", ms: 1000, rasters: 1, stale: false, cached: true } }).kind, "done", "a kept read still shows");
});

test("a lookup that failed (not missed) is retried next time, and warns", async () => {
  let broken = true;
  const meta = metaMap();
  const cache = createPageCache({ metaGet: async (k: string) => { if (broken) throw new Error("idb closed"); return meta.m.get(k); }, metaPut: meta.deps.metaPut });
  await cache.put(HASH, 1, { rev: "r2", rs: RS, lines: [{ str: "KEPT", x: 1, y: 2, w: 3, h: 4 }], ms: 5, rasters: 1 });
  const reader = createPageReader({ session: fakeSession().session, cache, readRegion: instantRegion(), onLines: () => {} });
  const req = { key: "A.pdf", file: "A.pdf", page: 1, rs: RS, pdfHash: async () => HASH };
  const warned = captureWarn();
  try {
    assert.equal(await reader.lookup(req), null);
    assert.match(String(warned.calls[0]?.[0]), /OCR cache/);
  } finally { warned.restore(); }
  assert.equal(reader.status("A.pdf"), undefined, "no checking left behind");
  broken = false;
  const hit = await reader.lookup(req);
  assert.equal(hit?.lines[0].str, "KEPT", "asked again, not remembered as a miss");
});

test("a lookup whose hash threw is retried next time", async () => {
  let n = 0;
  const t = setup();
  const req = { key: "A.pdf", file: "A.pdf", page: 1, rs: RS, pdfHash: async () => { n++; if (n === 1) throw new Error("download failed"); return HASH; } };
  const warned = captureWarn();
  try { assert.equal(await t.reader.lookup(req), null); } finally { warned.restore(); }
  await t.reader.lookup(req);
  assert.equal(n, 2);
});
